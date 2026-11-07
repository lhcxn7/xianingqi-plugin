// End-to-end demo/test for @memory-plugin/core.
// Exercises record -> keyword recall -> importance -> log rollover ->
// snapshot -> corrupt -> restore, on sample data in a temp directory.
// Exits non-zero on any failed assertion.
//
// Anti-conflict rules under test (v1 design correction):
// - The core NEVER writes MEMORY.md (fixture bytes must be identical at
//   the end); the three-layer summaries stay model-written per skill.
// - Recall injects only raw-log / archive detail, never layer 1.

import { strict as assert } from "node:assert";
import { execFile, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createContext, Script } from "node:vm";
import {
  AttributeStore,
  KeywordIndex,
  MemoryCore,
  MemoryGraph,
  MODEL_REVIEW_CATEGORIES,
  acquireWriteLock,
  buildModelReviewPrompt,
  computeActivation,
  emotionColor,
  emotionFactor,
  emotionPolarity,
  estimateTokens,
  fragmentKeyTerms,
  initialSignificance,
  isLockStale,
  listTempLeftovers,
  loadReviewState,
  loadSummaries,
  lockDirPath,
  normalizeForDedupe,
  parseArchiveText,
  parseMemoryText,
  parseModelReviewIds,
  parseToneLabel,
  pruneSnapshots,
  recallFromEntries,
  restoreSnapshot,
  snapshotComplete,
  tagEmotion,
  tokenize,
} from "../src/index.ts";

const local = (y: number, m: number, d: number, hh: number, mm: number) =>
  new Date(y, m - 1, d, hh, mm).getTime();

// Evidence header (review-9 m-8): every run labels its OS + Node, so
// a Linux-only green run can never again pass for a Windows failure.
console.log(`os: ${process.platform} / node: ${process.version}`);

function check(name: string, fn: () => void): void {
  fn();
  console.log(`PASS ${name}`);
}

// ---- fixture: a skill-shaped MEMORY.md, hand-written, no canonical
// markers required (tolerant parser must still read it) -------------
const fixtureMemory = `# MEMORY

## 当前状态

- 名字: 夏柠柒
- 阶段: 1
- 喜欢: 银口琴, 兔子挂件
- 不喜欢: 被跟踪
- 约定:
  - 每周五查岗
- 计数: 对话轮数=40; 记忆条数=120

## 最近30天

### 2026/11/04

- 09:12 [user|persona|heavy] 以后每周五查岗
- 09:13 [assistant|persona|light] 好, 每周五查

### 2026/11/05

- 08:01 [user|persona|light] 今天天气不错
- 08:02 [assistant|persona|light] 嗯, 适合出门

## 月度归档

- 2026-10: 共 8 条, 其中重要 2 条; 大事: 摩天轮初吻
`;

const fixtureArchive = `# 记忆归档 2026-10

### 2026/10/28

- 21:30 [user|persona|heavy] 摩天轮初吻, 在最高处
`;

const dir = mkdtempSync(join(tmpdir(), "memory-core-demo-"));
writeFileSync(join(dir, "MEMORY.md"), fixtureMemory, "utf8");
writeFileSync(join(dir, "MEMORY-2026-10.md"), fixtureArchive, "utf8");
const memoryBefore = readFileSync(join(dir, "MEMORY.md"), "utf8");

// ---- tolerant parser ----------------------------------------------
check("tolerant parser reads skill-shaped MEMORY.md", () => {
  const parsed = parseMemoryText(fixtureMemory);
  assert.equal(parsed.layer1.name, "夏柠柒");
  assert.equal(parsed.layer1.stage, "1");
  assert.deepEqual(parsed.layer1.likes, ["银口琴", "兔子挂件"]);
  assert.ok(parsed.layer1.agreements.includes("每周五查岗"));
  assert.equal(parsed.layer1.counters["记忆条数"], 120);
  assert.equal(parsed.layer2.length, 4);
  assert.equal(parsed.layer2[0].text, "以后每周五查岗");
  assert.equal(parsed.layer2[0].importance, "heavy");
  assert.equal(parsed.layer3[0].month, "2026-10");
});

// ---- parser reads skill v2.4 REAL format (audit issue 1) -----------
// Written exactly as the skill writes it: ## date headings, [HH:MM]
// entries with no dash and no metadata, 喜好/厌恶 keys, 旧月份总结区.
// The v1 parser read NONE of this (layer2 0, layer3 0, likes empty).
const realMemory = `# MEMORY

## 当前状态

- 名字: 夏柠柒
- 阶段: 1
- 喜好: 银口琴, 兔子挂件
- 厌恶: 被跟踪
- 约定:
  - 每周五查岗
- 计数: 对话轮数=40; 记忆条数=120
- 最后更新时间: 2026-11-05 09:00

## 最近30天

## 2026/11/04

[09:12] 以后每周五查岗
[09:13] 好，每周五查

## 2026/11/05

[08:01] 今天天气不错
[08:02] 嗯，适合出门

## 旧月份总结区

- 2026-10: 共 8 条，其中重要 2 条；大事：摩天轮初吻
`;

const realArchive = `# 记忆归档 2026-10

## 2026/10/28

[21:30] 摩天轮初吻，在最高处
`;

check("parser reads skill v2.4 real format (## dates, [HH:MM], 喜好/厌恶)", () => {
  const parsed = parseMemoryText(realMemory);
  assert.equal(parsed.layer1.name, "夏柠柒");
  assert.equal(parsed.layer1.stage, "1");
  assert.deepEqual(parsed.layer1.likes, ["银口琴", "兔子挂件"]);
  assert.deepEqual(parsed.layer1.dislikes, ["被跟踪"]);
  assert.ok(parsed.layer1.agreements.includes("每周五查岗"));
  assert.equal(parsed.layer1.counters["记忆条数"], 120);
  assert.equal(parsed.layer1.lastUpdated, "2026-11-05 09:00");
  assert.equal(parsed.layer2.length, 4);
  assert.equal(parsed.layer2[0].text, "以后每周五查岗");
  assert.equal(parsed.layer2[0].time, "09:12");
  assert.equal(parsed.layer3.length, 1);
  assert.equal(parsed.layer3[0].month, "2026-10");
  const archived = parseArchiveText("2026-10", realArchive);
  assert.equal(archived.length, 1);
  assert.ok(archived[0].text.includes("摩天轮初吻"));
});

const dir2 = mkdtempSync(join(tmpdir(), "memory-core-real-format-"));
writeFileSync(join(dir2, "MEMORY.md"), realMemory, "utf8");
writeFileSync(join(dir2, "MEMORY-2026-10.md"), realArchive, "utf8");

check("core reads real-format files end to end (layer2 + archive recall)", () => {
  const coreReal = new MemoryCore({ dataDir: dir2 });
  assert.equal(coreReal.stats().layer2Count, 4);
  assert.deepEqual(coreReal.readLayer1().likes, ["银口琴", "兔子挂件"]);
  const r = coreReal.recall("摩天轮");
  assert.ok(r.hits.some((h) => h.entry.text.includes("摩天轮初吻")));
});

// ---- record ---------------------------------------------------------
const core = new MemoryCore({ dataDir: dir, logMaxEntries: 5 });

const e1 = core.record({
  role: "user",
  text: "以后每周五查岗, 不许忘",
  window: "persona",
  importance: "heavy",
  sessionId: "s1",
  ts: local(2026, 11, 3, 9, 12),
});
core.record({
  role: "assistant",
  text: "好, 每周五查",
  window: "persona",
  importance: "light",
  sessionId: "s1",
  ts: local(2026, 11, 3, 9, 13),
});
core.record({
  role: "user",
  text: "今天查岗了吗",
  window: "persona",
  importance: "light",
  sessionId: "s1",
  ts: local(2026, 11, 5, 10, 0),
});
core.record({
  role: "user",
  text: "任务窗口的查岗记录不该出现",
  window: "task",
  importance: "light",
  sessionId: "s2",
  ts: local(2026, 11, 5, 10, 5),
});

check("record appends to append-only log", () => {
  const log = readFileSync(join(dir, "log.jsonl"), "utf8").trim().split("\n");
  assert.equal(log.length, 4);
  assert.equal(JSON.parse(log[0]).id, e1.id);
  assert.equal(JSON.parse(log[0]).window, "persona");
});

// ---- recall ---------------------------------------------------------
check("recall finds keyword, heavy first, task window excluded", () => {
  const r = core.recall("查岗");
  assert.ok(r.hits.length >= 2);
  assert.equal(r.hits[0].entry.id, e1.id, "heavy beats recency");
  assert.ok(
    r.hits.every((h) => h.entry.window === "persona"),
    "task-window entries excluded by default",
  );
  const all = core.recall("查岗", { window: "all" });
  assert.ok(all.hits.some((h) => h.entry.window === "task"));
});

check("recall injects facts only, never layer 1", () => {
  const r = core.recall("查岗");
  assert.equal(r.layer1?.stage, "1", "stage readable for reference");
  assert.ok(!r.text.includes("银口琴"), "layer-1-only detail not injected");
  assert.ok(!r.text.includes("阶段:"), "layer 1 block not injected");
  assert.ok(r.text.includes("查岗"), "log hits injected");
});

check("recall finds monthly-archive detail", () => {
  const r = core.recall("摩天轮");
  assert.ok(r.hits.some((h) => h.entry.text.includes("摩天轮初吻")));
});

check("recall respects the token cap", () => {
  const r = core.recall("查岗", { tokenCap: 25 });
  assert.equal(r.hits.length, 1);
  assert.ok(r.estimatedTokens <= 25);
  const wide = core.recall("查岗");
  assert.ok(wide.estimatedTokens <= 1500);
});

// No keyword match means NO injection (audit issue 4): v1 fell back
// to "most recent, heavy first" and injected unrelated memories.
check("no keyword match returns empty, no fallback injection", () => {
  const r = core.recall("完全不相关的词xyzabc");
  assert.equal(r.hits.length, 0);
  assert.equal(r.text, "");
  assert.equal(r.estimatedTokens, 0);
});

check("empty query returns no hits", () => {
  const r = core.recall("");
  assert.equal(r.hits.length, 0);
  assert.equal(r.text, "");
});

// 0.3.0 mid-turn trigger (condition b): a query matching a
// high-significance memory counts, a query matching only light or
// task-window memories does not. The heavy entry (e1) is 0.9, so a
// 0.95 threshold excludes it; the light entries are 0.4.
check("hasHighSignificanceMatch: heavy hit matches, light-only and task-only queries do not", () => {
  assert.equal(core.hasHighSignificanceMatch("查岗"), true, "heavy entry matches 查岗");
  assert.equal(core.hasHighSignificanceMatch("查岗", 0.95), false, "0.9 is below a 0.95 threshold");
  assert.equal(core.hasHighSignificanceMatch("好"), false, "only the light '好, 每周五查' matches 好");
  assert.equal(core.hasHighSignificanceMatch("任务窗口"), false, "task-window entries never count");
  assert.equal(core.hasHighSignificanceMatch("完全不相关的词xyzabc"), false, "no match at all");
  assert.equal(core.hasHighSignificanceMatch(""), false, "empty query");
});

// ---- rollover -------------------------------------------------------
core.record({
  role: "user",
  text: "十月那件事还记得吗",
  window: "persona",
  importance: "light",
  sessionId: "s1",
  ts: local(2026, 10, 28, 21, 0),
});
core.record({
  role: "assistant",
  text: "记得, 十月二十八号",
  window: "persona",
  importance: "light",
  sessionId: "s1",
  ts: local(2026, 11, 5, 11, 0),
});
core.record({
  role: "user",
  text: "再记一条凑数",
  window: "persona",
  importance: "light",
  sessionId: "s1",
  ts: local(2026, 11, 5, 11, 1),
});
core.record({
  role: "user",
  text: "第八条",
  window: "persona",
  importance: "light",
  sessionId: "s1",
  ts: local(2026, 11, 5, 11, 2),
});

check("log rollover moves entries to month segments, nothing lost", () => {
  const stats = core.stats();
  assert.equal(stats.totalEntries, 8);
  const r = core.recall("十月那件事");
  assert.ok(r.hits.some((h) => h.entry.text.includes("十月那件事")));
  const r2 = core.recall("查岗");
  assert.ok(r2.hits.length >= 2, "rolled entries still searchable");
});

check("flush persists the index; a new core loads it", () => {
  core.flush();
  const core2 = new MemoryCore({ dataDir: dir, logMaxEntries: 5 });
  assert.equal(core2.stats().totalEntries, 8);
  assert.ok(core2.stats().indexTokens > 0);
  assert.ok(core2.recall("查岗").hits.length >= 2);
});

// ---- snapshot / corrupt / restore -----------------------------------
const snap = core.snapshot();
check("snapshot created", () => {
  assert.ok(core.listSnapshots().includes(snap));
});

// Corrupt the live log and the index, then restore. A diary file and
// an unrelated note are added first: the snapshot predates them, so a
// destructive restore would delete them (audit issue 2).
writeFileSync(join(dir, "log.jsonl"), "garbage\n{broken\n", "utf8");
writeFileSync(join(dir, "index.json"), "not json", "utf8");
writeFileSync(join(dir, "日记.md"), "今天心情很好\n", "utf8");
writeFileSync(join(dir, "notes.txt"), "用户自己放的便签\n", "utf8");

check("restore brings the log back from snapshot", () => {
  const safety = core.restore(snap);
  assert.ok(core.listSnapshots().includes(safety), "pre-restore snapshot kept");
  assert.equal(core.stats().totalEntries, 8);
  assert.ok(core.recall("查岗").hits.length >= 2);
});

check("restore leaves files outside the snapshot alone (diary safe)", () => {
  assert.equal(readFileSync(join(dir, "日记.md"), "utf8"), "今天心情很好\n");
  assert.equal(readFileSync(join(dir, "notes.txt"), "utf8"), "用户自己放的便签\n");
});

// Torn last line (crash mid-append) is skipped, never fatal: append a
// partial line to the live log instead of destroying it.
const logPath = join(dir, "log.jsonl");
writeFileSync(logPath, readFileSync(logPath, "utf8") + '{"id":"torn"', "utf8");
check("torn log line is skipped on load", () => {
  const core3 = new MemoryCore({ dataDir: dir, logMaxEntries: 5 });
  assert.equal(core3.stats().totalEntries, 8);
});

// ---- MEMORY.md untouched + no temp leftovers -------------------------
check("MEMORY.md bytes unchanged by every core operation", () => {
  assert.equal(readFileSync(join(dir, "MEMORY.md"), "utf8"), memoryBefore);
});

check("no atomic-write temp leftovers", () => {
  assert.deepEqual(listTempLeftovers(dir), []);
});

