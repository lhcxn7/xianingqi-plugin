// Mock-DSH test for @character-db/dsh-plugin.
// Drives tool registration + execution with a fake Cordis context:
// no real DSH, no API key, no network. Exits non-zero on any failed
// assertion.
//
// The fake context is tools-only ON PURPOSE: it records every
// on()/effect() call and every systemPrompt call. The plugin may
// register exactly ONE static systemPrompt.section (tool-usage
// instructions only, 0.1.1) — systemPrompt.context() must NEVER be
// called, and on()/effect() must NEVER be called either; any of
// those would be the tools-only tripwire firing. It also has NO
// config property: real DSH passes plugin config as apply's SECOND
// argument, and a ctx carrying config would hide the "cannot get
// property config without inject" failure (2026-11-05).

import { strict as assert } from "node:assert";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { apply, inject, name, resolveDataDir, TOOLS_SECTION_NAME, TOOLS_SECTION_TEXT } from "../src/index.ts";
import { isObjectSchema } from "../src/define-tool.ts";
import { loadDb } from "../src/db.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1;
      console.log(`PASS ${label}`);
    });
}

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REAL_DB_DIR = join(TEST_DIR, "..", "..", "xia-ningqi");

type ToolFn = (args: unknown) => Promise<Record<string, unknown>>;

class MockContext {
  registeredTools: Array<Record<string, unknown>> = [];
  onCalls: string[] = [];
  effectCalls = 0;
  // The one static section apply() registers (0.1.1), recorded here
  // in order; context() calls are counted separately and must stay 0.
  sections: Array<{ name: string; order: number; text: string }> = [];
  contextCalls = 0;

  // NOTE: no config property, on purpose (see the header comment).
  // systemPrompt IS present on purpose: the fake registry records
  // section()/context() so the test can prove the plugin registers
  // exactly one static section and never touches dynamic context.
  // Arrow functions close over this instance (the strict Proxy below
  // passes the registry object through untouched).
  systemPrompt = {
    section: (opts: { name: string; order: number; text: string }) => {
      this.sections.push(opts);
    },
    context: (_opts: unknown) => {
      this.contextCalls += 1;
      return () => {};
    },
  };

  tools = {
    register: (t: unknown) => {
      this.registeredTools.push(t as Record<string, unknown>);
    },
    get: (toolName: string) =>
      this.registeredTools.find((t) => t.name === toolName),
  };

  on(event: string): void {
    this.onCalls.push(event);
  }

  effect(): void {
    this.effectCalls += 1;
  }
}

function tool(ctx: MockContext, toolName: string): ToolFn {
  const t = ctx.registeredTools.find((x) => x.name === toolName);
  assert.ok(t, `工具 ${toolName} 应该已注册`);
  assert.equal(typeof t.execute, "function");
  return t.execute as ToolFn;
}

function snapshotDir(dir: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const f of readdirSync(dir)) {
    out.set(f, statSync(join(dir, f)).size);
  }
  return out;
}

// ---------------------------------------------------------------- exports
await check("plugin exports name/inject/apply, inject is tools + systemPrompt", () => {
  assert.equal(name, "character-db");
  // systemPrompt is in inject because apply registers one static
  // section (0.1.1); without it ctx.systemPrompt would not exist in
  // real DSH. No hooks are registered, so nothing else is needed.
  assert.deepEqual(inject, ["tools", "systemPrompt"]);
  assert.equal(typeof apply, "function");
});

await check("resolveDataDir: config > env > default", () => {
  assert.equal(resolveDataDir({ dataDir: "/tmp/somewhere" }), "/tmp/somewhere");
  const def = resolveDataDir({});
  assert.ok(def.endsWith(join("character-db", "xia-ningqi")));
});

