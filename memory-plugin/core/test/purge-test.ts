// 终版 WP2 — delete ledger + pattern purge tests.
//
// Run: node test/purge-test.ts

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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

// ---- ledger: restoring a pre-delete snapshot must not resurrect ----
const dirA = mkdtempSync(join(tmpdir(), "memory-ledger-"));
try {
  const core = new MemoryCore({ dataDir: dirA });
  const secret = core.record({
    role: "user",
    text: "我的手机号是 13800138000，别记",
    ts: Date.now() - 10_000,
  });
  const normal = core.record({
    role: "user",
    text: "我喜欢喝酸梅汤",
    ts: Date.now() - 9_000,
  });
  const snap = core.snapshot();
  const req = core.requestForget({
    mode: "delete",
    entryIds: [secret.id],
    reason: "test secret",
    createdBy: "cli",
  });
  core.approveForget(req.id, { channel: "cli", by: "test" });
  const res = core.executeForget(req.id, { by: "test" });
  assert.deepEqual(res.removed, [secret.id]);

  check("delete removes the entry and writes the ledger", () => {
    assert.equal(core.recall("13800138000").hits.length, 0);
    assert.equal(core.recall("酸梅汤").hits.length, 1);
    assert.ok(existsSync(join(dirA, "forget-ledger.jsonl")));
    const ledger = readFileSync(join(dirA, "forget-ledger.jsonl"), "utf8");
    assert.ok(ledger.includes(secret.id));
    assert.ok(!ledger.includes("13800138000"), "ledger never carries the words");
  });

  check("restoring a pre-delete snapshot does not resurrect", () => {
    core.restore(snap);
    assert.equal(core.recall("13800138000").hits.length, 0);
    assert.equal(core.recall("酸梅汤").hits.length, 1);
    assert.equal(core.allEntries().some((e) => e.id === secret.id), false);
    assert.equal(core.allEntries().some((e) => e.id === normal.id), true);
  });
} finally {
  rmSync(dirA, { recursive: true, force: true });
}

// ---- purge: dry-run first, then remove logs + snapshots ----
const dirB = mkdtempSync(join(tmpdir(), "memory-purge-"));
try {
  const core = new MemoryCore({ dataDir: dirB });
  const s1 = core.record({
    role: "user",
    text: "身份证号 110101199001011234 不要外传",
    ts: Date.now() - 10_000,
  });
  const normal = core.record({
    role: "user",
    text: "今天想吃酸梅汤",
    ts: Date.now() - 9_000,
  });
  const s2 = core.record({
    role: "assistant",
    text: "记住 110101199001011234 这个号码要还给你",
    ts: Date.now() - 8_000,
  });
  const snap = core.snapshot();

  check("purge dry-run reports without changing anything", () => {
    const dry = core.purgeByPattern("110101199001011234", { dryRun: true });
    assert.equal(dry.dryRun, true);
    assert.equal(dry.matches.length, 2);
    assert.ok(dry.snapshots.includes(snap));
    assert.ok(dry.matches.every((m) => m.masked.includes("***")));
    assert.ok(dry.matches.every((m) => !m.masked.includes("110101199001011234")));
    assert.equal(core.allEntries().length, 3);
    assert.equal(core.recall("110101199001011234").hits.length, 2);
  });

  check("purge removes log rows, stores and snapshots", () => {
    const out = core.purgeByPattern("110101199001011234", {
      dryRun: false,
      by: "test",
    });
    assert.equal(out.removed, 2);
    assert.equal(core.recall("110101199001011234").hits.length, 0);
    assert.equal(core.recall("酸梅汤").hits.length, 1);
    assert.equal(core.allEntries().length, 1);
    assert.equal(core.allEntries()[0].id, normal.id);
    assert.equal(existsSync(join(dirB, ".snapshots", snap)), false);
    assert.equal(out.snapshotsRemoved.includes(snap), true);
  });

  check("purge leaves no secret in audit, ledger or starmap", () => {
    const audit = readFileSync(join(dirB, "forget-audit.jsonl"), "utf8");
    assert.ok(!audit.includes("110101199001011234"));
    const ledger = readFileSync(join(dirB, "forget-ledger.jsonl"), "utf8");
    assert.ok(!ledger.includes("110101199001011234"));
    assert.ok(ledger.includes(s1.id) && ledger.includes(s2.id));
    const starmap = readFileSync(join(dirB, "starmap.html"), "utf8");
    assert.ok(!starmap.includes("110101199001011234"));
  });
} finally {
  rmSync(dirB, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
