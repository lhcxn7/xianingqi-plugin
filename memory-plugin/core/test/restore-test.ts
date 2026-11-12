// 终版 WP3 — restore consistency tests.
//
// Run: node test/restore-test.ts

import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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

// ---- 1. a valid restore rebuilds and verifies ----
const dirA = mkdtempSync(join(tmpdir(), "memory-restore-a-"));
try {
  const core = new MemoryCore({ dataDir: dirA });
  core.record({ role: "user", text: "我喜欢喝酸梅汤", ts: Date.now() - 20_000 });
  const snap = core.snapshot();
  core.record({ role: "user", text: "今天很累", ts: Date.now() - 10_000 });

  check("valid restore returns to the snapshot and rebuilds stores", () => {
    core.restore(snap);
    assert.equal(core.allEntries().length, 1);
    assert.equal(core.recall("酸梅汤").hits.length, 1);
    assert.equal(core.recall("很累").hits.length, 0);
    assert.equal(existsSync(join(dirA, "restore-journal.json")), false);
  });

  check("1.0.0: loop.json is snapshotted and restored with the log", () => {
    const loopFile = join(dirA, "loop.json");
    writeFileSync(
      loopFile,
      JSON.stringify({
        version: 1,
        pendingActions: [],
        recentTriggers: [{ trigger: "old", at: 1 }],
      }),
    );
    const snapLoop = core.snapshot();
    writeFileSync(
      loopFile,
      JSON.stringify({
        version: 1,
        pendingActions: [],
        recentTriggers: [{ trigger: "new", at: 2 }],
      }),
    );
    core.restore(snapLoop);
    const restored = JSON.parse(readFileSync(loopFile, "utf8")) as {
      recentTriggers: Array<{ trigger: string }>;
    };
    assert.equal(restored.recentTriggers[0].trigger, "old");
  });

  check("1.0.0: an old snapshot without loop.json keeps the live loop", () => {
    const loopFile = join(dirA, "loop.json");
    const snapOld = core.snapshot();
    rmSync(join(dirA, ".snapshots", snapOld, "loop.json"), { force: true });
    writeFileSync(
      loopFile,
      JSON.stringify({
        version: 1,
        pendingActions: [],
        recentTriggers: [{ trigger: "keep", at: 3 }],
      }),
    );
    core.restore(snapOld);
    const after = JSON.parse(readFileSync(loopFile, "utf8")) as {
      recentTriggers: Array<{ trigger: string }>;
    };
    assert.equal(after.recentTriggers[0].trigger, "keep");
  });
} finally {
  rmSync(dirA, { recursive: true, force: true });
}

// ---- 2. interrupted restore is rolled back on the next Core ----
const dirB = mkdtempSync(join(tmpdir(), "memory-restore-b-"));
try {
  const core = new MemoryCore({ dataDir: dirB });
  core.record({ role: "user", text: "安全状态里的记忆", ts: Date.now() - 20_000 });
  const safe = core.snapshot();
  core.record({ role: "user", text: "恢复后不该留下", ts: Date.now() - 10_000 });
  // Simulate a crash after the restore copied files: the journal is
  // committing, pointing at a safety snapshot.
  writeFileSync(
    join(dirB, "restore-journal.json"),
    JSON.stringify(
      { snapshot: "does-not-matter", safety: safe, status: "committing" },
      null,
      2,
    ),
    "utf8",
  );

  check("interrupted restore rolls back to safety on the next start", () => {
    const recovered = new MemoryCore({ dataDir: dirB });
    assert.equal(existsSync(join(dirB, "restore-journal.json")), false);
    assert.equal(recovered.allEntries().length, 1);
    assert.equal(recovered.recall("安全状态里的记忆").hits.length, 1);
    assert.equal(recovered.recall("恢复后不该留下").hits.length, 0);
  });
} finally {
  rmSync(dirB, { recursive: true, force: true });
}

// ---- 3. a corrupt snapshot (duplicate log row) fails and rolls back ----
const dirC = mkdtempSync(join(tmpdir(), "memory-restore-c-"));
try {
  const core = new MemoryCore({ dataDir: dirC });
  core.record({ role: "user", text: "第一句", ts: Date.now() - 20_000 });
  const bad = core.snapshot();
  const badLog = join(dirC, ".snapshots", bad, "log.jsonl");
  const line = readFileSync(badLog, "utf8").trim();
  writeFileSync(badLog, `${line}\n${line}\n`, "utf8");
  core.record({ role: "user", text: "当前状态第二句", ts: Date.now() - 10_000 });

  check("verification failure rolls back and keeps the journal", () => {
    assert.throws(() => core.restore(bad), /恢复失败，已回滚/);
    const journal = JSON.parse(
      readFileSync(join(dirC, "restore-journal.json"), "utf8"),
    ) as { status?: string };
    assert.equal(journal.status, "rolled-back");
    // The safety snapshot is the state before the failed restore.
    assert.equal(core.allEntries().length, 2);
    assert.equal(core.recall("当前状态第二句").hits.length, 1);
  });
} finally {
  rmSync(dirC, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
