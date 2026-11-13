// Local embedding (0.5.1 item 2, per LOCAL-EMBEDDING-PLAN.md).
//
// bge-small-zh-v1.5 (ONNX int8 export by Xenova, base model
// BAAI/bge-small-zh-v1.5), run on CPU via @huggingface/transformers
// + onnxruntime-node. No Python, no GPU, no resident service, no
// network at runtime — the model is loaded from a local directory
// only (env.allowRemoteModels = false), and a missing / corrupt
// model is "model unavailable", never a silent download. The one
// network step is installing the optional @huggingface/transformers
// runtime, and that is an explicit `semantic install --yes` (WP9),
// never part of a normal turn.
//
// Pinned identity (the index is only valid for exactly this):
//   model repo   Xenova/bge-small-zh-v1.5 (ONNX export of BAAI's)
//   revision     75c43b069aac4d136ba6bc1122f995fedcfd2781 (40-char SHA)
//   runtime file onnx/model_int8.onnx (23,903,394 bytes, sha256
//     b9837c19ce154ff0726d398ee77abbc03a7faf0476c6f93016c84e531be7ebb5)
//   dimensions   512, pooling "cls", query prefix the BGE Chinese
//     retrieval instruction (documents get no prefix).
// transformers.js v3 has no "quantized" dtype — the v3-compatible
// quantized file is model_int8.onnx (dtype "int8"); the old
// model_quantized.onnx is NOT shipped.
// Full manifest: see MODELS.md at the package root.
//
// The index (semantic-index.json) is DERIVED, not a source of
// truth: the log / fragments are. It is discarded and rebuilt
// whenever the model id / revision / dimensions / pooling /
// prefix change, when the file is corrupt, or on explicit rebuild.
// A new memory only appends its vector; a full rebuild re-embeds
// from the log.
//
// Default is OFF (semanticRecall.enabled=false): disabled means
// the model is never loaded, the index is never read, and recall
// behaves exactly as 0.5.0. When enabled, the plugin awaits the
// semantic search with a strict timeout (default 3000 ms) and
// falls back to keyword-only on timeout or any error — recall
// never breaks on the semantic path.

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { atomicWriteText, backupCorruptFile } from "./atomic.ts";
import type { MemoryEntry } from "./types.ts";

/** The ONNX export repo the shipped files came from. */
export const SEMANTIC_MODEL_ID = "Xenova/bge-small-zh-v1.5";
/** Directory name the model is shipped under. */
export const SEMANTIC_MODEL_DIRNAME = "bge-small-zh-v1.5";

/** 0.5.4: locate the model bundled with the plugin, if any.
 *  Candidates, in order:
 *    <package>/dsh-plugin/models/bge-small-zh-v1.5  (the shipped copy)
 *    <package>/models/bge-small-zh-v1.5             (legacy layout)
 *    <core>/models/bge-small-zh-v1.5                (standalone core)
 *  No network: a missing model is reported as unavailable. */
/** 0.5.6: walk up from this module to the package root (the
 *  directory holding package.json). Works for both layouts:
 *  source  (<pkg>/core/src/semantic.ts)
 *  compiled (<pkg>/dist/core/src/semantic.js) */
