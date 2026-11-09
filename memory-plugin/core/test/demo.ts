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
  appendFileSync,
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
  AppendLog,
  BeliefStore,
  buildProactPrompt,
  buildReflectionPrompt,
  buildStarmapData,
  checkGuardrails,
  deliver,
  extractReflectionQuotes,
  FragmentStore,
  KeywordIndex,
  LOOP_FILE,
  LOOP_MAX_PENDING,
  LOOP_TRIGGER_COOLDOWN_MS,
  LoopStore,
  MemoryCore,
  MemoryGraph,
  MAX_STARMAP_NODES,
  MODEL_REVIEW_CATEGORIES,
  acquireWriteLock,
  attentionFactor,
  buildModelReviewPrompt,
  clarityLambda,
  COMMON_TOKENS,
  computeActivation,
  contentTokens,
  detailLambda,
  emotionColor,
  emotionFactor,
  emotionLambda,
  emotionPolarity,
  emotionRetain,
  estimateTokens,
  factLambda,
  formatBeliefLine,
  formatLayer1,
  formatProfileBlock,
  formatRecallBlock,
  fragmentKeyTerms,
  initialSignificance,
  invalidateEntries,
  isExpired,
  isLockStale,
  listTempLeftovers,
  loadProfile,
  loadReviewState,
  loadSummaries,
  lockDirPath,
  mergeProfile,
  normalizeForDedupe,
  parseArchiveText,
  parseMemoryText,
  parseModelReviewIds,
  parseProactDecision,
  parseToneLabel,
  PROACT_PROMPT_TTL_MS,
  PROFILE_FILE,
  pruneSnapshots,
  recallFromEntries,
  recordOutcome,
  REFLECTION_MIN_FLOOR,
  reflectionGate,
  renderStarmapHtml,
  restoreSnapshot,
  retrievability,
  saveProfile,
  saveReflection,
  selectCappedEntries,
  selectSpotlightCandidates,
  snapshotComplete,
  summarizeBeliefs,
  tagEmotion,
  tokenize,
  verifyBeliefEvidence,
  verifyReflection,
} from "../src/index.ts";
import { timeFactor } from "../src/activation.ts";
import type { MemoryEntry, RecallHit } from "../src/index.ts";

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
// 0.4.4 (0.4.3 audit issue 1): the model ACTUALLY writes "- [HH:MM]"
// (dash + bracketed time) — the fixture now uses that shape for
// half the entries, bare "[HH:MM]" for the other half, so both
// shapes are covered and this bug cannot come back silently.
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

- [09:12] 以后每周五查岗
[09:13] 好，每周五查

## 2026/11/05

- [08:01] 今天天气不错
[08:02] 嗯，适合出门

## 旧月份总结区

- 2026-10: 共 8 条，其中重要 2 条；大事：摩天轮初吻
`;

const realArchive = `# 记忆归档 2026-10

## 2026/10/28

- [21:30] 摩天轮初吻，在最高处
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

// 0.4.4 (0.4.3 audit issue 1): a real MEMORY.md has 74 layer-2
// entries, all in the "- [HH:MM]" shape the model actually writes —
// the 0.4.3 parser read 0 of them (layer2Count 0, memory_status
// "最近 30 天条数" stuck at 0, layer-2 dedup dead). Build the 74
// programmatically across three dates; every one must parse, and
// the core must see all 74.
check("parser reads 74 real '- [HH:MM]' entries (0.4.3 audit issue 1)", () => {
  const lines = ["# MEMORY", "", "## 最近30天", ""];
  const dates = ["2026/11/05", "2026/11/06", "2026/11/07"];
  for (let i = 0; i < 74; i++) {
    if (i % 25 === 0) lines.push(`## ${dates[Math.floor(i / 25)] ?? dates[2]}`, "");
    const hh = String(8 + Math.floor(i / 6)).padStart(2, "0");
    const mm = String((i * 7) % 60).padStart(2, "0");
    lines.push(`- [${hh}:${mm}] 真实记忆第${i + 1}条`);
  }
  const text74 = lines.join("\n");
  const parsed74 = parseMemoryText(text74);
  assert.equal(parsed74.layer2.length, 74, "all 74 real-shape entries parse");
  assert.equal(parsed74.layer2[0].text, "真实记忆第1条");
  assert.equal(parsed74.layer2[0].time, "08:00");
  const dir74 = mkdtempSync(join(tmpdir(), "memory-core-real-74-"));
  writeFileSync(join(dir74, "MEMORY.md"), text74, "utf8");
  const core74 = new MemoryCore({ dataDir: dir74 });
  assert.equal(core74.stats().layer2Count, 74, "layer2Count is 74, not 0");
  // And the same shape in an archive parses too (parseArchiveText
  // shares the line parser — the next monthly archive must recall).
  const archive74 = `# 记忆归档 2026-10\n\n## 2026/10/28\n\n- [21:30] 归档记忆第一条\n- [21:31] 归档记忆第二条\n`;
  const archived74 = parseArchiveText("2026-10", archive74);
  assert.equal(archived74.length, 2, "dash-shape archive rows parse");
  assert.equal(archived74[0].source, "archive");
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

check("0.4.3 snapshot: profile.json is snapshotted and restored; audit / beliefs / loop still are not", () => {
  const dirS = mkdtempSync(join(tmpdir(), "memory-core-snapshot-profile-"));
  writeFileSync(join(dirS, "MEMORY.md"), fixtureMemory, "utf8");
  const coreS = new MemoryCore({ dataDir: dirS });
  coreS.updateProfile({ name: "快照前", stage: "早期" });
  // The three still-excluded files, placed with marker content so
  // the snapshot-contents assertion reads the filename rule, not
  // the absence of the files.
  writeFileSync(join(dirS, "invalidation-audit.jsonl"), "{}\n", "utf8");
  writeFileSync(join(dirS, "beliefs.json"), JSON.stringify({ version: 1, beliefs: [] }), "utf8");
  writeFileSync(join(dirS, "loop.json"), JSON.stringify({ version: 1, pendingActions: [] }), "utf8");
  const snap = coreS.snapshot();
  const snapFiles = readdirSync(join(dirS, ".snapshots", snap));
  assert.ok(snapFiles.includes("profile.json"), `snapshot carries profile.json, got ${JSON.stringify(snapFiles)}`);
  assert.ok(!snapFiles.includes("invalidation-audit.jsonl"), "audit trail is never snapshotted");
  assert.ok(!snapFiles.includes("beliefs.json"), "beliefs are never snapshotted");
  assert.ok(!snapFiles.includes("loop.json"), "loop state is never snapshotted");
  // Change the profile, restore, and the profile comes back.
  coreS.updateProfile({ name: "快照后", stage: "中期" });
  assert.equal(coreS.readLayer1().name, "快照后", "profile changed after the snapshot");
  coreS.restore(snap);
  assert.equal(coreS.readLayer1().name, "快照前", "restore brings the profile back");
  assert.equal(coreS.readLayer1().stage, "早期", "restore brings the profile stage back");
  // The excluded files were never in the snapshot, so the restore
  // leaves the live copies exactly as they were.
  assert.equal(readFileSync(join(dirS, "beliefs.json"), "utf8"), JSON.stringify({ version: 1, beliefs: [] }), "restore leaves beliefs.json alone");
  assert.equal(readFileSync(join(dirS, "loop.json"), "utf8"), JSON.stringify({ version: 1, pendingActions: [] }), "restore leaves loop.json alone");
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
  // (Pre-existing time-bomb, fixed 2026-11-08: the first review
  // above passes an explicit now of 2026-11-07 09:00, but the
  // second call used the real clock, so it started running — and
  // failing this check — once real time passed 24h after that
  // fixed instant. Pass an explicit now 3h later instead, so the
  // 24h gate is deterministic and independent of the real clock.)
  assert.equal(core22.review(false, local(2026, 11, 7, 12, 0)), null, "second review within 24h is skipped");
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

// 0.3.1 拾光: DATA lives inside the single inline <script> as
// `const DATA = {...};`. Extract it with a brace matcher that
// respects strings, so a memory text containing "};" cannot cut
// the parse short.
function extractShiguangData(html: string): any {
  const marker = "const DATA = ";
  const start = html.indexOf(marker);
  assert.ok(start >= 0, "const DATA found in rendered HTML");
  let i = start + marker.length;
  assert.equal(html[i], "{", "DATA starts with {");
  let depth = 0;
  let inStr: string | null = null;
  let esc = false;
  for (; i < html.length; i++) {
    const ch = html[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inStr = ch;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        i++;
        break;
      }
    }
  }
  return JSON.parse(html.slice(start + marker.length, i));
}

// Starmap (static, 0.3.1 拾光): real data, real edges, no external
// URLs; the page is the 拾光 UI with DATA injected, nothing else.
// Closed-world check: DATA may hold only the memories this test
// recorded itself — no foreign data of any kind can slip in.
const dir24 = mkdtempSync(join(tmpdir(), "memory-core-020-starmap-"));
writeFileSync(join(dir24, "MEMORY.md"), fixtureMemory020, "utf8");
const core24 = new MemoryCore({ dataDir: dir24 });
core24.record({ role: "user", text: "酸梅汤真好喝", window: "persona", sessionId: "s1", ts: local(2026, 11, 5, 10, 0) });
core24.record({ role: "user", text: "今晚吃拉面", window: "persona", sessionId: "s1", ts: local(2026, 11, 5, 10, 1) });
core24.recall("酸梅汤", { sessionId: "s2" });
core24.record({ role: "user", text: "明天要去爬山", window: "persona", sessionId: "s2", ts: local(2026, 11, 5, 10, 2) });
const starmap = core24.generateStarmap();
const starmapHtml = readFileSync(starmap.path, "utf8");
const starmapData = extractShiguangData(starmapHtml);

check("0.3.1 starmap (拾光): generated from real graph+attributes+log, no external URLs, 拾光 UI", () => {
  assert.equal(starmap.nodes, 3, "3 stars");
  assert.equal(starmap.edges, 2, "session + recall edges");
  assert.equal(starmapData.memories.length, 3, "DATA carries the 3 stars");
  assert.equal(starmapData.edges.length, 2, "DATA carries the 2 edges");
  assert.ok(starmapHtml.includes("酸梅汤真好喝"), "real memory text embedded");
  assert.ok(starmapHtml.includes("明天要去爬山"), "real memory text embedded");
  assert.ok(starmapHtml.includes('"from"'), "edges embedded as data");
  assert.ok(!starmapHtml.includes("http://") && !starmapHtml.includes("https://"), "no external URLs anywhere");
  assert.ok(starmapHtml.includes("<title>拾光</title>"), "拾光 title present");
  assert.ok(starmapHtml.includes("window.__map"), "__map handle exposed");
  assert.equal(starmapData.self, "夏柠柒", "self is 夏柠柒");
  assert.equal(starmapData.user, "你", "user defaults to 你");
  assert.deepEqual(starmapData.traces, [], "traces empty, never invented");
  const knownTexts = new Set(["酸梅汤真好喝", "今晚吃拉面", "明天要去爬山"]);
  assert.ok(
    starmapData.memories.every((m: any) => knownTexts.has(m.text)),
    "DATA holds only the test's own memories, nothing foreign",
  );
  assert.ok(!starmapHtml.includes("时间流速"), "old time-flow slider gone");
  assert.ok(!starmapHtml.includes("常用词"), "old 常用词 field gone");
  assert.ok(!starmapHtml.includes("recall-input"), "old recall input gone");
  assert.ok(!starmapHtml.includes("__starmap"), "old drift handle gone");
  assert.ok(!starmapHtml.includes('<line class="edge"'), "old SVG edge lines gone");
  assert.ok(!starmapHtml.includes('id="map"'), "old SVG map element gone");
  assert.ok(existsSync(join(dir24, "starmap.html")), "starmap.html lives in the data dir");
});

// ---- 0.3.1 拾光 starmap functional test (async) -------------------
// The generated HTML is the real 拾光 page: canvas galaxy, drag to
// rotate, click a star to open the bottom detail panel. Run its
// inline script in node:vm against a minimal DOM stub (canvas 2D
// context as a no-op Proxy, rAF bounded to a few frames so the
// intro loop terminates) and drive it like a user.
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
    getContext: () => ctxStub,
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

// 0.3.1 拾光 runs on a <canvas>: the 2D context is a no-op Proxy
// (gradients get a stub with addColorStop, measureText a width),
// so the galaxy can draw without a real canvas. makeFakeEl's
// getContext above returns this stub for every element.
const gradientStub = { addColorStop: () => {} };
const ctxStub: any = new Proxy(
  {},
  {
    get: (_target: any, prop: string) => {
      if (prop === "createRadialGradient" || prop === "createLinearGradient") return () => gradientStub;
      if (prop === "measureText") return () => ({ width: 0 });
      if (prop === "getImageData") return () => ({ data: [] });
      return () => {};
    },
    set: () => true,
  },
);

// Run a rendered 拾光 page in node:vm with the stub DOM above and
// return the live handles: __map, the canvas, and the panel els.
// rAF is bounded to a few frames so the intro loop terminates;
// the two resize setTimeouts (300/1500ms) are harmless.
function driveShiguangHtml(html: string, search = ""): any {
  const scriptMatch = /<script>([\s\S]*?)<\/script>/.exec(html);
  assert.ok(scriptMatch, "inline script block found");
  const els = new Map<string, any>();
  const mk = (id: string) => {
    const e = makeFakeEl();
    els.set(id, e);
    return e;
  };
  const cv = mk("c");
  cv.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600 });
  cv.clientWidth = 800;
  cv.clientHeight = 600;
  cv.setPointerCapture = () => {};
  cv.hasPointerCapture = () => false;
  cv.releasePointerCapture = () => {};
  const panel = mk("panel");
  const pTitle = mk("pTitle");
  const pDate = mk("pDate");
  const pBadge = mk("pBadge");
  const pBody = mk("pBody");
  const stat = mk("stat");
  mk("fs");
  mk("replay");
  mk("vert");
  mk("stage");
  mk("tools");
  const labelsEl = mk("labels");

  let nowMs = 1000;
  let rafFrames = 0;
  let lastCb: any = null;
  const sandbox: any = {
    console,
    setTimeout,
    setInterval,
    clearTimeout,
    clearInterval,
    performance: { now: () => (nowMs += 16) },
    location: { search },
    requestAnimationFrame: (cb: any) => {
      lastCb = cb;
      if (rafFrames++ >= 12) return 0;
      cb((nowMs += 16));
      return rafFrames;
    },
    ResizeObserver: class {
      constructor(_cb: any) {}
      observe() {}
      unobserve() {}
      disconnect() {}
    },
    devicePixelRatio: 1,
    document: {
      getElementById: (id: string) => els.get(id) ?? null,
      createElement: (tag: string) => makeFakeEl(tag),
      addEventListener: () => {},
      hidden: false,
    },
    addEventListener: () => {},
  };
  sandbox.window = sandbox;
  createContext(sandbox);
  new Script(scriptMatch[1]).runInContext(sandbox);
  return {
    map: sandbox.window.__map,
    cv, panel, pTitle, pDate, pBadge, pBody, stat, els,
    labelsEl,
    // 0.4.2: the rAF stub runs 12 frames synchronously at load,
    // then stops invoking; stepFrames re-runs the captured loop
    // callback so a test can advance time (e.g. after setDist)
    // without a real clock. With ?t=5 the intro is frozen at 5s
    // and dist follows distGoal on the next frame.
    stepFrames: (n: number) => {
      for (let i = 0; i < n; i++) {
        if (!lastCb) break;
        const cb = lastCb;
        lastCb = null;
        cb((nowMs += 16));
      }
    },
  };
}

// Click a star on a driven page: project its 3D position to the
// screen, then pointerdown + pointerup at the same spot (<6px).
function clickShiguangStar(d: any, star: any): void {
  const p = d.map.project(star.x, star.y, star.z);
  assert.ok(p, "star projects onto the screen");
  d.cv.fire("pointerdown", { clientX: p.x, clientY: p.y, pointerId: 1 });
  d.cv.fire("pointerup", { clientX: p.x, clientY: p.y, pointerId: 1 });
}

const starmapTest = (async () => {
  const data = starmapData;
  assert.equal(data.memories.length, 3, "stub sees the 3 real memories");
  const d = driveShiguangHtml(starmapHtml);
  const { map, cv, panel, pTitle, pDate, pBadge, pBody, stat } = d;
  assert.ok(map, "__map handle exposed");
  assert.equal(map.stars.length, 3, "3 stars built");
  assert.ok(stat.textContent.includes("3 颗记忆"), "stat shows 3 颗记忆");
  assert.ok(!stat.textContent.includes("全部"), "stat shows no cap when uncapped");

  // Click a star: the detail panel opens with the memory.
  const seedMem = data.memories.find((m: any) => m.text.includes("酸梅汤"));
  const seedStar = map.stars.find((s: any) => s.id === seedMem.id);
  const p = map.project(seedStar.x, seedStar.y, seedStar.z);
  assert.ok(p, "seed star projects onto the screen");
  clickShiguangStar(d, seedStar);
  assert.ok(panel.classList.contains("on"), "panel opens on star click");
  assert.ok(pBody.textContent.includes("酸梅汤真好喝"), "panel shows the memory text");
  assert.ok(pTitle.textContent.includes("酸梅汤"), "panel title shows the memory");
  assert.equal(pBadge.textContent, "酸梅", "0.4.2 P8: panel badge shows the keyword only, no 约定. prefix");
  assert.ok(seedMem.key.startsWith("约定."), "0.4.2 P8: DATA key keeps the prefix — only the display strips it");
  assert.ok(pDate.textContent.length > 0, "panel date shows");

  // Hover over the star: cursor turns to pointer.
  cv.fire("pointermove", { clientX: p.x, clientY: p.y });
  assert.equal(cv.style.cursor, "pointer", "hover over a star shows pointer cursor");

  // Drag: theta moves with the pointer.
  const thetaBefore = map.state().theta;
  cv.fire("pointerdown", { clientX: 400, clientY: 300, pointerId: 2 });
  cv.fire("pointermove", { clientX: 430, clientY: 300 });
  cv.fire("pointerup", { clientX: 430, clientY: 300, pointerId: 2 });
  assert.ok(Math.abs(map.state().theta - thetaBefore) > 0.05, "drag rotates the galaxy");

  // Click empty space: the panel closes.
  const far = [
    [5, 5],
    [795, 5],
    [5, 595],
    [795, 595],
    [400, 5],
  ].find(([x, y]: number[]) =>
    map.stars.every((s: any) => {
      const q = map.project(s.x, s.y, s.z);
      return !q || Math.hypot(q.x - x, q.y - y) > 40;
    }),
  );
  assert.ok(far, "an empty corner exists");
  cv.fire("pointerdown", { clientX: far[0], clientY: far[1], pointerId: 3 });
  cv.fire("pointerup", { clientX: far[0], clientY: far[1], pointerId: 3 });
  assert.ok(!panel.classList.contains("on"), "clicking empty space closes the panel");
  console.log("PASS 0.3.1 starmap (拾光): canvas galaxy — click panel, hover, drag, empty click (vm)");
})();

await starmapTest;

// ---- 0.3.1 拾光 mapping unit tests --------------------------------
// buildStarmapData maps plugin data -> 拾光 DATA. Test the mapping
// directly, with hand-built entries/attrs, so each rule is pinned.
// Test data is the same neutral 夏柠柒 sample set used everywhere
// else (酸梅汤 / 拉面 / 奖学金 / 爬山); nothing foreign.
function mkMapEntry(id: string, text: string, role: "user" | "assistant", ts: number): any {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    id,
    ts,
    date: `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
    role,
    window: "persona",
    sessionId: "s1",
    importance: "light",
    text,
  };
}
function mkMapAttrs(id: string, significance: number, extra: any = {}): [string, any] {
  return [id, { clarity: 1, recallCount: 0, significance, ...extra }];
}
const mapNow = local(2026, 11, 5, 12, 0);

check("0.3.1 mapping: imp clamps significance to [0,1]", () => {
  const e1 = mkMapEntry("e1", "酸梅汤真好喝", "user", mapNow);
  const e2 = mkMapEntry("e2", "今晚吃拉面", "user", mapNow + 60000);
  const e3 = mkMapEntry("e3", "明天要去爬山", "user", mapNow + 120000);
  const attrs = new Map([mkMapAttrs("e1", 2), mkMapAttrs("e2", -0.5), mkMapAttrs("e3", 0.9)]);
  const data = buildStarmapData([e1, e2, e3], [], attrs, mapNow);
  const byId = new Map(data.memories.map((m) => [m.id, m]));
  assert.equal(byId.get("e1")!.imp, 1, "significance 2 clamps to 1");
  assert.equal(byId.get("e2")!.imp, 0, "significance -0.5 clamps to 0");
  assert.equal(byId.get("e3")!.imp, 0.9, "0.9 passes through");
});

check("0.3.1 mapping: cat — fragment stable_profile, emotion with feeling, event otherwise", () => {
  const e1 = mkMapEntry("e1", "今天下雨了，有点难过", "user", mapNow);
  const e2 = mkMapEntry("e2", "今晚吃拉面", "user", mapNow + 60000);
  const attrs = new Map([
    mkMapAttrs("e1", 0.4, { emotion: { type: "难过", intensity: 0.8 } }),
    mkMapAttrs("e2", 0.4),
  ]);
  const frag: any = {
    id: "f1",
    sourceIds: ["e2"],
    text: "他很喜欢拉面",
    tone: { label: "很喜欢", level: "unknown", intensity: 0.9 },
    quotes: ["拉面"],
    topic: "拉面",
    keywords: ["拉面"],
    createdAt: mapNow,
    verified: true,
  };
  const data = buildStarmapData([e1, e2], [], attrs, mapNow, [frag]);
  const byId = new Map(data.memories.map((m) => [m.id, m]));
  assert.equal(byId.get("e1")!.cat, "emotion", "entry with emotion -> emotion");
  assert.equal(byId.get("f1")!.cat, "stable_profile", "fragment -> stable_profile");
  assert.ok(!data.memories.some((m) => m.cat === "other"), "other never emitted");
  assert.equal(data.memories.length, 2, "fragment folds its source: 1 fragment + 1 entry");
});

check("0.3.1 mapping: key/owner — assistant + fragments go ta.*, user goes 约定.*", () => {
  const u = mkMapEntry("u1", "酸梅汤真好喝", "user", mapNow);
  const a = mkMapEntry("a1", "今晚吃拉面", "assistant", mapNow + 60000);
  const attrs = new Map([mkMapAttrs("u1", 0.4), mkMapAttrs("a1", 0.4)]);
  const data = buildStarmapData([u, a], [], attrs, mapNow);
  const byId = new Map(data.memories.map((m) => [m.id, m]));
  assert.ok(byId.get("u1")!.key.startsWith("约定."), `user key is 约定.*: ${byId.get("u1")!.key}`);
  assert.ok(byId.get("a1")!.key.startsWith("ta."), `assistant key is ta.*: ${byId.get("a1")!.key}`);
  assert.equal(byId.get("u1")!.key, "约定.酸梅", "short keyword suffix, not the whole sentence");
  assert.equal(data.self, "夏柠柒", "self is 夏柠柒");
  assert.equal(data.user, "你", "user defaults to 你");
});

// review-15 m-2: the key suffix is picked by document frequency
// across this batch of stars — the most-shared word wins, ties
// break by longest, then latest-appearing. The old "first short
// token" rule produced sliced bigrams (天要 / 天拿 / 天下 / 奖学 /
// 你说 / 第一) on the 14-sample page; all six are gone here.
// Each pair below is its own batch, so the shared word is pinned.
check("0.3.1 mapping: key suffix picks the shared keyword (DF), not a sliced bigram", () => {
  const pair = (t1: string, t2: string) => {
    const e1 = mkMapEntry("e1", t1, "user", mapNow);
    const e2 = mkMapEntry("e2", t2, "user", mapNow + 60000);
    const attrs = new Map([mkMapAttrs("e1", 0.4), mkMapAttrs("e2", 0.4)]);
    const data = buildStarmapData([e1, e2], [], attrs, mapNow);
    return new Map(data.memories.map((m) => [m.id, m]));
  };
  // 爬山 is shared by both hiking stars; the old rule took 天要.
  const c = pair("明天要去爬山，有点紧张", "爬山要带酸梅汤，解渴");
  assert.equal(c.get("e1")!.key, "约定.爬山", "shared 爬山, not 天要");
  // 奖学金 is a trigram the bigrams slice into 奖学 / 学金; the
  // DF pool includes trigrams, so the whole word wins.
  const j = pair("今天拿到奖学金，开心得睡不着", "奖学金请你吃拉面，说好了");
  assert.equal(j.get("e1")!.key, "约定.奖学金", "shared 奖学金, not 天拿");
  assert.equal(j.get("e2")!.key, "约定.奖学金", "shared 奖学金, not 奖学");
  // 安心 is shared; the old rule took 你说.
  const w = pair("你说晚安的时候我特别安心", "今晚吃拉面，暖暖的很安心");
  assert.equal(w.get("e1")!.key, "约定.安心", "shared 安心, not 你说");
  // 难过 is shared; the old rule took 天下.
  const r = pair("今天下雨了，有点难过", "上次吵架我很难过，你哄了我好久");
  assert.equal(r.get("e1")!.key, "约定.难过", "shared 难过, not 天下");
  // Full-batch guard: the 8 entries above share nothing else that
  // would resurrect a sliced badge.
  const entries = [
    mkMapEntry("c1", "明天要去爬山，有点紧张", "user", mapNow),
    mkMapEntry("c2", "爬山要带酸梅汤，解渴", "user", mapNow + 60000),
    mkMapEntry("j1", "今天拿到奖学金，开心得睡不着", "user", mapNow + 120000),
    mkMapEntry("j2", "奖学金请你吃拉面，说好了", "user", mapNow + 180000),
    mkMapEntry("w1", "你说晚安的时候我特别安心", "user", mapNow + 240000),
    mkMapEntry("w2", "今晚吃拉面，暖暖的很安心", "user", mapNow + 300000),
    mkMapEntry("r1", "今天下雨了，有点难过", "user", mapNow + 360000),
    mkMapEntry("r2", "上次吵架我很难过，你哄了我好久", "user", mapNow + 420000),
  ];
  const attrsAll = new Map(entries.map((e) => mkMapAttrs(e.id, 0.4)));
  const all = buildStarmapData(entries, [], attrsAll, mapNow);
  const bad = ["天要", "天拿", "天下", "奖学", "你说", "第一", "吃拉", "得睡不", "有点"];
  assert.ok(
    all.memories.every((m) => !bad.some((b) => m.key.endsWith(b))),
    "no sliced-bigram badge survives the full batch",
  );
});

check("0.3.1 mapping: key suffix falls back to the first clean content word when nothing is shared (0.4.2 P9)", () => {
  const e = mkMapEntry("e1", "今晚吃拉面", "user", mapNow);
  const data = buildStarmapData([e], [], new Map([mkMapAttrs("e1", 0.4)]), mapNow);
  assert.equal(data.memories[0].key, "约定.今晚", "single star: every word occurs once, fallback pool applies");
});

// review-16 N-2, ATTEMPTED AND REVERTED — do not "fix" this again
// without re-running the measurement. The review suggested the
// fallback prefer a 3-char candidate (酸梅 -> 酸梅汤). It was
// implemented and measured on the two sample pages before being
// reverted in the same round:
//   3mem page: 酸梅 -> 酸梅汤 (better), 今晚 -> 今晚吃 (worse),
//     天要 -> 要去爬 (same kind of slice);
//   14-sample page: 雨天 -> 雨天你 (worse), other 12 unchanged;
//   sliced badges total: 3 -> 3, a wash, not a fix.
// And the review's parenthetical — 明天要去爬山 falling back to
// the whole run — does not happen under its own rule: after the
// N-1 filter the surviving trigrams are 要去爬 / 去爬山, and the
// first 3-char candidate is 要去爬, so the whole run only wins
// when no 3-char candidate exists at all. Telling a complete
// 3-char word (酸梅汤) from a sliced one (今晚吃) needs a lexicon,
// which this plugin does not have.
// 0.4.2 P9 superseded the fallback itself (not the 3-char idea):
// the fallback pool is now curator words first, then clean
// content words (boundary rule), then the category name — the
// "first short keyword" fallback and its lone-star slices are
// gone. The three assertions below are UNCHANGED in value
// (酸梅 / 今晚 / 要去 are all clean words, so the new pool
// picks them too) — they still pin the reverted 3-char
// behaviour: 酸梅 stays 酸梅, not 酸梅汤. This test pins the
// reverted behaviour so a future attempt has to confront the
// measurement, not rediscover it silently.
check("0.3.1 mapping: N-2 3-char fallback was tried and reverted (review-16)", () => {
  const one = (text: string) => {
    const e = mkMapEntry("e1", text, "user", mapNow);
    return buildStarmapData([e], [], new Map([mkMapAttrs("e1", 0.4)]), mapNow).memories[0].key;
  };
  assert.equal(one("酸梅汤真好喝"), "约定.酸梅", "old fallback: sliced bigram, N-2 not shipped");
  assert.equal(one("今晚吃拉面"), "约定.今晚", "old fallback kept: 今晚, not 今晚吃");
  assert.equal(one("明天要去爬山"), "约定.要去", "review-17: 天要 is filtered from the pool now, fallback is 要去, not 要去爬 and not the whole run");
});

// review-16 N-1: trigrams overlapping a COMMON_TOKENS word never
// enter the DF pool, so a group of memories sharing only an opening
// like 今天我 / 明天要去 cannot collapse onto a function-word
// trigram. Each batch below is its own group.
check("0.3.1 mapping: key suffix never picks a function-word trigram (review-16 N-1)", () => {
  const batch = (texts: string[]) => {
    const entries = texts.map((t, i) => mkMapEntry(`e${i}`, t, "user", mapNow + i * 60000));
    const attrs = new Map(entries.map((e) => mkMapAttrs(e.id, 0.4)));
    return buildStarmapData(entries, [], attrs, mapNow).memories;
  };
  // Four memories opening with 今天我...: the shared trigrams
  // 今天我 / 天我去 are filtered (they overlap 今天); the shared
  // word left is the genuine verb 我去, not a function trigram.
  const a = batch(["今天我去买菜", "今天我去上班", "今天我去跑步", "今天我去看电影"]);
  assert.ok(a.every((m) => m.key === "约定.我去"), `今天我 group shares 我去, got ${a.map((m) => m.key).join(" ")}`);
  assert.ok(a.every((m) => !/今天我|天我去/.test(m.key)), "no 今天我 / 天我去 badge");
  // Two memories opening with 明天要去...: 明天要 / 天要去 are
  // filtered (they overlap 明天); the shared word left is 要去.
  // Note the review's own example: 天要去 does NOT start with a
  // common word, it only overlaps one — a starts-with filter
  // would have missed it, so the filter is overlap, not prefix.
  const b = batch(["明天要去爬山", "明天要去游泳"]);
  assert.ok(b.every((m) => m.key === "约定.要去"), `明天要去 group shares 要去, got ${b.map((m) => m.key).join(" ")}`);
  assert.ok(b.every((m) => !/明天要|天要去/.test(m.key)), "no 明天要 / 天要去 badge");
});

// review-17 (re-review round 3 §3): the N-1 overlap filter also
// covers content-token bigrams, not just trigrams. Review-16
// blocked 今天我 / 天要去 as trigrams but left the bigram channel
// open, so a group opening with 今天我 still collapsed onto
// 约定.天我 — and a real shared word could lose to the slice.
check("0.3.1 mapping: badge words never pick a sliced bigram (review-17)", () => {
  const batch = (texts: string[]) => {
    const entries = texts.map((t, i) => mkMapEntry(`e${i}`, t, "user", mapNow + i * 60000));
    const attrs = new Map(entries.map((e) => mkMapAttrs(e.id, 0.4)));
    return buildStarmapData(entries, [], attrs, mapNow).memories;
  };
  // A real shared word beats a sliced bigram: 考试 is shared by
  // both lines; before the fix both took 约定.天我.
  const k = batch(["考试考砸了，今天我很难过", "考试没考好，今天我也很累"]);
  assert.ok(
    k.every((m) => m.key === "约定.考试"),
    `考试 wins over 天我, got ${k.map((m) => m.key).join(" ")}`,
  );
  // Four memories opening with 今天我 and sharing nothing else:
  // they no longer collapse onto one meaningless badge. Each
  // falls back to its own first clean content word — a wash, not
  // a fix, for a group that shares nothing but its opening (the
  // re-review's own trade-off, stated in the checklist). 0.4.2
  // P9 changed the fallback pool (boundary rule), so the four
  // values moved: 我吃/我很/我拿/我爬 are all pronoun-first
  // slices now; each star takes its first clean word instead.
  const f = batch(["今天我拿到了奖学金", "今天我爬山累死了", "今天我吃了拉面", "今天我很想你"]);
  assert.ok(
    !f.some((m) => m.key === "约定.天我"),
    `no collapse onto 天我, got ${f.map((m) => m.key).join(" ")}`,
  );
  assert.deepEqual(
    f.map((m) => m.key).sort(),
    ["约定.很想", "约定.拉面", "约定.拿到", "约定.爬山"],
    "each falls back to its own first clean word (0.4.2 P9)",
  );
});

// 0.4.2 P9: the lone-star fallback no longer slices bigrams off
// the text. The user's complaint case first: a lone "我以前不该
// 欺负你的" used to become 约定.我以.
check("0.4.2 mapping: lone-star suffix never slices — boundary rule + category fallback (P9)", () => {
  const one = (text: string) => {
    const e = mkMapEntry("e1", text, "user", mapNow);
    return buildStarmapData([e], [], new Map([mkMapAttrs("e1", 0.4)]), mapNow).memories[0].key;
  };
  assert.equal(one("我以前不该欺负你的"), "约定.以前", "user's complaint case: 以前, not 我以");
  assert.equal(one("今天我吃了拉面"), "约定.拉面", "particle-first slice 了拉 is rejected");
  assert.equal(one("你说的对"), "约定.事件", "no clean word left: category name, not 的对");
  assert.equal(one("了不起"), "约定.了不起", "whole short memory is the suffix outright");
  // 0.4.3 P9: punctuation is stripped before the 2–3 char whole
  // rule runs — "好。" is a 1-char memory, not a 2-char suffix.
  assert.equal(one("好。"), "约定.事件", "punctuation stripped: 好。 is not a 2-char suffix");
  assert.equal(one("走吧！"), "约定.走吧", "punctuation stripped: 走吧！ keeps 走吧");
  assert.equal(one("好！"), "约定.事件", "punctuation stripped: 好！ falls back to the category");
});

// 0.4.3 P9: a fragment whose only fallback word is a 1-char
// topic takes the category name, not the single char. The
// fragment text here ("他说") has no clean 2-char content word
// either — 他说 starts with a pronoun, so the boundary rule
// rejects it — leaving only the 1-char topic "说" in the pool.
check("0.4.3 mapping: lone-star suffix never takes a 1-char fragment topic (P9)", () => {
  const e = mkMapEntry("e1", "他说", "user", mapNow);
  const frag: any = {
    id: "f1",
    sourceIds: ["e1"],
    text: "他说",
    tone: { label: "很喜欢", level: "unknown", intensity: 0.9 },
    quotes: ["他说"],
    topic: "说",
    keywords: ["说"],
    createdAt: mapNow,
    verified: true,
  };
  const data = buildStarmapData([e], [], new Map([mkMapAttrs("e1", 0.4)]), mapNow, [frag]);
  assert.equal(data.memories.length, 1, "one fragment star, source folded in");
  assert.equal(data.memories[0].key, "ta.画像", "1-char topic filtered: category name, not 说");
});

// 0.4.2 P7: original-sentence labels (two-line preview). Drive
// the 14-sample page frozen at t=5 (intro done, dist follows
// distGoal) and watch the 24-div label pool through the distance
// changes. The label is a preview, not the full text on screen:
// textContent holds the whole sentence, but the pill's CSS
// clamps it to two lines (-webkit-line-clamp:2); the full text
// is read in the bottom panel after clicking the star.
check("0.4.2 starmap: original-sentence labels fade in only up close (P7, two-line preview)", () => {
  const seeds: Array<[string, "user" | "assistant"]> = [
    ["酸梅汤真好喝，今天特别开心", "user"],
    ["今晚吃拉面，暖暖的很安心", "assistant"],
    ["明天要去爬山，有点紧张", "user"],
    ["爬山要带酸梅汤，解渴", "assistant"],
    ["上次吵架我很难过，你哄了我好久", "user"],
    ["吵完你给我买了酸梅汤，我原谅你了", "assistant"],
    ["今天拿到奖学金，开心得睡不着", "user"],
    ["奖学金请你吃拉面，说好了", "assistant"],
    ["半夜想你想得睡不着", "user"],
    ["你说晚安的时候我特别安心", "assistant"],
    ["第一次见你是在奶茶店，你紧张得手抖", "user"],
    ["奶茶店的酸梅汤没有你做的好喝", "user"],
    ["今天下雨了，有点难过", "user"],
    ["雨天你送我回家，伞都偏向我这边", "assistant"],
  ];
  const entries = seeds.map(([t, r], i) => mkMapEntry(`e${i + 1}`, t, r, mapNow + i * 60000));
  const attrs = new Map(entries.map((e) => mkMapAttrs(e.id, 0.4)));
  const frag: any = {
    id: "f1",
    sourceIds: ["e1", "e12"],
    text: "他很喜欢酸梅汤",
    tone: { label: "很喜欢", level: "unknown", intensity: 0.9 },
    quotes: ["没有你做的好喝", "真好喝"],
    topic: "酸梅汤",
    keywords: ["酸梅", "梅汤"],
    createdAt: mapNow,
    verified: true,
  };
  const data = buildStarmapData(entries, [], attrs, mapNow, [frag]);
  const html = renderStarmapHtml(data);
  // The two-line clamp is pinned here: the label is a preview,
  // the pill never renders more than two lines of the sentence.
  assert.ok(
    html.includes("-webkit-line-clamp:2"),
    "label CSS clamps the pill to two lines (preview, not full text on screen)",
  );
  const d = driveShiguangHtml(html, "?t=5");
  const visible = () =>
    d.labelsEl.children.filter((c: any) => parseFloat(c.style.opacity || "0") > 0);
  assert.equal(d.labelsEl.children.length, 24, "label pool is 24 reusable divs");
  // Far (default distGoal 9.2): nothing.
  d.stepFrames(3);
  assert.equal(visible().length, 0, "no labels at dist 9.2");
  // Close (dist 4): rotate a full turn so near-side stars sweep
  // past the camera whatever theta started at.
  d.map.setDist(4);
  let maxSeen = 0;
  const seenTexts = new Set<string>();
  for (let r = 0; r < 10; r++) {
    d.stepFrames(2);
    const v = visible();
    maxSeen = Math.max(maxSeen, v.length);
    for (const c of v) seenTexts.add(c.textContent);
    d.cv.fire("pointerdown", { clientX: 400, clientY: 300, pointerId: 9 });
    d.cv.fire("pointermove", { clientX: 800, clientY: 300 });
    d.cv.fire("pointerup", { clientX: 800, clientY: 300, pointerId: 9 });
  }
  assert.ok(maxSeen > 0, `at least one label appears up close (max ${maxSeen})`);
  assert.ok(maxSeen <= 24, `never more than 24 labels at once (max ${maxSeen})`);
  const starTexts = new Set(d.map.stars.map((s: any) => s.text));
  for (const t of seenTexts) {
    assert.ok(starTexts.has(t), `label text is a star's original sentence (two-line preview, textContent holds the whole sentence): ${t}`);
  }
  // Far again (dist 16): gone.
  d.map.setDist(16);
  d.stepFrames(3);
  assert.equal(visible().length, 0, "labels fade out again at dist 16");
  // 0.4.3 P7: hovered/selected stars carry no label (they already
  // have their tooltip/panel), and no-ui hides the label layer.
  d.map.setDist(4);
  d.stepFrames(3);
  const shownNow = visible();
  assert.ok(shownNow.length > 0, "labels are back up close for the hover/selected checks");
  const hoverText = shownNow[0].textContent;
  const hoverStar = d.map.stars.find((s: any) => s.text === hoverText);
  assert.ok(hoverStar, "a visible label maps back to its star");
  const hp = d.map.project(hoverStar.x, hoverStar.y, hoverStar.z);
  assert.ok(hp, "hovered star projects onto the screen");
  d.cv.fire("pointermove", { clientX: hp.x, clientY: hp.y });
  d.stepFrames(2);
  assert.ok(
    !visible().some((c: any) => c.textContent === hoverText),
    "hovered star shows no label while hovered",
  );
  // Click a different visible star: it becomes selected (panel
  // opens) and its label goes away too.
  const selText = visible().find((c: any) => c.textContent !== hoverText)?.textContent;
  assert.ok(selText, "another labelled star is visible to select");
  const selStar = d.map.stars.find((s: any) => s.text === selText);
  clickShiguangStar(d, selStar);
  assert.ok(d.panel.classList.contains("on"), "panel opens on the selected star");
  d.stepFrames(2);
  assert.ok(
    !visible().some((c: any) => c.textContent === selText),
    "selected star shows no label while selected",
  );
  // no-ui: the VM's stub DOM has no stylesheet engine and no
  // document.body, so the `body.no-ui #labels{opacity:0}` rule
  // cannot be observed taking effect here — pin the rule itself
  // in the rendered page instead. Whether the layer really
  // disappears on H in a browser still needs a real-browser
  // check (see the 0.4.3 notes in the READMEs).
  assert.ok(
    html.includes("body.no-ui #labels,"),
    "rendered page carries the no-ui rule hiding the label layer",
  );
});