// ---- endSession ------------------------------------------------------
check("endSession snapshots and flushes", () => {
  const res = core.endSession();
  assert.ok(typeof res.snapshot === "string" && res.snapshot.length > 0);
  assert.ok(core.listSnapshots().includes(res.snapshot));
});

// ---- fresh core: dedupe-before-cap, index staleness, 2nd rollover,
// snapshot rotation + completion markers (audit minors d/f/g/o) ------
const dir3 = mkdtempSync(join(tmpdir(), "memory-core-extra-"));
// Archive holds a copy of the log entry's text (same memory, two
// sources) plus an unrelated one, for the dedupe-before-cap test.
writeFileSync(
  join(dir3, "MEMORY-2026-10.md"),
  `# 记忆归档 2026-10

## 2026/10/28

[21:30] 查岗约定每周五
[21:31] 摩天轮初吻，在最高处
`,
  "utf8",
);
const coreB = new MemoryCore({ dataDir: dir3, logMaxEntries: 3 });
coreB.record({
  role: "user",
  text: "查岗约定每周五",
  window: "persona",
  importance: "heavy",
  sessionId: "b1",
  ts: local(2026, 11, 5, 9, 0),
});
coreB.record({
  role: "user",
  text: "查岗别的事",
  window: "persona",
  importance: "light",
  sessionId: "b1",
  ts: local(2026, 10, 1, 9, 0),
});

check("dedupe happens before the token cap (archive copy eats no slot)", () => {
  // Log entry "查岗约定每周五" and the archive copy have identical
  // text. Ranked order is [log-heavy, archive, other]; with limit 2
  // a post-cap dedupe would return only 1 hit.
  const r = coreB.recall("查岗", { limit: 2 });
  assert.equal(r.hits.length, 2);
  assert.deepEqual(
    r.hits.map((h) => h.entry.text),
    ["查岗约定每周五", "查岗别的事"],
  );
});

check("index staleness: same-size hand edit rebuilds, v1 index rejected", () => {
  coreB.flush();
  const indexFile = join(dir3, "index.json");
  const idx = new KeywordIndex(indexFile);
  assert.equal(idx.load([join(dir3, "log.jsonl")]), true);
  // Same byte count, different content: 查岗 -> 巡逻 (both 6 bytes).
  const logPath = join(dir3, "log.jsonl");
  const edited = readFileSync(logPath, "utf8").replaceAll("查岗", "巡逻");
  assert.equal(
    Buffer.byteLength(edited),
    Buffer.byteLength(readFileSync(logPath, "utf8")),
  );
  writeFileSync(logPath, edited, "utf8");
  const idx2 = new KeywordIndex(indexFile);
  assert.equal(idx2.load([join(dir3, "log.jsonl")]), false);
  // A v1 index (version 1, no per-file fingerprint) is stale too.
  writeFileSync(
    indexFile,
    JSON.stringify({ version: 1, logBytes: 0, entries: {} }),
    "utf8",
  );
  const idx3 = new KeywordIndex(indexFile);
  assert.equal(idx3.load([join(dir3, "log.jsonl")]), false);
});

check("second rollover merges into the existing segment, nothing lost", () => {
  coreB.record({
    role: "user",
    text: "第三条",
    window: "persona",
    sessionId: "b1",
    ts: local(2026, 11, 5, 10, 0),
  });
  coreB.record({
    role: "user",
    text: "第四条触发第一次 rollover",
    window: "persona",
    sessionId: "b1",
    ts: local(2026, 11, 5, 10, 1),
  });
  assert.equal(coreB.stats().totalEntries, 4);
  for (let i = 0; i < 4; i++) {
    coreB.record({
      role: "user",
      text: `第二轮第${i + 1}条`,
      window: "persona",
      sessionId: "b1",
      ts: local(2026, 11, 5, 11, i),
    });
  }
  assert.equal(coreB.stats().totalEntries, 8);
  assert.ok(coreB.recall("第三条").hits.length >= 1);
  assert.ok(coreB.recall("第二轮第4条").hits.length >= 1);
});

check("load dedupes an entry present in both log and segment", () => {
  const segment = readFileSync(join(dir3, "log-2026-11.jsonl"), "utf8")
    .trim()
    .split("\n")[0];
  writeFileSync(
    join(dir3, "log.jsonl"),
    `${segment}\n`,
    "utf8",
  );
  const coreC = new MemoryCore({ dataDir: dir3, logMaxEntries: 3 });
  assert.equal(coreC.stats().totalEntries, 8);
});

check("snapshots carry a .complete marker; rotation keeps newest", () => {
  const snapB = coreB.snapshot();
  assert.ok(
    existsSync(join(dir3, ".snapshots", snapB, ".complete")),
    "snapshot has a completion marker",
  );
  assert.equal(snapshotComplete(dir3, snapB), true);
  const emptySnap = join(dir3, ".snapshots", "empty-snap");
  mkdirSync(emptySnap, { recursive: true });
  assert.equal(snapshotComplete(dir3, "empty-snap"), false);
  assert.throws(() => restoreSnapshot(dir3, "empty-snap"), /incomplete/);
  rmSync(emptySnap, { recursive: true, force: true });
  mkdirSync(join(dir3, ".snapshots", "2000-01-01-fake-a"), { recursive: true });
  writeFileSync(
    join(dir3, ".snapshots", "2000-01-01-fake-a", ".complete"),
    "x\n",
    "utf8",
  );
  mkdirSync(join(dir3, ".snapshots", "2000-01-02-fake-b"), { recursive: true });
  writeFileSync(
    join(dir3, ".snapshots", "2000-01-02-fake-b", ".complete"),
    "x\n",
    "utf8",
  );
  pruneSnapshots(dir3, 2);
  const kept = coreB.listSnapshots();
  assert.equal(kept.length, 2);
  assert.ok(!kept.includes("2000-01-01-fake-a"), "oldest snapshot pruned");
  assert.ok(kept.includes(snapB), "newest snapshot kept");
});

console.log(`\nALL PASS (data dir: ${dir})`);

// ---- 0.1.3 audit fixes (B2, m1-m4, m8, m11, m13, snapshot allowlist)
const dir4 = mkdtempSync(join(tmpdir(), "memory-core-013-"));
writeFileSync(
  join(dir4, "MEMORY.md"),
  "# MEMORY\n\n## 当前状态\n\n- 名字: 夏柠柒\n- 阶段: 1\n",
  "utf8",
);
const coreD = new MemoryCore({ dataDir: dir4 });
const dGood1 = coreD.record({
  role: "user",
  text: "好的",
  window: "persona",
  sessionId: "d1",
  ts: local(2026, 11, 5, 12, 0),
});
const dGood2 = coreD.record({
  role: "user",
  text: "好的",
  window: "persona",
  sessionId: "d1",
  ts: local(2026, 11, 6, 12, 0),
});
const dSmall1 = coreD.record({
  role: "user",
  text: "查岗小事一",
  window: "persona",
  sessionId: "d1",
  ts: local(2026, 11, 5, 12, 10),
});
const dSmall2 = coreD.record({
  role: "user",
  text: "查岗小事二",
  window: "persona",
  sessionId: "d1",
  ts: local(2026, 11, 5, 12, 11),
});
coreD.record({
  role: "user",
  text: `查岗${"啊".repeat(3000)}`,
  window: "persona",
  sessionId: "d1",
  ts: local(2026, 11, 5, 12, 12),
});
coreD.record({
  role: "user",
  text: "最喜欢冰镇酸梅汤",
  window: "persona",
  sessionId: "d1",
  ts: local(2026, 11, 5, 12, 13),
});

check("m2: genuine repeats inside the log are kept (same text, two days)", () => {
  const r = coreD.recall("好的");
  assert.equal(r.hits.length, 2, "both '好的' kept, different times");
  assert.deepEqual(
    r.hits.map((h) => h.entry.id).sort(),
    [dGood1.id, dGood2.id].sort(),
  );
});

check("m3: over-cap entries are skipped, smaller fitting ones still collected", () => {
  const r = coreD.recall("查岗", { tokenCap: 100 });
  assert.equal(r.hits.length, 2);
  assert.ok(r.estimatedTokens <= 100);
  assert.ok(r.hits.every((h) => h.entry.text.length < 100));
  assert.deepEqual(
    r.hits.map((h) => h.entry.id).sort(),
    [dSmall1.id, dSmall2.id].sort(),
  );
});

check("m4: single-char query matches, stopwords do not over-match", () => {
  assert.ok(tokenize("汤").includes("汤"), "single char token emitted");
  assert.ok(!tokenize("不").includes("不"), "stopword single not emitted");
  assert.ok(!tokenize("完全不相关的词").includes("不"));
  const r = coreD.recall("汤");
  assert.ok(r.hits.some((h) => h.entry.text.includes("酸梅汤")));
  const unrelated = coreD.recall("完全不相关的词xyzabc");
  assert.equal(unrelated.hits.length, 0, "no single-char noise recall");
});

check("m1: recall uses the keyword index (lookup), results match a rebuilt core", () => {
  coreD.flush();
  const idx = new KeywordIndex(join(dir4, "index.json"));
  assert.equal(idx.load([join(dir4, "log.jsonl")]), true);
  const ids = idx.lookup(["查岗"]).get("查岗") ?? [];
  assert.ok(ids.includes(dSmall1.id));
  assert.ok(ids.includes(dSmall2.id));
  const coreE = new MemoryCore({ dataDir: dir4 });
  assert.deepEqual(
    coreE.recall("查岗", { tokenCap: 100 }).hits.map((h) => h.entry.id).sort(),
    coreD.recall("查岗", { tokenCap: 100 }).hits.map((h) => h.entry.id).sort(),
  );
});

check("m8: archive hits are labelled [归档], not [user]", () => {
  const r = core.recall("摩天轮");
  assert.ok(r.hits.some((h) => h.entry.text.includes("摩天轮初吻")));
  assert.ok(r.text.includes("归档"), "archive label present");
  assert.ok(!r.text.includes("21:30 user]"), "her words not labelled [user]");
});

check("m11: non-string query returns empty, never throws", () => {
  const r1 = coreD.recall(undefined as unknown as string);
  assert.equal(r1.hits.length, 0);
  assert.equal(r1.text, "");
  const r2 = coreD.recall(123 as unknown as string);
  assert.equal(r2.hits.length, 0);
  assert.equal(tokenize(undefined as unknown as string).length, 0);
  assert.equal(tokenize(123 as unknown as string).length, 0);
});

check("snapshots cover only plugin-owned files, never MEMORY.md", () => {
  const snapD = coreD.snapshot();
  assert.ok(
    !existsSync(join(dir4, ".snapshots", snapD, "MEMORY.md")),
    "MEMORY.md is not snapshotted",
  );
  assert.ok(
    existsSync(join(dir4, ".snapshots", snapD, "log.jsonl")),
    "log is snapshotted",
  );
  writeFileSync(
    join(dir4, "MEMORY.md"),
    readFileSync(join(dir4, "MEMORY.md"), "utf8") + "\n后来加的一行\n",
    "utf8",
  );
  coreD.restore(snapD);
  assert.ok(
    readFileSync(join(dir4, "MEMORY.md"), "utf8").includes("后来加的一行"),
    "restore does not revert MEMORY.md",
  );
  assert.equal(coreD.stats().totalEntries, 6);
});

check("B2: record() validates before writing — poison never lands on disk", () => {
  const logPath = join(dir4, "log.jsonl");
  const linesBefore = readFileSync(logPath, "utf8")
    .trim()
    .split("\n").length;
  assert.throws(
    () => coreD.record({ role: "user", text: undefined as unknown as string }),
    /non-empty string/,
  );
  assert.throws(
    () => coreD.record({ role: "user", text: 123 as unknown as string }),
    /non-empty string/,
  );
  assert.throws(
    () => coreD.record({ role: "user", text: "   " }),
    /non-empty string/,
  );
  assert.equal(
    readFileSync(logPath, "utf8").trim().split("\n").length,
    linesBefore,
    "no poisoned line was appended",
  );
  // A poisoned line already on disk (hand-written, no text field) is
  // skipped on load and never crashes the constructor or recall.
  writeFileSync(
    logPath,
    readFileSync(logPath, "utf8") +
      '{"id":"poison-1","ts":123,"role":"user","window":"persona","importance":"light"}\n',
    "utf8",
  );
  const coreF = new MemoryCore({ dataDir: dir4 });
  assert.equal(coreF.stats().totalEntries, 6);
  assert.ok(coreF.recall("查岗").hits.length >= 1);
});

check("m13: new empty data dir without MEMORY.md warns (m13)", () => {
  const warns: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warns.push(args.map(String).join(" "));
  };
  try {
    const emptyDir = mkdtempSync(join(tmpdir(), "memory-core-empty-"));
    new MemoryCore({ dataDir: emptyDir });
    assert.ok(
      warns.some((w) => w.includes(emptyDir) && w.includes("MEMORY.md")),
      "warn names the dir and MEMORY.md",
    );
    warns.length = 0;
    const okDir = mkdtempSync(join(tmpdir(), "memory-core-ok-"));
    writeFileSync(join(okDir, "MEMORY.md"), "# MEMORY\n", "utf8");
    new MemoryCore({ dataDir: okDir });
    assert.equal(warns.length, 0, "no warn when MEMORY.md exists");
  } finally {
    console.warn = origWarn;
  }
});

console.log(`\nALL PASS (0.1.3 additions, data dir: ${dir4})`);

// ---- 0.1.4 re-verification minors (restore name validation) -------
check("minor 3: restoreSnapshot rejects path-traversal names", () => {
  assert.throws(() => restoreSnapshot(dir4, "../escape"), /invalid snapshot name/);
  assert.throws(() => restoreSnapshot(dir4, "a/b"), /invalid snapshot name/);
  assert.throws(() => restoreSnapshot(dir4, ".."), /invalid snapshot name/);
  assert.throws(() => restoreSnapshot(dir4, "a\\b"), /invalid snapshot name/);
  assert.throws(() => restoreSnapshot(dir4, "   "), /invalid snapshot name/);
  // A legitimate name still restores: the guard only rejects paths.
  const snapOk = coreD.snapshot();
  assert.ok(coreD.listSnapshots().includes(snapOk));
  const safety = coreD.restore(snapOk);
  assert.ok(coreD.listSnapshots().includes(safety));
});

console.log(`\nALL PASS (0.1.4 additions, data dir: ${dir4})`);

