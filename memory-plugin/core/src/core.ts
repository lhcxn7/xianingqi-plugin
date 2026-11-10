// MemoryCore: the single writer for the plugin's own store.
//
// Division of labour with the skill (anti-conflict rules, v1):
// - The plugin writes ONLY its own append-only log (log.jsonl, rolled
//   into per-month log-YYYY-MM.jsonl segments) and its keyword index
//   (index.json). It NEVER writes MEMORY.md — the three-layer summaries
//   stay written by the model following the skill.
// - Recall injects ONLY what the skill has not already read: raw-log
//   fragments and monthly-archive detail. Layer 1 (current state) is
//   read by the skill at open, so it is returned for reference but is
//   NOT part of the injectable text — the same memory must never appear
//   twice in context.
// - The plugin injects facts only and never makes stage judgments;
//   stage comes from MEMORY.md layer 1.
// - 0.2.0 additions are all plugin-owned too: the memory graph
//   (graph.json), per-memory attributes (attributes.json), review
//   state (review.json), compressed one-line summaries
//   (summary-YYYY-MM.jsonl) and the starmap (starmap.html, derived
//   and regenerable — NOT snapshotted). The skill's files are never
//   written; the graph/attributes/review only ever describe the
//   plugin's own log.
// - Memory entries are never deleted. Log rollover MOVES entries into
//   segments; snapshots copy only the plugin's own files (log + index
//   + segments + persona-sessions.json) and NEVER MEMORY.md, the
//   monthly archives or the diary — restore can only bring back the
//   plugin's own files, never revert her memory or diary to snapshot
//   time (audit, 0.1.3). (Snapshots themselves rotate: keep=30 by
//   default. Restore replaces only the files present in the snapshot
//   and never deletes other files in the data folder — see
//   snapshot.ts.)
// - Multi-process writes are serialised by a file lock
//   (core/src/lock.ts, 0.1.6): <dataDir>/.locks/write.lock, atomic
//   mkdir, 5 s acquire timeout, stale after 30 s with a dead owner
//   pid. Two processes writing the same log.jsonl at once used to
//   interleave appends and overwrite each other's index.json with a
//   stale in-memory copy; the lock makes every write (record,
//   rollover, flush, snapshot, restore, endSession) atomic across
//   processes. Instances do NOT share in-memory state: a process only
//   recalls what it has loaded, and picks up another process's
//   entries at the next flush (which reloads when the log files
//   changed) or restart. The lock guarantees no lost or corrupt
//   writes on disk; it does not make two processes see each other's
//   unflushed memory.

import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { atomicWriteText, cleanTempLeftovers, ensureDir } from "./atomic.ts";
import { AttributeStore, initialSignificance } from "./attributes.ts";
import { BeliefStore } from "./beliefs.ts";
import type {
  BeliefAdjustResult,
  BeliefCreateInput,
  BeliefCreateResult,
} from "./beliefs.ts";
import { formatDate, formatTime, monthKey } from "./dates.ts";
import { FragmentStore } from "./fragments.ts";
import {
  ForgetStore,
  buildForgetPreview,
  type ForgetMode,
  type ForgetPreview,
  type ForgetRequest,
} from "./forget.ts";
import { ExperienceStore } from "./experiences.ts";
import { GoalStore } from "./goals.ts";
import type {
  FragmentCreateResult,
  FragmentInput,
} from "./fragments.ts";
import { MemoryGraph } from "./graph.ts";
import {
  LoopStore,
  buildProactPrompt,
  checkGuardrails,
  recordOutcome,
} from "./loop.ts";
import type {
  LoopState,
  PendingAction,
  ProactChannel,
  ProactDecision,
} from "./loop.ts";
import {
  acquireWriteLock,
  DEFAULT_LOCK_TIMEOUT_MS,
} from "./lock.ts";
import { AppendLog } from "./log.ts";
import {
  KeywordIndex,
  fingerprintLogFiles,
  fingerprintsEqual,
  type FileFingerprint,
} from "./keyword-index.ts";
import { MemoryFile } from "./memory-file.ts";
import { loadProfile, mergeProfile, saveProfile, type PersonaProfile } from "./profile.ts";
import { DEFAULT_TOKEN_CAP, formatProfileBlock, matchTokensFor, recallFromEntries } from "./recall.ts";
import type { SemanticRetriever } from "./retrieval.ts";
import {
  REVIEW_INTERVAL_MS,
  loadReviewState,
  loadSummaries,
  runReview,
} from "./review.ts";
import {
  RECENT_MAX_CHARS,
  RECENT_MAX_ENTRIES,
  selectCappedEntries,
} from "./model-review.ts";
import type { CappedSelection } from "./model-review.ts";
import {
  buildReflectionPrompt,
  reflectionGate,
  saveReflection,
} from "./reflection.ts";
import type {
  ReflectionCheck,
  ReflectionSaveResult,
} from "./reflection.ts";
import {
  listSnapshots,
  restoreSnapshot,
  takeSnapshot,
} from "./snapshot.ts";
import {
  SEMANTIC_DEFAULT_MAX_CANDIDATES,
  SEMANTIC_DEFAULT_MIN_SIMILARITY,
  SEMANTIC_DEFAULT_TIMEOUT_MS,
  SEMANTIC_DIMENSIONS,
  SEMANTIC_MODEL_ID,
  SEMANTIC_MODEL_REVISION,
  SEMANTIC_POOLING,
  SEMANTIC_QUERY_PREFIX,
  SemanticIndex,
  SemanticSearcher,
  TransformersEmbeddingProvider,
  buildSemanticIndex,
  findBundledModelDir,
  type SemanticIndexLoadStatus,
} from "./semantic.ts";
import {
  STARMAP_FILE,
  buildStarmapData,
  renderStarmapHtml,
} from "./starmap.ts";
import { tokenize } from "./tokenize.ts";
import type {
  Belief,
  BeliefDimension,
  BeliefDimensionSummary,
  CoreOptions,
  CoreStats,
  EmotionTag,
  EndSessionResult,
  Importance,
  Layer1State,
  LogRolloverResult,
  MemoryEntry,
  ParsedMemoryFile,
  RecallResult,
  ReviewResult,
  Role,
  StarmapResult,
  WindowKind,
} from "./types.ts";

const LOG_FILE = "log.jsonl";
const INDEX_FILE = "index.json";

/** What prepareProactPrompt hands back: the prompt and the token
 *  that binds the model's decision to it, plus the source ids the
 *  prompt showed. `prompted: false` with a `reason` means the
 *  day's quota is spent; without one means there is nothing at
 *  all to weigh. */
export interface PrepareProactPromptResult {
  prompted: boolean;
  prompt?: string;
  promptToken?: string;
  sourceIds?: string[];
  reason?: string;
}

export interface RecordInput {
  role: Role;
  text: string;
  window?: WindowKind;
  importance?: Importance;
  sessionId?: string;
  /** Epoch ms. Defaults to now. Tests pass explicit old timestamps. */
  ts?: number;
  /** 0.2.0: model-supplied emotion tag; the lexicon guesses when
   *  absent. */
  emotion?: EmotionTag;
  /** 0.5.1 item 1: fact identity (see MemoryEntry.factKey). A
   *  non-empty string of at most 80 chars; absent = unversioned. */
  factKey?: string;
  /** 0.5.1 item 1: id of the previous version this entry
   *  replaces. Must reference an existing entry with the same
   *  factKey, else record() throws. */
  supersedes?: string;
}

/** 0.5.0 step 4: what the user said about a recalled memory. */
export type FeedbackKind = "correct" | "wrong" | "irrelevant";

export interface FeedbackResult {
  ok: boolean;
  entryId: string;
  kind: FeedbackKind;
  /** Entry ids invalidated by this feedback (only "wrong"). */
  invalidated: string[];
  fragmentId?: string;
  /** The entry's feedback counts after this call. */
  feedback: { correct: number; wrong: number; irrelevant: number };
  /** The entry's significance after this call ("irrelevant"
   *  halves it, floored at 0.1). */
  significance?: number;
  /** Why not ok (unknown entry id). */
  reason?: string;
}

export class MemoryCore {
  readonly dataDir: string;
  private readonly logMaxEntries: number;
  private readonly snapshotKeep: number;
  private readonly memoryFile: MemoryFile;
  private readonly index: KeywordIndex;
  /** 0.2.0: memory graph (edges between log entries). */
  private readonly graph: MemoryGraph;
  /** 0.2.0: per-memory attributes. */
  private readonly attrs: AttributeStore;
  /** 0.3.0: fragments (summary layer on top of the log). */
  private readonly fragments: FragmentStore;
  /** 0.4.0 item 2: beliefs (evidence-backed belief layer +
   *  three relationship dimensions). */
  private readonly beliefs: BeliefStore;
  /** 0.4.0 item 7: behaviour loop (proactive actions, loop.json). */
  private readonly loop: LoopStore;
  /** 0.5.1 item 1: forgetting governance — requests, approvals,
   *  tombstones (forgotten.json) and the append-only audit. */
  readonly forget: ForgetStore;
  /** 0.5.1 item 4: experience learning — rules from mistakes. */
  readonly experiences: ExperienceStore;
  /** 0.5.1 item 5: goals / todos. */
  readonly goals: GoalStore;
  /** 0.5.1 item 2: local embedding. Lazy: nothing is loaded
   *  until semantic is enabled and ensureSemanticIndex() runs. */
  private semanticProvider: TransformersEmbeddingProvider | null = null;
  private semanticIndex: SemanticIndex | null = null;
  private semanticIndexStatus: SemanticIndexLoadStatus | null = null;
  private readonly semanticConfig: {
    enabled: boolean;
    modelId: string;
    modelDir: string;
    modelRevision: string;
    runtimeDir: string;
    timeoutMs: number;
    maxCandidates: number;
    minSimilarity: number;
  };
  /** 0.2.0: entryId -> compressed one-line summary (review). */
  private summaries: Map<string, string>;
  /** 0.2.0: last entry per session, for session-edge linking. */
  private lastBySession = new Map<string, MemoryEntry>();
  /** 0.2.0: entry ids surfaced by the last recall per session —
   *  the next record in that session links to them as "recall"
   *  edges (the conversation moved there because A was recalled). */
  private pendingRecallLinks = new Map<string, string[]>();
  private entries: MemoryEntry[] = [];
  private counter = 0;
  /** Entries currently in log.jsonl (not yet rolled into segments).
   *  Maintained incrementally so record() never re-reads the file. */
  private currentLogCount = 0;
  /** Re-entrancy depth for the write lock (record() -> rollover()).
   *  The on-disk lock arbitrates between processes AND between
   *  instances in the same process; the depth only stops one instance
   *  deadlocking on itself. */
  private lockDepth = 0;
  private lockRelease: (() => void) | null = null;
  /** Fingerprints of the log files AND the store files as this
   *  instance last saw them. refreshIfStale() reloads when another
   *  writer changed any of them. 0.5.1 (0.4.3 item 11): the old
   *  fingerprint covered the log only, so a second process that
   *  changed beliefs/attributes/loop.json without touching the log
   *  was invisible — this instance's next flush overwrote its
   *  changes with stale in-memory state. The store files are the
   *  same size+mtime fingerprint as the log files. */
  private lastSeenFingerprints: {
    log: Record<string, FileFingerprint>;
    stores: Record<string, FileFingerprint>;
  } | null = null;

  /** The store files whose changes refreshIfStale must notice:
   *  beliefs, fragments, attributes, graph, loop. Missing files
   *  are skipped by fingerprintLogFiles (a file appearing later
   *  still changes the fingerprint). */
  private storeFiles(): string[] {
    return [
      "beliefs.json",
      "fragments.json",
      "attributes.json",
      "graph.json",
      "loop.json",
      // 0.5.1 item 1: a second process that files / approves /
      // executes a forgetting changes these without touching the
      // log — this instance must notice.
      "forget-requests.json",
      "forgotten.json",
      // 0.5.1 items 4/5: same for experiences and goals.
      "experiences.json",
      "goals.json",
    ].map((f) => join(this.dataDir, f));
  }

