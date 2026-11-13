// Fragments (0.3.0): a short model-written summary layer ON TOP of
// the verbatim log.
//
// The log (log.jsonl) stays the ground-truth base, verbatim, one
// line per message, never edited, with NO tone annotations. A
// fragment is the visible star in the star map; the log is only for
// confirmation. When the system retrieves a fragment it checks the
// base to confirm — a fragment whose claims do not match its sources
// is rejected at creation and falls back to the verbatim source at
// retrieval.
//
// Each fragment: id, sourceIds (PROVENANCE, mandatory — the log
// entry ids it derives from), text (a short model-written summary,
// ~10 tokens), tone (attitude tag toward the topic, model-tagged at
// creation, stored as data), quotes (1-2 VERBATIM tone-critical
// phrases copied from the source), topic/keywords, createdAt,
// verified flag. A fragment that later fails re-verification is
// marked suspect (never silently deleted — the next review can fix
// or drop it).
//
// Verification is done by CODE (no model tokens), at two moments:
// (a) creation — key terms + quotes must appear in the source
// entries' text, and the tone tag must be consistent with the
// sources' attitude markers; (b) retrieval — the same checks run
// again, and a failure falls back to the source log entry.
//
// Tone is FREE-FORM (0.3.0 design update): the model writes
// whatever attitude word fits — "嘴上嫌弃心里喜欢", "有点喜欢但不
// 太确定" — not limited to a fixed list. The tone lexicon below is
// only the verification vocabulary: a tone word the lexicon does
// not know maps to level "unknown", and the tone check is then
// skipped (toneChecked false) — an unlisted tone word never fails
// a fragment on tone alone. Only a CLEAR contradiction fails: a
// known-level tone against known-level source markers more than 1
// level apart (e.g. 很喜欢 vs 还行-only sources).
//
// Honest limit (documented in the README too): code checks catch
// gross fabrication and clear tone mismatches, but subtle tone — a
// fragment that paraphrases without using any lexicon word — can
// still slip through. This is a safety net, not a guarantee. The
// iron rule （只记真实对话不许编） is enforced by provenance +
// verification, not by trust.

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteText, backupCorruptFile } from "./atomic.ts";
import type { CorruptBackup } from "./atomic.ts";
import {
  MODEL_SOURCE_TYPES,
  confidenceFor,
  legacyProvenance,
  newProvenance,
  normalizeProvenance,
  validateSourceIds,
  type Provenance,
  type SourceType,
} from "./provenance.ts";
import { estimateTokens } from "./tokenize.ts";
import type { MemoryEntry } from "./types.ts";

export const FRAGMENTS_FILE = "fragments.json";

/** Fragment text cap: ~10 tokens is the design size; 30 estimated
 *  tokens is the hard ceiling — a fragment longer than that saves
 *  nothing over the verbatim source and is rejected. */
export const FRAGMENT_MAX_TOKENS = 30;
export const FRAGMENT_MAX_QUOTES = 2;
/** 0.5.1 (0.4.3 item 9): a fragment quote must be at least 4
 *  characters — a 1–2 char quote (\"累\", \"生气\") matches almost
 *  any line and proves nothing about where the fragment came
 *  from. Applies to ordinary fragments only: reflections keep
 *  their own 2-char floor (REFLECTION_MIN_QUOTE_CHARS), because
 *  a 「」 citation is a short verbatim anchor by design. */
export const FRAGMENT_MIN_QUOTE_CHARS = 4;

/** 0.6.0 (人味改造 第 1 项): an impression is one deliberate
 *  breath, not a paragraph — one line of how she reads him, plus
 *  one line of what she will do about it. */
export const IMPRESSION_MAX_TEXT_CHARS = 40;
export const IMPRESSION_MAX_STRATEGY_CHARS = 60;
/** An impression that never expires stops being a judgement and
 *  becomes a label, so every impression gets a clock (14 days). */
export const IMPRESSION_DEFAULT_TTL_MS = 14 * 86_400_000;
/** Her own-voice version is one short line, not a rewrite. */
export const FRAGMENT_MAX_VOICED_CHARS = 60;

/** Parse a validUntil input: epoch ms (number, or numeric string)
 *  or a YYYY-MM-DD date (local midnight). Returns undefined for
 *  anything else — the caller then uses the default TTL. */
export function parseValidUntil(raw: unknown): number | undefined {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string") {
    const s = raw.trim();
    if (!s) return undefined;
    if (/^\d+$/.test(s)) {
      const n = Number(s);
      return Number.isFinite(n) ? n : undefined;
    }
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (m) {
      const t = new Date(
        Number(m[1]),
        Number(m[2]) - 1,
        Number(m[3]),
      ).getTime();
      return Number.isFinite(t) ? t : undefined;
    }
  }
  return undefined;
}

export type ToneLevel =
  | "strong-positive"
  | "mild-positive"
  | "lukewarm"
  | "mild-negative"
  | "strong-negative"
  /** Free-form tone the lexicon cannot place: the tone check is
   *  skipped for it (never failed on tone alone). */
  | "unknown";

/** A tone level the lexicon can place (everything but "unknown"). */
export type KnownToneLevel = Exclude<ToneLevel, "unknown">;

/** Numeric attitude: strong-positive +2 down to strong-negative
 *  -2 ("unknown" has no number). A KNOWN fragment tone is
 *  consistent with KNOWN source markers when the two levels differ
 *  by at most 1 — so "喜欢" (+1) from "还行" sources (0) passes,
 *  but "很喜欢" (+2) from "还行" sources (0) fails by 2. */
export const TONE_LEVEL_VALUE: Record<KnownToneLevel, number> = {
  "strong-positive": 2,
  "mild-positive": 1,
  lukewarm: 0,
  "mild-negative": -1,
  "strong-negative": -2,
};

export function toneLevelValue(level: ToneLevel): number | undefined {
  return level === "unknown" ? undefined : TONE_LEVEL_VALUE[level];
}

/** Attitude markers found in source text, by level. Longest first
 *  when scanning: "很喜欢" must win over the "喜欢" inside it. */
