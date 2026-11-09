// @memory-plugin/core — public surface.

export { MemoryCore } from "./core.ts";
export type { PrepareProactPromptResult, RecordInput } from "./core.ts";
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
  formatProfileBlock,
  formatRecallBlock,
  invalidateEntries,
  isExpired,
  memoryDedupeTexts,
  normalizeForDedupe,
  recallFromEntries,
  scoreEntry,
  selectSpotlightCandidates,
} from "./recall.ts";
export type { RecallOptions } from "./recall.ts";
// 0.4.1 item 1: memory_profile write path — the standing profile
// lives in profile.json (plugin-owned, never MEMORY.md), and
// loadProfile/saveProfile/mergeProfile are the only way in or out.
// mergeProfile is what the recall path uses to let profile.json win
// over the layer-1 assembly: it copies profile.name/stage onto
// the layer-1 fields themselves (layer-1 keys are the fallback),
// so formatLayer1 and formatProfileBlock agree on the same
// person; formatProfileBlock additionally prefers profile.*
// field by field when both are present.
export {
  PROFILE_FILE,
  loadProfile,
  mergeProfile,
  saveProfile,
} from "./profile.ts";
export type { PersonaProfile } from "./profile.ts";
export { estimateTokens, tokenize } from "./tokenize.ts";
export {
  ageDays,
  formatDate,
  formatTime,
  monthKey,
  parseDateHeading,
} from "./dates.ts";
export type {
  Belief,
  BeliefCandidate,
  BeliefDimension,
  BeliefDimensionSummary,
  BeliefEvidence,
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
// 0.4.0 item 2: 带证据的信念层 + 三维信念.
export {
  BELIEF_DECAY_PER_DAY,
  BELIEF_DIMENSION_CN,
  BELIEF_DIMENSIONS,
  BELIEF_INITIAL_STRENGTH,
  BELIEF_INITIAL_UNCERTAINTY,
  BELIEF_MAX_DELTA,
  BELIEF_MIN_QUOTE_CHARS,
  BELIEFS_FILE,
  BeliefStore,
  formatBeliefLine,
  summarizeBeliefs,
  verifyBeliefEvidence,
} from "./beliefs.ts";
export type {
  BeliefAdjustResult,
  BeliefCreateInput,
  BeliefCreateResult,
} from "./beliefs.ts";
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
  detailLambda,
  emotionLambda,
  emotionPolarity,
  emotionRetain,
  factLambda,
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
  attentionFactor,
  COMMON_TOKENS,
  computeActivation,
  contentTokens,
  emotionFactor,
  topicOf,
} from "./activation.ts";
export {
  COMPRESS_AGE_DAYS,
  COMPRESS_SIGNIFICANCE_BELOW,
  INVALIDATION_CHECK_DAYS,
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
  RECENT_MAX_CHARS,
  RECENT_MAX_ENTRIES,
  buildModelReviewPrompt,
  parseModelReviewIds,
  selectCappedEntries,
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
// 0.4.0 item 3: 反思触发器 (Generative Agents reflection).
// No hard score threshold: the code only enforces the tiny
// anti-disturbance floor (REFLECTION_MIN_FLOOR) and hands the
// model the prompt; whether to reflect is the model's call.
// A saved reflection is a type: "reflection" fragment — its
// insight words are new by design, so only its 「」 citations
// are verified verbatim (quote-only).
export {
  REFLECTION_MIN_FLOOR,
  REFLECTION_MIN_QUOTE_CHARS,
  REFLECTION_WINDOW_MS,
  buildReflectionPrompt,
  extractReflectionQuotes,
  reflectionGate,
  saveReflection,
  verifyReflection,
} from "./reflection.ts";
export type {
  ReflectionCheck,
  ReflectionGate,
  ReflectionSaveResult,
  ReflectionVerifyResult,
} from "./reflection.ts";
// 0.4.0 item 7: 行为回流 · 会话内主动版.
// Judgement belongs to the model (buildProactPrompt /
// parseProactDecision), guardrails to the code (checkGuardrails:
// one action a day, no repeat of a trigger within 7 days, 3
// pending max with the oldest dropped). loop.json holds loop
// state only, never chat text; the user's reply closes the loop
// through recordOutcome (log.jsonl, like any ordinary message).
// deliver() is the channel seam: session hands the model's own
// words back for the chat, qq throws qq_not_connected until QQ
// is wired up. No fixed template sentence lives in loop.ts.
export {
  LOOP_FILE,
  LOOP_MAX_PENDING,
  LOOP_TRIGGER_COOLDOWN_MS,
  LOOP_TRIGGER_REPEAT_MS,
  LoopStore,
  PROACT_PROMPT_TTL_MS,
  buildProactPrompt,
  checkGuardrails,
  deliver,
  parseProactDecision,
  recordOutcome,
} from "./loop.ts";
export type {
  AddActionResult,
  LoopState,
  PendingAction,
  PendingPrompt,
  ProactChannel,
  ProactDecision,
} from "./loop.ts";
export {
  MAX_STARMAP_NODES,
  SHIGUANG_SELF,
  SHIGUANG_USER,
  STARMAP_FILE,
  buildStarmapData,
  emotionColor,
  renderStarmapHtml,
} from "./starmap.ts";
export type {
  ShiguangCat,
  ShiguangMemory,
  ShiguangTrace,
  StarmapData,
} from "./starmap.ts";
