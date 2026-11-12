import type { Provenance } from "./provenance.ts";

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
  /** 终版 WP1: what this entry is, independent of the window it was
   *  recorded in. "persona" = her side of the conversation, goes into
   *  memory (injection / review / starmap); "task" = user work she did,
   *  kept verbatim but never injected or reviewed; "greeting" = a bare
   *  trigger call ("夏柠柒"), kept as raw text, not memory. Absent on
   *  old entries = "persona" (zero migration). */
  kind?: "persona" | "task" | "greeting";
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
  /** 0.5.1 item 1 (fact version chain): identity of the fact this
   *  entry is a version of ("最喜欢的颜色", "喝咖啡"). Entries
   *  sharing a factKey are versions of one fact; the newest (by
   *  ts) is current, older ones are superseded. Absent = this
   *  entry is not versioned and recall treats it exactly as
   *  before. Set by the model (memory_remember) or by the admin
   *  correct path — never auto-derived from text (guessing a
   *  fact identity from keywords is how two different facts get
   *  merged into one chain). */
  factKey?: string;
  /** 0.5.1 item 1: id of the previous version this entry
   *  replaces (must share the factKey). The chain itself is
   *  factKey + ts order; this is the explicit link, for the
   *  admin UI and the audit trail. */
  supersedes?: string;
  /** 终版 WP4: epoch ms when the fact became true (absent = ts).
   *  Current-version selection and history answers prefer this over
   *  record time, so a backdated entry does not become "now". */
  validFrom?: number;
  /** 终版 WP4: epoch ms when the system learned the fact (absent =
   *  ts). Kept separate from validFrom: "搬去上海" may be true since
   *  March but only learned in November. */
  observedAt?: number;
  /** 终版 WP4: insufficient evidence. A candidate is kept in the log
   *  but never injected as an established fact; an explicit search
   *  can opt in. */
  candidate?: boolean;
}

/** Layer 1: current state, at the head of MEMORY.md, always read on open,
 *  never archived away. */
export type ProfileCategory =
  | "爱好习惯"
  | "理想"
  | "偏好"
  | "底线"
  | "身体健康"
  | "害怕担心"
  | "秘密"
  | "家人朋友";

export interface ProfileItem {
  text: string;
  /** Log entry ids this item was derived from. Required: a profile
   *  item with no source is a guess, not a memory. */
  sourceIds: string[];
  updatedAt: number;
}

