// 终版 WP10 — 48-case regression eval.
//
// Run: node test/eval-048.ts [--json] [--verbose]
//
// Controlled fixtures in a temp data dir; no real memory is touched.
// 48 cases: extraction 10, cross-session 8, time 8, conflict 8,
// refusal 6, delete residual 4, task leakage 4.
//
// Metrics: Recall@5, MRR, false-positive rate (refusal queries),
// delete residual rate, stale-fact error rate (present-tense),
// task-content leakage rate (must be 0). Exit 1 on any failed case.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryCore } from "../src/index.ts";

const args = new Set(process.argv.slice(2));
const asJson = args.has("--json");
const verbose = args.has("--verbose");

interface EvalCase {
  id: string;
  category:
    | "extraction"
    | "cross-session"
    | "time"
    | "conflict"
    | "refusal"
    | "delete"
    | "task";
  query: string;
  expectId?: string;
  expectNoHits?: boolean;
  /** present-tense fact case: top1 must be this id (stale check). */
  expectTop1?: string;
}

interface CaseResult extends EvalCase {
  ok: boolean;
  rank: number | null;
  hits: number;
  top1: string | null;
}

const dir = mkdtempSync(join(tmpdir(), "memory-eval-048-"));
const core = new MemoryCore({ dataDir: dir });
const cases: EvalCase[] = [];
let ts = Date.now() - 10_000_000;

const add = (
  id: string,
  text: string,
  extra: Record<string, unknown> = {},
): string => {
  ts += 1000;
  return core.record({
    role: "user",
    text,
    sessionId: "s-main",
    ts,
    ...extra,
  }).id;
};

// ---- extraction: 10 ----
const extractionPhrases = [
  "蓝莓蛋糕",
  "摩天轮",
  "奖学金",
  "海边散步",
  "围巾",
  "口琴",
  "猫粮",
  "电影票",
  "火锅",
  "酸梅汤",
];
for (let i = 0; i < extractionPhrases.length; i += 1) {
  const phrase = extractionPhrases[i];
  const id = add(`ex-${i}`, `提取${i + 1} 提到${phrase}，仅此一条`);
  cases.push({
    id: `ex-${i}`,
    category: "extraction",
    query: phrase,
    expectId: id,
    expectTop1: id,
  });
}

// ---- cross-session: 8 ----
const crossWords = ["灯塔", "帆船", "山谷", "银河", "沙漠", "森林", "岛屿", "草原"];
for (let i = 0; i < crossWords.length; i += 1) {
  const word = crossWords[i];
  const id = add(`cs-${i}`, `${word} 只在会话${i % 2} 出现`, {
    sessionId: `s-${i % 2}`,
  });
  cases.push({
    id: `cs-${i}`,
    category: "cross-session",
    query: word,
    expectId: id,
    expectTop1: id,
  });
}

// ---- time: 4 pairs = 8 ----
const in2020 = Date.parse("2020-01-01T00:00:00+08:00");
const in2024 = Date.parse("2024-01-01T00:00:00+08:00");
const roads = ["青禾路", "白沙街", "枫林巷", "望江道"];
for (let i = 0; i < roads.length; i += 1) {
  const road = roads[i];
  const factKey = `${road}住哪`;
  const oldId = add(`tm-${i}-old`, `${road} 住甲区`, {
    factKey,
    validFrom: in2020,
  });
  const newId = add(`tm-${i}-new`, `${road} 住乙区`, {
    factKey,
    validFrom: in2024,
  });
  cases.push({
    id: `tm-${i}-present`,
    category: "time",
    query: road,
    expectId: newId,
    expectTop1: newId,
  });
  cases.push({
    id: `tm-${i}-history`,
    category: "time",
    query: `${road} 以前`,
    expectId: oldId,
  });
}

// ---- conflict: 4 pairs = 8 ----
const conflictTags = ["红桥", "蓝湾", "金谷", "绿洲"];
for (let i = 0; i < conflictTags.length; i += 1) {
  const tag = conflictTags[i];
  const factKey = `${tag}住哪`;
  const oldId = add(`cf-${i}-old`, `${tag} 以前住丁区`, { factKey });
  const newId = add(`cf-${i}-new`, `${tag} 现在住丙区`, {
    factKey,
    supersedes: oldId,
  });
  cases.push({
    id: `cf-${i}-present`,
    category: "conflict",
    query: tag,
    expectId: newId,
    expectTop1: newId,
  });
  cases.push({
    id: `cf-${i}-history`,
    category: "conflict",
    query: `${tag} 以前`,
    expectId: oldId,
  });
}

// ---- refusal: 6 ----
for (let i = 0; i < 6; i += 1) {
  cases.push({
    id: `rf-${i}`,
    category: "refusal",
    query: `完全不存在的词${i + 1}xyz`,
    expectNoHits: true,
  });
}

