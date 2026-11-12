// 终版 WP9 — runtime install + auto-enable tests.
//
// Run: node test/install-runtime-test.ts
// The actual `--yes` install is NOT run here (it uses the network);
// the test pins the dry-run command and the consent gate.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryCore } from "../src/index.ts";
import {
  installTransformersRuntime,
  transformersInstallCommand,
} from "../src/install-runtime.ts";

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

const dir = mkdtempSync(join(tmpdir(), "memory-install-runtime-"));
try {
  check("dry-run prints the npm command without consent", () => {
    const cmd = transformersInstallCommand(dir);
    assert.ok(cmd.includes("npm install"));
    assert.ok(cmd.includes("@huggingface/transformers@3.8.1"));
    assert.ok(cmd.includes(dir));
    const out = installTransformersRuntime(dir, { dryRun: true });
    assert.equal(out.ok, true);
    assert.equal(out.dryRun, true);
    assert.equal(out.needsConfirmation, false);
    assert.equal(out.command, cmd);
  });

  check("without --yes it asks for confirmation and runs nothing", () => {
    const out = installTransformersRuntime(dir, {});
    assert.equal(out.ok, false);
    assert.equal(out.needsConfirmation, true);
    assert.equal(out.dryRun, false);
  });

  check("autoEnable false keeps semantic off; explicit enabled wins", () => {
    const off = new MemoryCore({
      dataDir: join(dir, "a"),
      semanticRecall: { autoEnable: false },
    });
    assert.equal(off.semanticEnabled(), false);
    const on = new MemoryCore({
      dataDir: join(dir, "b"),
      semanticRecall: { enabled: true },
    });
    assert.equal(on.semanticEnabled(), true);
  });

  check("dependency status names the install command and dirs", () => {
    const core = new MemoryCore({ dataDir: join(dir, "c") });
    const dep = core.semanticStatus().dependency;
    assert.equal(dep.modelPresent, true, "bundled model is present");
    assert.equal(typeof dep.runtimePresent, "boolean");
    assert.ok(dep.installCommand.includes("semantic install --yes"));
    assert.ok(dep.manualHint.includes("npm install"));
  });
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