export function findPackageRoot(): string | null {
  let dir = fileURLToPath(new URL(".", import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export function findBundledModelDir(): string | null {
  const here = fileURLToPath(new URL(".", import.meta.url)); // <pkg>/core/src/ or <pkg>/dist/core/src/
  const root = findPackageRoot();
  const candidates = [
    ...(root ? [join(root, "models", SEMANTIC_MODEL_DIRNAME)] : []),
    join(here, "..", "..", "models", SEMANTIC_MODEL_DIRNAME),
    // legacy: core still next to dsh-plugin (source layout used to be
    // memory-plugin/core/src, i.e. one more level down from the package)
    join(here, "..", "..", "..", "models", SEMANTIC_MODEL_DIRNAME),
  ];
  return candidates.find((d) => existsSync(join(d, "config.json"))) ?? null;
}
/** The base model the export was made from. */
export const SEMANTIC_BASE_MODEL_ID = "BAAI/bge-small-zh-v1.5";
/** Pinned 40-char commit SHA of the export repo (see MODELS.md). */
export const SEMANTIC_MODEL_REVISION =
  "75c43b069aac4d136ba6bc1122f995fedcfd2781";
export const SEMANTIC_DIMENSIONS = 512;
export const SEMANTIC_POOLING = "cls" as const;
/** BGE retrieval instruction, Chinese. Queries get it, documents
 *  do not — mixing that up makes the vectors incompatible with
 *  the index, which is why the prefix is part of the pinned
 *  identity (a changed prefix discards the index). */
export const SEMANTIC_QUERY_PREFIX =
  "为这个句子生成表示以用于检索相关文章：";
export const SEMANTIC_INDEX_FILE = "semantic-index.json";
export const SEMANTIC_INDEX_VERSION = 1;
/** v3 dtype for the shipped file (see header: no "quantized"). */
export const SEMANTIC_DTYPE = "int8" as const;
export const SEMANTIC_DEFAULT_TIMEOUT_MS = 3000;
export const SEMANTIC_DEFAULT_MAX_CANDIDATES = 50;
export const SEMANTIC_DEFAULT_MAX_ENTRIES = 10000;

/** 0.5.6: locate the runtime bundled with the plugin, if any.
 *  Returns the directory WHOSE `node_modules` holds the runtime (the
 *  same shape as a dataDir:
 *  `<dir>/node_modules/@huggingface/transformers`). Candidates:
 *    <package>/dsh-plugin/runtime  (the shipped copy)
 *    <package>/runtime             (packaged at the root)
 *  A GitHub/local install that ships the runtime therefore gets
 *  semantic recall on first launch with no npm step. */
export function findBundledRuntimeDir(): string | null {
  const here = fileURLToPath(new URL(".", import.meta.url)); // <pkg>/core/src/ or <pkg>/dist/core/src/
  const root = findPackageRoot();
  const candidates = [
    ...(root ? [join(root, "runtime")] : []),
    join(here, "..", "..", "runtime"),
    join(here, "..", "..", "..", "runtime"),
  ];
  return (
    candidates.find((d) =>
      existsSync(
        join(d, "node_modules", "@huggingface", "transformers", "package.json"),
      ),
    ) ?? null
  );
}

/** 终版 WP9: is the optional transformers runtime installed? Checks
 *  `<runtimeDir>/node_modules` first, then the normal import path.
 *  Never loads the module (no model, no network). */
export function hasTransformersRuntime(runtimeDir: string | null): boolean {
  if (runtimeDir) {
    try {
      createRequire(join(runtimeDir, "package.json")).resolve(
        "@huggingface/transformers",
      );
      return true;
    } catch {
      // Fall through to the package's own resolution.
    }
  }
  try {
    createRequire(import.meta.url).resolve("@huggingface/transformers");
    return true;
  } catch {
    return false;
  }
}

/** 终版 WP8: pick which entries get a vector when the index is built.
 *  Only persona chat entries (never task/greeting/candidate/hidden),
 *  capped at maxEntries; over the cap, keep the highest
 *  significance × recency. Pure — the caller supplies significance. */
export function selectSemanticEntriesForIndex(
  entries: MemoryEntry[],
  opts: {
    significanceOf: (entry: MemoryEntry) => number;
    maxEntries?: number;
    now?: number;
    isForgotten?: (id: string) => boolean;
  },
): MemoryEntry[] {
  const max = Math.max(1, Math.floor(opts.maxEntries ?? SEMANTIC_DEFAULT_MAX_ENTRIES));
  const now = opts.now ?? Date.now();
  const day = 24 * 60 * 60 * 1000;
  const scored: Array<{ entry: MemoryEntry; score: number }> = [];
  for (const entry of entries) {
    if (entry.window !== "persona") continue;
    if ((entry.kind ?? "persona") !== "persona") continue;
    if (entry.candidate === true) continue;
    if (opts.isForgotten?.(entry.id) === true) continue;
    const significance = opts.significanceOf(entry);
    const recency = Math.exp(-Math.max(0, now - entry.ts) / (30 * day));
    scored.push({ entry, score: significance * recency });
  }
  scored.sort((a, b) => b.score - a.score || b.entry.ts - a.entry.ts);
  return scored.slice(0, max).map((x) => x.entry);
}
/** Similarity floor for semantic candidates (0.5.1 item 2).
 *  Measured on core/test/semantic-benchmark.json (24 queries,
 *  real model): true answers score 0.436–0.802, but the top
 *  UNRELATED entry for a no-evidence query scores up to 0.476
 *  in this 20-entry corpus — so 0.3 lets every no-evidence query
 *  inject unrelated memories (6/6 false positives), while 0.5
 *  cuts them to 1/6 (the keyword baseline) at the cost of one
 *  answer (q02, 0.436). Overall MRR is higher at 0.5 (0.852)
 *  than at 0.3 (0.847), synonym MRR higher too (0.667 vs
 *  0.656) — precision wins over one more recall. The number is
 *  a default, not a law: it is a tuning knob
 *  (semanticRecall.minSimilarity), and a bigger real corpus
 *  would push unrelated tops down, so re-measure before
 *  lowering it. */
export const SEMANTIC_DEFAULT_MIN_SIMILARITY = 0.5;
/** Similarity floor for semantic candidates (0.5.1 item 2,
 *  found by the semantic benchmark): without it the searcher
 *  returns its top-N whatever the scores are, so a no-evidence
 *  query injects up to maxCandidates unrelated entries — the mock
 *  run showed 6/6 false positives before the floor existed. A
 *  bge-small-zh-v1.5 pair on the same fact scores ~0.5–0.8 and an
 *  unrelated pair ~0.15–0.35 in a big corpus, but in a 20-entry
 *  corpus unrelated tops reach 0.48, so the measured default is
 *  0.5 (see the constant above). Tuning knob:
 *  semanticRecall.minSimilarity. */

export interface EmbeddingProvider {
  readonly modelId: string;
  readonly dimensions: number;
  embed(texts: string[]): Promise<Float32Array[]>;
  close?(): Promise<void> | void;
}

export interface SemanticRetriever {
  readonly provider: EmbeddingProvider;
  search(
    query: string,
    candidates: MemoryEntry[],
    limit: number,
  ): Promise<Array<{ entry: MemoryEntry; similarity: number }>>;
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  // 0.5.2: a dimension mismatch is a bug in the index/model pair,
  // not something to silently truncate with Math.min.
  if (a.length !== b.length) {
    throw new Error(`vector dimensions differ: ${a.length} vs ${b.length}`);
  }
  const n = a.length;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!Number.isFinite(dot) || !Number.isFinite(na) || !Number.isFinite(nb)) {
    throw new Error("non-finite vector value");
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export function normalizeVector(v: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i];
  const norm = Math.sqrt(sum);
  if (norm === 0) return v;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / norm;
  return out;
}

/** A feature-extraction pipeline, lazily loaded. The import is
 *  dynamic on purpose: core has no hard dependency on
 *  @huggingface/transformers — a build without it still compiles
 *  and runs (semantic stays unavailable, keyword-only). */
type FeatureExtractionPipeline = (
  texts: string | string[],
  options?: { pooling?: string; normalize?: boolean },
) => Promise<{ tolist(): number[][] }>;

/** Load the optional runtime, preferring `<runtimeDir>/node_modules`.
 *  `createRequire(...).resolve` follows the package's exports map;
 *  the resolved file is then imported as ESM (transformers.js v3 is
 *  ESM). Fallback: a normal import, which works when the host put
 *  the dependency on the normal resolution path. */
async function loadTransformersModule(
  runtimeDir: string | null,
): Promise<typeof import("@huggingface/transformers")> {
  if (runtimeDir) {
    try {
      const req = createRequire(join(runtimeDir, "package.json"));
      const resolved = req.resolve("@huggingface/transformers");
      return (await import(pathToFileURL(resolved).href)) as typeof import("@huggingface/transformers");
    } catch {
      // fall through to the normal import
    }
  }
  return (await import("@huggingface/transformers")) as typeof import("@huggingface/transformers");
}

export class TransformersEmbeddingProvider implements EmbeddingProvider {  readonly modelId: string;
  readonly dimensions = SEMANTIC_DIMENSIONS;
  private readonly modelDir: string;
  private readonly modelRevision: string;
  private readonly runtimeDir: string | null;
  private extractor: FeatureExtractionPipeline | null = null;
  private loading: Promise<FeatureExtractionPipeline> | null = null;

  constructor(opts: {
    modelDir: string;
    modelId?: string;
    modelRevision?: string;
    /** 0.5.3: directory whose node_modules holds the optional
     *  runtime (`<dataDir>` by default). This closes the install
     *  chain without depending on how DSH lays out plugin folders:
     *  `npm install --prefix <dataDir> @huggingface/transformers@3.8.1`
     *  is enough, and the normal import is still tried as a fallback. */
    runtimeDir?: string;
  }) {
    this.modelDir = opts.modelDir;
    this.modelId = opts.modelId ?? SEMANTIC_MODEL_ID;
    this.modelRevision = opts.modelRevision ?? SEMANTIC_MODEL_REVISION;
    this.runtimeDir = opts.runtimeDir ?? null;
  }

  private async load(): Promise<FeatureExtractionPipeline> {
    if (this.extractor) return this.extractor;
    if (!this.loading) {
      this.loading = (async () => {
        if (!existsSync(join(this.modelDir, "config.json"))) {
          throw new Error(
            `semantic model not found in ${this.modelDir} (config.json missing) — copy the shipped models/bge-small-zh-v1.5/ directory to <dataDir>/models/bge-small-zh-v1.5/ first; no download happens at runtime`,
          );
        }
        const mod = await loadTransformersModule(this.runtimeDir);
        // createRequire().resolve follows the "require" export
        // condition, which points at the CJS bundle; import() wraps
        // it, so env/pipeline sit on `.default`. Use the namespace
        // when it already exposes env (ESM), else the CJS default.
        const tf = (
          (mod as { env?: unknown }).env
            ? mod
            : ((mod as { default?: unknown }).default ?? mod)
        ) as typeof import("@huggingface/transformers");
        // Local only: never silently download a model at runtime.
        tf.env.allowLocalModels = true;
        tf.env.allowRemoteModels = false;
        const ex = (await tf.pipeline("feature-extraction", this.modelDir, {
          dtype: SEMANTIC_DTYPE,
          revision: this.modelRevision,
        })) as unknown as FeatureExtractionPipeline & {
          dispose?: () => Promise<void>;
        };
        this.disposeFn = async () => {
          if (typeof ex.dispose === "function") await ex.dispose();
        };
        return ex as FeatureExtractionPipeline;
      })();
    }
    try {
      this.extractor = await this.loading;
      return this.extractor;
    } catch (err) {
      // 0.5.2: a failed first load must be retryable on the same
      // provider instance once the model/dependency is installed.
      this.loading = null;
      throw err;
    }
  }

  private disposeFn: (() => Promise<void>) | null = null;

  /** Embed documents (NO query prefix — see SEMANTIC_QUERY_PREFIX). */
  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const ex = await this.load();
    const out = await ex(texts, { pooling: SEMANTIC_POOLING, normalize: true });
    const rows = out.tolist();
    if (rows.length === 0 || rows[0].length !== this.dimensions) {
      throw new Error(
        `semantic model returned ${rows[0]?.length ?? 0} dimensions, expected ${this.dimensions} — the model in ${this.modelDir} does not match the pinned identity`,
      );
    }
    return rows.map((r) => Float32Array.from(r));
  }

  /** Embed one query (WITH the BGE instruction prefix). */
  async embedQuery(text: string): Promise<Float32Array> {
    const [v] = await this.embed([SEMANTIC_QUERY_PREFIX + text]);
    return v;
  }

  async close(): Promise<void> {
    if (this.disposeFn) {
      await this.disposeFn();
      this.disposeFn = null;
    }
    this.extractor = null;
    this.loading = null;
  }
}

export interface SemanticIndexJson {
  version: number;
  modelId: string;
  modelRevision: string;
  dimensions: number;
  pooling: string;
  queryPrefix: string;
  builtAt: number;
  entries: Array<{ id: string; vector: number[] }>;
}

export type SemanticIndexLoadStatus =
  | "loaded"
  | "empty"
  | "discarded-mismatch"
  | "discarded-corrupt";

/** The derived vector index. Loaded lazily; a mismatch or a
 *  corrupt file discards it (the caller rebuilds from the log —
 *  the index is never the source of truth). */
export class SemanticIndex {
  readonly dataDir: string;
  readonly modelId: string;
  readonly modelRevision: string;
  readonly dimensions: number;
  readonly pooling: string;
  readonly queryPrefix: string;
  private vectors = new Map<string, Float32Array>();
  builtAt = 0;

  constructor(opts: {
    dataDir: string;
    modelId?: string;
    modelRevision?: string;
    dimensions?: number;
    pooling?: string;
    queryPrefix?: string;
  }) {
    this.dataDir = opts.dataDir;
    this.modelId = opts.modelId ?? SEMANTIC_MODEL_ID;
    this.modelRevision = opts.modelRevision ?? SEMANTIC_MODEL_REVISION;
    this.dimensions = opts.dimensions ?? SEMANTIC_DIMENSIONS;
    this.pooling = opts.pooling ?? SEMANTIC_POOLING;
    this.queryPrefix = opts.queryPrefix ?? SEMANTIC_QUERY_PREFIX;
  }

  get size(): number {
    return this.vectors.size;
  }

  get(id: string): Float32Array | undefined {
    return this.vectors.get(id);
  }

  has(id: string): boolean {
    return this.vectors.has(id);
  }

  /** Load semantic-index.json. Returns why it was discarded when
   *  it does not match this identity — the caller rebuilds. */
  load(): SemanticIndexLoadStatus {
    // 0.5.2: a discard must leave an EMPTY index. Reusing an instance
    // that already held vectors used to keep stale ids after a
    // mismatch/corrupt load.
    this.vectors = new Map();
    this.builtAt = 0;
    const file = join(this.dataDir, SEMANTIC_INDEX_FILE);
    if (!existsSync(file)) return "empty";
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    } catch {
      backupCorruptFile(file, null);
      console.warn(
        `[memory-plugin] ${SEMANTIC_INDEX_FILE} 损坏，已备份，丢弃重建（索引是派生数据，原始记忆不受影响）。`,
      );
      return "discarded-corrupt";
    }
    const j = parsed as Partial<SemanticIndexJson>;
    const mismatch =
      j.version !== SEMANTIC_INDEX_VERSION ||
      j.modelId !== this.modelId ||
      j.modelRevision !== this.modelRevision ||
      j.dimensions !== this.dimensions ||
      j.pooling !== this.pooling ||
      j.queryPrefix !== this.queryPrefix ||
      !Array.isArray(j.entries);
    if (mismatch) {
      console.warn(
        `[memory-plugin] ${SEMANTIC_INDEX_FILE} 与当前模型身份不符（模型/版本/维度/池化/前缀变了），丢弃重建。`,
      );
      return "discarded-mismatch";
    }
    const vectors = new Map<string, Float32Array>();
    for (const row of (j.entries as SemanticIndexJson["entries"])) {
      if (
        typeof row.id !== "string" ||
        !Array.isArray(row.vector) ||
        row.vector.length !== this.dimensions
      ) {
        console.warn(
          `[memory-plugin] ${SEMANTIC_INDEX_FILE} 有维度不对的行（${row.id}），整份索引丢弃重建。`,
        );
        return "discarded-mismatch";
      }
      vectors.set(row.id, Float32Array.from(row.vector));
    }
    this.vectors = vectors;
    this.builtAt = typeof j.builtAt === "number" ? j.builtAt : 0;
    return "loaded";
  }

  save(): void {
    const json: SemanticIndexJson = {
      version: SEMANTIC_INDEX_VERSION,
      modelId: this.modelId,
      modelRevision: this.modelRevision,
      dimensions: this.dimensions,
      pooling: this.pooling,
      queryPrefix: this.queryPrefix,
      builtAt: this.builtAt,
      entries: [...this.vectors.entries()].map(([id, v]) => ({
        id,
        vector: [...v],
      })),
    };
    atomicWriteText(join(this.dataDir, SEMANTIC_INDEX_FILE), JSON.stringify(json));
  }

  upsert(id: string, vector: Float32Array): void {
    this.vectors.set(id, vector);
  }

  removeIds(ids: string[]): number {
    let n = 0;
    for (const id of ids) {
      if (this.vectors.delete(id)) n += 1;
    }
    return n;
  }

  /** 0.5.2: empty the in-memory index before a full rebuild. */
  clear(): void {
    this.vectors = new Map();
    this.builtAt = 0;
  }

  /** Top-N entries by cosine similarity to the query vector.
   *  Only ids present in the index are returned. */
  search(
    queryVector: Float32Array,
    limit: number,
    allowedIds?: Set<string>,
  ): Array<{ id: string; similarity: number }> {
    const scored: Array<{ id: string; similarity: number }> = [];
    for (const [id, v] of this.vectors) {
      // 0.5.2: filter BEFORE ranking. Taking the global top-N and
      // only then dropping task/non-persona ids could let task
      // vectors crowd every persona hit out of the list.
      if (allowedIds && !allowedIds.has(id)) continue;
      scored.push({ id, similarity: cosineSimilarity(queryVector, v) });
    }
    scored.sort((a, b) => b.similarity - a.similarity);
    return scored.slice(0, Math.max(0, limit));
  }
}

/** Async semantic search over the index (plan §3.1): embed the
 *  query, rank the indexed vectors, return the matching entries
 *  with similarities. Pure — it never touches the keyword path. */
export class SemanticSearcher implements SemanticRetriever {
  readonly provider: EmbeddingProvider;
  private readonly index: SemanticIndex;

  constructor(provider: EmbeddingProvider, index: SemanticIndex) {
    this.provider = provider;
    this.index = index;
  }

  async search(
    query: string,
    candidates: MemoryEntry[],
    limit: number,
  ): Promise<Array<{ entry: MemoryEntry; similarity: number }>> {
    const provider = this.provider as TransformersEmbeddingProvider;
    const queryVector =
      typeof provider.embedQuery === "function"
        ? await provider.embedQuery(query)
        : (await provider.embed([SEMANTIC_QUERY_PREFIX + query]))[0];
    const byId = new Map(candidates.map((e) => [e.id, e]));
    const out: Array<{ entry: MemoryEntry; similarity: number }> = [];
    for (const hit of this.index.search(queryVector, limit, new Set(byId.keys()))) {
      const entry = byId.get(hit.id);
      if (!entry) continue;
      out.push({ entry, similarity: hit.similarity });
    }
    return out;
  }
}

/** Embed one batch of entry texts and put the vectors into the
 *  index (build / rebuild path). Batches of 16 keep a 10k-memory
 *  rebuild bounded; a batch failure aborts the rebuild loudly —
 *  a half-built index is never saved (the caller saves only on
 *  success). */
export async function buildSemanticIndex(
  provider: EmbeddingProvider,
  index: SemanticIndex,
  entries: MemoryEntry[],
  batchSize = 16,
): Promise<number> {
  const texts = entries.map((e) => e.text);
  // 0.5.2: a rebuild replaces the index, it does not merge into it.
  index.clear();
  let done = 0;
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const vectors = await provider.embed(batch);
    for (let j = 0; j < batch.length; j++) {
      index.upsert(entries[i + j].id, vectors[j]);
    }
    done += batch.length;
  }
  index.builtAt = Date.now();
  return done;
}