// ---- 0.1.6: file lock (two writers, stale/live locks) ---------------
const dir5 = mkdtempSync(join(tmpdir(), "memory-core-016-"));
writeFileSync(
  join(dir5, "MEMORY.md"),
  "# MEMORY\n\n## 当前状态\n\n- 名字: 夏柠柒\n- 阶段: 1\n",
  "utf8",
);
const coreP = new MemoryCore({ dataDir: dir5, logMaxEntries: 1000 });
const coreQ = new MemoryCore({ dataDir: dir5, logMaxEntries: 1000 });
for (let i = 0; i < 50; i++) {
  coreP.record({
    role: "user",
    text: `alpha side sharedmark number ${i}`,
    window: "persona",
    sessionId: "a",
  });
  coreQ.record({
    role: "user",
    text: `beta side sharedmark number ${i}`,
    window: "persona",
    sessionId: "b",
  });
}

check("0.1.6 lock: two cores interleave 50+50 records, all 100 land, index consistent", () => {
  const logLines = readFileSync(join(dir5, "log.jsonl"), "utf8")
    .trim()
    .split("\n");
  assert.equal(logLines.length, 100, "log has all 100 lines");
  const ids = new Set(
    logLines.map((l) => (JSON.parse(l) as { id: string }).id),
  );
  assert.equal(ids.size, 100, "no duplicate ids");
  coreP.flush();
  coreQ.flush();
  // The persisted index must be accepted as fresh AND complete: a
  // fresh core that trusts it still finds both sides' keywords. (A
  // stale-but-fresh-fingerprinted index would miss one side.)
  const idx = new KeywordIndex(join(dir5, "index.json"));
  assert.equal(
    idx.load([join(dir5, "log.jsonl")]),
    true,
    "index accepted as fresh",
  );
  const coreR = new MemoryCore({ dataDir: dir5, logMaxEntries: 1000 });
  assert.equal(coreR.stats().totalEntries, 100);
  assert.equal(
    coreR.recall("sharedmark", { limit: 100, tokenCap: 100000 }).hits.length,
    100,
  );
  // 0.2.0: "alpha" still finds all 50 alpha entries directly — and
  // the top 8 seeds each pull their number-linked beta neighbour
  // along a keyword edge (the number token appears in exactly one
  // alpha + one beta entry, df 2). Graph expansion is part of
  // recall, not the valve, so it runs with an explicit limit too.
  const alphaHits = coreR.recall("alpha", { limit: 100, tokenCap: 100000 }).hits;
  assert.equal(alphaHits.filter((h) => !h.viaGraph).length, 50, "all 50 alpha entries are direct hits");
  assert.equal(alphaHits.filter((h) => h.viaGraph).length, 8, "top 8 seeds each pull one beta neighbour");
  assert.equal(alphaHits.length, 58);
  const betaHits = coreR.recall("beta", { limit: 100, tokenCap: 100000 }).hits;
  assert.equal(betaHits.filter((h) => !h.viaGraph).length, 50, "all 50 beta entries are direct hits");
  assert.equal(betaHits.filter((h) => h.viaGraph).length, 8, "top 8 seeds each pull one alpha neighbour");
  assert.equal(betaHits.length, 58);
  // No lock left behind after clean releases.
  assert.equal(existsSync(lockDirPath(dir5)), false);
});

check("0.1.6 lock: stale lock (old + dead pid) is broken, live lock is not", () => {
  const dir6 = mkdtempSync(join(tmpdir(), "memory-core-016-lock-"));
  // A dead pid: a process that has already exited.
  const deadPid = spawnSync(process.execPath, ["--version"]).pid as number;
  assert.ok(deadPid > 0, "spawned a short-lived process");
  // Stale: old mtime + dead pid -> acquire succeeds by breaking it.
  const staleDir = lockDirPath(dir6);
  mkdirSync(staleDir, { recursive: true });
  writeFileSync(
    join(staleDir, "owner.json"),
    JSON.stringify({ pid: deadPid, token: "stale-owner", time: Date.now() - 60000 }),
    "utf8",
  );
  const old = new Date(Date.now() - 60000);
  utimesSync(staleDir, old, old);
  assert.equal(isLockStale(staleDir, 30000), true);
  const releaseStale = acquireWriteLock(dir6, { timeoutMs: 2000 });
  assert.equal(existsSync(join(staleDir, "owner.json")), true);
  releaseStale();
  assert.equal(existsSync(staleDir), false, "stale lock dir removed on release");

  // Live: fresh mtime + live pid (this process) -> acquire times out,
  // and the lock is left untouched.
  const liveDir = lockDirPath(dir6);
  mkdirSync(liveDir, { recursive: true });
  writeFileSync(
    join(liveDir, "owner.json"),
    JSON.stringify({ pid: process.pid, token: "live-owner", time: Date.now() }),
    "utf8",
  );
  assert.equal(isLockStale(liveDir, 30000), false);
  const start = Date.now();
  assert.throws(
    () => acquireWriteLock(dir6, { timeoutMs: 200 }),
    /could not acquire write lock/,
  );
  assert.ok(Date.now() - start >= 150, "waited for the timeout");
  assert.equal(existsSync(liveDir), true, "live lock not broken");
  assert.equal(
    JSON.parse(readFileSync(join(liveDir, "owner.json"), "utf8")).token,
    "live-owner",
  );

  // Old mtime but LIVE pid -> still not stale (both conditions needed).
  const oldLive = new Date(Date.now() - 60000);
  utimesSync(liveDir, oldLive, oldLive);
  assert.equal(isLockStale(liveDir, 30000), false);
  assert.throws(
    () => acquireWriteLock(dir6, { timeoutMs: 200 }),
    /could not acquire write lock/,
  );
  assert.equal(existsSync(liveDir), true, "old-but-live lock not broken");
  rmSync(liveDir, { recursive: true, force: true });
});

check("0.1.6 lock: release only removes a lock we own", () => {
  const dir7 = mkdtempSync(join(tmpdir(), "memory-core-016-own-"));
  const release = acquireWriteLock(dir7, { timeoutMs: 2000 });
  const lockPath = lockDirPath(dir7);
  assert.equal(existsSync(lockPath), true);
  // Someone else breaks our lock and retakes it (different token):
  // our release must not delete theirs.
  writeFileSync(
    join(lockPath, "owner.json"),
    JSON.stringify({ pid: process.pid, token: "someone-else", time: Date.now() }),
    "utf8",
  );
  release();
  assert.equal(existsSync(lockPath), true, "foreign lock left alone");
  // Release is idempotent, and releasing a lock that vanished
  // underneath us does not throw.
  release();
  rmSync(lockPath, { recursive: true, force: true });
  const release2 = acquireWriteLock(dir7, { timeoutMs: 2000 });
  rmSync(lockDirPath(dir7), { recursive: true, force: true });
  release2();
  assert.equal(existsSync(lockDirPath(dir7)), false);
});

// ---- 0.1.6: recall dedupe (log vs MEMORY.md) -----------------------
const dir8 = mkdtempSync(join(tmpdir(), "memory-core-016-dedupe-"));
writeFileSync(
  join(dir8, "MEMORY.md"),
  `# MEMORY

## 当前状态

- 名字: 夏柠柒
- 阶段: 1
- 喜好: 最喜欢的饮料是冰镇酸梅汤
- 重要记忆: 以后每周五查岗不许忘记了

## 最近30天

## 2026/11/05

[09:12] 以后每周五查岗不许忘记了
[09:13] 今天天气不错
`,
  "utf8",
);
const coreDedupe = new MemoryCore({ dataDir: dir8 });
coreDedupe.record({
  role: "user",
  text: "我最喜欢的饮料是冰镇酸梅汤，以后请我喝这个",
  window: "persona",
  sessionId: "g1",
  ts: local(2026, 11, 5, 10, 0),
});
coreDedupe.record({
  role: "user",
  text: "每周五查岗不许忘记了",
  window: "persona",
  sessionId: "g1",
  ts: local(2026, 11, 5, 10, 1),
});
coreDedupe.record({
  role: "user",
  text: "最喜欢的颜色是深蓝色",
  window: "persona",
  sessionId: "g1",
  ts: local(2026, 11, 5, 10, 2),
});
coreDedupe.record({
  role: "user",
  text: "今天天气不错，适合出门",
  window: "persona",
  sessionId: "g1",
  ts: local(2026, 11, 5, 10, 3),
});

check("0.1.6 dedupe: log copy of a Layer 1 fact is dropped, curated copy kept", () => {
  const r = coreDedupe.recall("酸梅汤");
  assert.equal(r.hits.length, 0, "verbatim log copy dropped");
  assert.equal(r.text, "", "no injected text for the dropped fact");
  assert.ok(
    (r.layer1?.likes ?? []).includes("最喜欢的饮料是冰镇酸梅汤"),
    "curated Layer 1 copy still present",
  );
  // The entry is still on disk — dedupe only filters the recall,
  // it never deletes.
  assert.equal(coreDedupe.stats().totalEntries, 4);
});

check("0.1.6 dedupe: shorter log copy contained in a Layer 2 entry is dropped, different facts survive", () => {
  const r = coreDedupe.recall("查岗");
  assert.equal(r.hits.length, 0, "shorter log copy contained in Layer 2 dropped");
  const r2 = coreDedupe.recall("最喜欢");
  assert.equal(r2.hits.length, 1, "only the different fact survives");
  assert.equal(r2.hits[0].entry.text, "最喜欢的颜色是深蓝色");
});

check("0.1.6 dedupe: short overlap (<10 chars) is kept", () => {
  const r = coreDedupe.recall("天气");
  assert.equal(r.hits.length, 1, "Layer 2 '今天天气不错' is 6 chars, below the bar");
  assert.equal(r.hits[0].entry.text, "今天天气不错，适合出门");
});

check("0.1.6 dedupe: archive hits are exempt (archives are not read at open)", () => {
  const dir9 = mkdtempSync(join(tmpdir(), "memory-core-016-arch-"));
  writeFileSync(
    join(dir9, "MEMORY.md"),
    `# MEMORY

## 当前状态

- 名字: 夏柠柒
- 阶段: 1

## 最近30天

## 2026/11/05

[09:12] 摩天轮初吻在最高处的时候很紧张
`,
    "utf8",
  );
  writeFileSync(
    join(dir9, "MEMORY-2026-10.md"),
    `# 记忆归档 2026-10

## 2026/10/28

[21:30] 摩天轮初吻在最高处的时候很紧张
`,
    "utf8",
  );
  const coreArch = new MemoryCore({ dataDir: dir9 });
  const r = coreArch.recall("摩天轮");
  assert.ok(
    r.hits.some(
      (h) => h.entry.source === "archive" && h.entry.text.includes("摩天轮初吻"),
    ),
    "identical-text archive hit kept",
  );
});

check("0.1.6 dedupe: normalisation strips space, punctuation, case", () => {
  assert.equal(normalizeForDedupe("  Hello, World! 你好，世界。 "), "helloworld你好世界");
  assert.equal(
    normalizeForDedupe("最喜欢的饮料是冰镇酸梅汤"),
    "最喜欢的饮料是冰镇酸梅汤",
  );
  assert.equal(normalizeForDedupe(""), "");
});

// ---- 0.1.7: two-process stale-lock race (M2) -----------------------
// The in-process interleave test above cannot catch the breakLock
// TOCTOU: two OS processes racing one stale lock. The runner plants
// a stale lock per round and spawns two independent node processes
// that break it at the same time; a worker fails if its live lock
// is deleted or retaken while held. Run it once (20 rounds) and
// assert a clean exit plus no lock leftovers.
check("0.1.7 lock: two OS processes race one stale lock, no live lock deleted, all writes land", () => {
  const raceDir = mkdtempSync(join(tmpdir(), "memory-core-017-race-"));
  const raceScript = join(
    dirname(fileURLToPath(import.meta.url)),
    "lock-race.ts",
  );
  const res = spawnSync(process.execPath, [raceScript, raceDir, "20"], {
    encoding: "utf8",
  });
  if (res.stdout) process.stdout.write(res.stdout);
  if (res.stderr) process.stderr.write(res.stderr);
  assert.equal(
    res.status,
    0,
    `lock-race runner must exit 0 (status ${res.status})`,
  );
  assert.equal(
    existsSync(join(raceDir, ".locks")),
    false,
    "no .locks left after race",
  );
});

// ---- 0.1.7: no renames in lock.ts (v6 Major) -----------------------
// Claude's deep review of package v6 (Major M-01) showed the arbiter
// break/release renames could move a live arbiter: an old process's
// stale judgement predates a new holder's acquire, the rename moves
// the new holder's live arbiter, two processes hold the arbiter, and
// a stale reclaim then deletes a live canonical lock. The fix removes
// every rename from lock.ts — no path is ever moved, so no process
// can ever move another's lock. This check makes that a testable
// invariant: the identifier `renameSync` and any `rename(` call must
// not appear in the file at all (comments included, so the check
// cannot be satisfied by hiding the call in a comment).
check("0.1.7 lock: lock.ts contains no rename (v6 Major invariant)", () => {
  const lockSrc = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "src", "lock.ts"),
    "utf8",
  );
  assert.equal(
    lockSrc.includes("renameSync"),
    false,
    "lock.ts must not reference renameSync",
  );
  assert.equal(
    /\brename\s*\(/.test(lockSrc),
    false,
    "lock.ts must not call rename",
  );
});

// ---- 0.1.7: multi-process mutual exclusion (arbiter redesign) ------
// The v5 claim-and-verify release could be broken by a third process
// taking the canonical dir while it was renamed away (deep review of
// package v5, Major M-01). The lock was redesigned around an arbiter
// that serialises every canonical-lock operation, and the canonical
// dir is never moved. The v6 deep review then found the SAME hole in
// the arbiter itself (its break/release renames), so the fix removes
// all renames and re-verifies the owner token before every delete.
// The regression test must therefore be real multi-process
// interleaving, not a single-process emulation:
// lock-mutex.ts runs release-isolation + stale-arbiter reclaim +
// the arbiter-break race (step 2b, forced with a delay hook) +
// 3 outer rounds x 4 workers x 15 rounds of acquire/hold/release,
// and verifies the START/END log never overlaps (at most 1 holder).
check("0.1.7 lock: multi-process mutual exclusion (arbiter, 3 rounds x 4 workers)", () => {
  const mutexDir = mkdtempSync(join(tmpdir(), "memory-core-017-mutex-"));
  const mutexScript = join(
    dirname(fileURLToPath(import.meta.url)),
    "lock-mutex.ts",
  );
  const res = spawnSync(process.execPath, [mutexScript, mutexDir, "3", "4", "15"], {
    encoding: "utf8",
  });
  if (res.stdout) process.stdout.write(res.stdout);
  if (res.stderr) process.stderr.write(res.stderr);
  assert.equal(
    res.status,
    0,
    `lock-mutex runner must exit 0 (status ${res.status})`,
  );
  assert.equal(
    existsSync(join(mutexDir, ".locks")),
    false,
    "no .locks left after mutex test",
  );
  rmSync(mutexDir, { recursive: true, force: true });
});

