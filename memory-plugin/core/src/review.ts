// Daily review / sedimentation (0.2.0). Runs when DSH opens and
// more than 24h passed since the last review — in-process only,
// there is no background service, so a week without opening DSH
// means a week without review. Four jobs:
// 1. decay clarity on old memories (important ones decay slower);
// 2. promote repeatedly recalled memories (significance up);
// 3. compress light old memories to one line into the monthly
//    summary file (summary-YYYY-MM.jsonl) — the original log
//    entry is NEVER touched, only its faded form is stored;
// 4. backfill graph edges for entries that predate the graph.
// Then write the day's sediment summary into review.json. The
// caller (MemoryCore.review) regenerates the starmap afterwards.

import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { atomicWriteText } from "./atomic.ts";
import { COMMON_TOKENS } from "./activation.ts";
import { compressSummary, type AttributeStore } from "./attributes.ts";
import type { BeliefStore } from "./beliefs.ts";
import { ageDays } from "./dates.ts";
import { monthKey } from "./dates.ts";
import type { MemoryGraph } from "./graph.ts";
import type { KeywordIndex } from "./keyword-index.ts";
import { formatDate } from "./dates.ts";
import { CJK_SINGLE_STOP, tokenize } from "./tokenize.ts";
import { buildReflectionPrompt, reflectionGate } from "./reflection.ts";
import { buildProactPrompt } from "./loop.ts";
import type {
  BeliefCandidate,
  CompressedSummary,
  FragmentCandidate,
  MemoryEntry,
  ReviewResult,
  ReviewState,
} from "./types.ts";
import type { Fragment } from "./fragments.ts";

export const REVIEW_FILE = "review.json";
export const REVIEW_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const COMPRESS_AGE_DAYS = 30;
export const COMPRESS_SIGNIFICANCE_BELOW = 0.5;
/** 0.4.0 item 1: an opposite statement counts only when it
 *  appeared within this many days of the review. */
export const INVALIDATION_CHECK_DAYS = 30;
/** 0.4.0 item 1: negation substrings for the opposite-statement
 *  check. Multi-char markers only — a lone 不/没 sits in half of
 *  all sentences and proves nothing. Since 0.4.6 a marker only
 *  counts when it attaches to a shared topic word (see
 *  isNegatedAdjacent below): "喜欢吃辣" vs "不吃辣了" share the
 *  topic token and differ on exactly one side carrying a negation
 *  that bites into that token. */
export const NEGATION_MARKERS: readonly string[] = [
  "不喜欢",
  "不爱",
  "讨厌",
  "不要",
  "不会",
  "不是",
  "没有",
  "不再",
  "不吃",
  "不喝",
  "不想",
  "不能",
  "不去",
  "不看",
  "不玩",
];

/** 0.4.6 (0.4.5 audit new issue 2): a shared topic token is only
 *  a topic when few entries carry it — a name or a filler word
 *  shared by half the log is not something one message can
 *  contradict. Document frequency over persona entries. */
export const INVALIDATION_MAX_DF = 5;

/** 0.4.6: the persona's own name (and its short form) can never
 *  be an invalidation topic — half of all persona messages address
 *  her by name, so sharing it proves nothing. The skill's
 *  canonical name is the default; the caller may add more (the
 *  profile name) through ReviewInput.excludedTopicTokens. */
export const DEFAULT_EXCLUDED_TOPIC_TOKENS: ReadonlySet<string> =
  new Set(tokenize("夏柠柒 柠柒"));

export function defaultReviewState(): ReviewState {
  return {
    version: 1,
    lastReviewedAt: null,
    totalReviews: 0,
    lastSummary: "",
    lastStats: {
      decayed: 0,
      promoted: 0,
      compressed: 0,
      edgesAdded: 0,
      edgesUpgraded: 0,
      entries: 0,
    },
  };
}

export function loadReviewState(dataDir: string): ReviewState {
  try {
    const file = join(dataDir, REVIEW_FILE);
    if (!existsSync(file)) return defaultReviewState();
    const data = JSON.parse(readFileSync(file, "utf8")) as ReviewState;
    if (data.version !== 1) return defaultReviewState();
    return {
      ...defaultReviewState(),
      ...data,
      lastStats: {
        ...defaultReviewState().lastStats,
        ...(data.lastStats ?? {}),
      },
    };
  } catch {
    return defaultReviewState();
  }
}