// review-18 (re-review round 4): the fragment channel had the
// same collapse as the entry channel, easier to hit — a ~10-token
// summary opens with 今天/明天 so naturally that two fragments
// summarising similar days both carry 今天 as topic/keyword and
// converge on ta.今天 via DF. Fragment topic/keywords now go
// through the same hasClearOccurrence filter, against the
// fragment's own text: 今天 occurs in "今天很开心…" only on
// covered positions, so it drops out of the pool, and each
// fragment falls back to its own real word. Before the fix both
// took ta.今天.
check("0.3.1 mapping: two similar fragments no longer collapse onto ta.今天 (review-18)", () => {
  const e1 = mkMapEntry("e1", "今天很开心，奖学金到账了", "user", mapNow);
  const e2 = mkMapEntry("e2", "今天累坏了，爬山爬了一天", "user", mapNow + 60000);
  const attrs = new Map([mkMapAttrs("e1", 0.4), mkMapAttrs("e2", 0.4)]);
  const frags: any[] = [
    {
      id: "f1",
      sourceIds: ["e1"],
      text: "今天很开心，奖学金到账了",
      tone: { label: "很开心", level: "unknown", intensity: 0.9 },
      quotes: ["很开心"],
      topic: "今天",
      keywords: ["今天", "开心"],
      createdAt: mapNow,
      verified: true,
    },
    {
      id: "f2",
      sourceIds: ["e2"],
      text: "今天累坏了，爬山爬了一天",
      tone: { label: "累坏了", level: "unknown", intensity: 0.9 },
      quotes: ["累坏了"],
      topic: "今天",
      keywords: ["今天", "累坏"],
      createdAt: mapNow + 60000,
      verified: true,
    },
  ];
  const data = buildStarmapData([e1, e2], [], attrs, mapNow, frags);
  const byId = new Map(data.memories.map((m) => [m.id, m]));
  assert.equal(data.memories.length, 2, "two fragment stars, sources folded in");
  assert.equal(byId.get("f1")!.key, "ta.开心", "fragment 1 falls back to its own word, not 今天");
  assert.equal(byId.get("f2")!.key, "ta.累坏", "fragment 2 falls back to its own word, not 今天");
});

// review-18: the filter must not injure a curator word passed
// explicitly — a topic/keyword that never occurs in the fragment
// text has nothing to overlap (hasClearOccurrence returns true
// when !found), so it is kept. Here 夏日特饮 is the curator's
// own label for the fragment; it appears nowhere in the text,
// and it still wins the badge.
check("0.3.1 mapping: curator-passed fragment word not in the text is kept (review-18)", () => {
  const e1 = mkMapEntry("e1", "酸梅汤真好喝", "user", mapNow);
  const attrs = new Map([mkMapAttrs("e1", 0.4)]);
  const frag: any = {
    id: "f1",
    sourceIds: ["e1"],
    text: "他很喜欢酸梅汤",
    tone: { label: "很喜欢", level: "unknown", intensity: 0.9 },
    quotes: ["真好喝"],
    topic: "夏日特饮",
    keywords: ["夏日特饮", "酸梅汤"],
    createdAt: mapNow,
    verified: true,
  };
  const data = buildStarmapData([e1], [], attrs, mapNow, [frag]);
  const f = data.memories.find((m) => m.kind === "fragment")!;
  assert.equal(f.key, "ta.夏日特饮", "explicit curator topic survives the filter");
});

// review-19 (residual from review-18's Known limits): 那天 was not
// in COMMON_TOKENS, so two fragments opening with 那天 and sharing
// topic 那天 still collapsed onto ta.那天 — the word had no covered
// position, so `hasClearOccurrence` kept it. 那天 joins the day words
// (今天/明天/昨天) in the list, and the same two-fragment contrast
// as the review-18 今天 test now splits: each fragment falls back
// to its own real word.
check("0.3.1 mapping: two similar fragments no longer collapse onto ta.那天 (review-19)", () => {
  const e1 = mkMapEntry("e1", "那天我们去爬山，很开心", "user", mapNow);
  const e2 = mkMapEntry("e2", "那天你做了拉面，很好吃", "user", mapNow + 60000);
  const attrs = new Map([mkMapAttrs("e1", 0.4), mkMapAttrs("e2", 0.4)]);
  const frags: any[] = [
    {
      id: "f1",
      sourceIds: ["e1"],
      text: "那天我们去爬山，很开心",
      tone: { label: "很开心", level: "unknown", intensity: 0.9 },
      quotes: ["很开心"],
      topic: "那天",
      keywords: ["那天", "爬山"],
      createdAt: mapNow,
      verified: true,
    },
    {
      id: "f2",
      sourceIds: ["e2"],
      text: "那天你做了拉面，很好吃",
      tone: { label: "很好吃", level: "unknown", intensity: 0.9 },
      quotes: ["很好吃"],
      topic: "那天",
      keywords: ["那天", "拉面"],
      createdAt: mapNow + 60000,
      verified: true,
    },
  ];
  const data = buildStarmapData([e1, e2], [], attrs, mapNow, frags);
  const byId = new Map(data.memories.map((m) => [m.id, m]));
  assert.equal(data.memories.length, 2, "two fragment stars, sources folded in");
  assert.equal(byId.get("f1")!.key, "ta.爬山", "fragment 1 falls back to its own word, not 那天");
  assert.equal(byId.get("f2")!.key, "ta.拉面", "fragment 2 falls back to its own word, not 那天");
});

// review-19: the other side of adding 那天 to COMMON_TOKENS —
// contentTokens drops it, so recall's attentionFactor no longer
// treats it as a shared content word. A memory whose ONLY shared
// token with the recent turns is 那天 gets no attention boost
// (0.5, same as no shared token), exactly like its siblings
// 今天/明天/昨天; a genuinely shared word still earns the boost.
check("0.3.1 recall: 那天 no longer counts as a shared attention token (review-19)", () => {
  assert.ok(!contentTokens("那天我们去爬山").has("那天"), "那天 is a common token now");
  assert.equal(
    attentionFactor("那天我们去爬山", ["那天你做了拉面"]),
    0.5,
    "only 那天 is shared: no attention boost",
  );
  for (const day of ["今天", "明天", "昨天"]) {
    assert.equal(
      attentionFactor(`${day}我们去爬山`, [`${day}你做了拉面`]),
      0.5,
      `${day} behaves the same way: a day word alone is not a topic`,
    );
  }
  assert.equal(
    attentionFactor("那天我们去爬山", ["那天爬山很累"]),
    1,
    "a genuinely shared word (爬山) still earns the boost",
  );
});

// review-20 (r5 follow-up): review-19's 那天 edit silently dropped 这个
// from COMMON_TOKENS — the list lost a member and no test noticed,
// because the new tests only covered 那天 and the day words. The full
// list is snapshotted here: 52 members, no more, no fewer. Any future
// add/remove must update this test deliberately, with a review note.
check("0.3.1 activation: COMMON_TOKENS membership is pinned (review-20)", () => {
  const expected = [
    "今天", "明天", "昨天", "那天", "这个", "那个", "什么", "怎么",
    "为什么", "可以", "应该", "觉得", "知道", "时候", "东西", "事情",
    "一下", "有点", "真的", "很好", "不错", "好的", "现在", "然后",
    "就是", "还是", "没有", "不用", "不要", "这样", "那样", "这里",
    "那里", "我们", "你们", "他们", "自己", "一点", "一些", "可能",
    "如果", "因为", "所以", "但是", "不过", "而且", "或者", "已经",
    "正在", "刚才", "一直", "总是",
  ];
  assert.equal(COMMON_TOKENS.size, expected.length, "52 members, no more, no fewer");
  for (const w of expected) assert.ok(COMMON_TOKENS.has(w), `COMMON_TOKENS still has ${w}`);
});

// review-17: the bigram filter must not move any badge on the
// 14-sample page — 0/13 change, pinned here so a future badge
// fix has to prove it did not regress the page the reviewers
// already signed off. Same 14 neutral sample memories and the
// same fragment (2 entries fold into 1 star) as the generated
// sample page; compared as a sorted multiset, so star order
// (recency) cannot mask a change.
check("0.3.1 mapping: 14-sample page badges unchanged by the bigram filter (review-17)", () => {
  const seeds: Array<[string, "user" | "assistant"]> = [
    ["酸梅汤真好喝，今天特别开心", "user"],
    ["今晚吃拉面，暖暖的很安心", "assistant"],
    ["明天要去爬山，有点紧张", "user"],
    ["爬山要带酸梅汤，解渴", "assistant"],
    ["上次吵架我很难过，你哄了我好久", "user"],
    ["吵完你给我买了酸梅汤，我原谅你了", "assistant"],
    ["今天拿到奖学金，开心得睡不着", "user"],
    ["奖学金请你吃拉面，说好了", "assistant"],
    ["半夜想你想得睡不着", "user"],
    ["你说晚安的时候我特别安心", "assistant"],
    ["第一次见你是在奶茶店，你紧张得手抖", "user"],
    ["奶茶店的酸梅汤没有你做的好喝", "user"],
    ["今天下雨了，有点难过", "user"],
    ["雨天你送我回家，伞都偏向我这边", "assistant"],
  ];
  const entries = seeds.map(([t, r], i) => mkMapEntry(`e${i + 1}`, t, r, mapNow + i * 60000));
  const attrs = new Map(entries.map((e) => mkMapAttrs(e.id, 0.4)));
  const frag: any = {
    id: "f1",
    sourceIds: ["e1", "e12"],
    text: "他很喜欢酸梅汤",
    tone: { label: "很喜欢", level: "unknown", intensity: 0.9 },
    quotes: ["没有你做的好喝", "真好喝"],
    topic: "酸梅汤",
    keywords: ["酸梅", "梅汤"],
    createdAt: mapNow,
    verified: true,
  };
  const data = buildStarmapData(entries, [], attrs, mapNow, [frag]);
  assert.equal(data.memories.length, 13, "13 stars from 14 entries (2 fold into the fragment)");
  assert.deepEqual(
    data.memories.map((m) => m.key).sort(),
    [
      "ta.吃拉面", "ta.吃拉面", "ta.安心", "ta.酸梅汤", "ta.酸梅汤",
      "ta.酸梅汤", "ta.雨天", "约定.睡不着", "约定.睡不着",
      "约定.紧张", "约定.紧张", "约定.难过", "约定.难过",
    ].sort(),
    "badge multiset identical to review-15/16: 0/13 change",
  );
});


check("0.3.1 mapping: fragment key suffix uses DF over topic + keywords", () => {
  const e1 = mkMapEntry("e1", "酸梅汤真好喝", "user", mapNow);
  const e2 = mkMapEntry("e2", "昨天又喝了酸梅汤，还是那么好喝", "user", mapNow + 60000);
  const attrs = new Map([mkMapAttrs("e1", 0.4), mkMapAttrs("e2", 0.4)]);
  const frag: any = {
    id: "f1",
    sourceIds: ["e1", "e2"],
    text: "他很喜欢酸梅汤",
    tone: { label: "很喜欢", level: "unknown", intensity: 0.9 },
    quotes: ["真好喝"],
    topic: "酸梅汤",
    keywords: ["酸梅", "梅汤"],
    createdAt: mapNow,
    verified: true,
  };
  const data = buildStarmapData([e1, e2], [], attrs, mapNow, [frag]);
  const f = data.memories.find((m) => m.kind === "fragment")!;
  assert.equal(f.key, "ta.酸梅汤", "酸梅汤 is shared by the fragment + both sources");
});

check("0.3.1 mapping: tags/related deduped and capped at 8, traces empty, at is local time", () => {
  const e = mkMapEntry("e1", "酸梅汤拉面奖学金爬山下雨难过开心", "user", mapNow);
  const data = buildStarmapData([e], [], new Map([mkMapAttrs("e1", 0.4)]), mapNow);
  const m = data.memories[0];
  assert.ok(m.tags.length <= 8, `tags capped at 8, got ${m.tags.length}`);
  assert.equal(new Set(m.tags).size, m.tags.length, "tags deduped");
  assert.deepEqual(m.related, m.tags, "related mirrors tags");
  assert.deepEqual(data.traces, [], "traces empty");
  assert.match(m.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00$/, `at is local ISO minute precision: ${m.at}`);
});

check("0.3.1 mapping: 800 cap keeps the most significant, capped + total visible", () => {
  const entries: any[] = [];
  const attrs = new Map<string, any>();
  for (let i = 0; i < 805; i++) {
    const e = mkMapEntry(`e${i}`, `第${i}条酸梅汤`, "user", mapNow + i * 60000);
    entries.push(e);
    attrs.set(`e${i}`, { clarity: 1, recallCount: 0, significance: i === 700 ? 0.9 : 0.4 });
  }
  const data = buildStarmapData(entries, [], attrs, mapNow);
  assert.equal(data.memories.length, MAX_STARMAP_NODES, "800 stars max");
  assert.equal(data.total, 805, "total counts all stars before the cap");
  assert.equal(data.capped, true, "capped flag set");
  assert.ok(data.memories.some((m) => m.id === "e700"), "the 0.9 entry survives the cap");
});

check("0.3.1 mapping: JSON escaping — a memory containing </script> cannot break out", () => {
  const evil = "</script><script>alert(1)</script> & <b>酸梅汤</b>";
  const e = mkMapEntry("e1", evil, "user", mapNow);
  const html = renderStarmapHtml(buildStarmapData([e], [], new Map([mkMapAttrs("e1", 0.4)]), mapNow));
  assert.equal((html.match(/<\/script>/g) ?? []).length, 1, "only the real closing </script> exists");
  assert.ok(!html.includes("</script><script>"), "no raw script break-out");
  const data = extractShiguangData(html);
  assert.equal(data.memories[0].text, evil, "round-trips through the escaped JSON");
});

