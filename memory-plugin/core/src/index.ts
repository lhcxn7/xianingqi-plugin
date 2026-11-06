// @memory-plugin/core — public surface.

export { MemoryCore } from "./core.ts";
export type { RecordInput } from "./core.ts";
export { MemoryFile, parseArchiveText, parseMemoryText } from "./memory-file.ts";
export { KeywordIndex, fingerprintLogFiles, fingerprintsEqual } from "./keyword-index.ts";
export { AppendLog } from "./log.ts";
export { atomicWriteText, ensureDir, listTempLeftovers } from "./atomic.ts";
export {
  acquireWriteLock,
  isLockStale,
  isPidAlive,
  lockDirPath,
  withWriteLock,
  DEFAULT_LOCK_TIMEOUT_MS,
  DEFAULT_LOCK_STALE_MS,
  DEFAULT_LOCK_RETRY_MS,
} from "./lock.ts";
export type { LockOptions, LockOwner } from "./lock.ts";
export {
  listSnapshots,
  pruneSnapshots,
  restoreSnapshot,
  snapshotComplete,
  takeSnapshot,
} from "./snapshot.ts";
export {
  DEFAULT_TOKEN_CAP,
  formatLayer1,
  formatRecallBlock,
  memoryDedupeTexts,
  normalizeForDedupe,
  recallFromEntries,
  scoreEntry,
} from "./recall.ts";
export type { RecallOptions } from "./recall.ts";
export { estimateTokens, tokenize } from "./tokenize.ts";
export {
  ageDays,
  formatDate,
  formatTime,
  monthKey,
  parseDateHeading,
} from "./dates.ts";
export type {
  CoreOptions,
  CoreStats,
  EndSessionResult,
  Importance,
  Layer1State,
  LogRolloverResult,
  MemoryEntry,
  MonthlySummary,
  ParsedMemoryFile,
  RecallHit,
  RecallResult,
  Role,
  WindowKind,
} from "./types.ts";
