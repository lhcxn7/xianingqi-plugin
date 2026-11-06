// Recall: keyword match + importance + recency, ranked, with a token
// cap so the caller never injects an unbounded blob into context.
// v1 is keyword-only (CJK bigrams + latin words). No vector/semantic
// recall.
//
// No-match behaviour (fixed 2026-11-05): when nothing matches the
// query keywords, recall returns NO hits and empty injectable text.
// v1 fell back to "most recent, heavy first", which injected unrelated
// memories (and burned tokens) on every unrelated question, including
// in task windows. A search with no matches is an empty result, not
// an excuse to inject something else.

import { ageDays } from "./dates.ts";
import { estimateTokens, tokenize } from "./tokenize.ts";
import type {
  Layer1State,
  MemoryEntry,
  RecallHit,
  RecallResult,
} from "./types.ts";

export const DEFAULT_TOKEN_CAP = 1500;

export interface RecallOptions {
  /** Default "persona": only persona-window records. "all" includes task
   *  records (never injected as persona experience by default). */
  window?: "persona" | "task" | "all";
  /** Max estimated tokens for the returned block. Default 1500. */
  tokenCap?: number;
  /** Max hits. Default 10. */
  limit?: number;
  /** Restrict the log scan to these entry ids (e.g. a keyword-index
   *  lookup). Archive entries are exempt — they are not in the index
   *  (audit m1). */
  candidateIds?: Set<string>;
  /** Layer-2 entries from MEMORY.md (recent 30 days). The skill reads
   *  these at open, so a log hit saying the same thing is dropped in
   *  favour of the curated copy (0.1.6 recall dedupe). */
  layer2?: MemoryEntry[];
}

export function scoreEntry(
  entry: MemoryEntry,
  matchedCount: number,
  now: number,
): number {
  const keyword = matchedCount * 2;
  const importance = entry.importance === "heavy" ? 3 : 0;
  const recency = 1 / (1 + ageDays(entry.ts, now));
  return keyword + importance + recency;
}

/** Normalise text for the 0.1.6 recall dedupe: strip whitespace and
 *  punctuation, lowercase. CJK punctuation (、。！？ etc.) is \p{P},
 *  symbols (including most emoji) are \p{S}, so one pattern covers
 *  both scripts. */
export function normalizeForDedupe(text: string): string {
  if (typeof text !== "string") return "";
  return text.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");
}

/** The MEMORY.md texts the skill already reads at open: layer-1 items
 *  (likes, dislikes, agreements, heavy notes, unrecognised lines) plus
 *  layer-2 entry texts. Normalised, and only the ones long enough to
 *  match reliably (>= 10 chars) are kept — a short phrase ("查岗",
 *  "酸梅汤") appears in too many unrelated lines to prove a duplicate. */
export function memoryDedupeTexts(
  layer1: Layer1State | null,
  layer2: MemoryEntry[],
): string[] {
  const raw: string[] = [];
  if (layer1) {
    raw.push(
      ...layer1.likes,
      ...layer1.dislikes,
      ...layer1.agreements,
      ...layer1.heavyNotes,
      ...layer1.extra,
    );
  }
  for (const e of layer2) {
    if (typeof e.text === "string") raw.push(e.text);
  }
  const out: string[] = [];
  for (const t of raw) {
    const n = normalizeForDedupe(t);
    if (n.length >= 10) out.push(n);
  }
  return out;
}

/** True when the normalised log text says the same thing as one of the
 *  normalised MEMORY.md texts: one contains the other. The shorter
 *  side must be >= 10 chars, so a short generic phrase never matches.
 *  This is a containment check only — no semantic judgement, and it
 *  never deletes anything: the caller drops the log copy and keeps
 *  the curated MEMORY.md copy (which the skill already has). */
function duplicatesMemoryText(
  logNorm: string,
  memoryNorms: string[],
): boolean {
  if (logNorm.length < 10) return false;
  for (const m of memoryNorms) {
    const short = logNorm.length <= m.length ? logNorm : m;
    const long = logNorm.length <= m.length ? m : logNorm;
    if (short.length >= 10 && long.includes(short)) return true;
  }
  return false;
}