check("0.3.1 mapping: fragment star keeps tone + sources, sources fold in", () => {
  const e1 = mkMapEntry("e1", "酸梅汤真好喝", "user", mapNow);
  const e2 = mkMapEntry("e2", "昨天又喝了酸梅汤，还是那么好喝", "user", mapNow + 60000);
  const e3 = mkMapEntry("e3", "今晚吃拉面", "user", mapNow + 120000);
  const attrs = new Map([mkMapAttrs("e1", 0.4), mkMapAttrs("e2", 0.4), mkMapAttrs("e3", 0.4)]);
  const frag: any = {
    id: "f1",
    sourceIds: ["e1", "e2"],
    text: "他很喜欢酸梅汤",
    tone: { label: "很喜欢", level: "unknown", intensity: 0.9 },
    quotes: ["真好喝"],
    topic: "酸梅汤",
    keywords: ["酸梅汤"],
    createdAt: mapNow,
    verified: true,
  };
  const data = buildStarmapData([e1, e2, e3], [], attrs, mapNow, [frag]);
  assert.equal(data.memories.length, 2, "fragment star + unfragmented entry");
  assert.equal(data.total, 2, "total counts stars before the cap, not log entries (m-3)");
  const f = data.memories.find((m) => m.kind === "fragment")!;
  assert.equal(f.text, "他很喜欢酸梅汤", "fragment text is the star");
  assert.equal(f.toneLabel, "很喜欢", "tone label carried");
  assert.equal(f.sources!.length, 2, "both sources carried");
  assert.ok(f.sources!.some((s) => s.text === "酸梅汤真好喝"), "source text carried for the panel");
  assert.ok(f.key.startsWith("ta."), "fragment key is ta.*");
  assert.ok(data.memories.some((m) => m.text === "今晚吃拉面"), "unfragmented entry still a star");
});


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
  const sigs = [...html.matchAll(/"imp":(\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]));
  assert.ok(sigs.length > 0 && sigs.every((s) => s >= 0 && s <= 1), `imp clamped to [0,1], got ${JSON.stringify(sigs)}`);
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
// resolve in O(1), and every edge still lands in the embedded DATA
// (拾光 draws constellations from shared tags, not from these edges).
{
  const dirM9 = mkdtempSync(join(tmpdir(), "memory-core-020-m9-"));
  writeFileSync(join(dirM9, "MEMORY.md"), fixtureMemory020, "utf8");
  const core = new MemoryCore({ dataDir: dirM9 });
  for (let i = 0; i < 120; i++) {
    core.record({ role: "user", text: `第${i}条酸梅汤真好喝`, window: "persona", sessionId: `s${i % 6}`, ts: local(2026, 11, 5, 10, 0) + i * 60000 });
  }
  const sm = core.generateStarmap();
  const html = readFileSync(sm.path, "utf8");
  const data = extractShiguangData(html);
  assert.equal(sm.nodes, 120, "all 120 entries become stars");
  assert.ok(sm.edges > 0, "edges exist");
  assert.equal(data.memories.length, 120, "DATA carries all 120 stars");
  assert.equal(data.edges.length, sm.edges, "every data edge is carried in DATA");
  assert.ok(!html.includes('<line class="edge"'), "no SVG lines in the 拾光 UI");
  console.log("PASS 0.2.0 m9: starmap renders 120 nodes with all edges in DATA");
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
  const data = extractShiguangData(html);
  const fragStar = data.memories.find((m: any) => m.kind === "fragment");
  assert.ok(fragStar, "fragment star present in DATA");
  assert.equal(fragStar.toneLabel, "很喜欢", "fragment tone label in DATA");
  assert.equal(fragStar.sources.length, 2, "fragment carries both sources");
  assert.ok(fragStar.sources.some((s: any) => s.text.includes("酸梅湯真好喝")), "source text in DATA for the panel");
  assert.ok(data.memories.some((m: any) => m.text === "今晚吃拉面"), "unfragmented entry still a star in DATA");
  // P6 regression: click the fragment star in the real page — the
  // panel must show the fragment text + tone + both 原文 sources.
  // (The star literal used to drop toneLabel/sources, so the panel
  // patch never fired.)
  const driven = driveShiguangHtml(html);
  const fragPageStar = driven.map.stars.find((s: any) => s.text === "他很喜欢酸梅湯");
  assert.ok(fragPageStar, "fragment star built in the page");
  clickShiguangStar(driven, fragPageStar);
  assert.ok(driven.panel.classList.contains("on"), "panel opens on fragment star click");
  assert.ok(driven.pBody.textContent.includes("他很喜欢酸梅湯"), "panel shows fragment text");
  assert.ok(driven.pBody.textContent.includes("片段 · 语气 很喜欢"), "panel shows fragment tone");
  assert.ok(driven.pBody.textContent.includes("原文"), "panel shows 原文 sources");
  assert.ok(driven.pBody.textContent.includes("酸梅湯真好喝"), "panel shows source 1");
  assert.ok(driven.pBody.textContent.includes("昨天又喝了酸梅湯，还是那么好喝"), "panel shows source 2");
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

// ---- 0.4.0 item 1: 双时间戳失效 (Graphiti) --------------------------
// An invalidated memory stops recalling but its log text stays;
// the review only FLAGS a contradiction, never auto-invalidates.

const dirInv = mkdtempSync(join(tmpdir(), "memory-core-invalidate-"));
writeFileSync(join(dirInv, "MEMORY.md"), fixtureMemory, "utf8");
const coreInv = new MemoryCore({ dataDir: dirInv });
const invOld = coreInv.record({ role: "user", text: "他喜欢吃辣", window: "persona", importance: "heavy", sessionId: "s1", ts: local(2026, 11, 5, 10, 0) });
const invNew = coreInv.record({ role: "user", text: "他不吃辣了", window: "persona", sessionId: "s1", ts: local(2026, 11, 6, 10, 0) });

check("0.4.0 item 1: invalidateEntries writes validTo, recall skips the entry, log untouched", () => {
  const before = coreInv.recall("吃辣");
  assert.ok(before.hits.some((h) => h.entry.id === invOld.id), "old memory recalls before invalidation");
  const res = coreInv.invalidateEntries([invOld.id, "no-such-id"]);
  assert.deepEqual(res.invalidated, [invOld.id]);
  assert.deepEqual(res.unknown, ["no-such-id"]);
  const attrs = JSON.parse(readFileSync(join(dirInv, "attributes.json"), "utf8")) as {
    entries: Record<string, { validTo?: number | null; validFrom?: number }>;
  };
  assert.equal(typeof attrs.entries[invOld.id].validTo, "number", "validTo persisted to attributes.json");
  assert.equal(attrs.entries[invOld.id].validFrom, invOld.ts, "validFrom defaults to the entry ts");
  const after = coreInv.recall("吃辣");
  assert.ok(!after.hits.some((h) => h.entry.id === invOld.id), "invalidated memory no longer recalls");
  assert.ok(after.hits.some((h) => h.entry.id === invNew.id), "the newer statement still recalls");
  const log = readFileSync(join(dirInv, "log.jsonl"), "utf8");
  assert.ok(log.includes("他喜欢吃辣"), "log.jsonl original still there — skipped, not deleted");
});

check("0.4.0 item 1: boundary — future validTo still recalls, validTo == now is expired, null is valid", () => {
  const dirB = mkdtempSync(join(tmpdir(), "memory-core-invalidate-boundary-"));
  writeFileSync(join(dirB, "MEMORY.md"), fixtureMemory, "utf8");
  const nowB = local(2026, 11, 7, 9, 0);
  const storeB = new AttributeStore(dirB);
  const eB: MemoryEntry = {
    id: "b1",
    ts: local(2026, 11, 6, 10, 0),
    date: "2026/11/06",
    time: "10:00",
    role: "user",
    window: "persona",
    sessionId: "s1",
    importance: "heavy",
    text: "他喜欢吃辣",
    source: "log",
  };
  storeB.ensure(eB, undefined, nowB);
  const rFuture = invalidateEntries([eB.id], nowB + 3600000, storeB);
  assert.deepEqual(rFuture.invalidated, [eB.id]);
  assert.deepEqual(rFuture.unknown, []);
  assert.equal(
    recallFromEntries([eB], null, "吃辣", { attributes: storeB }, nowB).hits.length,
    1,
    "future validTo still recalls",
  );
  invalidateEntries([eB.id], nowB, storeB);
  assert.equal(
    recallFromEntries([eB], null, "吃辣", { attributes: storeB }, nowB).hits.length,
    0,
    "validTo == now is expired (<= now)",
  );
  const rowB = storeB.get(eB.id);
  assert.ok(rowB, "row still exists after invalidation");
  rowB.validTo = null;
  storeB.save();
  assert.equal(
    recallFromEntries([eB], null, "吃辣", { attributes: storeB }, nowB).hits.length,
    1,
    "validTo null is still valid",
  );
  assert.equal(isExpired(null, nowB), false, "isExpired(null) is false");
  assert.equal(isExpired(nowB, nowB), true, "isExpired(now, now) is true");
  assert.equal(isExpired(undefined, nowB), false, "isExpired(undefined) is false");
  // Persistence round-trip: the store-level call saved attributes.json.
  const reloaded = new AttributeStore(dirB);
  assert.equal(reloaded.get(eB.id)?.validTo, null, "null validTo round-trips");
});

check("0.4.0 item 1: old attributes.json / graph.json without the new fields load and recall works", () => {
  const dirO = mkdtempSync(join(tmpdir(), "memory-core-invalidate-old-"));
  writeFileSync(join(dirO, "MEMORY.md"), fixtureMemory, "utf8");
  // Hand-written old-style files: no validFrom / validTo anywhere,
  // plus corrupt new-field values that must be dropped, not crash.
  writeFileSync(
    join(dirO, "attributes.json"),
    JSON.stringify({
      version: 1,
      entries: {
        "old-1": { clarity: 0.9, recallCount: 0, significance: 0.9 },
        "old-2": { clarity: 0.5, recallCount: 0, significance: 0.4, validTo: "soon", validFrom: "yesterday" },
      },
    }),
    "utf8",
  );
  writeFileSync(join(dirO, "graph.json"), JSON.stringify({ version: 1, edges: [] }), "utf8");
  const coreO = new MemoryCore({ dataDir: dirO });
  const eO = coreO.record({ role: "user", text: "他喜欢吃辣", window: "persona", importance: "heavy", sessionId: "s1", ts: local(2026, 11, 6, 10, 0) });
  const rO = coreO.recall("吃辣");
  assert.ok(rO.hits.some((h) => h.entry.id === eO.id), "recall works over old files");
  const storeO = new AttributeStore(dirO);
  assert.equal(storeO.get("old-1")?.validTo, undefined, "old row has no validTo");
  assert.equal(storeO.get("old-2")?.validTo, undefined, "corrupt string validTo dropped on load");
  assert.equal(storeO.get("old-2")?.validFrom, undefined, "corrupt string validFrom dropped on load");
  assert.equal(storeO.get(eO.id)?.validFrom, eO.ts, "new rows still get validFrom");
});

const dirR = mkdtempSync(join(tmpdir(), "memory-core-invalidate-review-"));
writeFileSync(join(dirR, "MEMORY.md"), fixtureMemory, "utf8");
const coreR = new MemoryCore({ dataDir: dirR });
const nowR = local(2026, 11, 7, 9, 0);
const rOld = coreR.record({ role: "user", text: "他喜欢吃辣", window: "persona", importance: "heavy", sessionId: "s1", ts: local(2026, 9, 28, 10, 0) });
coreR.record({ role: "user", text: "他不吃辣了", window: "persona", sessionId: "s1", ts: local(2026, 11, 6, 10, 0) });
// Control pair, same shape but light (significance 0.4): must NOT flag.
const rCtlOld = coreR.record({ role: "user", text: "他喜欢喝可乐", window: "persona", sessionId: "s2", ts: local(2026, 9, 28, 10, 0) });
coreR.record({ role: "user", text: "他不喝可乐了", window: "persona", sessionId: "s2", ts: local(2026, 11, 6, 10, 5) });

check("0.4.0 item 1: review flags significance>=0.5 with an opposite statement in 30 days — mark only", () => {
  const result = coreR.review(true, nowR);
  assert.ok(result !== null && result.ran, "review ran");
  assert.ok(result.invalidationChecks?.includes(rOld.id), "old heavy entry flagged");
  assert.ok(!result.invalidationChecks?.includes(rCtlOld.id), "light control not flagged (significance < 0.5)");
  const attrs = JSON.parse(readFileSync(join(dirR, "attributes.json"), "utf8")) as {
    entries: Record<string, { needsInvalidationCheck?: boolean; validTo?: number | null }>;
  };
  assert.equal(attrs.entries[rOld.id].needsInvalidationCheck, true, "flag persisted in attributes.json");
  assert.equal(attrs.entries[rOld.id].validTo, undefined, "flag is not an auto-invalidation");
  assert.ok(
    coreR.recall("吃辣").hits.some((h) => h.entry.id === rOld.id),
    "flagged memory still recalls until someone confirms via memory_invalidate",
  );
});

// 0.4.4 (0.4.3 audit issue 2): a flagged entry is re-listed at the
// next review while the opposition is still live — the 0.4.0 code
// skipped it forever, so a check the model never acted on vanished
// from every later review. Same data, one day later (2026-11-08):
// the opposing entry (2026-11-06) is still inside the 30-day window.
check("0.4.4: a flagged entry is re-listed at the next review (no permanent skip)", () => {
  const again = coreR.review(true, local(2026, 11, 8, 9, 0));
  assert.ok(again !== null && again.ran, "second review ran");
  assert.ok(again.invalidationChecks?.includes(rOld.id), "still listed while the opposition is live");
  assert.equal(coreR.stats().pendingInvalidationChecks, 1, "memory_status counts one pending check");
  const attrs = JSON.parse(readFileSync(join(dirR, "attributes.json"), "utf8")) as {
    entries: Record<string, { needsInvalidationCheck?: boolean }>;
  };
  assert.equal(attrs.entries[rOld.id].needsInvalidationCheck, true, "flag still set");
});

// 0.4.4: the check lapses on its own — once the opposing statement
// itself ages past the 30-day window there is nothing left for the
// model to confirm, so the flag clears instead of sitting in
// memory_status forever. 2026-12-07: "他不吃辣了" (2026-11-06) is
// 31 days old.
check("0.4.4: an invalidation check lapses when the opposing statement ages past 30 days", () => {
  const lapsed = coreR.review(true, local(2026, 12, 7, 9, 0));
  assert.ok(lapsed !== null && lapsed.ran, "lapse review ran");
  assert.ok(!lapsed.invalidationChecks?.includes(rOld.id), "no longer listed once the opposition is stale");
  assert.equal(coreR.stats().pendingInvalidationChecks, 0, "pending count back to 0");
  const attrs = JSON.parse(readFileSync(join(dirR, "attributes.json"), "utf8")) as {
    entries: Record<string, { needsInvalidationCheck?: boolean }>;
  };
  assert.equal(attrs.entries[rOld.id].needsInvalidationCheck, false, "flag cleared by lapse");
  assert.ok(
    coreR.recall("吃辣").hits.some((h) => h.entry.id === rOld.id),
    "lapsed entry stays valid and still recalls",
  );
});

// 0.4.4: invalidating resolves the check — the flag clears with
// the invalidation, so a dead entry is never counted as "awaiting
// review" in memory_status.
check("0.4.4: invalidating an entry clears its invalidation-check flag", () => {
  const dirI = mkdtempSync(join(tmpdir(), "memory-core-invalidate-clear-"));
  writeFileSync(join(dirI, "MEMORY.md"), fixtureMemory, "utf8");
  const coreI = new MemoryCore({ dataDir: dirI });
  const old = coreI.record({ role: "user", text: "他喜欢吃辣", window: "persona", importance: "heavy", sessionId: "s1", ts: local(2026, 9, 28, 10, 0) });
  coreI.record({ role: "user", text: "他不吃辣了", window: "persona", sessionId: "s1", ts: local(2026, 11, 6, 10, 0) });
  const result = coreI.review(true, local(2026, 11, 7, 9, 0));
  assert.ok(result?.invalidationChecks?.includes(old.id), "flagged by the review");
  assert.equal(coreI.stats().pendingInvalidationChecks, 1, "one pending before invalidation");
  const res = coreI.invalidateEntries([old.id], local(2026, 11, 7, 10, 0));
  assert.deepEqual(res.invalidated, [old.id]);
  assert.equal(coreI.stats().pendingInvalidationChecks, 0, "no pending after invalidation");
  const attrs = JSON.parse(readFileSync(join(dirI, "attributes.json"), "utf8")) as {
    entries: Record<string, { needsInvalidationCheck?: boolean; validTo?: number | null }>;
  };
  assert.equal(attrs.entries[old.id].needsInvalidationCheck, false, "flag cleared by invalidation");
  assert.ok(attrs.entries[old.id].validTo !== undefined && attrs.entries[old.id].validTo !== null, "validTo still stamped");
});

// 0.4.6 (0.4.5 audit new issue 2): the invalidation check no
// longer fires on the persona name alone — on real data it marked
// "夏柠柒，我喜欢你" and "夏柠柒" itself as possibly outdated,
// because they share her name with an unrelated message that
// happened to carry a negation. And a high-df token is not a topic
// either. The true positive ("他喜欢吃辣" vs "他不吃辣了") still
// flags — see the 0.4.0 test above.
check("0.4.6: invalidation ignores the persona name and high-df tokens", () => {
  const dirN = mkdtempSync(join(tmpdir(), "memory-core-invalidate-name-"));
  writeFileSync(join(dirN, "MEMORY.md"), fixtureMemory, "utf8");
  const coreN = new MemoryCore({ dataDir: dirN });
  // The two real-data false positives, heavy so the 0.5 floor does
  // not hide them. The opposing message is the real one: it mentions
  // her name and carries negations, but none of them attaches to a
  // shared topic word — the only shared tokens are her name.
  const love = coreN.record({ role: "user", text: "夏柠柒，我喜欢你", window: "persona", importance: "heavy", sessionId: "s1", ts: local(2026, 11, 6, 0, 19) });
  const nameOnly = coreN.record({ role: "user", text: "夏柠柒", window: "persona", importance: "heavy", sessionId: "s1", ts: local(2026, 11, 6, 2, 7) });
  coreN.record({ role: "assistant", text: "夏柠柒，已按那 13 行删完，顺带清掉了之后新增的 2 行，我不会再弄了，也不再管了", window: "persona", sessionId: "s1", ts: local(2026, 11, 6, 21, 30) });
  const result = coreN.review(true, local(2026, 11, 7, 9, 0));
  assert.ok(result !== null && result.ran, "review ran");
  assert.ok(!result.invalidationChecks?.includes(love.id), "“我喜欢你” is not outdated — only her name is shared");
  assert.ok(!result.invalidationChecks?.includes(nameOnly.id), "a bare name is not a topic at all");
  assert.equal(coreN.stats().pendingInvalidationChecks, 0, "no pending checks from a name-only share");
  // High document frequency is not a topic either: seven entries
  // share 酸梅汤, so none of them can be contradicted through it.
  const dirD = mkdtempSync(join(tmpdir(), "memory-core-invalidate-df-"));
  writeFileSync(join(dirD, "MEMORY.md"), fixtureMemory, "utf8");
  const coreD = new MemoryCore({ dataDir: dirD });
  const dfOld = coreD.record({ role: "user", text: "我喜欢酸梅汤", window: "persona", importance: "heavy", sessionId: "s1", ts: local(2026, 9, 28, 10, 0) });
  for (let i = 0; i < 5; i++) {
    coreD.record({ role: "user", text: `第${i + 1}天喝酸梅汤`, window: "persona", sessionId: "s2", ts: local(2026, 10, 1 + i, 10, 0) });
  }
  coreD.record({ role: "user", text: "我不喝酸梅汤了", window: "persona", sessionId: "s1", ts: local(2026, 11, 6, 10, 0) });
  const dfResult = coreD.review(true, local(2026, 11, 7, 9, 0));
  assert.ok(dfResult !== null && dfResult.ran, "df review ran");
  assert.ok(!dfResult.invalidationChecks?.includes(dfOld.id), "a token carried by 7 entries is not a contradiction topic");
});

// 0.4.4: entriesByIds resolves ids to entries (unknown ids skipped)
// — the shell uses it to put the review's invalidation ids into the
// daily-review prompt with their text.
check("0.4.4: entriesByIds resolves review ids to entries", () => {
  const found = coreR.entriesByIds([rOld.id, "no-such-id"]);
  assert.equal(found.length, 1, "unknown ids skipped");
  assert.equal(found[0].id, rOld.id);
  assert.equal(found[0].text, "他喜欢吃辣");
  assert.deepEqual(coreR.entriesByIds([]), [], "empty in, empty out");
});

// 0.4.4: the daily-review prompt carries the review's proactivity
// proposal and invalidation checks — and carries neither when the
// review built none.
check("0.4.4: buildModelReviewPrompt carries the proact proposal and invalidation checks", () => {
  const entry: MemoryEntry = {
    id: "inv-1",
    ts: local(2026, 11, 6, 10, 0),
    date: "2026/11/06",
    time: "10:00",
    role: "user",
    window: "persona",
    sessionId: "s1",
    importance: "heavy",
    text: "他喜欢吃辣",
  };
  const prompt = buildModelReviewPrompt(
    [],
    [],
    [],
    "",
    "你是夏柠柒。今天是 2026/11/07。请你自己掂量一下：现在要不要主动找他说句话？",
    [entry],
  );
  assert.ok(prompt.includes("主动提议"), "proact section present");
  assert.ok(prompt.includes("请你自己掂量一下"), "proact text pasted in");
  assert.ok(prompt.includes("memory_proact"), "tells her how to act (fresh gate call for the token)");
  assert.ok(prompt.includes("inv-1"), "invalidation entry id citable");
  assert.ok(prompt.includes("他喜欢吃辣"), "invalidation entry text present");
  assert.ok(prompt.includes("memory_invalidate"), "tells her how to confirm");
  assert.ok(prompt.includes("可能已经过时"), "invalidation section present");
  const empty = buildModelReviewPrompt([]);
  assert.ok(!empty.includes("主动提议"), "no proact section on an empty day");
  assert.ok(!empty.includes("可能已经过时"), "no invalidation section with no checks");
});

// 0.4.5 (0.4.3 audit item 4): the daily-review prompt is capped —
// top 60 by significance, 8000 characters of entry text — and the
// prompt says only the important part is listed.
check("0.4.5: buildModelReviewPrompt caps yesterday's entries at 60 by significance / 8000 chars", () => {
  const mk = (i: number, text: string): MemoryEntry => ({
    id: `cap-${i}`,
    ts: local(2026, 11, 6, 10, 0) + i * 60000,
    date: "2026/11/06",
    time: "10:00",
    role: "user",
    window: "persona",
    sessionId: "s1",
    importance: i % 2 === 0 ? "heavy" : "light",
    text,
  });
  // 100 short entries, significance = index (cap-99 most significant).
  const entries = Array.from({ length: 100 }, (_, i) => mk(i, `第${i}条`));
  const sig = (e: MemoryEntry) => Number(e.id.slice(4));
  const prompt = buildModelReviewPrompt(entries, [], [], "", "", [], { significanceOf: sig });
  assert.ok(prompt.includes("第99条"), "most significant kept");
  assert.ok(prompt.includes("第40条"), "60th kept");
  // 0.4.6: cut entries no longer vanish — they survive as id +
  // summary lines. So "cut" now means "not shown in full": the
  // full-entry line carries the date/role bracket, the summary
  // line carries （摘要）.
  assert.ok(!prompt.includes("[cap-39] [2026/11/06"), "61st not shown in full");
  assert.ok(prompt.includes("[cap-39] （摘要）第39条"), "61st survives as a summary");
  assert.ok(!prompt.includes("[cap-0] [2026/11/06"), "least significant not shown in full");
  // Overflow summaries go to the most significant of the cut
  // first: cap-39..cap-20 get summary lines, cap-19..cap-0 are
  // counted, not listed.
  assert.ok(!prompt.includes("[cap-0] （摘要）"), "least significant is past the summary budget");
  assert.ok(prompt.includes("另有 20 条未列出"), "the unlisted remainder is counted");
  assert.ok(prompt.includes("只列了重要的部分"), "prompt says the list is cut");
  assert.ok(prompt.includes("100 条"), "prompt names the day's total");
  assert.ok(prompt.indexOf("第40条") < prompt.indexOf("第99条"), "selected entries shown chronologically, not ranked");
  // No cap note when nothing is cut.
  const small = buildModelReviewPrompt(entries.slice(0, 5), [], [], "", "", [], { significanceOf: sig });
  assert.ok(!small.includes("只列了重要的部分"), "no note when the whole day fits");
  assert.ok(small.includes("第0条"), "small day lists everything");
  // Character cap: 100 entries of 200 chars each — 40 fit in 8000.
  const long = Array.from({ length: 100 }, (_, i) => mk(i, "长".repeat(200)));
  const longPrompt = buildModelReviewPrompt(long, [], [], "", "", [], { significanceOf: sig });
  const listed = (longPrompt.match(/cap-\d+ \[2026\/11\/06/g) ?? []).length;
  assert.ok(listed <= 40, `200-char entries: at most 40 shown in full in 8000 chars, got ${listed}`);
  assert.ok(longPrompt.includes("只列了重要的部分"), "char cap also notes the cut");
  // Budget-skipped entries are summaries too, not dropped: the
  // 200-char entries past the budget still appear as （摘要）.
  assert.ok(longPrompt.includes("（摘要）"), "budget-skipped entries survive as summaries");
  assert.ok(longPrompt.includes("另有"), "the unlisted remainder is counted, not hidden");
  // Without a significance function the caps still apply in order.
  const noSig = buildModelReviewPrompt(entries);
  assert.ok(noSig.includes("第0条") && noSig.includes("第59条"), "no significance fn: first 60 in order");
  assert.ok(!noSig.includes("[cap-60] [2026/11/06"), "no significance fn: 61st not shown in full");
  assert.ok(noSig.includes("[cap-60] （摘要）第60条"), "no significance fn: 61st survives as a summary");
});

// 0.4.5 (0.4.3 audit item 5): backfill is idempotent — the cap
// counts a node's EXISTING keyword edges, so a second daily
// backfill adds nothing instead of mining colder tokens.
check("0.4.5: backfill twice adds no edges and the 3-edge cap holds", () => {
  const dirB = mkdtempSync(join(tmpdir(), "memory-core-045-backfill-"));
  const t0 = local(2026, 11, 6, 10, 0);
  const mkE = (id: string, text: string, sessionId: string, ts: number): MemoryEntry => ({
    id, ts, date: "2026/11/06", time: "10:00", role: "user", window: "persona",
    sessionId, importance: "light", text, source: "log",
  });
  // E shares one rare token with each of A, B, C, D, F — five
  // sharers, cap 3. Each entry lives in its own session so no
  // session edges muddy the count.
  const e = mkE("bf-e", "酸梅汤爬山拉面电影", "s-e", t0);
  const a = mkE("bf-a", "酸梅汤真好喝", "s-a", t0 + 60000);
  const b = mkE("bf-b", "酸梅汤要冰镇的", "s-b", t0 + 120000);
  const c = mkE("bf-c", "爬山累死了", "s-c", t0 + 180000);
  const d = mkE("bf-d", "拉面真好吃", "s-d", t0 + 240000);
  const f = mkE("bf-f", "电影真好看", "s-f", t0 + 300000);
  const entries = [e, a, b, c, d, f];
  const idx = new KeywordIndex(join(dirB, "index.json"));
  idx.build(entries);
  const g = new MemoryGraph(dirB);
  const first = g.backfill(entries, idx, t0 + 3600000);
  assert.ok(first > 0, "first backfill creates edges");
  // The cap is a per-entry creation budget (each entry's own
  // processing creates at most 3 keyword edges ever — its count
  // includes edges other entries already made to it), so a popular
  // node can hold more than 3 edges in total (its own 3 plus
  // incoming ones), but the total is bounded by 3 per entry and
  // later runs must not grow anything.
  const keywordEdges = () =>
    g.allEdges().filter((x) => x.type === "keyword").length;
  assert.ok(
    keywordEdges() <= 3 * entries.length,
    `keyword edges bounded by 3 per entry, got ${keywordEdges()}`,
  );
  const degreeE = () =>
    g.neighbors("bf-e").filter((x) => x.type === "keyword").length;
  const degreeAfterFirst = degreeE();
  const afterFirst = g.size;
  const second = g.backfill(entries, idx, t0 + 7200000);
  assert.equal(second, 0, "second backfill adds no edges");
  assert.equal(g.size, afterFirst, "edge count unchanged after the second backfill");
  assert.equal(degreeE(), degreeAfterFirst, "the busiest node's degree does not grow on re-backfill");
  const third = g.backfill(entries, idx, t0 + 10800000);
  assert.equal(third, 0, "third backfill adds no edges either");
  assert.equal(g.size, afterFirst, "edge count unchanged after the third backfill");
  assert.equal(degreeE(), degreeAfterFirst, "degree still unchanged after the third backfill");
});

// 0.4.5 (0.4.3 audit item 5): a session edge between two entries
// that also share a rare keyword upgrades to a keyword edge on
// backfill — type only, weight and clock untouched (decay must
// survive), and the upgrade is not counted as a new edge.
check("0.4.5: backfill upgrades a session edge to keyword without touching weight or clock", () => {
  const dirU = mkdtempSync(join(tmpdir(), "memory-core-045-upgrade-"));
  const t0 = local(2026, 11, 6, 10, 0);
  const uA: MemoryEntry = {
    id: "up-a", ts: t0, date: "2026/11/06", time: "10:00", role: "user",
    window: "persona", sessionId: "s1", importance: "light", text: "酸梅汤真好喝", source: "log",
  };
  const uB: MemoryEntry = {
    id: "up-b", ts: t0 + 60000, date: "2026/11/06", time: "10:01", role: "user",
    window: "persona", sessionId: "s1", importance: "light", text: "酸梅汤要冰镇的", source: "log",
  };
  const idx = new KeywordIndex(join(dirU, "index.json"));
  idx.build([uA, uB]);
  const g = new MemoryGraph(dirU);
  g.link("up-a", "up-b", "session", t0);
  const before = g.find("up-a", "up-b");
  assert.equal(before?.type, "session", "starts as a session edge");
  assert.equal(before?.weight, 0.5, "session weight 0.5");
  const added = g.backfill([uA, uB], idx, t0 + 86400000);
  const after = g.find("up-a", "up-b");
  assert.equal(added, 0, "upgrade is not a new edge");
  assert.equal(after?.type, "keyword", "upgraded to a traversable keyword edge");
  assert.equal(after?.weight, 0.5, "weight untouched by the upgrade");
  assert.equal(after?.lastTraversedAt, t0, "clock untouched by the upgrade");
  const again = g.backfill([uA, uB], idx, t0 + 2 * 86400000);
  assert.equal(again, 0, "second backfill adds nothing");
  assert.equal(g.find("up-a", "up-b")?.type, "keyword", "stays keyword");
});

check("0.4.0 item 1: an expired graph edge is never walked by recall", () => {
  const dirG = mkdtempSync(join(tmpdir(), "memory-core-invalidate-graph-"));
  writeFileSync(join(dirG, "MEMORY.md"), fixtureMemory, "utf8");
  const nowG = local(2026, 11, 7, 9, 0);
  const gA: MemoryEntry = {
    id: "g-a",
    ts: local(2026, 11, 6, 10, 0),
    date: "2026/11/06",
    time: "10:00",
    role: "user",
    window: "persona",
    sessionId: "s1",
    importance: "heavy",
    text: "酸梅汤真好喝",
    source: "log",
  };
  const gB: MemoryEntry = {
    id: "g-b",
    ts: local(2026, 11, 6, 10, 5),
    date: "2026/11/06",
    time: "10:05",
    role: "user",
    window: "persona",
    sessionId: "s1",
    importance: "light",
    text: "昨天去爬山了",
    source: "log",
  };
  const graphG = new MemoryGraph(dirG);
  graphG.link(gA.id, gB.id, "keyword", nowG);
  const storeG = new AttributeStore(dirG);
  const live = recallFromEntries([gA, gB], null, "酸梅汤", { graph: graphG, attributes: storeG }, nowG);
  assert.ok(
    live.hits.some((h) => h.entry.id === gB.id && h.viaGraph),
    "live edge diffuses to the neighbour",
  );
  assert.equal(graphG.invalidate([gA.id], nowG), 1, "one incident edge stamped");
  const dead = recallFromEntries([gA, gB], null, "酸梅汤", { graph: graphG, attributes: storeG }, nowG);
  assert.ok(!dead.hits.some((h) => h.entry.id === gB.id), "expired edge no longer diffuses");
  assert.ok(dead.hits.some((h) => h.entry.id === gA.id), "the seed itself still recalls");
});

console.log(`\nALL PASS (0.4.0 item 1 additions)`);

// ---- 0.4.0 item 6: 分速率衰减 (小凌识海 + Persode / FadeMem) -----
// Details fade fast, feelings linger, stable likes never decay.
// NOTE on the spec's file list: it says "core/src/recall.ts:
// activationFor()" — wrong file, activationFor lives in
// core/src/activation.ts (timeFactor too); the code, not the spec
// text, is authoritative here.

check("0.4.0 item 6: likes/dislikes/agreements unchanged after 100 days with no chat", () => {
  const dirL = mkdtempSync(join(tmpdir(), "memory-core-item6-likes-"));
  writeFileSync(join(dirL, "MEMORY.md"), fixtureMemory, "utf8");
  const coreL = new MemoryCore({ dataDir: dirL });
  coreL.record({ role: "user", text: "他喜欢吃辣", window: "persona", importance: "heavy", sessionId: "s1", ts: local(2026, 9, 1, 10, 0) });
  const before = parseMemoryText(fixtureMemory).layer1;
  const memBefore = readFileSync(join(dirL, "MEMORY.md"), "utf8");
  // 100 days later, no chat in between, a full review runs.
  const result = coreL.review(true, local(2026, 12, 10, 9, 0));
  assert.ok(result !== null && result.ran, "review ran");
  assert.equal(readFileSync(join(dirL, "MEMORY.md"), "utf8"), memBefore, "MEMORY.md bytes untouched by review");
  const after = parseMemoryText(readFileSync(join(dirL, "MEMORY.md"), "utf8")).layer1;
  assert.deepEqual(after.likes, before.likes, "likes unchanged after 100 days");
  assert.deepEqual(after.dislikes, before.dislikes, "dislikes unchanged after 100 days");
  assert.deepEqual(after.agreements, before.agreements, "agreements unchanged after 100 days");
  assert.deepEqual(after.likes, ["银口琴", "兔子挂件"], "likes are the fixture values, not decayed");
});

check("0.4.0 item 6: detail fades faster than emotion — both rates asserted, time factor blends 0.7/0.3", () => {
  // Pure rates: a half-life is a true half-life (lambda = ln2 / H).
  assert.ok(detailLambda(0.4) > emotionLambda(0.4), "detail rate is faster than emotion rate at the same significance");
  assert.ok(detailLambda(0.9) > emotionLambda(0.9), "same ordering for heavy memories");
  assert.ok(Math.abs(Math.exp(-detailLambda(0.4) * 26) - 0.5) < 1e-9, "detail half-life is 14 + 30*0.4 = 26 days");
  assert.ok(Math.abs(Math.exp(-emotionLambda(0.4) * 108) - 0.5) < 1e-9, "emotion half-life is 60 + 120*0.4 = 108 days");
  assert.equal(factLambda(), 0, "facts/likes never decay");
  assert.equal(clarityLambda(0.4), detailLambda(0.4), "clarityLambda stays available as the detailLambda alias");
  // Stored decay over 90 days (light, S=0.4): detail ~0.09, emotion ~0.56.
  const dirD = mkdtempSync(join(tmpdir(), "memory-core-item6-decay-"));
  const storeD = new AttributeStore(dirD);
  const t0 = local(2026, 8, 10, 10, 0);
  const eD: MemoryEntry = {
    id: "d1", ts: t0, date: "2026/08/10", time: "10:00",
    role: "user", window: "persona", sessionId: "s1",
    importance: "light", text: "今天天气不错，适合出门", source: "log",
  };
  storeD.ensure(eD, undefined, t0);
  assert.ok(storeD.decayClarity(eD, t0 + 90 * 86_400_000), "decay ran");
  const rowD = storeD.get("d1");
  assert.ok(rowD, "row exists");
  assert.ok(Math.abs((rowD.detailClarity ?? -1) - 0.0907) < 0.005, `detail clarity after 90d is ~0.09, got ${rowD.detailClarity}`);
  assert.ok(Math.abs((rowD.emotionRetain ?? -1) - 0.5613) < 0.005, `emotion retention after 90d is ~0.56, got ${rowD.emotionRetain}`);
  assert.ok((rowD.detailClarity ?? 1) < (rowD.emotionRetain ?? 0), "detail fell further than emotion over the same 90 days");
  assert.equal(rowD.clarity, rowD.detailClarity, "clarity stays in sync with the detail track");
  // The blend at 90d is 0.7*0.09 + 0.3*0.56 = 0.23, so the 0.3 floor catches it.
  assert.equal(timeFactor(eD, rowD, t0 + 90 * 86_400_000), 0.3, "time factor never drops below the 0.3 floor");
  // At 30 days the blend is above the floor and shows the weights exactly.
  const storeF = new AttributeStore(mkdtempSync(join(tmpdir(), "memory-core-item6-blend-")));
  const eF: MemoryEntry = { ...eD, id: "f1" };
  storeF.ensure(eF, undefined, t0);
  storeF.decayClarity(eF, t0 + 30 * 86_400_000);
  const rowF = storeF.get("f1");
  assert.ok(rowF, "row exists");
  const expectBlend = 0.7 * (rowF.detailClarity ?? 0) + 0.3 * (rowF.emotionRetain ?? 0);
  assert.ok(Math.abs(timeFactor(eF, rowF, t0 + 30 * 86_400_000) - expectBlend) < 1e-9, "time factor is exactly 0.7*detail + 0.3*emotion");
  assert.ok(Math.abs(timeFactor(eF, rowF, t0 + 30 * 86_400_000) - 0.562) < 0.01, "30d blend is ~0.56, above the floor");
  // retrievability now runs at the detail rate: at exactly one detail
  // half-life (26d, S=0.4) with no emotion and no recalls, R = 0.5 * 0.7.
  const r = retrievability(
    { clarity: 1, recallCount: 0, significance: 0.4 },
    eD, t0 + 26 * 86_400_000,
  );
  assert.ok(Math.abs(r - 0.35) < 0.01, `retrievability at one detail half-life is ~0.35, got ${r}`);
  // The pure emotion function agrees with the stored track.
  assert.ok(
    Math.abs(emotionRetain({ clarity: 1, recallCount: 0, significance: 0.4 }, eD, t0 + 90 * 86_400_000) - 0.5613) < 0.005,
    "emotionRetain() computes the same 90d value from age",
  );
});

check("0.4.0 item 6: timeFactor without a stored emotionRetain does not double-decay", () => {
  // Hand-built attrs with no stored emotionRetain / lastReviewedAt:
  // the fallback emotionRetain() is already decayed to `now` by age,
  // so timeFactor must NOT multiply it by the since-last-review decay
  // a second time (regression: it used to square the decay).
  const t0 = local(2026, 8, 10, 10, 0);
  const eG: MemoryEntry = {
    id: "g1", ts: t0, date: "2026/08/10", time: "10:00",
    role: "user", window: "persona", sessionId: "s1",
    importance: "light", text: "今天天气不错，适合出门", source: "log",
  };
  const now = t0 + 30 * 86_400_000;
  const expect =
    0.7 * Math.exp(-detailLambda(0.4) * 30) +
    0.3 * Math.exp(-emotionLambda(0.4) * 30);
  assert.ok(
    Math.abs(timeFactor(eG, { clarity: 1, recallCount: 0, significance: 0.4 }, now) - Math.max(0.3, expect)) < 1e-9,
    `fallback time factor is single-decayed, got ${timeFactor(eG, { clarity: 1, recallCount: 0, significance: 0.4 }, now)} vs ${Math.max(0.3, expect)}`,
  );
});

check("0.4.0 item 6: old attributes.json without the new fields loads on defaults and survives review", () => {
  const dirO6 = mkdtempSync(join(tmpdir(), "memory-core-item6-old-"));
  writeFileSync(join(dirO6, "MEMORY.md"), fixtureMemory, "utf8");
  writeFileSync(
    join(dirO6, "attributes.json"),
    JSON.stringify({
      version: 1,
      entries: {
        "old-1": { clarity: 0.9, recallCount: 0, significance: 0.9 },
        "old-2": { clarity: 0.5, recallCount: 0, significance: 0.4, detailClarity: "soon", emotionRetain: "high" },
        "old-3": { clarity: 0.8, recallCount: 0, significance: 0.4, emotionRetain: -5 },
      },
    }),
    "utf8",
  );
  const storeO6 = new AttributeStore(dirO6);
  assert.equal(storeO6.get("old-1")?.detailClarity, 0.9, "detailClarity defaults to the stored clarity");
  assert.equal(storeO6.get("old-1")?.emotionRetain, 1.0, "emotionRetain defaults to 1.0");
  assert.equal(storeO6.get("old-2")?.detailClarity, 0.5, "corrupt string detailClarity falls back to clarity");
  assert.equal(storeO6.get("old-2")?.emotionRetain, 1.0, "corrupt string emotionRetain falls back to 1.0");
  assert.equal(storeO6.get("old-3")?.emotionRetain, 0, "out-of-range emotionRetain is clamped, not a crash");
  // Recall over an old row works, and a full review persists the new fields.
  const eO6: MemoryEntry = {
    id: "old-1", ts: local(2026, 9, 1, 10, 0), date: "2026/09/01", time: "10:00",
    role: "user", window: "persona", sessionId: "s1",
    importance: "heavy", text: "他喜欢吃辣", source: "log",
  };
  const nowO6 = local(2026, 11, 9, 9, 0);
  assert.equal(
    recallFromEntries([eO6], null, "吃辣", { attributes: storeO6 }, nowO6).hits.length,
    1,
    "recall works over an old row with no new fields",
  );
  const coreO6 = new MemoryCore({ dataDir: dirO6 });
  coreO6.record({ role: "user", text: "今天天气不错", window: "persona", sessionId: "s1", ts: local(2026, 11, 8, 10, 0) });
  assert.ok(coreO6.review(true, local(2026, 11, 9, 9, 0))?.ran, "review runs over old data");
  const persisted = JSON.parse(readFileSync(join(dirO6, "attributes.json"), "utf8")) as {
    entries: Record<string, { detailClarity?: number; emotionRetain?: number }>;
  };
  for (const id of ["old-1", "old-2", "old-3"]) {
    assert.equal(typeof persisted.entries[id].detailClarity, "number", `${id} detailClarity persisted by review`);
    assert.equal(typeof persisted.entries[id].emotionRetain, "number", `${id} emotionRetain persisted by review`);
    assert.ok(persisted.entries[id].detailClarity! >= 0 && persisted.entries[id].detailClarity! <= 1, `${id} detailClarity in range`);
    assert.ok(persisted.entries[id].emotionRetain! >= 0 && persisted.entries[id].emotionRetain! <= 1, `${id} emotionRetain in range`);
  }
});

check("0.4.0 item 6: recall sharpens detail but not emotion; time factor floors at 0.3 even for fully faded rows", () => {
  const dirB6 = mkdtempSync(join(tmpdir(), "memory-core-item6-bump-"));
  const storeB6 = new AttributeStore(dirB6);
  const t0 = local(2026, 8, 10, 10, 0);
  const eB6: MemoryEntry = {
    id: "b6", ts: t0, date: "2026/08/10", time: "10:00",
    role: "user", window: "persona", sessionId: "s1",
    importance: "light", text: "今天天气不错，适合出门", source: "log",
  };
  // Age the row 30 days at creation so the bump is visible (fresh is 1.0, capped).
  storeB6.ensure(eB6, undefined, t0 + 30 * 86_400_000);
  const before = storeB6.get("b6");
  assert.ok(before && (before.clarity ?? 1) < 1, "aged-in row starts below 1.0");
  const clarityBefore = before.clarity;
  // The emotion track of a 30-day-old row starts aged too (0.82, not 1.0).
  const emotionBefore = before.emotionRetain;
  assert.ok(emotionBefore !== undefined && emotionBefore < 1 && emotionBefore > 0.8, `emotion starts age-correct at ~0.82, got ${emotionBefore}`);
  storeB6.bumpOnRecall("b6", t0 + 30 * 86_400_000);
  const after = storeB6.get("b6");
  assert.ok(after, "row exists after bump");
  assert.ok(Math.abs(after.clarity - Math.min(1, clarityBefore + 0.15)) < 1e-9, "clarity rises 0.15 on recall");
  assert.equal(after.detailClarity, after.clarity, "detail track rises with clarity");
  assert.equal(after.emotionRetain, emotionBefore, "emotion retention is untouched by recall");
  // A fully faded row still gets a 0.3 time factor — time never zeroes a memory.
  const faded = {
    clarity: 0.05, detailClarity: 0.05, emotionRetain: 0.05,
    recallCount: 0, significance: 0.4,
  };
  assert.equal(timeFactor(eB6, faded, t0 + 365 * 86_400_000), 0.3, "0.3 floor holds for a fully faded row");
});

console.log(`\nALL PASS (0.4.0 item 6 additions)`);

// ---- 0.4.0 item 4: 画像常驻块 (Memobase) --------------------------
// The standing profile rides along with every recall, separate from
// hits: no keyword recall, no valve slot, no token-cap budget, and
// changing it never touches the keyword index.
// NOTE on scope: the profile field itself has no MEMORY.md key yet —
// the parser (memory-file.ts) reads only the existing layer-1 keys,
// and the skill does not write a profile section — so the block is
// assembled from profile.* when present, falling back to the
// layer-1 name/stage and the likes/agreements lists (the spec's
// example block needs 喜欢/约定, which only exist in layer 1).
// Until the skill writes a profile section, relationshipStage can
// only arrive via a directly-built Layer1State (see the unit test
// below); the parser side is a follow-up, not guessed here.

const profEntry: MemoryEntry = {
  id: "p0",
  ts: local(2026, 11, 6, 10, 0),
  date: "2026/11/06",
  time: "10:00",
  role: "user",
  window: "persona",
  sessionId: "s1",
  importance: "light",
  text: "今天喝了酸梅汤",
  source: "log",
};

check("0.4.0 item 4: no profile data — profileText is an empty string, no crash", () => {
  const noLayer1 = recallFromEntries([profEntry], null, "酸梅汤");
  assert.equal(noLayer1.profileText, "", "null layer 1 → empty profileText");
  assert.equal(noLayer1.hits.length, 1, "hits unaffected by the missing profile");
  const emptyLayer1 = {
    likes: [], dislikes: [], agreements: [], counters: {},
    heavyNotes: [], extra: [],
  };
  assert.equal(
    recallFromEntries([profEntry], emptyLayer1, "酸梅汤").profileText,
    "",
    "layer 1 with no profile fields at all → empty profileText",
  );
  // The non-string-query path in MemoryCore also carries the (empty) block.
  const dirP0 = mkdtempSync(join(tmpdir(), "memory-core-profile-empty-"));
  writeFileSync(join(dirP0, "MEMORY.md"), "# MEMORY\n", "utf8");
  const coreP0 = new MemoryCore({ dataDir: dirP0 });
  const badQuery = coreP0.recall(42 as unknown as string);
  assert.equal(badQuery.profileText, "", "bad query → empty profileText, never throws");
});

const profLayer1 = {
  name: "夏柠柒",
  stage: "早期",
  profile: {
    name: "夏柠柒",
    stage: "早期",
    relationshipStage: "刚认识不久",
    updatedAt: local(2026, 11, 6, 9, 0),
  },
  likes: ["酸梅汤"],
  dislikes: [],
  agreements: ["每天睡前聊一会儿"],
  counters: {},
  heavyNotes: [],
  extra: [],
};

check("0.4.0 item 4: profile block costs no token-cap budget and no valve slot", () => {
  // Six entries, each matching exactly one distinct query token, so
  // each hit has its own valve topic (per-topic cap 2 never bites)
  // and the valve's top-5 cut is the only thing trimming the list.
  const words = ["酸梅", "蓝莓", "爬山", "海边", "摩天", "火锅"];
  const texts = [
    "今天喝了酸梅，味道很不错",
    "蓝莓蛋糕真好吃",
    "周末去爬山，累死了",
    "想去海边散步",
    "摩天轮上风很大",
    "晚上吃火锅",
  ];
  const entries: MemoryEntry[] = texts.map((text, i) => ({
    id: `p-cap-${i}`,
    ts: local(2026, 11, 6, 10, i),
    date: "2026/11/06",
    time: `10:0${i}`,
    role: "user",
    window: "persona",
    sessionId: "s1",
    importance: "heavy",
    text,
    source: "log",
  }));
  assert.equal(words.length, 6, "six distinct topics in the fixture");
  const query = words.join(" ");
  const withProfile = recallFromEntries(entries, profLayer1, query);
  const withoutProfile = recallFromEntries(entries, null, query);
  assert.equal(withProfile.hits.length, 5, "valve top 5 still holds with the profile block present");
  assert.equal(withProfile.profileText.split("\n").length, 5, "block is 5 lines");
  assert.deepEqual(
    withProfile.hits.map((h) => h.entry.id),
    withoutProfile.hits.map((h) => h.entry.id),
    "identical hits with and without the profile block",
  );
  assert.equal(
    withProfile.estimatedTokens,
    withoutProfile.estimatedTokens,
    "profile block costs no token-cap budget",
  );
  assert.ok(
    !withProfile.text.includes("夏柠柒"),
    "profile block is not inside the injectable hits text",
  );
});

check("0.4.0 item 4: changing the profile needs no index rebuild — next recall reads the new values", () => {
  const dirP = mkdtempSync(join(tmpdir(), "memory-core-profile-"));
  const memoryV1 = `# MEMORY

## 当前状态

- 名字: 夏柠柒
- 阶段: 早期
- 喜欢: 酸梅汤
- 约定:
  - 每天睡前聊一会儿
`;
  writeFileSync(join(dirP, "MEMORY.md"), memoryV1, "utf8");
  const coreP = new MemoryCore({ dataDir: dirP });
  coreP.record({
    role: "user", text: "今天喝了酸梅汤，很解渴", window: "persona",
    sessionId: "s1", ts: local(2026, 11, 6, 10, 0),
  });
  const first = coreP.recall("酸梅汤");
  assert.ok(first.profileText.includes("阶段：早期"), "first recall sees 早期");
  assert.ok(first.profileText.includes("喜欢：酸梅汤"), "first recall sees 酸梅汤");
  assert.ok(first.hits.length > 0, "keyword recall still works");
  // Rewrite MEMORY.md in place — the profile lives in layer 1, not
  // in the keyword index, so no rebuildIndex() is called anywhere
  // in this test. The size differs AND the mtime is bumped, so the
  // MemoryFile cache cannot serve the stale parse.
  const memoryV2 = `# MEMORY

## 当前状态

- 名字: 夏柠柒
- 阶段: 中期
- 喜欢: 蓝莓蛋糕
- 约定:
  - 每周五查岗
`;
  const memPath = join(dirP, "MEMORY.md");
  writeFileSync(memPath, memoryV2, "utf8");
  const bumped = new Date(local(2026, 11, 9, 12, 0));
  utimesSync(memPath, bumped, bumped);
  const second = coreP.recall("酸梅汤");
  assert.ok(second.profileText.includes("阶段：中期"), "same core, no rebuild — recall sees 中期");
  assert.ok(second.profileText.includes("喜欢：蓝莓蛋糕"), "same core, no rebuild — recall sees 蓝莓蛋糕");
  assert.ok(!second.profileText.includes("早期"), "old stage is gone from the block");
  assert.ok(second.hits.length > 0, "keyword recall still works after the profile change");
});

check("0.4.3 item P1-2: updateProfile overwrites layer-1 name/stage — memory_search layer1 and profileText agree", () => {
  const dirQ = mkdtempSync(join(tmpdir(), "memory-core-profile-layer1-"));
  writeFileSync(join(dirQ, "MEMORY.md"), `# MEMORY

## 当前状态

- 名字: 夏柠柒
- 阶段: 早期
- 喜欢: 酸梅汤
`, "utf8");
  const coreQ = new MemoryCore({ dataDir: dirQ });
  coreQ.record({
    role: "user", text: "今天喝了酸梅汤，很解渴", window: "persona",
    sessionId: "s1", ts: local(2026, 11, 6, 10, 0),
  });
  // Before the profile write, layer1 and profileText say 早期/夏柠柒.
  const before = coreQ.recall("酸梅汤");
  assert.equal(before.layer1?.name, "夏柠柒", "before: layer1 name from MEMORY.md");
  assert.equal(before.layer1?.stage, "早期", "before: layer1 stage from MEMORY.md");
  // The report's repro: updateProfile then readLayer1() was still
  // empty while profileText had the new name. Now the merge copies
  // profile.name/stage onto the layer-1 fields themselves.
  coreQ.updateProfile({ name: "新名字", stage: "新阶段", relationshipStage: "更近了" });
  const layer1 = coreQ.readLayer1();
  assert.equal(layer1.name, "新名字", "after updateProfile: readLayer1().name is the profile name");
  assert.equal(layer1.stage, "新阶段", "after updateProfile: readLayer1().stage is the profile stage");
  assert.equal(layer1.profile?.relationshipStage, "更近了", "relationshipStage stays inside profile");
  const after = coreQ.recall("酸梅汤");
  assert.equal(after.layer1?.name, "新名字", "recall layer1.name matches the profile");
  assert.equal(after.layer1?.stage, "新阶段", "recall layer1.stage matches the profile");
  const layer1Text = formatLayer1(after.layer1!);
  assert.ok(layer1Text.includes("名字: 新名字"), "formatLayer1 shows the new name");
  assert.ok(layer1Text.includes("阶段: 新阶段"), "formatLayer1 shows the new stage");
  assert.ok(after.profileText.includes("她：新名字"), "profileText shows the new name");
  assert.ok(after.profileText.includes("阶段：新阶段"), "profileText shows the new stage");
  assert.ok(after.profileText.includes("关系：更近了"), "profileText shows the new relationship stage");
  // mergeProfile unit level: a profile field left unset falls back
  // to the layer-1 key, it never blanks it.
  const merged = mergeProfile(
    { name: "夏柠柒", stage: "早期", likes: [], dislikes: [], agreements: [], counters: {}, heavyNotes: [], extra: [] },
    { stage: "中期" },
  );
  assert.equal(merged.name, "夏柠柒", "unset profile.name falls back to the layer-1 name");
  assert.equal(merged.stage, "中期", "set profile.stage wins over the layer-1 stage");
});

check("0.4.0 item 4: formatProfileBlock — profile wins over layer-1 keys, missing fields skipped, max 5 lines", () => {
  assert.equal(
    formatProfileBlock(profLayer1),
    "她：夏柠柒\n阶段：早期\n关系：刚认识不久\n喜欢：酸梅汤\n约定：每天睡前聊一会儿",
    "full block is exactly the spec's example, one field per line",
  );
  // profile-only relationship, everything else missing → one line, no blanks.
  const bare = {
    profile: { relationshipStage: "刚认识不久" },
    likes: [], dislikes: [], agreements: [], counters: {},
    heavyNotes: [], extra: [],
  };
  assert.equal(formatProfileBlock(bare), "关系：刚认识不久", "missing fields are skipped, not blank lines");
  // No profile at all: falls back to the layer-1 name/stage keys.
  const legacy = {
    name: "夏柠柒", stage: "早期",
    likes: [], dislikes: [], agreements: [], counters: {},
    heavyNotes: [], extra: [],
  };
  assert.equal(
    formatProfileBlock(legacy),
    "她：夏柠柒\n阶段：早期",
    "no profile → layer-1 keys still build the block",
  );
  assert.equal(formatProfileBlock(null), "", "null layer 1 → empty string");
});

console.log(`\nALL PASS (0.4.0 item 4 additions)`);

// ---- 0.4.1 item 1: memory_profile write path (profile.json) --------
// Ported from A (core/src/profile.ts, verbatim): the profile is
// plugin-owned derived state in profile.json — loadProfile /
// saveProfile / mergeProfile, cleanString truncates at 500 chars,
// a dirty file reads as undefined, never throws. The wiring that
// lets profile.json win inside MemoryCore.recall/readLayer1 lives
// in core.ts and is NOT part of this merge (coordinator's patch);
// these tests lock the file-level behaviour and the B-side rules
// that must hold regardless: profile.json values win over the
// layer-1 assembly field by field, and a profile that exists
// still never injects on a no-hit turn.
check("0.4.1 item 1: profile.json round-trips through save/load, absent file is undefined", () => {
  const dirW = mkdtempSync(join(tmpdir(), "memory-core-profile-write-"));
  assert.equal(loadProfile(dirW), undefined, "no profile.json yet → undefined");
  assert.equal(existsSync(join(dirW, PROFILE_FILE)), false, "nothing written yet");
  const at = local(2026, 11, 9, 13, 0);
  saveProfile(dirW, { name: "夏柠柒", stage: "稳定期", relationshipStage: "熟悉陪伴", updatedAt: at });
  assert.ok(existsSync(join(dirW, PROFILE_FILE)), "saveProfile writes profile.json");
  assert.deepEqual(
    loadProfile(dirW),
    { name: "夏柠柒", stage: "稳定期", relationshipStage: "熟悉陪伴", updatedAt: at },
    "write then read returns the same profile",
  );
  // A second save keeps the fields it was not asked to change only
  // when the caller merges first — saveProfile itself stores exactly
  // what it is given (the tool merges over loadProfile before saving).
  saveProfile(dirW, { name: "夏柠柒", stage: "中期", updatedAt: at });
  const second = loadProfile(dirW);
  assert.equal(second?.name, "夏柠柒", "second save keeps the name it was given");
  assert.equal(second?.stage, "中期", "second save stores the new stage");
  assert.equal(second?.relationshipStage, undefined, "a field not passed is not resurrected");
  assert.equal(second?.updatedAt, at, "second save keeps the updatedAt it was given");
});

check("0.4.1 item 1: dirty profile.json reads as undefined, never throws; over-long values truncate at 500", () => {
  const dirD = mkdtempSync(join(tmpdir(), "memory-core-profile-dirty-"));
  writeFileSync(join(dirD, PROFILE_FILE), "{not json", "utf8");
  assert.equal(loadProfile(dirD), undefined, "invalid JSON → undefined");
  writeFileSync(join(dirD, PROFILE_FILE), "[1,2,3]", "utf8");
  assert.equal(loadProfile(dirD), undefined, "JSON array → undefined");
  writeFileSync(join(dirD, PROFILE_FILE), "\"just a string\"", "utf8");
  assert.equal(loadProfile(dirD), undefined, "JSON string → undefined");
  writeFileSync(join(dirD, PROFILE_FILE), "{}", "utf8");
  assert.equal(loadProfile(dirD), undefined, "empty object → undefined (no fields)");
  // Truncation + blank handling go through the same cleanString on
  // both the save and the load path.
  const long = "名".repeat(600);
  saveProfile(dirD, { name: long, stage: "   ", relationshipStage: "熟悉陪伴" });
  const cleaned = loadProfile(dirD);
  assert.equal(cleaned?.name?.length, 500, "600-char name truncates to 500");
  assert.equal(cleaned?.stage, undefined, "whitespace-only stage is dropped");
  assert.equal(cleaned?.relationshipStage, "熟悉陪伴", "other fields survive cleaning");
});

check("0.4.1 item 1: mergeProfile — profile.json wins, absent profile leaves layer 1 untouched", () => {
  const merged = mergeProfile(profLayer1, {
    name: "夏柠柒",
    stage: "稳定期",
    relationshipStage: "熟悉陪伴",
  });
  assert.equal(
    formatProfileBlock(merged),
    "她：夏柠柒\n阶段：稳定期\n关系：熟悉陪伴\n喜欢：酸梅汤\n约定：每天睡前聊一会儿",
    "profile.json stage/relationship win; likes/agreements still come from layer 1",
  );
  // A profile.json that only sets the relationship leaves the
  // layer-1 name/stage standing (formatProfileBlock falls back
  // field by field) — a partial profile never blanks the block.
  const partial = mergeProfile(profLayer1, { relationshipStage: "熟悉陪伴" });
  assert.equal(
    formatProfileBlock(partial),
    "她：夏柠柒\n阶段：早期\n关系：熟悉陪伴\n喜欢：酸梅汤\n约定：每天睡前聊一会儿",
    "partial profile.json: missing fields fall back to layer-1 keys",
  );
  assert.equal(
    mergeProfile(profLayer1, undefined),
    profLayer1,
    "no profile.json → the very same layer-1 object, B behaviour unchanged",
  );
  assert.equal(
    formatProfileBlock(mergeProfile(profLayer1, undefined)),
    formatProfileBlock(profLayer1),
    "no profile.json → the block is byte-identical to B's assembly",
  );
});

check("0.4.1 item 1 (regression lock): profile present + no recall hits → nothing is injected", () => {
  // The block EXISTS (profileText is non-empty) but the injectable
  // text stays empty: the profile only rides with hits, it never
  // leaks on its own. This is the exact behaviour A's always-on
  // condition (hits.length > 0 || profileText) broke.
  const noHit = recallFromEntries([profEntry], profLayer1, "完全不会匹配的词");
  assert.equal(noHit.hits.length, 0, "no hits for a non-matching query");
  assert.ok(noHit.profileText.includes("夏柠柒"), "the profile block itself still exists");
  assert.ok(noHit.profileText.includes("刚认识不久"), "relationship stage is in the block");
  assert.equal(noHit.text, "", "no hits → no injectable text at all, profile included");
});

check("0.4.1 item 1 (coordinator wiring): updateProfile + readLayer1/recall see profile.json", () => {
  // The core.ts wiring (not the file helpers above): updateProfile
  // writes profile.json under the write lock, and readLayer1 merges
  // it over the layer-1 assembly — so recall and memory_search see
  // the written values without any tool-layer merging.
  const dirC = mkdtempSync(join(tmpdir(), "memory-core-profile-wiring-"));
  const coreC = new MemoryCore({ dataDir: dirC });
  const written = coreC.updateProfile({ name: "夏柠柒", stage: "稳定期", relationshipStage: "熟悉陪伴" });
  assert.equal(written.stage, "稳定期", "updateProfile returns the written profile");
  assert.equal(coreC.readLayer1().profile?.stage, "稳定期", "readLayer1 merges profile.json in");
  assert.equal(coreC.readLayer1().profile?.relationshipStage, "熟悉陪伴", "relationship stage comes from profile.json");
  assert.ok(
    formatProfileBlock(coreC.readLayer1()).includes("阶段：稳定期"),
    "the profile block shows the written stage",
  );
  const partial = coreC.updateProfile({ stage: "中期" });
  assert.equal(partial.name, "夏柠柒", "partial update keeps the stored name");
  assert.equal(partial.stage, "中期", "partial update stores the new stage");
  assert.equal(partial.relationshipStage, "熟悉陪伴", "partial update keeps the stored relationship stage");
  assert.equal(loadProfile(dirC)?.stage, "中期", "the file on disk matches the merged write");
});

// ---- 0.4.0 item 5: 心光选择 + 传播激活 (小凌识海心光 + HippoRAG PPR) ----
// 2026-11-09 改版：打星不再只按分数排 — 分数只做候选排序（取前 3
// 条放进召回块），挑哪一条由会话中本来就要回话的模型定，不许为
// 此每轮多调一次模型。
//
// SCOPE NOTE on the diffusion step: the spec's body keeps the
// existing 0.2.0 expansion (one hop, second hop × GRAPH_HOP_DECAY
// = 0.5, keyword/recall edges only — no session edges), while its
// acceptance line ① says "扩散不超过一跳". The two contradict each
// other, and cutting the second hop would change existing behaviour
// (global principle 1: only add, never change). So the second hop
// stays, and the test below pins the bound that actually holds:
// diffusion never walks a session edge and never goes beyond the
// second hop. If a strict one-hop cap is wanted, that is a separate
// decision — it must not be smuggled in here.

const spotEntry = (id: string, text: string, mins: number): MemoryEntry => ({
  id,
  ts: local(2026, 11, 6, 10, mins),
  date: "2026/11/06",
  time: `10:${String(mins).padStart(2, "0")}`,
  role: "user",
  window: "persona",
  sessionId: "s1",
  importance: "light",
  text,
  source: "log",
});

check("0.4.0 item 5: diffusion walks keyword/recall edges only, never session edges, and stops at the second hop", () => {
  const dirS = mkdtempSync(join(tmpdir(), "memory-core-item5-diffusion-"));
  const graphS = new MemoryGraph(dirS);
  const storeS = new AttributeStore(dirS);
  const nowS = local(2026, 11, 6, 10, 30);
  const sA = spotEntry("s-a", "酸梅汤真好喝", 0);
  const sB = spotEntry("s-b", "昨天去爬山了", 5);
  const sC = spotEntry("s-c", "山顶风很大", 10);
  const sD = spotEntry("s-d", "今晚吃拉面", 15);
  const sE = spotEntry("s-e", "风很大别着凉", 20);
  graphS.link(sA.id, sB.id, "keyword", nowS);
  graphS.link(sB.id, sC.id, "keyword", nowS);
  graphS.link(sA.id, sD.id, "session", nowS);
  graphS.link(sC.id, sE.id, "keyword", nowS);
  // Valve off: the valve's per-topic cap (2) would cut one of the
  // three same-topic hits (seed + two hops), hiding the raw
  // diffusion bound this test pins. The valve itself is covered by
  // the candidate test below, on the default path.
  const r = recallFromEntries(
    [sA, sB, sC, sD, sE],
    null,
    "酸梅汤",
    { graph: graphS, attributes: storeS, valve: false },
    nowS,
  );
  const ids = r.hits.map((h) => h.entry.id);
  assert.ok(ids.includes("s-a"), "seed hit present");
  assert.ok(
    r.hits.some((h) => h.entry.id === "s-b" && h.viaGraph),
    "hop-1 keyword neighbour surfaces",
  );
  assert.ok(
    r.hits.some((h) => h.entry.id === "s-c" && h.viaGraph),
    "hop-2 keyword neighbour surfaces (second hop x0.5, per spec body)",
  );
  assert.ok(!ids.includes("s-d"), "session-only neighbour never surfaces");
  assert.ok(!ids.includes("s-e"), "third-hop neighbour never surfaces");
  // graph.ts item 3: only edges that actually surfaced gain the
  // +0.05 traverse bump; the existing 0.95/review decay is untouched.
  const w = (a: string, b: string): number =>
    graphS.find(a, b)?.weight ?? NaN;
  assert.ok(Math.abs(w(sA.id, sB.id) - 0.65) < 1e-9, `surfaced hop-1 edge bumped 0.6 -> 0.65, got ${w(sA.id, sB.id)}`);
  assert.ok(Math.abs(w(sB.id, sC.id) - 0.65) < 1e-9, `surfaced hop-2 edge bumped 0.6 -> 0.65, got ${w(sB.id, sC.id)}`);
  assert.ok(Math.abs(w(sA.id, sD.id) - 0.5) < 1e-9, "session edge untouched");
  assert.ok(Math.abs(w(sC.id, sE.id) - 0.6) < 1e-9, "never-walked edge untouched");
});

check("0.4.0 item 5: candidates are at most 3, one per topic, ranked by activation x edge weight", () => {
  // Unit: the sort key is activation x edge weight, not activation
  // alone — h3 (0.2 x 0.9 = 0.18) outranks h4 (0.5 x 0.2 = 0.10),
  // and h2 loses its topic to the higher-ranked h1.
  const hit = (
    id: string,
    activation: number,
    edgeWeight: number,
    topic: string,
    score: number,
  ): RecallHit => ({
    entry: spotEntry(id, `记忆${id}`, 0),
    score,
    matchedTokens: [],
    activation,
    topic,
    edgeWeight,
  });
  const pool = [
    hit("h1", 0.5, 1, "酸梅", 3),
    hit("h2", 0.4, 1, "酸梅", 2),
    hit("h3", 0.2, 0.9, "蓝莓", 2),
    hit("h4", 0.5, 0.2, "爬山", 2),
    hit("h5", 0.1, 1, "海边", 1),
  ];
  const cands = selectSpotlightCandidates(pool);
  assert.deepEqual(
    cands.map((h) => h.entry.id),
    ["h1", "h3", "h4"],
    "top 3 by activation x edge weight, one per topic",
  );
  assert.ok(
    cands.every((h) => h.spotlightCandidate === true),
    "returned candidates are flagged",
  );
  assert.equal(pool[1].spotlightCandidate, undefined, "same-topic loser is not flagged");
  assert.equal(pool[4].spotlightCandidate, undefined, "4th-ranked hit is not flagged");
  assert.deepEqual(selectSpotlightCandidates([]), [], "empty in, empty out");
  const two = selectSpotlightCandidates([
    hit("t1", 0.5, 1, "酸梅", 1),
    hit("t2", 0.4, 1, "蓝莓", 1),
  ]);
  assert.equal(two.length, 2, "fewer than 3 hits all become candidates");
  // End to end, default path (valve on): 6 distinct-topic heavy
  // entries, valve keeps top 5, candidates are 3 with unique topics.
  const words = ["酸梅", "蓝莓", "爬山", "海边", "摩天", "火锅"];
  const texts = [
    "今天喝了酸梅，味道很不错",
    "蓝莓蛋糕真好吃",
    "周末去爬山，累死了",
    "想去海边散步",
    "摩天轮上风很大",
    "晚上吃火锅",
  ];
  const entries: MemoryEntry[] = texts.map((text, i) => ({
    id: `s-cap-${i}`,
    ts: local(2026, 11, 6, 10, i),
    date: "2026/11/06",
    time: `10:0${i}`,
    role: "user",
    window: "persona",
    sessionId: "s1",
    importance: "heavy",
    text,
    source: "log",
  }));
  const r = recallFromEntries(entries, profLayer1, words.join(" "));
  assert.equal(r.hits.length, 5, "valve top 5 still holds with spotlight on");
  const flagged = r.hits.filter((h) => h.spotlightCandidate);
  assert.equal(flagged.length, 3, "exactly 3 candidates");
  assert.equal(
    new Set(flagged.map((h) => h.topic)).size,
    3,
    "one candidate per topic",
  );
  assert.ok(
    r.hits.every((h) => h.spotlight === undefined),
    "spotlight stays unset — reserved for a later explicit model mark",
  );
  // The block marks the 3 candidates with ☆ and carries exactly one
  // prompt line for the in-session model — no new tool, no extra call.
  const starLines = r.text.split("\n").filter((l) => l.startsWith("- ☆ "));
  assert.equal(starLines.length, 3, "exactly 3 ☆ lines in the block");
  assert.ok(r.text.includes("不用调工具"), "prompt line says no tool call");
  assert.ok(r.text.includes("不用单独解释"), "prompt line says no separate explanation");
  assert.ok(!r.text.includes("★"), "nothing is ★-marked by code");
  // No hits means no ☆ and no prompt line at all.
  const empty = recallFromEntries(entries, profLayer1, "完全不相关的词xyzabc");
  assert.equal(empty.text, "", "no hits, no block, no prompt line");
  // A block built from unmarked hits carries neither ☆ nor the prompt.
  const plain = formatRecallBlock([
    { entry: entries[0], score: 1, matchedTokens: [], activation: 0.5, topic: "酸梅" },
  ]);
  assert.ok(!plain.includes("☆"), "unmarked hits get no ☆");
  assert.ok(!plain.includes("心光"), "unmarked hits get no prompt line");
});

check("0.4.0 item 5: spotlight is reserved and unset by default — a single hit is a ☆ candidate, never ★", () => {
  const r = recallFromEntries(
    [spotEntry("s-only", "今天喝了酸梅汤", 0)],
    null,
    "酸梅汤",
  );
  assert.equal(r.hits.length, 1, "single hit");
  assert.equal(r.hits[0].spotlightCandidate, true, "single hit is a candidate");
  assert.equal(r.hits[0].spotlight, undefined, "spotlight stays unset");
  assert.ok(r.text.includes("☆"), "candidate is marked ☆ in the block");
  assert.ok(!r.text.includes("★"), "nothing is ★-marked by code");
});

check("0.4.0 item 5: old graph.json without a weight field loads on the type default and still diffuses", () => {
  const dirO5 = mkdtempSync(join(tmpdir(), "memory-core-item5-oldgraph-"));
  writeFileSync(
    join(dirO5, "graph.json"),
    JSON.stringify({
      version: 1,
      edges: [
        { from: "o-a", to: "o-b", type: "keyword", lastTraversedAt: 0 },
        { from: "o-a", to: "o-c", type: "session", lastTraversedAt: 0 },
        { from: "o-a", to: "o-d", type: "recall", weight: 0.9, lastTraversedAt: 0 },
        { from: "o-b", to: "o-c", type: "keyword", weight: 5, lastTraversedAt: 0 },
        { from: "o-b", to: "o-d", type: "keyword", weight: 0, lastTraversedAt: 0 },
      ],
    }),
    "utf8",
  );
  const graphO5 = new MemoryGraph(dirO5);
  assert.equal(graphO5.size, 4, "weight-less rows load, zero-weight row dropped");
  assert.equal(graphO5.find("o-a", "o-b")?.weight, 0.6, "missing weight defaults to the keyword initial");
  assert.equal(graphO5.find("o-a", "o-c")?.weight, 0.5, "missing weight defaults to the session initial");
  assert.equal(graphO5.find("o-a", "o-d")?.weight, 0.9, "explicit weight kept");
  assert.equal(graphO5.find("o-b", "o-c")?.weight, 1, "weight above 1 still clamped");
  assert.equal(graphO5.find("o-b", "o-d"), undefined, "zero-weight row still dropped");
  // And recall actually diffuses through the defaulted edge.
  const oA = spotEntry("o-a", "酸梅汤真好喝", 0);
  const oB = spotEntry("o-b", "昨天去爬山了", 5);
  const r = recallFromEntries(
    [oA, oB],
    null,
    "酸梅汤",
    { graph: graphO5 },
    local(2026, 11, 6, 10, 30),
  );
  assert.ok(
    r.hits.some((h) => h.entry.id === "o-b" && h.viaGraph),
    "default-weight edge diffuses",
  );
});

console.log(`\nALL PASS (0.4.0 item 5 additions)`);

// ---- 0.4.0 item 2: 带证据的信念层 + 三维信念 --------------------
// No fixed +0.05 / -0.1 steps any more (2026-11-09): the delta is the
// model's call, the code only clamps a single move to ±0.2 and
// strength to 0..1, and one contradicting entry deducts once.

const dirBel = mkdtempSync(join(tmpdir(), "memory-core-belief-"));
writeFileSync(join(dirBel, "MEMORY.md"), fixtureMemory, "utf8");
const coreBel = new MemoryCore({ dataDir: dirBel });
const belE1 = coreBel.record({ role: "user", text: "昨晚难过的时候想找你聊天", window: "persona", importance: "heavy", sessionId: "s1", ts: local(2026, 11, 5, 23, 30) });
const belE2 = coreBel.record({ role: "user", text: "半夜睡不着也想找你聊天", window: "persona", sessionId: "s1", ts: local(2026, 11, 6, 0, 30) });
const belE3 = coreBel.record({ role: "user", text: "答应陪你看星星结果没去成", window: "persona", sessionId: "s1", ts: local(2026, 11, 6, 20, 0) });
const belE4 = coreBel.record({ role: "user", text: "说好陪你看星星结果放你鸽子了", window: "persona", sessionId: "s1", ts: local(2026, 11, 6, 21, 0) });
const belE5 = coreBel.record({ role: "user", text: "明明约好一起吃饭他却没来", window: "persona", sessionId: "s1", ts: local(2026, 11, 6, 22, 0) });

check("0.4.0 item 2: create + support — model delta moves strength, clamped to 0.2 per move, proofCount + 1, non-verbatim quote rejected", () => {
  const created = coreBel.createBelief({
    dimension: "trust",
    statement: "他难过时会来找我",
    entryId: belE1.id,
    quote: "昨晚难过的时候想找你聊天",
  });
  assert.equal(created.ok, true, JSON.stringify(created.reasons));
  assert.ok(created.belief, "belief created");
  assert.equal(created.belief?.id, "BEL_TRUST_001", "id is assigned per-dimension, not invented by the model");
  assert.equal(created.belief?.strength, 0.5, "initial strength defaults to 0.5");
  assert.equal(created.belief?.uncertainty, 0.8, "initial uncertainty defaults to 0.8");
  assert.equal(created.belief?.proofCount, 1, "first evidence counts");
  const supported = coreBel.supportBelief(
    "BEL_TRUST_001",
    belE2.id,
    "半夜睡不着也想找你聊天",
    0.15,
  );
  assert.equal(supported.ok, true, JSON.stringify(supported.reasons));
  assert.equal(supported.belief?.strength, 0.65, "model delta 0.15 applied as-is");
  assert.equal(supported.belief?.proofCount, 2, "support is proofCount + 1");
  // Over-cap delta clamps to 0.2, no error.
  const clamped = coreBel.supportBelief(
    "BEL_TRUST_001",
    belE2.id,
    "半夜睡不着也想找你聊天",
    0.5,
  );
  assert.equal(clamped.ok, true);
  assert.ok(
    Math.abs((clamped.belief?.strength ?? 0) - 0.85) < 1e-9,
    `delta 0.5 clamped to 0.2 (got ${clamped.belief?.strength})`,
  );
  assert.equal(clamped.belief?.proofCount, 3, "clamped support still counts its evidence");
  // A paraphrased quote is not verbatim: rejected, nothing moves.
  const before = coreBel.listBeliefs()[0];
  const paraphrased = coreBel.supportBelief(
    "BEL_TRUST_001",
    belE1.id,
    "昨晚难过第一个想到你",
    0.1,
  );
  assert.equal(paraphrased.ok, false, "paraphrase must be rejected");
  assert.ok(paraphrased.reasons.length > 0, "rejection carries a reason");
  const after = coreBel.listBeliefs()[0];
  assert.equal(after.strength, before.strength, "rejected support moves nothing");
  assert.equal(after.proofCount, before.proofCount, "rejected support counts nothing");
  // Unknown belief id is rejected, not created.
  const unknown = coreBel.supportBelief(belE1.id, belE1.id, "昨晚难过的时候想找你聊天", 0.1);
  assert.equal(unknown.ok, false, "support on a missing belief is rejected");
  // The store itself round-trips through beliefs.json.
  const persisted = JSON.parse(readFileSync(join(dirBel, "beliefs.json"), "utf8")) as {
    beliefs: Array<{ id: string; proofCount: number }>;
  };
  assert.equal(persisted.beliefs.length, 1);
  assert.equal(persisted.beliefs[0].proofCount, 3);
});

check("0.4.0 item 2: contradict — same entry deducts once only, a different entry deducts again, clamped to -0.2", () => {
  // Strength after the previous check: 0.85.
  const first = coreBel.contradictBelief(
    "BEL_TRUST_001",
    belE3.id,
    "答应陪你看星星结果没去成",
    0.1,
  );
  assert.equal(first.ok, true, JSON.stringify(first.reasons));
  assert.ok(Math.abs((first.belief?.strength ?? 0) - 0.75) < 1e-9, "first contradict deducts 0.1");
  assert.equal(first.belief?.proofCount, 3, "contradict never moves proofCount");
  assert.deepEqual(first.belief?.contradicting, [belE3.id], "charged entry recorded");
  // Same entry again: ignored outright — duplicate, no deduction.
  const dup = coreBel.contradictBelief(
    "BEL_TRUST_001",
    belE3.id,
    "答应陪你看星星结果没去成",
    0.1,
  );
  assert.equal(dup.ok, true);
  assert.equal(dup.duplicate, true, "repeat contradict is flagged duplicate");
  assert.ok(Math.abs((dup.belief?.strength ?? 0) - 0.75) < 1e-9, "duplicate deducts nothing");
  // A different conflicting entry deducts again, clamped to -0.2.
  const second = coreBel.contradictBelief(
    "BEL_TRUST_001",
    belE4.id,
    "说好陪你看星星结果放你鸽子了",
    0.3,
  );
  assert.equal(second.ok, true);
  assert.ok(Math.abs((second.belief?.strength ?? 0) - 0.55) < 1e-9, "delta 0.3 clamped to -0.2");
  // Non-verbatim contradict quote is rejected before any charge
  // (a fresh entry: an already-charged one returns duplicate
  // before verification, by design — it moves nothing either way).
  const bad = coreBel.contradictBelief(
    "BEL_TRUST_001",
    belE5.id,
    "约好吃饭他没来",
    0.1,
  );
  assert.equal(bad.ok, false, "non-verbatim contradict quote rejected");
  assert.deepEqual(
    coreBel.listBeliefs()[0].contradicting,
    [belE3.id, belE4.id],
    "rejected contradict charges nothing new",
  );
  assert.ok(
    Math.abs((coreBel.listBeliefs()[0].strength ?? 0) - 0.55) < 1e-9,
    "rejected contradict moves nothing",
  );
});

check("0.4.1 (A) core persona-source check: a task-window entry can never create / support / contradict a belief — source_entry_not_found, nothing moves; persona sources still pass", () => {
  const dirT = mkdtempSync(join(tmpdir(), "memory-core-belief-task-src-"));
  writeFileSync(join(dirT, "MEMORY.md"), fixtureMemory, "utf8");
  const coreT = new MemoryCore({ dataDir: dirT });
  const personaE = coreT.record({ role: "user", text: "昨晚难过的时候想找你聊天", window: "persona", sessionId: "s1", ts: local(2026, 11, 6, 10, 0) });
  const taskE = coreT.record({ role: "user", text: "任务清单：买一张地铁卡", window: "task", sessionId: "s1", ts: local(2026, 11, 6, 10, 5) });
  // Persona source still passes (regression): the belief is created.
  const created = coreT.createBelief({
    dimension: "trust",
    statement: "他难过时会来找我",
    entryId: personaE.id,
    quote: "昨晚难过的时候想找你聊天",
  });
  assert.equal(created.ok, true, JSON.stringify(created.reasons));
  assert.equal(created.belief?.id, "BEL_TRUST_001");
  // Task source, verbatim quote and all: every one of the three
  // call sites throws source_entry_not_found (A's error name) and
  // the belief does not move.
  assert.throws(
    () =>
      coreT.createBelief({
        dimension: "trust",
        statement: "他只惦记任务清单",
        entryId: taskE.id,
        quote: "任务清单：买一张地铁卡",
      }),
    /source_entry_not_found/,
    "create with a task-window source throws",
  );
  assert.throws(
    () => coreT.supportBelief("BEL_TRUST_001", taskE.id, "任务清单：买一张地铁卡", 0.1),
    /source_entry_not_found/,
    "support with a task-window source throws",
  );
  assert.throws(
    () => coreT.contradictBelief("BEL_TRUST_001", taskE.id, "任务清单：买一张地铁卡", 0.1),
    /source_entry_not_found/,
    "contradict with a task-window source throws",
  );
  // A missing source id throws the same error (A's rule: no source
  // entry at all is source_entry_not_found, not a silent ok:false).
  assert.throws(
    () => coreT.supportBelief("BEL_TRUST_001", "no-such-id", "任务清单：买一张地铁卡", 0.1),
    /source_entry_not_found/,
    "support with an unknown source id throws",
  );
  assert.equal(coreT.listBeliefs().length, 1, "rejected writes store nothing new");
  assert.equal(coreT.listBeliefs()[0]?.strength, 0.5, "rejected writes move nothing");
  assert.deepEqual(coreT.listBeliefs()[0]?.contradicting, [], "rejected contradict charges nothing");
  // Persona source still moves the belief afterwards (regression).
  const supported = coreT.supportBelief(
    "BEL_TRUST_001",
    personaE.id,
    "昨晚难过的时候想找你聊天",
    0.1,
  );
  assert.equal(supported.ok, true, JSON.stringify(supported.reasons));
  assert.ok(Math.abs((supported.belief?.strength ?? 0) - 0.6) < 1e-9, "persona support still applies");
});

check("0.4.0 item 2: decay — strength x 0.99 per silent day, never to 0, never deletes the belief", () => {
  const dirD = mkdtempSync(join(tmpdir(), "memory-core-belief-decay-"));
  const storeD = new BeliefStore(dirD);
  const nowD = local(2026, 11, 7, 9, 0);
  const byIdD = new Map<string, import("../src/index.ts").MemoryEntry>();
  const created = storeD.create(
    { dimension: "closeness", statement: "他睡前会来找我", strength: 0.5 },
    byIdD,
    nowD,
  );
  assert.equal(created.ok, true);
  assert.equal(storeD.decayBeliefs(nowD), 0, "same-day review decays nothing");
  assert.equal(storeD.decayBeliefs(nowD + 3 * 24 * 60 * 60 * 1000), 1, "one belief decayed over 3 silent days");
  const after3 = storeD.get(created.belief?.id ?? "")?.strength ?? 0;
  assert.ok(
    Math.abs(after3 - 0.5 * Math.pow(0.99, 3)) < 1e-9,
    `3 days: 0.5 x 0.99^3 (got ${after3})`,
  );
  assert.equal(storeD.decayBeliefs(nowD + 3 * 24 * 60 * 60 * 1000), 0, "the same silence is never charged twice");
  // A nearly-dead belief survives 100 silent days, weaker but present.
  const weak = storeD.create(
    { dimension: "safety", statement: "他不会突然消失", strength: 0.01 },
    byIdD,
    nowD,
  );
  storeD.decayBeliefs(nowD + 100 * 24 * 60 * 60 * 1000);
  const weakAfter = storeD.get(weak.belief?.id ?? "");
  assert.ok(weakAfter !== undefined, "faded belief is kept, not deleted");
  assert.ok((weakAfter?.strength ?? 0) > 0, "strength never reaches 0");
  assert.ok((weakAfter?.strength ?? 1) < 0.01, "100 days still fades it");
});

check("0.4.0 item 2: review proposes beliefCandidates only — no write to beliefs.json, quotes verbatim", () => {
  const dirR2 = mkdtempSync(join(tmpdir(), "memory-core-belief-review-"));
  writeFileSync(join(dirR2, "MEMORY.md"), fixtureMemory, "utf8");
  const coreR2 = new MemoryCore({ dataDir: dirR2 });
  const f1 = coreR2.record({ role: "user", text: "昨晚难过的时候想找你聊天", window: "persona", sessionId: "s1", ts: local(2026, 11, 5, 23, 30) });
  const f2 = coreR2.record({ role: "user", text: "半夜睡不着也想找你聊天", window: "persona", sessionId: "s1", ts: local(2026, 11, 6, 0, 30) });
  coreR2.record({ role: "user", text: "今天天气不错", window: "persona", sessionId: "s1", ts: local(2026, 11, 6, 10, 0) });
  const result = coreR2.review(true, local(2026, 11, 7, 9, 0));
  assert.ok(result !== null && result.ran, "review ran");
  assert.ok(result.beliefCandidates && result.beliefCandidates.length >= 1, "at least one belief candidate proposed");
  const cand = result.beliefCandidates?.find((c) =>
    c.sourceIds.includes(f1.id) && c.sourceIds.includes(f2.id),
  );
  assert.ok(cand, "the shared-topic pair is proposed");
  assert.equal("statement" in (cand as object), false, "a candidate carries no statement — the model writes it");
  assert.equal("dimension" in (cand as object), false, "a candidate carries no dimension guess — the model picks it");
  const byId = new Map([[f1.id, f1], [f2.id, f2]]);
  for (let i = 0; i < (cand?.sourceIds.length ?? 0); i++) {
    const quote = cand?.quotes[i] ?? "";
    assert.ok(
      (byId.get(cand?.sourceIds[i] ?? "")?.text ?? "").includes(quote),
      "every candidate quote is a verbatim substring of its source",
    );
  }
  assert.equal(
    existsSync(join(dirR2, "beliefs.json")),
    false,
    "the review proposes only — it writes no belief",
  );
  // And the candidates reach the model through the daily-review
  // prompt (the memory_fragment flow's M-1 surfacing, same shape).
  const prompt = buildModelReviewPrompt([], [], result.beliefCandidates ?? []);
  assert.ok(prompt.includes("memory_belief"), "review prompt names the belief tool");
  assert.ok(prompt.includes(cand?.topic ?? ""), "review prompt carries the candidate topic");
  assert.ok(
    (cand?.quotes ?? []).every((q) => prompt.includes(q)),
    "review prompt carries the verbatim quotes for the model to quote back",
  );
});

check("0.4.0 item 2: recall belief line — one compact line when beliefs exist, none when empty, no token-cap budget", () => {
  const dirL = mkdtempSync(join(tmpdir(), "memory-core-belief-line-"));
  const storeL = new BeliefStore(dirL);
  const byIdL = new Map<string, import("../src/index.ts").MemoryEntry>();
  const eL: import("../src/index.ts").MemoryEntry = {
    id: "l-1",
    ts: local(2026, 11, 6, 10, 0),
    date: "2026/11/06",
    time: "10:00",
    role: "user",
    window: "persona",
    sessionId: "s1",
    importance: "heavy",
    text: "昨晚难过的时候想找你聊天",
    source: "log",
  };
  byIdL.set(eL.id, eL);
  // No beliefs: no line, block unchanged.
  const plain = recallFromEntries([eL], null, "难过", {}, local(2026, 11, 6, 10, 30));
  assert.ok(!plain.text.includes("关系："), "empty belief layer adds no line");
  // One belief: exactly one extra line, token count unchanged.
  storeL.create(
    { dimension: "trust", statement: "他难过时会来找我", strength: 0.7, entryId: eL.id, quote: "昨晚难过的时候想找你聊天" },
    byIdL,
    local(2026, 11, 6, 10, 0),
  );
  const withLine = recallFromEntries(
    [eL],
    null,
    "难过",
    { beliefs: storeL },
    local(2026, 11, 6, 10, 30),
  );
  assert.equal(withLine.estimatedTokens, plain.estimatedTokens, "belief line takes no token-cap budget");
  assert.ok(
    withLine.text.includes("关系：信任 0.7（证据 1 条）"),
    `belief line appended (got: ${JSON.stringify(withLine.text)})`,
  );
  assert.ok(
    formatBeliefLine(storeL.all()).split("\n").length <= 2,
    "belief line is at most 2 lines",
  );
  assert.equal(formatBeliefLine([]), "", "no beliefs means no line");
  // No hits: no block at all, even with beliefs (recall gate holds).
  const noHits = recallFromEntries([eL], null, "不存在的词", { beliefs: storeL }, local(2026, 11, 6, 10, 30));
  assert.equal(noHits.text, "", "no hits means no block and no belief line");
  // Summaries: empty dimensions read 0 / 1 / 0, never null.
  const empty = summarizeBeliefs([]);
  assert.deepEqual(empty.safety, { strength: 0, uncertainty: 1, proofCount: 0, beliefs: 0 });
  assert.deepEqual(empty.closeness, { strength: 0, uncertainty: 1, proofCount: 0, beliefs: 0 });
  const summary = summarizeBeliefs(storeL.all());
  assert.equal(summary.trust.strength, 0.7);
  assert.equal(summary.trust.proofCount, 1);
  assert.equal(summary.trust.beliefs, 1);
  assert.equal(summary.safety.beliefs, 0, "dimensions without beliefs stay empty");
});

check("0.4.0 item 2: old data — no beliefs.json starts empty, hand-written old-shape rows load on defaults", () => {
  const dirO2 = mkdtempSync(join(tmpdir(), "memory-core-belief-old-"));
  writeFileSync(join(dirO2, "MEMORY.md"), fixtureMemory, "utf8");
  const coreO2 = new MemoryCore({ dataDir: dirO2 });
  assert.equal(coreO2.listBeliefs().length, 0, "no beliefs.json means empty beliefs, not a crash");
  assert.equal(coreO2.stats().beliefs, 0, "stats counts zero beliefs");
  assert.deepEqual(coreO2.stats().beliefDimensions.trust, { strength: 0, uncertainty: 1, proofCount: 0, beliefs: 0 });
  const eO2 = coreO2.record({ role: "user", text: "昨晚难过的时候想找你聊天", window: "persona", importance: "heavy", sessionId: "s1", ts: local(2026, 11, 6, 10, 0) });
  assert.ok(coreO2.recall("难过").hits.some((h) => h.entry.id === eO2.id), "recall works with no beliefs file");
  assert.equal(coreO2.beliefLine(), "", "belief line is empty, not a crash");
  // Hand-written old-shape beliefs.json: no contradicting, no
  // proofCount, plus one corrupt row (bad dimension) that must be
  // dropped, not crash the load.
  writeFileSync(
    join(dirO2, "beliefs.json"),
    JSON.stringify({
      version: 1,
      beliefs: [
        {
          id: "BEL_TRUST_001",
          dimension: "trust",
          statement: "他难过时会来找我",
          strength: 0.6,
          evidence: [{ entryId: eO2.id, quote: "昨晚难过的时候想找你聊天" }],
          uncertainty: 0.7,
          updatedAt: local(2026, 11, 6, 10, 0),
        },
        {
          id: "BEL_NOPE_001",
          dimension: "admiration",
          statement: "bad row",
          strength: 0.9,
          evidence: [],
          uncertainty: 0.5,
          updatedAt: 0,
        },
      ],
    }),
    "utf8",
  );
  const coreO2b = new MemoryCore({ dataDir: dirO2 });
  assert.equal(coreO2b.listBeliefs().length, 1, "corrupt-dimension row dropped, good row kept");
  const loaded = coreO2b.listBeliefs()[0];
  assert.equal(loaded.proofCount, 1, "proofCount recomputed from evidence");
  assert.deepEqual(loaded.contradicting, [], "missing contradicting defaults to []");
  assert.ok(
    coreO2b.recall("难过").text.includes("关系：信任 0.6（证据 1 条）"),
    "old-shape belief still injects its line",
  );
  // verifyBeliefEvidence: the shared verbatim check.
  const byId = new Map([[eO2.id, eO2]]);
  assert.equal(verifyBeliefEvidence(eO2.id, "昨晚难过的时候想找你聊天", byId).ok, true);
  assert.equal(verifyBeliefEvidence(eO2.id, "昨晚难过第一个想到你", byId).ok, false);
  assert.equal(verifyBeliefEvidence("no-such-id", "昨晚难过的时候想找你聊天", byId).ok, false);
});

console.log(`\nALL PASS (0.4.0 item 2 additions)`);

// ---- 0.4.0 item 3: 反思触发器 (Generative Agents reflection) -------
// 2026-11-09 去机械化：没有 50 分硬门槛，触发与否归模型，不归
// 分数。代码只留一个极小防打扰下限（REFLECTION_MIN_FLOOR = 5，
// 24h 新增 significance 总和）：低于它连提示词都不拼；高于它
// 由模型自己决定做不做反思、做什么反思。反思结论存成一条
// type: "reflection" 的特殊碎片——结论的新词是看出来的，不
// 校验；只有「」引用的话必须逐字出自来源，找不到整条作废。

const dirRef = mkdtempSync(join(tmpdir(), "memory-core-reflection-"));
writeFileSync(join(dirRef, "MEMORY.md"), fixtureMemory, "utf8");
const coreRef = new MemoryCore({ dataDir: dirRef });
const refTexts = [
  "今天好累",
  "昨天也说好累",
  "前天累得不想动",
  "今天又说累",
  "累得睡不着",
  "好累，什么都不想干",
];
const refEntries = refTexts.map((text, i) =>
  coreRef.record({
    role: "user", text, window: "persona", importance: "heavy",
    sessionId: "s1", ts: local(2026, 11, 6, 10, i),
  }),
);

check("0.4.0 item 3: review hands the model a reflection prompt only above the floor — below it, no prompt at all", () => {
  // 6 heavy in 24 h: 6 x 0.9 = 5.4 >= 5 — the prompt is built.
  // (On the old 50-point scale this would never have triggered;
  // the point of the de-mechanisation is that the code no longer
  // scores whether to reflect at all.)
  const result = coreRef.review(true, local(2026, 11, 7, 9, 0));
  assert.ok(result !== null && result.ran, "review ran");
  assert.ok(
    typeof result.reflectionPrompt === "string" && result.reflectionPrompt.length > 0,
    "above the floor the review carries a reflection prompt",
  );
  assert.ok(
    (result.reflectionPrompt ?? "").includes("今天好累"),
    "the prompt carries the triggering memories verbatim",
  );
  assert.ok(
    (result.reflectionPrompt ?? "").includes("你自己决定"),
    "the prompt says the decision is the model's, not the code's",
  );
  assert.ok(
    (result.reflectionPrompt ?? "").includes("memory_reflect"),
    "the prompt names the tool that saves the conclusion",
  );
  assert.ok(
    (result.reflectionPrompt ?? "").includes(refEntries[0].id),
    "the prompt carries the entry ids for sourceIds",
  );
  assert.equal(
    existsSync(join(dirRef, "fragments.json")),
    false,
    "the review proposes only — it writes no reflection",
  );
  // 5 heavy in 24 h: 5 x 0.9 = 4.5 < 5 — no prompt is built.
  const dirLow = mkdtempSync(join(tmpdir(), "memory-core-reflection-low-"));
  writeFileSync(join(dirLow, "MEMORY.md"), fixtureMemory, "utf8");
  const coreLow = new MemoryCore({ dataDir: dirLow });
  for (let i = 0; i < 5; i++) {
    coreLow.record({
      role: "user", text: refTexts[i], window: "persona",
      importance: "heavy", sessionId: "s1", ts: local(2026, 11, 6, 10, i),
    });
  }
  const low = coreLow.review(true, local(2026, 11, 7, 9, 0));
  assert.equal(low?.reflectionPrompt, undefined, "below the floor: no prompt at all");
  // 6 heavy but 49 h old: outside the 24 h window — no prompt.
  const dirOld = mkdtempSync(join(tmpdir(), "memory-core-reflection-old-"));
  writeFileSync(join(dirOld, "MEMORY.md"), fixtureMemory, "utf8");
  const coreOldR = new MemoryCore({ dataDir: dirOld });
  for (let i = 0; i < 6; i++) {
    coreOldR.record({
      role: "user", text: refTexts[i], window: "persona",
      importance: "heavy", sessionId: "s1", ts: local(2026, 11, 5, 8, i),
    });
  }
  const old = coreOldR.review(true, local(2026, 11, 7, 9, 0));
  assert.equal(old?.reflectionPrompt, undefined, "memories older than 24 h do not trigger");
  // 6 heavy but task-window: task entries never count.
  const dirTask = mkdtempSync(join(tmpdir(), "memory-core-reflection-task-"));
  writeFileSync(join(dirTask, "MEMORY.md"), fixtureMemory, "utf8");
  const coreTask = new MemoryCore({ dataDir: dirTask });
  for (let i = 0; i < 6; i++) {
    coreTask.record({
      role: "user", text: refTexts[i], window: "task",
      importance: "heavy", sessionId: "s1", ts: local(2026, 11, 6, 10, i),
    });
  }
  const task = coreTask.review(true, local(2026, 11, 7, 9, 0));
  assert.equal(task?.reflectionPrompt, undefined, "task-window entries never trigger a reflection");
});

check("0.4.0 item 3: buildReflectionPrompt + quote extraction + the prompt rides the daily-review context", () => {
  const prompt = buildReflectionPrompt(refEntries.slice(0, 3));
  assert.ok(prompt.includes(refEntries[0].id), "prompt carries the entry ids");
  assert.ok(prompt.includes("前天累得不想动"), "prompt carries the verbatim texts");
  assert.ok(prompt.includes("不用每轮都反思"), "prompt says not to reflect every round");
  // Quote extraction: 「」 and “” both accepted, deduped.
  assert.deepEqual(
    extractReflectionQuotes("他最近压力大，「今天好累」「昨天也说好累」「今天好累」"),
    ["今天好累", "昨天也说好累"],
    "「」 quotes extracted and deduped",
  );
  assert.deepEqual(
    extractReflectionQuotes("他说“今天好累”，又说“昨天也说好累”"),
    ["今天好累", "昨天也说好累"],
    "“” quotes extracted too",
  );
  assert.deepEqual(extractReflectionQuotes("他最近压力大"), [], "no quotes means no citations");
  assert.deepEqual(extractReflectionQuotes(""), [], "empty text has no quotes");
  // The review prompt carries the reflection block only when the
  // review actually produced one; below the floor there is no
  // section at all, so she is never asked.
  const withBlock = buildModelReviewPrompt([], [], [], prompt);
  assert.ok(withBlock.includes("memory_reflect"), "review context carries the reflection prompt");
  assert.ok(withBlock.includes("今天好累"), "review context carries the triggering memories");
  const withoutBlock = buildModelReviewPrompt([], [], [], "");
  assert.ok(!withoutBlock.includes("memory_reflect"), "no reflection prompt means no reflection section");
  assert.ok(!withoutBlock.includes("值得你想想"), "no reflection prompt means no reflection lead-in");
  const legacyCall = buildModelReviewPrompt([], [], []);
  assert.ok(!legacyCall.includes("memory_reflect"), "the old 3-arg call is unchanged");
});

const reflSaved = coreRef.saveReflection(
  "他最近压力大，「今天好累」「昨天也说好累」",
  refEntries.slice(0, 3).map((e) => e.id),
);
check("0.4.0 item 3: saveReflection stores a type:reflection fragment — novel insight words pass, recall brings the conclusion", () => {
  assert.equal(reflSaved.ok, true, JSON.stringify(reflSaved.reasons));
  assert.ok(reflSaved.fragment, "fragment saved");
  assert.equal(reflSaved.fragment?.type, "reflection", "stored as a reflection fragment");
  assert.ok(
    (reflSaved.fragment?.id ?? "").startsWith("refl-"),
    "reflection ids are distinguishable from ordinary fragments",
  );
  assert.equal(reflSaved.fragment?.text, "他最近压力大，「今天好累」「昨天也说好累」");
  assert.deepEqual(reflSaved.fragment?.quotes, ["今天好累", "昨天也说好累"]);
  assert.equal(reflSaved.fragment?.tone.label, "反思", "reflection tone is 反思, not an attitude tag");
  assert.equal(reflSaved.fragment?.verified, true);
  const persisted = JSON.parse(readFileSync(join(dirRef, "fragments.json"), "utf8")) as {
    fragments: Array<{ id: string; type?: string }>;
  };
  assert.equal(persisted.fragments.length, 1, "one fragment persisted");
  assert.equal(persisted.fragments[0].type, "reflection", "type survives to disk");
  // Recall brings the CONCLUSION, not the three originals — and
  // the retrieval-time re-check must not mark it suspect: its
  // insight words ("压力") appear in no source, only its quotes
  // are checked (quote-only verification). (Query "好累", not
  // "累": a single-char query puts all six entries on one valve
  // topic and the per-topic cap 2 keeps only the two newest —
  // the reflection's sources lose the valve race, which is the
  // valve working as designed, not a reflection failure.)
  const recalled = coreRef.recall("好累");
  const reflHit = recalled.hits.find((h) => h.fragmentId === reflSaved.fragment?.id);
  assert.ok(reflHit, "recall surfaces the reflection fragment");
  assert.equal(reflHit?.displayText, "他最近压力大，「今天好累」「昨天也说好累」", "the injected text is the conclusion");
  assert.equal(reflHit?.fragmentTone, "反思");
  assert.equal(reflHit?.fragmentFallback, undefined, "no fallback to the verbatim source");
  assert.equal(coreRef.stats().suspectFragments, 0, "the reflection is not marked suspect");
  // The type survives a reload, and recall still brings it.
  const coreRef2 = new MemoryCore({ dataDir: dirRef });
  assert.equal(coreRef2.listFragments()[0]?.type, "reflection", "type survives a reload");
  const recalled2 = coreRef2.recall("好累");
  assert.ok(
    recalled2.hits.some((h) => h.fragmentId === reflSaved.fragment?.id),
    "reloaded core still recalls the reflection",
  );
  assert.equal(coreRef2.stats().suspectFragments, 0, "still not suspect after reload");
  // Valve-off, direct: the fragment injection itself does not
  // depend on valve ordering — every covered source folds into
  // the one reflection, and the quote-only re-check passes.
  const direct = recallFromEntries(
    refEntries,
    null,
    "好累",
    { fragments: new FragmentStore(dirRef), valve: false },
    local(2026, 11, 6, 12, 0),
  );
  assert.ok(
    direct.hits.some((h) => h.fragmentId === reflSaved.fragment?.id),
    "direct recall (valve off) surfaces the reflection",
  );
  assert.ok(
    direct.hits.every((h) => h.fragmentFallback !== true),
    "no hit falls back to the verbatim source",
  );
});

check("0.4.0 item 3: saveReflection rejects a fabricated quote — the whole reflection is void, nothing is stored", () => {
  const before = coreRef.listFragments().length;
  const fabricated = coreRef.saveReflection(
    "他最近压力大，「今天一点都不累」",
    [refEntries[0].id],
  );
  assert.equal(fabricated.ok, false, "a quote not in the sources must be rejected");
  assert.ok(fabricated.reasons.length > 0, "rejection carries a reason");
  assert.ok(
    fabricated.reasons.some((r) => r.includes("今天一点都不累")),
    "the reason names the fabricated quote",
  );
  assert.equal(coreRef.listFragments().length, before, "rejected reflection stores nothing");
  // No quotes at all: ungrounded, void too.
  const quoteless = coreRef.saveReflection("他最近压力大", [refEntries[0].id]);
  assert.equal(quoteless.ok, false, "a conclusion with no citations is void");
  assert.ok(quoteless.reasons.some((r) => r.includes("没有任何引用")), "the reason says a citation is required");
  assert.equal(coreRef.listFragments().length, before, "quoteless reflection stores nothing");
  // Unknown source id: rejected before any verification.
  const unknownSrc = coreRef.saveReflection("他最近压力大，「今天好累」", ["no-such-id"]);
  assert.equal(unknownSrc.ok, false, "unknown source id is rejected");
  assert.equal(coreRef.listFragments().length, before, "unknown-source reflection stores nothing");
  // Empty text / empty sourceIds: rejected, nothing stored.
  assert.equal(coreRef.saveReflection("  ", [refEntries[0].id]).ok, false);
  assert.equal(coreRef.saveReflection("他最近压力大，「今天好累」", []).ok, false);
  assert.equal(coreRef.listFragments().length, before, "shape failures store nothing");
  // verifyReflection directly: the shared quote-only check.
  const byId = new Map(refEntries.map((e) => [e.id, e]));
  const sources = [refEntries[0], refEntries[1]];
  assert.equal(
    verifyReflection("他最近压力大，「今天好累」", sources).ok,
    true,
    "verbatim quote passes",
  );
  assert.equal(
    verifyReflection("他最近压力大，「今天一点都不累」", sources).ok,
    false,
    "fabricated quote fails the direct check",
  );
  assert.equal(
    verifyReflection("他最近压力大", sources).ok,
    false,
    "no quote fails the direct check",
  );
  void byId;
});

check("0.4.1 (A) core persona-source check: saveReflection rejects a task-window source — the whole reflection is void, nothing stored; persona sources still pass", () => {
  const dirT = mkdtempSync(join(tmpdir(), "memory-core-reflection-task-src-"));
  writeFileSync(join(dirT, "MEMORY.md"), fixtureMemory, "utf8");
  const coreT = new MemoryCore({ dataDir: dirT });
  const personaE = coreT.record({ role: "user", text: "今天好累", window: "persona", sessionId: "s1", ts: local(2026, 11, 6, 10, 0) });
  const taskE = coreT.record({ role: "user", text: "任务清单：买一张地铁卡", window: "task", sessionId: "s1", ts: local(2026, 11, 6, 10, 5) });
  // Persona source still passes (regression).
  const saved = coreT.saveReflection("他最近压力大，「今天好累」", [personaE.id]);
  assert.equal(saved.ok, true, JSON.stringify(saved.reasons));
  assert.equal(coreT.listFragments().length, 1, "one reflection stored");
  // Task-only source: rejected outright, nothing stored — even
  // though the quote is verbatim from the task entry.
  const taskOnly = coreT.saveReflection("任务很重，「买一张地铁卡」", [taskE.id]);
  assert.equal(taskOnly.ok, false, "a task-window source is rejected");
  assert.ok(taskOnly.reasons.some((r) => r.includes("人设窗口")), "the reason says the source must be persona");
  assert.equal(coreT.listFragments().length, 1, "rejected reflection stores nothing");
  // Mixed sources: one task id among persona ids voids the whole
  // reflection too — no partial save.
  const mixed = coreT.saveReflection("他最近压力大，「今天好累」「买一张地铁卡」", [personaE.id, taskE.id]);
  assert.equal(mixed.ok, false, "a mixed persona + task source list is rejected in full");
  assert.equal(coreT.listFragments().length, 1, "mixed-source reflection stores nothing");
  // Unknown source id keeps its old contract: ok:false, not a throw.
  const unknownSrc = coreT.saveReflection("他最近压力大，「今天好累」", ["no-such-id"]);
  assert.equal(unknownSrc.ok, false, "unknown source id is still rejected as ok:false");
  assert.equal(coreT.listFragments().length, 1, "unknown-source reflection stores nothing");
});

check("0.4.1 follow-up: reflectionCheck returns the gate sourceIds — the only ids a save may cite", () => {
  const dirG = mkdtempSync(join(tmpdir(), "memory-core-reflection-gate-ids-"));
  writeFileSync(join(dirG, "MEMORY.md"), fixtureMemory, "utf8");
  const coreG = new MemoryCore({ dataDir: dirG });
  const now = Date.now();
  const freshIds: string[] = [];
  for (let i = 0; i < 6; i++) {
    const e = coreG.record({ role: "user", text: `今天好累${i}`, window: "persona", importance: "heavy", sessionId: "s1", ts: now - i * 60_000 });
    freshIds.push(e.id);
  }
  const gate = coreG.reflectionCheck(now);
  assert.equal(gate.reached, true, "6 fresh heavies clear the floor");
  assert.equal(gate.entryCount, 6, "six entries in the gate");
  assert.deepEqual([...gate.sourceIds].sort(), [...freshIds].sort(), "the check returns exactly the gate entry ids");
  // Old entries only: the gate is empty and the check says so.
  const dirOld = mkdtempSync(join(tmpdir(), "memory-core-reflection-gate-old-"));
  writeFileSync(join(dirOld, "MEMORY.md"), fixtureMemory, "utf8");
  const coreOld = new MemoryCore({ dataDir: dirOld });
  coreOld.record({ role: "user", text: "今天好累", window: "persona", importance: "heavy", sessionId: "s1", ts: local(2026, 11, 6, 10, 0) });
  const oldGate = coreOld.reflectionCheck(now);
  assert.equal(oldGate.reached, false, "a 3-day-old entry does not reach the floor");
  assert.deepEqual(oldGate.sourceIds, [], "no entries in the gate means no citable sources");
});

check("0.4.3 reflection gate snapshot: sources cited from the issued prompt survive the 24 h boundary", () => {
  const dirS = mkdtempSync(join(tmpdir(), "memory-core-reflection-snapshot-"));
  writeFileSync(join(dirS, "MEMORY.md"), fixtureMemory, "utf8");
  const coreS = new MemoryCore({ dataDir: dirS });
  const t0 = local(2026, 11, 6, 10, 0);
  const snapIds: string[] = [];
  for (let i = 0; i < 6; i++) {
    const e = coreS.record({ role: "user", text: `今天好累${i}`, window: "persona", importance: "heavy", sessionId: "s1", ts: t0 - i * 60_000 });
    snapIds.push(e.id);
  }
  // No gate issued yet: no snapshot, nothing citable.
  assert.equal(coreS.reflectionGateSnapshot(), null, "no gate issued yet → no snapshot");
  // Gate at t0: reached, and the snapshot is exactly its sources.
  const gate = coreS.reflectionCheck(t0);
  assert.equal(gate.reached, true, "6 fresh heavies clear the floor");
  assert.deepEqual([...(coreS.reflectionGateSnapshot() ?? [])].sort(), [...snapIds].sort(), "gate snapshots its sourceIds");
  // 25 h later the same entries are past the window: a FRESH
  // check is empty and below the floor — recomputing at save
  // time would refuse a conclusion the model was already shown.
  // The snapshot, taken at gate time, still holds them (no real
  // 24 h wait — the clock is the controlled `now` argument).
  const late = t0 + 25 * 60 * 60 * 1000;
  assert.deepEqual([...(coreS.reflectionGateSnapshot() ?? [])].sort(), [...snapIds].sort(), "snapshot survives the entries crossing the 24 h boundary");
  // A fresh gate check now would clear the snapshot (below the
  // floor) — which is exactly why the save path must read the
  // snapshot instead of re-checking: re-issue the gate at the
  // late time on a SECOND core to show the recompute result,
  // without touching the first core's snapshot.
  const coreS2 = new MemoryCore({ dataDir: dirS });
  const lateGate = coreS2.reflectionCheck(late);
  assert.equal(lateGate.reached, false, "recomputed 25 h later, the gate is below the floor");
  assert.deepEqual(lateGate.sourceIds, [], "recomputed 25 h later, no citable sources");
  // The first core's snapshot is untouched by the second core's
  // check (snapshots are per-instance, in memory only).
  assert.deepEqual([...(coreS.reflectionGateSnapshot() ?? [])].sort(), [...snapIds].sort(), "another instance's re-check does not clear this snapshot");
  // A failed save keeps the snapshot (the model can fix the
  // quotes and retry against the same prompt)…
  const failed = coreS.saveReflection("他最近压力大，「今天一点都不累」", snapIds.slice(0, 3));
  assert.equal(failed.ok, false, "fabricated quote still voids the reflection");
  assert.deepEqual([...(coreS.reflectionGateSnapshot() ?? [])].sort(), [...snapIds].sort(), "failed save keeps the snapshot for a retry");
  // …and a successful save consumes it (one gate, one reflection).
  const saved = coreS.saveReflection("他最近压力大，「今天好累0」「今天好累1」", snapIds.slice(0, 2));
  assert.equal(saved.ok, true, "citing snapshot sources saves");
  assert.equal(coreS.reflectionGateSnapshot(), null, "successful save clears the snapshot");
  // A gate below the floor clears any snapshot too: fresh entries
  // are all folded now, so the next gate is empty.
  const afterGate = coreS.reflectionCheck(late);
  assert.equal(afterGate.reached, false, "after the save the gate is below the floor");
  assert.equal(coreS.reflectionGateSnapshot(), null, "below-floor gate leaves no snapshot");
});

check("0.4.0 item 3: floor boundary — exactly 5.0 reaches, 4.9 does not; already-reflected entries never re-trigger", () => {
  assert.equal(REFLECTION_MIN_FLOOR, 5, "the floor is 5 significance points");
  const mkEntry = (id: string, importance: "heavy" | "light", mins: number): MemoryEntry => ({
    id,
    ts: local(2026, 11, 6, 10, mins),
    date: "2026/11/06",
    time: `10:${String(mins).padStart(2, "0")}`,
    role: "user",
    window: "persona",
    sessionId: "s1",
    importance,
    text: `记忆${id}`,
    source: "log",
  });
  const sig = (e: MemoryEntry): number => (e.importance === "heavy" ? 0.9 : 0.4);
  const nowB = local(2026, 11, 6, 12, 0);
  // 2 heavy + 8 light = 1.8 + 3.2 = exactly 5.0 — reached.
  const exact: MemoryEntry[] = [
    mkEntry("b-h1", "heavy", 0),
    mkEntry("b-h2", "heavy", 1),
    ...Array.from({ length: 8 }, (_, i) => mkEntry(`b-l${i}`, "light", 2 + i)),
  ];
  const atFloor = reflectionGate(exact, sig, nowB);
  assert.ok(Math.abs(atFloor.significanceSum - 5) < 1e-9, `sum is exactly 5 (got ${atFloor.significanceSum})`);
  assert.equal(atFloor.reached, true, "exactly at the floor triggers");
  // 1 heavy + 10 light = 0.9 + 4.0 = 4.9 — not reached.
  const below: MemoryEntry[] = [
    mkEntry("c-h1", "heavy", 0),
    ...Array.from({ length: 10 }, (_, i) => mkEntry(`c-l${i}`, "light", 1 + i)),
  ];
  const under = reflectionGate(below, sig, nowB);
  assert.ok(Math.abs(under.significanceSum - 4.9) < 1e-9, `sum is 4.9 (got ${under.significanceSum})`);
  assert.equal(under.reached, false, "just below the floor does not trigger");
  assert.deepEqual(reflectionGate([], sig, nowB), { entries: [], significanceSum: 0, reached: false }, "no entries means no trigger");
  // Entries already folded into a reflection are excluded: the
  // three reflected entries (e1–e3) leave only e4–e6 (2.7 < 5),
  // so a second review inside the same 24 h proposes nothing.
  const second = coreRef.review(true, local(2026, 11, 6, 18, 0));
  assert.ok(second !== null && second.ran, "second review ran");
  assert.equal(
    second.reflectionPrompt,
    undefined,
    "already-reflected entries do not re-trigger in the same day",
  );
  // A fresh heavy entry the same evening is still not enough on
  // its own (2.7 + 0.9 = 3.6 < 5).
  coreRef.record({
    role: "user", text: "今天累得不行了", window: "persona",
    importance: "heavy", sessionId: "s1", ts: local(2026, 11, 6, 18, 30),
  });
  const third = coreRef.review(true, local(2026, 11, 6, 19, 0));
  assert.equal(third?.reflectionPrompt, undefined, "one new heavy entry is still below the floor");
});

check("0.4.0 item 3: starmap — a reflection fragment is a gold stable_profile star, like any fragment", () => {
  const attrsMap = new Map(
    refEntries.map((e) => [
      e.id,
      { clarity: 1, recallCount: 0, significance: 0.9 },
    ]),
  );
  const data = buildStarmapData(
    refEntries,
    [],
    attrsMap,
    local(2026, 11, 7, 9, 0),
    coreRef.listFragments(),
  );
  const star = data.memories.find((m) => m.id === reflSaved.fragment?.id);
  assert.ok(star, "the reflection fragment is a star");
  assert.equal(star?.cat, "stable_profile", "reflection star is gold stable_profile");
  assert.ok((star?.key ?? "").startsWith("ta."), "reflection star is on the ta. arm");
  assert.equal(star?.toneLabel, "反思", "reflection star carries its tone label");
  assert.equal(star?.text, "他最近压力大，「今天好累」「昨天也说好累」", "reflection star shows the conclusion");
  assert.ok(
    (star?.sources ?? []).some((s) => s.text === "今天好累"),
    "reflection star keeps its provenance sources for the panel",
  );
  // The three folded sources have no entry stars of their own.
  assert.ok(
    !data.memories.some((m) => m.id === refEntries[0].id),
    "a source folded into the reflection has no separate star",
  );
});

check("0.4.0 item 3: old data — fragments.json without the type field loads, ordinary fragments still verify the old way", () => {
  const dirO3 = mkdtempSync(join(tmpdir(), "memory-core-reflection-old-"));
  writeFileSync(join(dirO3, "MEMORY.md"), fixtureMemory, "utf8");
  const coreO3 = new MemoryCore({ dataDir: dirO3 });
  const eO3 = coreO3.record({
    role: "user", text: "今天喝了酸梅汤，很解渴", window: "persona",
    importance: "heavy", sessionId: "s1", ts: local(2026, 11, 6, 10, 0),
  });
  // An ordinary fragment, created the 0.3.0 way — no type field
  // anywhere in the file (this IS the old shape).
  const ordinary = coreO3.createFragment({
    sourceIds: [eO3.id],
    text: "他喜欢酸梅汤",
    tone: "喜欢",
    quotes: ["今天喝了酸梅汤"],
  });
  assert.equal(ordinary.ok, true, JSON.stringify(ordinary.reasons));
  assert.equal(ordinary.fragment?.type, undefined, "ordinary fragments carry no type");
  const rawOld = JSON.parse(readFileSync(join(dirO3, "fragments.json"), "utf8")) as {
    fragments: Array<Record<string, unknown>>;
  };
  assert.equal("type" in (rawOld.fragments[0] ?? {}), false, "old-shape row has no type key");
  // Reload: the old row loads, recalls fine (full verification,
  // unchanged), and a reflection can be saved next to it.
  const coreO3b = new MemoryCore({ dataDir: dirO3 });
  assert.equal(coreO3b.listFragments().length, 1, "old row loads");
  assert.equal(coreO3b.listFragments()[0]?.type, undefined, "old row stays typeless");
  const hitOld = coreO3b.recall("酸梅汤");
  assert.ok(
    hitOld.hits.some((h) => h.fragmentId === ordinary.fragment?.id),
    "old-shape fragment still injects on recall",
  );
  assert.equal(coreO3b.stats().suspectFragments, 0, "old fragment is not suspect");
  const reflOld = coreO3b.saveReflection(
    "他最近总念叨酸梅汤，「今天喝了酸梅汤」",
    [eO3.id],
  );
  assert.equal(reflOld.ok, true, JSON.stringify(reflOld.reasons));
  assert.equal(reflOld.fragment?.type, "reflection", "reflection saves alongside the old row");
  const coreO3c = new MemoryCore({ dataDir: dirO3 });
  assert.equal(coreO3c.listFragments().length, 2, "both rows survive a reload");
  assert.deepEqual(
    coreO3c.listFragments().map((f) => f.type ?? "ordinary"),
    ["ordinary", "reflection"],
    "types round-trip: old row ordinary, new row reflection",
  );
  // FragmentStore.add is the reflection path — a hand-built
  // fragment added directly is stored verbatim.
  const dirAdd = mkdtempSync(join(tmpdir(), "memory-core-reflection-store-"));
  const storeAdd = new FragmentStore(dirAdd);
  assert.equal(storeAdd.size, 0, "no fragments.json starts empty, not a crash");
  storeAdd.add({
    id: "refl-test-1",
    type: "reflection",
    sourceIds: [eO3.id],
    text: "测试反思",
    tone: { label: "反思", level: "unknown", intensity: 0.5 },
    quotes: ["今天喝了酸梅汤"],
    topic: "反思",
    keywords: [],
    createdAt: 0,
    verified: true,
  });
  assert.equal(storeAdd.size, 1, "add stores the fragment");
  const storeAdd2 = new FragmentStore(dirAdd);
  assert.equal(storeAdd2.get("refl-test-1")?.type, "reflection", "added reflection reloads with its type");
});

// ---- 0.4.0 item 7: 行为回流 · 会话内主动版 ---------------------
// 2026-11-09 去机械化：判断什么时候主动、主动说什么，归模型；
// 算术/护栏归代码（一天最多 1 次、同一触发 7 天内不重复、待办
// 最多 3 条超了丢最旧）。actionText 只能来自模型返回，loop.ts
// 里不许出现固定模板句；解析失败、act: false 时不产生行动。

const dirLoop = mkdtempSync(join(tmpdir(), "memory-core-loop-"));
writeFileSync(join(dirLoop, "MEMORY.md"), fixtureMemory, "utf8");
const coreLoop = new MemoryCore({ dataDir: dirLoop });
const loopE1 = coreLoop.record({
  role: "user", text: "明天有考试，今晚得早点睡", window: "persona",
  importance: "heavy", sessionId: "s1", ts: local(2026, 11, 7, 10, 0),
});
const loopE2 = coreLoop.record({
  role: "assistant", text: "好，考完告诉我", window: "persona",
  importance: "light", sessionId: "s1", ts: local(2026, 11, 7, 10, 5),
});
const loopBelief = coreLoop.createBelief({
  dimension: "trust",
  statement: "他难过时会来找我",
  entryId: loopE1.id,
  quote: "明天有考试",
});
assert.equal(loopBelief.ok, true, JSON.stringify(loopBelief.reasons));
const loopRefl = coreLoop.saveReflection(
  "他最近压力大，「明天有考试」",
  [loopE1.id],
);
assert.equal(loopRefl.ok, true, JSON.stringify(loopRefl.reasons));
const loopReflections = coreLoop
  .listFragments()
  .filter((f) => f.type === "reflection");

check("0.4.0 item 7: buildProactPrompt carries today's memories, beliefs and reflections, and says not acting is fine", () => {
  const prompt = buildProactPrompt({
    memories: [loopE1, loopE2],
    beliefs: coreLoop.listBeliefs(),
    reflections: loopReflections,
    now: local(2026, 11, 7, 12, 0),
  });
  assert.ok(prompt.includes(loopE1.id), "prompt carries the memory id");
  assert.ok(prompt.includes("明天有考试，今晚得早点睡"), "prompt carries the memory verbatim");
  assert.ok(prompt.includes(loopBelief.belief?.id ?? ""), "prompt carries the belief id");
  assert.ok(prompt.includes("他难过时会来找我"), "prompt carries the belief statement");
  assert.ok(prompt.includes("他最近压力大"), "prompt carries the reflection");
  assert.ok(prompt.includes("该不该打扰"), "prompt says to weigh disturbing him");
  assert.ok(prompt.includes("现在说合不合适"), "prompt says to weigh the moment");
  assert.ok(prompt.includes("不要为了主动而主动"), "prompt says not to act for acting's sake");
  assert.ok(prompt.includes("不行动是完全可以接受的回答"), "prompt says not acting is fine");
  assert.ok(prompt.includes("memory_proact"), "prompt names the tool that takes the decision");
  // 0.4.3: the prompt must tell the model to carry the gate's
  // promptToken — act:false included, so the prompt is voided —
  // or the model hands back a token-less decision first and gets
  // proact_prompt_not_found.
  assert.ok(prompt.includes("promptToken"), "prompt tells the model to carry the promptToken");
  assert.ok(prompt.includes("act: false"), "prompt mentions the act:false case for the token");
  // The prompt must never suggest a ready-made line: what she says
  // is hers to write. (The spec's example line is quoted here only
  // as the forbidden string — it must not appear in the prompt.)
  assert.ok(!prompt.includes("早点睡别熬了"), "prompt suggests no fixed action line");
});

check("0.4.0 item 7: parseProactDecision — valid object and JSON string parse; act:false and every malformed shape return null", () => {
  const good = {
    act: true,
    judgment: "他明天有考试，今晚会紧张",
    actionText: "模型自己写的一句话",
    trigger: loopE1.id,
  };
  assert.deepEqual(parseProactDecision(good), {
    act: true,
    judgment: "他明天有考试，今晚会紧张",
    actionText: "模型自己写的一句话",
    trigger: loopE1.id,
  });
  assert.deepEqual(parseProactDecision(JSON.stringify(good)), {
    act: true,
    judgment: "他明天有考试，今晚会紧张",
    actionText: "模型自己写的一句话",
    trigger: loopE1.id,
  });
  assert.deepEqual(parseProactDecision({ act: false }), { act: false });
  assert.deepEqual(
    parseProactDecision({ act: false, judgment: "x", actionText: "y", trigger: "z" }),
    { act: false },
    "act:false ignores the other fields",
  );
  assert.equal(parseProactDecision({ act: true, judgment: "x", trigger: "z" }), null, "missing actionText is void");
  assert.equal(parseProactDecision({ act: true, judgment: "x", actionText: "   ", trigger: "z" }), null, "blank actionText is void");
  assert.equal(parseProactDecision({ act: true, judgment: "", actionText: "y", trigger: "z" }), null, "blank judgment is void");
  assert.equal(parseProactDecision({ act: true, judgment: "x", actionText: "y" }), null, "missing trigger is void");
  assert.equal(parseProactDecision({ judgment: "x", actionText: "y", trigger: "z" }), null, "missing act is void");
  assert.equal(parseProactDecision("not json at all"), null, "unparseable text is void, not a crash");
  assert.equal(parseProactDecision(""), null, "empty string is void");
  assert.equal(parseProactDecision(42), null, "a number is void");
  assert.equal(parseProactDecision(["x"]), null, "an array is void");
  assert.equal(parseProactDecision(null), null, "null is void");
  assert.deepEqual(
    parseProactDecision({ decision: good }),
    {
      act: true,
      judgment: "他明天有考试，今晚会紧张",
      actionText: "模型自己写的一句话",
      trigger: loopE1.id,
    },
    "a wrapped {decision} is unwrapped once",
  );
});

check("0.4.0 item 7: checkGuardrails — one action a day, same trigger 7 days, act:false consumes nothing, lastJudgedAt is not the quota", () => {
  const day1 = local(2026, 11, 7, 12, 0);
  // Fresh state: the gate is open.
  assert.deepEqual(coreLoop.proactCheck(loopE1.id, day1), { ok: true });
  // Store one action today (trigger: the memory).
  const saved = coreLoop.proactSave(
    { act: true, judgment: "模型判断", actionText: "模型写的话", trigger: loopE1.id },
    "session",
    day1,
  );
  assert.equal(saved.ok, true, JSON.stringify(saved.reason));
  assert.ok(saved.action, "the action is stored");
  // Same day, any trigger: refused (the day's one action is spent).
  const sameDay = coreLoop.proactCheck("some-other-trigger", day1 + 60 * 60 * 1000);
  assert.equal(sameDay.ok, false, "a second action the same day is refused");
  assert.ok((sameDay.reason ?? "").includes("今天已经主动过一次"), "the reason names the daily limit");
  // Next day, same trigger: refused (7-day repeat).
  const nextDay = coreLoop.proactCheck(loopE1.id, local(2026, 11, 8, 12, 0));
  assert.equal(nextDay.ok, false, "the same trigger within 7 days is refused");
  assert.ok((nextDay.reason ?? "").includes("7 天内"), "the reason names the 7-day repeat");
  // Next day, a different trigger: open.
  assert.deepEqual(
    coreLoop.proactCheck("another-trigger", local(2026, 11, 8, 12, 0)),
    { ok: true },
    "a different trigger the next day is open",
  );
  // Exactly 7 days after the stored action, same trigger: open
  // (the window is "within 7 days", the boundary day is free).
  assert.deepEqual(
    coreLoop.proactCheck(loopE1.id, local(2026, 11, 14, 12, 0)),
    { ok: true },
    "exactly 7 days later the trigger is free again",
  );
  // lastJudgedAt alone never blocks: a state with lastJudgedAt set
  // today but no actions stored is open (act:false stores nothing,
  // so judging without acting never consumes the quota).
  assert.deepEqual(
    checkGuardrails(
      { lastJudgedAt: day1, pendingActions: [], recentTriggers: [] },
      "t",
      day1,
    ),
    { ok: true },
    "lastJudgedAt is bookkeeping only, never the quota basis",
  );
  // The gate call ({}) carries no trigger: only the daily limit is
  // checked — the repeat check is skipped, not failed.
  assert.deepEqual(
    checkGuardrails(
      { lastJudgedAt: 0, pendingActions: [], recentTriggers: [] },
      "",
      day1,
    ),
    { ok: true },
    "an empty trigger skips the repeat check",
  );
});

check("0.4.0 item 7: LoopStore — 3 pending max, oldest dropped not deleted; a stale decision is refused at store time", () => {
  const dirCap = mkdtempSync(join(tmpdir(), "memory-core-loop-cap-"));
  const store = new LoopStore(dirCap);
  const mk = (trigger: string, day: number) => ({
    act: true as const,
    judgment: `模型判断 ${trigger}`,
    actionText: `模型写的话 ${trigger}`,
    trigger,
  });
  const d1 = store.addAction(mk("trig-A", 1), "session", local(2026, 11, 7, 9, 0));
  const d2 = store.addAction(mk("trig-B", 2), "session", local(2026, 11, 8, 9, 0));
  const d3 = store.addAction(mk("trig-C", 3), "session", local(2026, 11, 9, 9, 0));
  assert.ok(d1.ok && d2.ok && d3.ok, "three actions on three days store fine");
  assert.equal(store.pending().length, 3, "three pending");
  assert.equal(d3.droppedOldest, false, "no eviction while under the cap");
  // Fourth action, fourth day: the oldest pending (trig-A) is
  // dropped — status "dropped", record still in loop.json.
  const d4 = store.addAction(mk("trig-D", 4), "session", local(2026, 11, 10, 9, 0));
  assert.equal(d4.ok, true, JSON.stringify(d4.reason));
  assert.equal(d4.droppedOldest, true, "the fourth store evicts the oldest");
  assert.equal(store.pending().length, 3, "still at most 3 pending");
  assert.deepEqual(
    store.pending().map((a) => a.trigger),
    ["trig-B", "trig-C", "trig-D"],
    "the oldest pending is gone from the pending list",
  );
  const all = store.all();
  assert.equal(all.length, 4, "the dropped record is kept, not deleted");
  assert.equal(
    all.find((a) => a.trigger === "trig-A")?.status,
    "dropped",
    "the oldest row is marked dropped",
  );
  // The dropped row survives a reload from disk.
  const store2 = new LoopStore(dirCap);
  assert.equal(store2.all().length, 4, "dropped row persists across reload");
  assert.equal(
    store2.all().find((a) => a.trigger === "trig-A")?.status,
    "dropped",
    "dropped status round-trips",
  );
  assert.equal(store2.pending().length, 3, "3 pending after reload");
  // A decision that went stale between gate and save is refused
  // here too (the store re-checks): trig-B fired 2026-11-08, so on
  // 2026-11-10 it is still inside 7 days.
  const stale = store2.addAction(mk("trig-B", 5), "session", local(2026, 11, 10, 10, 0));
  assert.equal(stale.ok, false, "a repeat trigger inside 7 days is refused at store time");
  assert.equal(store2.pending().length, 3, "a refused store adds nothing");
  assert.equal(store2.all().length, 4, "a refused store writes nothing new");
});

check("0.4.0 item 7: deliver — session returns the model's own words, qq throws qq_not_connected", () => {
  const sessionAction = {
    id: "act-test-1",
    trigger: loopE1.id,
    judgment: "模型判断",
    actionText: "模型自己写的一句话",
    channel: "session" as const,
    status: "pending" as const,
    createdAt: local(2026, 11, 7, 12, 0),
  };
  assert.equal(deliver(sessionAction), "模型自己写的一句话", "session hands the model's words back verbatim");
  const qqAction = { ...sessionAction, id: "act-test-2", channel: "qq" as const };
  assert.throws(
    () => deliver(qqAction),
    /qq_not_connected/,
    "qq throws qq_not_connected, never a fallback line",
  );
  assert.throws(
    () => deliver({ ...sessionAction, channel: "carrier-pigeon" as never }),
    /unknown proact channel/,
    "an unknown channel throws instead of delivering nowhere",
  );
});

check("0.4.0 item 7: recordProactOutcome — the reply lands in log.jsonl and the action is done; unknown id writes nothing", () => {
  const day = local(2026, 11, 9, 12, 0);
  const saved = coreLoop.proactSave(
    { act: true, judgment: "模型判断", actionText: "模型写的话", trigger: loopE2.id },
    "session",
    day,
  );
  assert.equal(saved.ok, true, JSON.stringify(saved.reason));
  const actionId = saved.action?.id ?? "";
  const logBefore = readFileSync(join(dirLoop, "log.jsonl"), "utf8");
  assert.ok(!logBefore.includes("知道了，晚安"), "the reply is not in the log yet");
  const closed = coreLoop.recordProactOutcome(actionId, "知道了，晚安", "s1");
  assert.equal(closed.ok, true, JSON.stringify(closed.reason));
  assert.equal(closed.entry?.role, "user", "the reply is recorded as a user message");
  assert.equal(closed.entry?.text, "知道了，晚安", "the reply text is verbatim");
  const logAfter = readFileSync(join(dirLoop, "log.jsonl"), "utf8");
  assert.ok(logAfter.includes("知道了，晚安"), "the reply is appended to log.jsonl");
  assert.equal(
    coreLoop.listProactActions().find((a) => a.id === actionId)?.status,
    "done",
    "the action is marked done",
  );
  // Closing the same action twice appends nothing.
  const logLines = logAfter.split("\n").filter((l) => l.includes("知道了，晚安")).length;
  const closedAgain = coreLoop.recordProactOutcome(actionId, "知道了，晚安", "s1");
  assert.equal(closedAgain.ok, false, "an already-done action cannot close again");
  const logAfter2 = readFileSync(join(dirLoop, "log.jsonl"), "utf8");
  assert.equal(
    logAfter2.split("\n").filter((l) => l.includes("知道了，晚安")).length,
    logLines,
    "the second close appends nothing",
  );
  // Unknown id: nothing is appended, nothing is marked.
  const unknown = coreLoop.recordProactOutcome("act-no-such-id", "知道了，晚安", "s1");
  assert.equal(unknown.ok, false, "an unknown action id closes nothing");
  const logAfter3 = readFileSync(join(dirLoop, "log.jsonl"), "utf8");
  assert.equal(
    logAfter3.split("\n").filter((l) => l.includes("知道了，晚安")).length,
    logLines,
    "an unknown id appends nothing",
  );
  // Empty reply: nothing is appended.
  const saved2 = coreLoop.proactSave(
    { act: true, judgment: "模型判断", actionText: "模型写的话", trigger: "trig-empty-reply" },
    "session",
    local(2026, 11, 10, 12, 0),
  );
  assert.equal(saved2.ok, true, JSON.stringify(saved2.reason));
  const empty = coreLoop.recordProactOutcome(saved2.action?.id ?? "", "   ", "s1");
  assert.equal(empty.ok, false, "an empty reply closes nothing");
  assert.equal(
    coreLoop.listProactActions().find((a) => a.id === saved2.action?.id)?.status,
    "pending",
    "the action stays pending after an empty reply",
  );
});

check("0.4.0 item 7: review proposes a proactPrompt but writes nothing to loop.json; an empty day builds none", () => {
  const dirRev = mkdtempSync(join(tmpdir(), "memory-core-loop-review-"));
  writeFileSync(join(dirRev, "MEMORY.md"), fixtureMemory, "utf8");
  const coreRev = new MemoryCore({ dataDir: dirRev });
  coreRev.record({
    role: "user", text: "明天有考试，今晚得早点睡", window: "persona",
    importance: "heavy", sessionId: "s1", ts: local(2026, 11, 7, 10, 0),
  });
  const result = coreRev.review(true, local(2026, 11, 7, 12, 0));
  assert.ok(result !== null && result.ran, "review ran");
  assert.ok(
    typeof result.proactPrompt === "string" && result.proactPrompt.length > 0,
    "the review carries a proactivity prompt",
  );
  assert.ok(
    (result.proactPrompt ?? "").includes("明天有考试，今晚得早点睡"),
    "the prompt carries today's memory",
  );
  assert.ok(
    (result.proactPrompt ?? "").includes("memory_proact"),
    "the prompt names the tool that executes it",
  );
  assert.equal(
    existsSync(join(dirRev, LOOP_FILE)),
    false,
    "the review proposes only — it writes no loop.json",
  );
  // Empty day: no memories, no beliefs, no reflections — no prompt.
  const dirEmpty = mkdtempSync(join(tmpdir(), "memory-core-loop-empty-"));
  writeFileSync(join(dirEmpty, "MEMORY.md"), fixtureMemory, "utf8");
  const coreEmpty = new MemoryCore({ dataDir: dirEmpty });
  const emptyResult = coreEmpty.review(true, local(2026, 11, 7, 12, 0));
  assert.equal(emptyResult?.proactPrompt, undefined, "an empty day builds no prompt");
  // Old data: no loop.json at all — the review still runs, the
  // prompt is built from the entries alone.
  assert.equal(
    existsSync(join(dirEmpty, LOOP_FILE)),
    false,
    "an empty old dir has no loop.json and the review still runs",
  );
});

check("0.4.0 item 7: loop.ts carries no hard-coded action line (source grep)", () => {
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "src", "loop.ts"),
    "utf8",
  );
  // The spec's example lines are quoted here only as the forbidden
  // strings — they may appear in a comment or a test, never in the
  // executable paths of loop.ts. This file has no such comment, so
  // neither string may appear in it at all.
  assert.ok(!src.includes("早点睡别熬了"), "loop.ts must not contain a fixed action line");
  assert.ok(!src.includes("他明天有考试，今晚会紧张"), "loop.ts must not contain a fixed judgment line");
  // And the prompt builder never emits one either, whatever the input.
  const prompt = buildProactPrompt({
    memories: [loopE1],
    beliefs: [],
    reflections: [],
    now: local(2026, 11, 7, 12, 0),
  });
  assert.ok(!prompt.includes("早点睡别熬了"), "buildProactPrompt emits no fixed action line");
  assert.ok(!prompt.includes("他明天有考试，今晚会紧张"), "buildProactPrompt emits no fixed judgment line");
  // The cap constant is the spec's 3.
  assert.equal(LOOP_MAX_PENDING, 3, "at most 3 pending actions");
});

