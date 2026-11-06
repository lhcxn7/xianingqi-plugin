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
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  KeywordIndex,
  MemoryCore,
  acquireWriteLock,
  isLockStale,
  listTempLeftovers,
  lockDirPath,
  normalizeForDedupe,
  parseArchiveText,
  parseMemoryText,
  pruneSnapshots,
  restoreSnapshot,
  snapshotComplete,
  tokenize,
} from "../src/index.ts";

const local = (y: number, m: number, d: number, hh: number, mm: number) =>
  new Date(y, m - 1, d, hh, mm).getTime();

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
  assert.equal(
    coreR.recall("alpha", { limit: 100, tokenCap: 100000 }).hits.length,
    50,
  );
  assert.equal(
    coreR.recall("beta", { limit: 100, tokenCap: 100000 }).hits.length,
    50,
  );
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

console.log(`\nALL PASS (0.1.6 additions, data dir: ${dir5})`);