function saveReviewState(dataDir: string, state: ReviewState): void {
  atomicWriteText(join(dataDir, REVIEW_FILE), JSON.stringify(state));
}

/** 0.5.1 (0.4.3 item 13): what counts as a review topic token.
 *  Without a segmenter, tokenize() emits every overlapping bigram
 *  of a CJK run — including garbage that straddles a word boundary
 *  ("把这" from 把这件事, "不到" from 不到明天) and aspect /
 *  particle bigrams ("吃完" from 吃完饭). A topic must be 2+
 *  chars, not a common word, and contain no stop character
 *  (CJK_SINGLE_STOP) and none of the function / aspect characters
 *  below (把/被/给/对/向/从/到/中/里/外/前/后/时/只/条/件/种/
 *  样/完/着/过/得/地). Latin words pass through (they carry no
 *  stop chars). Honest limit: without a real segmenter a
 *  cross-boundary bigram whose two chars are both content chars
 *  cannot be fully detected — the filter kills the reported cases
 *  (把这/不到/吃完) and every bigram of the same shape, not every
 *  possible garbage bigram. Shared by the fragment and belief
 *  candidate blocks below. */
const REVIEW_TOPIC_EXTRA_STOP = new Set([
  "把", "被", "给", "对", "向", "从", "到", "中", "里", "外", "前",
  "后", "时", "只", "条", "件", "种", "样", "完", "着", "过",
  "得", "地",
]);

export function isReviewTopicToken(t: string): boolean {
  if (typeof t !== "string" || t.length < 2) return false;
  if (COMMON_TOKENS.has(t)) return false;
  for (const ch of t) {
    if (CJK_SINGLE_STOP.has(ch) || REVIEW_TOPIC_EXTRA_STOP.has(ch)) {
      return false;
    }
  }
  return true;
}

/** Read every summary-YYYY-MM.jsonl into entryId -> one-line summary.
 *  Torn lines are skipped, like the log. A directory that cannot
 *  be listed at all (0.5.1 §四: the readdirSync used to throw
 *  uncaught) returns an empty map instead of breaking the review. */
export function loadSummaries(dataDir: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(dataDir)) return out;
  let names: string[];
  try {
    names = readdirSync(dataDir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (!/^summary-\d{4}-\d{2}\.jsonl$/.test(name)) continue;
    let raw: string;
    try {
      raw = readFileSync(join(dataDir, name), "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line) as CompressedSummary;
        if (typeof row.entryId === "string" && typeof row.summary === "string") {
          out.set(row.entryId, row.summary);
        }
      } catch {
        // Torn line: skip.
      }
    }
  }
  return out;
}

