// 0.5.0 基准集评测：对 benchmark-050.json 重跑召回，输出
// 记录覆盖率、Recall@5、MRR、注入 token、延迟。
// 用法：node test/benchmark-050.ts [--json] [--data <path>] [--rewrite]
// --rewrite: 用测试专用的同义扩写桩（确定性同义词表，不是模型，
// 也不是 embedding）给每条查询加改写词，再跑一次，量改写版相对
// 关键词版的收益。桩只扩写，不改写原意，不碰无证据类。
// 固定用 MemoryCore.record + core.recall（limit 5, tokenCap 1500，
// persona 窗口）走真实路径；覆盖率用 dsh-plugin 的
// shouldMarkPersona 模拟开场白标记门（与真机同一判定）。
// 退出码永远 0（这是测量，不是断言）；数字以 stdout 的 JSON 为准。

import { readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MemoryCore } from "../src/index.ts";
import { shouldMarkPersona } from "../../dsh-plugin/src/index.ts";

interface BenchMemory {
  key: string;
  role: "user" | "assistant";
  text: string;
  importance: "heavy" | "light";
  daysAgo: number;
  /** 0.5.1 item 1: fact identity — entries sharing a factKey are
   *  versions of one fact (the newest is current). */
  factKey?: string;
}
interface BenchQuery {
  id: string;
  category: "synonym" | "time" | "conflict" | "no-evidence";
  query: string;
  expect: string | null;
}
interface BenchCoverageSession {
  id: string;
  turns: string[];
  expectedRecorded: number;
}
interface BenchData {
  version: string;
  memories: BenchMemory[];
  queries: BenchQuery[];
  coverage: { sessions: BenchCoverageSession[] };
}

const args = process.argv.slice(2);
const jsonOnly = args.includes("--json");
const useRewrite = args.includes("--rewrite");
const dataIdx = args.indexOf("--data");
const dataPath =
  dataIdx >= 0 && args[dataIdx + 1]
    ? args[dataIdx + 1]
    : join(
        fileURLToPath(new URL(".", import.meta.url)),
        "benchmark-050.json",
      );
const data = JSON.parse(readFileSync(dataPath, "utf8")) as BenchData;

const DAY_MS = 86_400_000;
const now = Date.now();
const dir = mkdtempSync(join(tmpdir(), "memory-plugin-bench050-"));
const core = new MemoryCore({ dataDir: dir });

// ---- 记下全部基准记忆（固定 session，便于复现）----
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
    // 0.5.1 item 1: a newer version of the same fact supersedes
    // the older one — the chain is factKey + ts order, and this
    // explicit link is the audit trail.
    ...(m.factKey !== undefined && supersedesByKey.has(m.factKey)
      ? { supersedes: supersedesByKey.get(m.factKey) as string }
      : {}),
  });
  idByKey.set(m.key, e.id);
  if (m.factKey !== undefined) supersedesByKey.set(m.factKey, e.id);
}

// ---- 0.5.0 step 5: 测试专用的同义扩写桩 -------------------------
// 确定性同义词表（不是模型、不是 embedding）：查询里出现触发词
// 就追加对应的原文词。无证据类查询没有触发词，故意不扩写 ——
// 改写绝不能把没证据的问题改写成有证据。
const REWRITE_MAP: Array<[string, string]> = [
  ["酸酸甜甜", "酸梅汤"],
  ["检查", "查岗"],
  ["绿色", "香菜"],
  ["胖猫", "橘猫 团团"],
  ["天气现象", "打雷 雷声"],
  ["咖啡", "美式"],
];
function mockRewrite(query: string): string | undefined {
  const adds: string[] = [];
  for (const [trigger, expansion] of REWRITE_MAP) {
    if (query.includes(trigger)) adds.push(expansion);
  }
  return adds.length > 0 ? `${query} ${adds.join(" ")}` : undefined;
}

// ---- 逐条查询：排名 / token / 延迟 ----
interface PerQuery {
  id: string;
  category: string;
  query: string;
  expect: string | null;
  rank: number | null;
  hits: number;
  tokens: number;
  ms: number;
}
const perQuery: PerQuery[] = [];
for (const q of data.queries) {
  const t0 = performance.now();
  const result = core.recall(q.query, {
    window: "persona",
    limit: 5,
    tokenCap: 1500,
    rewrittenQuery: useRewrite ? mockRewrite(q.query) : undefined,
  });
  const ms = performance.now() - t0;
  const rank =
    q.expect === null
      ? null
      : (() => {
          const idx = result.hits.findIndex(
            (h) => h.entry.id === idByKey.get(q.expect as string),
          );
          return idx === -1 ? null : idx + 1;
        })();
  perQuery.push({
    id: q.id,
    category: q.category,
    query: q.query,
    expect: q.expect,
    rank,
    hits: result.hits.length,
    tokens: result.estimatedTokens,
    ms: Math.round(ms * 100) / 100,
  });
}