check("0.4.0 item 7: old data — no loop.json starts empty; a hand-written row without channel/status loads with defaults; corrupt loop.json starts empty", () => {
  // No loop.json at all: empty state, gate open, no crash.
  const dirOld = mkdtempSync(join(tmpdir(), "memory-core-loop-old-"));
  writeFileSync(join(dirOld, "MEMORY.md"), fixtureMemory, "utf8");
  const coreOld = new MemoryCore({ dataDir: dirOld });
  assert.deepEqual(coreOld.loopState(), {
    lastJudgedAt: 0,
    pendingActions: [],
    recentTriggers: [],
  });
  assert.deepEqual(coreOld.proactCheck("t", local(2026, 11, 7, 12, 0)), { ok: true });
  assert.equal(coreOld.proactPrompt(local(2026, 11, 7, 12, 0)), undefined, "no memories, no beliefs, no reflections — no prompt");
  // A hand-written row without channel/status (the pre-0.4.0 shape
  // has no such fields at all — here a row that simply omits them).
  writeFileSync(
    join(dirOld, LOOP_FILE),
    JSON.stringify({
      version: 1,
      lastJudgedAt: local(2026, 11, 6, 9, 0),
      pendingActions: [
        {
          id: "act-legacy-1",
          trigger: "legacy-trigger",
          judgment: "旧判断",
          actionText: "旧话术",
          createdAt: local(2026, 11, 6, 9, 0),
        },
        // A row without an id is poison — dropped, not trusted.
        { trigger: "no-id", judgment: "x", actionText: "y", createdAt: 0 },
      ],
    }),
    "utf8",
  );
  const coreOld2 = new MemoryCore({ dataDir: dirOld });
  const loaded = coreOld2.listProactActions();
  assert.equal(loaded.length, 1, "the id-less row is dropped");
  assert.equal(loaded[0]?.channel, "session", "a missing channel defaults to session");
  assert.equal(loaded[0]?.status, "pending", "a missing status defaults to pending");
  assert.equal(coreOld2.loopState().lastJudgedAt, local(2026, 11, 6, 9, 0), "lastJudgedAt round-trips");
  // Corrupt loop.json: starts empty, never a crash.
  const dirCorrupt = mkdtempSync(join(tmpdir(), "memory-core-loop-corrupt-"));
  writeFileSync(join(dirCorrupt, "MEMORY.md"), fixtureMemory, "utf8");
  writeFileSync(join(dirCorrupt, LOOP_FILE), "{not json", "utf8");
  const coreCorrupt = new MemoryCore({ dataDir: dirCorrupt });
  assert.deepEqual(coreCorrupt.loopState(), {
    lastJudgedAt: 0,
    pendingActions: [],
    recentTriggers: [],
  });
  assert.deepEqual(coreCorrupt.proactCheck("t", local(2026, 11, 7, 12, 0)), { ok: true });
  // recordOutcome's free-function form: a capturing append proves
  // the reply goes through the callback and the action is marked.
  const dirRec = mkdtempSync(join(tmpdir(), "memory-core-loop-record-"));
  const storeRec = new LoopStore(dirRec);
  const added = storeRec.addAction(
    { act: true, judgment: "模型判断", actionText: "模型写的话", trigger: "trig-rec" },
    "session",
    local(2026, 11, 7, 12, 0),
  );
  assert.equal(added.ok, true, JSON.stringify(added.reason));
  const appended: string[] = [];
  const closedFree = recordOutcome(storeRec, added.action?.id ?? "", "收到，晚安", (t) => appended.push(t));
  assert.equal(closedFree, true, "recordOutcome closes the action");
  assert.deepEqual(appended, ["收到，晚安"], "the reply goes through the append callback");
  assert.equal(storeRec.getById(added.action?.id ?? "")?.status, "done", "the action is done");
  assert.equal(
    recordOutcome(storeRec, "act-no-such-id", "收到", (t) => appended.push(t)),
    false,
    "an unknown id appends nothing",
  );
  assert.deepEqual(appended, ["收到，晚安"], "nothing appended for the unknown id");
});