// ---------------------------------------------------------------- config Proxy
const strictDir = mkdtempSync(join(tmpdir(), "character-db-strict-"));
// The strict dir needs a loadable db: the regression is about
// ctx.config access, not about load failure — an empty dir would
// throw in loadDb before the point is proven.
writeFileSync(
  join(strictDir, "lines.json"),
  JSON.stringify({
    character: "test-char",
    character_name: "测试角色",
    collection: "lines",
    entries: [
      {
        id: "line-001-01",
        type: "lines",
        chapter: 1,
        chapter_label: null,
        chapter_range: null,
        stage: "early",
        addressee: null,
        emotion: [],
        tags: ["测试"],
        text: "测试台词。",
        scene: null,
        source: "mock-test",
        paraphrase: true,
      },
    ],
  }),
  "utf8",
);
const strictCtx = new MockContext();
const strictProxy = new Proxy(strictCtx, {
  get(t, p) {
    if (p === "config") {
      throw new Error('cannot get property "config" without inject');
    }
    const v = (t as unknown as Record<string | symbol, unknown>)[p];
    return typeof v === "function"
      ? (v as (...a: never[]) => unknown).bind(t)
      : v;
  },
});

await check("apply never reads ctx.config (real-DSH regression)", () => {
  apply(strictProxy as never, { dataDir: strictDir } as never);
});

// ---------------------------------------------------------------- real DB
const before = snapshotDir(REAL_DB_DIR);
const ctx = new MockContext();
apply(ctx as never, { dataDir: REAL_DB_DIR } as never);
await sleep(80); // async defineTool load + tool registration

await check("registers exactly the two tools with valid JSON Schema params", () => {
  assert.equal(ctx.registeredTools.length, 2);
  const names = ctx.registeredTools.map((t) => t.name).sort();
  assert.deepEqual(names, ["character_lookup", "character_search"]);
  for (const t of ctx.registeredTools) {
    assert.ok(
      isObjectSchema(t.parameters),
      `${String(t.name)} 的 parameters 必须是合法 JSON Schema`,
    );
  }
});

await check("tools-only: no listeners, no effect, no systemPrompt.context; one static tools section", () => {
  assert.deepEqual(ctx.onCalls, []);
  assert.equal(ctx.effectCalls, 0);
  // Dynamic context must never be registered: the plugin injects
  // nothing into the prompt per turn.
  assert.equal(ctx.contextCalls, 0);
  // Exactly one static section, with the expected id and text.
  assert.equal(ctx.sections.length, 1);
  assert.equal(ctx.sections[0].name, TOOLS_SECTION_NAME);
  assert.equal(ctx.sections[0].name, "character-db:tools");
  assert.equal(ctx.sections[0].text, TOOLS_SECTION_TEXT);
});

await check("tools section text names both tools, when to call, and the guards", () => {
  const text = TOOLS_SECTION_TEXT;
  // Both tools named.
  assert.ok(text.includes("character_search"));
  assert.ok(text.includes("character_lookup"));
  // When to call: canon-detail checks only, with the four examples.
  assert.ok(text.includes("核对原著细节"));
  assert.ok(text.includes("某句台词"));
  assert.ok(text.includes("某件事"));
  assert.ok(text.includes("某个人物"));
  assert.ok(text.includes("某个名字"));
  assert.ok(text.includes("不要为了闲聊主动查库"));
  // The guards from the tool descriptions.
  assert.ok(text.includes("不是她的原话"));
  assert.ok(text.includes("不是与聊天使用者的共同经历"));
  // No canon content whatsoever: no entry ids, no chapter-specific
  // facts, no names of people or events from the novel.
  assert.ok(!/event-|line-|inner-|trait-|rel-|arc-/.test(text));
  for (const forbidden of ["绑架", "410", "摩天轮", "祁南", "叶安苒", "定位器"]) {
    assert.ok(!text.includes(forbidden), `section 文本不应出现原著内容：${forbidden}`);
  }
});

const search = tool(ctx, "character_search");
const lookup = tool(ctx, "character_lookup");