export interface Layer1State {
  name?: string;
  stage?: string;
  /** 0.4.0 item 4 (画像常驻块, Memobase): standing profile — who
   *  she is and what stage the relationship is at. Read fresh from
   *  layer 1 on every recall, never indexed, never part of keyword
   *  recall. All fields optional: old MEMORY.md files without it
   *  run exactly as before (name/stage fall back to the layer-1
   *  keys above, likes/agreements are read from the layer-1 lists). */
  profile?: {
    name?: string;
    stage?: string;
    relationshipStage?: string;
    updatedAt?: number;
    /** 终版 WP6: structured 8-category profile. Each item carries its
     *  source ids; no sensitivity tier (deliberately dropped). */
    categories?: Partial<Record<ProfileCategory, ProfileItem[]>>;
  };
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
  /** 0.5.1 item 2: local embedding. Default off — disabled
   *  means the model is never loaded and recall is exactly
   *  keyword-only. */
  semanticRecall?: {
    enabled?: boolean;
    /** 终版 WP9: when `enabled` is omitted, turn semantic on if the
     *  runtime and model are both present. Default true. */
    autoEnable?: boolean;
    modelId?: string;
    modelDir?: string;
    modelRevision?: string;
    /** 0.5.3: directory whose node_modules holds the optional
     *  @huggingface/transformers runtime (default: dataDir). */
    runtimeDir?: string;
    /** 终版 WP8: max vectors kept in the semantic index. Over the
     *  cap, the build keeps the highest importance × recency. */
    maxEntries?: number;
    timeoutMs?: number;
    maxCandidates?: number;
    /** Similarity floor for semantic candidates (default 0.5;
     *  see SEMANTIC_DEFAULT_MIN_SIMILARITY in semantic.ts). */
    minSimilarity?: number;
  };
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
  /** 0.5.1 item 1: true when this hit is a superseded version of
   *  its fact — a newer version with the same factKey exists.
   *  Rendered as "·旧版" in the injected block. */
  superseded?: boolean;
  /** 终版 WP4: this hit is an unverified candidate (explicit search
   *  only; never auto-injected). */
  candidate?: boolean;
  /** 0.2.0: rarest matched token (valve topic). Graph hits inherit
   *  their seed's topic. */
  topic: string;
  /** 0.4.0 item 5 (心光选择): weight of the graph edge this hit
   *  arrived through — the second factor of the spotlight sort key
   *  (activation × edge weight). Direct keyword hits are 1 (no edge
   *  walked); graph hits carry the traversed edge's weight as of
   *  the walk (before the +0.05 traverse bump). Absent = 1. */
  edgeWeight?: number;
  /** 0.4.0 item 5: true when this hit is one of the (at most 3)
   *  spotlight candidates — picked by score only (activation ×
   *  edge weight, one per topic), for the in-session model to
   *  choose from. The code never picks the single ★ itself. */
  spotlightCandidate?: boolean;
  /** 0.4.0 item 5: reserved for a later explicit model mark — the
   *  model may one day flag the one memory it actually called out.
   *  The code never sets it; absent by default. */
  spotlight?: boolean;
  /** 0.2.0: compressed one-line summary injected instead of the
   *  full text (review compressed this entry). */
  displayText?: string;
  /** 0.2.0: this entry was compressed by review. */
  compressed?: boolean;
  /** 0.5.0 step 3: provenance of this hit — the fragment's when
   *  fragment-backed, otherwise the verbatim log line itself
   *  (user_quote / model_quote). Set in the token-cap loop. */
  provenance?: Provenance;
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
  /** 0.4.0 item 4 (画像常驻块): the standing profile block, kept
   *  SEPARATE from hits — it is not a recall result, it never goes
   *  through keyword recall, it takes no VALVE_TOP slot and its
   *  tokens are not counted in estimatedTokens. Empty string when
   *  there is no profile data at all (never null, never throws). */
  profileText: string;
  /** Rough token estimate of the injectable hits ONLY. Layer 1 is
   *  returned separately for reference and is never part of the
   *  injectable text, so it is not counted here. */
  estimatedTokens: number;
  /** Ready-to-inject text block (hits only, markdown — layer 1 is
   *  never injected). */
  text: string;
  /** 0.5.1 item 4: experiences whose triggers matched the query
   *  (rule + source), in the order injected. Empty when none
   *  matched. */
  experiences?: Array<{ rule: string; source: string }>;
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
  /** 0.4.0 item 2: stored beliefs (beliefs.json). */
  beliefs: number;
  /** 0.4.0 item 2: the three dimensions' current values — the
   *  same summary memory_belief get returns. Always present
   *  (empty dimensions read 0 / 1 / 0), so memory_status shows
   *  the relationship state without another call. */
  beliefDimensions: Record<BeliefDimension, BeliefDimensionSummary>;
  /** 0.4.4 item 2: memories flagged needsInvalidationCheck and
   *  not yet invalidated — "awaiting model review" (see
   *  stats()). */
  pendingInvalidationChecks: number;
  /** 终版 WP1: entry counts by content kind (see MemoryEntry.kind). */
  kinds?: { persona: number; task: number; greeting: number };
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
  /** 0.4.0 item 1 (Graphiti 双时间戳失效): the memory is valid
   *  from this time (defaults to the entry's ts when absent).
   *  Absent = no lower bound recorded. */
  validFrom?: number;
  /** 0.4.0 item 1: the memory stopped being true at this time.
   *  null = still valid; a timestamp <= now means expired — recall
   *  skips it (never deletes it). Absent = never invalidated. */
  validTo?: number | null;
  /** 0.4.0 item 1: review flagged this memory for an invalidation
   *  check (significant + an opposite statement appeared recently).
   *  A flag only — never an auto-invalidation. */
  needsInvalidationCheck?: boolean;
  /** 0.4.0 item 6 (分速率衰减): 细节清晰度 — the detail track.
   *  Defaults to `clarity` when absent: the old single clarity IS
   *  the detail track, so old rows keep their value. Review decays
   *  it at the detail rate (detailLambda) and recall bumps it
   *  alongside `clarity`; the two are kept in sync. */
  detailClarity?: number;
  /** 0.4.0 item 6: 情绪保留度 0..1 — the emotion track. Fresh
   *  memories start at 1.0; review decays it at the (slower)
   *  emotion rate (emotionLambda), floored at 0.05 like clarity.
   *  Recall never touches it — remembering the words does not
   *  refresh the feeling. */
  emotionRetain?: number;
  /** 0.5.0 step 4: user feedback counts (memory_feedback).
   *  correct = the user confirmed it right (a verification),
   *  wrong = the user said it is wrong (the entry is invalidated),
   *  irrelevant = the user said it does not belong here (recall
   *  ranking halves per count, significance halves once per
   *  feedback). All optional: old rows have none. */
  feedbackCorrect?: number;
  feedbackWrong?: number;
  feedbackIrrelevant?: number;
  lastFeedbackAt?: number;
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
  /** 0.4.0 item 1: the link stopped being true at this time
   *  (null = still valid; absent = never invalidated). An expired
   *  edge is never traversed by recall — the link stays in
   *  graph.json, only skipped. */
  validTo?: number | null;
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
    /** 0.5.1 (0.4.5 item 7): edges the last review's backfill
     *  upgraded in place (session -> keyword), not new edges. */
    edgesUpgraded: number;
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
  /** 0.4.0 item 2: entry clusters the review proposes for a
   *  belief (same propose-only rule as fragments — a belief is
   *  created by the model through memory_belief, quote-verified
   *  against the log, never written by the review itself). Not
   *  persisted. */
  beliefCandidates?: BeliefCandidate[];
  /** 0.4.0 item 1: entry ids the review flagged for an invalidation
   *  check this run (newly flagged only — already-flagged rows stay
   *  flagged in attributes.json). Mark only, never auto-invalidate.
   *  Not persisted (the flag itself lives in attributes.json). */
  invalidationChecks?: string[];
  /** 0.4.0 item 3: the reflection prompt for the model — present
   *  ONLY when the last 24 h of new persona memories cleared the
   *  anti-disturbance floor (REFLECTION_MIN_FLOOR). The review
   *  only PROPOSES: whether to reflect, and what to conclude, is
   *  the model's call (memory_reflect), never the code's. Below
   *  the floor this is undefined — no prompt is built at all.
   *  Not persisted. */
  reflectionPrompt?: string;
  /** 0.4.0 item 7: the proactivity prompt for the model — present
   *  when there is anything to weigh today (new persona memories,
   *  beliefs, or reflections). The review only PROPOSES: whether
   *  to act, and what to say, is the model's call (memory_proact),
   *  never the code's. Empty day (no memories, no beliefs, no
   *  reflections) → undefined, no prompt at all. Not persisted. */
  proactPrompt?: string;
  /** 0.4.6 (0.4.5 audit new issue 1): the entry ids behind the
   *  daily review's ONE merged recent section — reflection entries
   *  ∪ proact memories, de-duplicated, in review order. The shell
   *  resolves them to entries and hands them to
   *  buildModelReviewPrompt, which caps them (20 entries / 3000
   *  characters) and renders a single section instead of pasting
   *  the two full prompts. Empty when there is nothing recent to
   *  show. Not persisted. */
  recentEntryIds?: string[];
  /** 0.4.6: which instruction blocks the merged recent section
   *  carries — reflection (the floor was cleared), proact (a
   *  proactivity prompt was built), or both. Not persisted. */
  recentKinds?: { reflection: boolean; proact: boolean };
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

// ---- 0.4.0 item 2: 带证据的信念层 + 三维信念 --------------------

/** The three relationship dimensions a belief belongs to. */
export type BeliefDimension = "safety" | "trust" | "closeness";

/** One supporting evidence item: the log entry it came from plus a
 *  VERBATIM quote copied from that entry's text (never paraphrased
 *  — the code checks the quote against the log at write time). */
export interface BeliefEvidence {
  entryId: string;
  quote: string;
}

/** A belief about the relationship ("他难过时会来找我"), held with
 *  evidence. The strength moves only by model-supplied deltas
 *  (clamped to ±0.2 per call by the code, strength always 0..1);
 *  the code never invents or scores evidence on its own. */
export interface Belief {
  /** BEL_SAFETY_001 style id, assigned at creation. */
  id: string;
  dimension: BeliefDimension;
  /** One sentence, model-written. */
  statement: string;
  /** 0..1. */
  strength: number;
  evidence: BeliefEvidence[];
  /** = evidence.length. */
  proofCount: number;
  /** 0..1 — high when newly met, lower as the relationship grows. */
  uncertainty: number;
  updatedAt: number;
  /** 0.4.0 item 2 (去机械化): entry ids whose contradiction was
   *  already charged once — a repeat contradict for the same entry
   *  is ignored, never deducted twice. Absent = none yet. */
  contradicting?: string[];
  /** 0.5.0 step 3: provenance — sourceIds are the evidence entry
   *  ids, sourceType is always model_inference (a belief is a
   *  model judgement), confidence is code-computed from the type
   *  + verification count. The model never writes the number. */
  provenance?: Provenance;
}

/** One review-proposed belief cluster (0.4.0 item 2): entries
 *  sharing a rare topic token, none of them folded into a belief
 *  yet. The review only PROPOSES — the model writes the statement
 *  and picks the dimension when it confirms via memory_belief, so
 *  the candidate carries no statement and no dimension guess. */
export interface BeliefCandidate {
  topic: string;
  sourceIds: string[];
  /** Verbatim excerpts from the sources (substrings of the entry
   *  texts), so the model can quote them back at confirmation. */
  quotes: string[];
}

/** One dimension's current value: the model's get/status view.
 *  Empty dimensions read strength 0, uncertainty 1 (unknown),
 *  proofCount 0 — never null, never a crash. */
export interface BeliefDimensionSummary {
  strength: number;
  uncertainty: number;
  proofCount: number;
  /** How many stored beliefs feed this dimension. */
  beliefs: number;
}