function appendSummary(dataDir: string, row: CompressedSummary): void {
  const file = join(dataDir, `summary-${row.month}.jsonl`);
  const fd = openSync(file, "a", 0o600);
  try {
    appendFileSync(fd, `${JSON.stringify(row)}\n`, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export interface ReviewInput {
  dataDir: string;
  entries: MemoryEntry[];
  graph: MemoryGraph;
  attrs: AttributeStore;
  index: KeywordIndex;
  now?: number;
  compressAgeDays?: number;
  /** 0.3.0: existing fragments — entries already folded into one
   *  are never proposed again. */
  fragments?: Fragment[];
  /** 0.4.0 item 2: the belief store — entries already used as
   *  belief evidence are never proposed again, and the store's
   *  daily decay runs here. Absent = old caller: no belief step. */
  beliefs?: BeliefStore;
  /** 0.4.6: extra tokens that can never be invalidation topics
   *  (on top of the persona-name default) — the caller passes the
   *  profile name's tokens, so a rename via memory_profile is
   *  honoured. Absent = the default only. */
  excludedTopicTokens?: ReadonlySet<string>;
}

export function runReview(input: ReviewInput): ReviewResult {
  const now = input.now ?? Date.now();
  const compressAgeDays = input.compressAgeDays ?? COMPRESS_AGE_DAYS;
  const state = loadReviewState(input.dataDir);
  // Entries already compressed in an earlier review (the summary
  // file is the record). attributes.json is the cache, not the
  // source of truth — if it is lost or corrupt, the summary file
  // still says "already compressed", so the same entry must never
  // be appended a second time.
  const existingSummaries = loadSummaries(input.dataDir);
  let decayed = 0;
  let promoted = 0;
  let compressed = 0;
  for (const entry of input.entries) {
    const attrs = input.attrs.ensure(entry, undefined, now);
    if (!attrs.compressed && existingSummaries.has(entry.id)) {
      attrs.compressed = true;
    }
    if (input.attrs.decayClarity(entry, now)) decayed += 1;
    if (input.attrs.promote(entry)) promoted += 1;
    if (
      !attrs.compressed &&
      !attrs.modelMarked &&
      attrs.significance < COMPRESS_SIGNIFICANCE_BELOW &&
      ageDays(entry.ts, now) >= compressAgeDays
    ) {
      appendSummary(input.dataDir, {
        entryId: entry.id,
        month: monthKey(entry.ts),
        summary: compressSummary(entry.text),
        ts: now,
      });
      attrs.compressed = true;
      attrs.compressedAt = now;
      compressed += 1;
    }
  }
  const edgesAdded = input.graph.backfill(input.entries, input.index, now);
  // 0.5.1 (0.4.5 item 7): backfill upgrades session edges to
  // keyword edges in place — those are not new edges, but the
  // summary used to say nothing about them at all.
  const edgesUpgraded = input.graph.lastBackfillUpgraded;
  input.graph.decay(now);
  // 0.3.0: propose fragment clusters — groups of 2+ entries sharing
  // a rare topic token (document frequency 2..5), none of them
  // folded into a fragment yet. The review only PROPOSES: a fragment
  // is created by the model through memory_fragment / createFragment,
  // so both paths share the same code verification. At most 5
  // candidates, rarest topic first.
  const fragmentCandidates: FragmentCandidate[] = [];
  {
    const alreadyFragmented = new Set<string>();
    for (const f of input.fragments ?? []) {
      for (const id of f.sourceIds) alreadyFragmented.add(id);
    }
    const df = new Map<string, string[]>();
    for (const entry of input.entries) {
      // m-7 (review-12): candidates are shown to the model (M-1
      // exposes them in the daily review prompt), so task-window
      // entries must never be clustered — only persona entries.
      if (entry.window !== "persona" || (entry.kind ?? "persona") !== "persona") continue;
      if (alreadyFragmented.has(entry.id)) continue;
      for (const token of new Set(
        tokenize(entry.text).filter(isReviewTopicToken),
      )) {
        const list = df.get(token) ?? [];
        list.push(entry.id);
        df.set(token, list);
      }
    }
    const seenSets = new Set<string>();
    const ranked = [...df.entries()]
      .filter(([, ids]) => ids.length >= 2 && ids.length <= 5)
      .sort((a, b) => a[1].length - b[1].length || a[0].localeCompare(b[0]));
    for (const [topic, ids] of ranked) {
      if (fragmentCandidates.length >= 5) break;
      const key = [...ids].sort().join("\0");
      if (seenSets.has(key)) continue;
      seenSets.add(key);
      fragmentCandidates.push({ topic, sourceIds: ids, keywords: [topic] });
    }
  }
  // 0.4.0 item 2: belief aggregation — PROPOSE ONLY, never write.
  // Groups of 2+ persona entries sharing a rare topic token (df
  // 2..5), none of them already used as belief evidence, become
  // candidates for a belief: the model writes the statement and
  // picks the dimension when it confirms via memory_belief (create),
  // so the candidate carries no statement and no dimension guess —
  // judgement belongs to the model. Quotes are verbatim excerpts
  // (the entry text, or its first 40 chars) so the model can quote
  // them back at confirmation. At most 5 candidates, rarest topic
  // first — same shape as the fragment candidates above. The
  // store's daily decay runs here too (strength × 0.99 per silent
  // day); decay never deletes a belief.
  const beliefCandidates: BeliefCandidate[] = [];
  let beliefsDecayed = 0;
  if (input.beliefs) {
    beliefsDecayed = input.beliefs.decayBeliefs(now);
    const alreadyBelieved = new Set<string>();
    for (const b of input.beliefs.all()) {
      for (const ev of b.evidence) alreadyBelieved.add(ev.entryId);
    }
    const df = new Map<string, string[]>();
    for (const entry of input.entries) {
      if (entry.window !== "persona" || (entry.kind ?? "persona") !== "persona") continue;
      if (alreadyBelieved.has(entry.id)) continue;
      for (const token of new Set(
        tokenize(entry.text).filter(isReviewTopicToken),
      )) {
        const list = df.get(token) ?? [];
        list.push(entry.id);
        df.set(token, list);
      }
    }
    const seenSets = new Set<string>();
    const ranked = [...df.entries()]
      .filter(([, ids]) => ids.length >= 2 && ids.length <= 5)
      .sort((a, b) => a[1].length - b[1].length || a[0].localeCompare(b[0]));
    const byId = new Map(input.entries.map((e) => [e.id, e]));
    for (const [topic, ids] of ranked) {
      if (beliefCandidates.length >= 5) break;
      const key = [...ids].sort().join("\0");
      if (seenSets.has(key)) continue;
      seenSets.add(key);
      const quotes = ids.map((id) => {
        const text = byId.get(id)?.text ?? "";
        return text.length > 40 ? text.slice(0, 40) : text;
      });
      beliefCandidates.push({ topic, sourceIds: ids, quotes });
    }
  }
  const summary =
    `${formatDate(now)} 复盘：共 ${input.entries.length} 条记忆；` +
    `${decayed} 条清晰度衰减；${promoted} 条提了上去；` +
    `${compressed} 条旧记忆压成一行；新连 ${edgesAdded} 条线。` +
    (edgesUpgraded > 0 ? `（另有 ${edgesUpgraded} 条边升级。）` : "") +
    (fragmentCandidates.length > 0
      ? `${fragmentCandidates.length} 组可提炼成片段。`
      : "") +
    (beliefCandidates.length > 0
      ? `${beliefCandidates.length} 组可聚成信念。`
      : "") +
    (beliefsDecayed > 0 ? `${beliefsDecayed} 条信念衰减。` : "");
  // 0.4.0 item 1: invalidation check — MARK ONLY, never
  // auto-invalidate. A memory with significance >= 0.5 is flagged
  // (needsInvalidationCheck, persisted in attributes.json) when a
  // LATER persona entry, from within the last 30 days, says the
  // opposite: the two share a >= 2-char topic token and exactly one
  // side carries a negation marker. The flag waits for the model or
  // a human to confirm via memory_invalidate; the memory itself
  // keeps recalling until then. Task-window entries never count
  // (same rule as fragment candidates), already-invalid entries
  // need no check.
  //
  // 0.4.4 (0.4.3 audit issue 2): the flag is "awaiting model
  // review", NOT "never check again". The 0.4.0 code skipped a
  // flagged entry forever (`if (attrs.needsInvalidationCheck)
  // continue`), so a check the model never acted on vanished from
  // every later review — and nothing anywhere read the flag, so
  // the model could never have acted on it in the first place.
  // Now: a flagged entry is re-evaluated every review and
  // re-listed while the opposition is still live. The flag only
  // clears when the check is resolved — the model invalidates the
  // entry (attributes.invalidate clears it), the opposing
  // statement itself ages past the 30-day window (nothing left to
  // confirm — the model had up to 30 days of daily prompts to
  // act), or the entry drops out of the check's population
  // (invalidated, or significance below the 0.5 floor). There is
  // no explicit "still valid" confirmation: memory_invalidate has
  // no keep-action, so inaction + lapse is the answer — the entry
  // stays valid and the flag goes away on its own.
  const invalidationChecks: string[] = [];
  {
    const windowMs = INVALIDATION_CHECK_DAYS * 24 * 60 * 60 * 1000;
    // 0.4.6 (0.4.5 audit new issue 2): the 0.4.0 rule flagged any
    // pair sharing one >= 2-char token with a negation anywhere in
    // either message — on real data it marked "夏柠柒，我喜欢你"
    // and "夏柠柒" itself as possibly outdated, because they share
    // her own name with an unrelated message that happened to carry
    // a negation. Four tightenings, all still keyword-level (the
    // core has no semantics):
    // 1. topic tokens exclude the persona name / trigger words
    //    (DEFAULT_EXCLUDED_TOPIC_TOKENS, plus any the caller
    //    passes), COMMON_TOKENS, and any token with document
    //    frequency > INVALIDATION_MAX_DF over persona entries;
    // 2. a negation only counts when it attaches to a shared word
    //    — its span overlaps the word, or sits within one character
    //    of it ("不吃辣" vs "吃辣"), never merely "somewhere in the
    //    same message";
    // 3. at least two shared real words, or a single shared token
    //    that is itself a phrase (the strict-overlap rule below —
    //    the negation has to bite into the word itself);
    // 4. the two sides must differ on that attachment (exactly one
    //    side negated-adjacent to the shared word).
    const excluded = new Set<string>([
      ...DEFAULT_EXCLUDED_TOPIC_TOKENS,
      ...(input.excludedTopicTokens ?? []),
    ]);
    const df = new Map<string, number>();
    for (const e of input.entries) {
      if (e.window !== "persona" || (e.kind ?? "persona") !== "persona") continue;
      for (const t of new Set(tokenize(e.text))) {
        df.set(t, (df.get(t) ?? 0) + 1);
      }
    }
    const topicTokens = (text: string): Set<string> =>
      new Set(
        tokenize(text).filter(
          (t) =>
            t.length >= 2 &&
            !COMMON_TOKENS.has(t) &&
            !excluded.has(t) &&
            (df.get(t) ?? 0) <= INVALIDATION_MAX_DF,
        ),
      );
    // True when a negation marker's span overlaps the token's span
    // (strict), or overlaps it or sits within one character of it
    // (loose). A lone shared token must clear the strict bar — the
    // marker has to bite into the word itself ("不吃" over "吃辣"
    // in "不吃辣"), which is what makes it a negated phrase rather
    // than a coincidental bigram slice; with two or more shared
    // words the loose bar is enough.
    const isNegatedAdjacent = (
      text: string,
      token: string,
      strictOverlap: boolean,
    ): boolean => {
      for (const m of NEGATION_MARKERS) {
        let mi = text.indexOf(m);
        while (mi !== -1) {
          const mEnd = mi + m.length;
          let ti = text.indexOf(token);
          while (ti !== -1) {
            const tEnd = ti + token.length;
            if (mi < tEnd && ti < mEnd) return true;
            if (!strictOverlap && ti <= mEnd + 1 && mi <= tEnd + 1) {
              return true;
            }
            ti = text.indexOf(token, ti + 1);
          }
          mi = text.indexOf(m, mi + 1);
        }
      }
      return false;
    };
    const recent = input.entries.filter(
      (e) =>
        e.window === "persona" && now - e.ts >= 0 && now - e.ts <= windowMs,
    );
    for (const entry of input.entries) {
      if (entry.window !== "persona" || (entry.kind ?? "persona") !== "persona") continue;
      const attrs = input.attrs.get(entry.id);
      if (!attrs) continue;
      // Resolved by invalidation — a dead entry needs no check.
      // (Belt and braces: attributes.invalidate clears the flag
      // too; this catches rows invalidated under 0.4.3, where it
      // did not.)
      if (attrs.validTo != null && attrs.validTo <= now) {
        if (attrs.needsInvalidationCheck) attrs.needsInvalidationCheck = false;
        continue;
      }
      // Below the check's floor: no longer important enough to
      // nag about. A stale flag here would sit in memory_status
      // forever — clear it.
      if (attrs.significance < 0.5) {
        if (attrs.needsInvalidationCheck) attrs.needsInvalidationCheck = false;
        continue;
      }
      const entryTokens = topicTokens(entry.text);
      if (entryTokens.size === 0) continue;
      let opposed = false;
      for (const other of recent) {
        if (other.id === entry.id || other.ts <= entry.ts) continue;
        const otherTokens = topicTokens(other.text);
        const shared = [...entryTokens].filter((t) => otherTokens.has(t));
        if (shared.length === 0) continue;
        // One shared token alone is only a phrase when the negation
        // bites into it (strict overlap); two or more shared words
        // may lean on a merely adjacent negation.
        const strict = shared.length === 1;
        for (const t of shared) {
          if (
            isNegatedAdjacent(entry.text, t, strict) !==
            isNegatedAdjacent(other.text, t, strict)
          ) {
            opposed = true;
            break;
          }
        }
        if (opposed) break;
      }
      if (opposed) {
        // Still opposed: flag it (again — the flag may already be
        // set from an earlier review) and list it, so the model
        // gets another chance to confirm at this review.
        attrs.needsInvalidationCheck = true;
        invalidationChecks.push(entry.id);
      } else if (attrs.needsInvalidationCheck) {
        // Lapsed: the opposing statement aged past the 30-day
        // window, so there is nothing left for the model to
        // confirm. Clear the flag instead of leaving a stale
        // "awaiting review" on the entry forever.
        attrs.needsInvalidationCheck = false;
      }
    }
  }
  const next: ReviewState = {
    version: 1,
    lastReviewedAt: now,
    totalReviews: state.totalReviews + 1,
    lastSummary: summary,
    lastStats: {
      decayed,
      promoted,
      compressed,
      edgesAdded,
      edgesUpgraded,
      entries: input.entries.length,
    },
  };
  input.attrs.save();
  input.graph.save();
  saveReviewState(input.dataDir, next);
  // 0.4.0 item 3: reflection trigger — PROPOSE ONLY, never write.
  // The last 24 h of new persona memories, minus entries already
  // folded into a reflection, are summed by significance; only
  // when the sum clears the tiny anti-disturbance floor
  // (REFLECTION_MIN_FLOOR) is a prompt built and handed to the
  // model in ReviewResult. Below the floor there is no prompt and
  // no model call. Above it, whether to reflect — and what the
  // conclusion is — is the model's decision (memory_reflect);
  // the code never blocks it and never writes a reflection
  // itself. There is no score threshold for reflecting, only
  // this floor for being asked at all.
  const reflectedIds = new Set<string>();
  for (const f of input.fragments ?? []) {
    if (f.type === "reflection") {
      for (const id of f.sourceIds) reflectedIds.add(id);
    }
  }
  const reflection = reflectionGate(
    input.entries,
    (e) => input.attrs.ensure(e, undefined, now).significance,
    now,
    reflectedIds,
  );
  const reflectionPrompt = reflection.reached
    ? buildReflectionPrompt(reflection.entries, {
        significanceOf: (e) =>
          input.attrs.ensure(e, undefined, now).significance,
      })
    : undefined;
  // 0.4.0 item 7: proactive proposal — PROPOSE ONLY, never write.
  // The last 24 h of new persona memories, the stored beliefs and
  // the saved reflections are handed to the model as one prompt
  // (buildProactPrompt): she weighs whether to act at all, why,
  // and what to say. No floor, no score gate — an empty day simply
  // builds no prompt. Execution only ever goes through
  // memory_proact (guardrails first, then the model, then the
  // store); the review writes nothing to loop.json.
  const proactMemories = input.entries.filter(
    (e) =>
      e.window === "persona" &&
      now - e.ts >= 0 &&
      now - e.ts <= 24 * 60 * 60 * 1000,
  );
  const proactBeliefs = input.beliefs?.all() ?? [];
  const proactReflections = (input.fragments ?? []).filter(
    (f) => f.type === "reflection",
  );
  const proactPrompt =
    proactMemories.length > 0 ||
    proactBeliefs.length > 0 ||
    proactReflections.length > 0
      ? buildProactPrompt(
          {
            memories: proactMemories,
            beliefs: proactBeliefs,
            reflections: proactReflections,
            now,
          },
          {
            significanceOf: (e) =>
              input.attrs.ensure(e, undefined, now).significance,
          },
        )
      : undefined;
  // 0.4.6 (0.4.5 audit new issue 1): the daily-review prompt no
  // longer pastes the reflection and proact prompts as two full
  // sections — each listed all 24 h of memories verbatim (~37k
  // characters each on a chatty day). Instead the shell builds ONE
  // merged section from these entry ids (reflection entries ∪
  // proact memories, de-duplicated), capped at 20 entries / 3000
  // characters. The kinds say which instruction blocks the merged
  // section carries; the prompt strings above are still built
  // (capped) for the standalone gates and for tests, but the daily
  // prompt no longer pastes them.
  const recentEntryIds = [
    ...new Set([
      ...(reflection.reached ? reflection.entries.map((e) => e.id) : []),
      ...proactMemories.map((e) => e.id),
    ]),
  ];
  const recentKinds = {
    reflection: reflection.reached,
    proact: proactPrompt !== undefined,
  };
  return { ...next, ran: true, fragmentCandidates, beliefCandidates, invalidationChecks, reflectionPrompt, proactPrompt, recentEntryIds, recentKinds };
}
