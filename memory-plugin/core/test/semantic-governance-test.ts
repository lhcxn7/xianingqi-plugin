// 终版 WP8 — semantic index governance tests.
//
// Run: node test/semantic-governance-test.ts

import assert from "node:assert/strict";
import {
  SEMANTIC_DEFAULT_MAX_ENTRIES,
  selectSemanticEntriesForIndex,
} from "../src/semantic.ts";
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
const day = 24 * 60 * 60 * 1000;
const mk = (
  id: string,
  opts: Partial<MemoryEntry> & { ts: number },
): MemoryEntry => ({
  id,
  date: "2026/11/11",
  time: "12:00",
  role: "user",
  window: "persona",
  sessionId: "s1",
  importance: "light",
  text: `记忆 ${id}`,
  ...opts,
});

const heavyRecent = mk("heavy-recent", {
  ts: now - 1 * day,
  importance: "heavy",
});
const lightRecent = mk("light-recent", { ts: now - 1 * day });
const heavyOld = mk("heavy-old", { ts: now - 300 * day, importance: "heavy" });
const task = mk("task", { ts: now - 1 * day, kind: "task" });
const greeting = mk("greeting", { ts: now - 1 * day, kind: "greeting" });
const candidate = mk("candidate", { ts: now - 1 * day, candidate: true });
const hidden = mk("hidden", { ts: now - 1 * day });

const sig = (e: MemoryEntry): number =>
  e.importance === "heavy" ? 0.9 : 0.4;

const all = [
  heavyRecent,
  lightRecent,
  heavyOld,
  task,
  greeting,
  candidate,
  hidden,
];

check("default cap is 10000", () => {
  assert.equal(SEMANTIC_DEFAULT_MAX_ENTRIES, 10000);
});

check("only persona chat entries are indexed", () => {
  const picked = selectSemanticEntriesForIndex(all, {
    significanceOf: sig,
    maxEntries: 100,
    now,
    isForgotten: (id) => id === "hidden",
  });
  const ids = picked.map((e) => e.id);
  assert.deepEqual(
    ids.sort(),
    ["heavy-old", "heavy-recent", "light-recent"].sort(),
  );
});

check("over the cap keeps importance × recency", () => {
  const picked = selectSemanticEntriesForIndex(all, {
    significanceOf: sig,
    maxEntries: 2,
    now,
    isForgotten: (id) => id === "hidden",
  });
  assert.equal(picked[0].id, "heavy-recent");
  assert.equal(picked[1].id, "light-recent");
  assert.equal(picked.some((e) => e.id === "heavy-old"), false);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