await check("search 绑架 returns the 238-chapter entries on top", async () => {
  const r = await search({ query: "绑架" });
  assert.equal(r.ok, true);
  assert.ok((r.totalHits as number) > 0);
  const results = r.results as Array<Record<string, unknown>>;
  assert.ok(results.length > 0);
  assert.ok(["event-231-240", "event-238"].includes(results[0].id as string));
  assert.ok(results.some((x) => x.id === "event-238"));
  for (const x of results) {
    assert.equal(typeof x.id, "string");
    assert.equal(typeof x.text, "string");
    assert.ok((x.text as string).length > 0);
    assert.equal(typeof x.source, "string");
    assert.ok(Array.isArray(x.emotion));
  }
  assert.equal(r.truncated, false);
});

await check("filters: chapter range / emotion / stage / addressee", async () => {
  const byRange = (await search({ chapter: "231-264" })) as Record<
    string,
    unknown
  >;
  assert.equal(byRange.ok, true);
  const rangeResults = byRange.results as Array<Record<string, unknown>>;
  assert.ok(rangeResults.length > 0);
  for (const x of rangeResults) {
    const ch = x.chapter as number | null;
    const cr = x.chapter_range as [number, number] | null;
    const inRange =
      (ch !== null && ch >= 231 && ch <= 264) ||
      (cr !== null && cr[0] <= 264 && cr[1] >= 231);
    assert.ok(inRange, `${String(x.id)} 应在 231-264 范围内`);
  }

  const byEmotion = (await search({ emotion: "吃醋" })) as Record<
    string,
    unknown
  >;
  const emoResults = byEmotion.results as Array<Record<string, unknown>>;
  assert.ok(emoResults.length > 0);
  for (const x of emoResults) {
    assert.ok((x.emotion as string[]).includes("吃醋"));
  }

  const byStage = (await search({ stage: "late" })) as Record<
    string,
    unknown
  >;
  const stageResults = byStage.results as Array<Record<string, unknown>>;
  assert.ok(stageResults.length > 0);
  for (const x of stageResults) assert.equal(x.stage, "late");

  const byAddressee = (await search({ addressee: "祁南" })) as Record<
    string,
    unknown
  >;
  const addrResults = byAddressee.results as Array<Record<string, unknown>>;
  assert.ok(addrResults.length > 0);
  for (const x of addrResults) assert.equal(x.addressee, "祁南");
});

await check("type filter: events at chapter 238", async () => {
  const r = (await search({ type: "events", chapter: "238" })) as Record<
    string,
    unknown
  >;
  assert.equal(r.ok, true);
  const results = r.results as Array<Record<string, unknown>>;
  assert.ok(results.some((x) => x.id === "event-238"));
  for (const x of results) assert.equal(x.type, "key_events");
});

await check("lookup event-238 returns the full entry", async () => {
  const r = await lookup({ id: "event-238" });
  assert.equal(r.ok, true);
  assert.equal(r.found, true);
  const entry = r.entry as Record<string, unknown>;
  assert.equal(entry.id, "event-238");
  assert.equal(entry._type, "key_events");
  assert.ok((entry.text as string).includes("绑架"));
});

await check("lookup unknown id returns found:false, no throw", async () => {
  const r = await lookup({ id: "no-such-id" });
  assert.equal(r.ok, true);
  assert.equal(r.found, false);
  assert.equal(typeof r.error, "string");
});

await check("lookup empty id returns an error, no throw", async () => {
  const r = await lookup({ id: "   " });
  assert.equal(r.ok, false);
  assert.equal(r.found, false);
});

await check("search with no query and no filter returns an error", async () => {
  const r = await search({});
  assert.equal(r.ok, false);
  assert.equal(typeof r.error, "string");
});

await check("search rejects unknown type / bad chapter / bad stage", async () => {
  const badType = await search({ query: "绑架", type: "nonsense" });
  assert.equal(badType.ok, false);
  const badChapter = await search({ query: "绑架", chapter: "abc" });
  assert.equal(badChapter.ok, false);
  const badStage = await search({ query: "绑架", stage: "weird" });
  assert.equal(badStage.ok, false);
});

