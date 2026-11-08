// Shared types for @memory-plugin/core.
// Erasable TypeScript only (no enums, no parameter properties) so Node
// runs these files directly via type stripping.

export type Role = "user" | "assistant";

/** Which kind of host window a message came from. Only "persona" records
 *  go into persona memory; "task" records are kept separable and never
 *  injected as persona experience. */
export type WindowKind = "persona" | "task";

/** "heavy" = promises, firsts, fights-and-reconciliations, bottom lines,
 *  stage changes. Heavy memories stay in layer 1 and are never compressed
 *  away at month-end. "light" = everything else; compresses to one line. */
export type Importance = "heavy" | "light";

export interface MemoryEntry {
  /** Stable id: `${ts}-${counter}-${random}`. */
  id: string;
  /** Epoch ms. */
  ts: number;
  /** Host-local date, YYYY/MM/DD. */
  date: string;
  /** Host-local time, HH:MM (minute precision). */
  time: string;
  role: Role;
  window: WindowKind;
  sessionId: string;
  importance: Importance;
  text: string;
  /** Where the entry came from: the verbatim log, or a skill archive
   *  file. Archive rows carry no role metadata in the skill format
   *  (they default to role "user"); the source keeps her words from
   *  being labelled [user] in recall output (audit m8), and lets
   *  recall dedupe log-vs-archive copies without deleting genuine
   *  repeats inside the log (audit m2). */
  source?: "log" | "archive";
}

/** Layer 1: current state, at the head of MEMORY.md, always read on open,
 *  never archived away. */
export interface Layer1State {
  name?: string;
  stage?: string;
  /** Last update time, minute precision (skill: 最后更新时间). */
  lastUpdated?: string;
  likes: string[];
  dislikes: string[];
  agreements: string[];
  counters: Record<string, number>;
  /** Heavy memories kept as standing lines in layer 1. */
  heavyNotes: string[];
  /** Layer-1 lines the parser did not recognise, kept verbatim so a
   *  hand-written file round-trips without losing anything. */
  extra: string[];
}

export interface MonthlySummary {
  month: string; // YYYY-MM
  total: number;
  heavy: number;
  /** One-sentence major events (extractive, max 3). */
  events: string[];
}

export interface ParsedMemoryFile {
  layer1: Layer1State;
  /** Layer 2: recent entries, ascending by ts. */
  layer2: MemoryEntry[];
  /** Layer 3: monthly summaries, ascending by month. */
  layer3: MonthlySummary[];
}

export interface CoreOptions {
  /** Data directory, e.g. ./xia-ningqi-data. Created if missing. */
  dataDir: string;
  /** Current-log entry cap; oldest entries roll into per-month
   *  log segments when exceeded. Default 1000. */
  logMaxEntries?: number;
  /** Snapshots to keep. Default 30. */
  snapshotKeep?: number;
}

export interface RecallHit {
  entry: MemoryEntry;
  score: number;
  matchedTokens: string[];
  /** 0.2.0 five-factor activation (content x relationship x
   *  emotion x time x attention). 0 when the valve is off. */
  activation: number;
  /** 0.2.0: true when this hit arrived via a graph edge, not a
   *  keyword match. */
  viaGraph?: boolean;
  /** 0.2.0: rarest matched token (valve topic). Graph hits inherit
   *  their seed's topic. */
  topic: string;
  /** 0.2.0: compressed one-line summary injected instead of the
   *  full text (review compressed this entry). */
  displayText?: string;
  /** 0.2.0: this entry was compressed by review. */
  compressed?: boolean;
  /** 0.3.0: this hit injects a fragment instead of the full entry
   *  text (the fragment is ~10 tokens vs ~100 for its sources). */
  fragmentId?: string;
  /** 0.3.0: the fragment's tone label, e.g. 很喜欢. */
  fragmentTone?: string;
  /** 0.3.0: true when this hit's fragment failed its retrieval-
   *  time re-check — the injected text is the verbatim source
   *  instead, and the fragment is marked suspect. */
  fragmentFallback?: boolean;
}

export interface RecallResult {
  hits: RecallHit[];
  layer1: Layer1State | null;
  /** Rough token estimate of the injectable hits ONLY. Layer 1 is
   *  returned separately for reference and is never part of the
   *  injectable text, so it is not counted here. */
  estimatedTokens: number;
  /** Ready-to-inject text block (hits only, markdown — layer 1 is
   *  never injected). */
  text: string;
}