check("0.4.1 item 7 (merge 2): prompt token — a decision must answer the issued prompt: wrong token, expired token and a trigger outside the prompt are all refused", () => {
  const dirTok = mkdtempSync(join(tmpdir(), "memory-core-loop-token-"));
  writeFileSync(join(dirTok, "MEMORY.md"), fixtureMemory, "utf8");
  const coreTok = new MemoryCore({ dataDir: dirTok });
  const day = local(2026, 11, 7, 12, 0);
  const e1 = coreTok.record({
    role: "user", text: "明天有考试，今晚得早点睡", window: "persona",
    importance: "heavy", sessionId: "s1", ts: local(2026, 11, 7, 10, 0),
  });
  const e2 = coreTok.record({
    role: "user", text: "考完想吃顿好的", window: "persona",
    importance: "light", sessionId: "s1", ts: local(2026, 11, 7, 11, 0),
  });
  assert.equal(PROACT_PROMPT_TTL_MS, 15 * 60 * 1000, "the prompt TTL is 15 minutes");
  assert.equal(
    LOOP_TRIGGER_COOLDOWN_MS,
    7 * 24 * 60 * 60 * 1000,
    "the trigger cooldown is 7 days",
  );
  // Issuing the prompt: token shape + the source ids it showed.
  const prepared = coreTok.prepareProactPrompt(day);
  assert.equal(prepared.prompted, true, "the gate issues a prompt");
  assert.ok(
    (prepared.promptToken ?? "").startsWith("PROACT_"),
    "the token carries the PROACT_ prefix",
  );
  assert.ok(
    (prepared.sourceIds ?? []).includes(e1.id) &&
      (prepared.sourceIds ?? []).includes(e2.id),
    "the source ids are the prompt's memories",
  );
  assert.equal(
    coreTok.loopState().pendingPrompt?.token,
    prepared.promptToken,
    "the issued token is persisted in loop state",
  );
  const decision = {
    act: true as const,
    judgment: "模型判断",
    actionText: "模型写的话",
    trigger: e1.id,
  };
  // A token that was never issued is refused.
  const wrong = coreTok.proactSave(decision, "session", day, "PROACT_bogus");
  assert.equal(wrong.ok, false, "a wrong token stores nothing");
  assert.equal(wrong.reason, "proact_prompt_not_found");
  // The right token, but a trigger the prompt never showed.
  const outside = coreTok.proactSave(
    { ...decision, trigger: "mem-never-shown" },
    "session",
    day,
    prepared.promptToken,
  );
  assert.equal(outside.ok, false, "a trigger outside the prompt stores nothing");
  assert.equal(outside.reason, "proact_trigger_not_in_prompt");
  // 16 minutes after issue the token is dead.
  const expired = coreTok.proactSave(
    decision,
    "session",
    day + 16 * 60 * 1000,
    prepared.promptToken,
  );
  assert.equal(expired.ok, false, "an expired token stores nothing");
  assert.equal(expired.reason, "proact_prompt_expired");
  // Inside the TTL the same token stores — and is consumed by it.
  const stored = coreTok.proactSave(
    decision,
    "session",
    day + 5 * 60 * 1000,
    prepared.promptToken,
  );
  assert.equal(stored.ok, true, JSON.stringify(stored.reason));
  assert.equal(
    coreTok.loopState().pendingPrompt,
    undefined,
    "a stored decision consumes its prompt token",
  );
  assert.equal(coreTok.listProactActions().length, 1, "one action stored");
  assert.equal(
    coreTok.loopState().recentTriggers.length,
    1,
    "the stored action's trigger is in recentTriggers",
  );
});

