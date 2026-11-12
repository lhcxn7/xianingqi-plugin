// 终版 WP1 — core-side kind filtering tests.
//
// Run: node test/kind-test.ts
//
// Checks that "task" and "greeting" entries stay in the log but never
// reach default recall / review / starmap, and that an old entry with
// no kind still behaves as persona (zero migration).

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryCore } from "../src/index.ts";

const dir = mkdtempSync(join(tmpdir(), "memory-kind-"));
let passed = 0;
const failures: string[] = [];

function check(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (err) {
    failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    console.log(`FAIL ${name}`);
  }
}

try {
  const core = new MemoryCore({ dataDir: dir });
  const base = Date.now() - 60_000;

  const persona = core.record({
    role: "user",
    text: "我喜欢喝酸梅汤，夏天一定要冰的",
    kind: "persona",
    ts: base,
  });
  const task = core.record({
    role: "user",
    text: "帮我改这段文档，语气软一点",
    kind: "task",
    ts: base + 1000,
  });
  const greeting = core.record({
    role: "user",
    text: "夏柠柒",
    kind: "greeting",
    ts: base + 2000,
  });
  // Old entry: no kind at all.
  const legacy = core.record({
    role: "user",
    text: "我以前住在朝阳区",
    ts: base + 3000,
  });

  check("record keeps the kind on disk", () => {
    assert.equal(persona.kind, "persona");
    assert.equal(task.kind, "task");
    assert.equal(greeting.kind, "greeting");
    assert.equal(legacy.kind, undefined);
  });

  check("default recall: persona only (legacy counts as persona)", () => {
    const r = core.recall("酸梅汤");
    assert.equal(r.hits.length, 1);
    assert.equal(r.hits[0].entry.id, persona.id);

    const old = core.recall("朝阳区");
    assert.equal(old.hits.length, 1);
    assert.equal(old.hits[0].entry.id, legacy.id);
  });

  check("task content is not recalled by default", () => {
    const r = core.recall("文档");
    assert.equal(r.hits.length, 0);
  });

  check("includeWork exposes task content on explicit search", () => {
    const r = core.recall("文档", { includeWork: true });
    assert.equal(r.hits.length, 1);
    assert.equal(r.hits[0].entry.id, task.id);
    assert.equal(r.hits[0].entry.kind, "task");
  });

  check("greeting is never recalled, even with includeWork", () => {
    const r = core.recall("夏柠柒", { includeWork: true });
    assert.equal(
      r.hits.some((h) => h.entry.id === greeting.id),
      false,
    );
  });

  check("stats reports the kind split", () => {
    const s = core.stats();
    assert.equal(s.kinds?.persona, 2);
    assert.equal(s.kinds?.task, 1);
    assert.equal(s.kinds?.greeting, 1);
  });

  check("review only touches persona entries", () => {
    const r = core.review(true);
    assert.ok(r);
    assert.equal(r.lastStats.entries, 2);
  });

  check("starmap excludes task and greeting", () => {
    const html = core.generateStarmap();
    assert.equal(html.nodes, 2);
  });
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