/** Result of rolling the current log into per-month segments. The
 *  entries are MOVED, never deleted: every segment stays indexed and
 *  searchable. */
export interface LogRolloverResult {
  moved: number;
  segments: string[];
  /** month -> number of entries rolled into it. */
  byMonth: Record<string, number>;
}

export interface EndSessionResult {
  snapshot: string;
  rollover: LogRolloverResult;
}

export interface CoreStats {
  totalEntries: number;
  layer2Count: number;
  archiveMonths: string[];
  indexTokens: number;
  snapshots: string[];
  /** 0.2.0: graph edges / stored attribute rows / last review time. */
  graphEdges: number;
  attributes: number;
  lastReviewAt: number | null;
  /** 0.3.0: stored fragments / fragments marked suspect. */
  fragments: number;
  suspectFragments: number;
}

// ---- 0.2.0: graph + attributes + activation + review + starmap ----

/** Emotion tag on a memory: type (e.g. 温暖) + intensity 0..1. */
export interface EmotionTag {
  type: string;
  intensity: number;
}

/** Per-memory attributes (0.2.0), persisted in attributes.json.
 *  Old log entries with no stored row get computed defaults —
 *  nothing is ever lost. Retrievability is NOT stored: it is
 *  computed from these fields (see attributes.ts). */
export interface MemoryAttributes {
  emotion?: EmotionTag;
  /** 0..1. Fresh memories start at 1.0, decay with time, rise
   *  when recalled. Never reaches 0 (details fade, never erase). */
  clarity: number;
  /** How many times recall surfaced this entry. */
  recallCount: number;
  /** 意义强度 0..1: heavy 0.9, light 0.4. Review raises it for
   *  repeatedly recalled entries (≥3 → 0.8, ≥5 → 0.9) and the
   *  daily model review raises model-marked entries to 0.9. No
   *  keyword list decides it. */
  significance: number;
  /** True once review compressed this entry to a one-line summary
   *  in summary-YYYY-MM.jsonl (original log entry untouched). */
  compressed?: boolean;
  /** 0.3.0: the daily model review marked this memory important.
   *  The code review never compresses a model-marked entry. */
  modelMarked?: boolean;
  compressedAt?: number;
  lastRecalledAt?: number;
  lastReviewedAt?: number;
}

/** One undirected link between two log entries (0.2.0, graph.json).
 *  Weight in (0, 1]: grows when traversed, decays slowly when
 *  unused, never to zero. */
export interface GraphEdge {
  /** Canonical order: from < to (lexicographic), so (A,B) == (B,A). */
  from: string;
  to: string;
  /** session: adjacent entries in one session; keyword: shared rare
   *  keyword; recall: entry A was recalled and the conversation
   *  then moved to B. */
  type: "session" | "keyword" | "recall";
  weight: number;
  lastTraversedAt: number;
}

/** One compressed line for a light old memory (0.2.0), stored in
 *  summary-YYYY-MM.jsonl. The original log entry is never touched. */
export interface CompressedSummary {
  entryId: string;
  month: string;
  summary: string;
  ts: number;
}

/** Daily review state (0.2.0), persisted in review.json. */
export interface ReviewState {
  version: 1;
  lastReviewedAt: number | null;
  totalReviews: number;
  lastSummary: string;
  lastStats: {
    decayed: number;
    promoted: number;
    compressed: number;
    edgesAdded: number;
    entries: number;
  };
}

export interface ReviewResult extends ReviewState {
  ran: boolean;
  /** 0.3.0: clusters of related entries the review proposes for
   *  fragmenting. The review only PROPOSES — a fragment is created
   *  by the model through memory_fragment / createFragment, so both
   *  paths share the same code verification. Not persisted. */
  fragmentCandidates?: FragmentCandidate[];
}

/** One review-proposed fragment cluster (0.3.0): entries sharing a
 *  rare topic token, none of them folded into a fragment yet. */
export interface FragmentCandidate {
  topic: string;
  sourceIds: string[];
  keywords: string[];
}

/** Result of generating the starmap HTML (0.2.0). */
export interface StarmapResult {
  path: string;
  nodes: number;
  edges: number;
  generatedAt: number;
}