export const TONE_MARKERS: Record<KnownToneLevel, string[]> = {
  "strong-positive": [
    "很喜欢",
    "最喜欢",
    "超爱",
    "超喜欢",
    "特别喜欢",
    "非常喜欢",
    "太喜欢了",
    "爱死了",
    "喜欢得不得了",
  ],
  "mild-positive": [
    "喜欢",
    "还不错",
    "挺好的",
    "挺喜欢",
    "不错",
    "好喝",
    "好吃",
    "挺好",
  ],
  lukewarm: [
    "还行",
    "一般",
    "也就那样",
    "凑合",
    "马马虎虎",
    "还可以",
    "一般般",
  ],
  "mild-negative": ["不太喜欢", "不怎么样", "不怎么喜欢", "不太好吃", "不太好喝"],
  "strong-negative": ["不喜欢", "讨厌", "难吃", "难喝", "很讨厌", "最讨厌"],
};

/** Tone labels the model may pass (tool input), mapped to levels.
 *  This is a RECOGNITION list, not a permission list: a label
 *  outside it is stored with level "unknown" (free-form tone — the
 *  model writes its own words), never rejected for being unlisted.
 *  Only an empty label or an unparseable ":intensity" is rejected. */
export const TONE_LABELS: Record<string, ToneLevel> = {
  "很喜欢": "strong-positive",
  "最喜欢": "strong-positive",
  "超爱": "strong-positive",
  "超喜欢": "strong-positive",
  "特别喜欢": "strong-positive",
  "非常喜欢": "strong-positive",
  "喜欢": "mild-positive",
  "还不错": "mild-positive",
  "挺好的": "mild-positive",
  "挺喜欢": "mild-positive",
  "不错": "mild-positive",
  "还行": "lukewarm",
  "一般": "lukewarm",
  "也就那样": "lukewarm",
  "凑合": "lukewarm",
  "马马虎虎": "lukewarm",
  "还可以": "lukewarm",
  "不太喜欢": "mild-negative",
  "不怎么样": "mild-negative",
  "不怎么喜欢": "mild-negative",
  "不喜欢": "strong-negative",
  "讨厌": "strong-negative",
  "难吃": "strong-negative",
  "难喝": "strong-negative",
};

const DEFAULT_TONE_INTENSITY: Record<ToneLevel, number> = {
  "strong-positive": 0.9,
  "mild-positive": 0.7,
  lukewarm: 0.5,
  "mild-negative": 0.7,
  "strong-negative": 0.9,
  unknown: 0.5,
};

/** High-frequency grammatical characters — a bigram containing one
 *  carries no topical signal ("汤的", "的味"), so it is never a
 *  required key term. Same set as the tokenizer's stopwords.
 *  0.5.1 (0.4.3 item 9): 不 / 没 are NO LONGER stop chars here —
 *  a negation bigram (没有, 不生气) is a real word and must be
 *  kept, or "我没有生气" would verify the same as "我生气了". */
const STOP_CHARS = new Set([
  "的", "了", "在", "是", "有", "和", "就", "都", "也", "还",
  "很", "这", "那", "我", "你", "他", "她", "它", "们",
  "个", "一", "上", "下", "来", "去", "吗", "呢", "吧", "啊", "哦",
  "嗯", "呀", "么",
]);

/** Negation words for the polarity check below. */
const NEGATION_CHARS = new Set(["不", "没", "未", "别", "莫", "勿", "非"]);

/** Polarity of a term inside a text: "neg" when every occurrence
 *  is preceded within 2 characters by a negation word, "pos" when
 *  none is, "mixed" when both, "absent" when it never occurs. The
 *  2-char window catches 我没有生气 / 我不生气 without reaching
 *  across a clause boundary. */
export function termPolarity(
  text: string,
  term: string,
): "neg" | "pos" | "mixed" | "absent" {
  let neg = 0;
  let pos = 0;
  let idx = 0;
  for (;;) {
    const at = text.indexOf(term, idx);
    if (at === -1) break;
    const before = text.slice(Math.max(0, at - 2), at);
    if ([...before].some((ch) => NEGATION_CHARS.has(ch))) neg++;
    else pos++;
    idx = at + term.length;
  }
  if (neg === 0 && pos === 0) return "absent";
  if (neg > 0 && pos > 0) return "mixed";
  return neg > 0 ? "neg" : "pos";
}

/** True when at least one quote shares a 2-char slice with the
 *  fragment text — the quote grounds the fragment's own claim,
 *  not just any verbatim phrase from the sources. Punctuation and
 *  case are stripped first, so "聊 DSH 的插件" shares 插件 with
 *  "他还想聊 dsh 插件". */
function quoteSharesWordWithText(quotes: string[], text: string): boolean {
  const norm = (s: string): string =>
    s.toLowerCase().replace(/[\s\p{P}]/gu, "");
  const t = norm(text);
  if (t.length < 2) return false;
  const textBigrams = new Set<string>();
  for (let i = 0; i + 1 < t.length; i++) textBigrams.add(t.slice(i, i + 2));
  return quotes.some((q) => {
    const nq = norm(q);
    for (let i = 0; i + 1 < nq.length; i++) {
      if (textBigrams.has(nq.slice(i, i + 2))) return true;
    }
    return false;
  });
}

/** All tone-marker phrases, longest first, for stripping. */
const ALL_MARKERS: string[] = Object.values(TONE_MARKERS)
  .flat()
  .sort((a, b) => b.length - a.length);

export interface FragmentTone {
  label: string;
  level: ToneLevel;
  intensity: number;
}

