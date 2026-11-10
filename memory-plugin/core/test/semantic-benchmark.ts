// Semantic-recall benchmark (0.5.1 item 2) — keyword vs hybrid on
// core/test/semantic-benchmark.json (24 queries, 4 classes).
//
//   node test/semantic-benchmark.ts              mock embedding
//     (hashed bag-of-words — pipeline/fusion check ONLY; it cannot
//     show semantic gains, and its numbers must never be quoted
//     as "semantic is better")
//   node test/semantic-benchmark.ts --real       real model
//     (bge-small-zh-v1.5; model dir from --modelDir, the
//     SEMANTIC_MODEL_DIR env var, <package>/models/bge-small-zh-v1.5,
//     or ~/workspace/tmp-push/models/bge-small-zh-v1.5; missing
//     model reports "真实模型未验证" and exits 0 — a measurement
//     script, not an assertion)
//   node test/semantic-benchmark.ts --json       machine output
//
// The acceptance question is only answered by the --real run:
// synonym-class Recall@5 / MRR must be quantifiably above the
// keyword run, and the time/conflict/no-evidence classes must not
// regress. The mock run only proves the fusion path works.
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MemoryCore,
  buildSemanticIndex,
  normalizeVector,
  SemanticIndex,
  SemanticSearcher,
  SEMANTIC_DIMENSIONS,
  SEMANTIC_MODEL_ID,
  SEMANTIC_DEFAULT_MIN_SIMILARITY,
  type EmbeddingProvider,
  type MemoryEntry,
} from "../src/index.ts";

const DAY_MS = 86_400_000;

interface BenchMemory {
  key: string;
  role: "user" | "assistant";
  text: string;
  importance: "heavy" | "light";
  daysAgo: number;
  factKey?: string;
}

interface BenchQuery {
  id: string;
  category: string;
  query: string;
  expect: string | null;
}

interface BenchData {
  memories: BenchMemory[];
  queries: BenchQuery[];
}

interface PerQuery {
  id: string;
  category: string;
  kwRank: number | null;
  hyRank: number | null;
  kwHits: number;
  hyHits: number;
  kwTokens: number;
  hyTokens: number;
  kwMs: number;
  hyMs: number;
  /** Real mode only: top semantic similarity for this query
   *  (judges the minSimilarity floor — if the true answer scores
   *  below it, the floor is wrong, not the model). */
  hyTopSim: number | null;
}

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Mock embedding (pipeline check only): hashed bag-of-words.
 *  Each bigram/single char maps to a fixed pseudo-random unit
 *  vector (seeded by its hash); a text is the normalized sum.
 *  Texts sharing tokens are similar; paraphrases sharing no token
 *  are orthogonal. This is NOT semantic — it only proves the
 *  hybrid fusion path runs end to end. */
class MockEmbeddingProvider implements EmbeddingProvider {
  readonly modelId = "mock-hashed-bow";
  readonly dimensions = SEMANTIC_DIMENSIONS;

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((text) => {
      const out = new Float32Array(SEMANTIC_DIMENSIONS);
      const tokens = new Set<string>();
      for (let i = 0; i < text.length; i++) {
        tokens.add(text[i]);
        if (i + 1 < text.length) tokens.add(text.slice(i, i + 2));
      }
      for (const tok of tokens) {
        const rand = mulberry32(hashString(tok));
        for (let d = 0; d < SEMANTIC_DIMENSIONS; d++) {
          out[d] += rand() - 0.5;
        }
      }
      return normalizeVector(out);
    });
  }
}

