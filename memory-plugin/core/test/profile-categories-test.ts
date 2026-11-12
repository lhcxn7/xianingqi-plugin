// 终版 WP6 — 8-category profile tests.
//
// Run: node test/profile-categories-test.ts

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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

const dir = mkdtempSync(join(tmpdir(), "memory-profile-cat-"));
try {
  const core = new MemoryCore({ dataDir: dir });
  const e1 = core.record({ role: "user", text: "我喜欢喝酸梅汤", ts: Date.now() - 2000 });
  const e2 = core.record({ role: "user", text: "我胃不好，吃辣会疼", ts: Date.now() - 1000 });

  check("updateProfile writes categories with sources", () => {
    const p = core.updateProfile({
      categories: {
        偏好: [
          { text: "喜欢喝酸梅汤", sourceIds: [e1.id], updatedAt: Date.now() },
        ],
        身体健康: [
          { text: "胃不好，吃辣会疼", sourceIds: [e2.id], updatedAt: Date.now() },
        ],
      },
    });
    assert.equal(p.categories?.偏好?.[0].text, "喜欢喝酸梅汤");
    assert.deepEqual(p.categories?.偏好?.[0].sourceIds, [e1.id]);
    assert.equal(p.categories?.身体健康?.[0].text, "胃不好，吃辣会疼");
  });

  check("reading back merges profile.json over layer 1", () => {
    const layer1 = core.readLayer1();
    assert.equal(layer1.profile?.categories?.偏好?.[0].text, "喜欢喝酸梅汤");
    const raw = JSON.parse(readFileSync(join(dir, "profile.json"), "utf8")) as {
      categories?: Record<string, unknown>;
    };
    assert.ok(raw.categories?.偏好);
    assert.ok(raw.categories?.身体健康);
  });

  check("updating one category preserves the others", () => {
    core.updateProfile({
      categories: {
        偏好: [
          { text: "喜欢喝酸梅汤", sourceIds: [e1.id], updatedAt: Date.now() },
          { text: "也喜欢蓝莓", sourceIds: [e1.id], updatedAt: Date.now() },
        ],
      },
    });
    const cats = core.readLayer1().profile?.categories;
    assert.equal(cats?.偏好?.length, 2);
    assert.equal(cats?.身体健康?.length, 1, "other category survives");
  });
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