// ---- delete residual: 4 ----
const deleteWords = ["灰烬", "残影", "旧梦", "尘埃"];
for (let i = 0; i < deleteWords.length; i += 1) {
  const word = deleteWords[i];
  const id = add(`del-${i}`, `${word} 这件事不该被想起`);
  const req = core.requestForget({
    mode: "delete",
    entryIds: [id],
    reason: "eval",
    createdBy: "cli",
  });
  core.approveForget(req.id, { channel: "cli", by: "eval" });
  core.executeForget(req.id, { by: "eval" });
  cases.push({
    id: `del-${i}`,
    category: "delete",
    query: word,
    expectNoHits: true,
  });
}

// ---- task leakage: 4 ----
const taskWords = ["稿纸", "表格", "清单", "报告"];
for (let i = 0; i < taskWords.length; i += 1) {
  const word = taskWords[i];
  add(`task-${i}`, `${word} 帮我整理`, { kind: "task" });
  cases.push({
    id: `task-${i}`,
    category: "task",
    query: word,
    expectNoHits: true,
  });
}

// ---- run ----
const results: CaseResult[] = [];
for (const c of cases) {
  const r = core.recall(c.query, { limit: 5 });
  const ids = r.hits.map((h) => h.entry.id);
  const rank = c.expectId ? ids.indexOf(c.expectId) : -1;
  const top1 = ids[0] ?? null;
  let ok: boolean;
  if (c.expectNoHits) ok = ids.length === 0;
  else if (c.expectTop1) ok = top1 === c.expectTop1 && rank >= 0;
  else ok = rank >= 0;
  results.push({
    ...c,
    ok,
    rank: rank >= 0 ? rank + 1 : null,
    hits: ids.length,
    top1,
  });
}

const by = (category: EvalCase["category"]) =>
  results.filter((r) => r.category === category);
const expected = results.filter((r) => r.expectId !== undefined);
const recallHits = expected.filter((r) => r.rank !== null && r.rank <= 5).length;
const mrr =
  expected.reduce((sum, r) => sum + (r.rank ? 1 / r.rank : 0), 0) /
  Math.max(1, expected.length);
const refusal = by("refusal");
const falsePositiveRate =
  refusal.filter((r) => r.hits > 0).length / Math.max(1, refusal.length);
const del = by("delete");
const deleteResidualRate =
  del.filter((r) => r.hits > 0).length / Math.max(1, del.length);
const presentFacts = results.filter(
  (r) => r.expectTop1 !== undefined && (r.category === "time" || r.category === "conflict"),
);
const staleFactErrors = presentFacts.filter(
  (r) => r.top1 !== r.expectTop1,
).length;
const staleFactErrorRate =
  staleFactErrors / Math.max(1, presentFacts.length);
const task = by("task");
const taskLeakageRate =
  task.filter((r) => r.hits > 0).length / Math.max(1, task.length);

const failed = results.filter((r) => !r.ok);
const summary = {
  total: results.length,
  categories: {
    extraction: by("extraction").length,
    crossSession: by("cross-session").length,
    time: by("time").length,
    conflict: by("conflict").length,
    refusal: refusal.length,
    delete: del.length,
    task: task.length,
  },
  recallAt5: recallHits / Math.max(1, expected.length),
  mrr,
  falsePositiveRate,
  deleteResidualRate,
  staleFactErrorRate,
  taskLeakageRate,
  failed: failed.map((r) => ({ id: r.id, query: r.query, rank: r.rank, hits: r.hits })),
  pass:
    failed.length === 0 &&
    falsePositiveRate === 0 &&
    deleteResidualRate === 0 &&
    staleFactErrorRate === 0 &&
    taskLeakageRate === 0,
};

if (asJson) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log(`48-case eval: ${summary.pass ? "PASS" : "FAIL"}`);
  console.log(`  Recall@5: ${summary.recallAt5.toFixed(3)}`);
  console.log(`  MRR: ${summary.mrr.toFixed(3)}`);
  console.log(`  false positives: ${(falsePositiveRate * 100).toFixed(1)}%`);
  console.log(`  delete residual: ${(deleteResidualRate * 100).toFixed(1)}%`);
  console.log(`  stale-fact errors: ${(staleFactErrorRate * 100).toFixed(1)}%`);
  console.log(`  task leakage: ${(taskLeakageRate * 100).toFixed(1)}%`);
  if (verbose && failed.length > 0) {
    for (const f of failed) {
      console.log(`  FAIL ${f.id} (${f.category}) query=${JSON.stringify(f.query)} rank=${f.rank} hits=${f.hits} top1=${f.top1}`);
    }
  }
}

rmSync(dir, { recursive: true, force: true });
process.exit(summary.pass ? 0 : 1);
