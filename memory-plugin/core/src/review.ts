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
import { compressSummary, type AttributeStore } from "./attributes.ts";
import { ageDays } from "./dates.ts";
import { monthKey } from "./dates.ts";
import type { MemoryGraph } from "./graph.ts";
import type { KeywordIndex } from "./keyword-index.ts";
import { formatDate } from "./dates.ts";
import { tokenize } from "./tokenize.ts";
import type {
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

/** Read every summary-YYYY-MM.jsonl into entryId -> one-line summary.
 *  Torn lines are skipped, like the log. */
export function loadSummaries(dataDir: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(dataDir)) return out;
  for (const name of readdirSync(dataDir)) {
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
  const fd = openSync(file, "a");
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
      if (entry.window !== "persona") continue;
      if (alreadyFragmented.has(entry.id)) continue;
      for (const token of new Set(
        tokenize(entry.text).filter((t) => t.length >= 2),
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
  const summary =
    `${formatDate(now)} 复盘：共 ${input.entries.length} 条记忆；` +
    `${decayed} 条清晰度衰减；${promoted} 条提了上去；` +
    `${compressed} 条旧记忆压成一行；新连 ${edgesAdded} 条线。` +
    (fragmentCandidates.length > 0
      ? `${fragmentCandidates.length} 组可提炼成片段。`
      : "");
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
      entries: input.entries.length,
    },
  };
  input.attrs.save();
  input.graph.save();
  saveReviewState(input.dataDir, next);
  return { ...next, ran: true, fragmentCandidates };
}
