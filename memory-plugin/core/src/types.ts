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
}