/** The async call site (plan §5): embed the query and rank the
 *  index, with a strict timeout. Returns candidate ids best-first,
 *  keeping only hits at or above `minSimilarity` (default 0.5 —
 *  see SEMANTIC_DEFAULT_MIN_SIMILARITY: without the floor the
 *  top-N comes back whatever the scores are, and a no-evidence
 *  query injects unrelated entries).
 *  Timeout, empty index, missing model, inference error — all
 *  return [] (keyword-only fallback). Never throws. */
export async function semanticCandidateIds(opts: {
  searcher: SemanticRetriever;
  query: string;
  candidates: MemoryEntry[];
  timeoutMs?: number;
  maxCandidates?: number;
  minSimilarity?: number;
}): Promise<string[]> {
  const timeoutMs = opts.timeoutMs ?? SEMANTIC_DEFAULT_TIMEOUT_MS;
  const maxCandidates = opts.maxCandidates ?? SEMANTIC_DEFAULT_MAX_CANDIDATES;
  const minSimilarity = opts.minSimilarity ?? SEMANTIC_DEFAULT_MIN_SIMILARITY;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const run = opts.searcher.search(
      opts.query,
      opts.candidates,
      maxCandidates,
    );
    const hits = await Promise.race([
      run,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
    if (hits === null) return [];
    return hits
      .filter((h) => h.similarity >= minSimilarity)
      .map((h) => h.entry.id);
  } catch {
    return [];
  } finally {
    // 0.5.2: do not leave the timeout timer alive after a fast hit.
    if (timer !== undefined) clearTimeout(timer);
  }
}
