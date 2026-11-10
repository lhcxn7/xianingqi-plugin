// Retrieval providers (0.5.0 step 5: query-rewrite hybrid recall).
//
// The recall path is split behind one interface so the keyword
// default, the rewrite variant and a future semantic provider all
// answer the same call — and so the caller can always fall back to
// keyword-only without touching the turn.
//
// - KeywordRetriever (default): the existing recallFromEntries
//   keyword path, byte for byte — its core logic is NOT changed
//   here. A rewritten query arrives as RecallOptions.rewrittenQuery
//   (a plain string + the original query); its tokens union with
//   the original's, so a bad rewrite can never lose the original
//   recall.
// - SemanticRetriever: the slot a real embedding provider plugs
//   into. retrieveIds returns entry ids ordered by similarity;
//   recall treats them as extra candidates (see
//   recallFromEntries: they surface in explicit searches and are
//   gated by the valve like everything else, because they carry
//   no keyword content signal). A mock implementation lives in
//   the tests; the real one is core/src/semantic.ts
//   (TransformersEmbeddingProvider + SemanticIndex), reached
//   through the async semanticCandidateIds() helper — recall
//   itself stays synchronous, so the async embed + timeout race
//   happens at the call site (dsh-plugin pre-step / memory_search)
//   and the ids arrive here pre-computed.
// - HybridRetriever (0.5.1 item 2): keyword + semantic merged
//   into the SAME ranking — never a second ranking, never a
//   separate top-5. It is KeywordRetriever with the semantic slot
//   filled; the merge is recallFromEntries' job.
// - Query rewrite itself is NOT a provider: the rewrite is an
//   async model call and recall is synchronous, so the dsh-plugin
//   side awaits the rewriter (with timeout, falling back to the
//   original query) and hands core both strings.

import { recallFromEntries } from "./recall.ts";
import type { RecallOptions } from "./recall.ts";
import type { Layer1State, MemoryEntry, RecallResult } from "./types.ts";

/** A semantic provider: given a query, return entry ids ordered
 *  by similarity (best first). The real implementation is
 *  core/src/semantic.ts; a deterministic mock lives in the tests.
 *  `similarityOf` is optional: when the caller has the scores it
 *  hands them over, so recall can score a semantic-only hit by
 *  its similarity instead of by recency (0.5.1 item 2 — a
 *  0.45-similarity hit from yesterday must not outrank a
 *  0.65-similarity hit from a year ago). A provider without it
 *  scores its hits 0 (keyword evidence only). */
export interface SemanticRetriever {
  readonly kind: "semantic";
  retrieveIds(query: string, entries: MemoryEntry[]): string[];
  similarityOf?(id: string): number | undefined;
}
export interface SemanticRetriever {
  readonly kind: "semantic";
  retrieveIds(query: string, entries: MemoryEntry[]): string[];
}

/** One recall strategy behind a single call. */
export interface RetrievalProvider {
  readonly kind: "keyword" | "semantic" | "hybrid";
  retrieve(
    query: string,
    entries: MemoryEntry[],
    layer1: Layer1State | null,
    opts?: RecallOptions,
    now?: number,
  ): RecallResult;
}

/** The default provider: the existing keyword recall, unchanged. */
export class KeywordRetriever implements RetrievalProvider {
  readonly kind = "keyword" as const;

  retrieve(
    query: string,
    entries: MemoryEntry[],
    layer1: Layer1State | null,
    opts: RecallOptions = {},
    now: number = Date.now(),
  ): RecallResult {
    return recallFromEntries(entries, layer1, query, opts, now);
  }
}

/** 0.5.1 item 2: keyword + semantic in one ranking. The semantic
 *  ids arrive pre-computed (the async embed + timeout race ran at
 *  the call site); this class only fills the slot recall already
 *  merges — no second ranking, no separate top-5. */
export class HybridRetriever implements RetrievalProvider {
  readonly kind = "hybrid" as const;
  private readonly semantic: SemanticRetriever;

  constructor(semantic: SemanticRetriever) {
    this.semantic = semantic;
  }

  retrieve(
    query: string,
    entries: MemoryEntry[],
    layer1: Layer1State | null,
    opts: RecallOptions = {},
    now: number = Date.now(),
  ): RecallResult {
    return recallFromEntries(entries, layer1, query, {
      ...opts,
      semantic: this.semantic,
    }, now);
  }
}

/** The default provider, shared instance. */
export const defaultRetriever = new KeywordRetriever();