// ---- 0.1.7: recall dedupe remainder rule (m1) ----------------------
// 0.1.6 dropped a log hit on any containment either way, so a turn
// carrying a known fact PLUS a new fact lost the new fact from
// recall. Since 0.1.7 a longer log hit is dropped only when the
// remainder after removing the matched MEMORY.md fact is < 10
// normalised chars. Memory fact here (normalised, 12 chars):
// 最喜欢的饮料是冰镇酸梅汤. The four turns below differ only in
// what follows it: remainder 11 (kept), 1 (dropped), 9 (dropped),
// 10 (kept — exactly at the bar).
const dir10 = mkdtempSync(join(tmpdir(), "memory-core-017-dedupe-"));
writeFileSync(
  join(dir10, "MEMORY.md"),
  `# MEMORY\n\n## 当前状态\n\n- 名字: 夏柠柒\n- 阶段: 1\n- 喜好: 最喜欢的饮料是冰镇酸梅汤\n\n## 最近30天\n`,
  "utf8",
);
const coreDedupe17 = new MemoryCore({ dataDir: dir10 });
const m1TurnA = "我最喜欢的饮料是冰镇酸梅汤，而且明天想去海边散步";
const m1TurnB = "我最喜欢的饮料是冰镇酸梅汤";
const m1TurnC = "我最喜欢的饮料是冰镇酸梅汤，今天天气真的很热";
const m1TurnD = "我最喜欢的饮料是冰镇酸梅汤，明天想去海边散步呀";
coreDedupe17.record({ role: "user", text: m1TurnA, window: "persona", sessionId: "h1", ts: local(2026, 11, 5, 11, 0) });
coreDedupe17.record({ role: "user", text: m1TurnB, window: "persona", sessionId: "h1", ts: local(2026, 11, 5, 11, 1) });
coreDedupe17.record({ role: "user", text: m1TurnC, window: "persona", sessionId: "h1", ts: local(2026, 11, 5, 11, 2) });
coreDedupe17.record({ role: "user", text: m1TurnD, window: "persona", sessionId: "h1", ts: local(2026, 11, 5, 11, 3) });

check("0.1.7 dedupe: log turn with a known fact PLUS a new fact is kept (m1)", () => {
  const r = coreDedupe17.recall("海边");
  assert.equal(r.hits.length, 2, "both multi-fact turns survive");
  const texts = r.hits.map((h) => h.entry.text).sort();
  assert.deepEqual(texts, [m1TurnA, m1TurnD].sort());
});

check("0.1.7 dedupe: pure copy dropped, remainder just under the bar dropped", () => {
  const r = coreDedupe17.recall("酸梅汤");
  // All four turns match the keyword; only the two carrying extra
  // facts (remainder 11 and 10) survive — the pure copy (remainder
  // 1) and the just-under turn (remainder 9) are dropped.
  assert.equal(r.hits.length, 2, "only turns carrying extra facts survive");
  const texts = r.hits.map((h) => h.entry.text).sort();
  assert.deepEqual(texts, [m1TurnA, m1TurnD].sort());
  // Nothing is deleted from disk — dedupe only filters the recall.
  assert.equal(coreDedupe17.stats().totalEntries, 4);
});

console.log(`\nALL PASS (0.1.7 additions, data dir: ${dir5})`);

// ---- 0.2.0: graph + attributes + activation + valve + review ----
// Minimal MEMORY.md fixture: deliberately contains NONE of the test
// facts, so the 0.1.6/0.1.7 MEMORY.md dedupe can never drop a test
// hit (the shared fixture's "每周五查岗" would eat the valve test).
const fixtureMemory020 = `# MEMORY\n\n## 当前状态\n\n- 名字: 夏柠柒\n- 阶段: 1\n- 喜好: 银口琴\n\n## 最近30天\n`;

// Graph: A (seed) —recall—> B (no shared keyword), A —session—> C
// (adjacent in the same session, no shared keyword). Recall must
// surface B through the recall edge and must NOT surface C.
const dir20 = mkdtempSync(join(tmpdir(), "memory-core-020-graph-"));
writeFileSync(join(dir20, "MEMORY.md"), fixtureMemory020, "utf8");
const core20 = new MemoryCore({ dataDir: dir20 });
core20.record({ role: "user", text: "酸梅汤真好喝", window: "persona", sessionId: "s1", ts: local(2026, 11, 5, 10, 0) });
core20.record({ role: "user", text: "今晚吃拉面", window: "persona", sessionId: "s1", ts: local(2026, 11, 5, 10, 1) });
const rSeed = core20.recall("酸梅汤", { sessionId: "s2" });
assert.equal(rSeed.hits.length, 1, "seed recall surfaces only A");
core20.record({ role: "user", text: "明天要去爬山", window: "persona", sessionId: "s2", ts: local(2026, 11, 5, 10, 2) });

check("0.2.0 graph: a memory with no shared keyword but a recall edge is surfaced; session-only neighbour is not", () => {
  const r = core20.recall("酸梅汤", { sessionId: "s3" });
  const texts = r.hits.map((h) => h.entry.text);
  assert.ok(texts.includes("酸梅汤真好喝"), "seed hit present");
  const b = r.hits.find((h) => h.entry.text === "明天要去爬山");
  assert.ok(b, "recall-edge neighbour surfaces");
  assert.equal(b?.viaGraph, true, "marked as a graph hit");
  assert.ok(!texts.includes("今晚吃拉面"), "session-only neighbour stays out");
  assert.equal(core20.stats().graphEdges, 2, "session + recall edges");
});

// Activation: pure product, any zero factor kills it; the valve's
// threshold drops a diluted old hit, a short query surfaces it.
check("0.2.0 activation: five factors multiply, any zero factor is zero", () => {
  assert.equal(computeActivation({ content: 0, relationship: 1, emotion: 1, time: 1, attention: 1 }), 0);
  assert.equal(computeActivation({ content: 1, relationship: 1, emotion: 1, time: 1, attention: 0 }), 0);
  assert.equal(computeActivation({ content: 1, relationship: 1, emotion: 1, time: 1, attention: 1 }), 1);
  assert.equal(computeActivation({ content: 0.5, relationship: 0.5, emotion: 0.5, time: 0.5, attention: 0.5 }), 0.03125);
});

const dir21 = mkdtempSync(join(tmpdir(), "memory-core-020-activation-"));
writeFileSync(join(dir21, "MEMORY.md"), fixtureMemory020, "utf8");
const core21 = new MemoryCore({ dataDir: dir21 });
core21.record({ role: "user", text: "酸梅汤真好喝", window: "persona", sessionId: "s1", ts: local(2026, 9, 6, 10, 0) });

check("0.2.0 activation: a diluted old hit is below threshold and dropped; a short query surfaces it", () => {
  const diluted = core21.recall("酸梅汤明天天气海边爬山拉面");
  assert.ok(!diluted.hits.some((h) => h.entry.text === "酸梅汤真好喝"), "diluted query drops the old light hit");
  const short = core21.recall("酸梅汤");
  assert.ok(short.hits.some((h) => h.entry.text === "酸梅汤真好喝"), "short query surfaces it");
  assert.ok(short.hits.every((h) => h.activation >= 0.02), "every surfaced hit clears the threshold");
  assert.ok(diluted.hits.every((h) => h.activation >= 0.02), "real valve path: nothing below threshold is ever injected");
});

// Review: old light entry compresses, a 3x-recalled entry promotes,
// clarity decays, MEMORY.md is untouched, a second review is skipped.
const dir22 = mkdtempSync(join(tmpdir(), "memory-core-020-review-"));
writeFileSync(join(dir22, "MEMORY.md"), fixtureMemory020, "utf8");
const core22 = new MemoryCore({ dataDir: dir22 });
const memBefore22 = readFileSync(join(dir22, "MEMORY.md"), "utf8");
const eOld = core22.record({ role: "user", text: "今天天气不错，适合出门", window: "persona", sessionId: "s1", ts: local(2026, 9, 28, 10, 0) });
const eFresh = core22.record({ role: "user", text: "酸梅汤真好喝", window: "persona", sessionId: "s2", ts: local(2026, 11, 6, 10, 0) });
core22.record({ role: "user", text: "明天要去爬山", window: "persona", sessionId: "s3", ts: local(2026, 11, 6, 10, 5) });
for (let i = 0; i < 3; i++) core22.recall("酸梅汤");
const reviewResult = core22.review(true, local(2026, 11, 7, 9, 0));

check("0.2.0 review: decay, compression, promotion, summary file, MEMORY.md untouched", () => {
  assert.ok(reviewResult !== null && reviewResult.ran, "review ran");
  assert.equal(reviewResult.lastStats.compressed, 1, "exactly the old light entry compresses");
  assert.equal(reviewResult.lastStats.promoted, 1, "the 3x-recalled entry promotes");
  assert.ok(reviewResult.lastStats.decayed >= 1, "clarity decayed");
  assert.equal(reviewResult.lastStats.edgesAdded, 0, "no shared rare keywords, no new edges");
  assert.ok(existsSync(join(dir22, "review.json")), "review.json written");
  assert.ok(existsSync(join(dir22, "summary-2026-09.jsonl")), "compressed summary lands in the monthly file");
  assert.ok(readFileSync(join(dir22, "summary-2026-09.jsonl"), "utf8").includes("今天天气不错"), "summary carries the old memory");
  const attrs = JSON.parse(readFileSync(join(dir22, "attributes.json"), "utf8")) as {
    entries: Record<string, { clarity: number; significance: number; compressed?: boolean }>;
  };
  assert.ok(attrs.entries[eOld.id].compressed, "old entry flagged compressed");
  assert.ok(attrs.entries[eOld.id].clarity < 0.5, "old entry clarity faded");
  assert.equal(attrs.entries[eFresh.id].significance, 0.8, "3x-recalled entry promoted to 0.8");
  assert.equal(readFileSync(join(dir22, "MEMORY.md"), "utf8"), memBefore22, "MEMORY.md bytes identical");
  assert.equal(core22.review(false), null, "second review within 24h is skipped");
});

check("0.2.0 review: a compressed hit injects its one-line summary, marked ·压缩", () => {
  const r = core22.recall("天气");
  const hit = r.hits.find((h) => h.entry.id === eOld.id);
  assert.ok(hit, "compressed entry still recalls");
  assert.equal(hit?.compressed, true, "marked compressed");
  assert.ok(r.text.includes("·压缩"), "injected block carries the ·压缩 marker");
});

// ---- 0.3.0: daily model review replaces HEAVY_SIGNAL_WORDS --------
// Significance is now: heavy 0.9 / light 0.4 at record time, recall
// promotion in review, and the model review below. No keyword list.
check("model review: initialSignificance no longer uses signal words (light + former signal word stays 0.4)", () => {
  assert.equal(initialSignificance({ importance: "light", text: "我保证以后每天都陪你" }), 0.4, "保证 no longer lifts a light entry");
  assert.equal(initialSignificance({ importance: "light", text: "这是我们的第一次" }), 0.4, "第一次 no longer lifts a light entry");
  assert.equal(initialSignificance({ importance: "heavy", text: "随便一句" }), 0.9, "heavy is still 0.9");
});

check("model review: parseModelReviewIds accepts arrays/objects, rejects garbage (no partial apply)", () => {
  assert.deepEqual(parseModelReviewIds(["a", "b", "a"]), ["a", "b"], "duplicates removed");
  assert.deepEqual(parseModelReviewIds({ ids: ["a", "b"] }), ["a", "b"]);
  assert.deepEqual(parseModelReviewIds({ important: ["a"] }), ["a"]);
  assert.deepEqual(parseModelReviewIds('["a", "b"]'), ["a", "b"], "a JSON string is parsed once");
  assert.deepEqual(parseModelReviewIds([]), [], "empty list is valid (nothing important)");
  assert.equal(parseModelReviewIds("not json"), null);
  assert.equal(parseModelReviewIds('{"foo": 1}'), null);
  assert.equal(parseModelReviewIds("[1, 2]"), null, "non-string elements rejected");
  assert.equal(parseModelReviewIds("null"), null);
  assert.equal(parseModelReviewIds(""), null);
  assert.equal(parseModelReviewIds({ ids: "not-an-array" }), null);
  assert.equal(parseModelReviewIds(undefined), null);
});

const dirMR = mkdtempSync(join(tmpdir(), "memory-core-model-review-"));
writeFileSync(join(dirMR, "MEMORY.md"), fixtureMemory020, "utf8");
const coreMR = new MemoryCore({ dataDir: dirMR });
const nowMR = local(2026, 11, 7, 9, 0);
const ydayMR = local(2026, 11, 6, 12, 0);
const eY1 = coreMR.record({ role: "user", text: "昨天去爬山了，我保证下次还去", window: "persona", sessionId: "s1", ts: ydayMR });
const eY2 = coreMR.record({ role: "assistant", text: "好呀，下次一起去", window: "persona", sessionId: "s1", ts: ydayMR + 60000 });
const eHeavyMR = coreMR.record({ role: "user", text: "记住：她喜欢银口琴", window: "persona", importance: "heavy", sessionId: "s1", ts: ydayMR + 120000 });
coreMR.record({ role: "user", text: "今天要去买菜", window: "persona", sessionId: "s1", ts: nowMR });
coreMR.record({ role: "user", text: "昨天任务窗口的一句", window: "task", sessionId: "s2", ts: ydayMR });

check("model review: yesterdayEntries returns only yesterday's persona entries", () => {
  const list = coreMR.yesterdayEntries(nowMR);
  assert.equal(list.length, 3, "two light + one heavy, all persona, all yesterday");
  assert.ok(list.some((e) => e.id === eY1.id));
  assert.ok(list.some((e) => e.id === eY2.id));
  assert.ok(list.some((e) => e.id === eHeavyMR.id));
});

check("model review: prompt carries the ids, the text and all 20 categories", () => {
  const text = buildModelReviewPrompt(coreMR.yesterdayEntries(nowMR));
  assert.ok(text.includes(eY1.id), "entry id present for the model to cite");
  assert.ok(text.includes("昨天去爬山了"), "entry text present");
  assert.ok(text.includes("memory_daily_review"), "tool named");
  assert.equal(MODEL_REVIEW_CATEGORIES.length, 20, "20 categories");
  for (const c of MODEL_REVIEW_CATEGORIES) {
    assert.ok(text.includes(c), `prompt lists ${c}`);
  }
});