check("0.4.1 item 7 (merge 2): issuing a prompt writes no lastJudgedAt and consumes no quota; act:false voids the token and consumes nothing", () => {
  const dirQ = mkdtempSync(join(tmpdir(), "memory-core-loop-token-quota-"));
  writeFileSync(join(dirQ, "MEMORY.md"), fixtureMemory, "utf8");
  const coreQ = new MemoryCore({ dataDir: dirQ });
  const day = local(2026, 11, 7, 12, 0);
  const e1 = coreQ.record({
    role: "user", text: "明天有考试，今晚得早点睡", window: "persona",
    importance: "heavy", sessionId: "s1", ts: local(2026, 11, 7, 10, 0),
  });
  assert.equal(coreQ.loopState().lastJudgedAt, 0, "nothing judged yet");
  const p1 = coreQ.prepareProactPrompt(day);
  assert.equal(p1.prompted, true, "the first prompt issues");
  assert.equal(
    coreQ.loopState().lastJudgedAt,
    0,
    "issuing a prompt writes no lastJudgedAt",
  );
  assert.deepEqual(
    coreQ.proactCheck(e1.id, day),
    { ok: true },
    "issuing a prompt consumes no daily quota",
  );
  assert.equal(coreQ.listProactActions().length, 0, "issuing stores no action");
  // act:false answers the prompt and voids its token — still no quota.
  const noAct = coreQ.proactSave({ act: false }, "session", day, p1.promptToken);
  assert.equal(noAct.ok, false, "act:false stores nothing");
  assert.equal(
    coreQ.loopState().pendingPrompt,
    undefined,
    "act:false voids its prompt token",
  );
  assert.deepEqual(
    coreQ.proactCheck(e1.id, day),
    { ok: true },
    "act:false consumes no quota either",
  );
  assert.equal(coreQ.loopState().lastJudgedAt, 0, "act:false writes no lastJudgedAt");
  // A second prompt the same day issues fine and its decision stores.
  const p2 = coreQ.prepareProactPrompt(day + 60 * 60 * 1000);
  assert.equal(p2.prompted, true, "a second prompt issues the same day");
  assert.notEqual(p2.promptToken, p1.promptToken, "a fresh prompt gets a fresh token");
  const stored = coreQ.proactSave(
    { act: true, judgment: "模型判断", actionText: "模型写的话", trigger: e1.id },
    "session",
    day + 60 * 60 * 1000,
    p2.promptToken,
  );
  assert.equal(stored.ok, true, JSON.stringify(stored.reason));
  // The spent day refuses a third prompt, with the daily reason.
  const p3 = coreQ.prepareProactPrompt(day + 2 * 60 * 60 * 1000);
  assert.equal(p3.prompted, false, "the spent day issues no prompt");
  assert.ok(
    (p3.reason ?? "").includes("今天已经主动过一次"),
    "the refusal names the daily limit",
  );
});