function summarize(rows: PerQuery[], mode: "kw" | "hy") {
  // Every row is a query with an expected answer; rank null is a
  // miss (counts in n, adds 0 to MRR). No-evidence queries are
  // filtered out by the caller.
  const byCat = new Map<string, { n: number; hit: number; mrr: number }>();
  let hit = 0;
  let mrrSum = 0;
  const n = rows.length;
  for (const r of rows) {
    const rank = mode === "kw" ? r.kwRank : r.hyRank;
    if (rank !== null && rank <= 5) hit += 1;
    mrrSum += rank === null ? 0 : 1 / rank;
    const cat = r.category;
    const c = byCat.get(cat) ?? { n: 0, hit: 0, mrr: 0 };
    c.n += 1;
    if (rank !== null && rank <= 5) c.hit += 1;
    c.mrr += rank === null ? 0 : 1 / rank;
    byCat.set(cat, c);
  }
  for (const c of byCat.values()) c.mrr = c.n === 0 ? 0 : c.mrr / c.n;
  return {
    n,
    recallAt5: n === 0 ? 0 : hit / n,
    mrr: n === 0 ? 0 : mrrSum / n,
    byCategory: Object.fromEntries(byCat),
  };
}

export interface SemanticBenchmarkResult {
  mode: "mock" | "real";
  modelId: string;
  modelDir: string | null;
  keyword: ReturnType<typeof summarize>;
  hybrid: ReturnType<typeof summarize>;
  noEvidenceFalsePositives: { keyword: number; hybrid: number; total: number };
  perQuery: PerQuery[];
  avgMs: { keyword: number; hybrid: number };
}

