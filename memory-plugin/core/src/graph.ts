// MemoryGraph: associative links between log entries (0.2.0).
//
// Nodes are log entries (by id); edges are undirected links with a
// weight in (0, 1]. Three sources:
// - "session": adjacent entries in one session (things talked about
//   together are related);
// - "keyword": two entries sharing a rare keyword (document
//   frequency <= MAX_RARE_DF);
// - "recall": entry A was recalled and the conversation then moved
//   to B (the graph learns from use).
//
// Weights grow when an edge is traversed (recall follows it) and
// decay slowly when unused — never to zero, so a link never dies.
// Persisted to graph.json (atomic write). The log stays the source
// of truth; the graph is derived and rebuildable (backfill).
//
// TRAVERSAL RULE (deliberate, 0.2.0): recall follows "keyword" and
// "recall" edges only — NOT "session" edges. Session adjacency
// alone is not evidence of relatedness: any two adjacent messages
// link, including across a topic change, so traversing them injects
// unrelated memories (the exact failure the 0.1.x no-fallback rule
// was written to prevent; the 0.1.6 dedupe checks "different facts
// survive" would break). Session edges are still recorded — the
// starmap draws them as constellation lines — and a session
// neighbour becomes reachable the moment a recall actually leads
// to it (then it is a "recall" edge).

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteText } from "./atomic.ts";
import type { KeywordIndex } from "./keyword-index.ts";
import { tokenize } from "./tokenize.ts";
import type { GraphEdge, MemoryEntry } from "./types.ts";

export const GRAPH_FILE = "graph.json";

/** Traversable edge types (see the header note). */
export const TRAVERSABLE_TYPES: ReadonlySet<GraphEdge["type"]> = new Set([
  "keyword",
  "recall",
]);

export const EDGE_INITIAL_WEIGHT: Record<GraphEdge["type"], number> = {
  session: 0.5,
  keyword: 0.6,
  recall: 0.8,
};
export const EDGE_MIN_WEIGHT = 0.1;
export const EDGE_TRAVERSE_BUMP = 0.05;
export const EDGE_DECAY_PER_REVIEW = 0.95;
/** An edge not traversed for this long decays at review time. */
export const EDGE_DECAY_AFTER_MS = 24 * 60 * 60 * 1000;
/** A token shared by more than this many entries is too common to
 *  prove a link ("查岗" in every other line links nothing). */
export const MAX_RARE_DF = 5;
/** Keyword edges created per new entry, rarest token first. */
export const MAX_KEYWORD_EDGES_PER_ENTRY = 3;

/** Valid edge types — anything else in a hand-edited graph.json
 *  is dropped, not carried. */
const VALID_EDGE_TYPES: ReadonlySet<string> = new Set([
  "session",
  "keyword",
  "recall",
]);

/** Type strength for link() upgrades: a stronger evidence type
 *  replaces a weaker one on the same pair (recall > keyword >
 *  session). */
const TYPE_RANK: Record<GraphEdge["type"], number> = {
  session: 0,
  keyword: 1,
  recall: 2,
};

interface PersistedGraph {
  version: 1;
  edges: GraphEdge[];
}

