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
import { atomicWriteText } from "./atomic.ts";
import { estimateTokens } from "./tokenize.ts";
import type { MemoryEntry } from "./types.ts";

export const FRAGMENTS_FILE = "fragments.json";

/** Fragment text cap: ~10 tokens is the design size; 30 estimated
 *  tokens is the hard ceiling — a fragment longer than that saves
 *  nothing over the verbatim source and is rejected. */
export const FRAGMENT_MAX_TOKENS = 30;
export const FRAGMENT_MAX_QUOTES = 2;

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
 *  required key term. Same set as the tokenizer's stopwords. */
const STOP_CHARS = new Set([
  "的", "了", "在", "是", "有", "和", "就", "都", "也", "还",
  "不", "没", "很", "这", "那", "我", "你", "他", "她", "它", "们",
  "个", "一", "上", "下", "来", "去", "吗", "呢", "吧", "啊", "哦",
  "嗯", "呀", "么",
]);

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
  sourceIds: string[];
  text: string;
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
  keywords?: string[];
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
  const quoteOnly = opts?.quoteOnly === true;
  if (!quoteOnly) {
    const terms = fragmentKeyTerms(draft.text);
    if (terms.length === 0) {
      reasons.push("片段正文里没有任何可核对的关键实词（只有语气词/停用词），无法核对来源。");
    } else {
      const missing = terms.filter((t) => !joined.includes(t));
      if (missing.length > 0) {
        reasons.push(
          `关键实词不在来源里：${missing.slice(0, 5).join("、")}——来源从没提过这些词，可能是编造。`,
        );
      }
    }
  }
  if (draft.quotes.length === 0) {
    reasons.push("没有逐字引用：片段必须带 1–2 句从来源原文逐字抄来的短语。");
  }
  for (const q of draft.quotes) {
    if (typeof q !== "string" || q.trim().length === 0) {
      reasons.push("有一条引用是空的。");
    } else if (!sources.some((s) => s.text.includes(q))) {
      reasons.push(`引用不在来源原文里：${JSON.stringify(q)}——引用必须是逐字抄的，不能改写。`);
    }
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
  const missingIds = input.sourceIds.filter((id) => !entriesById.has(id));
  if (missingIds.length > 0) {
    reasons.push(`来源条目不存在：${missingIds.slice(0, 5).join("、")}`);
  }
  if (typeof input.text !== "string" || input.text.trim().length === 0) {
    reasons.push("片段正文不能为空。");
  } else if (estimateTokens(input.text) > FRAGMENT_MAX_TOKENS) {
    reasons.push(
      `片段太长（约 ${estimateTokens(input.text)} tokens，上限 ${FRAGMENT_MAX_TOKENS}）：片段是 ~10 token 的短句，不是复述原文。`,
    );
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
  const verified = verifyFragment(
    { text: input.text, tone: tone as FragmentTone, quotes: input.quotes },
    sources,
  );
  if (!verified.ok) return { ok: false, reasons: verified.reasons };
  const topic =
    typeof input.topic === "string" && input.topic.trim()
      ? input.topic.trim()
      : (fragmentKeyTerms(input.text)[0] ?? "");
  const keywords =
    Array.isArray(input.keywords) && input.keywords.length > 0
      ? input.keywords.filter((k): k is string => typeof k === "string")
      : fragmentKeyTerms(input.text);
  const fragment: Fragment = {
    id: `frag-${now}-${randomBytes(3).toString("hex")}`,
    sourceIds: [...input.sourceIds],
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

  private load(): void {
    try {
      if (!existsSync(this.file)) return;
      const data = JSON.parse(readFileSync(this.file, "utf8")) as PersistedFragments;
      if (data.version !== 1 || !Array.isArray(data.fragments)) return;
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
          sourceIds: [...f.sourceIds],
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
    } catch {
      this.list = [];
    }
  }

  reload(): void {
    this.list = [];
    this.load();
  }

  save(): void {
    atomicWriteText(
      this.file,
      JSON.stringify({ version: 1, fragments: this.list } satisfies PersistedFragments),
    );
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
      fragment.type === "reflection" ? { quoteOnly: true } : undefined,
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
    }
    return true;
  }
}
