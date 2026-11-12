// 终版 WP4 — fact time semantics tests.
//
// Run: node test/facts-time-test.ts

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryCore } from "../src/index.ts";

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

const dir = mkdtempSync(join(tmpdir(), "memory-facts-time-"));
try {
  const core = new MemoryCore({ dataDir: dir });
  const base = Date.now() - 100_000;
  const in2020 = Date.parse("2020-01-01T00:00:00+08:00");
  const in2024 = Date.parse("2024-01-01T00:00:00+08:00");
  const in2019 = Date.parse("2019-01-01T00:00:00+08:00");
  const in2025 = Date.parse("2025-01-01T00:00:00+08:00");

  const v1 = core.record({
    role: "user",
    text: "我住在朝阳区",
    factKey: "住在哪里",
    validFrom: in2020,
    observedAt: in2020,
    ts: base,
  });
  const v2 = core.record({
    role: "user",
    text: "我搬到海淀区了",
    factKey: "住在哪里",
    validFrom: in2024,
    observedAt: in2024,
    ts: base + 1000,
  });

  check("fields are written", () => {
    assert.equal(v1.validFrom, in2020);
    assert.equal(v1.observedAt, in2020);
    assert.equal(v2.validFrom, in2024);
  });

  check("present query answers the latest validFrom", () => {
    const r = core.recall("住在哪");
    assert.ok(r.hits.length > 0);
    assert.equal(r.hits[0].entry.id, v2.id);
  });

  check("history query answers the old version", () => {
    const r = core.recall("我以前住在哪");
    assert.ok(r.hits.length > 0);
    assert.equal(r.hits[0].entry.id, v1.id);
  });

  check("a backdated later write does not become current", () => {
    const v3 = core.record({
      role: "user",
      text: "我住在西城区",
      factKey: "住在哪里",
      validFrom: in2019,
      ts: base + 2000,
    });
    const r = core.recall("住在哪");
    assert.equal(r.hits[0].entry.id, v2.id);
    assert.notEqual(r.hits[0].entry.id, v3.id);
  });

  check("supersedes links still decide the current version", () => {
    const v4 = core.record({
      role: "user",
      text: "我现在住东城区",
      factKey: "住在哪里",
      validFrom: in2025,
      supersedes: v2.id,
      ts: base + 3000,
    });
    const present = core.recall("住在哪");
    assert.equal(present.hits[0].entry.id, v4.id);
    const history = core.recall("我以前住在哪");
    assert.notEqual(history.hits[0].entry.id, v4.id);
  });

  check("different applicable scopes can coexist as two factKeys", () => {
    const work = core.record({
      role: "user",
      text: "工作日住在公司附近",
      factKey: "工作日住哪",
      ts: base + 4000,
    });
    const home = core.record({
      role: "user",
      text: "周末回家住",
      factKey: "周末住哪",
      ts: base + 5000,
    });
    const a = core.recall("工作日住哪");
    const b = core.recall("周末住哪");
    assert.equal(a.hits[0].entry.id, work.id);
    assert.equal(b.hits[0].entry.id, home.id);
  });

  check("a candidate is not recalled by default", () => {
    const cand = core.record({
      role: "user",
      text: "我可能养了一只猫，叫团子，还没确认",
      candidate: true,
      ts: base + 6000,
    });
    assert.equal(core.recall("猫").hits.length, 0);
    const r = core.recall("猫", { includeCandidates: true });
    assert.equal(r.hits[0].entry.id, cand.id);
    assert.equal(r.hits[0].candidate, true);
  });
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