check("model review: prompt appends fragment candidates for memory_fragment (M-1), and omits the section when there are none", () => {
  const withCand = buildModelReviewPrompt(coreMR.yesterdayEntries(nowMR), [
    { topic: "酸梅湯", sourceIds: [eY1.id, eY2.id], keywords: ["酸梅湯"] },
  ]);
  assert.ok(
    withCand.includes(`话题“酸梅湯”：[${eY1.id}]、[${eY2.id}]`),
    "candidate cluster listed with topic and ids",
  );
  assert.ok(withCand.includes("memory_fragment"), "fragment tool named in the candidate section");
  const withoutCand = buildModelReviewPrompt(coreMR.yesterdayEntries(nowMR));
  assert.ok(!withoutCand.includes("提炼成片段"), "no candidate section when there are none");
});

type AttrRow = { significance: number; modelMarked?: boolean; compressed?: boolean };
const readAttrs = (dir: string) =>
  JSON.parse(readFileSync(join(dir, "attributes.json"), "utf8")) as {
    entries: Record<string, AttrRow>;
  };

check("model review: applyModelMarks upgrades to 0.9, never downgrades, unknown ids are reported", () => {
  const res = coreMR.applyModelMarks([eY1.id, "no-such-id"]);
  assert.deepEqual(res.applied, [eY1.id]);
  assert.deepEqual(res.unknown, ["no-such-id"]);
  const attrs = readAttrs(dirMR);
  assert.equal(attrs.entries[eY1.id].significance, 0.9, "light 0.4 raised to 0.9");
  assert.equal(attrs.entries[eY1.id].modelMarked, true, "flagged model-marked");
  // Never downgrades: a heavy 0.9 stays 0.9, and re-applying is a no-op.
  const res2 = coreMR.applyModelMarks([eY1.id, eHeavyMR.id]);
  assert.deepEqual(res2.applied, [eY1.id, eHeavyMR.id]);
  assert.deepEqual(res2.unknown, []);
  assert.equal(readAttrs(dirMR).entries[eHeavyMR.id].significance, 0.9, "heavy stays 0.9");
  assert.equal(readAttrs(dirMR).entries[eY1.id].significance, 0.9, "re-apply keeps 0.9");
});

// A model-marked old light memory is never compressed, while an
// unmarked old light memory compresses as before.
const dirMC = mkdtempSync(join(tmpdir(), "memory-core-model-marked-"));
writeFileSync(join(dirMC, "MEMORY.md"), fixtureMemory020, "utf8");
const coreMC = new MemoryCore({ dataDir: dirMC });
const eMarked = coreMC.record({ role: "user", text: "很久以前的一句重要的话", window: "persona", sessionId: "s1", ts: local(2026, 9, 28, 10, 0) });
const ePlain = coreMC.record({ role: "user", text: "很久以前的一句普通的话", window: "persona", sessionId: "s1", ts: local(2026, 9, 28, 10, 5) });
coreMC.applyModelMarks([eMarked.id], local(2026, 11, 7, 9, 0));
const rMC = coreMC.review(true, local(2026, 11, 7, 9, 0));

check("model review: a model-marked memory is never compressed", () => {
  assert.ok(rMC !== null && rMC.ran, "review ran");
  assert.equal(rMC.lastStats.compressed, 1, "only the unmarked old light entry compresses");
  const attrs = readAttrs(dirMC);
  assert.equal(attrs.entries[eMarked.id].compressed, undefined, "marked entry not flagged compressed");
  assert.equal(attrs.entries[eMarked.id].significance, 0.9, "marked entry stays 0.9");
  assert.equal(attrs.entries[eMarked.id].modelMarked, true, "mark persisted");
  assert.ok(attrs.entries[ePlain.id].compressed, "unmarked old entry compressed");
  const summary = readFileSync(join(dirMC, "summary-2026-09.jsonl"), "utf8");
  assert.ok(summary.includes("普通的话"), "summary carries the plain entry");
  assert.ok(!summary.includes("重要的话"), "summary never carries the marked entry");
});

// Valve: 6 hits on one topic -> at most 2 on the injection path;
// an explicit limit disables the valve.
const dir23 = mkdtempSync(join(tmpdir(), "memory-core-020-valve-"));
writeFileSync(join(dir23, "MEMORY.md"), fixtureMemory020, "utf8");
const core23 = new MemoryCore({ dataDir: dir23 });
for (let i = 0; i < 6; i++) {
  core23.record({ role: "user", text: `查岗第${i + 1}条`, window: "persona", sessionId: `s${i}`, ts: local(2026, 11, 6, 10, i) });
}

check("0.2.0 valve: one topic is capped at 2 on the injection path; an explicit limit disables it", () => {
  assert.equal(core23.recall("查岗").hits.length, 2, "valve keeps at most 2 per topic");
  assert.equal(core23.recall("查岗", { limit: 10 }).hits.length, 6, "explicit limit turns the valve off");
});

// Starmap (static): real data, real edges, no external URLs, video
// fields present (常用词, 平衡, 时间流速, 想起).
const dir24 = mkdtempSync(join(tmpdir(), "memory-core-020-starmap-"));
writeFileSync(join(dir24, "MEMORY.md"), fixtureMemory020, "utf8");
const core24 = new MemoryCore({ dataDir: dir24 });
core24.record({ role: "user", text: "酸梅汤真好喝", window: "persona", sessionId: "s1", ts: local(2026, 11, 5, 10, 0) });
core24.record({ role: "user", text: "今晚吃拉面", window: "persona", sessionId: "s1", ts: local(2026, 11, 5, 10, 1) });
core24.recall("酸梅汤", { sessionId: "s2" });
core24.record({ role: "user", text: "明天要去爬山", window: "persona", sessionId: "s2", ts: local(2026, 11, 5, 10, 2) });
const starmap = core24.generateStarmap();
const starmapHtml = readFileSync(starmap.path, "utf8");

check("0.2.0 starmap: generated from real graph+attributes+log, no external URLs, video fields present", () => {
  assert.equal(starmap.nodes, 3, "3 stars");
  assert.equal(starmap.edges, 2, "session + recall edges");
  assert.ok(starmapHtml.includes("酸梅汤真好喝"), "real memory text embedded");
  assert.ok(starmapHtml.includes("明天要去爬山"), "real memory text embedded");
  assert.ok(starmapHtml.includes('"from"'), "edges embedded as data");
  assert.ok(!starmapHtml.includes("http://") && !starmapHtml.includes("https://"), "no external URLs anywhere");
  assert.ok(starmapHtml.includes("时间流速"), "time-flow slider present");
  assert.ok(starmapHtml.includes("常用词"), "video detail field 常用词 present");
  assert.ok(starmapHtml.includes("平衡"), "status dials present");
  assert.ok(starmapHtml.includes("recall-input"), "recall demo input present");
  assert.ok(starmapHtml.includes("__starmap"), "drift stop handle exposed");
  assert.ok(existsSync(join(dir24, "starmap.html")), "starmap.html lives in the data dir");
});

// ---- 0.2.0 starmap functional test (async) -------------------------
// The generated HTML is a real interactive page: stars twinkle and
// drift, clicking a star opens the video-style detail panel, typing
// a trigger word lights a chain along the edges, and the time-flow
// slider dims memories outside the cursor. Run its inline script in
// node:vm against a minimal DOM stub and drive it like a user.
function makeFakeEl(tag = "div"): any {
  const el: any = {
    tag,
    children: [] as any[],
    _text: "",
    _cls: new Set<string>(),
    attrs: new Map<string, string>(),
    style: {} as Record<string, string>,
    value: "",
    handlers: new Map<string, any[]>(),
    get textContent() {
      return this._text + this.children.map((c: any) => c.textContent).join("");
    },
    set textContent(v: string) {
      this._text = String(v);
      this.children = [];
    },
    classList: {
      add: (...c: string[]) => c.forEach((x) => el._cls.add(x)),
      remove: (...c: string[]) => c.forEach((x) => el._cls.delete(x)),
      toggle: (c: string, f?: boolean) => {
        const on = f ?? !el._cls.has(c);
        if (on) el._cls.add(c);
        else el._cls.delete(c);
        return on;
      },
      contains: (c: string) => el._cls.has(c),
    },
    getAttribute: (k: string) => el.attrs.get(k) ?? null,
    setAttribute: (k: string, v: string) => {
      el.attrs.set(k, String(v));
    },
    appendChild: (c: any) => {
      el.children.push(c);
      return c;
    },
    addEventListener: (type: string, fn: any) => {
      const list = el.handlers.get(type) ?? [];
      list.push(fn);
      el.handlers.set(type, list);
    },
    fire: (type: string, ev: any = {}) => {
      for (const fn of el.handlers.get(type) ?? []) fn({ ...ev, target: ev.target ?? el });
    },
    querySelector: (sel: string) => el.querySelectorAll(sel)[0] ?? null,
    querySelectorAll: (sel: string) => el.children.filter((c: any) => matchesSel(c, sel)),
  };
  return el;
}

function matchesSel(el: any, sel: string): boolean {
  // Supports: .class, .a.b, [data-k="v"], [data-a="x"][data-b="y"].
  const attrParts = sel.match(/\[data-([a-z]+)="([^"]*)"\]/g) ?? [];
  const classes = sel.replace(/\[[^\]]*\]/g, "").split(".").filter(Boolean);
  for (const c of classes) {
    if (!el.classList.contains(c)) return false;
  }
  for (const part of attrParts) {
    const m = /\[data-([a-z]+)="([^"]*)"\]/.exec(part) as RegExpExecArray;
    if (el.getAttribute("data-" + m[1]) !== m[2]) return false;
  }
  return true;
}

const starmapTest = (async () => {
  const jsonMatch = /<script type="application\/json" id="starmap-data">([\s\S]*?)<\/script>/.exec(starmapHtml);
  const scriptMatch = /<script>([\s\S]*?)<\/script>/.exec(starmapHtml);
  assert.ok(jsonMatch, "embedded JSON block found");
  assert.ok(scriptMatch, "inline script block found");
  const data = JSON.parse(jsonMatch[1]);
  assert.equal(data.nodes.length, 3, "stub sees the 3 real nodes");

  const els = new Map<string, any>();
  const mk = (id: string) => {
    const e = makeFakeEl();
    els.set(id, e);
    return e;
  };
  const svg = mk("map");
  const dataEl = mk("starmap-data");
  dataEl._text = jsonMatch[1];
  mk("panel");
  mk("p-date");
  mk("p-text");
  mk("p-tags");
  mk("p-close");
  const recallInput = mk("recall-input");
  const recallBtn = mk("recall-btn");
  mk("recall-clear");
  const recallStatus = mk("recall-status");
  const timeSlider = mk("time-slider");
  timeSlider.value = "1000";
  mk("time-play");
  const timeLabel = mk("time-label");
  mk("dials");
  // Stars + edges as the svg's children, from the real embedded data.
  const starEls = new Map<string, any>();
  for (const n of data.nodes) {
    const s = makeFakeEl("circle");
    s.classList.add("star");
    s.setAttribute("data-id", n.id);
    s.setAttribute("data-ts", String(n.ts));
    svg.children.push(s);
    starEls.set(n.id, s);
  }
  const edgeEls: any[] = [];
  for (const e of data.edges) {
    const l = makeFakeEl("line");
    l.classList.add("edge");
    l.setAttribute("data-a", e.from);
    l.setAttribute("data-b", e.to);
    svg.children.push(l);
    edgeEls.push(l);
  }
  const sandbox: any = {
    console,
    setTimeout,
    setInterval,
    clearTimeout,
    clearInterval,
    document: {
      getElementById: (id: string) => els.get(id) ?? null,
      createElement: (tag: string) => makeFakeEl(tag),
    },
  };
  sandbox.window = sandbox;
  createContext(sandbox);
  new Script(scriptMatch[1]).runInContext(sandbox);
  try {
    // Dials render from the real emotions at load.
    const dials = els.get("dials");
    assert.ok(dials.textContent.length > 0, "dials render (or report no emotion data)");

    // Click a star: the video-style panel opens with real fields.
    const seedNode = data.nodes.find((n: any) => n.text.includes("酸梅汤"));
    const seedStar = starEls.get(seedNode.id);
    svg.fire("click", { target: seedStar });
    const panel = els.get("panel");
    assert.ok(panel.classList.contains("open"), "panel opens on star click");
    assert.ok(els.get("p-text").textContent.includes("酸梅汤"), "panel shows the memory text");
    assert.ok(els.get("p-tags").textContent.includes("常用词"), "panel shows 常用词");
    assert.ok(els.get("p-tags").textContent.includes("清晰度"), "panel shows 清晰度");
    assert.ok(els.get("p-tags").textContent.includes("被想起"), "panel shows 被想起次数");
    assert.ok(els.get("p-tags").textContent.includes("情绪"), "panel shows 情绪+强度");

    // Hover highlights the star's edges and neighbours.
    svg.fire("mouseover", { target: seedStar });
    assert.ok(edgeEls.some((l) => l.classList.contains("lit")), "hover lights connected edges");
    svg.fire("mouseout", { target: seedStar });

    // Recall demo: type the trigger word, the chain lights along edges.
    recallInput.value = "酸梅汤";
    recallBtn.fire("click");
    await new Promise((r) => setTimeout(r, 1300));
    const litStars = [...starEls.values()].filter((s) => s.classList.contains("recall"));
    assert.ok(litStars.length >= 2, "seed + at least one edge neighbour lit");
    assert.ok(recallStatus.textContent.startsWith("想起「酸梅汤」"), "status reads 想起「酸梅汤」");
    assert.ok(recallStatus.textContent.includes("顺着线亮起了"), "status carries the video line");
    assert.ok(edgeEls.some((l) => l.classList.contains("recall-line")), "the connecting edge lights gold");

    // Time-flow slider: drag to the start, later memories dim.
    timeSlider.value = "0";
    timeSlider.fire("input");
    const dimmed = [...starEls.values()].filter((s) => s.classList.contains("dimmed"));
    assert.ok(dimmed.length >= 1, "dragging the time slider dims later memories");
    assert.ok(timeLabel.textContent.length > 0, "time label shows the cursor date");
    timeSlider.value = "1000";
    timeSlider.fire("input");
    assert.ok([...starEls.values()].every((s) => !s.classList.contains("dimmed")), "dragging back to the end shows everything");
  } finally {
    // Stop the drift interval (and any play timer) or node never exits.
    sandbox.__starmap?.stop();
  }
  console.log("PASS 0.2.0 starmap: dynamic page — twinkle/drift, click panel, recall chain, time slider (vm)");
})();

await starmapTest;

// ---- 0.2.0 audit fixes (deep review, 2026-11-07) ------------------
// Each fix below has a regression test asserting the fixed behaviour,
// so the bug cannot silently come back.

