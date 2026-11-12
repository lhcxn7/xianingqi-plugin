// 终版 WP5 — recall governance tests.
//
// Run: node test/recall-governance-test.ts

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryCore } from "../src/index.ts";
import { applyValveTop, VALVE_TOP } from "../src/activation.ts";
import { composeInjection } from "../src/recall.ts";
import { reflectionGate } from "../src/reflection.ts";
import { SEMANTIC_DEFAULT_TIMEOUT_MS } from "../src/semantic.ts";

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

check("valve default is 8 and accepts 1..10", () => {
  assert.equal(VALVE_TOP, 8);
  const hits = Array.from({ length: 12 }, (_, i) => ({
    activation: 1,
    topic: `t${i}`,
  }));
  assert.equal(applyValveTop(hits).length, 8);
  assert.equal(applyValveTop(hits, 10).length, 10);
  assert.equal(applyValveTop(hits, 20).length, 10);
  assert.equal(applyValveTop(hits, 0).length, 1);
});

check("reflection gate opens on any new persona entry", () => {
  const now = Date.now();
  const entry = {
    id: "e1",
    ts: now - 1000,
    date: "2026/11/11",
    time: "12:00",
    role: "user" as const,
    window: "persona" as const,
    sessionId: "s",
    importance: "light" as const,
    text: "今天有点累",
  };
  assert.equal(reflectionGate([entry], () => 0.4, now).reached, true);
  assert.equal(reflectionGate([], () => 0.4, now).reached, false);
});

check("semantic timeout is 3 s", () => {
  assert.equal(SEMANTIC_DEFAULT_TIMEOUT_MS, 3000);
});

const dir = mkdtempSync(join(tmpdir(), "memory-recall-gov-"));
try {
  const core = new MemoryCore({ dataDir: dir });
  const now = Date.now();
  for (let i = 0; i < 5; i += 1) {
    core.record({
      role: "user",
      text: `今天想说的是第 ${i} 件事，关于苹果`,
      ts: now - (10 - i) * 1000,
    });
  }

  check("injection header says these are candidates", () => {
    const r = core.recall("苹果");
    assert.ok(r.hits.length > 0);
    const text = composeInjection("", r.hits, undefined, undefined, 1500);
    assert.ok(text.includes("候选"), text.slice(0, 80));
    assert.ok(text.includes("不必凑满 5 条"));
  });

  check("token-cap drops are reported through onDrop", () => {
    const r = core.recall("苹果");
    let dropped: unknown[] = [];
    composeInjection("", r.hits, undefined, undefined, 1, (d) => {
      dropped = d;
    });
    assert.ok(dropped.length > 0);
  });
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