export async function runSemanticBenchmark(opts: {
  real: boolean;
  modelDir?: string;
  json?: boolean;
  /** Override the similarity floor (default: the core default).
   *  Experiment knob only — the shipped default is the constant
   *  in semantic.ts, measured on this benchmark (see the report). */
  minSimilarity?: number;
}): Promise<SemanticBenchmarkResult | null> {
  const here = dirname(fileURLToPath(import.meta.url));
  const data = JSON.parse(
    readFileSync(join(here, "semantic-benchmark.json"), "utf8"),
  ) as BenchData;
  const now = Date.now();
  const modelDir =
    opts.modelDir ??
    process.env.SEMANTIC_MODEL_DIR ??
    resolve(here, "..", "..", "dsh-plugin", "models", "bge-small-zh-v1.5") ??
    resolve(here, "..", "..", "models", "bge-small-zh-v1.5") ??
    join(process.env.HOME ?? "", "workspace", "tmp-push", "models", "bge-small-zh-v1.5");

  let core: MemoryCore;
  let modelId = "mock-hashed-bow";
  let effectiveModelDir: string | null = null;
  if (opts.real) {
    const candidates = [
      opts.modelDir,
      process.env.SEMANTIC_MODEL_DIR,
      resolve(here, "..", "..", "dsh-plugin", "models", "bge-small-zh-v1.5"),
      resolve(here, "..", "..", "models", "bge-small-zh-v1.5"),
      join(process.env.HOME ?? "", "workspace", "tmp-push", "models", "bge-small-zh-v1.5"),
    ].filter((d): d is string => typeof d === "string" && d.length > 0);
    const found = candidates.find((d) => existsSync(join(d, "config.json")));
    if (!found) {
      console.log(
        "真实模型未验证：模型目录不存在（找过：" +
          candidates.join("、") +
          "）。完整包应自带 dsh-plugin/models/；nomodel 包请按 MODELS.md 自行准备模型。",
      );
      return null;
    }
    effectiveModelDir = found;
    modelId = SEMANTIC_MODEL_ID;
    core = new MemoryCore({
      dataDir: mkdtempSync(join(tmpdir(), "semantic-bench-")),
      semanticRecall: {
        enabled: true,
        modelDir: found,
        ...(opts.minSimilarity !== undefined
          ? { minSimilarity: opts.minSimilarity }
          : {}),
      },
    });
  } else {
    core = new MemoryCore({
      dataDir: mkdtempSync(join(tmpdir(), "semantic-bench-")),
    });
  }

  // ---- seed (same wiring as benchmark-050: fact chain links) ----
  const entries: MemoryEntry[] = [];
  const idByKey = new Map<string, string>();
  const supersedesByKey = new Map<string, string>();
  for (const m of data.memories) {
    const e = core.record({
      role: m.role,
      text: m.text,
      window: "persona",
      importance: m.importance,
      sessionId: "bench",
      ts: now - m.daysAgo * DAY_MS,
      ...(m.factKey !== undefined ? { factKey: m.factKey } : {}),
      ...(m.factKey !== undefined && supersedesByKey.has(m.factKey)
        ? { supersedes: supersedesByKey.get(m.factKey) as string }
        : {}),
    });
    entries.push(e);
    idByKey.set(m.key, e.id);
    if (m.factKey !== undefined) supersedesByKey.set(m.factKey, e.id);
  }

  // ---- build the semantic index (real: core; mock: manual) ----
  let searcher: SemanticSearcher | null = null;
  if (opts.real) {
    const built = await core.ensureSemanticIndex();
    if (built.status !== "loaded" && built.built === 0) {
      console.log("真实模型未验证：语义索引未能建立（status=" + built.status + "）。");
      return null;
    }
  } else {
    const mock = new MockEmbeddingProvider();
    const index = new SemanticIndex({
      dataDir: core.dataDir,
      modelId: mock.modelId,
      modelRevision: "mock",
      dimensions: SEMANTIC_DIMENSIONS,
      pooling: "cls",
      queryPrefix: "",
    });
    await buildSemanticIndex(mock, index, entries);
    index.save();
    searcher = new SemanticSearcher(mock, index);
  }

  // ---- run both modes over the same queries ----
  const perQuery: PerQuery[] = [];
  for (const q of data.queries) {
    const t0 = performance.now();
    const kw = core.recall(q.query, { window: "persona", limit: 5, tokenCap: 1500 });
    const kwMs = performance.now() - t0;
    const kwRank =
      q.expect === null
        ? null
        : (() => {
            const idx = kw.hits.findIndex((h) => h.entry.id === idByKey.get(q.expect as string));
            return idx === -1 ? null : idx + 1;
          })();

    const t1 = performance.now();
    let hyIds: string[];
    let hyTopSim: number | null = null;
    // One search call per query: similarities ride along so
    // recall scores semantic-only hits by similarity (0.5.1
    // item 2), filtered by the same 0.3 floor the core uses.
    let simById = new Map<string, number>();
    if (opts.real) {
      const searchHits = await core.semanticSearch(q.query, entries, 50);
      hyTopSim = searchHits.length > 0 ? searchHits[0].similarity : null;
      const kept = searchHits.filter(
        (h) => h.similarity >= core.semanticMinSimilarity(),
      );
      hyIds = kept.map((h) => h.id);
      simById = new Map(kept.map((h) => [h.id, h.similarity]));
    } else {
      const searchHits = await (searcher as SemanticSearcher).search(
        q.query,
        entries,
        50,
      );
      const kept = searchHits.filter(
        (h) => h.similarity >= SEMANTIC_DEFAULT_MIN_SIMILARITY,
      );
      hyIds = kept.map((h) => h.entry.id);
      simById = new Map(kept.map((h) => [h.entry.id, h.similarity]));
    }
    const adapter = {
      kind: "semantic" as const,
      retrieveIds: () => hyIds,
      similarityOf: (id: string) => simById.get(id),
    };
    const hy = core.recall(q.query, {
      window: "persona",
      limit: 5,
      tokenCap: 1500,
      semantic: adapter,
    });
    const hyMs = performance.now() - t1;
    const hyRank =
      q.expect === null
        ? null
        : (() => {
            const idx = hy.hits.findIndex((h) => h.entry.id === idByKey.get(q.expect as string));
            return idx === -1 ? null : idx + 1;
          })();
    perQuery.push({
      id: q.id,
      category: q.category,
      kwRank,
      hyRank,
      kwHits: kw.hits.length,
      hyHits: hy.hits.length,
      kwTokens: kw.estimatedTokens,
      hyTokens: hy.estimatedTokens,
      kwMs: Math.round(kwMs * 100) / 100,
      hyMs: Math.round(hyMs * 100) / 100,
      hyTopSim,
    });
  }

  // Recall stats count only queries with an expected answer;
  // no-evidence queries are the false-positive count.
  const retrievable = perQuery.filter((r) => {
    const q = data.queries.find((x) => x.id === r.id);
    return q !== undefined && q.expect !== null;
  });
  const noEvidence = perQuery.filter((r) => {
    const q = data.queries.find((x) => x.id === r.id);
    return q !== undefined && q.expect === null;
  });
  const keyword = summarize(retrievable, "kw");
  const hybrid = summarize(retrievable, "hy");
  const result: SemanticBenchmarkResult = {
    mode: opts.real ? "real" : "mock",
    modelId,
    modelDir: effectiveModelDir,
    keyword,
    hybrid,
    noEvidenceFalsePositives: {
      keyword: noEvidence.filter((r) => r.kwHits > 0).length,
      hybrid: noEvidence.filter((r) => r.hyHits > 0).length,
      total: noEvidence.length,
    },
    perQuery,
    avgMs: {
      keyword:
        perQuery.reduce((s, r) => s + r.kwMs, 0) / Math.max(1, perQuery.length),
      hybrid: perQuery.reduce((s, r) => s + r.hyMs, 0) / Math.max(1, perQuery.length),
    },
  };

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const tag = opts.real ? "真实模型 " + modelId : "mock 向量（仅接口融合检查）";
    console.log("语义基准（" + tag + "）—— 关键词 vs 混合");
    const fmt = (s: ReturnType<typeof summarize>) =>
      "Recall@5=" + s.recallAt5.toFixed(3) + " MRR=" + s.mrr.toFixed(3);
    console.log("  关键词： " + fmt(keyword));
    console.log("  混合：   " + fmt(hybrid));
    for (const [cat, c] of Object.entries(keyword.byCategory)) {
      const h = hybrid.byCategory[cat] as { n: number; hit: number; mrr: number };
      console.log(
        "  " + cat + ": n=" + c.n +
          " 关键词 R@5=" + (c.hit / c.n).toFixed(3) + " MRR=" + c.mrr.toFixed(3) +
          " ｜ 混合 R@5=" + (h.hit / h.n).toFixed(3) + " MRR=" + h.mrr.toFixed(3),
      );
    }
    console.log(
      "  无证据误召：关键词 " + result.noEvidenceFalsePositives.keyword + "/" +
        result.noEvidenceFalsePositives.total + " ｜ 混合 " +
        result.noEvidenceFalsePositives.hybrid + "/" + result.noEvidenceFalsePositives.total,
    );
    console.log(
      "  平均耗时：关键词 " + result.avgMs.keyword.toFixed(2) + "ms ｜ 混合 " +
        result.avgMs.hybrid.toFixed(2) + "ms",
    );
    console.log("  逐条：");
    for (const r of perQuery) {
      console.log(
        "    " + r.id + " " + r.category + " 关键词 rank=" +
          (r.kwRank === null ? "-" : r.kwRank) + " 混合 rank=" +
          (r.hyRank === null ? "-" : r.hyRank) +
          (r.hyTopSim !== null ? " topSim=" + r.hyTopSim.toFixed(3) : ""),
      );
    }
  }
  return result;
}

const isMain = process.argv[1]?.endsWith("semantic-benchmark.ts") ?? false;
if (isMain) {
  const real = process.argv.includes("--real");
  const json = process.argv.includes("--json");
  const modelDirFlag = process.argv.indexOf("--modelDir");
  const modelDir =
    modelDirFlag >= 0 ? process.argv[modelDirFlag + 1] : undefined;
  const minSimFlag = process.argv.indexOf("--minSimilarity");
  const minSimilarity =
    minSimFlag >= 0 ? Number(process.argv[minSimFlag + 1]) : undefined;
  await runSemanticBenchmark({ real, modelDir, json, minSimilarity });
}