// M1: first review over an old log must decay clarity ONCE.
// ensure() ages the new row by entry.ts -> now, so the review clock
// starts at now; a second decay from entry.ts would square it.
{
  const dirM1 = mkdtempSync(join(tmpdir(), "memory-core-020-m1-"));
  writeFileSync(join(dirM1, "MEMORY.md"), fixtureMemory020, "utf8");
  const coreA = new MemoryCore({ dataDir: dirM1 });
  const e = coreA.record({ role: "user", text: "今天天气不错，适合出门", window: "persona", sessionId: "s1", ts: local(2026, 10, 8, 10, 0) });
  rmSync(join(dirM1, "attributes.json"));
  rmSync(join(dirM1, "graph.json"), { force: true });
  const coreB = new MemoryCore({ dataDir: dirM1 });
  const r = coreB.review(true, local(2026, 11, 7, 9, 0));
  assert.ok(r?.ran, "review ran");
  const attrs = JSON.parse(readFileSync(join(dirM1, "attributes.json"), "utf8")) as {
    entries: Record<string, { clarity: number }>;
  };
  const got = attrs.entries[e.id].clarity;
  assert.ok(Math.abs(got - Math.exp(-0.03 * 30)) < 0.01, `single decay ~0.4066, got ${got.toFixed(4)} (double decay would be ~0.1653)`);
  console.log("PASS 0.2.0 M1: first review decays clarity once, not twice");
}

// M2 + M3: per-review backfill must not reset a decayed edge, and
// decay() is per-time, not per-call. 11 daily reviews take a 0.6
// keyword edge to 0.6*0.95^11 = 0.3413 — not pinned at 0.57.
{
  const dirM2 = mkdtempSync(join(tmpdir(), "memory-core-020-m2-"));
  writeFileSync(join(dirM2, "MEMORY.md"), fixtureMemory020, "utf8");
  const core = new MemoryCore({ dataDir: dirM2 });
  const t0 = local(2026, 10, 1, 10, 0);
  core.record({ role: "user", text: "酸梅汤真好喝", window: "persona", sessionId: "s1", ts: t0 });
  core.record({ role: "user", text: "酸梅汤要冰镇的", window: "persona", sessionId: "s1", ts: t0 + 60000 });
  const now = local(2026, 11, 7, 9, 0);
  core.review(true, now);
  for (let i = 1; i <= 10; i++) core.review(true, now + i * 86400000);
  const g = JSON.parse(readFileSync(join(dirM2, "graph.json"), "utf8")) as {
    edges: Array<{ weight: number }>;
  };
  const w = g.edges[0].weight;
  assert.ok(Math.abs(w - 0.6 * Math.pow(0.95, 11)) < 0.002, `11 daily reviews -> 0.3413, got ${w.toFixed(4)} (pinned at 0.57 means backfill reset it)`);
  console.log("PASS 0.2.0 M2+M3: backfill never resets decayed edges; decay is per-day");
}

// M3 (direct): decay() three times at the same instant fades once.
{
  const dirM3 = mkdtempSync(join(tmpdir(), "memory-core-020-m3-"));
  const g = new MemoryGraph(dirM3);
  const t0 = Date.UTC(2026, 10, 1, 10, 0);
  g.link("a", "b", "keyword", t0);
  const now = Date.UTC(2026, 11, 7, 9, 0);
  assert.equal(g.decay(now), 1, "first decay at this now changes 1 edge");
  assert.equal(g.decay(now), 0, "second decay at the same now is a no-op");
  assert.equal(g.decay(now), 0, "third decay at the same now is a no-op");
  assert.ok(Math.abs((g.find("a", "b")?.weight ?? 0) - 0.57) < 1e-9, "weight is 0.6*0.95 after three same-instant decays");
  console.log("PASS 0.2.0 M3: decay() at one instant fades an edge once");
}

// M4 + m3: link() upgrades the type by evidence strength and
// refreshes the clock. A session edge that later shares a rare
// keyword becomes a keyword edge (traversable), with today's
// timestamp — not a stale session edge from 30 days ago.
{
  const dirM4 = mkdtempSync(join(tmpdir(), "memory-core-020-m4-"));
  const g = new MemoryGraph(dirM4);
  const tOld = Date.UTC(2026, 10, 1, 10, 0);
  const tNow = Date.UTC(2026, 10, 31, 10, 0);
  g.link("a", "b", "session", tOld);
  g.link("a", "b", "keyword", tNow);
  const e = g.find("a", "b");
  assert.equal(e?.type, "keyword", "keyword evidence upgrades a session edge");
  assert.equal(e?.weight, 0.6, "weight rises to the keyword initial");
  assert.equal(e?.lastTraversedAt, tNow, "strengthening refreshes lastTraversedAt");
  console.log("PASS 0.2.0 M4+m3: link() upgrades session->keyword and refreshes the clock");
}

// M4 (end to end): same-session entries sharing a rare keyword link
// as a keyword edge, so the neighbour surfaces via the graph.
{
  const dirM4b = mkdtempSync(join(tmpdir(), "memory-core-020-m4b-"));
  writeFileSync(join(dirM4b, "MEMORY.md"), fixtureMemory020, "utf8");
  const core = new MemoryCore({ dataDir: dirM4b });
  const t0 = local(2026, 11, 5, 10, 0);
  core.record({ role: "user", text: "酸梅汤真好喝", window: "persona", sessionId: "s1", ts: t0 });
  core.record({ role: "user", text: "酸梅汤要冰镇的才够味", window: "persona", sessionId: "s1", ts: t0 + 60000 });
  const g = JSON.parse(readFileSync(join(dirM4b, "graph.json"), "utf8")) as {
    edges: Array<{ type: string }>;
  };
  assert.equal(g.edges[0].type, "keyword", "same-session + shared rare keyword is a keyword edge, not session");
  const r = core.recall("真好喝");
  assert.ok(r.hits.some((h) => h.entry.text.includes("冰镇") && h.viaGraph), "keyword neighbour surfaces via the graph");
  console.log("PASS 0.2.0 M4: same-session shared-keyword edge is traversable");
}

// M4 (single-char guard): a shared single character (好) is not a
// topical link — it must NOT upgrade a session edge to keyword, or
// every "好呀 / 好吗 / 好喝" would chain unrelated memories into
// recall. Only multi-char tokens build keyword edges.
{
  const dirM4c = mkdtempSync(join(tmpdir(), "memory-core-020-m4c-"));
  writeFileSync(join(dirM4c, "MEMORY.md"), fixtureMemory020, "utf8");
  const core = new MemoryCore({ dataDir: dirM4c });
  const t0 = local(2026, 11, 5, 10, 0);
  core.record({ role: "user", text: "夏柠柒，今天好吗", window: "persona", sessionId: "s1", ts: t0 });
  core.record({ role: "assistant", text: "好呀", window: "persona", sessionId: "s1", ts: t0 + 60000 });
  const g = JSON.parse(readFileSync(join(dirM4c, "graph.json"), "utf8")) as {
    edges: Array<{ type: string }>;
  };
  assert.equal(g.edges.length, 1, "one edge for the pair");
  assert.equal(g.edges[0].type, "session", "shared single char 好 does not upgrade the session edge");
  const r = core.recall("夏柠柒，今天好吗");
  assert.ok(!r.hits.some((h) => h.entry.text === "好呀" && h.viaGraph), "好呀 is not pulled in via graph on a 今天好吗 query");
  console.log("PASS 0.2.0 M4: single-char tokens never build keyword edges");
}

// M6: a graph neighbour that never surfaces must not gain weight.
// The diluted query leaves B below threshold; its edge stays 0.8.
{
  const dirM6 = mkdtempSync(join(tmpdir(), "memory-core-020-m6-"));
  const graph = new MemoryGraph(dirM6);
  const attrs = new AttributeStore(dirM6);
  const tRecent = Date.UTC(2026, 10, 6, 10, 0);
  const tOld = Date.UTC(2026, 8, 6, 10, 0);
  const A = { id: "a1", ts: tRecent, date: "2026/11/06", time: "10:00", role: "user" as const, window: "persona" as const, sessionId: "s1", importance: "light" as const, text: "酸梅汤真好喝", source: "log" as const };
  const B = { id: "b1", ts: tOld, date: "2026/09/06", time: "10:00", role: "user" as const, window: "persona" as const, sessionId: "s2", importance: "light" as const, text: "我昨晚买了二斤橙子", source: "log" as const };
  graph.link(A.id, B.id, "recall", tRecent);
  const r = recallFromEntries([A, B], null, "酸梅汤明天天气海边爬山拉面电影", {
    graph, attributes: attrs, sessionId: "s3",
  }, Date.UTC(2026, 10, 7, 9, 0));
  assert.ok(!r.hits.some((h) => h.entry.id === "b1"), "below-threshold neighbour does not surface");
  assert.equal(graph.find(A.id, B.id)?.weight, 0.8, "edge weight unmoved for a neighbour that never surfaced");
  console.log("PASS 0.2.0 M6: a non-surfaced graph neighbour gains no weight");
}

// m1: single-char emotion keywords must not fire inside common
// compounds (恐怕 / 积累 / 醋溜 / 暖气), but real uses still tag.
check("0.2.0 m1: emotion lexicon ignores 恐怕/积累/醋溜/暖气, keeps real 怕", () => {
  assert.equal(tagEmotion("恐怕要下雨了"), undefined, "恐怕 is not fear");
  assert.equal(tagEmotion("积累了很多经验"), undefined, "积累 is not tired");
  assert.equal(tagEmotion("醋溜土豆很好吃"), undefined, "醋溜土豆 is not jealousy");
  assert.equal(tagEmotion("暖气开了，屋里很热"), undefined, "暖气 is not warmth");
  assert.equal(tagEmotion("我今天很开心")?.type, "开心", "real 开心 still tags");
  assert.equal(tagEmotion("别怕，我在")?.type, "紧张", "real 怕 still tags");
});

// m2: hand-corrupted graph.json / attributes.json are sanitised on
// load — no crash, no out-of-range value reaches behaviour.
{
  const dirM2b = mkdtempSync(join(tmpdir(), "memory-core-020-m2b-"));
  writeFileSync(join(dirM2b, "MEMORY.md"), fixtureMemory020, "utf8");
  const core = new MemoryCore({ dataDir: dirM2b });
  const t0 = local(2026, 11, 5, 10, 0);
  const e1 = core.record({ role: "user", text: "酸梅汤真好喝", window: "persona", sessionId: "s1", ts: t0 });
  const e2 = core.record({ role: "user", text: "酸梅汤要冰镇的", window: "persona", sessionId: "s1", ts: t0 + 60000 });
  writeFileSync(join(dirM2b, "graph.json"), JSON.stringify({
    version: 1,
    edges: [
      { from: e1.id, to: e2.id, type: "bogus", weight: 5 },
      { from: e1.id, to: e2.id, type: "keyword", weight: 0.6, lastTraversedAt: t0 },
    ],
  }), "utf8");
  writeFileSync(join(dirM2b, "attributes.json"), JSON.stringify({
    version: 1,
    entries: {
      [e1.id]: { emotion: { type: "开心", intensity: 5 }, clarity: -1, recallCount: 3, significance: 999 },
      [e2.id]: { clarity: 0.5, recallCount: 0, significance: -5 },
    },
  }), "utf8");
  const core2 = new MemoryCore({ dataDir: dirM2b });
  const g = JSON.parse(readFileSync(join(dirM2b, "graph.json"), "utf8")) as {
    edges: Array<{ type: string; weight: number }>;
  };
  // The bogus edge is dropped on load; only the keyword edge survives.
  const sm = core2.generateStarmap();
  const html = readFileSync(sm.path, "utf8");
  const sigs = [...html.matchAll(/"significance":(\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]));
  assert.ok(sigs.length > 0 && sigs.every((s) => s >= 0 && s <= 1), `significance clamped to [0,1], got ${JSON.stringify(sigs)}`);
  const radii = [...html.matchAll(/"r":(\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]));
  assert.ok(radii.every((r) => r < 100), `star radii sane, got ${JSON.stringify(radii.slice(0, 4))}`);
  assert.equal(core2.recall("酸梅汤").hits.length, 2, "recall still works on sanitised data");
  console.log("PASS 0.2.0 m2: corrupt graph/attributes files are sanitised on load");
}

// m4: losing attributes.json must not compress the same entry twice.
// The summary file is the record, not the attributes cache.
{
  const dirM4c = mkdtempSync(join(tmpdir(), "memory-core-020-m4c-"));
  writeFileSync(join(dirM4c, "MEMORY.md"), fixtureMemory020, "utf8");
  const core = new MemoryCore({ dataDir: dirM4c });
  const t0 = local(2026, 9, 28, 10, 0);
  core.record({ role: "user", text: "今天天气不错，适合出门", window: "persona", sessionId: "s1", ts: t0 });
  const now = local(2026, 11, 7, 9, 0);
  core.review(true, now);
  rmSync(join(dirM4c, "attributes.json"));
  const core2 = new MemoryCore({ dataDir: dirM4c });
  core2.review(true, now + 86400000);
  const lines = readFileSync(join(dirM4c, "summary-2026-09.jsonl"), "utf8").trim().split("\n").filter(Boolean);
  assert.equal(lines.length, 1, "one summary line after two reviews with attributes.json lost in between");
  assert.equal(new Set(lines.map((l) => (JSON.parse(l) as { entryId: string }).entryId)).size, 1, "one distinct entryId");
  console.log("PASS 0.2.0 m4: attributes.json loss never double-compresses");
}

// m8: two recalls in one session, no record between them — both
// batches of surfaced ids survive for the next record's recall edges.
{
  const dirM8 = mkdtempSync(join(tmpdir(), "memory-core-020-m8-"));
  writeFileSync(join(dirM8, "MEMORY.md"), fixtureMemory020, "utf8");
  const core = new MemoryCore({ dataDir: dirM8 });
  const t0 = local(2026, 11, 5, 10, 0);
  const a1 = core.record({ role: "user", text: "酸梅汤真好喝", window: "persona", sessionId: "s1", ts: t0 });
  const a2 = core.record({ role: "user", text: "今晚吃拉面", window: "persona", sessionId: "s1", ts: t0 + 60000 });
  core.recall("酸梅汤", { sessionId: "s2" });
  core.recall("拉面", { sessionId: "s2" });
  const b = core.record({ role: "user", text: "明天要去爬山", window: "persona", sessionId: "s2", ts: t0 + 120000 });
  const g = JSON.parse(readFileSync(join(dirM8, "graph.json"), "utf8")) as {
    edges: Array<{ from: string; to: string; type: string }>;
  };
  const recallEdges = g.edges.filter((e) => e.type === "recall");
  const hasA1 = recallEdges.some((e) => (e.from === a1.id && e.to === b.id) || (e.from === b.id && e.to === a1.id));
  const hasA2 = recallEdges.some((e) => (e.from === a2.id && e.to === b.id) || (e.from === b.id && e.to === a2.id));
  assert.ok(hasA1, "first recall batch still linked after the second recall");
  assert.ok(hasA2, "second recall batch linked too");
  console.log("PASS 0.2.0 m8: pending recall links append-merge, both batches linked");
}