export interface Fragment {
  id: string;
  /** 0.4.0 item 3: only "reflection" is special — a reflection
   *  conclusion stored as a fragment. Absent = an ordinary
   *  fragment (0.3.0). The type only changes how the fragment is
   *  verified (quote-only, see verifyStored): the starmap and
   *  recall treat every fragment the same. */
  type?: "reflection";
  /** 0.6.0 (人味改造 第 1 项): "impression" = her current read of
   *  him plus what she plans to do about it. Verified quote-only
   *  (the read is a new judgement, like a reflection), expires on
   *  validUntil, and is injected at the top of the recall block in
   *  her own words. Absent = an ordinary fragment. */
  kind?: "impression";
  sourceIds: string[];
  /** 0.5.0 step 3: provenance — where this fragment came from
   *  and how much it can be trusted. The model proposes the
   *  sourceType at creation; the confidence is code-computed.
   *  Rows written before 0.5.0 load as legacy (unknown). */
  provenance?: Provenance;
  text: string;
  /** 0.6.0: with kind "impression", one short line — what she plans
   *  to do about it ("别催他早睡，给他留盏灯"). Required for an
   *  impression, absent for an ordinary fragment. */
  strategy?: string;
  /** 0.6.0: epoch ms after which an impression stops being true —
   *  recall skips it from then on (the row stays on disk). Only
   *  impressions carry one; absent = never expires. */
  validUntil?: number;
  /** 0.6.0 (人味改造 第 1 项 / 第 27 轮): her own-voice version of
   *  the fragment, written in the stage's tone. The block injects
   *  this one, while recall/keywords keep using `text` — the model
   *  reads human words, the index still matches plain ones. */
  voiced?: string;
  tone: FragmentTone;
  quotes: string[];
  topic: string;
  keywords: string[];
  createdAt: number;
  /** True when the fragment passed code verification at creation.
   *  Stays true if it later turns suspect — suspect is the
   *  retrieval-time flag, verified is the creation-time fact. */
  verified: boolean;
  /** True when a retrieval-time re-check failed: recall falls back
   *  to the verbatim source and the next review can fix or drop it. */
  suspect?: boolean;
  suspectReason?: string;
}

/** What the model passes to memory_fragment / createFragment. */
export interface FragmentInput {
  sourceIds: string[];
  text: string;
  /** Tone label, e.g. "很喜欢", or "很喜欢:0.9" (label:intensity). */
  tone: string;
  quotes: string[];
  topic?: string;
  /** 0.5.0 step 3: the model's JUDGEMENT of what this fragment
   *  is — user_quote / model_quote / model_summary /
   *  model_inference. Absent = model_summary. The confidence is
   *  NOT an input: the code computes it. An unknown value is
   *  rejected (the vocabulary is fixed). */
  sourceType?: string;
  keywords?: string[];
  /** 0.6.0: "impression" makes this row her standing read of him
   *  (with strategy + validUntil). Absent = an ordinary fragment;
   *  any other value is rejected (the vocabulary is fixed). */
  kind?: string;
  /** 0.6.0: what she plans to do about it — required for an
   *  impression, ignored for an ordinary fragment. */
  strategy?: string;
  /** 0.6.0: epoch ms (number) or YYYY-MM-DD; impressions default
   *  to now + 14 days. */
  validUntil?: number | string;
  /** 0.6.0: her own-voice version of the text (injected, never
   *  used for matching). */
  voiced?: string;
}

export interface FragmentCreateResult {
  ok: boolean;
  fragment?: Fragment;
  /** Why it was rejected (empty when ok). Returned to the caller so
   *  the model can fix the fragment instead of guessing. */
  reasons: string[];
}

export interface FragmentVerifyResult {
  ok: boolean;
  reasons: string[];
  /** False when the sources carried no attitude markers at all, so
   *  the tone check had nothing to compare against — the fragment
   *  passed on keywords + quotes alone. That is the documented
   *  honest limit, not a pass on tone. */
  toneChecked: boolean;
}

/** Chinese label for a tone level, for user-facing reasons —
 *  the enum names (lukewarm etc.) must never leak into a message
 *  the model or the user reads. */
const TONE_LEVEL_CN: Record<KnownToneLevel, string> = {
  "strong-positive": "很喜欢",
  "mild-positive": "喜欢",
  lukewarm: "还行/一般",
  "mild-negative": "不太喜欢",
  "strong-negative": "不喜欢/讨厌",
};

/** Parse a tone label ("很喜欢" or "很喜欢:0.9", full-width ：
 *  accepted) into a stored tone. Free-form: a label the lexicon
 *  does not know is stored with level "unknown" (its own words,
 *  kept verbatim) — the tone check is then skipped for it. Only an
 *  empty label or an unparseable ":intensity" returns undefined. */
export function parseToneLabel(
  raw: unknown,
): FragmentTone | undefined {
  if (typeof raw !== "string") return undefined;
  const s = raw.trim().replace(/：/g, ":");
  if (!s) return undefined;
  const idx = s.lastIndexOf(":");
  let label = s;
  let intensity: number | undefined;
  if (idx !== -1) {
    label = s.slice(0, idx).trim();
    const n = Number(s.slice(idx + 1).trim());
    if (!label || !Number.isFinite(n)) return undefined;
    intensity = Math.min(1, Math.max(0, n));
  }
  const level = TONE_LABELS[label] ?? "unknown";
  return {
    label,
    level,
    intensity: intensity ?? DEFAULT_TONE_INTENSITY[level],
  };
}

/** Attitude levels present in a text, from the marker lexicon.
 *  Longer markers win over shorter ones inside them ("很喜欢"
 *  counts as strong-positive, not also mild-positive via "喜欢"):
 *  a matched span is blanked before shorter markers are tried. */
export function detectToneLevels(text: string): KnownToneLevel[] {
  if (typeof text !== "string") return [];
  const found = new Set<KnownToneLevel>();
  let masked = text;
  const levels = Object.keys(TONE_MARKERS) as KnownToneLevel[];
  // Strong markers first, then the rest by phrase length — a
  // strong phrase must claim its span before "喜欢" sees it.
  const ordered: Array<{ level: KnownToneLevel; phrase: string }> = [];
  for (const level of levels) {
    for (const phrase of TONE_MARKERS[level]) {
      ordered.push({ level, phrase });
    }
  }
  ordered.sort((a, b) => b.phrase.length - a.phrase.length);
  for (const { level, phrase } of ordered) {
    if (masked.includes(phrase)) {
      found.add(level);
      masked = masked.split(phrase).join(" ".repeat(phrase.length));
    }
  }
  return [...found];
}

/** The source entries' overall attitude: the matched level with
 *  the greatest absolute value (strong evidence wins); ties go to
 *  the level with more distinct markers. Undefined when no marker
 *  appears at all — then the tone check is inconclusive. */
