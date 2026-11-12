// 终版 WP7 — star map data: person roles + graph edges.
//
// Run: node test/starmap-wp7-test.ts

import assert from "node:assert/strict";
import { buildStarmapData } from "../src/starmap.ts";
import type { MemoryEntry } from "../src/types.ts";

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

const now = Date.parse("2026-11-11T12:00:00+08:00");
const base = {
  ts: now - 1000,
  date: "2026/11/11",
  time: "11:59",
  sessionId: "s1",
  importance: "light" as const,
  source: "log" as const,
};
const user: MemoryEntry = {
  ...base,
  id: "u1",
  role: "user",
  window: "persona",
  text: "我今天好累",
};
const her: MemoryEntry = {
  ...base,
  id: "a1",
  ts: now - 500,
  time: "11:59",
  role: "assistant",
  window: "persona",
  text: "那就早点睡。",
};

const data = buildStarmapData(
  [user, her],
  [{ from: "u1", to: "a1", type: "session", weight: 0.5 } as never],
  new Map(),
  now,
  [],
);

check("stars carry the speaker role", () => {
  const byId = new Map(data.memories.map((m) => [m.id, m]));
  assert.equal(byId.get("u1")?.role, "user");
  assert.equal(byId.get("a1")?.role, "assistant");
});

check("graph edges are carried for the constellation lines", () => {
  assert.equal(data.edges.length, 1);
  assert.equal(data.edges[0].from, "u1");
  assert.equal(data.edges[0].to, "a1");
  assert.equal(data.edges[0].weight, 0.5);
});

check("duplicate edges collapse to the strongest weight", () => {
  const merged = buildStarmapData(
    [user, her],
    [
      { from: "u1", to: "a1", type: "session", weight: 0.5 } as never,
      { from: "a1", to: "u1", type: "recall", weight: 0.9 } as never,
    ],
    new Map(),
    now,
    [],
  );
  assert.equal(merged.edges.length, 1);
  assert.equal(merged.edges[0].weight, 0.9);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