function canonical(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

/** Index key for one undirected edge: canonical from + NUL + to. */
function edgeKey(from: string, to: string): string {
  return `${from}\0${to}`;
}

export class MemoryGraph {
  private edges: GraphEdge[] = [];
  private adj = new Map<string, GraphEdge[]>();
  /** O(1) lookup by canonical (from, to) — find() is on the recall
   *  hot path (review-9 m-7). Holds the SAME edge objects as
   *  this.edges, so weight/type mutations through a found edge
   *  stay in sync. Rebuilt by rebuildIndexes(); link() maintains
   *  it incrementally for new edges. There is no edge removal. */
  private edgeIndex = new Map<string, GraphEdge>();
  private readonly file: string;
  /** True when graph.json existed on disk at load. A first 0.2.0
   *  run over an old data dir backfills from the existing log. */
  readonly loadedExisting: boolean;

  constructor(dataDir: string) {
    this.file = join(dataDir, GRAPH_FILE);
    this.loadedExisting = this.load();
    this.rebuildIndexes();
  }

  get size(): number {
    return this.edges.length;
  }

  allEdges(): GraphEdge[] {
    return [...this.edges];
  }

  /** Load graph.json. Missing or corrupt starts empty (the graph
   *  is derived — backfill rebuilds it from the log). Hand-edited
   *  rows are sanitised: the type must be one of the three, the
   *  weight must be a finite number in (0, 1] (clamped, never
   *  trusted — a weight of 5 must never reach traversal), a missing
   *  or non-numeric lastTraversedAt defaults to 0 (never traversed),
   *  endpoints are canonicalised, and duplicate (from, to) pairs
   *  keep only the first valid row. */
  private load(): boolean {
    try {
      if (!existsSync(this.file)) return false;
      const data = JSON.parse(readFileSync(this.file, "utf8")) as PersistedGraph;
      if (data.version !== 1 || !Array.isArray(data.edges)) return false;
      const seen = new Set<string>();
      const clean: GraphEdge[] = [];
      for (const e of data.edges) {
        if (
          !e ||
          typeof e.from !== "string" ||
          typeof e.to !== "string" ||
          e.from === e.to ||
          !VALID_EDGE_TYPES.has(e.type) ||
          !Number.isFinite(e.weight) ||
          e.weight <= 0
        ) {
          continue;
        }
        const [from, to] = canonical(e.from, e.to);
        const key = edgeKey(from, to);
        if (seen.has(key)) continue;
        seen.add(key);
        clean.push({
          from,
          to,
          type: e.type as GraphEdge["type"],
          weight: Math.min(1, e.weight),
          lastTraversedAt:
            typeof e.lastTraversedAt === "number" &&
            Number.isFinite(e.lastTraversedAt)
              ? e.lastTraversedAt
              : 0,
        });
      }
      this.edges = clean;
      return true;
    } catch {
      this.edges = [];
      return false;
    }
  }

  /** Re-read graph.json from disk (called under the write lock
   *  when another writer may have moved it). In-memory traverse
   *  bumps not yet flushed are lost on reload — small weights,
   *  harmless; the log (source of truth) is never affected. */
  reload(): void {
    this.load();
    this.rebuildIndexes();
  }

  save(): void {
    atomicWriteText(
      this.file,
      JSON.stringify({ version: 1, edges: this.edges } satisfies PersistedGraph),
    );
  }

  /** Rebuild the adjacency map AND the (from, to) index from the
   *  edge list. Called after load()/reload(); link() maintains
   *  both incrementally for new edges. */
  private rebuildIndexes(): void {
    this.adj.clear();
    this.edgeIndex.clear();
    for (const e of this.edges) {
      for (const id of [e.from, e.to]) {
        const list = this.adj.get(id) ?? [];
        list.push(e);
        this.adj.set(id, list);
      }
      this.edgeIndex.set(edgeKey(e.from, e.to), e);
    }
  }

  /** The edge between a and b, either direction. O(1) via the index. */
  find(a: string, b: string): GraphEdge | undefined {
    const [from, to] = canonical(a, b);
    return this.edgeIndex.get(edgeKey(from, to));
  }

  /** Create or strengthen a link. An existing edge keeps its weight
   *  unless the new type starts stronger (a recall link is stronger
   *  evidence than a session link), and its type upgrades to the
   *  stronger evidence (recall > keyword > session) — a pair that
   *  first linked as session neighbours and later shares a rare
   *  keyword becomes a keyword edge, so it is traversable. Any
   *  strengthening refreshes lastTraversedAt: new evidence today
   *  means the edge is not stale. */
  link(a: string, b: string, type: GraphEdge["type"], now: number): GraphEdge | undefined {
    if (a === b) return undefined;
    const [from, to] = canonical(a, b);
    const existing = this.find(a, b);
    if (existing) {
      existing.weight = Math.max(existing.weight, EDGE_INITIAL_WEIGHT[type]);
      if (TYPE_RANK[type] > TYPE_RANK[existing.type]) {
        existing.type = type;
      }
      existing.lastTraversedAt = now;
      return existing;
    }
    const edge: GraphEdge = {
      from,
      to,
      type,
      weight: EDGE_INITIAL_WEIGHT[type],
      lastTraversedAt: now,
    };
    this.edges.push(edge);
    this.edgeIndex.set(edgeKey(from, to), edge);
    for (const id of [from, to]) {
      const list = this.adj.get(id) ?? [];
      list.push(edge);
      this.adj.set(id, list);
    }
    return edge;
  }

  /** Edges touching an entry (any type). */
  neighbors(id: string): GraphEdge[] {
    return [...(this.adj.get(id) ?? [])];
  }

  /** The other endpoint of an edge, from one side. */
  otherEnd(edge: GraphEdge, id: string): string {
    return edge.from === id ? edge.to : edge.from;
  }

  /** Follow an edge: weight grows a little, capped at 1. In-memory
   *  only — the caller persists (flush / record / review). */
  traverse(a: string, b: string, now: number): void {
    const edge = this.find(a, b);
    if (!edge) return;
    edge.weight = Math.min(1, edge.weight + EDGE_TRAVERSE_BUMP);
    edge.lastTraversedAt = now;
  }

  /** Slow fade for edges nobody walked lately. Never below the
   *  floor, never to zero — a link never dies. Decay is per TIME,
   *  not per call: after an edge decays, its clock restarts at now,
   *  so calling decay() three times at the same instant only fades
   *  it once (the next fade needs another 24 h of non-use). */
  decay(now: number): number {
    let changed = 0;
    for (const e of this.edges) {
      if (now - e.lastTraversedAt < EDGE_DECAY_AFTER_MS) continue;
      const next = Math.max(EDGE_MIN_WEIGHT, e.weight * EDGE_DECAY_PER_REVIEW);
      if (next !== e.weight) {
        e.weight = next;
        e.lastTraversedAt = now;
        changed += 1;
      }
    }
    return changed;
  }

  /** Link a fresh entry: a session edge to the previous entry in
   *  the same session, plus keyword edges to entries sharing a rare
   *  token (rarest first, capped). Returns the edges created.
   *  onlyNew (backfill): create only edges that do not exist yet —
   *  never strengthen an existing one. A per-review backfill that
   *  re-strengthened decayed edges would pin their weight at the
   *  initial value and neutralise decay entirely. */
  linkNewEntry(
    entry: MemoryEntry,
    index: KeywordIndex,
    prevInSession: MemoryEntry | null,
    now: number,
    onlyNew = false,
  ): GraphEdge[] {
    const made: GraphEdge[] = [];
    const linkOne = (
      a: string,
      b: string,
      type: GraphEdge["type"],
    ): GraphEdge | undefined => {
      if (onlyNew && this.find(a, b)) return undefined;
      return this.link(a, b, type, now);
    };
    if (prevInSession && prevInSession.id !== entry.id) {
      const e = linkOne(entry.id, prevInSession.id, "session");
      if (e) made.push(e);
    }
    const tokens = tokenize(entry.text);
    if (tokens.length === 0) return made;
    const byToken = index.lookup(tokens);
    // Rarest token first: its sharers are the most specific links.
    // Single-character tokens never create a keyword edge: a lone
    // 好 / 天 / 人 is shared by half of all chat lines, so it says
    // nothing about two memories being on the same topic — and (M4)
    // it would upgrade their session edge to a traversable keyword
    // edge on generic evidence. Multi-char tokens (bigrams, whole
    // runs) carry the topical signal. Single chars still work for
    // direct query matching (the index), just not for graph links.
    const ranked = [...byToken.entries()]
      .map(([token, ids]) => ({ token, ids: ids.filter((id) => id !== entry.id) }))
      .filter((t) => t.token.length >= 2 && t.ids.length > 0 && t.ids.length <= MAX_RARE_DF)
      .sort((a, b) => a.ids.length - b.ids.length || a.token.localeCompare(b.token));
    const linked = new Set<string>();
    for (const { ids } of ranked) {
      for (const id of ids) {
        if (made.filter((e) => e.type === "keyword").length >= MAX_KEYWORD_EDGES_PER_ENTRY) break;
        if (linked.has(id)) continue;
        linked.add(id);
        const e = linkOne(entry.id, id, "keyword");
        if (e) made.push(e);
      }
      if (made.filter((e) => e.type === "keyword").length >= MAX_KEYWORD_EDGES_PER_ENTRY) break;
    }
    return made;
  }

  /** One-time backfill for a log that predates the graph: walk
   *  entries in ts order and link each one as if just recorded.
   *  Only creates edges that do not exist yet — re-running it (every
   *  review does) must never touch an existing edge's weight, type
   *  or clock, or decay would be undone. Returns the number of NEW
   *  edges created. */
  backfill(entries: MemoryEntry[], index: KeywordIndex, now: number): number {
    const before = this.edges.length;
    const sorted = [...entries].sort((a, b) => a.ts - b.ts);
    const lastBySession = new Map<string, MemoryEntry>();
    for (const e of sorted) {
      this.linkNewEntry(e, index, lastBySession.get(e.sessionId) ?? null, now, true);
      lastBySession.set(e.sessionId, e);
    }
    return this.edges.length - before;
  }
}