// ---- 汇总：可召回类（同义/时间/冲突）算 Recall@5 + MRR ----
const retrievable = perQuery.filter((p) => p.expect !== null);
const hitAt5 = retrievable.filter(
  (p) => p.rank !== null && (p.rank as number) <= 5,
).length;
const recallAt5 = retrievable.length === 0 ? 0 : hitAt5 / retrievable.length;
const mrr =
  retrievable.length === 0
    ? 0
    : retrievable.reduce(
        (s, p) => s + (p.rank === null ? 0 : 1 / (p.rank as number)),
        0,
      ) / retrievable.length;
const byCategory: Record<string, { n: number; hit: number; mrr: number }> = {};
for (const p of retrievable) {
  const c = byCategory[p.category] ?? { n: 0, hit: 0, mrr: 0 };
  c.n += 1;
  if (p.rank !== null && p.rank <= 5) c.hit += 1;
  c.mrr += p.rank === null ? 0 : 1 / p.rank;
  byCategory[p.category] = c;
}
for (const c of Object.values(byCategory)) c.mrr = c.n === 0 ? 0 : c.mrr / c.n;
const noEvidence = perQuery.filter((p) => p.expect === null);
const noEvidenceFp =
  noEvidence.length === 0
    ? 0
    : noEvidence.filter((p) => p.hits > 0).length / noEvidence.length;
const avgTokens =
  perQuery.length === 0
    ? 0
    : perQuery.reduce((s, p) => s + p.tokens, 0) / perQuery.length;
const latencies = perQuery.map((p) => p.ms).sort((a, b) => a - b);
const avgMs =
  latencies.length === 0
    ? 0
    : latencies.reduce((s, v) => s + v, 0) / latencies.length;
const p95Ms =
  latencies.length === 0
    ? 0
    : latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))];

// ---- 记录覆盖率：开场白标记门模拟 ----
let totalTurns = 0;
let recordedTurns = 0;
const coveragePerSession: Array<{
  id: string;
  turns: number;
  recorded: number;
  expected: number;
}> = [];
for (const s of data.coverage.sessions) {
  let marked = false;
  let recorded = 0;
  for (const turn of s.turns) {
    if (!marked && shouldMarkPersona(turn)) marked = true;
    if (marked) recorded += 1;
  }
  totalTurns += s.turns.length;
  recordedTurns += recorded;
  coveragePerSession.push({
    id: s.id,
    turns: s.turns.length,
    recorded,
    expected: s.expectedRecorded,
  });
}
const coverage = totalTurns === 0 ? 0 : recordedTurns / totalTurns;

const summary = {
  dataset: data.version,
  mode: useRewrite ? "rewrite-mock" : "keyword-only",
  dataDir: dir,
  queries: perQuery.length,
  retrievable: retrievable.length,
  coverage: Math.round(coverage * 1000) / 1000,
  coverageDetail: coveragePerSession,
  recallAt5: Math.round(recallAt5 * 1000) / 1000,
  mrr: Math.round(mrr * 1000) / 1000,
  byCategory: Object.fromEntries(
    Object.entries(byCategory).map(([k, c]) => [
      k,
      {
        n: c.n,
        recallAt5: c.n === 0 ? 0 : Math.round((c.hit / c.n) * 1000) / 1000,
        mrr: Math.round(c.mrr * 1000) / 1000,
      },
    ]),
  ),
  noEvidenceQueries: noEvidence.length,
  noEvidenceFalsePositiveRate: Math.round(noEvidenceFp * 1000) / 1000,
  avgInjectedTokens: Math.round(avgTokens * 10) / 10,
  avgLatencyMs: Math.round(avgMs * 100) / 100,
  p95LatencyMs: p95Ms,
  perQuery,
};

if (jsonOnly) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log(`benchmark ${summary.dataset} [${summary.mode}] (${summary.queries} 条查询，${summary.retrievable} 条可召回）`);
  console.log(`记录覆盖率: ${summary.coverage} (${recordedTurns}/${totalTurns} 句）`);
  for (const s of coveragePerSession) {
    console.log(
      `  ${s.id}: ${s.recorded}/${s.turns} 句（期望 ${s.expected}）${s.recorded === s.expected ? "" : " ← 与期望不符"}`,
    );
  }
  console.log(`Recall@5: ${summary.recallAt5}  MRR: ${summary.mrr}`);
  for (const [k, c] of Object.entries(summary.byCategory)) {
    console.log(`  ${k}: n=${c.n} Recall@5=${c.recallAt5} MRR=${c.mrr}`);
  }
  console.log(
    `无证据误召率: ${summary.noEvidenceFalsePositiveRate} (${noEvidence.filter((p) => p.hits > 0).length}/${noEvidence.length} 条误召）`,
  );
  console.log(
    `注入 token 均值: ${summary.avgInjectedTokens}  延迟均值: ${summary.avgLatencyMs}ms  p95: ${summary.p95LatencyMs}ms`,
  );
  console.log(JSON.stringify(summary, null, 2));
}
