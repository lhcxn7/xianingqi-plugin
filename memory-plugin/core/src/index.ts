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
  EmotionTag,
  EndSessionResult,
  FragmentCandidate,
  GraphEdge,
  Importance,
  Layer1State,
  LogRolloverResult,
  MemoryAttributes,
  MemoryEntry,
  MonthlySummary,
  ParsedMemoryFile,
  RecallHit,
  RecallResult,
  ReviewResult,
  ReviewState,
  Role,
  StarmapResult,
  WindowKind,
} from "./types.ts";
// 0.2.0: graph, attributes, activation, review, starmap.
export {
  GRAPH_FILE,
  MAX_KEYWORD_EDGES_PER_ENTRY,
  MAX_RARE_DF,
  MemoryGraph,
} from "./graph.ts";
export {
  ATTRIBUTES_FILE,
  AttributeStore,
  clarityLambda,
  compressSummary,
  defaultClarity,
  emotionPolarity,
  initialSignificance,
  retrievability,
  tagEmotion,
} from "./attributes.ts";
export {
  ACTIVATION_THRESHOLD,
  GRAPH_HOP_DECAY,
  VALVE_PER_TOPIC,
  VALVE_TOP,
  applyValveTop,
  computeActivation,
  contentTokens,
  emotionFactor,
  topicOf,
} from "./activation.ts";
export {
  COMPRESS_AGE_DAYS,
  COMPRESS_SIGNIFICANCE_BELOW,
  REVIEW_FILE,
  REVIEW_INTERVAL_MS,
  defaultReviewState,
  loadReviewState,
  loadSummaries,
  runReview,
} from "./review.ts";
export type { ReviewInput } from "./review.ts";
// 0.3.0: daily model review (new layer 2 — replaces the
// HEAVY_SIGNAL_WORDS keyword list). The 20 categories guide the
// model's judgment; the prompt hands yesterday's messages to her;
// the parser turns her output into memory ids.
export {
  MODEL_REVIEW_CATEGORIES,
  buildModelReviewPrompt,
  parseModelReviewIds,
} from "./model-review.ts";
export {
  FRAGMENTS_FILE,
  FRAGMENT_MAX_QUOTES,
  FRAGMENT_MAX_TOKENS,
  FragmentStore,
  detectToneLevels,
  fragmentKeyTerms,
  parseToneLabel,
  sourceToneLevel,
  verifyFragment,
} from "./fragments.ts";
export type {
  Fragment,
  FragmentCreateResult,
  FragmentInput,
  FragmentTone,
  FragmentVerifyResult,
  ToneLevel,
} from "./fragments.ts";
export {
  MAX_STARMAP_NODES,
  STARMAP_FILE,
  buildStarmapData,
  emotionColor,
  renderStarmapHtml,
} from "./starmap.ts";