export function recallFromEntries(
  entries: MemoryEntry[],
  layer1: Layer1State | null,
  query: string,
  opts: RecallOptions = {},
  now = Date.now(),
): RecallResult {
  const window = opts.window ?? "persona";
  const tokenCap = opts.tokenCap ?? DEFAULT_TOKEN_CAP;
  const limit = opts.limit ?? 10;
  const tokens = tokenize(query);

  const scoped = entries.filter(
    (e) => window === "all" || e.window === window,
  );
  const byId = new Map(scoped.map((e) => [e.id, e]));

  // Keyword hits. A candidateIds set (from the keyword index) bounds
  // the log scan; archive rows are exempt (they are not in the index).
  const matched = new Map<string, string[]>(); // entry id -> matched tokens
  if (tokens.length > 0) {
    for (const e of scoped) {
      if (typeof e.text !== "string") continue; // defensive (audit B2)
      if (
        opts.candidateIds &&
        e.source !== "archive" &&
        !opts.candidateIds.has(e.id)
      ) {
        continue;
      }
      const entryTokens = new Set(tokenize(e.text));
      const hits = tokens.filter((t) => entryTokens.has(t));
      if (hits.length > 0) matched.set(e.id, hits);
    }
  }

  // Ranked by score. No keyword match (or empty query) means no hits
  // at all — see the header note. There is deliberately no
  // "most recent" fallback.
  let ranked: RecallHit[] = [];
  if (matched.size > 0) {
    ranked = [...matched.entries()]
      .map(([id, matchedTokens]) => {
        const entry = byId.get(id) as MemoryEntry;
        return {
          entry,
          score: scoreEntry(entry, matchedTokens.length, now),
          matchedTokens,
        };
      })
      .sort((a, b) => b.score - a.score || b.entry.ts - a.entry.ts);
  }

  // Dedupe BEFORE the token cap, but only across sources (audit m2):
  // a raw-log fragment and its monthly-archive copy are the same
  // memory and must not eat two cap slots — the first copy in ranked
  // order wins, whichever source it is. Genuine repeats INSIDE the
  // log ("好的" said twice, the same question on two days) are kept:
  // the second occurrence has its own time and context.
  const seenLogTexts = new Set<string>();
  const seenArchiveTexts = new Set<string>();
  ranked = ranked.filter((hit) => {
    const key = hit.entry.text.trim();
    if (hit.entry.source === "archive") {
      if (seenLogTexts.has(key) || seenArchiveTexts.has(key)) return false;
      seenArchiveTexts.add(key);
      return true;
    }
    if (seenArchiveTexts.has(key)) return false;
    seenLogTexts.add(key);
    return true;
  });

  // 0.1.6 recall dedupe: the skill already reads layer 1 + layer 2
  // (recent 30 days) at open. A raw-log hit saying the same thing as
  // a MEMORY.md entry would appear twice in context — drop the log
  // copy, keep the curated one (the skill already has it; nothing is
  // deleted from disk, the log entry stays). Archive hits are exempt:
  // the skill does NOT read archives at open, so an archive hit is
  // new information, not a repeat. Only log-source hits are filtered,
  // and only on a normalised containment match (>= 10 chars) — no
  // semantic judgement, and short overlaps never match.
  const memoryNorms = memoryDedupeTexts(layer1, opts.layer2 ?? []);
  if (memoryNorms.length > 0) {
    ranked = ranked.filter((hit) => {
      if (hit.entry.source === "archive") return true;
      return !duplicatesMemoryText(
        normalizeForDedupe(hit.entry.text),
        memoryNorms,
      );
    });
  }

  // Apply the token cap to the hits. Layer 1 is NOT part of the
  // injectable text: the skill already reads it at open, and the same
  // memory must never appear twice in context. (Layer 1 is returned
  // separately in the result for reference — e.g. the stage.)
  // An over-cap entry is SKIPPED, not a stop sign (audit m3): the
  // first hit is bound by the cap like any other, and smaller fitting
  // entries behind a giant one are still collected.
  let used = 0;
  const hits: RecallHit[] = [];
  for (const hit of ranked) {
    if (hits.length >= limit) break;
    const cost = estimateTokens(hit.entry.text) + 8; // + date/time line
    if (used + cost > tokenCap) continue;
    hits.push(hit);
    used += cost;
  }

  return {
    hits,
    layer1,
    estimatedTokens: used,
    text: formatRecallBlock(hits),
  };
}

/** Layer-1 display for memory_search. Uses the skill's own wording
 *  (喜好 / 厌恶); unrecognised layer-1 lines are shown verbatim so
 *  nothing the skill wrote is silently dropped from the display. */
export function formatLayer1(layer1: Layer1State): string {
  const lines: string[] = ["当前状态:"];
  if (layer1.name) lines.push(`名字: ${layer1.name}`);
  if (layer1.stage) lines.push(`阶段: ${layer1.stage}`);
  if (layer1.lastUpdated) lines.push(`最后更新时间: ${layer1.lastUpdated}`);
  if (layer1.likes.length > 0) lines.push(`喜好: ${layer1.likes.join(", ")}`);
  if (layer1.dislikes.length > 0) {
    lines.push(`厌恶: ${layer1.dislikes.join(", ")}`);
  }
  if (layer1.agreements.length > 0) {
    lines.push(`约定: ${layer1.agreements.join("; ")}`);
  }
  if (layer1.heavyNotes.length > 0) {
    lines.push(`重要记忆: ${layer1.heavyNotes.join("; ")}`);
  }
  for (const extra of layer1.extra) lines.push(extra);
  return lines.join("\n");
}

/** Injectable block: raw-log and archive hits ONLY — no layer 1.
 *  Archive rows are labelled [归档], not [user]: the skill format
 *  carries no role metadata for them, and her words must not be
 *  presented as his (audit m8). */
export function formatRecallBlock(hits: RecallHit[]): string {
  if (hits.length === 0) return "";
  const parts: string[] = ["相关记忆:"];
  for (const hit of hits) {
    const label =
      hit.entry.source === "archive" ? "归档" : hit.entry.role;
    parts.push(
      `- [${hit.entry.date} ${hit.entry.time} ${label}] ${hit.entry.text}`,
    );
  }
  return parts.join("\n");
}