check("0.4.1 item 7 (merge 4): recentTriggers — a dropped action's trigger stays cooled for 7 days, then frees", () => {
  const dirCool = mkdtempSync(join(tmpdir(), "memory-core-loop-cooldown-"));
  const store = new LoopStore(dirCool);
  const mk = (trigger: string) => ({
    act: true as const,
    judgment: "模型判断",
    actionText: "模型写的话",
    trigger,
  });
  // Fill the 3-pending cap on three days; a fourth store drops trig-A.
  assert.equal(store.addAction(mk("trig-A"), "session", local(2026, 11, 7, 9, 0)).ok, true);
  assert.equal(store.addAction(mk("trig-B"), "session", local(2026, 11, 8, 9, 0)).ok, true);
  assert.equal(store.addAction(mk("trig-C"), "session", local(2026, 11, 9, 9, 0)).ok, true);
  const d4 = store.addAction(mk("trig-D"), "session", local(2026, 11, 10, 9, 0));
  assert.equal(d4.ok, true, JSON.stringify(d4.reason));
  assert.equal(d4.droppedOldest, true, "the fourth store evicts the oldest");
  assert.equal(
    store.all().find((a) => a.trigger === "trig-A")?.status,
    "dropped",
    "trig-A is dropped, not deleted",
  );
  // A fresh trigger the next day is open; the dropped one is not.
  assert.deepEqual(
    checkGuardrails(store.get(), "trig-E", local(2026, 11, 11, 9, 0)),
    { ok: true },
    "an unrelated trigger the next day is open",
  );
  const cooled = checkGuardrails(store.get(), "trig-A", local(2026, 11, 11, 9, 0));
  assert.equal(cooled.ok, false, "a dropped trigger is still cooled within 7 days");
  assert.equal(cooled.reason, "trigger_cooldown");
  // Exactly 7 days after trig-A was stored, it is free again.
  assert.deepEqual(
    checkGuardrails(store.get(), "trig-A", local(2026, 11, 14, 9, 0)),
    { ok: true },
    "exactly 7 days later the dropped trigger is free",
  );
  const again = store.addAction(mk("trig-A"), "session", local(2026, 11, 14, 9, 0));
  assert.equal(again.ok, true, JSON.stringify(again.reason));
  // recentTriggers survives a reload from disk.
  const reloaded = new LoopStore(dirCool);
  assert.ok(
    reloaded.get().recentTriggers.some((r) => r.trigger === "trig-A"),
    "recentTriggers round-trips through loop.json",
  );
});