export function sourceToneLevel(texts: string[]): KnownToneLevel | undefined {
  const counts = new Map<KnownToneLevel, number>();
  for (const t of texts) {
    for (const level of detectToneLevels(t)) {
      counts.set(level, (counts.get(level) ?? 0) + 1);
    }
  }
  if (counts.size === 0) return undefined;
  let best: KnownToneLevel | undefined;
  for (const [level, count] of counts) {
    if (!best) {
      best = level;
      continue;
    }
    const bestVal = Math.abs(TONE_LEVEL_VALUE[best]);
    const val = Math.abs(TONE_LEVEL_VALUE[level]);
    if (val > bestVal || (val === bestVal && count > (counts.get(best) ?? 0))) {
      best = level;
    }
  }
  return best;
}

/** Key terms of a fragment text: content bigrams (+ latin words)
 *  after stripping tone-marker phrases and stopword bigrams. The
 *  tone phrases are replaced by a space, not deleted outright, so
 *  stripping "很喜欢" from "他很喜欢酸梅湯" does not glue "他" onto
 *  "酸梅湯" and invent the bigram "他酸". A term must appear
 *  verbatim in the source text to count as grounded. */
export function fragmentKeyTerms(text: string): string[] {
  if (typeof text !== "string") return [];
  let stripped = text;
  for (const phrase of ALL_MARKERS) {
    stripped = stripped.split(phrase).join(" ");
  }
  const out = new Set<string>();
  for (const w of stripped.toLowerCase().match(/[a-z0-9]+(?:[.'-][a-z0-9]+)*/g) ?? []) {
    if (w.length >= 2) out.add(w);
  }
  for (const m of stripped.matchAll(
    /[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff]+/gu,
  )) {
    const run = m[0];
    for (let i = 0; i + 1 < run.length; i++) {
      const bigram = run.slice(i, i + 2);
      if (STOP_CHARS.has(bigram[0]) || STOP_CHARS.has(bigram[1])) continue;
      out.add(bigram);
    }
  }
  return [...out];
}

/** The shared verification, used at creation AND at retrieval:
 *  - every key term of the fragment text appears in the sources
 *    (catches novel contamination: "粉色筷子" is not in the source,
 *    so "粉色" / "筷子" fail);
 *  - every quote appears verbatim in some source entry (the quote
 *    is copied, not paraphrased, so the exact tone survives);
 *  - the tone tag is within 1 level of the sources' attitude
 *    markers, when the sources carry any (catches "很喜欢酸梅湯"
 *    from "酸梅湯还行吧，也就那样": +2 vs 0);
 *  - the fragment text's own attitude markers agree with its tone
 *    tag within 1 level (the text must not smuggle in a tone the
 *    tag denies).
 *  A fragment with no key terms at all has nothing to ground it and
 *  fails. A source set with no attitude markers passes the tone
 *  check as inconclusive (toneChecked false) — the documented limit.
 *  quoteOnly (0.4.0 item 3, reflections): skip the key-term and
 *  tone checks entirely and check ONLY the quotes. A reflection's
 *  insight is new by design ("他最近压力大" from three "累"), so
 *  its new words must never be checked against the sources — only
 *  its citations must be verbatim. */
export function verifyFragment(
  draft: {
    text: string;
    tone: FragmentTone;
    quotes: string[];
  },
  sources: MemoryEntry[],
  opts?: { quoteOnly?: boolean },
): FragmentVerifyResult {
  const reasons: string[] = [];
  if (sources.length === 0) {
    return { ok: false, reasons: ["没有找到来源条目（sourceIds 不存在）。"], toneChecked: false };
  }
  const joined = sources.map((s) => s.text).join("\n");
  // 0.5.1 (0.4.3 item 9): the key-term check is case-insensitive
  // — a source that says "dsh" must match a fragment that says
  // "DSH" (DSH / iPhone / GitHub are all lower-case in the log
  // half the time). Only the term check is lowered; quotes stay
  // exact, verbatim, case and all.
  const joinedLower = joined.toLowerCase();
  const quoteOnly = opts?.quoteOnly === true;
  if (!quoteOnly) {
    const terms = fragmentKeyTerms(draft.text);
    if (terms.length === 0) {
      reasons.push("片段正文里没有任何可核对的关键实词（只有语气词/停用词），无法核对来源。");
    } else {
      const missing = terms.filter((t) => !joinedLower.includes(t.toLowerCase()));
      if (missing.length > 0) {
        reasons.push(
          `关键实词不在来源里：${missing.slice(0, 5).join("、")}——来源从没提过这些词，可能是编造。`,
        );
      } else {
        // 0.5.1 (0.4.3 item 9): negation polarity — a term the
        // sources negate must not be written as an affirmation,
        // or the other way round ("我没有生气" -> "我生气了").
        // A term whose polarity is mixed in the sources is
        // skipped (the sources themselves disagree), and a term
        // absent from the sources is already caught above.
        for (const t of terms) {
          const fragPol = termPolarity(draft.text, t);
          const srcPol = termPolarity(joined, t);
          if (
            srcPol !== "absent" &&
            srcPol !== "mixed" &&
            fragPol !== srcPol
          ) {
            reasons.push(
              `语义反转：来源里「${t}」是${srcPol === "neg" ? "否定" : "肯定"}的，片段里却写成了${fragPol === "neg" ? "否定" : "肯定"}——否定句不能写成肯定句。`,
            );
          }
        }
      }
    }
  }
  if (draft.quotes.length === 0) {
    reasons.push("没有逐字引用：片段必须带 1–2 句从来源原文逐字抄来的短语。");
  }
  for (const q of draft.quotes) {
    if (typeof q !== "string" || q.trim().length === 0) {
      reasons.push("有一条引用是空的。");
    } else if (!quoteOnly && q.trim().length < FRAGMENT_MIN_QUOTE_CHARS) {
      reasons.push(
        `引用太短（${JSON.stringify(q)} 只有 ${q.trim().length} 个字，至少 ${FRAGMENT_MIN_QUOTE_CHARS} 个字）：一两个字的引用谁都能对上，证明不了片段的出处。`,
      );
    } else if (!sources.some((s) => s.text.includes(q))) {
      reasons.push(`引用不在来源原文里：${JSON.stringify(q)}——引用必须是逐字抄的，不能改写。`);
    }
  }
  // 0.5.1 (0.4.3 item 9): at least one quote must share a real
  // word with the fragment text — a quote that is only a tone
  // phrase ("真好喝") does not ground a claim about a topic
  // ("酸梅湯"). Skipped in quoteOnly mode (a reflection's insight
  // words are new by design, only its citations are checked).
  if (
    !quoteOnly &&
    draft.quotes.length > 0 &&
    draft.quotes.every((q) => typeof q === "string" && q.trim().length > 0) &&
    !quoteSharesWordWithText(draft.quotes, draft.text)
  ) {
    reasons.push(
      "引用和片段正文没有共享实词：引用只是来源里的一句语气词，和片段说的不是一回事——引用至少要有一句提到片段正文里的词。",
    );
  }
  // Tone: sources first, then the fragment's own text. Only when
  // BOTH sides are known levels — a free-form tone ("unknown") or
  // sources with no markers never fail on tone alone (toneChecked
  // stays false); keyword + quote checks still apply. Skipped
  // entirely in quoteOnly mode (reflections carry tone "unknown"
  // and have no attitude to check).
  const sourceLevel = sourceToneLevel(sources.map((s) => s.text));
  let toneChecked = false;
  const fragValue = toneLevelValue(draft.tone.level);
  if (!quoteOnly && sourceLevel !== undefined && fragValue !== undefined) {
    toneChecked = true;
    const diff = Math.abs(fragValue - TONE_LEVEL_VALUE[sourceLevel]);
    if (diff > 1) {
      reasons.push(
        `语气对不上：片段标的是「${draft.tone.label}」，来源的语气只有「${TONE_LEVEL_CN[sourceLevel]}」那一档（来源里只有${detectToneLevels(sources.map((s) => s.text).join(" ")).map((l) => TONE_LEVEL_CN[l]).join("、") || "无语气词"}级别的词）。`,
      );
    }
  }
  const textLevels = detectToneLevels(draft.text);
  if (!quoteOnly && textLevels.length > 0 && fragValue !== undefined) {
    const textLevel = textLevels.reduce((a, b) =>
      Math.abs(TONE_LEVEL_VALUE[b]) > Math.abs(TONE_LEVEL_VALUE[a]) ? b : a,
    );
    const diff = Math.abs(fragValue - TONE_LEVEL_VALUE[textLevel]);
    if (diff > 1) {
      reasons.push(
        `片段正文自己的语气（${TONE_LEVEL_CN[textLevel]}）和它标的语气「${draft.tone.label}」差太多，正文和标签自相矛盾。`,
      );
    }
  }
  return { ok: reasons.length === 0, reasons, toneChecked };
}

/** Full creation-time validation: shape checks first (so a bad
 *  call is rejected before any source is even looked up), then the
 *  shared verification. Returns the fragment to store, or the
 *  reasons it was rejected. */
export function validateFragmentInput(
  input: FragmentInput,
  entriesById: Map<string, MemoryEntry>,
  now = Date.now(),
): FragmentCreateResult {
  const reasons: string[] = [];
  if (!input || typeof input !== "object") {
    return { ok: false, reasons: ["需要一个片段对象。"] };
  }
  if (!Array.isArray(input.sourceIds) || input.sourceIds.length === 0) {
    return { ok: false, reasons: ["sourceIds 不能为空：片段必须注明它是从哪几条原文来的。"] };
  }
  // 0.5.0 step 3: core-layer source-existence check — every
  // sourceId must resolve to a real log entry, or the fragment is
  // rejected (nothing stored).
  const sourceCheck = validateSourceIds(input.sourceIds, entriesById);
  if (!sourceCheck.ok) {
    reasons.push(
      `来源条目不存在：${sourceCheck.missing.slice(0, 5).join("、")}`,
    );
  }
  // 0.5.1 (0.4.3 item 12): every source must be a persona-window
  // entry — a task-window line must never be folded into a
  // fragment, because fragments are injected into her context.
  // (Beliefs and reflections already check this; see core.ts
  // createBelief and reflection.ts saveReflection.)
  const nonPersona = input.sourceIds.filter((id) => {
    const e = entriesById.get(id);
    return e !== undefined && e.window !== "persona";
  });
  if (nonPersona.length > 0) {
    reasons.push(
      `来源条目不在人设窗口：${nonPersona.slice(0, 5).join("、")}——任务窗口的对话不能做成片段。`,
    );
  }
  // 0.5.0 step 3: the source type is the model's judgement only —
  // a fixed vocabulary, default model_summary. The confidence is
  // code-computed at build time below, never an input.
  let sourceType: SourceType = "model_summary";
  if (typeof input.sourceType === "string" && input.sourceType.trim()) {
    const t = input.sourceType.trim();
    if ((MODEL_SOURCE_TYPES as string[]).includes(t)) {
      sourceType = t as SourceType;
    } else {
      reasons.push(
        `来源类型只能是 用户原话 / 模型原话 / 模型总结 / 模型推断 之一，传了「${t}」。`,
      );
    }
  }
  if (typeof input.text !== "string" || input.text.trim().length === 0) {
    reasons.push("片段正文不能为空。");
  } else if (estimateTokens(input.text) > FRAGMENT_MAX_TOKENS) {
    reasons.push(
      `片段太长（约 ${estimateTokens(input.text)} tokens，上限 ${FRAGMENT_MAX_TOKENS}）：片段是 ~10 token 的短句，不是复述原文。`,
    );
  }
  // 0.6.0 (人味改造 第 1 项): the impression shape. kind is a fixed
  // vocabulary — a typo must be rejected, not silently stored as an
  // ordinary fragment.
  let kind: "impression" | undefined;
  if (input.kind !== undefined) {
    const k = typeof input.kind === "string" ? input.kind.trim() : "";
    if (k === "impression") {
      kind = "impression";
    } else if (k !== "") {
      reasons.push(
        `kind 只能是 "impression"（印象）或不填（普通片段），传了「${k}」。`,
      );
    }
  }
  let strategy: string | undefined;
  let validUntil: number | undefined;
  let voiced: string | undefined;
  if (kind === "impression") {
    strategy =
      typeof input.strategy === "string" ? input.strategy.trim() : "";
    if (!strategy) {
      reasons.push(
        "印象必须带 strategy：一句你打算怎么对他（如「别催他早睡，给他留盏灯」）。只有看法没有对策的不是印象。",
      );
    } else if (strategy.length > IMPRESSION_MAX_STRATEGY_CHARS) {
      reasons.push(
        `strategy 太长（${strategy.length} 字，上限 ${IMPRESSION_MAX_STRATEGY_CHARS}）：一句对策就够，别写成方案。`,
      );
    }
    if (typeof input.text === "string" && input.text.trim().length > IMPRESSION_MAX_TEXT_CHARS) {
      reasons.push(
        `印象正文太长（${input.text.trim().length} 字，上限 ${IMPRESSION_MAX_TEXT_CHARS}）：一句你怎么看他，不是分析报告。`,
      );
    }
    const parsed = parseValidUntil(input.validUntil);
    validUntil = parsed ?? (now + IMPRESSION_DEFAULT_TTL_MS);
    if (parsed !== undefined && parsed <= now) {
      reasons.push(
        "validUntil 已经过去了：印象要有寿命，但不能一开始就过期——换个未来的日期，或者不填（默认 14 天）。",
      );
    }
  }
  if (input.voiced !== undefined) {
    voiced = typeof input.voiced === "string" ? input.voiced.trim() : "";
    if (!voiced) {
      voiced = undefined;
    } else if (voiced.length > FRAGMENT_MAX_VOICED_CHARS) {
      reasons.push(
        `voiced 太长（${voiced.length} 字，上限 ${FRAGMENT_MAX_VOICED_CHARS}）：只要一句你自己的口吻，不是重写。`,
      );
    }
  }
  const tone = parseToneLabel(input.tone);
  if (!tone) {
    reasons.push(
      "语气标签为空或强度写错了：语气用你自己的词写就行（如 很喜欢 / 嘴上嫌弃心里喜欢），可加 :强度（如 很喜欢:0.9）。",
    );
  }
  if (!Array.isArray(input.quotes) || input.quotes.length === 0) {
    reasons.push("quotes 不能为空：片段必须带 1–2 句从来源原文逐字抄来的短语。");
  } else if (input.quotes.length > FRAGMENT_MAX_QUOTES) {
    reasons.push(`引用最多 ${FRAGMENT_MAX_QUOTES} 句，传了 ${input.quotes.length} 句。`);
  }
  if (reasons.length > 0) return { ok: false, reasons };
  const sources = input.sourceIds
    .map((id) => entriesById.get(id) as MemoryEntry)
    .filter(Boolean);
  // 0.6.0: an impression is a JUDGEMENT, so its own words are new
  // by design (like a reflection) — only its citations are checked
  // verbatim. The provenance rule (sourceIds exist, persona window)
  // above still applies: an impression must always be able to point
  // at the lines it was formed from, or it is not saved.
  const verified = verifyFragment(
    { text: input.text, tone: tone as FragmentTone, quotes: input.quotes },
    sources,
    kind === "impression" ? { quoteOnly: true } : undefined,
  );
  if (!verified.ok) return { ok: false, reasons: verified.reasons };
  const topic =
    typeof input.topic === "string" && input.topic.trim()
      ? input.topic.trim()
      : (fragmentKeyTerms(input.text)[0] ?? "");
  // 0.6.0: an impression's keywords cover BOTH halves — a query about
  // "早睡" must surface an impression whose strategy mentions it,
  // even when the read ("他累了") does not.
  const impressionSource = kind === "impression"
    ? `${input.text} ${strategy ?? ""}`
    : input.text;
  const keywords =
    Array.isArray(input.keywords) && input.keywords.length > 0
      ? input.keywords.filter((k): k is string => typeof k === "string")
      : fragmentKeyTerms(impressionSource);
  const fragment: Fragment = {
    id: `frag-${now}-${randomBytes(3).toString("hex")}`,
    ...(kind === "impression"
      ? { kind, strategy, validUntil }
      : {}),
    ...(voiced !== undefined ? { voiced } : {}),
    sourceIds: [...input.sourceIds],
    // 0.5.0 step 3: creation passed code verification, so it
    // counts as the first verification (verifyCount 1, stamped).
    provenance: newProvenance(input.sourceIds, sourceType, now),
    text: input.text.trim(),
    tone: tone as FragmentTone,
    quotes: [...input.quotes],
    topic,
    keywords,
    createdAt: now,
    verified: true,
  };
  return { ok: true, fragment, reasons: [] };
}

interface PersistedFragments {
  version: 1;
  fragments: Fragment[];
}

const VALID_TONE_LEVELS: ReadonlySet<string> = new Set([
  "strong-positive",
  "mild-positive",
  "lukewarm",
  "mild-negative",
  "strong-negative",
  "unknown",
]);

/** fragments.json store: load + sanitise + atomic save. Hand-edited
 *  rows are sanitised, not trusted: a fragment with no sources, no
 *  text, an unknown tone level or a non-string quote is dropped, and
 *  every range is clamped — a corrupt file must never crash recall
 *  or the starmap. */
export class FragmentStore {
  private list: Fragment[] = [];
  private readonly file: string;
  // 0.5.1 (0.4.3 item 10): same corrupt-file treatment as
  // BeliefStore — a failed load backs the bytes up once and marks
  // the store; save() refuses until the file parses again.
  private loadFailed = false;
  private corruptBackup: CorruptBackup | null = null;
  // 0.5.1 (0.4.3 §四): suspect / verified marks made in memory
  // between loads. A reload (cross-process refresh) used to wipe
  // them — now they are recorded here and replayed onto the
  // reloaded rows, and cleared only after a successful save.
  private dirty = new Map<
    string,
    { suspect?: boolean; suspectReason?: string; provenance?: Provenance }
  >();

  /** True when the file on disk failed to parse and has not been
   *  repaired since; while true, save() throws instead of writing. */
  get hasLoadFailed(): boolean {
    return this.loadFailed;
  }

  /** Path of the .corrupt-* backup, if one was taken. */
  get corruptBackupPath(): string | null {
    return this.corruptBackup?.path ?? null;
  }

  constructor(dataDir: string) {
    this.file = join(dataDir, FRAGMENTS_FILE);
    this.load();
  }

  get size(): number {
    return this.list.length;
  }

  get suspectCount(): number {
    return this.list.filter((f) => f.suspect).length;
  }

  all(): Fragment[] {
    return [...this.list];
  }

  get(id: string): Fragment | undefined {
    return this.list.find((f) => f.id === id);
  }

  /** Fragments covering one log entry (in creation order). */
  forEntry(entryId: string): Fragment[] {
    return this.list.filter((f) => f.sourceIds.includes(entryId));
  }

  /** 0.6.0 (人味改造 第 3 项): the live impressions for this turn —
   *  kind "impression", not suspect, not yet expired. At most two
   *  are ever injected; this returns them in creation order and the
   *  caller picks by relevance. */
  impressions(now = Date.now()): Fragment[] {
    return this.list.filter(
      (f) =>
        f.kind === "impression" &&
        !f.suspect &&
        (f.validUntil === undefined || f.validUntil > now),
    );
  }

  /** 0.6.0 (第 4 项): the user flatly denied an impression ("我没
   *  焦虑") — it stops being injected at once: suspect + validUntil
   *  stamped to now. The row stays on disk for audit, and the next
   *  review may form a better one. Returns false when the id is not
   *  an impression. */
  reject(id: string, reason: string, now = Date.now()): boolean {
    const f = this.get(id);
    if (!f || f.kind !== "impression") return false;
    f.suspect = true;
    f.suspectReason = reason;
    f.validUntil = now;
    this.dirty.set(id, {
      ...(this.dirty.get(id) ?? {}),
      suspect: true,
      suspectReason: reason,
    });
    this.save();
    return true;
  }

  /** Ids of fragments whose sources are ALL inside `ids` — they
   *  would lose every source (dry-run preview for a forget). */
  idsLosingAllSources(ids: string[]): string[] {
    const set = new Set(ids);
    return this.list
      .filter(
        (f) =>
          f.sourceIds.length > 0 &&
          f.sourceIds.every((s) => set.has(s)),
      )
      .map((f) => f.id);
  }

  /** Remove fragments that lose all their sources (0.5.1 item 1:
   *  forget-delete). A fragment with a surviving source stays —
   *  its re-check will judge it against what is left. Returns
   *  the removed fragment ids. The caller saves. */
  /** 终版 WP3: drop fragments whose source list is no longer fully
   *  live. A fragment with one dead source can no longer prove its
   *  verbatim quotes, so it is removed rather than partially kept. */
  pruneTo(liveIds: Set<string>): string[] {
    const doomed = this.list
      .filter((f) => !f.sourceIds.every((id) => liveIds.has(id)))
      .map((f) => f.id);
    if (doomed.length === 0) return [];
    const set = new Set(doomed);
    this.list = this.list.filter((f) => !set.has(f.id));
    return doomed;
  }

  removeEntries(ids: string[]): string[] {
    const doomed = new Set(this.idsLosingAllSources(ids));
    if (doomed.size === 0) return [];
    this.list = this.list.filter((f) => !doomed.has(f.id));
    return [...doomed];
  }

  /** A load failure never clears the in-memory list and never
   *  overwrites the file: the corrupt bytes are backed up once and
   *  the failure is marked, so the next save() refuses loudly
   *  instead of silently writing an empty store over them. A
   *  missing file is not a failure — it is a fresh store. */
  private markCorrupt(why: string): void {
    const backup = backupCorruptFile(this.file, this.corruptBackup);
    if (backup) this.corruptBackup = backup;
    this.loadFailed = true;
    console.warn(
      `[memory-plugin] fragments.json 损坏（${why}），` +
        `已备份到 ${this.corruptBackup?.path ?? "（备份失败）"}，` +
        "拒绝覆盖原文件——请检查后删除损坏文件或从快照恢复。",
    );
  }

  private load(): void {
    if (!existsSync(this.file)) {
      this.list = [];
      this.loadFailed = false;
      // No file means no fragments at all — stale in-memory marks
      // have nothing to replay onto.
      this.dirty.clear();
      return;
    }
    let data: PersistedFragments;
    try {
      data = JSON.parse(readFileSync(this.file, "utf8")) as PersistedFragments;
    } catch {
      this.markCorrupt("无法解析 JSON");
      return;
    }
    if (data.version !== 1 || !Array.isArray(data.fragments)) {
      this.markCorrupt("版本号或结构不对");
      return;
    }
    try {
      const clean: Fragment[] = [];
      for (const f of data.fragments) {
        if (
          !f ||
          typeof f.id !== "string" ||
          !Array.isArray(f.sourceIds) ||
          f.sourceIds.length === 0 ||
          !f.sourceIds.every((id) => typeof id === "string") ||
          typeof f.text !== "string" ||
          f.text.trim().length === 0 ||
          !f.tone ||
          typeof f.tone.label !== "string" ||
          !VALID_TONE_LEVELS.has(f.tone.level) ||
          !Number.isFinite(f.tone.intensity) ||
          !Array.isArray(f.quotes) ||
          !f.quotes.every((q) => typeof q === "string")
        ) {
          continue;
        }
        clean.push({
          id: f.id,
          // 0.4.0 item 3: only "reflection" survives the load —
          // any other type value (hand-edited or from a future
          // version) is dropped, never trusted. Old rows without
          // the field load as ordinary fragments.
          type: f.type === "reflection" ? "reflection" : undefined,
          // 0.6.0: only "impression" survives — a hand-edited or
          // future kind value is dropped back to an ordinary row,
          // never trusted. strategy / validUntil only ride an
          // impression (a stray value on an ordinary row is ignored).
          kind: f.kind === "impression" ? "impression" : undefined,
          ...(f.kind === "impression" && typeof f.strategy === "string" && f.strategy.trim()
            ? { strategy: f.strategy.trim() }
            : {}),
          ...(f.kind === "impression" &&
          typeof f.validUntil === "number" &&
          Number.isFinite(f.validUntil)
            ? { validUntil: f.validUntil }
            : {}),
          ...(typeof f.voiced === "string" && f.voiced.trim()
            ? { voiced: f.voiced.trim() }
            : {}),
          sourceIds: [...f.sourceIds],
          // 0.5.0 step 3: rows written before this step have no
          // provenance — they load as legacy (unknown), never
          // forged. A stored confidence is recomputed by code.
          provenance: normalizeProvenance(
            (f as { provenance?: unknown }).provenance,
            f.sourceIds,
          ),
          text: f.text,
          tone: {
            label: f.tone.label,
            level: f.tone.level as ToneLevel,
            intensity: Math.min(1, Math.max(0, f.tone.intensity)),
          },
          quotes: [...f.quotes],
          topic: typeof f.topic === "string" ? f.topic : "",
          keywords: Array.isArray(f.keywords)
            ? f.keywords.filter((k): k is string => typeof k === "string")
            : [],
          createdAt: Number.isFinite(f.createdAt) ? f.createdAt : 0,
          verified: f.verified === true,
          suspect: f.suspect === true,
          suspectReason:
            typeof f.suspectReason === "string" ? f.suspectReason : undefined,
        });
      }
      this.list = clean;
      this.loadFailed = false;
      this.replayDirty();
    } catch {
      this.markCorrupt("行级解析失败");
    }
  }

  /** Re-apply the in-memory suspect / verified marks onto the
   *  freshly loaded rows (0.5.1 §四): a reload must not wipe a
   *  mark that has not been saved yet. Rows that no longer exist
   *  drop their dirty entry. */
  private replayDirty(): void {
    if (this.dirty.size === 0) return;
    for (const [id, d] of [...this.dirty.entries()]) {
      const f = this.get(id);
      if (!f) {
        this.dirty.delete(id);
        continue;
      }
      if (d.suspect !== undefined) {
        f.suspect = d.suspect;
        if (d.suspectReason !== undefined) f.suspectReason = d.suspectReason;
      }
      if (d.provenance !== undefined) f.provenance = d.provenance;
    }
  }

  reload(): void {
    this.load();
  }

  save(): void {
    if (this.loadFailed) {
      throw new Error(
        `fragments.json 上次加载失败（已损坏，备份在 ${this.corruptBackup?.path ?? "未知"}），` +
          "拒绝覆盖——请删除损坏文件或从快照恢复后再写。",
      );
    }
    atomicWriteText(
      this.file,
      JSON.stringify({ version: 1, fragments: this.list } satisfies PersistedFragments),
    );
    this.dirty.clear();
  }

  /** Create a fragment: validate (shape + code verification
   *  against the sources) and, only when it passes, store it.
   *  A rejected fragment is never saved. */
  create(
    input: FragmentInput,
    entriesById: Map<string, MemoryEntry>,
    now = Date.now(),
  ): FragmentCreateResult {
    const result = validateFragmentInput(input, entriesById, now);
    if (!result.ok || !result.fragment) return result;
    this.list.push(result.fragment);
    this.save();
    return result;
  }

  /** Re-verify a stored fragment against its current sources (the
   *  log never changes, so this normally passes — it fails when the
   *  fragment was created against sources that are no longer there,
   *  or when its stored text/quotes were hand-edited afterwards).
   *  0.4.0 item 3: a reflection fragment is re-checked quote-only
   *  — its insight words are new by design, so the key-term check
   *  that guards ordinary fragments would wrongly fail it on
   *  first recall and mark it suspect. Only its citations are
   *  re-checked, verbatim. */
  verifyStored(
    fragment: Fragment,
    entriesById: Map<string, MemoryEntry>,
  ): FragmentVerifyResult {
    const sources = fragment.sourceIds
      .map((id) => entriesById.get(id))
      .filter((e): e is MemoryEntry => e !== undefined);
    if (sources.length !== fragment.sourceIds.length) {
      return {
        ok: false,
        reasons: ["来源条目缺失：有来源原文找不到了。"],
        toneChecked: false,
      };
    }
    return verifyFragment(
      { text: fragment.text, tone: fragment.tone, quotes: fragment.quotes },
      sources,
      fragment.type === "reflection" || fragment.kind === "impression"
        ? { quoteOnly: true }
        : undefined,
    );
  }

  /** Store an already-built fragment (0.4.0 item 3: reflections
   *  are built by reflection.ts, not by validateFragmentInput —
   *  their insight words are new by design and would fail the
   *  ordinary fragment checks). The caller owns verification; this
   *  only appends and persists. */
  add(fragment: Fragment): void {
    this.list.push(fragment);
    this.save();
  }

  /** Mark a fragment suspect after a failed retrieval-time check.
   *  The fragment stays on disk (never silently deleted) so the
   *  next review can fix or drop it. In-memory only — the caller
   *  persists at flush() (recall is a read path; it must not write
   *  fragments.json under no lock, the same rule as recall's
   *  attribute bumps). Returns true when found. */
  markSuspect(id: string, reason: string): boolean {
    const f = this.get(id);
    if (!f) return false;
    if (!f.suspect) {
      f.suspect = true;
      f.suspectReason = reason;
      // 0.5.1 (§四): record the mark so a reload before flush
      // replays it instead of wiping it.
      this.dirty.set(id, {
        ...(this.dirty.get(id) ?? {}),
        suspect: true,
        suspectReason: reason,
      });
    }
    return true;
  }

  /** 0.5.0 step 3: note a successful retrieval-time re-check —
   *  verifyCount + 1, lastVerifiedAt stamped, confidence
   *  recomputed by code (capped). In-memory only, like
   *  markSuspect: the caller persists at flush(). Returns true
   *  when found. */
  markVerified(id: string, now: number = Date.now()): boolean {
    const f = this.get(id);
    if (!f) return false;
    const p = f.provenance ?? legacyProvenance(f.sourceIds);
    // 0.5.0 fix: a legacy row has no real verification history —
    // injecting it once must not manufacture a "已验证 1 次" count
    // while sourceType stays "legacy" and confidence stays null.
    if (p.sourceType === "legacy") return true;
    const verifyCount = p.verifyCount + 1;
    f.provenance = {
      ...p,
      verifyCount,
      lastVerifiedAt: now,
      confidence: confidenceFor(p.sourceType, verifyCount),
    };
    // 0.5.1 (§四): record the new provenance so a reload before
    // flush replays it instead of wiping it.
    this.dirty.set(id, {
      ...(this.dirty.get(id) ?? {}),
      provenance: f.provenance,
    });
    return true;
  }
}