// m9: starmap render at scale — the node index is a Map, so edges
// resolve in O(1), and every edge still lands in the SVG.
{
  const dirM9 = mkdtempSync(join(tmpdir(), "memory-core-020-m9-"));
  writeFileSync(join(dirM9, "MEMORY.md"), fixtureMemory020, "utf8");
  const core = new MemoryCore({ dataDir: dirM9 });
  for (let i = 0; i < 120; i++) {
    core.record({ role: "user", text: `第${i}条酸梅汤真好喝`, window: "persona", sessionId: `s${i % 6}`, ts: local(2026, 11, 5, 10, 0) + i * 60000 });
  }
  const sm = core.generateStarmap();
  const html = readFileSync(sm.path, "utf8");
  const lineCount = (html.match(/<line class="edge"/g) ?? []).length;
  assert.equal(sm.nodes, 120, "all 120 entries become stars");
  assert.ok(sm.edges > 0, "edges exist");
  assert.equal(lineCount, sm.edges, "every data edge is drawn as an SVG line");
  console.log("PASS 0.2.0 m9: starmap renders 120 nodes with all edges drawn");
}

// M5: two processes starting a review at the same moment — only one
// runs. The due-gate is re-checked inside the lock, so the second
// process sees the first one's write and skips (TOCTOU). Without
// the re-check both would run and totalReviews would be 2.
{
  const dirM5 = mkdtempSync(join(tmpdir(), "memory-core-020-m5-"));
  writeFileSync(join(dirM5, "MEMORY.md"), fixtureMemory020, "utf8");
  const seed = new MemoryCore({ dataDir: dirM5 });
  seed.record({ role: "user", text: "酸梅汤真好喝", window: "persona", sessionId: "s1", ts: local(2026, 11, 1, 10, 0) });
  const now = local(2026, 11, 7, 9, 0);
  const coreSrc = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "index.ts");
  // file:// URL, not a bare path: on Windows a bare "C:\..." path is
  // read by the ESM loader as protocol "c:" and the worker import
  // throws ERR_UNSUPPORTED_ESM_URL_SCHEME (review-9 M-2).
  const coreUrl = pathToFileURL(coreSrc).href;
  const workerSrc = `import { MemoryCore } from ${JSON.stringify(coreUrl)};
const core = new MemoryCore({ dataDir: process.argv[2] });
const r = core.review(false, Number(process.argv[3]));
console.log(JSON.stringify({ ran: r ? r.ran : null, totalReviews: r ? r.totalReviews : null }));
`;
  const workerFile = join(dirM5, "worker.mjs");
  writeFileSync(workerFile, workerSrc, "utf8");
  const runOne = () => new Promise<string>((resolve, reject) => {
    execFile(process.execPath, [workerFile, dirM5, String(now)], { encoding: "utf8" }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout.trim());
    });
  });
  const [o1, o2] = await Promise.all([runOne(), runOne()]);
  const j1 = JSON.parse(o1) as { ran: boolean | null; totalReviews: number | null };
  const j2 = JSON.parse(o2) as { ran: boolean | null; totalReviews: number | null };
  const state = loadReviewState(dirM5);
  assert.equal(state.totalReviews, 1, `exactly one of the two processes ran the review (got ${o1} / ${o2}, totalReviews=${state.totalReviews})`);
  assert.equal((j1.ran ? 1 : 0) + (j2.ran ? 1 : 0), 1, "exactly one child reported ran=true");
  console.log("PASS 0.2.0 M5: two concurrent reviews, only one runs");
}

console.log(`\nALL PASS (0.2.0 additions, data dir: ${dir20})`);

// ---- 0.3.0: fragments on top of the verbatim log ------------------
// The log stays verbatim (no tone in log.jsonl); fragments are the
// visible stars, verified by code at creation and at retrieval.
const fixtureMemory030 = fixtureMemory020;

check("0.3.0 fragment: creation accepts a good fragment (keywords + quotes + tone match)", () => {
  const dir = mkdtempSync(join(tmpdir(), "memory-core-030-good-"));
  writeFileSync(join(dir, "MEMORY.md"), fixtureMemory030, "utf8");
  const core = new MemoryCore({ dataDir: dir });
  const e1 = core.record({ role: "user", text: "酸梅湯真好喝，今天特别开心", window: "persona", sessionId: "s1", ts: local(2026, 11, 5, 10, 0) });
  const e2 = core.record({ role: "user", text: "昨天又喝了酸梅湯，还是那么好喝", window: "persona", sessionId: "s1", ts: local(2026, 11, 5, 10, 5) });
  const r = core.createFragment({
    sourceIds: [e1.id, e2.id],
    text: "他很喜欢酸梅湯",
    tone: "很喜欢",
    quotes: ["真好喝"],
    topic: "酸梅湯",
  });
  assert.equal(r.ok, true, `good fragment accepted, got ${JSON.stringify(r.reasons)}`);
  assert.ok(r.fragment, "fragment returned");
  assert.equal(r.fragment?.verified, true, "verified at creation");
  assert.equal(r.fragment?.tone.level, "strong-positive", "tone level parsed");
  assert.equal(core.stats().fragments, 1, "one fragment stored");
  assert.ok(existsSync(join(dir, "fragments.json")), "fragments.json written");
  const stored = JSON.parse(readFileSync(join(dir, "fragments.json"), "utf8")) as {
    fragments: Array<{ id: string; sourceIds: string[] }>;
  };
  assert.equal(stored.fragments.length, 1, "one fragment on disk");
  assert.deepEqual(stored.fragments[0].sourceIds, [e1.id, e2.id], "provenance kept");
  // The log itself is untouched by fragment creation: still
  // verbatim, still no tone annotation.
  const log = readFileSync(join(dir, "log.jsonl"), "utf8");
  assert.ok(log.includes("酸梅湯真好喝"), "log keeps the verbatim line");
  assert.ok(!log.includes("很喜欢"), "log carries no tone tag");
});

check("0.3.0 fragment: creation REJECTS novel contamination (粉色筷子)", () => {
  const dir = mkdtempSync(join(tmpdir(), "memory-core-030-novel-"));
  writeFileSync(join(dir, "MEMORY.md"), fixtureMemory030, "utf8");
  const core = new MemoryCore({ dataDir: dir });
  const e1 = core.record({ role: "user", text: "酸梅湯真好喝", window: "persona", sessionId: "s1", ts: local(2026, 11, 5, 10, 0) });
  const r = core.createFragment({
    sourceIds: [e1.id],
    text: "他很喜欢粉色筷子",
    tone: "很喜欢",
    quotes: ["真好喝"],
    topic: "粉色筷子",
  });
  assert.equal(r.ok, false, "contaminated fragment rejected");
  assert.ok(r.reasons.some((x) => x.includes("粉色")), `reason names the invented word: ${JSON.stringify(r.reasons)}`);
  assert.equal(core.stats().fragments, 0, "nothing stored");
  assert.equal(existsSync(join(dir, "fragments.json")), false, "no fragments file when nothing was ever accepted");
});

check("0.3.0 fragment: creation REJECTS a tone mismatch (很喜欢 from 还行吧，也就那样)", () => {
  const dir = mkdtempSync(join(tmpdir(), "memory-core-030-tone-"));
  writeFileSync(join(dir, "MEMORY.md"), fixtureMemory030, "utf8");
  const core = new MemoryCore({ dataDir: dir });
  const e1 = core.record({ role: "user", text: "酸梅湯还行吧，也就那样", window: "persona", sessionId: "s1", ts: local(2026, 11, 5, 10, 0) });
  const r = core.createFragment({
    sourceIds: [e1.id],
    text: "他很喜欢酸梅湯",
    tone: "很喜欢",
    quotes: ["还行吧，也就那样"],
    topic: "酸梅湯",
  });
  assert.equal(r.ok, false, "tone-mismatched fragment rejected");
  assert.ok(r.reasons.some((x) => x.includes("语气")), `reason names the tone: ${JSON.stringify(r.reasons)}`);
  assert.equal(core.stats().fragments, 0, "nothing stored");
});

check("0.3.0 fragment: creation ACCEPTS a fragment with a verbatim quote that matches", () => {
  const dir = mkdtempSync(join(tmpdir(), "memory-core-030-quote-"));
  writeFileSync(join(dir, "MEMORY.md"), fixtureMemory030, "utf8");
  const core = new MemoryCore({ dataDir: dir });
  const e1 = core.record({ role: "user", text: "酸梅湯还行吧，也就那样", window: "persona", sessionId: "s1", ts: local(2026, 11, 5, 10, 0) });
  const r = core.createFragment({
    sourceIds: [e1.id],
    text: "酸梅湯还行",
    tone: "还行",
    quotes: ["还行吧，也就那样"],
    topic: "酸梅湯",
  });
  assert.equal(r.ok, true, `verbatim-quote fragment accepted, got ${JSON.stringify(r.reasons)}`);
  assert.deepEqual(r.fragment?.quotes, ["还行吧，也就那样"], "quote kept verbatim");
  // A paraphrased quote (same meaning, different words) is rejected.
  const r2 = core.createFragment({
    sourceIds: [e1.id],
    text: "酸梅湯还行",
    tone: "还行",
    quotes: ["酸梅湯一般般"],
    topic: "酸梅湯",
  });
  assert.equal(r2.ok, false, "a quote that is not verbatim in the source is rejected");
});

check("0.3.0 fragment: free-form tone is accepted, unknown tone never fails on tone alone", () => {
  assert.equal(parseToneLabel("嘴上嫌弃心里喜欢")?.level, "unknown", "unlisted tone word maps to unknown, not rejected");
  assert.equal(parseToneLabel("很喜欢")?.level, "strong-positive", "listed tone still parses to its level");
  assert.equal(parseToneLabel("很喜欢:0.9")?.intensity, 0.9, "explicit intensity kept");
  assert.equal(parseToneLabel("")?.level, undefined, "empty tone is still rejected");
  const dir = mkdtempSync(join(tmpdir(), "memory-core-030-freeform-"));
  writeFileSync(join(dir, "MEMORY.md"), fixtureMemory030, "utf8");
  const core = new MemoryCore({ dataDir: dir });
  const e1 = core.record({ role: "user", text: "酸梅湯还行吧，也就那样", window: "persona", sessionId: "s1", ts: local(2026, 11, 5, 10, 0) });
  const r = core.createFragment({
    sourceIds: [e1.id],
    text: "酸梅湯还行",
    tone: "嘴上嫌弃心里喜欢",
    quotes: ["还行吧，也就那样"],
    topic: "酸梅湯",
  });
  assert.equal(r.ok, true, `free-form tone accepted, got ${JSON.stringify(r.reasons)}`);
  assert.equal(r.fragment?.tone.label, "嘴上嫌弃心里喜欢", "free-form label kept verbatim");
  assert.equal(r.fragment?.tone.level, "unknown", "level unknown, tone check skipped");
});

// Retrieval fallback: a fragment whose stored text was tampered
// with after creation fails its re-check, recall injects the
// verbatim source instead, and the fragment is marked suspect.
{
  const dir = mkdtempSync(join(tmpdir(), "memory-core-030-fallback-"));
  writeFileSync(join(dir, "MEMORY.md"), fixtureMemory030, "utf8");
  const core = new MemoryCore({ dataDir: dir });
  const e1 = core.record({ role: "user", text: "酸梅湯真好喝，今天特别开心", window: "persona", sessionId: "s1", ts: local(2026, 11, 5, 10, 0) });
  const created = core.createFragment({
    sourceIds: [e1.id],
    text: "他很喜欢酸梅湯",
    tone: "很喜欢",
    quotes: ["真好喝"],
    topic: "酸梅湯",
  });
  assert.equal(created.ok, true, "setup fragment accepted");
  // Tamper with the stored fragment on disk (as if it had been
  // hand-edited or its sources had drifted): the text now claims
  // something the source never says.
  const fragFile = join(dir, "fragments.json");
  const stored = JSON.parse(readFileSync(fragFile, "utf8")) as {
    fragments: Array<Record<string, unknown>>;
  };
  stored.fragments[0].text = "他很喜欢粉色筷子";
  writeFileSync(fragFile, JSON.stringify(stored), "utf8");
  const core2 = new MemoryCore({ dataDir: dir });
  const recalled = core2.recall("酸梅湯", { sessionId: "s2" });
  const hit = recalled.hits.find((h) => h.entry.id === e1.id);
  assert.ok(hit, "source entry still recalls");
  assert.equal(hit?.fragmentFallback, true, "hit marked as a fragment fallback");
  assert.ok(recalled.text.includes("酸梅湯真好喝"), "verbatim source injected instead of the fragment");
  assert.ok(!recalled.text.includes("粉色筷子"), "the tampered fragment text never reaches context");
  assert.ok(recalled.text.includes("·原文"), "injected block marks the fallback");
  core2.flush();
  const after = JSON.parse(readFileSync(fragFile, "utf8")) as {
    fragments: Array<{ suspect?: boolean; suspectReason?: string }>;
  };
  assert.equal(after.fragments[0].suspect, true, "fragment marked suspect on disk after flush");
  assert.ok((after.fragments[0].suspectReason ?? "").length > 0, "suspect reason recorded");
  assert.equal(core2.stats().suspectFragments, 1, "stats count the suspect fragment");
  // A suspect fragment is never injected again: the next recall
  // goes straight to the verbatim source without re-marking.
  const recalled2 = core2.recall("酸梅湯", { sessionId: "s2" });
  const hit2 = recalled2.hits.find((h) => h.entry.id === e1.id);
  assert.equal(hit2?.fragmentFallback, true, "suspect fragment still falls back on the next recall");
  console.log("PASS 0.3.0 fragment: stale/mismatched fragment falls back to the verbatim source and is marked suspect");
}

