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
  existsSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { atomicWriteText, ensureDir } from "./atomic.ts";
import { AttributeStore } from "./attributes.ts";
import { formatDate, formatTime, monthKey } from "./dates.ts";
import { FragmentStore } from "./fragments.ts";
import type {
  FragmentCreateResult,
  FragmentInput,
} from "./fragments.ts";
import { MemoryGraph } from "./graph.ts";
import {
  acquireWriteLock,
  DEFAULT_LOCK_TIMEOUT_MS,
} from "./lock.ts";
import { AppendLog } from "./log.ts";
import {
  KeywordIndex,
  fingerprintLogFiles,
  fingerprintsEqual,
} from "./keyword-index.ts";
import { MemoryFile } from "./memory-file.ts";
import { DEFAULT_TOKEN_CAP, recallFromEntries } from "./recall.ts";
import {
  REVIEW_INTERVAL_MS,
  loadReviewState,
  loadSummaries,
  runReview,
} from "./review.ts";
import {
  listSnapshots,
  restoreSnapshot,
  takeSnapshot,
} from "./snapshot.ts";
import {
  STARMAP_FILE,
  buildStarmapData,
  renderStarmapHtml,
} from "./starmap.ts";
import { tokenize } from "./tokenize.ts";
import type {
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
  /** Fingerprints of the log files as this instance last saw them.
   *  refreshIfStale() reloads when another writer changed them. */
  private lastSeenFingerprints: ReturnType<
    typeof fingerprintLogFiles
  > | null = null;

  constructor(opts: CoreOptions) {
    this.dataDir = opts.dataDir;
    this.logMaxEntries = opts.logMaxEntries ?? 1000;
    this.snapshotKeep = opts.snapshotKeep ?? 30;
    ensureDir(this.dataDir);
    this.memoryFile = new MemoryFile(this.dataDir);
    this.entries = this.loadAllLogEntries();
    this.counter = this.entries.length;
    this.currentLogCount = this.currentLogEntries().length;
    this.lastSeenFingerprints = fingerprintLogFiles(this.logFiles());
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
            this.lastSeenFingerprints = fingerprintLogFiles(
              this.logFiles(),
            );
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
   *  writer changed the log files since this instance last looked.
   *  Must be called holding the write lock. Returns true when a
   *  reload happened. Without this, a flush after another process's
   *  records would save an index built from stale in-memory entries
   *  but fingerprinted against the NEW log files — a fresh core would
   *  then accept the index as current and never find the other
   *  process's entries. */
  private refreshIfStale(): boolean {
    const files = this.logFiles();
    const fp = fingerprintLogFiles(files);
    if (
      this.lastSeenFingerprints &&
      fingerprintsEqual(this.lastSeenFingerprints, fp)
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
    // 0.3.0: same for fragments.json.
    this.graph.reload();
    this.attrs.reload();
    this.fragments.reload();
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
      this.lastSeenFingerprints = fingerprintLogFiles(this.logFiles());
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
    } = {},
  ): RecallResult {
    // A non-string query (a bad tool call) returns empty, never
    // throws (audit m11).
    if (typeof query !== "string") {
      return {
        hits: [],
        layer1: this.readLayer1(),
        estimatedTokens: 0,
        text: "",
      };
    }
    const tokens = tokenize(query);
    const archiveHits =
      tokens.length > 0 ? this.memoryFile.searchArchives(tokens) : [];
    // Load layer 1 + layer 2 together: recall needs layer 1 for
    // reference (stage) and layer 2 for the 0.1.6 dedupe (a log hit
    // saying what the skill already read at open is dropped).
    const parsed = this.memoryFile.load();
    const layer1 = parsed.layer1;
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
    const result = recallFromEntries(
      [...this.entries, ...archiveHits],
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

  // ---- daily model review (0.3.0, new layer 2) --------------------
  //
  // yesterdayEntries(): every persona-window log entry from
  // yesterday (host-local date). The model review reads ALL of
  // them — no token limit on reading. Task-window entries are not
  // her memories and are left out.
  yesterdayEntries(now = Date.now()): MemoryEntry[] {
    const yesterday = formatDate(now - 86_400_000);
    return this.entries.filter(
      (e) => e.window === "persona" && e.date === yesterday,
    );
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
      const entriesById = new Map(this.entries.map((e) => [e.id, e]));
      return this.fragments.create(input, entriesById);
    });
  }

  /** All stored fragments (for memory_status / review / tests). */
  listFragments(): import("./fragments.ts").Fragment[] {
    return this.fragments.all();
  }

  // ---- MEMORY.md (read-only) --------------------------------------

  /** Layer 1 current state, as the skill wrote it. Stage comes from here. */
  readLayer1(): Layer1State {
    return this.memoryFile.load().layer1;
  }

  /** Whole skill memory file, read-only (for memory_search display). */
  readMemoryFile(): ParsedMemoryFile {
    return this.memoryFile.load();
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
      this.lastSeenFingerprints = fingerprintLogFiles(this.logFiles());
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
   *  until flushed). */
  flush(): void {
    this.withWriteLock(() => {
      this.refreshIfStale();
      this.index.save(this.logFiles());
      this.graph.save();
      this.attrs.save();
      this.fragments.save();
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
      const r = runReview({
        dataDir: this.dataDir,
        entries: this.entries,
        graph: this.graph,
        attrs: this.attrs,
        index: this.index,
        fragments: this.fragments.all(),
        now,
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
      this.entries,
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
    };
  }
}

export { DEFAULT_TOKEN_CAP };
export { MemoryFile } from "./memory-file.ts";
export { parseMemoryText } from "./memory-file.ts";