check("0.4.1 item 7 (merge 4): recentTriggers caps at the latest 100 and dirty rows are discarded on load", () => {
  const dirTrunc = mkdtempSync(join(tmpdir(), "memory-core-loop-trunc-"));
  const store = new LoopStore(dirTrunc);
  const day0 = local(2026, 11, 7, 9, 0);
  for (let i = 0; i < 101; i++) {
    const r = store.addAction(
      {
        act: true as const,
        judgment: "模型判断",
        actionText: "模型写的话",
        trigger: `trig-${i}`,
      },
      "session",
      day0 + i * 24 * 60 * 60 * 1000,
    );
    assert.equal(r.ok, true, `store ${i} must succeed: ${r.reason}`);
  }
  const kept = store.get().recentTriggers;
  assert.equal(kept.length, 100, "recentTriggers keeps only the latest 100");
  assert.equal(kept[0]?.trigger, "trig-1", "the oldest trigger fell off");
  assert.equal(kept[99]?.trigger, "trig-100", "the newest trigger is kept");
  // A hand-written loop.json with a malformed pendingPrompt and
  // malformed recentTriggers rows: only the well-formed row survives.
  const dirDirty = mkdtempSync(join(tmpdir(), "memory-core-loop-dirty-"));
  writeFileSync(
    join(dirDirty, LOOP_FILE),
    JSON.stringify({
      version: 1,
      lastJudgedAt: 0,
      pendingActions: [],
      pendingPrompt: { token: 42, sourceIds: "nope", issuedAt: "x" },
      recentTriggers: [
        { trigger: "good-one", at: day0 },
        { trigger: 7, at: "x" },
        "junk",
        { trigger: "no-at" },
      ],
    }),
    "utf8",
  );
  const loaded = new LoopStore(dirDirty);
  assert.equal(
    loaded.get().pendingPrompt,
    undefined,
    "a malformed pendingPrompt is discarded, not trusted",
  );
  assert.deepEqual(
    loaded.get().recentTriggers,
    [{ trigger: "good-one", at: day0 }],
    "only well-formed recentTriggers rows survive load",
  );
});

console.log(`\nALL PASS (0.4.0 item 7 additions)`);

// ---- 0.4.6 (0.4.5 audit new issue 1 + new issue 5) -----------------
// The review prompt as a whole has a cap now, not just its
// yesterday section: reflection and proact travel as ONE merged
// recent section (top 20 / 3000 chars), and the first entry can
// never blow the budget (a 20k-char memory is truncated to the
// remaining budget + "…").

check("0.4.6: selectCappedEntries truncates an oversized first entry and counts the unlisted rest", () => {
  const mk = (id: string, text: string, ts: number): MemoryEntry => ({
    id,
    ts,
    date: "2026/11/06",
    time: "10:00",
    role: "user",
    window: "persona",
    sessionId: "s1",
    importance: "heavy",
    text,
  });
  // One 20k-char memory, most significant, plus 3 short ones.
  const big = mk("big-1", "大".repeat(20000), local(2026, 11, 6, 10, 0));
  const small = [1, 2, 3].map((i) =>
    mk(`small-${i}`, `短消息${i}`, local(2026, 11, 6, 10, i)),
  );
  const sel = selectCappedEntries([big, ...small], {
    maxEntries: 20,
    maxChars: 3000,
    significanceOf: (e) => (e.id === "big-1" ? 100 : 1),
  });
  assert.equal(sel.shown.length, 1, "only the oversized entry is shown in full");
  assert.ok(sel.shown[0].displayText.endsWith("…"), "oversized first entry is truncated, not taken whole");
  assert.ok(sel.shown[0].displayText.length <= 3001, "truncated to the 3000-char budget + …");
  assert.equal(sel.overflow.length, 3, "the short entries survive as summaries");
  assert.equal(sel.overflowHidden, 0, "nothing hidden when the rest fits the summary budget");
  assert.equal(sel.cut, true, "cut is reported");
  // Overflow budget: 30 entries, 5 shown, 3 summaries, the rest counted.
  const many = Array.from({ length: 30 }, (_, i) =>
    mk(`m-${i}`, `第${i}条`, local(2026, 11, 6, 10, 0) + i * 60000),
  );
  const sel2 = selectCappedEntries(many, { maxEntries: 5, maxChars: 100000, overflowMax: 3 });
  assert.equal(sel2.shown.length, 5, "5 shown in full");
  assert.equal(sel2.overflow.length, 3, "at most 3 summary lines");
  assert.equal(sel2.overflowHidden, 22, "the other 22 are counted, not silently dropped");
  // Shown entries come back in chronological order, not ranked.
  const rev = [3, 2, 1].map((i) =>
    mk(`r-${i}`, `第${i}条`, local(2026, 11, 6, 10, i)),
  );
  const sel3 = selectCappedEntries(rev, {
    maxEntries: 3,
    maxChars: 100000,
    significanceOf: (e) => Number(e.id.slice(2)),
  });
  assert.deepEqual(
    sel3.shown.map((r) => r.entry.id),
    ["r-1", "r-2", "r-3"],
    "shown in chronological order even when ranked the other way",
  );
});

check("0.4.6: chatty-day daily review — 200 yesterday + 200 today stays far under the old 85k", () => {
  const mk = (prefix: string, i: number, day: string, ts: number): MemoryEntry => ({
    id: `${prefix}-${i}`,
    ts,
    date: day,
    time: "10:00",
    role: i % 2 === 0 ? "user" : "assistant",
    window: "persona",
    sessionId: "s1",
    importance: "light",
    text: `今天第${i}条消息，聊到了酸梅汤和晚饭的事，他说想吃点辣的但是胃不太舒服所以最后点了清淡的，还说明天想去爬山`,
  });
  const yesterday = Array.from({ length: 200 }, (_, i) =>
    mk("y", i, "2026/11/06", local(2026, 11, 6, 10, 0) + i * 60000),
  );
  const today = Array.from({ length: 200 }, (_, i) =>
    mk("t", i, "2026/11/07", local(2026, 11, 7, 10, 0) + i * 60000),
  );
  const sig = (e: MemoryEntry) => Number(e.id.split("-")[1]);
  // The old pasted prompts are passed too — with kinds set, the
  // merged section must replace them, not add to them.
  const pastedReflection = "REFLECTION-PASTED-MARKER-" + "反".repeat(5000);
  const pastedProact = "PROACT-PASTED-MARKER-" + "主".repeat(5000);
  const prompt = buildModelReviewPrompt(yesterday, [], [], pastedReflection, pastedProact, [], {
    significanceOf: sig,
    recentEntries: today,
    recentReflection: true,
    recentProact: true,
  });
  assert.ok(prompt.length < 20000, `chatty-day prompt must stay far under the old 85k, got ${prompt.length}`);
  assert.ok(prompt.includes("最近 24 小时里值得注意的几条"), "the merged recent section is present");
  assert.ok(!prompt.includes("REFLECTION-PASTED-MARKER"), "the pasted reflection prompt is not inlined when merged");
  assert.ok(!prompt.includes("PROACT-PASTED-MARKER"), "the pasted proact prompt is not inlined when merged");
  assert.ok(prompt.includes("只列了重要的部分"), "yesterday's cut is still noted");
  assert.ok(prompt.includes("另有"), "the unlisted remainder is counted");
  // Without kinds the old pasted sections still work (fallback).
  const fallback = buildModelReviewPrompt([], [], [], pastedReflection, pastedProact, []);
  assert.ok(fallback.includes("REFLECTION-PASTED-MARKER"), "fallback still carries the reflection prompt");
  assert.ok(fallback.includes("PROACT-PASTED-MARKER"), "fallback still carries the proact prompt");
  assert.ok(!fallback.includes("最近 24 小时里值得注意的几条"), "fallback has no merged section");
});

check("0.4.6: buildReflectionPrompt and buildProactPrompt cap their 24 h lists", () => {
  const mk = (i: number, text: string): MemoryEntry => ({
    id: `r-${i}`,
    ts: local(2026, 11, 6, 10, 0) + i * 60000,
    date: "2026/11/06",
    time: "10:00",
    role: "user",
    window: "persona",
    sessionId: "s1",
    importance: "light",
    text,
  });
  const many = Array.from({ length: 200 }, (_, i) => mk(i, "长".repeat(200)));
  const rPrompt = buildReflectionPrompt(many, { significanceOf: (e) => Number(e.id.slice(2)) });
  assert.ok(rPrompt.length < 6000, `reflection prompt capped, got ${rPrompt.length}`);
  assert.ok(rPrompt.includes("（摘要）"), "reflection overflow survives as summaries");
  assert.ok(rPrompt.includes("摘要条目没有原文，不能当引用来源"), "summaries are marked not citable");
  const pPrompt = buildProactPrompt(
    { memories: many, beliefs: [], reflections: [], now: local(2026, 11, 6, 18, 0) },
    { significanceOf: (e) => Number(e.id.slice(2)) },
  );
  assert.ok(pPrompt.length < 6000, `proact prompt capped, got ${pPrompt.length}`);
  assert.ok(pPrompt.includes("（摘要）"), "proact overflow survives as summaries");
  // A single 20k-char memory does not blow either prompt.
  const huge = mk(0, "巨".repeat(20000));
  const rHuge = buildReflectionPrompt([huge]);
  assert.ok(rHuge.length < 5000, `one 20k memory truncated in the reflection prompt, got ${rHuge.length}`);
  assert.ok(rHuge.includes("…"), "truncation is marked");
  const pHuge = buildProactPrompt(
    { memories: [huge], beliefs: [], reflections: [], now: local(2026, 11, 6, 18, 0) },
  );
  assert.ok(pHuge.length < 5000, `one 20k memory truncated in the proact prompt, got ${pHuge.length}`);
});

check("0.4.6: reflectionCheck and proactPromptSourceIds only cite entries the capped prompt shows", () => {
  const dirC = mkdtempSync(join(tmpdir(), "memory-core-046-cap-sources-"));
  writeFileSync(join(dirC, "MEMORY.md"), fixtureMemory, "utf8");
  const coreC = new MemoryCore({ dataDir: dirC });
  const now = Date.now();
  const ids: string[] = [];
  for (let i = 0; i < 30; i++) {
    const e = coreC.record({
      role: "user",
      text: `今天好累${i}，聊了好多事`,
      window: "persona",
      importance: "heavy",
      sessionId: "s1",
      ts: now - i * 60_000,
    });
    ids.push(e.id);
  }
  const gate = coreC.reflectionCheck(now);
  assert.equal(gate.reached, true, "30 fresh heavies clear the floor");
  assert.equal(gate.entryCount, 30, "the gate itself sees all 30");
  assert.equal(gate.sourceIds.length, 20, "only the 20 shown entries are citable");
  assert.ok((gate.prompt?.length ?? 0) < 6000, `reflection gate prompt capped, got ${gate.prompt?.length}`);
  for (const id of gate.sourceIds) {
    assert.ok(gate.prompt?.includes(`[${id}] [`), `source ${id} is shown in full in the prompt`);
  }
  for (const id of ids.filter((x) => !gate.sourceIds.includes(x))) {
    assert.ok(!gate.prompt?.includes(`[${id}] [`), `uncited ${id} is not shown in full`);
  }
  const pIds = coreC.proactPromptSourceIds(now);
  assert.equal(pIds.length, 20, "proact source ids are the 20 shown memories");
  const pPrompt = coreC.proactPrompt(now);
  assert.ok((pPrompt?.length ?? 0) < 6000, `proact prompt capped, got ${pPrompt?.length}`);
  for (const id of pIds) {
    assert.ok(pPrompt?.includes(`[${id}] [`), `proact trigger ${id} is shown in full in the prompt`);
  }
});

// 0.4.7 (0.4.6 audit new issue 1): the audit's scenario — 25 fresh
// 24 h memories, the highest-ranked one already reflected. The
// review still shows it in full (it is a 24 h proact memory), but
// the reflection gate excludes it, so a save citing it used to be
// refused. With the gate's sourceIds passed as reflectableIds, the
// merged section marks exactly that row, and every unmarked shown
// row is in the gate's snapshot — prompt and gate agree.
check("0.4.7: merged review section marks the already-reflected entry the gate will not accept", () => {
  const dirR7 = mkdtempSync(join(tmpdir(), "memory-core-047-reflect-mark-"));
  writeFileSync(join(dirR7, "MEMORY.md"), fixtureMemory, "utf8");
  const coreR7 = new MemoryCore({ dataDir: dirR7 });
  const now = local(2026, 11, 7, 10, 0);
  const yest = now - 20 * 60 * 60 * 1000;
  const ids: string[] = [];
  for (let i = 0; i < 25; i++) {
    const e = coreR7.record({
      role: "user",
      text: `今天好累${i}，聊了好多事`,
      window: "persona",
      importance: "heavy",
      sessionId: "s1",
      ts: yest + i * 60_000,
    });
    ids.push(e.id);
  }
  const saved = coreR7.saveReflection("他最近很累，「今天好累0」。", [ids[0]]);
  assert.equal(saved.ok, true, "the first reflection saves");
  const result = coreR7.review(true, now);
  assert.ok(result !== null && result.ran, "review ran");
  assert.ok(
    (result.recentEntryIds ?? []).includes(ids[0]),
    "the reflected entry is still a recent (proact) entry",
  );
  const gate = coreR7.reflectionCheck(now);
  assert.equal(gate.reached, true, "24 fresh heavies still clear the floor");
  assert.ok(!gate.sourceIds.includes(ids[0]), "the gate excludes the reflected entry");
  assert.equal(gate.sourceIds.length, 20, "the gate shows its top 20");
  // 0.4.3 item 8: the gate call sets the snapshot the save path
  // validates against (the review path never set one before).
  assert.deepEqual(
    [...(coreR7.reflectionGateSnapshot() ?? [])].sort(),
    [...gate.sourceIds].sort(),
    "the gate snapshot is the gate's sourceIds",
  );
  const yesterday = coreR7.yesterdayEntries(now);
  const prompt = buildModelReviewPrompt(yesterday, [], [], "", "", [], {
    significanceOf: (e) => coreR7.significanceOf(e),
    recentEntries: coreR7.entriesByIds(result.recentEntryIds ?? []),
    recentReflection: true,
    recentProact: true,
    reflectableIds: gate.sourceIds,
  });
  // Only the merged section matters here — yesterday's section
  // lists the same ids unmarked, so search past its header.
  const merged = prompt.slice(prompt.indexOf("最近 24 小时里值得注意的几条"));
  const reflectedLine = merged
    .split("\n")
    .find((l) => l.includes(`[${ids[0]}]`));
  assert.ok(
    reflectedLine?.includes("（本次反思不可引用）"),
    "the reflected entry is shown in full AND marked not citable",
  );
  assert.ok(
    prompt.includes("带“本次反思不可引用”标记的条目这次不能当引用来源"),
    "the reflection instruction explains the mark",
  );
  const marked = merged
    .split("\n")
    .filter((l) => l.includes("（本次反思不可引用）"));
  assert.equal(marked.length, 1, "exactly one merged row is marked");
  for (const id of gate.sourceIds) {
    const line = merged.split("\n").find((l) => l.includes(`[${id}] [`));
    if (line) {
      assert.ok(
        !line.includes("（本次反思不可引用）"),
        `citable ${id} carries no mark`,
      );
    }
  }
});

// 0.4.7 (0.4.6 audit new issue 2): the standalone proact prompt
// used to cap the list BEFORE buildProactPrompt, so the prompt
// never saw the overflow — with 200 memories in 24 h the model
// was never told 180 more existed. Now the full list goes in and
// the cap happens once inside: 20 shown in full, 20 as summaries,
// 160 counted — the model is told about all 180 past the shown
// 20, and the source ids are still exactly the shown 20.
check("0.4.7: proactPrompt tells the model about the overflow instead of silently dropping it", () => {
  const dirP7 = mkdtempSync(join(tmpdir(), "memory-core-047-proact-overflow-"));
  writeFileSync(join(dirP7, "MEMORY.md"), fixtureMemory, "utf8");
  const coreP7 = new MemoryCore({ dataDir: dirP7 });
  const now = local(2026, 11, 7, 12, 0);
  const ids: string[] = [];
  for (let i = 0; i < 200; i++) {
    const e = coreP7.record({
      role: "user",
      text: `今天好累${i}，聊了好多事`,
      window: "persona",
      importance: "heavy",
      sessionId: "s1",
      ts: now - i * 60_000,
    });
    ids.push(e.id);
  }
  const prompt = coreP7.proactPrompt(now);
  assert.ok(prompt !== undefined, "a prompt is built");
  assert.ok(
    prompt.includes("另有 160 条未列出"),
    "the prompt counts the overflow hidden past the summaries",
  );
  assert.equal(
    prompt.split("（摘要）").length - 1,
    20,
    "20 overflow entries are listed as summaries",
  );
  const pIds = coreP7.proactPromptSourceIds(now);
  assert.equal(pIds.length, 20, "the source ids are still exactly the 20 shown memories");
  for (const id of pIds) {
    assert.ok(
      prompt.includes(`[${id}] [`),
      `proact trigger ${id} is shown in full in the prompt`,
    );
  }
  // 20 shown + 20 summaries + 160 counted = all 200 accounted for.
  assert.equal(pIds.length + 20 + 160, 200, "shown + summaries + hidden = 200");
});

check("0.4.6 (0.4.3 item 15): append after a torn line keeps both lines readable", () => {
  const dirT = mkdtempSync(join(tmpdir(), "memory-core-log-torn-"));
  const file = join(dirT, "log.jsonl");
  const log = new AppendLog(file);
  const mkE = (id: string, text: string): MemoryEntry => ({
    id,
    ts: local(2026, 11, 6, 10, 0),
    date: "2026/11/06",
    time: "10:00",
    role: "user",
    window: "persona",
    sessionId: "s1",
    importance: "light",
    text,
  });
  log.append(mkE("torn-1", "第一条完整消息"));
  // Simulate a crash mid-append: a torn half-line, no trailing newline.
  appendFileSync(file, '{"id":"torn-half","ts":123', "utf8");
  log.append(mkE("torn-2", "第二条消息"));
  const all = log.readAll();
  assert.equal(all.length, 2, "the torn half is skipped, both real entries survive");
  assert.equal(all[0].id, "torn-1");
  assert.equal(all[1].id, "torn-2");
  // A clean file still appends exactly one line per entry.
  const dirC = mkdtempSync(join(tmpdir(), "memory-core-log-clean-"));
  const logC = new AppendLog(join(dirC, "log.jsonl"));
  logC.append(mkE("c-1", "干净的第一条"));
  logC.append(mkE("c-2", "干净的第二条"));
  assert.equal(logC.readAll().length, 2, "no spurious blank lines on a clean file");
});

check("0.4.6 (0.4.3 item 16): a failing stale-lock reclaim yields and times out instead of tight-looping", () => {
  const dirL = mkdtempSync(join(tmpdir(), "memory-core-046-lock-reclaim-"));
  const deadPid = spawnSync(process.execPath, ["--version"]).pid as number;
  const staleDir = lockDirPath(dirL);
  mkdirSync(staleDir, { recursive: true });
  writeFileSync(
    join(staleDir, "owner.json"),
    JSON.stringify({ pid: deadPid, token: "stale-owner", time: Date.now() - 60000 }),
    "utf8",
  );
  const old = new Date(Date.now() - 60000);
  utimesSync(staleDir, old, old);
  assert.equal(isLockStale(staleDir, 30000), true);
  // Force every reclaim to fail (simulates rm throwing, e.g. the
  // dir held open on Windows). The old code spun forever here
  // (both branches `continue`, skipping deadline + sleep); the
  // new code must throw within the timeout and say so.
  process.env.LOCK_TEST_RECLAIM_FAIL = "1";
  try {
    const start = Date.now();
    assert.throws(
      () => acquireWriteLock(dirL, { timeoutMs: 500 }),
      /could not acquire write lock.*reclaim attempt\(s\) failed/,
    );
    const elapsed = Date.now() - start;
    assert.ok(elapsed >= 400, `waited for the timeout, only ${elapsed}ms elapsed`);
    assert.ok(elapsed < 5000, `returned within the timeout instead of spinning, ${elapsed}ms elapsed`);
  } finally {
    delete process.env.LOCK_TEST_RECLAIM_FAIL;
  }
  // The stale lock is still there (nothing deleted it) and the
  // hook is off again: a normal acquire breaks it.
  assert.equal(existsSync(staleDir), true, "failed reclaim leaves the stale lock alone");
  const release = acquireWriteLock(dirL, { timeoutMs: 2000 });
  release();
  assert.equal(existsSync(staleDir), false, "with the hook off, the stale lock breaks normally");
});

console.log(`\nALL PASS (0.4.6 new issue 1 + 5)`);