// m-1 (review-12): the same fallback on a COMPRESSED entry must
// inject the verbatim original, not the one-line summary. Before
// the fix the push used `fragmentId !== undefined ? displayText :
// summary`, so with the fragment gone the injected text was the
// summary (first sentence only) while the mark still said ·原文.
{
  const dir = mkdtempSync(join(tmpdir(), "memory-core-m1-fallback-"));
  writeFileSync(join(dir, "MEMORY.md"), fixtureMemory030, "utf8");
  const core = new MemoryCore({ dataDir: dir });
  const e1 = core.record({ role: "user", text: "酸梅湯真好喝，今天特别开心。晚上吃了拉面，很满足。", window: "persona", sessionId: "s1", ts: local(2026, 9, 28, 10, 0) });
  const reviewed = core.review(true, local(2026, 11, 7, 9, 0));
  assert.ok(reviewed !== null && reviewed.ran, "review ran");
  assert.equal(reviewed.lastStats.compressed, 1, "the 40-day-old light entry compresses");
  const created = core.createFragment({
    sourceIds: [e1.id],
    text: "他很喜欢酸梅湯",
    tone: "很喜欢",
    quotes: ["真好喝"],
    topic: "酸梅湯",
  });
  assert.equal(created.ok, true, "setup fragment accepted");
  const fragFile = join(dir, "fragments.json");
  const stored = JSON.parse(readFileSync(fragFile, "utf8")) as {
    fragments: Array<Record<string, unknown>>;
  };
  stored.fragments[0].text = "他很喜欢粉色筷子";
  writeFileSync(fragFile, JSON.stringify(stored), "utf8");
  const core2 = new MemoryCore({ dataDir: dir });
  const recalled = core2.recall("酸梅湯", { sessionId: "s2" });
  const hit = recalled.hits.find((h) => h.entry.id === e1.id);
  assert.ok(hit, "compressed source entry still recalls");
  assert.equal(hit?.fragmentFallback, true, "hit marked as a fragment fallback");
  assert.equal(
    hit?.displayText,
    "酸梅湯真好喝，今天特别开心。晚上吃了拉面，很满足。",
    "fallback injects the verbatim original, not the compressed summary",
  );
  assert.equal(hit?.compressed, false, "a fallback hit is not a compressed hit");
  assert.ok(recalled.text.includes("晚上吃了拉面"), "the second sentence survives (the summary drops it)");
  assert.ok(recalled.text.includes("·原文"), "injected block marks the fallback ·原文");
  assert.ok(!recalled.text.includes("粉色筷子"), "the tampered fragment text never reaches context");
  console.log("PASS m-1 (review-12): compressed entry + invalid fragment falls back to the verbatim original, marked ·原文");
}

// Recall injection prefers fragments, and costs fewer tokens.
{
  const dir = mkdtempSync(join(tmpdir(), "memory-core-030-inject-"));
  writeFileSync(join(dir, "MEMORY.md"), fixtureMemory030, "utf8");
  const core = new MemoryCore({ dataDir: dir });
  const long1 = "今天中午和朋友一起去喝酸梅湯，酸梅湯真好喝，喝了三大杯，聊了很久的天，还说明天再来喝一次酸梅湯";
  const long2 = "晚上回家路上又买了一杯酸梅湯，酸梅湯真好喝，冰冰凉凉的特别解渴，喝完心情都变好了很多";
  const e1 = core.record({ role: "user", text: long1, window: "persona", sessionId: "s1", ts: local(2026, 11, 5, 10, 0) });
  const e2 = core.record({ role: "user", text: long2, window: "persona", sessionId: "s1", ts: local(2026, 11, 5, 10, 5) });
  const created = core.createFragment({
    sourceIds: [e1.id, e2.id],
    text: "他很喜欢酸梅湯",
    tone: "很喜欢",
    quotes: ["真好喝"],
    topic: "酸梅湯",
  });
  assert.equal(created.ok, true, "setup fragment accepted");
  const r = core.recall("酸梅湯", { sessionId: "s2" });
  assert.ok(r.hits.length >= 1, "hits surface");
  assert.ok(r.hits.every((h) => h.fragmentId === created.fragment?.id), "every hit injects the fragment");
  assert.ok(r.text.includes("他很喜欢酸梅湯"), "injected text is the fragment");
  assert.ok(r.text.includes("·片段·很喜欢"), "injected block carries the fragment + tone marker");
  assert.ok(!r.text.includes(long1) && !r.text.includes(long2), "the full originals are NOT injected");
  const verbatimCost = r.hits.reduce(
    (n, h) => n + estimateTokens(h.entry.text) + 8,
    0,
  );
  assert.ok(
    r.estimatedTokens < verbatimCost,
    `fragment injection (${r.estimatedTokens} tokens) is cheaper than verbatim (${verbatimCost} tokens)`,
  );
  // One fragment injected once: two source entries of the same
  // fragment do not inject the same fragment text twice.
  assert.equal(
    r.text.split("他很喜欢酸梅湯").length - 1,
    1,
    "the fragment text appears exactly once in the injected block",
  );
  console.log("PASS 0.3.0 fragment: recall injects the fragment (not the full originals) at a lower token cost");
}

// Starmap: fragments are stars; clicking one shows its text + tone
// + the source log entries. Unfragmented entries still appear.
{
  const dir = mkdtempSync(join(tmpdir(), "memory-core-030-starmap-"));
  writeFileSync(join(dir, "MEMORY.md"), fixtureMemory030, "utf8");
  const core = new MemoryCore({ dataDir: dir });
  const e1 = core.record({ role: "user", text: "酸梅湯真好喝", window: "persona", sessionId: "s1", ts: local(2026, 11, 5, 10, 0) });
  const e2 = core.record({ role: "user", text: "昨天又喝了酸梅湯，还是那么好喝", window: "persona", sessionId: "s1", ts: local(2026, 11, 5, 10, 1) });
  const e3 = core.record({ role: "user", text: "今晚吃拉面", window: "persona", sessionId: "s1", ts: local(2026, 11, 5, 10, 2) });
  const created = core.createFragment({
    sourceIds: [e1.id, e2.id],
    text: "他很喜欢酸梅湯",
    tone: "很喜欢",
    quotes: ["真好喝"],
    topic: "酸梅湯",
  });
  assert.equal(created.ok, true, "setup fragment accepted");
  const sm = core.generateStarmap();
  const html = readFileSync(sm.path, "utf8");
  assert.equal(sm.nodes, 2, "one fragment star + one unfragmented entry star (2 sources fold into 1)");
  assert.ok(html.includes("他很喜欢酸梅湯"), "fragment text embedded in the map");
  assert.ok(html.includes(created.fragment?.id as string), "fragment id embedded");
  assert.ok(html.includes(e1.id) && html.includes(e2.id), "fragment sourceIds embedded (click-through to the originals)");
  assert.ok(html.includes("酸梅湯真好喝"), "source entry text embedded for the detail panel");
  assert.ok(html.includes("今晚吃拉面"), "unfragmented entry still appears as a star");
  assert.ok(html.includes("很喜欢"), "fragment tone label embedded");
  assert.ok(html.includes("原文"), "detail panel shows the source entries");
  console.log("PASS 0.3.0 starmap: fragments are stars with source click-through; unfragmented entries still appear");
}

// Review proposes fragment clusters (it never creates fragments
// itself — creation goes through the same verified tool path).
{
  const dir = mkdtempSync(join(tmpdir(), "memory-core-030-review-"));
  writeFileSync(join(dir, "MEMORY.md"), fixtureMemory030, "utf8");
  const core = new MemoryCore({ dataDir: dir });
  const e1 = core.record({ role: "user", text: "酸梅湯真好喝", window: "persona", sessionId: "s1", ts: local(2026, 11, 5, 10, 0) });
  const e2 = core.record({ role: "user", text: "昨天又喝了酸梅湯，还是那么好喝", window: "persona", sessionId: "s1", ts: local(2026, 11, 5, 10, 1) });
  const reviewed = core.review(true, local(2026, 11, 7, 9, 0));
  assert.ok(reviewed !== null && reviewed.ran, "review ran");
  const cand = (reviewed.fragmentCandidates ?? []).find((c) =>
    c.sourceIds.includes(e1.id) && c.sourceIds.includes(e2.id),
  );
  assert.ok(cand, `review proposes the 酸梅湯 cluster, got ${JSON.stringify(reviewed.fragmentCandidates)}`);
  // Once those entries are folded into a fragment, the review
  // stops proposing them.
  const created = core.createFragment({
    sourceIds: [e1.id, e2.id],
    text: "他很喜欢酸梅湯",
    tone: "很喜欢",
    quotes: ["真好喝"],
    topic: "酸梅湯",
  });
  assert.equal(created.ok, true, "setup fragment accepted");
  const reviewed2 = core.review(true, local(2026, 11, 8, 9, 0));
  assert.ok(
    !(reviewed2?.fragmentCandidates ?? []).some((c) =>
      c.sourceIds.includes(e1.id) || c.sourceIds.includes(e2.id),
    ),
    "fragmented entries are no longer proposed",
  );
  console.log("PASS 0.3.0 review: proposes fragment clusters, never proposes already-fragmented entries");
}

// m-7 (review-12): fragment candidates only ever come from persona
// entries — task-window entries sharing a rare token must not be
// proposed, because M-1 now hands the candidates to the model in
// the daily review prompt, and task content must never reach her
// that way.
{
  const dir = mkdtempSync(join(tmpdir(), "memory-core-030-cand-persona-"));
  writeFileSync(join(dir, "MEMORY.md"), fixtureMemory030, "utf8");
  const core = new MemoryCore({ dataDir: dir });
  const p1 = core.record({ role: "user", text: "紫罗兰真好看", window: "persona", sessionId: "s1", ts: local(2026, 11, 5, 10, 0) });
  const p2 = core.record({ role: "user", text: "又买了一束紫罗兰", window: "persona", sessionId: "s1", ts: local(2026, 11, 5, 10, 1) });
  const t1 = core.record({ role: "user", text: "黑曜石手链到了", window: "task", sessionId: "s2", ts: local(2026, 11, 5, 10, 2) });
  const t2 = core.record({ role: "user", text: "黑曜石手链很沉", window: "task", sessionId: "s2", ts: local(2026, 11, 5, 10, 3) });
  const reviewed = core.review(true, local(2026, 11, 7, 9, 0));
  assert.ok(reviewed !== null && reviewed.ran, "review ran");
  const cands = reviewed.fragmentCandidates ?? [];
  assert.ok(
    cands.some((c) => c.sourceIds.includes(p1.id) && c.sourceIds.includes(p2.id)),
    `persona 紫罗兰 cluster proposed, got ${JSON.stringify(cands)}`,
  );
  assert.ok(
    !cands.some((c) => c.sourceIds.includes(t1.id) || c.sourceIds.includes(t2.id)),
    "no candidate contains a task-window entry",
  );
  console.log("PASS m-7 (review-12): fragment candidates exclude task-window entries");
}

// Snapshots cover fragments.json: a restore brings fragments back.
{
  const dir = mkdtempSync(join(tmpdir(), "memory-core-030-snap-"));
  writeFileSync(join(dir, "MEMORY.md"), fixtureMemory030, "utf8");
  const core = new MemoryCore({ dataDir: dir });
  const e1 = core.record({ role: "user", text: "酸梅湯真好喝", window: "persona", sessionId: "s1", ts: local(2026, 11, 5, 10, 0) });
  const created = core.createFragment({
    sourceIds: [e1.id],
    text: "他很喜欢酸梅湯",
    tone: "很喜欢",
    quotes: ["真好喝"],
    topic: "酸梅湯",
  });
  assert.equal(created.ok, true, "setup fragment accepted");
  const snap = core.snapshot();
  const snapFiles = readdirSync(join(dir, ".snapshots", snap));
  assert.ok(snapFiles.includes("fragments.json"), `snapshot carries fragments.json, got ${JSON.stringify(snapFiles)}`);
  console.log("PASS 0.3.0 snapshot: fragments.json is snapshotted with the log");
}

// 0.3.0 free-form emotion downstream: the lexicon is UNCHANGED
// (a coarse fallback only — the model tags in its own words), but
// the activation factor and the starmap handle arbitrary words.
check("0.3.0 free-form emotion: lexicon unchanged, polarity fallback in activation + starmap", () => {
  // The lexicon was NOT expanded: 傲娇/宠溺/忐忑 are not fallback
  // words — when the model is silent, the lexicon must not invent
  // them. (Free-form tagging is the model's job, not the lexicon's.)
  assert.equal(tagEmotion("他有点傲娇，又赌气不理我"), undefined, "lexicon does not tag 傲娇/赌气");
  assert.equal(tagEmotion("今天特别开心")?.type, "开心", "old lexicon words still tag");
  assert.equal(tagEmotion("恐怕要下雨了"), undefined, "single-char exclusions still hold (恐怕)");
  // Activation: exact match 1.0, same polarity 0.7, opposite 0.2,
  // unknown polarity on either side 0.5 (neither match nor mismatch).
  assert.equal(emotionFactor({ type: "委屈", intensity: 0.7 }, { type: "委屈", intensity: 0.7 }), 1, "exact match");
  assert.equal(emotionFactor({ type: "委屈", intensity: 0.7 }, { type: "难过", intensity: 0.7 }), 0.7, "same polarity (negative) is close, not a mismatch");
  assert.equal(emotionFactor({ type: "委屈", intensity: 0.7 }, { type: "开心", intensity: 0.7 }), 0.2, "opposite polarity is a mismatch");
  assert.equal(emotionFactor({ type: "傲娇", intensity: 0.6 }, { type: "开心", intensity: 0.6 }), 0.5, "explicitly neutral polarity is neither a match nor a mismatch");
  assert.equal(emotionFactor({ type: "傲娇", intensity: 0.6 }, { type: "难过", intensity: 0.6 }), 0.5, "neutral vs negative is also neutral");
  assert.equal(emotionPolarity("宠溺"), "positive", "polarity knows free-form positive words");
  assert.equal(emotionPolarity("忐忑"), "negative", "polarity knows free-form negative words");
  assert.equal(emotionPolarity("some-made-up-word"), undefined, "a wholly unknown word has no polarity");
  // Starmap colour: known map first, polarity fallback, then default.
  assert.equal(emotionColor("委屈"), "#8aa8ff", "known type keeps its map colour");
  assert.equal(emotionColor("宠溺"), "#ffd166", "free-form positive word gets the positive colour");
  assert.equal(emotionColor("失落"), "#7aa7ff", "free-form negative word gets the negative colour");
  assert.equal(emotionColor("some-made-up-word"), "#e8ecff", "a wholly unknown word still renders a star (default colour)");
  assert.equal(emotionColor(undefined), "#e8ecff", "untagged still renders");
  // Key-term extraction ignores tone words and stopword bigrams.
  assert.deepEqual(fragmentKeyTerms("他很喜欢酸梅湯"), ["酸梅", "梅湯"], "tone words stripped, no glued bigrams");
  assert.deepEqual(fragmentKeyTerms("他很喜欢粉色筷子"), ["粉色", "色筷", "筷子"], "contamination terms extracted, so the check can catch them");
});

console.log(`\nALL PASS (0.3.0 additions)`);