  private snapshotFingerprints(): {
    log: Record<string, FileFingerprint>;
    stores: Record<string, FileFingerprint>;
  } {
    return {
      log: fingerprintLogFiles(this.logFiles()),
      stores: fingerprintLogFiles(this.storeFiles()),
    };
  }

  constructor(opts: CoreOptions) {
    this.dataDir = opts.dataDir;
    this.logMaxEntries = opts.logMaxEntries ?? 1000;
    this.snapshotKeep = opts.snapshotKeep ?? 30;
    const dataModelDir = join(
      opts.dataDir,
      "models",
      "bge-small-zh-v1.5",
    );
    const explicitModelDir = opts.semanticRecall?.modelDir;
    const bundledModelDir = findBundledModelDir();
    this.semanticConfig = {
      enabled: opts.semanticRecall?.enabled ?? false,
      modelId: opts.semanticRecall?.modelId ?? SEMANTIC_MODEL_ID,
      // 0.5.4: no manual copy. Prefer a model the user placed in the
      // data dir, otherwise use the copy shipped inside the plugin.
      modelDir:
        explicitModelDir ??
        (existsSync(join(dataModelDir, "config.json"))
          ? dataModelDir
          : (bundledModelDir ?? dataModelDir)),
      modelRevision:
        opts.semanticRecall?.modelRevision ?? SEMANTIC_MODEL_REVISION,
      runtimeDir: opts.semanticRecall?.runtimeDir ?? opts.dataDir,
      timeoutMs:
        opts.semanticRecall?.timeoutMs ?? SEMANTIC_DEFAULT_TIMEOUT_MS,
      maxCandidates:
        opts.semanticRecall?.maxCandidates ??
        SEMANTIC_DEFAULT_MAX_CANDIDATES,
      minSimilarity:
        opts.semanticRecall?.minSimilarity ??
        SEMANTIC_DEFAULT_MIN_SIMILARITY,
    };
    ensureDir(this.dataDir);
    // 0.5.1 (0.4.3 §四): clear temp leftovers older than 60 s
    // from a previous interrupted write (see atomic.ts — only
    // stale ones, never a live writer's temp file).
    cleanTempLeftovers(this.dataDir);
    this.memoryFile = new MemoryFile(this.dataDir);
    this.entries = this.loadAllLogEntries();
    this.counter = this.entries.length;
    this.currentLogCount = this.currentLogEntries().length;
    this.lastSeenFingerprints = this.snapshotFingerprints();
    for (const e of this.entries) {
      this.lastBySession.set(e.sessionId, e);
    }
    this.index = new KeywordIndex(join(this.dataDir, INDEX_FILE));
    if (!this.index.load(this.logFiles())) {
      this.index.build(this.entries);
      // Persist the rebuilt index under the write lock: two processes
      // starting at once must not both build from the same stale
      // snapshot of the log and save over each other. If the lock
      // cannot be had quickly, skip the save (never fail the load):
      // the index is rebuilt again at the next flush.
      try {
        this.withWriteLock(
          () => {
            this.refreshIfStale();
            this.index.save(this.logFiles());
            this.lastSeenFingerprints = this.snapshotFingerprints();
          },
          2000,
        );
      } catch (err) {
        console.warn(
          `[memory-plugin] 索引初次落盘被锁占用，跳过本次保存（下次 flush 时重建）：${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    // 0.2.0: graph + attributes. A first run over an old data dir
    // backfills the graph from the existing log (one-time, derived
    // data — the log stays the source of truth).
    this.graph = new MemoryGraph(this.dataDir);
    this.attrs = new AttributeStore(this.dataDir);
    this.fragments = new FragmentStore(this.dataDir);
    this.beliefs = new BeliefStore(this.dataDir);
    this.loop = new LoopStore(this.dataDir);
    this.forget = new ForgetStore(this.dataDir);
    this.experiences = new ExperienceStore(this.dataDir);
    this.goals = new GoalStore(this.dataDir);
    this.summaries = loadSummaries(this.dataDir);
    if (!this.graph.loadedExisting && this.entries.length > 0) {
      try {
        this.withWriteLock(() => {
          this.graph.backfill(this.entries, this.index, Date.now());
          this.graph.save();
        });
      } catch (err) {
        console.warn(
          `[memory-plugin] 图谱首次回填失败（下次加载时重试）：${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    // 0.5.3: a delete is a multi-file operation. If a previous run
    // wrote the journal but never reached "committed" (crash / power
    // loss / kill), roll the whole plugin state back to the safety
    // snapshot taken just before the delete.
    this.recoverForgetJournal();
    // Audit m13: a directory with no MEMORY.md and no records at all
    // is usually a misconfigured dataDir (a one-letter env-var typo)
    // — warn loudly instead of silently recording into the wrong
    // place while her real memory sits elsewhere. A genuinely new
    // test directory is legitimate, so this is a warning, not an
    // error, and it only fires on an empty directory.
    if (
      !existsSync(join(this.dataDir, "MEMORY.md")) &&
      this.entries.length === 0
    ) {
      console.warn(
        `[memory-plugin] 数据目录 ${this.dataDir} 里没有 MEMORY.md，也没有任何已有记忆记录——如果这不是故意新建的测试目录，请检查 dataDir 是否配错了路径（记录会进错文件夹，她的真记忆在别处）。`,
      );
    }
  }

  /** 0.5.3: drop compressed-summary rows for deleted entries. */
  private purgeSummaries(ids: string[]): void {
    const doomed = new Set(ids);
    if (doomed.size === 0) return;
    for (const name of readdirSync(this.dataDir)) {
      if (!/^summary-\d{4}-\d{2}\.jsonl$/.test(name)) continue;
      const file = join(this.dataDir, name);
      let raw: string;
      try {
        raw = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      const kept: string[] = [];
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try {
          const row = JSON.parse(line) as { entryId?: unknown };
          if (typeof row.entryId === "string" && doomed.has(row.entryId)) continue;
        } catch {
          // Keep torn/unknown lines; summary is derived, not source of truth.
        }
        kept.push(line);
      }
      if (kept.length !== raw.split("\n").filter((l) => l.trim()).length) {
        atomicWriteText(file, kept.join("\n") + (kept.length > 0 ? "\n" : ""));
      }
    }
  }

  /** 0.5.3: finish/rollback an interrupted forget-delete.
   *  The journal is written before the first mutation and removed
   *  after the last one. A journal still present at startup means
   *  the delete may have stopped halfway; the safety snapshot taken
   *  immediately before it is the only consistent state we can
   *  prove, so restore it and force a full store reload. */
  private recoverForgetJournal(): void {
    const file = join(this.dataDir, "forget-journal.json");
    if (!existsSync(file)) return;
    let resolved = false;
    try {
      const j = JSON.parse(readFileSync(file, "utf8")) as {
        snapshot?: unknown;
        requestId?: unknown;
        status?: unknown;
      };
      if (j.status === "committed") {
        resolved = true;
        return;
      }
      if (
        typeof j.snapshot === "string" &&
        existsSync(join(this.dataDir, ".snapshots", j.snapshot))
      ) {
        restoreSnapshot(this.dataDir, j.snapshot);
        this.lastSeenFingerprints = null;
        this.refreshIfStale();
        this.revalidateReferences();
        resolved = true;
        console.warn(
          `[memory-plugin] 检测到未完成的删除（${String(j.requestId ?? "?")}），已从删除前快照 ${j.snapshot} 回滚到一致状态。`,
        );
      } else {
        // Do NOT delete the journal here: without the snapshot we
        // cannot prove a consistent state, and the operator needs the
        // evidence to retry or repair by hand.
        console.warn(
          `[memory-plugin] 检测到未完成的删除（${String(j.requestId ?? "?")}），但找不到删除前快照，无法自动回滚；journal 保留，请检查日志/派生文件。`,
        );
      }
    } catch (err) {
      console.warn(
        `[memory-plugin] forget-journal.json 无法读取：${err instanceof Error ? err.message : String(err)}；journal 保留，请手工检查。`,
      );
    } finally {
      if (resolved) {
        try {
          rmSync(file, { force: true });
        } catch {
          // The snapshot restore is idempotent; a leftover committed
          // journal is harmless and is removed next start.
        }
      }
    }
  }

  /** 0.5.4: after a restore (or a hide/delete), drop source ids that
   *  no longer name a live persona entry. An Experience with no valid
   *  source becomes an unconfirmed candidate (never injected). */
  private revalidateReferences(): void {
    const live = new Set(
      this.entries
        .filter((e) => e.window === "persona" && !this.forget.isForgotten(e.id))
        .map((e) => e.id),
    );
    this.experiences.revalidate(live);
    this.goals.revalidate(live);
  }

  // ---- log files -------------------------------------------------

  private logFiles(): string[] {
    if (!existsSync(this.dataDir)) return [];
    return readdirSync(this.dataDir)
      .filter((f) => f === LOG_FILE || /^log-\d{4}-\d{2}\.jsonl$/.test(f))
      .map((f) => join(this.dataDir, f))
      .sort();
  }

  /** Load every log entry (current log + month segments), ascending by
   *  ts, deduped by id. Dedupe matters for crash safety: if a crash
   *  lands between writing the rollover segments and truncating the
   *  current log, an entry lives in both places; reload must count it
   *  once. */
  private loadAllLogEntries(): MemoryEntry[] {
    const out: MemoryEntry[] = [];
    const seen = new Set<string>();
    for (const file of this.logFiles()) {
      for (const e of new AppendLog(file).readAll()) {
        if (seen.has(e.id)) continue;
        seen.add(e.id);
        out.push(e);
      }
    }
    out.sort((a, b) => a.ts - b.ts);
    return out;
  }

  private currentLogEntries(): MemoryEntry[] {
    return new AppendLog(join(this.dataDir, LOG_FILE)).readAll();
  }

  // ---- write lock (0.1.6) -----------------------------------------
  //
  // Every disk write goes through withWriteLock: the on-disk lock
  // serialises writers across processes (and across instances in one
  // process). A lock timeout THROWS — the caller reports it, the write
  // is never silently dropped. Re-entrant within one instance
  // (record() -> rollover()), so nested calls do not deadlock.

  private withWriteLock<T>(
    fn: () => T,
    timeoutMs: number = DEFAULT_LOCK_TIMEOUT_MS,
  ): T {
    if (this.lockDepth > 0) return fn();
    const release = acquireWriteLock(this.dataDir, { timeoutMs });
    this.lockDepth = 1;
    this.lockRelease = release;
    try {
      return fn();
    } finally {
      this.lockDepth = 0;
      this.lockRelease = null;
      release();
    }
  }

  /** Reload log entries + rebuild the in-memory index when another
   *  writer changed the log files OR any store file since this
   *  instance last looked. Must be called holding the write lock.
   *  Returns true when a reload happened. Without this, a flush
   *  after another process's records would save an index built
   *  from stale in-memory entries but fingerprinted against the
   *  NEW log files — a fresh core would then accept the index as
   *  current and never find the other process's entries. */
  private refreshIfStale(): boolean {
    const fp = this.snapshotFingerprints();
    if (
      this.lastSeenFingerprints &&
      fingerprintsEqual(this.lastSeenFingerprints.log, fp.log) &&
      fingerprintsEqual(this.lastSeenFingerprints.stores, fp.stores)
    ) {
      return false;
    }
    this.entries = this.loadAllLogEntries();
    this.counter = this.entries.length;
    this.currentLogCount = this.currentLogEntries().length;
    this.index.build(this.entries);
    this.lastSeenFingerprints = fp;
    // 0.2.0: another writer may have moved the graph, the
    // attributes or the summaries too — reload them together, or
    // this instance's next save would overwrite their changes.
    // 0.3.0: same for fragments.json. 0.4.0 item 2: same for
    // beliefs.json.
    this.graph.reload();
    this.attrs.reload();
    this.fragments.reload();
    this.beliefs.reload();
    this.loop.reload();
    this.forget.reload();
    this.experiences.reload();
    this.goals.reload();
    this.summaries = loadSummaries(this.dataDir);
    this.lastBySession.clear();
    for (const e of this.entries) {
      this.lastBySession.set(e.sessionId, e);
    }
    return true;
  }

  // ---- record ----------------------------------------------------

  record(input: RecordInput): MemoryEntry {
    // Validate BEFORE anything is written (audit B2): a bad record
    // used to be appended to disk and only then throw inside the
    // index build — the poisoned line then crashed every later load
    // (constructor / recall) until someone hand-deleted it. A
    // validation failure now throws with nothing written.
    if (
      !input ||
      typeof input.text !== "string" ||
      input.text.trim().length === 0
    ) {
      throw new TypeError("record() needs a non-empty string text");
    }
    if (input.role !== "user" && input.role !== "assistant") {
      throw new TypeError('record() needs role "user" or "assistant"');
    }
    // 0.5.1 item 1: factKey is an explicit identity, never
    // auto-derived — validate the shape here; the supersedes
    // target must exist and share the factKey (checked under the
    // lock below, where the entry list is current).
    if (input.factKey !== undefined) {
      if (
        typeof input.factKey !== "string" ||
        input.factKey.trim().length === 0 ||
        input.factKey.length > 80
      ) {
        throw new TypeError(
          "record() factKey must be a non-empty string of at most 80 chars",
        );
      }
    }
    if (input.supersedes !== undefined && typeof input.supersedes !== "string") {
      throw new TypeError("record() supersedes must be an entry id string");
    }
    // The write itself (append + in-memory insert + index add +
    // possible rollover) holds the write lock: two processes must
    // never interleave appends or save over each other's index. A
    // lock timeout throws — the caller (DSH shell) catches it and
    // warns, the record is reported lost, never silently dropped.
    return this.withWriteLock(() => {
      // Another writer may have appended since this instance last
      // looked: reload first, or this instance's in-memory entries
      // (and the index built from them) silently fall behind the
      // disk — and a later flush would save that stale index stamped
      // with fresh fingerprints. The refresh is a no-op (a few
      // stat calls) when nothing moved, so the single-writer path
      // stays cheap.
      this.refreshIfStale();
      const ts = input.ts ?? Date.now();
      // 0.5.1 item 1: a supersedes link must point at a real entry
      // with the same factKey — a dangling or cross-fact link would
      // silently corrupt the version chain.
      if (input.supersedes !== undefined) {
        const target = this.entries.find((e) => e.id === input.supersedes);
        if (!target) {
          throw new Error(
            `record() supersedes ${input.supersedes}: no such entry`,
          );
        }
        if (input.factKey === undefined || target.factKey !== input.factKey) {
          throw new Error(
            "record() supersedes target must share the new entry's factKey",
          );
        }
      }
      const entry: MemoryEntry = {
        id: `${ts}-${this.counter++}-${randomBytes(3).toString("hex")}`,
        ts,
        date: formatDate(ts),
        time: formatTime(ts),
        role: input.role,
        window: input.window ?? "persona",
        sessionId: input.sessionId ?? "",
        importance: input.importance ?? "light",
        text: input.text,
        source: "log",
        ...(input.factKey !== undefined ? { factKey: input.factKey } : {}),
        ...(input.supersedes !== undefined
          ? { supersedes: input.supersedes }
          : {}),
      };
      new AppendLog(join(this.dataDir, LOG_FILE)).append(entry);
      // Insert in ts order (binary search) instead of re-sorting the
      // whole list on every record.
      let lo = 0;
      let hi = this.entries.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (this.entries[mid].ts <= entry.ts) lo = mid + 1;
        else hi = mid;
      }
      this.entries.splice(lo, 0, entry);
      this.currentLogCount += 1;
      this.index.add(entry);
      // 0.2.0: link the graph (session + keyword edges), ensure the
      // attributes row, and consume any pending recall links (the
      // conversation moved here because those entries were recalled).
      const prevInSession = this.lastBySession.get(entry.sessionId) ?? null;
      this.graph.linkNewEntry(entry, this.index, prevInSession, ts);
      this.lastBySession.set(entry.sessionId, entry);
      this.attrs.ensure(entry, input.emotion, ts);
      const pending = this.pendingRecallLinks.get(entry.sessionId);
      if (pending && pending.length > 0) {
        for (const id of pending.slice(0, 3)) {
          this.graph.link(id, entry.id, "recall", ts);
        }
        this.pendingRecallLinks.delete(entry.sessionId);
      }
      this.graph.save();
      this.attrs.save();
      if (this.currentLogCount > this.logMaxEntries) {
        this.rollover();
      }
      // The append (and any rollover it triggered) kept in-memory
      // and disk in sync — the refresh above established it, the
      // writes preserved it — so the fingerprints are current again.
      this.lastSeenFingerprints = this.snapshotFingerprints();
      return entry;
    });
  }

  // ---- recall ----------------------------------------------------
  //
  // Injectable text = raw-log hits + monthly-archive detail hits ONLY.
  // Layer 1 is returned separately for reference (the shell needs the
  // stage) but is NOT injected — the skill already reads it at open.

  recall(
    query: string,
    opts: {
      window?: "persona" | "task" | "all";
      tokenCap?: number;
      limit?: number;
      /** 0.2.0: per-session recall-link tracking + attention factor. */
      sessionId?: string;
      recentTexts?: string[];
      /** 0.5.0 step 5: the query-rewritten form (model rewrite /
       *  expansion, dsh-plugin side). Its tokens union with the
       *  original query's for the index lookup, the archive search
       *  and the match — the original recall is never lost to a
       *  bad rewrite. Absent = keyword-only, exactly as before. */
      rewrittenQuery?: string;
      /** 0.5.0 step 5: optional semantic provider slot (interface
       *  only; no embedding ships). */
      semantic?: SemanticRetriever;
    } = {},
  ): RecallResult {
    // A non-string query (a bad tool call) returns empty, never
    // throws (audit m11). The profile block is query-independent,
    // so it still comes along from the current layer 1.
    if (typeof query !== "string") {
      const layer1 = this.readLayer1();
      return {
        hits: [],
        layer1,
        profileText: formatProfileBlock(layer1),
        estimatedTokens: 0,
        text: "",
      };
    }
    // 0.5.0 step 5: the match tokens are the union of the original
    // query and the rewritten query (matchTokensFor applies the
    // single-char noise filter to the union) — the index lookup and
    // the archive search use the same set recallFromEntries matches
    // with, so a rewrite can surface entries the original words
    // never would.
    const tokens = matchTokensFor(query, opts.rewrittenQuery);
    const archiveHits =
      tokens.length > 0 ? this.memoryFile.searchArchives(tokens) : [];
    // Load layer 1 + layer 2 together: recall needs layer 1 for
    // reference (stage) and layer 2 for the 0.1.6 dedupe (a log hit
    // saying what the skill already read at open is dropped).
    const parsed = this.memoryFile.load();
    const layer1 = mergeProfile(parsed.layer1, loadProfile(this.dataDir));
    // Keyword-index lookup (audit m1): the persisted index is the
    // candidate source for the log scan, not a dead file — recall
    // unions the index's per-token id lists and lets
    // recallFromEntries match only within them. Archive hits are
    // exempt from the candidate filter (they are not in the index).
    let candidateIds: Set<string> | undefined;
    if (tokens.length > 0) {
      candidateIds = new Set<string>();
      for (const [, ids] of this.index.lookup(tokens)) {
        for (const id of ids) candidateIds.add(id);
      }
    }
    // Identical texts (raw-log fragment vs its archive copy) dedupe
    // inside recallFromEntries, BEFORE the token cap, so a duplicate
    // never eats a cap slot. The 0.1.6 dedupe there also drops log
    // hits that repeat what the skill already read at open (layer 1
    // + layer 2, passed below) — the curated copy wins.
    // 0.2.0: recall-from-entries also receives the graph, the
    // attributes and the compressed summaries, plus the session
    // context for the attention factor and recall-link tracking.
    // 0.3.0: plus the fragments — a hit covered by a verified
    // fragment injects the fragment text instead of the full
    // original (recallFromEntries re-checks it first).
    // 0.4.0 item 2: plus the beliefs — the recall block gains one
    // compact belief line at the end (no token-cap budget, no line
    // when there are no beliefs).
    const result = recallFromEntries(
      // 0.5.1 item 1: hidden (tombstoned) entries never enter
      // recall — the log text stays on disk, but no query, search
      // or review ever surfaces them again. Archive hits are
      // exempt: forgetting covers the live log, not the skill's
      // monthly archives (an admin delete of an archive row is a
      // separate, manual step).
      [...this.entries.filter((e) => !this.forget.isForgotten(e.id)), ...archiveHits.filter((e) => !this.forget.isForgotten(e.id))],
      layer1,
      query,
      {
        ...opts,
        candidateIds,
        layer2: parsed.layer2,
        graph: this.graph,
        attributes: this.attrs,
        summaries: this.summaries,
        fragments: this.fragments,
        beliefs: this.beliefs,
        experiences: this.experiences,
      },
    );
    // 0.2.0: the next record in this session links back to the
    // entries that were surfaced (the conversation moved there
    // because they were recalled), and surfaced entries are bumped
    // in memory (recallCount++, clarity +0.15) — persisted at
    // flush().
    if (opts.sessionId) {
      const surfaced = result.hits
        .filter((h) => h.entry.source !== "archive")
        .slice(0, 3)
        .map((h) => h.entry.id);
      if (surfaced.length > 0) {
        // Append-merge, never overwrite: two recalls in one session
        // with no record between them must both leave their links
        // for the next record — a plain set() drops the first batch
        // and the recall edges for it are never built.
        const prev = this.pendingRecallLinks.get(opts.sessionId) ?? [];
        const merged = [...prev];
        for (const id of surfaced) {
          if (!merged.includes(id)) merged.push(id);
        }
        this.pendingRecallLinks.set(opts.sessionId, merged);
      }
    }
    const now = Date.now();
    for (const hit of result.hits) {
      if (hit.entry.source === "archive") continue;
      this.attrs.bumpOnRecall(hit.entry.id, now);
    }
    return result;
  }

  // ---- mid-turn trigger (0.3.0) ------------------------------------
  //
  // Condition (b) of the restrained mid-conversation recall trigger:
  // true when the query's keywords match at least one persona-window
  // entry whose significance is >= threshold (default 0.8). Uses the
  // keyword index (candidate ids) + the attribute store; ensure() is
  // in-memory only until flush, so this writes nothing to disk, and
  // it reuses initialSignificance / the stored row — the significance
  // logic itself is untouched. Archive entries are not in the index
  // and are not checked (the trigger is about the live log); task
  // entries never count (their window is not persona).
  hasHighSignificanceMatch(query: string, threshold = 0.8): boolean {
    if (typeof query !== "string") return false;
    const tokens = tokenize(query);
    if (tokens.length === 0) return false;
    const candidateIds = new Set<string>();
    for (const [, ids] of this.index.lookup(tokens)) {
      for (const id of ids) candidateIds.add(id);
    }
    if (candidateIds.size === 0) return false;
    const now = Date.now();
    const byId = new Map(this.entries.map((e) => [e.id, e]));
    for (const id of candidateIds) {
      const entry = byId.get(id);
      if (!entry || entry.window !== "persona") continue;
      if (this.attrs.ensure(entry, undefined, now).significance >= threshold) {
        return true;
      }
    }
    return false;
  }

  // ---- forgetting (0.5.1 item 1) ----------------------------------
  //
  // Request -> approve -> execute. The model-facing tool only ever
  // calls requestForget / dryRunForget / listForgetRequests: the
  // approve and execute calls live on the admin CLI and the local
  // admin API, and approve() itself refuses any channel that is
  // not "cli" or "admin" — a chat "我同意" can never authorise a
  // forgetting, because there is no path from a chat line to an
  // approval record.

  /** 0.5.2: rebuild the in-memory session chain after hide/delete.
   *  A tombstoned/deleted entry must not remain the "previous turn"
   *  for the next record (it would create a dangling graph edge). */
  private rebuildSessionLinks(): void {
    this.lastBySession.clear();
    for (const e of this.entries) {
      if (e.window === "persona" && !this.forget.isForgotten(e.id)) {
        this.lastBySession.set(e.sessionId, e);
      }
    }
    for (const [sid, ids] of [...this.pendingRecallLinks]) {
      const kept = ids.filter((id) => !this.forget.isForgotten(id));
      if (kept.length > 0) this.pendingRecallLinks.set(sid, kept);
      else this.pendingRecallLinks.delete(sid);
    }
  }

  /** File a forget request. Changes nothing. */
  requestForget(input: {
    mode: ForgetMode;
    entryIds: string[];
    reason?: string;
    createdBy: "model" | "cli" | "admin";
  }): ForgetRequest {
    return this.withWriteLock(() => {
      this.refreshIfStale();
      return this.forget.request(input);
    });
  }

  listForgetRequests(): ForgetRequest[] {
    this.forget.refreshExpiry();
    return this.forget.all();
  }

  /** Dry-run preview: what a forget of these ids would touch.
   *  Changes nothing. */
  dryRunForget(ids: string[]): ForgetPreview {
    const byId = new Map(this.entries.map((e) => [e.id, e]));
    const preview = buildForgetPreview(ids, {
      entriesById: (id) => byId.get(id),
      fragmentsFor: (list) => this.fragments.idsLosingAllSources(list),
      beliefsFor: (list) => this.beliefs.idsLosingAllEvidence(list),
      graphEdgeCount: (list) => this.graph.edgeCountFor(list),
      semanticVectorCount: (list) => this.semanticVectorCount(list),
    });
    // 0.5.3: disclose skill-owned copies; do not pretend the plugin
    // can erase files it does not own.
    preview.skillCopies = this.skillCopiesFor(ids);
    return preview;
  }

  /** Files under MEMORY.md / MEMORY-YYYY-MM.md that contain an exact
   *  copy of one of these entries. Read-only. */
  private skillCopiesFor(ids: string[]): string[] {
    const texts = ids
      .map((id) => this.entries.find((e) => e.id === id)?.text)
      .filter((t): t is string => typeof t === "string" && t.length > 0);
    if (texts.length === 0) return [];
    return readdirSync(this.dataDir)
      .filter((f) => f === "MEMORY.md" || /^MEMORY-\d{4}-\d{2}\.md$/.test(f))
      .filter((f) => {
        try {
          const text = readFileSync(join(this.dataDir, f), "utf8");
          return texts.some((t) => text.includes(t));
        } catch {
          return false;
        }
      });
  }

  /** Opt-in purge of skill-owned copies (exact text lines only).
   *  Backs up the file before rewriting it. Never called by default. */
  private purgeSkillCopies(texts: string[]): void {
    if (texts.length === 0) return;
    for (const f of readdirSync(this.dataDir)) {
      if (f !== "MEMORY.md" && !/^MEMORY-\d{4}-\d{2}\.md$/.test(f)) continue;
      const file = join(this.dataDir, f);
      let before: string;
      try {
        before = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      const kept = before
        .split("\n")
        .filter((line) => !texts.some((t) => line.includes(t)))
        .join("\n");
      if (kept === before) continue;
      copyFileSync(file, `${file}.bak-purge-${Date.now()}`);
      atomicWriteText(file, kept);
    }
  }

  /** Approve a pending request (CLI / local admin API only). */
  approveForget(
    id: string,
    input: { channel: "cli" | "admin"; by: string },
  ): ForgetRequest {
    return this.withWriteLock(() => {
      this.refreshIfStale();
      return this.forget.approve(id, input);
    });
  }

  /** Execute an approved request. Hide tombstones the ids;
   *  delete physically removes them (snapshot first). Refuses
   *  unless the request is approved, unexpired, and approved on
   *  a non-model channel. */
  executeForget(
    id: string,
    input: { by: string; purgeSkillFiles?: boolean },
  ): { request: ForgetRequest; removed: string[]; hidden: string[] } {
    const req = this.forget.get(id);
    if (!req) throw new Error(`no forget request ${id}`);
    if (req.status !== "approved") {
      throw new Error(
        `forget request ${id} is ${req.status} — only an approved request can execute (approve it from the admin CLI first)`,
      );
    }
    if (
      req.approvedChannel !== "cli" &&
      req.approvedChannel !== "admin"
    ) {
      throw new Error(
        `forget request ${id} has no non-model approval — a chat agreement can never authorise forgetting`,
      );
    }
    if (this.forget.isExpired(req)) {
      throw new Error(`forget request ${id} has expired (7-day TTL)`);
    }
    // The audit must be writable BEFORE anything is mutated: a
    // forgetting with no audit trail is worse than no forgetting.
    // (The per-step audit lines inside markExecuted are
    // best-effort; this checked write is the gate.)
    try {
      appendFileSync(
        join(this.dataDir, "forget-audit.jsonl"),
        JSON.stringify({
          ts: Date.now(),
          event: "forget.executing",
          requestId: id,
          mode: req.mode,
          entryIds: req.entryIds,
          by: input.by,
        }) + "\n",
        { encoding: "utf8", mode: 0o600 },
      );
    } catch (err) {
      throw new Error(
        `forget audit is not writable, refusing to execute: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const byId = new Map(this.entries.map((e) => [e.id, e]));
    const existing = req.entryIds.filter((eid) => byId.has(eid));
    if (req.mode === "hide") {
      return this.withWriteLock(() => {
        this.refreshIfStale();
        this.forget.tombstone(existing, "hide", id);
        this.rebuildSessionLinks();
        this.revalidateReferences();
        const done = this.forget.markExecuted(id, input.by);
        this.lastSeenFingerprints = this.snapshotFingerprints();
        return { request: done, removed: [], hidden: existing };
      });
    }
    // delete: snapshot first (recoverable), then rewrite the log
    // without the ids and strip every derived store.
    const snapshotName = this.snapshot();
    // 0.5.3: write the delete journal before the first mutation. If
    // the process dies anywhere below, the next Core constructor
    // sees this file and restores snapshotName.
    const journalFile = join(this.dataDir, "forget-journal.json");
    atomicWriteText(
      journalFile,
      JSON.stringify(
        {
          requestId: id,
          snapshot: snapshotName,
          ids: existing,
          status: "committing",
        },
        null,
        2,
      ),
    );
    const removed = this.withWriteLock(() => {
      this.refreshIfStale();
      const doomed = new Set(existing);
      for (const file of this.logFiles()) {
        const kept = new AppendLog(file)
          .readAll()
          .filter((e) => !doomed.has(e.id));
        new AppendLog(file).rewrite(kept);
      }
      this.entries = this.entries.filter((e) => !doomed.has(e.id));
      this.counter = this.entries.length;
      this.currentLogCount = this.currentLogEntries().length;
      this.index.build(this.entries);
      this.index.save(this.logFiles());
      this.graph.removeEntries(existing);
      this.graph.save();
      this.attrs.removeEntries(existing);
      this.attrs.save();
      this.fragments.removeEntries(existing);
      this.fragments.save();
      this.beliefs.removeEntries(existing);
      this.beliefs.save();
      // 0.5.3 (P1-13): compressed summary rows are keyed by entryId;
      // a deleted entry must not survive in summary-YYYY-MM.jsonl.
      this.purgeSummaries(existing);
      this.semanticRemoveIds(existing);
      // A deleted entry is gone, not hidden — drop its tombstone
      // if an earlier hide put one there.
      this.forget.untombstone(existing);
      this.rebuildSessionLinks();
      this.revalidateReferences();
      this.lastSeenFingerprints = this.snapshotFingerprints();
      return existing;
    });
    const done = this.forget.markExecuted(id, input.by);
    this.forget.auditRaw("forget.deleted.snapshot", {
      requestId: id,
      snapshot: snapshotName,
      entryIds: removed,
    });
    // 0.5.3 (opt-in): the plugin cannot own MEMORY.md, so erasing
    // skill copies is explicit. Each touched file is backed up first.
    if (input.purgeSkillFiles) {
      const texts = existing
        .map((eid) => byId.get(eid)?.text)
        .filter((t): t is string => typeof t === "string" && t.length > 0);
      this.purgeSkillCopies(texts);
    }
    // The operation is committed: mark the journal so a restart
    // never rolls a successful delete back, then remove it.
    try {
      atomicWriteText(
        journalFile,
        JSON.stringify(
          { requestId: id, snapshot: snapshotName, ids: removed, status: "committed" },
          null,
          2,
        ),
      );
      rmSync(journalFile, { force: true });
    } catch {
      // A committed journal is a no-op for recovery; leaving it is
      // safe (it is removed on the next successful startup).
    }
    return { request: done, removed, hidden: [] };
  }

  /** Reverse a hide (admin/CLI only). Deleted entries cannot be
   *  unhidden — restore the pre-delete snapshot instead. */
  unforget(ids: string[]): string[] {
    return this.forget.untombstone(ids);
  }

  // ---- admin edit (0.5.1 item 3) -----------------------------------
  //
  // Direct mutation of a log entry — admin channel only (CLI /
  // local API), never a model tool. The words change; the learned
  // significance does NOT (the review re-promotes if the new
  // importance deserves it). The graph is re-linked for the entry
  // (its keyword edges follow the new text) and the audit records
  // the before/after. The semantic vector is refreshed by
  // semanticUpsertEntry (async, called by the admin layer).

  editEntry(
    id: string,
    patch: { text?: string; importance?: Importance },
    by = "cli",
  ): MemoryEntry {
    if (patch.text !== undefined && patch.text.trim().length === 0) {
      throw new TypeError("editEntry text must be a non-empty string");
    }
    if (
      patch.importance !== undefined &&
      patch.importance !== "heavy" &&
      patch.importance !== "light"
    ) {
      throw new TypeError('editEntry importance must be "heavy" or "light"');
    }
    return this.withWriteLock(() => {
      this.refreshIfStale();
      const entry = this.entries.find((e) => e.id === id);
      if (!entry) throw new Error(`no entry ${id}`);
      const before = { text: entry.text, importance: entry.importance };
      if (patch.text !== undefined) entry.text = patch.text;
      if (patch.importance !== undefined) entry.importance = patch.importance;
      for (const file of this.logFiles()) {
        const rows = new AppendLog(file).readAll();
        if (!rows.some((e) => e.id === id)) continue;
        new AppendLog(file).rewrite(
          rows.map((e) => (e.id === id ? entry : e)),
        );
      }
      this.index.build(this.entries);
      this.index.save(this.logFiles());
      this.graph.removeEntries([id]);
      const prev = this.lastBySession.get(entry.sessionId) ?? null;
      this.graph.linkNewEntry(entry, this.index, prev, Date.now());
      this.graph.save();
      this.lastSeenFingerprints = this.snapshotFingerprints();
      try {
        appendFileSync(
          join(this.dataDir, "admin-audit.jsonl"),
          JSON.stringify({
            ts: Date.now(),
            event: "admin.edit",
            id,
            by,
            before,
            after: { text: entry.text, importance: entry.importance },
          }) + "\n",
          { encoding: "utf8", mode: 0o600 },
        );
      } catch {
        // Audit is best-effort here — the edit itself already
        // landed; a failed audit line is warned, not fatal.
        console.warn(`[memory-plugin] admin audit 写失败（本次编辑未记审计）。`);
      }
      return { ...entry };
    });
  }

  /** Re-embed one entry into the semantic index (async, admin /
   *  plugin layer only). Returns false when semantic is disabled
   *  or unavailable — the index is rebuilt later, never blocking
   *  the edit. */
  async semanticUpsertEntry(entry: MemoryEntry): Promise<boolean> {
    if (!this.semanticEnabled()) return false;
    try {
      await this.ensureSemanticIndex();
      if (!this.semanticProvider || !this.semanticIndex) return false;
      const [v] = await this.semanticProvider.embed([entry.text]);
      this.semanticIndex.upsert(entry.id, v);
      this.semanticIndex.save();
      return true;
    } catch {
      return false;
    }
  }

  // ---- local embedding (0.5.1 item 2) ------------------------------
  //
  // Disabled by default: nothing below runs unless
  // semanticRecall.enabled is true. The provider is loaded lazily
  // (first ensureSemanticIndex), the index is derived from the log
  // and rebuilt whenever its identity stops matching.

  semanticEnabled(): boolean {
    return this.semanticConfig.enabled === true;
  }

  semanticModelDir(): string {
    return this.semanticConfig.modelDir;
  }

  semanticStatus(): {
    enabled: boolean;
    modelId: string;
    modelRevision: string;
    dimensions: number;
    modelPresent: boolean;
    indexStatus: SemanticIndexLoadStatus | null;
    indexSize: number;
  } {
    return {
      enabled: this.semanticEnabled(),
      modelId: this.semanticConfig.modelId,
      modelRevision: this.semanticConfig.modelRevision,
      dimensions: SEMANTIC_DIMENSIONS,
      modelPresent: existsSync(join(this.semanticConfig.modelDir, "config.json")),
      indexStatus: this.semanticIndexStatus,
      indexSize: this.semanticIndex?.size ?? 0,
    };
  }

  /** Load the provider + index, rebuilding the index from the log
   *  when it is missing, discarded, or `rebuild` is set. Throws
   *  when the model cannot load — the caller (plugin apply, admin
   *  CLI) reports it and stays keyword-only; recall never calls
   *  this. */
  async ensureSemanticIndex(opts: { rebuild?: boolean } = {}): Promise<{
    status: SemanticIndexLoadStatus;
    built: number;
  }> {
    if (!this.semanticProvider) {
      this.semanticProvider = new TransformersEmbeddingProvider({
        modelDir: this.semanticConfig.modelDir,
        modelId: this.semanticConfig.modelId,
        modelRevision: this.semanticConfig.modelRevision,
        runtimeDir: this.semanticConfig.runtimeDir,
      });
    }
    if (!this.semanticIndex) {
      this.semanticIndex = new SemanticIndex({
        dataDir: this.dataDir,
        modelId: this.semanticConfig.modelId,
        modelRevision: this.semanticConfig.modelRevision,
        dimensions: SEMANTIC_DIMENSIONS,
        pooling: SEMANTIC_POOLING,
        queryPrefix: SEMANTIC_QUERY_PREFIX,
      });
    }
    // 0.5.2: a loaded index is cached for the process lifetime. The
    // old path re-read and JSON.parse-ed the whole vector file on
    // every recorded message (O(N) per append, O(N²) overall).
    if (!opts.rebuild && this.semanticIndexStatus === "loaded") {
      return { status: "loaded", built: 0 };
    }
    const status = this.semanticIndex.load();
    this.semanticIndexStatus = status;
    if (opts.rebuild || status === "discarded-mismatch" || status === "discarded-corrupt" || status === "empty") {
      const live = this.entries.filter((e) => !this.forget.isForgotten(e.id));
      const built = await buildSemanticIndex(
        this.semanticProvider,
        this.semanticIndex,
        live,
      );
      this.semanticIndex.save();
      this.semanticIndexStatus = "loaded";
      return { status, built };
    }
    return { status, built: 0 };
  }

  /** Semantic search with similarities (best-first). Same
   *  timeout/fallback rules as semanticCandidateIds, but returns
   *  the raw hits — used by the benchmark (to report the score
   *  spread) and the admin centre (semantic status/debug). Never
   *  throws; [] when disabled, unbuilt, timed out or failed. */
  async semanticSearch(
    query: string,
    candidates: MemoryEntry[],
    limit?: number,
  ): Promise<Array<{ id: string; similarity: number }>> {
    if (!this.semanticEnabled() || !this.semanticProvider || !this.semanticIndex) {
      return [];
    }
    const searcher = new SemanticSearcher(
      this.semanticProvider,
      this.semanticIndex,
    );
    try {
      const run = searcher.search(
        query,
        candidates,
        limit ?? this.semanticConfig.maxCandidates,
      );
      const hits = await Promise.race([
        run,
        new Promise<null>((resolve) =>
          setTimeout(() => resolve(null), this.semanticConfig.timeoutMs),
        ),
      ]);
      if (hits === null) return [];
      return hits.map((h) => ({ id: h.entry.id, similarity: h.similarity }));
    } catch {
      return [];
    }
  }

  /** Semantic candidate ids for a query (best-first). Returns []
   *  when semantic is disabled, the index was never ensured, the
   *  model is missing, the search times out, or inference throws
   *  — keyword-only fallback, never an exception. Only hits at or
   *  above the configured similarity floor come back (see
   *  SEMANTIC_DEFAULT_MIN_SIMILARITY). */
  async semanticCandidateIds(
    query: string,
    candidates: MemoryEntry[],
  ): Promise<string[]> {
    const hits = await this.semanticSearch(query, candidates);
    return hits
      .filter((h) => h.similarity >= this.semanticConfig.minSimilarity)
      .map((h) => h.id);
  }

  /** Configured similarity floor for semantic candidates. */
  semanticMinSimilarity(): number {
    return this.semanticConfig.minSimilarity;
  }

  /** How many of `ids` hold a vector in the index (dry-run
   *  preview for a forget; 0 when the index was never built). */
  semanticVectorCount(ids: string[]): number {
    if (!this.semanticIndex) return 0;
    let n = 0;
    for (const id of ids) {
      if (this.semanticIndex.has(id)) n += 1;
    }
    return n;
  }

  /** Drop vectors for `ids` and persist (forget-delete path;
   *  the caller holds the write lock). */
  semanticRemoveIds(ids: string[]): number {
    // 0.5.2: deletion must reach the disk index even when the lazy
    // index object has not been loaded yet. Load it from disk (no
    // model needed for a removal), delete, and save.
    if (!this.semanticIndex) {
      const idx = new SemanticIndex({
        dataDir: this.dataDir,
        modelId: this.semanticConfig.modelId,
        modelRevision: this.semanticConfig.modelRevision,
        dimensions: SEMANTIC_DIMENSIONS,
        pooling: SEMANTIC_POOLING,
        queryPrefix: SEMANTIC_QUERY_PREFIX,
      });
      if (idx.load() !== "loaded") return 0;
      this.semanticIndex = idx;
      this.semanticIndexStatus = "loaded";
    }
    const n = this.semanticIndex.removeIds(ids);
    if (n > 0) this.semanticIndex.save();
    return n;
  }

  // ---- daily model review (0.3.0, new layer 2) --------------------
  //
  // yesterdayEntries(): every persona-window log entry from
  // yesterday (host-local date). The model review reads ALL of
  // them — no token limit on reading. Task-window entries are not
  // her memories and are left out.
  yesterdayEntries(now = Date.now()): MemoryEntry[] {
    // 0.5.1 (0.4.3 §四): calendar yesterday, not now minus 24 h —
    // the old subtraction crossed the wrong date on the day after
    // a daylight-saving change (a 25-hour day puts now-24h on the
    // day before yesterday) and on any late-night run it was
    // only right by luck. setDate handles month/year boundaries.
    const d = new Date(now);
    d.setDate(d.getDate() - 1);
    const yesterday = formatDate(d.getTime());
    return this.entries.filter(
      (e) =>
        e.window === "persona" &&
        e.date === yesterday &&
        !this.forget.isForgotten(e.id),
    );
  }

  /** Significance of one entry (0.4.5: the daily-review prompt
   *  cap ranks yesterday's entries by it). Read-only — a missing
   *  row falls back to the entry's initial significance, never
   *  creates a row. */
  significanceOf(entry: MemoryEntry): number {
    return (
      this.attrs.get(entry.id)?.significance ?? initialSignificance(entry)
    );
  }

  /** Entries by id (for the shell: resolve the review's
   *  invalidation-check ids to their text for the daily-review
   *  prompt — the model needs the words, not just ids). Unknown
   *  ids are skipped, never created. Read-only, but it takes the
   *  write lock briefly (0.5.1 §四): refreshIfStale must run
   *  under the lock — the old code called it outside the lock,
   *  contradicting the "must be called holding the write lock"
   *  contract. The lock is uncontended in the normal case (one
   *  mkdir), and the method is re-entrant, so a caller already
   *  holding it pays nothing. */
  entriesByIds(ids: string[]): MemoryEntry[] {
    return this.withWriteLock(() => {
      this.refreshIfStale();
      const byId = new Map(this.entries.map((e) => [e.id, e]));
      const out: MemoryEntry[] = [];
      for (const id of ids) {
        // 0.5.1 item 1: a hidden entry never resolves here either
        // — the daily-review prompt must not be handed text the
        // user asked to forget.
        if (this.forget.isForgotten(id)) continue;
        const entry = byId.get(id);
        if (entry) out.push(entry);
      }
      return out;
    });
  }

  /** Apply the model review's picks: every id that names a real log
   *  entry is raised to significance 0.9 and flagged modelMarked
   *  (the code review never compresses it). Only upgrades, never
   *  downgrades: an entry already at 0.9 stays 0.9. Unknown ids are
   *  reported, never applied, never an error. Runs under the write
   *  lock and persists attributes.json. */
  applyModelMarks(
    ids: string[],
    now = Date.now(),
  ): { applied: string[]; unknown: string[] } {
    return this.withWriteLock(() => {
      this.refreshIfStale();
      const byId = new Map(this.entries.map((e) => [e.id, e]));
      const applied: string[] = [];
      const unknown: string[] = [];
      for (const id of ids) {
        const entry = byId.get(id);
        if (!entry) {
          unknown.push(id);
          continue;
        }
        const attrs = this.attrs.ensure(entry, undefined, now);
        if (attrs.significance < 0.9) attrs.significance = 0.9;
        attrs.modelMarked = true;
        applied.push(id);
      }
      this.attrs.save();
      return { applied, unknown };
    });
  }

  // ---- invalidation (0.4.0 item 1, Graphiti 双时间戳失效) --------
  //
  // Mark entries invalid from `at` (default now): only validTo is
  // written, in attributes.json (via AttributeStore.invalidate) and
  // on every graph edge touching an invalidated entry (via
  // MemoryGraph.invalidate — a dead memory's links must not diffuse
  // it into recall). The log text is never touched: an invalidated
  // memory stays readable in history, it just stops recalling.
  // Unknown ids are reported, never created. Runs under the write
  // lock and persists both files.
  invalidateEntries(
    ids: string[],
    at: number = Date.now(),
  ): { invalidated: string[]; unknown: string[] } {
    return this.withWriteLock(() => {
      this.refreshIfStale();
      const byId = new Map(this.entries.map((e) => [e.id, e]));
      const invalidated: string[] = [];
      const unknown: string[] = [];
      for (const id of ids) {
        const entry = byId.get(id);
        if (!entry) {
          unknown.push(id);
          continue;
        }
        // Ensure a row exists first: invalidate() only stamps rows
        // it finds, and a log entry with no row yet (never recalled,
        // never reviewed) still deserves a validTo.
        this.attrs.ensure(entry, undefined, at);
        invalidated.push(id);
      }
      const res = this.attrs.invalidate(invalidated, at);
      this.attrs.save();
      if (this.graph.invalidate(res.invalidated, at) > 0) {
        this.graph.save();
      }
      return { invalidated: res.invalidated, unknown };
    });
  }

  // ---- feedback (0.5.0 step 4, memory_feedback) ----------------
  //
  // The user (through the model) says a recalled memory was right,
  // wrong or irrelevant — and the memory actually changes, not
  // just its score:
  // - correct: a verification — feedbackCorrect + 1; a named
  //   fragment's provenance verifyCount + 1 (its confidence is
  //   recomputed by code).
  // - wrong: the entry is invalidated (validTo = now, same path as
  //   memory_invalidate — recall skips it from now on, the log
  //   text stays); a named fragment is marked suspect.
  // - irrelevant: feedbackIrrelevant + 1 and the significance
  //   halves (floored at 0.1) — recall ranking halves per
  //   irrelevant count (see recallFromEntries), so the same
  //   question re-asked surfaces it lower or not at all.
  // An unknown entry id (or fragment id) is reported, never
  // created. Runs under the write lock and persists.
  applyFeedback(input: {
    entryId: string;
    kind: FeedbackKind;
    fragmentId?: string;
    reason?: string;
    now?: number;
  }): FeedbackResult {
    const now = input.now ?? Date.now();
    return this.withWriteLock(() => {
      this.refreshIfStale();
      const entry = this.entries.find((e) => e.id === input.entryId);
      if (!entry) {
        return {
          ok: false,
          entryId: input.entryId,
          kind: input.kind,
          invalidated: [],
          fragmentId: input.fragmentId,
          feedback: { correct: 0, wrong: 0, irrelevant: 0 },
          reason: "记忆条目不存在。",
        };
      }
      const attrs = this.attrs.ensure(entry, undefined, now);
      let fragmentTouched = false;
      let invalidated: string[] = [];
      if (input.kind === "correct") {
        attrs.feedbackCorrect = (attrs.feedbackCorrect ?? 0) + 1;
        attrs.lastFeedbackAt = now;
        if (input.fragmentId && this.fragments.get(input.fragmentId)) {
          this.fragments.markVerified(input.fragmentId, now);
          fragmentTouched = true;
        }
      } else if (input.kind === "wrong") {
        attrs.feedbackWrong = (attrs.feedbackWrong ?? 0) + 1;
        attrs.lastFeedbackAt = now;
        // Same path as memory_invalidate (re-entrant under the
        // lock): validTo is stamped, graph edges die, both files
        // persist. The log text is never touched.
        invalidated = this.invalidateEntries([input.entryId], now).invalidated;
        if (input.fragmentId && this.fragments.get(input.fragmentId)) {
          this.fragments.markSuspect(
            input.fragmentId,
            input.reason ?? "用户反馈：错误",
          );
          fragmentTouched = true;
        }
      } else {
        attrs.feedbackIrrelevant = (attrs.feedbackIrrelevant ?? 0) + 1;
        attrs.lastFeedbackAt = now;
        // 0.5.0 fix: only the first two "irrelevant" feedbacks halve
        // significance; the third and later stay put. This matches
        // the recall ranking factor (Math.pow(0.5, min(n, 2))).
        if (attrs.feedbackIrrelevant <= 2) {
          attrs.significance = Math.max(0.1, attrs.significance * 0.5);
        }
      }
      this.attrs.save();
      if (fragmentTouched) this.fragments.save();
      return {
        ok: true,
        entryId: input.entryId,
        kind: input.kind,
        invalidated,
        fragmentId: input.fragmentId,
        feedback: {
          correct: attrs.feedbackCorrect ?? 0,
          wrong: attrs.feedbackWrong ?? 0,
          irrelevant: attrs.feedbackIrrelevant ?? 0,
        },
        significance: attrs.significance,
      };
    });
  }

  // ---- fragments (0.3.0) ---------------------------------------
  //
  // Create a fragment on top of the verbatim log. The model writes
  // the summary + tone + quotes; the code verifies them against the
  // source entries and REJECTS the fragment (nothing saved) when
  // the key terms / quotes / tone do not match. The log is never
  // touched by this path.

  createFragment(input: FragmentInput): FragmentCreateResult {
    return this.withWriteLock(() => {
      this.refreshIfStale();
      const entriesById = new Map(
        this.entries
          .filter((e) => !this.forget.isForgotten(e.id))
          .map((e) => [e.id, e]),
      );
      return this.fragments.create(input, entriesById);
    });
  }

  /** All stored fragments (for memory_status / review / tests). */
  listFragments(): import("./fragments.ts").Fragment[] {
    return this.fragments.all();
  }

  // ---- beliefs (0.4.0 item 2, 带证据的信念层 + 三维信念) --------
  //
  // Create / support / contradict a belief. Every write verifies
  // its quote word for word against the log (the memory_fragment
  // pattern) and REJECTS the write when the quote is not verbatim
  // — nothing is stored, and the reasons come back so the model can
  // fix it. Deltas are the model's call (how strong this evidence
  // is); the store only clamps a single move to ±0.2 and strength
  // to 0..1. A contradict for an already-charged entry is ignored
  // (duplicate), never deducted twice. All three run under the
  // write lock and persist beliefs.json.

  createBelief(input: BeliefCreateInput): BeliefCreateResult {
    return this.withWriteLock(() => {
      this.refreshIfStale();
      const entriesById = new Map(
        this.entries
          .filter((e) => !this.forget.isForgotten(e.id))
          .map((e) => [e.id, e]),
      );
      // 0.4.1 (A) core-layer persona-source check: the evidence for a
      // belief must come from a persona-window memory. The tool layer
      // being persona-gated does not stop a task entry id being passed
      // in, so the core checks the source entry itself — a missing or
      // non-persona source throws source_entry_not_found (A's error
      // name), before the store's verbatim-quote / ≥2-char rules run.
      // 0.5.2: a hidden (tombstoned) source is equally invalid — a
      // belief must not keep a forgotten memory alive.
      const source = entriesById.get(input.entryId ?? "");
      if (!source || source.window !== "persona") {
        throw new Error("source_entry_not_found");
      }
      return this.beliefs.create(input, entriesById);
    });
  }

  supportBelief(
    beliefId: string,
    entryId: string,
    quote: string,
    delta: number,
  ): BeliefAdjustResult {
    return this.withWriteLock(() => {
      this.refreshIfStale();
      const entriesById = new Map(this.entries.map((e) => [e.id, e]));
      // 0.4.1 (A): same persona-source check as createBelief — a
      // task-window entry must not move a belief, even verbatim.
      const source = this.entries.find(
        (entry) =>
          entry.id === entryId &&
          entry.window === "persona" &&
          !this.forget.isForgotten(entry.id),
      );
      if (!source) throw new Error("source_entry_not_found");
      return this.beliefs.support(beliefId, entryId, quote, delta, entriesById);
    });
  }

  contradictBelief(
    beliefId: string,
    entryId: string,
    quote: string,
    delta: number,
  ): BeliefAdjustResult {
    return this.withWriteLock(() => {
      this.refreshIfStale();
      const entriesById = new Map(this.entries.map((e) => [e.id, e]));
      // 0.4.1 (A): same persona-source check as createBelief — a
      // task-window entry must not deduct from a belief, even verbatim.
      const source = this.entries.find(
        (entry) =>
          entry.id === entryId &&
          entry.window === "persona" &&
          !this.forget.isForgotten(entry.id),
      );
      if (!source) throw new Error("source_entry_not_found");
      return this.beliefs.contradict(beliefId, entryId, quote, delta, entriesById);
    });
  }

  /** All stored beliefs (for memory_belief get / review / tests). */
  listBeliefs(): Belief[] {
    return this.beliefs.all();
  }

  // ---- goals / experiences (0.5.4) -------------------------------
  //
  // Single write path: every mutation runs under the Core write lock,
  // reloads a stale view first, and validates that sourceIds name
  // live persona entries. Tools / CLI / admin API call these methods;
  // they must not call GoalStore / ExperienceStore.save() directly.

  private assertLivePersonaSources(ids: string[] | undefined): void {
    if (!ids || ids.length === 0) return;
    const found = this.entriesByIds(ids);
    if (found.length !== ids.length) {
      throw new Error("source_entry_not_found");
    }
    if (found.some((e) => e.window !== "persona")) {
      throw new Error("source_entry_not_found");
    }
  }

  createGoal(
    input: Parameters<GoalStore["create"]>[0],
  ): ReturnType<GoalStore["create"]> {
    return this.withWriteLock(() => {
      this.refreshIfStale();
      this.assertLivePersonaSources(input.sourceIds);
      return this.goals.create(input);
    });
  }

  updateGoal(
    id: string,
    patch: Parameters<GoalStore["update"]>[1],
  ): ReturnType<GoalStore["update"]> {
    return this.withWriteLock(() => {
      this.refreshIfStale();
      if (patch.sourceIds !== undefined) {
        this.assertLivePersonaSources(patch.sourceIds);
      }
      return this.goals.update(id, patch);
    });
  }

  setGoalStatus(
    id: string,
    status: Parameters<GoalStore["setStatus"]>[1],
  ): ReturnType<GoalStore["setStatus"]> {
    return this.withWriteLock(() => {
      this.refreshIfStale();
      return this.goals.setStatus(id, status);
    });
  }

  removeGoal(id: string): boolean {
    return this.withWriteLock(() => {
      this.refreshIfStale();
      return this.goals.remove(id);
    });
  }

  recordExperience(
    input: Parameters<ExperienceStore["record"]>[0],
  ): ReturnType<ExperienceStore["record"]> {
    return this.withWriteLock(() => {
      this.refreshIfStale();
      this.assertLivePersonaSources(input.sourceIds);
      return this.experiences.record(input);
    });
  }

  confirmExperience(id: string, by = "cli", expiresAt?: number): boolean {
    return this.withWriteLock(() => {
      this.refreshIfStale();
      return this.experiences.confirm(id, by, Date.now(), expiresAt);
    });
  }

  revokeExperience(id: string, by = "cli"): boolean {
    return this.withWriteLock(() => {
      this.refreshIfStale();
      return this.experiences.revoke(id, by);
    });
  }

  removeExperience(id: string): boolean {
    return this.withWriteLock(() => {
      this.refreshIfStale();
      return this.experiences.remove(id);
    });
  }

  // ---- reflection (0.4.0 item 3, Generative Agents 反思触发器) ----
  //
  // The gate check for memory_reflect: the last 24 h of new
  // persona memories (minus entries already folded into a
  // reflection), summed by significance. Below the tiny
  // anti-disturbance floor (REFLECTION_MIN_FLOOR) there is no
  // prompt — the tool returns triggered: false and no model is
  // called. Above it the prompt is handed to the model, which
  // decides for itself whether to reflect and what to conclude;
  // the code never blocks it. Read-only: ensure() is in-memory
  // only until flush, so this writes nothing to disk.
  //
  // 0.4.3: the gate SNAPSHOT. reflectionCheck() remembers the
  // sourceIds of the last gate prompt it issued
  // (lastReflectionGateSourceIds, in memory only — never on
  // disk, never in loop.json). The save path validates a
  // conclusion against THAT snapshot, not a freshly recomputed
  // gate: the model may take minutes over the prompt, and a
  // source that crosses the 24 h boundary in between must not
  // be refused for arriving late. Lifecycle: a new gate
  // overwrites the snapshot; a gate below the floor clears it
  // (no prompt was issued, so nothing may be cited); a
  // successful save clears it too (one gate, one reflection —
  // the saved entries are folded into reflectedIds anyway, so
  // the next gate would not contain them). A failed save keeps
  // it, so the model can fix the quotes and retry against the
  // same prompt.
  private lastReflectionGateSourceIds: string[] | null = null;

  /** Source ids of the last reflection gate prompt issued (a
   *  copy), or null when no gate is outstanding — the last gate
   *  was below the floor, or its reflection was already saved.
   *  The memory_reflect save path validates against this
   *  snapshot instead of recomputing the gate (see above). */
  reflectionGateSnapshot(): string[] | null {
    return this.lastReflectionGateSourceIds
      ? [...this.lastReflectionGateSourceIds]
      : null;
  }

  reflectionCheck(now: number = Date.now()): ReflectionCheck {
    const reflectedIds = new Set<string>();
    for (const f of this.fragments.all()) {
      if (f.type === "reflection") {
        for (const id of f.sourceIds) reflectedIds.add(id);
      }
    }
    const gate = reflectionGate(
      this.entries.filter((e) => !this.forget.isForgotten(e.id)),
      (e) => this.attrs.ensure(e, undefined, now).significance,
      now,
      reflectedIds,
    );
    // 0.4.6: the prompt is capped (top 20 / 3000 characters) — the
    // snapshot and the returned sourceIds are the SHOWN entries
    // only, so the model can only cite memories it was shown in
    // full (the prompt's overflow lines are summaries, not
    // citable). entryCount stays the gate total (how much new
    // significance triggered at all).
    const significanceOf = (e: MemoryEntry) =>
      this.attrs.ensure(e, undefined, now).significance;
    const shownEntries = gate.reached
      ? selectCappedEntries(gate.entries, {
          maxEntries: RECENT_MAX_ENTRIES,
          maxChars: RECENT_MAX_CHARS,
          significanceOf,
        }).shown.map((r) => r.entry)
      : [];
    // 0.4.3 snapshot: remember this gate's sources when a prompt
    // is issued; clear when below the floor (no prompt, no
    // citable sources).
    this.lastReflectionGateSourceIds = gate.reached
      ? shownEntries.map((e) => e.id)
      : null;
    return {
      reached: gate.reached,
      significanceSum: gate.significanceSum,
      entryCount: gate.entries.length,
      sourceIds: shownEntries.map((e) => e.id),
      prompt: gate.reached
        ? buildReflectionPrompt(gate.entries, { significanceOf })
        : undefined,
    };
  }

  /** Save a reflection conclusion as a type: "reflection"
   *  fragment (fragments.json). Every 「」-quoted phrase in the
   *  conclusion is verified verbatim against its sources first —
   *  a fabricated quote voids the whole reflection and nothing
   *  is stored. The insight's own new words are never checked
   *  (they are the conclusion, not a citation). Runs under the
   *  write lock and persists fragments.json. */
  saveReflection(
    text: string,
    sourceIds: string[],
  ): ReflectionSaveResult {
    return this.withWriteLock(() => {
      this.refreshIfStale();
      const entriesById = new Map(
        this.entries
          .filter((e) => !this.forget.isForgotten(e.id))
          .map((e) => [e.id, e]),
      );
      const res = saveReflection(text, sourceIds, entriesById, this.fragments);
      // 0.4.3: a successful save consumes the gate snapshot (one
      // gate, one reflection); a failed save keeps it, so the
      // model can fix the quotes and retry against the same prompt.
      if (res.ok) this.lastReflectionGateSourceIds = null;
      return res;
    });
  }

  /** The three dimensions' current values (memory_belief get /
   *  memory_status). No full quotes — only per-dimension strength /
   *  uncertainty / proofCount. */
  beliefSummary(): Record<BeliefDimension, BeliefDimensionSummary> {
    return this.beliefs.summarize();
  }

  /** The compact belief line appended to recall blocks ("" when
   *  there are no beliefs). */
  beliefLine(): string {
    return this.beliefs.line();
  }

  // ---- proactivity (0.4.0 item 7, 行为回流 · 会话内主动版) -------
  //
  // Judgement belongs to the model, guardrails to the code. The
  // tool flow (memory_proact, two calls): (1) {} checks the
  // guardrails and hands the model the prompt — a refusal there
  // costs no model call — and issues a 15-minute prompt token
  // (prepareProactPrompt); issuing a prompt writes no
  // lastJudgedAt and consumes no daily quota. (2) the model
  // hands its decision back together with that token, the
  // guardrails run again (token + TTL + trigger-in-prompt, then
  // the daily and 7-day checks), and the action is stored in
  // loop.json. A model `act: false` stores nothing, consumes no
  // quota, and voids the token it answered. The user's reply
  // closes the loop via recordProactOutcome (appended to
  // log.jsonl like any ordinary message, action marked done).

  /** Current loop state (a copy — loop.json on disk). */
  loopState(): LoopState {
    return this.loop.get();
  }

  /** All loop actions (pending, done, dropped). */
  listProactActions(): PendingAction[] {
    return this.loop.all();
  }

  /** Hard-guardrail check for a trigger (empty trigger = gate
   *  call: only the daily limit is checked). Read-only. When a
   *  prompt token is carried, it must match the outstanding
   *  prompt and be inside its TTL, and the trigger must be one
   *  of that prompt's sourceIds. */
  proactCheck(
    trigger: string,
    now: number = Date.now(),
    promptToken?: string,
  ): {
    ok: boolean;
    reason?: string;
  } {
    return checkGuardrails(this.loop.get(), trigger, now, promptToken);
  }

  /** The 24 h persona memories behind the proactivity prompt,
   *  UNCAPPED — buildProactPrompt caps once (top 20 / 3000
   *  characters by significance) and reports the overflow ("另有
   *  N 条未列出"). (0.4.7, 0.4.6 audit new issue 2: the cap used
   *  to happen here first, so buildProactPrompt never saw any
   *  overflow and the model was never told 180 more memories
   *  existed.) */
  private proactMemories(now: number): MemoryEntry[] {
    return this.entries.filter(
      (e) =>
        e.window === "persona" &&
        !this.forget.isForgotten(e.id) &&
        now - e.ts >= 0 &&
        now - e.ts <= 24 * 60 * 60 * 1000,
    );
  }

  /** The capped selection the proactivity prompt is built from:
   *  same input, same cap as buildProactPrompt applies, so the
   *  source ids are exactly the entries shown in full — a
   *  decision can only carry a trigger the model was shown.
   *  Overflow entries are summaries, never triggers (0.4.6). */
  private proactSelection(now: number): CappedSelection {
    return selectCappedEntries(this.proactMemories(now), {
      maxEntries: RECENT_MAX_ENTRIES,
      maxChars: RECENT_MAX_CHARS,
      significanceOf: (e) => this.significanceOf(e),
    });
  }

  /** The proactivity prompt for the model: the last 24 h of new
   *  persona memories, all beliefs, all saved reflections.
   *  Undefined when there is nothing at all to weigh (no prompt
   *  is built on an empty day). Read-only. */
  proactPrompt(now: number = Date.now()): string | undefined {
    const memories = this.proactMemories(now);
    // 0.5.2: hidden memories must not ride back in through a belief
    // or a reflection whose sources are tombstoned.
    const beliefs = this.beliefs
      .all()
      .filter((b) => b.evidence.some((e) => !this.forget.isForgotten(e.entryId)));
    const reflections = this.fragments
      .all()
      .filter(
        (f) =>
          f.type === "reflection" &&
          f.sourceIds.some((id) => !this.forget.isForgotten(id)),
      );
    if (
      memories.length === 0 &&
      beliefs.length === 0 &&
      reflections.length === 0
    ) {
      return undefined;
    }
    return buildProactPrompt(
      { memories, beliefs, reflections, now },
      { significanceOf: (e) => this.significanceOf(e) },
    );
  }

  /** The ids the proactivity prompt is built from, in prompt
   *  order: today's persona memories, all beliefs, all saved
   *  reflections. These are the only triggers a decision may
   *  carry for the prompt issued alongside them. The memory ids
   *  are the shown (capped) ones only, matching the prompt (0.4.6). */
  proactPromptSourceIds(now: number = Date.now()): string[] {
    const memories = this.proactSelection(now).shown.map(
      (r) => r.entry,
    );
    const beliefs = this.beliefs.all();
    const reflections = this.fragments
      .all()
      .filter((f) => f.type === "reflection");
    return [
      ...memories.map((e) => e.id),
      ...beliefs.map((b) => b.id),
      ...reflections.map((f) => f.id),
    ];
  }

  /** Gate call: check the guardrails, then hand the model the
   *  prompt together with its token. `prompted: false` with a
   *  reason means the day is spent (no model call); `prompted:
   *  false` without one means there is nothing to weigh. The
   *  token is issued (and loop.json written) only when a prompt
   *  is actually built; issuing writes no `lastJudgedAt` and
   *  consumes no daily quota. */
  prepareProactPrompt(
    now: number = Date.now(),
  ): PrepareProactPromptResult {
    return this.withWriteLock(() => {
      this.refreshIfStale();
      const guard = checkGuardrails(this.loop.get(), "", now);
      if (!guard.ok) return { prompted: false, reason: guard.reason };
      const prompt = this.proactPrompt(now);
      if (!prompt) return { prompted: false };
      const sourceIds = this.proactPromptSourceIds(now);
      const issued = this.loop.issuePrompt(sourceIds, now);
      return {
        prompted: true,
        prompt,
        promptToken: issued.token,
        sourceIds,
      };
    });
  }

  /** Void the outstanding prompt token (an `act: false` decision
   *  answers the prompt and retires it, so it can never be
   *  answered twice). A token that does not match the
   *  outstanding prompt clears nothing. Returns false when
   *  there was no outstanding prompt to void. */
  discardProactPrompt(promptToken?: string): boolean {
    return this.withWriteLock(() => {
      this.refreshIfStale();
      return this.loop.clearPrompt(promptToken);
    });
  }

  /** Store a model decision as a pending action. The guardrails
   *  run again here, under the write lock — a decision that went
   *  stale between the gate and the save is still refused.
   *  `channel` is "session" only for now: "qq" returns
   *  {ok:false, reason:"qq_not_connected"} and stores nothing.
   *  When a prompt token is carried, the decision must answer
   *  that exact prompt (token + TTL) and its trigger must be one
   *  of the prompt's sourceIds. A full pending list (3) drops
   *  the oldest pending action first (status "dropped", record
   *  kept). An `act: false` decision stores nothing, consumes
   *  no quota, and voids the token it carried. */
  proactSave(
    decision: ProactDecision,
    channel: ProactChannel = "session",
    now: number = Date.now(),
    promptToken?: string,
  ): { ok: boolean; action?: PendingAction; reason?: string } {
    if (channel === "qq") {
      return { ok: false, reason: "qq_not_connected" };
    }
    return this.withWriteLock(() => {
      this.refreshIfStale();
      if (!decision || decision.act !== true) {
        if (typeof promptToken === "string" && promptToken.length > 0) {
          this.loop.clearPrompt(promptToken);
        }
        return {
          ok: false,
          reason: "没有要执行的行动（模型决定不主动）。",
        };
      }
      return this.loop.addAction(decision, channel, now, promptToken);
    });
  }

  /** Close the loop: append the user's reply to log.jsonl like
   *  any ordinary message (role "user", persona window) and mark
   *  the action done. Unknown / already-done action id, or an
   *  empty reply: nothing is appended, nothing is marked. */
  recordProactOutcome(
    actionId: string,
    userReply: string,
    sessionId: string = "",
  ): { ok: boolean; entry?: MemoryEntry; reason?: string } {
    return this.withWriteLock(() => {
      this.refreshIfStale();
      let entry: MemoryEntry | undefined;
      const closed = recordOutcome(
        this.loop,
        actionId,
        userReply,
        (text) => {
          entry = this.record({
            role: "user",
            text,
            window: "persona",
            sessionId,
          });
        },
      );
      if (!closed) {
        return {
          ok: false,
          reason: "没有这条待执行的行动，或它已经完成了。",
        };
      }
      return { ok: true, entry };
    });
  }

  /** Mark one pending action done WITHOUT appending anything —
   *  for callers whose user reply is already in the log (the DSH
   *  session/event handler records every user message itself).
   *  Returns false when the id is unknown or already done. */
  markProactDone(actionId: string): boolean {
    return this.withWriteLock(() => {
      this.refreshIfStale();
      return this.loop.markDone(actionId);
    });
  }

  // ---- MEMORY.md (read-only) --------------------------------------

  /** Layer 1 current state, as the skill wrote it. Stage comes from here. */
  readLayer1(): Layer1State {
    return mergeProfile(this.memoryFile.load().layer1, loadProfile(this.dataDir));
  }

  /** Whole skill memory file, read-only (for memory_search display). */
  readMemoryFile(): ParsedMemoryFile {
    const parsed = this.memoryFile.load();
    return { ...parsed, layer1: mergeProfile(parsed.layer1, loadProfile(this.dataDir)) };
  }

  /** Update the persona profile (profile.json). Tool layer restricts to persona windows. */
  updateProfile(profile: Partial<PersonaProfile>, at = Date.now()): PersonaProfile {
    return this.withWriteLock(() => {
      this.refreshIfStale();
      const previous = loadProfile(this.dataDir) ?? {};
      const next: PersonaProfile = { ...previous, ...profile, updatedAt: at };
      saveProfile(this.dataDir, next);
      return next;
    });
  }

  // ---- rollover ---------------------------------------------------
  //
  // When the current log passes logMaxEntries, its entries move into
  // per-month segment files (log-YYYY-MM.jsonl) and a fresh log.jsonl
  // starts. Segments stay indexed and searchable; nothing is deleted.

  rollover(): LogRolloverResult {
    return this.withWriteLock(() => {
      // Another writer may have appended (or rolled over) since this
      // instance last looked: reload first, or the segment merge and
      // the index rebuild below would silently drop their entries.
      this.refreshIfStale();
      const current = this.currentLogEntries();
      if (current.length <= this.logMaxEntries) {
        return { moved: 0, segments: [], byMonth: {} };
      }
      const byMonth: Record<string, number> = {};
      const segments: string[] = [];
      const grouped = new Map<string, MemoryEntry[]>();
      for (const e of current) {
        const month = monthKey(e.ts);
        const list = grouped.get(month) ?? [];
        list.push(e);
        grouped.set(month, list);
      }
      for (const [month, entries] of [...grouped.entries()].sort()) {
        const segment = join(this.dataDir, `log-${month}.jsonl`);
        const existing = existsSync(segment)
          ? new AppendLog(segment).readAll()
          : [];
        const merged = [...existing, ...entries].sort((a, b) => a.ts - b.ts);
        atomicWriteText(
          segment,
          merged.map((e) => JSON.stringify(e)).join("\n") + "\n",
        );
        byMonth[month] = entries.length;
        segments.push(segment);
      }
      // Truncate the current log atomically (entries now live in the
      // segments). Segments were written first, so a crash before this
      // point only duplicates entries — and loadAllLogEntries dedupes
      // by id on reload, so nothing is counted twice.
      atomicWriteText(join(this.dataDir, LOG_FILE), "");
      this.currentLogCount = 0;
      this.index.build(this.entries);
      this.index.save(this.logFiles());
      // Segments were written and the log truncated: the fingerprints
      // changed, and the in-memory entries (now living in the
      // segments) still match the disk.
      this.lastSeenFingerprints = this.snapshotFingerprints();
      return {
        moved: current.length,
        segments,
        byMonth,
      };
    });
  }

  // ---- flush / snapshots / restore --------------------------------

  /** Persist the keyword index (called on turn end, compaction flush,
   *  session end and unload — record() only updates it in memory).
   *  Under the write lock, and refreshes from disk first when another
   *  writer moved: saving a stale in-memory index over the current
   *  log files would make a fresh core accept it as current and never
   *  find the other writer's entries.
   *  0.2.0: also persists the graph and the attributes (in-memory
   *  recall bumps live here until flushed). 0.3.0: also persists
   *  fragments (in-memory suspect marks from recall live here
   *  until flushed). 0.4.0 item 2: also persists beliefs.
   *  0.4.0 item 7: also persists the loop state. */
  flush(): void {
    this.withWriteLock(() => {
      this.refreshIfStale();
      this.index.save(this.logFiles());
      this.graph.save();
      this.attrs.save();
      this.fragments.save();
      this.beliefs.save();
      this.loop.save();
      // 0.5.1 item 4: experience use-counts are in-memory until
      // here (markUsed never writes on the recall path).
      this.experiences.save();
      this.goals.save();
      // The saves above moved the store files — the fingerprints
      // are current again, or the next refreshIfStale would
      // needlessly reload our own writes.
      this.lastSeenFingerprints = this.snapshotFingerprints();
    });
  }

  snapshot(): string {
    // The snapshot copies log + index while no writer can change
    // them mid-copy: without the lock, a concurrent append could
    // land half-copied (a torn line is skipped on read, but a
    // snapshot should be a clean point in time).
    return this.withWriteLock(() =>
      takeSnapshot(this.dataDir, this.snapshotKeep),
    );
  }

  listSnapshots(): string[] {
    return listSnapshots(this.dataDir);
  }

  /**
   * Explicit recovery operation (invoked, never automatic): restore a
   * snapshot over the data folder. First snapshots the current state,
   * then reloads log + index from the restored files. Returns the
   * safety snapshot name.
   */
  restore(name: string): string {
    // The whole restore (safety snapshot + file moves + reload) holds
    // the write lock: a concurrent record mid-restore could append to
    // a log file the restore is about to replace, and the record
    // would be lost without a trace.
    return this.withWriteLock(() => {
      const safety = restoreSnapshot(this.dataDir, name);
      this.entries = this.loadAllLogEntries();
      this.counter = this.entries.length;
      this.currentLogCount = this.currentLogEntries().length;
      this.rebuildIndex();
      // 0.5.2: derived state must not survive a rollback. The semantic
      // index is dropped (rebuilt lazily from the restored log), any
      // pending reflection gate is invalid, and the starmap is
      // regenerated from the restored entries.
      this.semanticIndex = null;
      this.semanticIndexStatus = null;
      this.lastReflectionGateSourceIds = null;
      // 0.5.4: experiences/goals were restored with the log; drop any
      // source id that is not live at this restored point in time.
      this.revalidateReferences();
      this.generateStarmap();
      // (rebuildIndex -> refreshIfStale already reloads the 0.2.0
      // graph, attributes, summaries and session map, since the
      // restored log files moved the fingerprints.)
      return safety;
    });
  }

  rebuildIndex(): void {
    this.withWriteLock(() => {
      this.refreshIfStale();
      this.index.build(this.entries);
      this.index.save(this.logFiles());
    });
  }

  /** Session end: snapshot, then roll the log over if it is past the
   *  cap, then persist the index. One lock for the whole sequence
   *  (nested calls are re-entrant), so no writer can slip in between
   *  the snapshot and the rollover. */
  endSession(): EndSessionResult {
    return this.withWriteLock(() => {
      const snapshot = this.snapshot();
      const rollover = this.rollover();
      this.flush();
      return { snapshot, rollover };
    });
  }

  /** 0.2.0 daily review. Runs only when due (>24 h since the last
   *  one) unless force is set — there is no background service, so
   *  the DSH shell calls this at session start. Decay, compression,
   *  promotion and new-edge linking happen here; the starmap is
   *  regenerated afterwards so the picture always matches the data.
   *  Returns null when skipped as not due. Never writes MEMORY.md.
   *
   *  The due-gate is checked TWICE: once before the lock (cheap
   *  skip) and once inside the lock. Two processes starting at the
   *  same moment both see "due" before the lock; without the
   *  in-lock re-check both would run the review (TOCTOU) and the
   *  day's work — decay, compression, promotion — would happen
   *  twice. */
  review(force = false, now = Date.now()): ReviewResult | null {
    const state = loadReviewState(this.dataDir);
    if (!force && state.lastReviewedAt !== null && now - state.lastReviewedAt < REVIEW_INTERVAL_MS) {
      return null;
    }
    const result = this.withWriteLock(() => {
      this.refreshIfStale();
      if (!force) {
        const fresh = loadReviewState(this.dataDir);
        if (fresh.lastReviewedAt !== null && now - fresh.lastReviewedAt < REVIEW_INTERVAL_MS) {
          return null;
        }
      }
      // 0.4.6 (0.4.5 audit new issue 2): the profile name's tokens
      // can never be invalidation topics either — a rename via
      // memory_profile is honoured on top of the skill-name
      // default in review.ts.
      const profileName = loadProfile(this.dataDir)?.name;
      const r = runReview({
        dataDir: this.dataDir,
        // 0.5.2: hidden memories never get attributes, compression,
        // graph edges or review prompts. 0.5.3: task-window entries
        // are not her memories and are excluded from review too — they
        // used to be decayed/compressed/backfilled alongside persona
        // entries.
        entries: this.entries.filter(
          (e) => e.window === "persona" && !this.forget.isForgotten(e.id),
        ),
        graph: this.graph,
        attrs: this.attrs,
        index: this.index,
        fragments: this.fragments.all(),
        beliefs: this.beliefs,
        now,
        excludedTopicTokens: profileName
          ? new Set(tokenize(profileName))
          : undefined,
      });
      // review.json was written by runReview; the in-memory
      // summaries cache picks up any new compressed lines.
      this.summaries = loadSummaries(this.dataDir);
      return r;
    });
    if (result === null) return null;
    // Regenerate the starmap outside the lock (read-only render).
    this.generateStarmap();
    return result;
  }

  /** 0.3.1 (拾光): regenerate starmap.html from the current graph +
   *  attributes + log. Derived artifact — excluded from snapshots,
   *  regenerated on review and on demand (memory_starmap tool). */
  generateStarmap(): StarmapResult {
    const data = buildStarmapData(
      // 0.5.2: the starmap is a persona-facing view; hidden entries
      // are not drawn unless the admin explicitly asks for them.
      this.entries.filter((e) => !this.forget.isForgotten(e.id)),
      this.graph.allEdges(),
      this.attrs.all(),
      Date.now(),
      this.fragments.all(),
    );
    const html = renderStarmapHtml(data);
    atomicWriteText(join(this.dataDir, STARMAP_FILE), html);
    return {
      path: join(this.dataDir, STARMAP_FILE),
      nodes: data.memories.length,
      edges: data.edges.length,
      generatedAt: Date.now(),
    };
  }

  /** All live log entries, oldest-first (a copy — the admin
   *  layer lists and filters from this). Hidden (tombstoned)
   *  entries are included: the admin is allowed to see what the
   *  user asked to forget, so it can unhide them. */
  allEntries(): MemoryEntry[] {
    return [...this.entries];
  }

  /** Fragment / belief counts (admin stats). */
  fragmentCount(): number {
    return this.fragments.size;
  }

  beliefCount(): number {
    return this.beliefs.size;
  }

  stats(): CoreStats {
    return {
      totalEntries: this.entries.length,
      layer2Count: this.memoryFile.load().layer2.length,
      archiveMonths: this.memoryFile.listArchiveMonths(),
      indexTokens: this.index.size,
      snapshots: this.listSnapshots(),
      // 0.2.0
      graphEdges: this.graph.size,
      attributes: this.attrs.size,
      lastReviewAt: loadReviewState(this.dataDir).lastReviewedAt,
      // 0.3.0
      fragments: this.fragments.size,
      suspectFragments: this.fragments.suspectCount,
      // 0.4.0 item 2
      beliefs: this.beliefs.size,
      beliefDimensions: this.beliefs.summarize(),
      // 0.4.4 item 2: memories flagged needsInvalidationCheck and
      // not yet invalidated — "awaiting model review". 0.5.1
      // (0.4.5 item 6): the count is "待下次复盘确认", NOT "live
      // contradictions" — the old comment claimed it never counts
      // a stale check, which was wrong: a flag whose opposing
      // statement aged past the 30-day window is still counted
      // here until the NEXT review runs and clears it (the flag
      // only clears inside runReview, when the opposition has
      // lapsed). Between reviews this number can include flags
      // whose window already passed; that is by design — the
      // review, not the clock, resolves them.
      pendingInvalidationChecks: this.entries.filter((e) => {
        const attrs = this.attrs.get(e.id);
        return (
          attrs?.needsInvalidationCheck === true &&
          !(attrs.validTo != null && attrs.validTo <= Date.now())
        );
      }).length,
    };
  }
}

export { DEFAULT_TOKEN_CAP };
export { MemoryFile } from "./memory-file.ts";
export { parseMemoryText } from "./memory-file.ts";