await check("limit is clamped to at most 20", async () => {
  const r = (await search({ query: "她", limit: 100 })) as Record<
    string,
    unknown
  >;
  assert.equal(r.ok, true);
  assert.ok((r.results as unknown[]).length <= 20);
});

// ---------------------------------------------------------------- truncation
const smallCapCtx = new MockContext();
apply(smallCapCtx as never, {
  dataDir: REAL_DB_DIR,
  tokenCap: 60,
} as never);
await sleep(80);

await check("tokenCap truncation: drops low-score hits and says so", async () => {
  const smallSearch = tool(smallCapCtx, "character_search");
  const r = (await smallSearch({ query: "绑架" })) as Record<string, unknown>;
  assert.equal(r.ok, true);
  assert.equal(r.truncated, true);
  assert.ok((r.dropped as number) > 0);
  assert.ok((r.returned as number) >= 1);
  assert.equal(typeof r.note, "string");
  assert.ok((r.note as string).includes("截掉"));
  assert.equal(r.tokenCap, 60);
});

// ---------------------------------------------------------------- bad JSON
const miniDir = mkdtempSync(join(tmpdir(), "character-db-mini-"));
writeFileSync(
  join(miniDir, "lines.json"),
  JSON.stringify({
    character: "test-char",
    character_name: "测试角色",
    collection: "lines",
    entries: [
      {
        id: "line-001-01",
        type: "lines",
        chapter: 1,
        chapter_label: null,
        chapter_range: null,
        stage: "early",
        addressee: "测试对象",
        emotion: ["冷拒"],
        tags: ["测试", "绑架"],
        text: "测试台词一，提到绑架。",
        scene: "测试场景",
        source: "mock-test",
        paraphrase: true,
      },
      {
        id: "line-002-01",
        type: "lines",
        chapter: 2,
        chapter_label: null,
        chapter_range: null,
        stage: "early",
        addressee: "测试对象",
        emotion: ["吃醋"],
        tags: ["测试"],
        text: "测试台词二。",
        scene: null,
        source: "mock-test",
        paraphrase: true,
      },
    ],
  }),
  "utf8",
);
writeFileSync(join(miniDir, "traits.json"), "{不是 json", "utf8");
writeFileSync(
  join(miniDir, "index.json"),
  JSON.stringify({ character: "test-char" }),
  "utf8",
);

await check("loadDb skips a corrupt file instead of dying", () => {
  const mini = loadDb(miniDir);
  assert.equal(mini.entries.length, 2);
  assert.ok(mini.filesSkipped.includes("traits.json"));
  assert.equal(mini.characterName, "测试角色");
});

const miniCtx = new MockContext();
apply(miniCtx as never, { dataDir: miniDir } as never);
await sleep(80);

await check("mini db still answers search after skipping the bad file", async () => {
  const miniSearch = tool(miniCtx, "character_search");
  const r = (await miniSearch({ query: "绑架" })) as Record<string, unknown>;
  assert.equal(r.ok, true);
  const results = r.results as Array<Record<string, unknown>>;
  assert.ok(results.some((x) => x.id === "line-001-01"));
});

// ---------------------------------------------------------------- missing dir
await check("apply throws loudly on a missing dataDir", () => {
  const badCtx = new MockContext();
  assert.throws(
    () => apply(badCtx as never, { dataDir: "/tmp/definitely-not-a-db-dir" } as never),
    /人物数据库目录不存在/,
  );
  assert.equal(badCtx.registeredTools.length, 0);
  // The tools section is registered only after the db loads, so a
  // load failure means no section either.
  assert.equal(badCtx.sections.length, 0);
});

// ---------------------------------------------------------------- read-only
await check("read-only: real db files unchanged after apply + searches", () => {
  const after = snapshotDir(REAL_DB_DIR);
  assert.deepEqual([...after.entries()], [...before.entries()]);
});

console.log(`\nALL PASS (${passed}/${passed})`);
