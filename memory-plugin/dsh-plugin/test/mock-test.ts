// Mock-DSH test for @memory-plugin/dsh-plugin.
// Drives every hook with a fake Cordis context: no real DSH, no API
// key, no network. Exits non-zero on any failed assertion.
//
// The fake context mirrors real DSH 0.2.1-rc.5 behaviour where it
// matters (verified live 2026-11-06):
// - systemPrompt.context throws on a same-name re-registration in
//   one layer ("prompt context ... is already registered");
// - each agent gets its OWN scoped systemPrompt (agent.ctx), so the
//   same context name can live in two agents at once;
// - ctx.tools.get returns the registered tool (used by the shell's
//   post-register self-check).
//
// Tests isolate the machine environment: a globally set
// MEMORY_PLUGIN_DATA_DIR would otherwise look like a config/env
// conflict (WP0 read-only mode) for every temp-dir apply() below.
delete process.env.MEMORY_PLUGIN_DATA_DIR;

import { strict as assert } from "node:assert";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { HybridRetriever, MemoryCore } from "../../core/src/index.ts";
import { apply, hasTaskActionWord, hasTaskBlocklistWord, hasTaskTechnicalWord, inject, INVALIDATION_AUDIT_FILE, isBareTaskPhrase, isPersonaTrigger, MODEL_REVIEW_AUTO_RELEASE_TURNS, name, parseEmotion, rewriteQuery, shouldMarkPersona } from "../src/index.ts";
import { compileWithDshTools, normalizeToolSpec } from "../src/define-tool.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Evidence header (review-9 m-8): every run labels its OS + Node, so
// a Linux-only green run can never again pass for a Windows failure.
console.log(`os: ${process.platform} / node: ${process.version}`);

function check(label: string, fn: () => void): void {
  fn();
  console.log(`PASS ${label}`);
}

check("dsh-tools schema adapter removes false required flags and closes nested objects", () => {
  const normalized = normalizeToolSpec({
    parameters: {
      optional: { type: "string", required: false },
      nested: {
        type: "object",
        properties: {
          child: { type: "object", properties: { enabled: { type: "boolean" } } },
        },
      },
    },
    output: {
      schema: {
        type: "object",
        properties: {
          result: { type: "object", properties: { ok: { type: "boolean" } } },
        },
      },
    },
  }) as {
    parameters: Record<string, unknown>;
    output: { schema: Record<string, unknown> };
  };
  assert.deepEqual(normalized.parameters.optional, { type: "string" });
  const nested = normalized.parameters.nested as {
    additionalProperties: boolean;
    properties: Record<string, { additionalProperties: boolean }>;
  };
  assert.equal(nested.additionalProperties, false);
  assert.equal(nested.properties.child.additionalProperties, false);
  const output = normalized.output.schema.properties as Record<
    string,
    { additionalProperties: boolean }
  >;
  assert.equal(output.result.additionalProperties, false);
});

check("dsh-tools compiler failure falls back locally and warns once", () => {
  const originalWarn = console.warn;
  const warnings: string[] = [];
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  try {
    const execute = (args: unknown) => args;
    const spec = {
      name: "fallback_test",
      description: "Fallback regression fixture",
      parameters: {
        query: { type: "string", required: true },
        limit: { type: "number", required: false },
      },
      output: {
        schema: { type: "object", properties: { ok: { type: "boolean" } } },
        render: () => [],
      },
      execute,
    };
    const rejectSchema = () => {
      throw new Error("strict schema rule changed");
    };
    const first = compileWithDshTools(rejectSchema, spec) as {
      parameters: { type: string; required?: string[]; properties: Record<string, unknown> };
      execute: typeof execute;
    };
    const second = compileWithDshTools(rejectSchema, spec);
    assert.equal(first.parameters.type, "object");
    assert.deepEqual(first.parameters.required, ["query"]);
    assert.deepEqual(first.parameters.properties.limit, { type: "number" });
    assert.equal(first.execute, execute);
    assert.ok(second);
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0].includes("strict schema rule changed"));
  } finally {
    console.warn = originalWarn;
  }
});

interface Handler {
  handler: (...args: unknown[]) => unknown;
  opts?: { prepend?: boolean };
}

interface ContextRecord {
  name: string;
  order: number;
  text: string;
  disposed: boolean;
}

class MockContext {
  handlers = new Map<string, Handler[]>();
  sections: Array<{ name: string; order: number; text: string }> = [];
  contexts: ContextRecord[] = [];
  agentCtxs = new Map<
    string,
    {
      contexts: ContextRecord[];
      systemPrompt: {
        section: (o: { name: string; order: number; text: string }) => void;
        context: (o: {
          name: string;
          order: number;
          text: string;
        }) => () => void;
      };
    }
  >();
  registeredTools: Array<Record<string, unknown>> = [];
  disposers: Array<() => void> = [];

  // NOTE: no config property on purpose. Real DSH passes plugin config
  // as apply's SECOND argument; a ctx carrying config would hide the
  // "cannot get property config without inject" failure (2026-11-05).
  constructor(_dataDir: string) {}

  systemPrompt = {
    section: (o: { name: string; order: number; text: string }) => {
      // Real DSH throws on a same-name section re-registration in one
      // layer (audit m14); the shell must catch it, not die.
      if (this.sections.some((s) => s.name === o.name)) {
        throw new Error(
          `prompt section "${o.name}" is already registered`,
        );
      }
      this.sections.push(o);
    },
    context: (o: { name: string; order: number; text: string }) => {
      if (this.contexts.some((c) => c.name === o.name && !c.disposed)) {
        throw new Error(
          `prompt context "${o.name}" is already registered (for a per-agent override, register through that agent's agent.ctx instead)`,
        );
      }
      const rec = { ...o, disposed: false };
      this.contexts.push(rec);
      return () => {
        rec.disposed = true;
      };
    },
  };

  /** Per-agent scoped context (real DSH: decision.agent.ctx). Each
   *  agent has its own registry: the same name may live in two agents
   *  at once, but not twice in one agent. */
  agentCtx(id: string) {
    let rec = this.agentCtxs.get(id);
    if (!rec) {
      const contexts: ContextRecord[] = [];
      rec = {
        contexts,
        systemPrompt: {
          section: () => {},
          context: (o: { name: string; order: number; text: string }) => {
            if (contexts.some((c) => c.name === o.name && !c.disposed)) {
              throw new Error(
                `prompt context "${o.name}" is already registered (for a per-agent override, register through that agent's agent.ctx instead)`,
              );
            }
            const r = { ...o, disposed: false };
            contexts.push(r);
            return () => {
              r.disposed = true;
            };
          },
        },
      };
      this.agentCtxs.set(id, rec);
    }
    return rec;
  }

  tools = {
    register: (t: unknown) => {
      this.registeredTools.push(t as Record<string, unknown>);
    },
    get: (toolName: string) =>
      this.registeredTools.find((t) => t.name === toolName),
  };

  on(
    event: string,
    handler: (...args: unknown[]) => unknown,
    opts?: { prepend?: boolean },
  ): void {
    const list = this.handlers.get(event) ?? [];
    list.push({ handler, opts });
    this.handlers.set(event, list);
  }

  effect(fn: () => () => void): void {
    this.disposers.push(fn());
  }

  // Pass args through verbatim (no appended next): pre-step tests
  // call the handler directly when they need a next, and session/event
  // in real DSH arrives as TWO args (session, event).
  async emit(event: string, ...args: unknown[]): Promise<void> {
    for (const { handler } of this.handlers.get(event) ?? []) {
      await handler(...args);
    }
  }

  get preStep(): Handler | undefined {
    return (this.handlers.get("agent/pre-step") ?? [])[0];
  }
}

// ---- fixture: skill-shaped MEMORY.md (must never be written) -------
const fixtureMemory = `# MEMORY

## 当前状态

- 名字: 夏柠柒
- 阶段: 1
- 喜欢: 银口琴, 兔子挂件
- 约定:
  - 每周五查岗
- 计数: 对话轮数=40; 记忆条数=120

## 最近30天

### 2026/11/05

- 08:01 [user|persona|light] 今天天气不错
`;

const dir = mkdtempSync(join(tmpdir(), "memory-plugin-mock-"));
writeFileSync(join(dir, "MEMORY.md"), fixtureMemory, "utf8");
const memoryBefore = readFileSync(join(dir, "MEMORY.md"), "utf8");

const logCount = (): number => {
  const file = join(dir, "log.jsonl");
  if (!existsSync(file)) return 0;
  return readFileSync(file, "utf8").trim().split("\n").filter(Boolean)
    .length;
};

const lastLog = (): Record<string, unknown> => {
  const lines = readFileSync(join(dir, "log.jsonl"), "utf8")
    .trim()
    .split("\n")
    .filter(Boolean);
  return JSON.parse(lines[lines.length - 1]) as Record<string, unknown>;
};

check("0.5.0 step 2: greetings that happen to contain a task-action word now mark (0.4.8: 6 openings, 4 unmarked)", () => {
  // The four 0.4.8 failures — ordinary chat use of 同步 / 测试 /
  // 创建 / 更新 — must mark now.
  assert.equal(shouldMarkPersona("夏柠柒，我想和你同步一下近况"), true);
  assert.equal(shouldMarkPersona("夏柠柒，测试一下，你在吗"), true);
  assert.equal(shouldMarkPersona("夏柠柒，我今天创建了一个新习惯"), true);
  assert.equal(shouldMarkPersona("夏柠柒，我想更新一下我的近况，跟你说说今天的事"), true);
  // Baselines still mark.
  assert.equal(shouldMarkPersona("夏柠柒，在吗"), true);
  assert.equal(shouldMarkPersona("柠柒，我回来了"), true);
  // A question that happens to contain 版本 also marks.
  assert.equal(shouldMarkPersona("夏柠柒，你是什么版本"), true);
});

check("0.5.0 step 2: task-shaped action words still do NOT mark", () => {
  // Imperative + action word = instruction.
  assert.equal(shouldMarkPersona("夏柠柒，帮我更新一下你的记忆"), false);
  assert.equal(shouldMarkPersona("夏柠柒，把测试跑一下"), false);
  // Bare task phrase (trigger + action word, nothing chatty left).
  assert.equal(shouldMarkPersona("夏柠柒，更新一下"), false);
  assert.equal(shouldMarkPersona("夏柠柒，恢复测试"), false);
  // Technical words still block on their own.
  assert.equal(shouldMarkPersona("夏柠柒的 SKILL.md 改一下"), false);
  assert.equal(shouldMarkPersona("夏柠柒，GitHub 上那个仓库推一下"), false);
  // 0.5.0 fix (P0): action word + memory object is a task even when
  // the ≤2-char bare rule would miss it (0.4.8 blocked all of these).
  assert.equal(shouldMarkPersona("夏柠柒，更新一下记忆"), false);
  assert.equal(shouldMarkPersona("夏柠柒，同步一下记忆"), false);
  assert.equal(shouldMarkPersona("夏柠柒，删除这条记忆"), false);
  assert.equal(shouldMarkPersona("夏柠柒，测试一下记忆"), false);
  assert.equal(shouldMarkPersona("夏柠柒，创建一条记忆"), false);
  // Chatty context still marks.
  assert.equal(shouldMarkPersona("夏柠柒，更新一下记忆，我想你"), true);
  // Narrative "你让我..." is not an imperative.
  assert.equal(shouldMarkPersona("夏柠柒，你让我更新一下心情"), true);
  // Split helpers agree with the gate.
  assert.equal(hasTaskTechnicalWord("这段代码跑不起来"), true);
  assert.equal(hasTaskTechnicalWord("夏柠柒，在吗"), false);
  assert.equal(hasTaskActionWord("我想同步一下近况"), true);
  assert.equal(hasTaskActionWord("夏柠柒，在吗"), false);
  assert.equal(isBareTaskPhrase("夏柠柒，恢复测试"), true);
  assert.equal(isBareTaskPhrase("夏柠柒，测试一下，你在吗"), false);
  assert.equal(isBareTaskPhrase("夏柠柒，我想和你同步一下近况"), false);
  // The raw union check is unchanged (old callers see the same).
  assert.equal(hasTaskBlocklistWord("帮我更新一下"), true);
  assert.equal(hasTaskBlocklistWord("夏柠柒，在吗"), false);
});

check("plugin exports name/inject/apply", () => {
  assert.equal(name, "memory-plugin");
  assert.deepEqual(inject, ["tools", "systemPrompt"]);
  assert.equal(typeof apply, "function");
});

check("trigger words match the skill's substring rule", () => {
  assert.equal(isPersonaTrigger("夏柠柒，今天好吗"), true);
  assert.equal(isPersonaTrigger("柠柒在吗"), true);
  assert.equal(isPersonaTrigger("帮我写个脚本"), false);
});

check("0.3.1 blocklist: trigger + task word does not mark, trigger alone does", () => {
  // Trigger alone marks.
  assert.equal(shouldMarkPersona("夏柠柒，在吗"), true);
  assert.equal(shouldMarkPersona("柠柒，今天好吗"), true);
  // Trigger + task-action word does not mark.
  assert.equal(shouldMarkPersona("帮我把夏柠柒的 skill 更新一下"), false);
  assert.equal(shouldMarkPersona("把夏柠柒的插件升级一下"), false);
  assert.equal(shouldMarkPersona("夏柠柒，帮我把那个 skill 安装一下"), false);
  assert.equal(shouldMarkPersona("夏柠柒，恢复测试"), false);
  // Trigger + technical word does not mark.
  assert.equal(shouldMarkPersona("夏柠柒的 SKILL.md 改一下"), false);
  assert.equal(shouldMarkPersona("把夏柠柒的记忆插件更新到 v0.3.1"), false);
  assert.equal(shouldMarkPersona("夏柠柒，GitHub 上那个仓库推一下"), false);
  // No trigger at all still does not mark.
  assert.equal(shouldMarkPersona("帮我把 skill 更新一下"), false);
  assert.equal(shouldMarkPersona("你好"), false);
  // Blocklist helper itself.
  assert.equal(hasTaskBlocklistWord("帮我更新一下"), true);
  assert.equal(hasTaskBlocklistWord("夏柠柒，在吗"), false);
  assert.equal(hasTaskBlocklistWord("这段代码跑不起来"), true);
  // isPersonaTrigger itself is unchanged (raw substring rule).
  assert.equal(isPersonaTrigger("帮我把夏柠柒的 skill 更新一下"), true);
});

check("0.2.0 parseEmotion: '温暖' / '温暖:0.7' parse, garbage means 'not passed'", () => {
  assert.deepEqual(parseEmotion("温暖"), { type: "温暖", intensity: 0.5 });
  assert.deepEqual(parseEmotion("温暖:0.7"), { type: "温暖", intensity: 0.7 });
  assert.deepEqual(parseEmotion("温暖：0.9"), { type: "温暖", intensity: 0.9 });
  assert.deepEqual(parseEmotion("温暖:2"), { type: "温暖", intensity: 1 });
  assert.equal(parseEmotion("温暖:abc"), undefined);
  assert.equal(parseEmotion(""), undefined);
  assert.equal(parseEmotion(undefined), undefined);
  assert.equal(parseEmotion(123), undefined);
});

const ctx = new MockContext(dir);
apply(ctx as never, { dataDir: dir } as never);
await sleep(50); // async defineTool load + tool registration

/** A pre-step decision the way real DSH 0.2.1 dispatches it: the
 *  agent (with its scoped ctx) is fused into the payload; there is
 *  NO sessionId field (audit m9). */
const decision = (id: string, content: string): Record<string, unknown> => ({
  agent: { id, ctx: ctx.agentCtx(id) },
  messages: [{ role: "user", content, source: { kind: "user" } }],
});

// Regression: apply must never touch ctx.config. In real DSH that
// property does not exist and reading it throws (2026-11-05, live
// DSH 0.2.1-rc.5: plugin failed to activate). A Proxy that throws on
// any config access proves the plugin only reads the 2nd argument.
const strictDir = mkdtempSync(join(tmpdir(), "memory-plugin-strict-"));
const strictCtx = new MockContext(strictDir);
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

check("apply never reads ctx.config (real-DSH regression)", () => {
  apply(strictProxy as never, { dataDir: strictDir } as never);
});

check("registers directives section and all seventeen tools (compiled JSON Schema)", () => {
  assert.ok(
    ctx.sections.some((s) => s.name === "memory-plugin:directives"),
  );
  const names = ctx.registeredTools.map((t) => t.name as string);
  for (const n of [
    "memory_profile",
    "memory_search",
    "memory_remember",
    "memory_fragment",
    "memory_daily_review",
    "memory_snapshot",
    "memory_restore",
    "memory_status",
    "memory_starmap",
    "memory_invalidate",
    "memory_belief",
    "memory_reflect",
    "memory_proact",
    "memory_feedback",
    "memory_forget",
    "memory_goal",
    "memory_experience",
  ]) {
    assert.ok(names.includes(n), `tool ${n} registered`);
  }
  // Audit M2: parameters must be real JSON Schema, not the raw DSL map.
  for (const t of ctx.registeredTools) {
    const p = t.parameters as {
      type?: string;
      properties?: unknown;
      required?: unknown;
    };
    assert.equal(p?.type, "object", `${t.name} parameters.type is object`);
    assert.equal(
      typeof p?.properties,
      "object",
      `${t.name} parameters.properties is an object`,
    );
  }
  const search = ctx.registeredTools.find((t) => t.name === "memory_search");
  assert.deepEqual(
    (search?.parameters as { required?: string[] }).required,
    ["query"],
  );
  const remember = ctx.registeredTools.find(
    (t) => t.name === "memory_remember",
  );
  assert.deepEqual(
    (remember?.parameters as { required?: string[] }).required,
    ["text"],
  );
  const fragment = ctx.registeredTools.find(
    (t) => t.name === "memory_fragment",
  );
  assert.deepEqual(
    (fragment?.parameters as { required?: string[] }).required,
    ["sourceIds", "text", "tone", "quotes"],
  );
  // The shell self-checks via ctx.tools.get: the registered copy must
  // also carry a legal schema.
  const viaGet = ctx.tools.get("memory_search") as {
    parameters?: { type?: string };
  };
  assert.equal(viaGet?.parameters?.type, "object");
  assert.equal(ctx.disposers.length, 1);
});

check("memory_remember description lists the 20 importance categories (new layer 2)", () => {
  const remember = ctx.registeredTools.find(
    (t) => t.name === "memory_remember",
  ) as { description?: string };
  assert.ok(
    remember?.description?.includes("情绪"),
    "first category listed",
  );
  assert.ok(
    remember?.description?.includes("学习工作"),
    "last category listed",
  );
  assert.ok(
    remember?.description?.includes("生日纪念日"),
    "a middle category listed",
  );
});

check("no tools/pre-execute veto listener (cut by design correction)", () => {
  assert.equal(ctx.handlers.has("tools/pre-execute"), false);
  assert.equal(ctx.preStep?.opts?.prepend, true);
});

// ---- persona session s1 ----------------------------------------------
await ctx.emit("agent/created", { agent: { id: "s1" } });
const d1 = decision("s1", "夏柠柒，今天好吗");
await ctx.emit("agent/pre-step", d1);
await ctx.emit("session/event", {
  type: "user/message",
  sessionId: "s1",
  source: { kind: "user" },
  message: {
    content: "夏柠柒，今天好吗",
    source: { kind: "user" },
  },
});
await ctx.emit("session/event", {
  type: "assistant/message",
  sessionId: "s1",
  message: { content: "好呀" },
});

check("persona session messages are recorded", () => {
  assert.equal(logCount(), 2);
});

// ---- review-9 m-6: task agent/created does not run the review -----
// At agent/created a fresh session has said no trigger word yet, so
// it cannot be told apart from a task session — the review must not
// run here. Nothing has run a review yet, so review.json must not
// exist at all after a task session start.
await ctx.emit("agent/created", { agent: { id: "s-task-review" } });
check("m-6: task agent/created does not run the review", () => {
  assert.equal(
    existsSync(join(dir, "review.json")),
    false,
    "no review.json from a task session start",
  );
});

// ---- 0.2.0: daily review runs once at agent/created when due ------
// s1 is persona now (persisted), so a re-created s1 is a restored
// persona session and the review runs; a second start inside the
// 24 h window must skip it (totalReviews unchanged).
const readReviewState = (d: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(d, "review.json"), "utf8")) as Record<
    string,
    unknown
  >;

await ctx.emit("agent/created", { agent: { id: "s1" } });
check("0.2.0: agent/created runs the daily review when due", () => {
  assert.ok(existsSync(join(dir, "review.json")), "review.json written");
  const state = readReviewState(dir);
  assert.equal(state.totalReviews, 1, "exactly one review ran");
  assert.equal(typeof state.lastReviewedAt, "number");
  assert.ok((state.lastReviewedAt as number) > 0);
  assert.ok(existsSync(join(dir, "starmap.html")), "review regenerated the starmap");
});

await ctx.emit("agent/created", { agent: { id: "s1" } });
check("0.2.0: agent/created skips the review when not due (< 24 h)", () => {
  assert.equal(readReviewState(dir).totalReviews, 1, "no second review");
});

// ---- task session s2 (no trigger) ------------------------------------
await ctx.emit("agent/created", { agent: { id: "s2" } });
const d2 = decision("s2", "帮我写个脚本");
await ctx.emit("agent/pre-step", d2);
await ctx.emit("session/event", {
  type: "user/message",
  sessionId: "s2",
  source: { kind: "user" },
  message: { content: "帮我写个脚本", source: { kind: "user" } },
});
await ctx.emit("session/event", {
  type: "assistant/message",
  sessionId: "s2",
  message: { content: "写好了" },
});

check("task session messages are NOT recorded", () => {
  assert.equal(logCount(), 2);
});

// ---- keyword memory, then turn-1 / turn-2 injection ------------------
await ctx.emit("session/event", {
  type: "user/message",
  sessionId: "s1",
  source: { kind: "user" },
  message: { content: "以后每周五查岗", source: { kind: "user" } },
});
assert.equal(logCount(), 3);

await ctx.emit("agent/created", { agent: { id: "s3" } });
const d3 = decision("s3", "夏柠柒，查岗的事还记得吗");
await ctx.emit("agent/pre-step", d3);
const d3messages = d3.messages as Array<Record<string, unknown>>;

check("turn 1 appends recall to decision.messages (UUID id + array content)", () => {
  assert.equal(d3messages.length, 2);
  const injected = d3messages[1];
  assert.equal(
    (injected.source as { kind: string }).kind,
    "memory-plugin",
  );
  // Audit m10: a real DSH message has an id and array content, not a
  // bare string with no id.
  assert.equal(typeof injected.id, "string");
  assert.ok((injected.id as string).length > 0);
  assert.ok(Array.isArray(injected.content));
  const text = (injected.content as Array<{ text: string }>)[0].text;
  assert.ok(text.includes("查岗"));
});

check("turn 1 registers no recall context: the append already carries it (m16)", () => {
  const rec = ctx
    .agentCtx("s3")
    .contexts.filter((c) => c.name === "memory-plugin:recall");
  assert.equal(rec.length, 0, "appended hits are not re-registered as context");
});

const d4 = decision("s3", "你还记得好呀吗");
await ctx.emit("agent/pre-step", d4);
const d4messages = d4.messages as Array<Record<string, unknown>>;

check("turn 2 does NOT append again; fresh hits register as context (cue-gated mid-turn recall)", () => {
  assert.equal(d4messages.length, 1);
  const rec = ctx
    .agentCtx("s3")
    .contexts.filter((c) => c.name === "memory-plugin:recall");
  assert.equal(rec.length, 1, "one context registered on turn 2");
  assert.ok(rec[0].text.includes("好呀"), "fresh hit (not in the turn-1 append) is the context");
});

const d4b = decision("s3", "你还记得好呀吗");
await ctx.emit("agent/pre-step", d4b);

check("turn 3 refreshes the context (old disposed)", () => {
  const rec = ctx
    .agentCtx("s3")
    .contexts.filter((c) => c.name === "memory-plugin:recall");
  assert.equal(rec.length, 2, "context refreshed on turn 3");
  assert.equal(rec[0].disposed, true, "old context disposed");
  assert.ok(rec[1].text.includes("好呀"));
});

// ---- 0.4.0 item 4: profile block rides with the recall injection ---
check("0.4.0 item 4: turn-1 append starts with the profile block", () => {
  const text = (d3messages[1].content as Array<{ text: string }>)[0].text;
  assert.ok(
    text.startsWith("她：夏柠柒\n阶段：1"),
    "profile block is the head of the turn-1 append",
  );
  assert.ok(text.includes("查岗"), "recall text follows the profile block");
});

check("0.4.0 item 4: refreshed context starts with the profile block", () => {
  const rec = ctx
    .agentCtx("s3")
    .contexts.filter((c) => c.name === "memory-plugin:recall");
  assert.ok(
    rec[1].text.startsWith("她：夏柠柒\n阶段：1"),
    "profile block is the head of the refreshed context",
  );
});

const noneDir = mkdtempSync(join(tmpdir(), "memory-plugin-profile-none-"));
writeFileSync(join(noneDir, "MEMORY.md"), fixtureMemory, "utf8");
const noneCtx = new MockContext(noneDir);
apply(noneCtx as never, { dataDir: noneDir } as never);
await sleep(50); // tools register async (loadDefineTool)
const dNone = {
  agent: { id: "s-none", ctx: noneCtx.agentCtx("s-none") },
  messages: [
    {
      role: "user",
      content: "夏柠柒，量子纠缠实验怎么做",
      source: { kind: "user" },
    },
  ],
};
await noneCtx.emit("agent/pre-step", dNone);

check("0.4.0 item 4: no hits means no injection — the profile never leaks on its own", () => {
  assert.equal(
    (dNone.messages as unknown[]).length,
    1,
    "nothing appended without hits",
  );
  const rec = noneCtx
    .agentCtx("s-none")
    .contexts.filter((c) => c.name === "memory-plugin:recall");
  assert.equal(
    rec.length,
    0,
    "no recall context without hits — profile does not inject alone",
  );
});

// ---- restrained mid-turn trigger (0.3.0) ---------------------------
// Turn 2+ injects ONLY when the user explicitly reaches for the
// past (a memory-cue substring) or the words touch a
// high-significance memory. No number cap, no extra token cap —
// the recall's own valve (top 5, max 2/topic) still selects, and
// the model decides how many of the injected memories to mention.
// Isolated data dir + context so the seeded entries are exactly
// the ones these checks reason about.
const midDir = mkdtempSync(join(tmpdir(), "memory-plugin-mid-"));
writeFileSync(join(midDir, "MEMORY.md"), fixtureMemory, "utf8");
const midCtx = new MockContext(midDir);
apply(midCtx as never, { dataDir: midDir } as never);
await sleep(50); // tools register async (loadDefineTool)
const midRemember = midCtx.registeredTools.find(
  (t) => t.name === "memory_remember",
) as {
  execute: (args: unknown, exec?: unknown) => Promise<Record<string, unknown>>;
};

const midDecision = (
  id: string,
  content: string,
): Record<string, unknown> => ({
  agent: { id, ctx: midCtx.agentCtx(id) },
  messages: [{ role: "user", content, source: { kind: "user" } }],
});
const midLiveContexts = (id: string) =>
  midCtx
    .agentCtx(id)
    .contexts.filter(
      (c) => c.name === "memory-plugin:recall" && !c.disposed,
    );

await midCtx.emit("agent/created", { agent: { id: "m1" } });
await midCtx.emit("agent/pre-step", midDecision("m1", "夏柠柒，在吗"));
// Seed: one HIGH-significance memory (heavy at record time -> 0.9)
// and one light-only memory (0.4). The heavy one is recorded via
// memory_remember: a bare "我保证..." line is light 0.4 now that
// the signal-word list is gone — only the importance param (or a
// later promotion / model mark) makes a memory significant.
const heavySeed = await midRemember.execute(
  { text: "我保证以后每天都陪你去散步", importance: "heavy" },
  { agent: { session: { id: "m1" } } },
);
assert.equal(heavySeed.ok, true, "heavy seed recorded");
await midCtx.emit("session/event", {
  type: "user/message",
  sessionId: "m1",
  source: { kind: "user" },
  message: { content: "今天中午吃了拉面", source: { kind: "user" } },
});

const mOrd = midDecision("m1", "拉面好吃吗");
await midCtx.emit("agent/pre-step", mOrd);
check("mid-turn: ordinary message with a light-only keyword match injects nothing", () => {
  assert.equal(midLiveContexts("m1").length, 0, "no recall context on an ordinary turn");
  assert.equal(
    (mOrd.messages as unknown[]).length,
    1,
    "no append on turn 2",
  );
});

const mCue = midDecision("m1", "你还记得拉面那次吗");
await midCtx.emit("agent/pre-step", mCue);
check("mid-turn: explicit memory cue triggers recall", () => {
  const live = midLiveContexts("m1");
  assert.equal(live.length, 1, "one recall context on a cue turn");
  assert.ok(live[0].text.includes("拉面"), "the matched light memory is the context");
});

const mHeavy = midDecision("m1", "去散步吗");
await midCtx.emit("agent/pre-step", mHeavy);
check("mid-turn: high-significance keyword match triggers recall (no cue)", () => {
  const all = midCtx
    .agentCtx("m1")
    .contexts.filter((c) => c.name === "memory-plugin:recall");
  assert.equal(all.length, 2, "context refreshed, not accumulated");
  assert.equal(all[0].disposed, true, "old cue-turn context disposed");
  const live = midLiveContexts("m1");
  assert.equal(live.length, 1, "one live context after refresh");
  assert.ok(live[0].text.includes("散步"), "the high-significance memory is the context");
});

// Dedup: a memory already injected at session start (turn-1 append)
// is never re-injected as dynamic context on a later turn.
await midCtx.emit("agent/created", { agent: { id: "m2" } });
const m2t1 = midDecision("m2", "夏柠柒，散步吗");
await midCtx.emit("agent/pre-step", m2t1);
check("mid-turn dedup setup: turn 1 appends the high-significance memory", () => {
  const msgs = m2t1.messages as Array<Record<string, unknown>>;
  assert.equal(msgs.length, 2, "turn 1 appends");
  const text = (msgs[1].content as Array<{ text: string }>)[0].text;
  assert.ok(text.includes("散步"), "the append carries the 散步 memory");
});
const m2t2 = midDecision("m2", "你还记得散步吗");
await midCtx.emit("agent/pre-step", m2t2);
check("mid-turn dedup: turn-1-appended memory is not re-injected as context", () => {
  assert.equal(
    midLiveContexts("m2").length,
    0,
    "appended hit stays out of the dynamic context",
  );
  assert.equal(
    (m2t2.messages as unknown[]).length,
    1,
    "no append on turn 2",
  );
});
for (const dispose of midCtx.disposers) dispose();

// ---- two messages before turn 1 recall on both (m17) -----------------
await ctx.emit("agent/created", { agent: { id: "s-m17" } });
const dM17: Record<string, unknown> = {
  agent: { id: "s-m17", ctx: ctx.agentCtx("s-m17") },
  messages: [
    { role: "user", content: "夏柠柒", source: { kind: "user" } },
    { role: "user", content: "好呀是什么意思", source: { kind: "user" } },
  ],
};
await ctx.emit("agent/pre-step", dM17);
const dM17messages = dM17.messages as Array<Record<string, unknown>>;

check("m17: two messages before turn 1 recall on both (joined query)", () => {
  assert.equal(dM17messages.length, 3, "turn 1 appends (2 original + 1 injected)");
  const text = (dM17messages[2].content as Array<{ text: string }>)[0].text;
  assert.ok(text.includes("好呀"), "second message's keywords recalled");
});

// ---- injected messages are never re-recorded -------------------------
await ctx.emit("session/event", {
  type: "user/message",
  sessionId: "s3",
  source: { kind: "memory-plugin" },
  message: {
    content: d3messages[1].content,
    source: { kind: "memory-plugin" },
  },
});

check("plugin-injected messages are not re-recorded", () => {
  assert.equal(logCount(), 3);
});

// ---- flush points + snapshots actually run (M5) ----------------------
await ctx.emit("session/event", {
  type: "compaction/start",
  sessionId: "s1",
});
await ctx.emit("agent/turn-stopping", { sessionId: "s1" });

check("compaction/start flushes the index AND takes a snapshot (M5)", () => {
  assert.ok(existsSync(join(dir, "index.json")));
  const snaps = readdirSync(join(dir, ".snapshots"));
  assert.ok(snaps.length >= 1, "a snapshot was taken on compaction");
});

// ---- fallback tools ----------------------------------------------------
const searchTool = ctx.registeredTools.find(
  (t) => t.name === "memory_search",
) as unknown as {
  execute: (args: Record<string, unknown>) => Promise<{
    layer1: string;
    hits: Array<Record<string, unknown>>;
  }>;
};
const rememberTool = ctx.registeredTools.find(
  (t) => t.name === "memory_remember",
) as unknown as {
  execute: (
    args: Record<string, unknown>,
    exec?: unknown,
  ) => Promise<{
    ok: boolean;
    id: string;
  }>;
};
const snapshotTool = ctx.registeredTools.find(
  (t) => t.name === "memory_snapshot",
) as unknown as {
  execute: (args: Record<string, unknown>) => Promise<{
    ok: boolean;
    snapshot?: string;
  }>;
};
const restoreTool = ctx.registeredTools.find(
  (t) => t.name === "memory_restore",
) as unknown as {
  execute: (args: Record<string, unknown>) => Promise<{
    ok: boolean;
    safety?: string;
  }>;
};
const statusTool = ctx.registeredTools.find(
  (t) => t.name === "memory_status",
) as unknown as {
  execute: (args: Record<string, unknown>) => Promise<{
    ok: boolean;
    totalEntries?: number;
    snapshots?: unknown;
  }>;
};

const searchResult = await searchTool.execute({ query: "查岗" });
check("memory_search tool returns hits + layer 1", () => {
  assert.ok(searchResult.hits.some((h) => (h.text as string).includes("查岗")));
  assert.ok(searchResult.layer1.includes("阶段"));
  // M-1 (review-12): every hit must carry its log entry id, or the
  // model has no id to hand to memory_fragment.
  assert.ok(searchResult.hits.length > 0, "hits exist to check");
  assert.ok(
    searchResult.hits.every(
      (h) => typeof h.id === "string" && (h.id as string).length > 0,
    ),
    `every hit carries a log entry id: ${JSON.stringify(searchResult.hits)}`,
  );
});

check("0.5.0 step 3: memory_search hits carry provenance (sourceId / type / confidence / verification)", () => {
  assert.ok(searchResult.hits.length > 0, "hits exist to check");
  for (const h of searchResult.hits) {
    // Source ids always resolve to this hit's own log entry for a
    // verbatim hit (fragment-backed hits carry the fragment's).
    assert.ok(Array.isArray(h.sourceIds), "sourceIds present");
    assert.ok(
      (h.sourceIds as string[]).length > 0,
      "sourceIds non-empty",
    );
    assert.ok(
      typeof h.sourceType === "string" && (h.sourceType as string).length > 0,
      "sourceType present",
    );
    assert.ok(
      typeof h.sourceTypeCn === "string" && (h.sourceTypeCn as string).length > 0,
      "sourceTypeCn present",
    );
    assert.ok(
      h.confidence === null || typeof h.confidence === "number",
      "confidence is a number or null (never a model-written string)",
    );
    assert.ok(typeof h.verifyCount === "number", "verifyCount present");
    assert.ok(
      h.lastVerifiedAt === null || typeof h.lastVerifiedAt === "number",
      "lastVerifiedAt is a timestamp or null",
    );
    assert.ok(
      typeof h.sourceSummary === "string" &&
        (h.sourceSummary as string).includes(h.date as string),
      `sourceSummary carries the date: ${h.sourceSummary}`,
    );
  }
  // The 查岗 hits are verbatim user lines: user_quote, 0.9, never verified.
  const first = searchResult.hits[0];
  assert.equal(first.sourceType, "user_quote");
  assert.equal(first.sourceTypeCn, "用户原话");
  assert.equal(first.confidence, 0.9);
  assert.equal(first.verifyCount, 0);
  assert.equal(first.lastVerifiedAt, null);
  assert.ok(
    (first.sourceSummary as string).includes("用户原话"),
    `sourceSummary names the kind: ${first.sourceSummary}`,
  );
});

const remembered = await rememberTool.execute({
  text: "记住：她喜欢银口琴",
  importance: "heavy",
});
check("memory_remember tool records a heavy entry", () => {
  assert.equal(remembered.ok, true);
  assert.ok(typeof remembered.id === "string");
  assert.equal(logCount(), 4);
});

const snapRes = await snapshotTool.execute({});
check("memory_snapshot takes a snapshot (M5/M12: wired, not dead code)", () => {
  assert.equal(snapRes.ok, true);
  assert.ok(typeof snapRes.snapshot === "string");
});

const statusRes = await statusTool.execute({});
check("memory_status returns stats (M12: wired, not dead code)", () => {
  assert.equal(statusRes.ok, true);
  assert.ok((statusRes.totalEntries as number) >= 1);
  assert.ok(Array.isArray(statusRes.snapshots));
});

const restoreBad = await restoreTool.execute({ name: "no-such-snapshot" });
check("memory_restore with an unknown name refuses", () => {
  assert.equal(restoreBad.ok, false);
});

const restoreTraversal = await restoreTool.execute({ name: "../escape" });
check("minor 3: memory_restore rejects path-traversal names", () => {
  assert.equal(restoreTraversal.ok, false);
});
const restoreSlash = await restoreTool.execute({ name: "a/b" });
check("minor 3: memory_restore rejects names containing /", () => {
  assert.equal(restoreSlash.ok, false);
});
const restoreBackslash = await restoreTool.execute({ name: "a\\b" });
check("minor 3: memory_restore rejects names containing \\", () => {
  assert.equal(restoreBackslash.ok, false);
});

// ---- 0.4.1 item 1: memory_profile (profile.json write path) --------
// Isolated data dir + context, like the noneDir/midDir sections: the
// profile write must not disturb the main dir's later checks (log
// counts, snapshots, MEMORY.md bytes).
const profDir = mkdtempSync(join(tmpdir(), "memory-plugin-profile-"));
writeFileSync(join(profDir, "MEMORY.md"), fixtureMemory, "utf8");
const profMemoryBefore = readFileSync(join(profDir, "MEMORY.md"), "utf8");
const profCtx = new MockContext(profDir);
apply(profCtx as never, { dataDir: profDir } as never);
await sleep(50); // tools register async (loadDefineTool)
const profDecision = (
  id: string,
  content: string,
): Record<string, unknown> => ({
  agent: { id, ctx: profCtx.agentCtx(id) },
  messages: [{ role: "user", content, source: { kind: "user" } }],
});
const profTool = profCtx.registeredTools.find(
  (t) => t.name === "memory_profile",
) as unknown as {
  execute: (
    args: Record<string, unknown>,
    exec?: unknown,
  ) => Promise<{
    ok: boolean;
    profile?: Record<string, unknown>;
    profileText?: string;
    error?: string;
  }>;
};

// s-prof goes persona (trigger word in the turn-1 pre-step), then
// records one turn so log.jsonl exists before the profile write —
// the write must leave both the log and MEMORY.md byte-identical.
await profCtx.emit("agent/created", { agent: { id: "s-prof" } });
await profCtx.emit("agent/pre-step", profDecision("s-prof", "夏柠柒，在吗"));
await profCtx.emit("session/event", {
  type: "user/message",
  sessionId: "s-prof",
  source: { kind: "user" },
  message: {
    content: "夏柠柒，今天好吗",
    source: { kind: "user" },
  },
});

const profLogBefore = readFileSync(join(profDir, "log.jsonl"), "utf8");
const profWritten = await profTool.execute(
  { name: "夏柠柒", stage: "稳定期", relationshipStage: "熟悉陪伴" },
  { agent: { session: { id: "s-prof" } } },
);
check("0.4.1 item 1: memory_profile writes then reads back the same profile (persona window)", () => {
  assert.equal(profWritten.ok, true);
  assert.equal(profWritten.profile?.name, "夏柠柒");
  assert.equal(profWritten.profile?.stage, "稳定期");
  assert.equal(profWritten.profile?.relationshipStage, "熟悉陪伴");
  assert.ok(
    typeof profWritten.profile?.updatedAt === "number",
    "write stamps updatedAt",
  );
  assert.ok(
    profWritten.profileText?.includes("阶段：稳定期"),
    "read-back block shows the new stage",
  );
  assert.ok(
    profWritten.profileText?.includes("关系：熟悉陪伴"),
    "read-back block shows the new relationship",
  );
  assert.ok(
    profWritten.profileText?.includes("喜欢：银口琴"),
    "likes still come from layer 1",
  );
  assert.ok(
    (profWritten.profileText?.split("\n").length ?? 99) <= 5,
    "block stays within B's 5 lines",
  );
  // The file on disk is the same profile the tool returned.
  const onDisk = JSON.parse(
    readFileSync(join(profDir, "profile.json"), "utf8"),
  ) as Record<string, unknown>;
  assert.equal(onDisk.name, "夏柠柒");
  assert.equal(onDisk.stage, "稳定期");
  assert.equal(onDisk.relationshipStage, "熟悉陪伴");
  assert.equal(
    onDisk.updatedAt,
    profWritten.profile?.updatedAt,
    "disk and read-back agree on updatedAt",
  );
  // The write touched neither the append-only log nor MEMORY.md.
  assert.equal(
    readFileSync(join(profDir, "log.jsonl"), "utf8"),
    profLogBefore,
    "profile write never edits the log",
  );
  assert.equal(
    readFileSync(join(profDir, "MEMORY.md"), "utf8"),
    profMemoryBefore,
    "profile write never edits MEMORY.md",
  );
});

// A partial update merges over the stored profile (untouched fields
// survive), and a read-only call ({}) returns the current profile
// without writing anything.
const profJsonBeforePartial = readFileSync(
  join(profDir, "profile.json"),
  "utf8",
);
const profPartial = await profTool.execute(
  { stage: "中期" },
  { agent: { session: { id: "s-prof" } } },
);
const profReadBack = await profTool.execute(
  {},
  { agent: { session: { id: "s-prof" } } },
);
check("0.4.1 item 1: memory_profile partial update merges over the stored profile", () => {
  assert.equal(profPartial.ok, true);
  assert.equal(profPartial.profile?.name, "夏柠柒", "name survives a partial update");
  assert.equal(profPartial.profile?.stage, "中期", "stage is updated");
  assert.equal(
    profPartial.profile?.relationshipStage,
    "熟悉陪伴",
    "relationship survives a partial update",
  );
  assert.ok(
    profPartial.profileText?.includes("阶段：中期"),
    "read-back block shows the merged stage",
  );
  assert.equal(profReadBack.ok, true);
  assert.equal(profReadBack.profile?.stage, "中期", "read-back sees the merged stage");
  assert.equal(
    profReadBack.profileText,
    profPartial.profileText,
    "read-back block is identical to the update's",
  );
  assert.notEqual(
    readFileSync(join(profDir, "profile.json"), "utf8"),
    profJsonBeforePartial,
    "the partial update did write (sanity: bytes changed)",
  );
});

const profJsonBeforeReadOnly = readFileSync(
  join(profDir, "profile.json"),
  "utf8",
);
const profReadOnly = await profTool.execute(
  {},
  { agent: { session: { id: "s-prof" } } },
);
check("0.4.1 item 1: memory_profile read-only call returns the profile and leaves the file alone", () => {
  assert.equal(profReadOnly.ok, true);
  assert.equal(profReadOnly.profile?.stage, "中期");
  assert.equal(
    readFileSync(join(profDir, "profile.json"), "utf8"),
    profJsonBeforeReadOnly,
    "a {} call writes nothing to profile.json",
  );
});

const profTask = await profTool.execute(
  { name: "不应写入" },
  { agent: { session: { id: "s-task" } } },
);
check("0.4.1 item 1: memory_profile refuses in a task window", () => {
  assert.equal(profTask.ok, false);
  assert.ok(profTask.error?.includes("人设窗口"));
  assert.ok(
    !readFileSync(join(profDir, "profile.json"), "utf8").includes("不应写入"),
    "task-window call writes nothing",
  );
});

const profJsonBeforeBad = readFileSync(join(profDir, "profile.json"), "utf8");
const profBad = await profTool.execute(
  { name: 123 },
  { agent: { session: { id: "s-prof" } } },
);
check("0.4.1 item 1: memory_profile rejects a non-string field, writes nothing", () => {
  assert.equal(profBad.ok, false);
  assert.ok(profBad.error?.includes("profile_fields_must_be_strings"));
  assert.equal(
    readFileSync(join(profDir, "profile.json"), "utf8"),
    profJsonBeforeBad,
    "a rejected call writes nothing",
  );
});

// Regression lock (the A always-on bug, at the injection level): a
// profile.json profile exists, but a turn with no recall hits still
// injects nothing — no append, no recall context. Separate dir with
// the profile seeded as a fixture (like MEMORY.md above), so the
// lock does not depend on the tool calls above.
const profNoneDir = mkdtempSync(join(tmpdir(), "memory-plugin-profile-none-"));
writeFileSync(join(profNoneDir, "MEMORY.md"), fixtureMemory, "utf8");
writeFileSync(
  join(profNoneDir, "profile.json"),
  JSON.stringify({ name: "夏柠柒", stage: "稳定期", relationshipStage: "熟悉陪伴" }),
  "utf8",
);
const profNoneCtx = new MockContext(profNoneDir);
apply(profNoneCtx as never, { dataDir: profNoneDir } as never);
await sleep(50); // tools register async (loadDefineTool)
const dProfNone = {
  agent: { id: "s-prof-none", ctx: profNoneCtx.agentCtx("s-prof-none") },
  messages: [
    {
      role: "user",
      content: "夏柠柒，量子纠缠实验怎么做",
      source: { kind: "user" },
    },
  ],
};
await profNoneCtx.emit("agent/pre-step", dProfNone);
check("0.4.1 item 1 (regression lock): profile.json present + no hits → still no injection", () => {
  assert.equal(
    (dProfNone.messages as unknown[]).length,
    1,
    "nothing appended without hits, profile or not",
  );
  const rec = profNoneCtx
    .agentCtx("s-prof-none")
    .contexts.filter((c) => c.name === "memory-plugin:recall");
  assert.equal(
    rec.length,
    0,
    "no recall context without hits — the profile never leaks on its own",
  );
});

// ---- task window: no recall injection, memory_remember refused -----
// (audit issues 4 + 5). The current turn switches to the task session
// s4 here; the persona remember test above already ran with s3.
await ctx.emit("agent/created", { agent: { id: "s4" } });
const contextsBeforeTask = ctx.agentCtx("s4").contexts.length;
const dTask = decision("s4", "查岗的事");
await ctx.emit("agent/pre-step", dTask);
const dTaskMessages = dTask.messages as Array<Record<string, unknown>>;

check("task-window pre-step injects nothing (even with keyword hits)", () => {
  assert.equal(dTaskMessages.length, 1, "no recall appended");
  assert.equal(
    ctx.agentCtx("s4").contexts.length,
    contextsBeforeTask,
    "no recall context registered",
  );
});

await ctx.emit("agent/pre-step", decision("s4", "帮我写个脚本"));
const refused = await rememberTool.execute({
  text: "任务窗口偷偷写进来的东西",
  importance: "heavy",
});
check("memory_remember refuses in a task window", () => {
  assert.equal(
    (refused as unknown as { ok: boolean }).ok,
    false,
    "task-window call is refused, not recorded",
  );
  assert.equal(logCount(), 4);
});

// ---- pre-step with no user text does not consume turn 1 (minor i) ---
const contextsBeforeEmpty = ctx.agentCtx("s5").contexts.length;
await ctx.emit("agent/pre-step", {
  agent: { id: "s5", ctx: ctx.agentCtx("s5") },
  messages: [],
});

check("empty pre-step registers no recall context", () => {
  assert.equal(ctx.agentCtx("s5").contexts.length, contextsBeforeEmpty);
});

const d5 = decision("s5", "夏柠柒，查岗还记得吗");
await ctx.emit("agent/pre-step", d5);
const d5messages = d5.messages as Array<Record<string, unknown>>;

check("empty pre-step does not consume the turn-1 append slot", () => {
  assert.equal(d5messages.length, 2, "first real turn still appends");
  const text = (d5messages[1].content as Array<{ text: string }>)[0].text;
  assert.ok(text.includes("查岗"));
  assert.equal(
    ctx.agentCtx("s5").contexts.length,
    0,
    "turn-1 append covers all hits, no context (m16)",
  );
});

// ---- event-envelope tolerance (audit issue 3) ------------------------
// (a) user/message without source.kind: recorded (event type trusted),
//     with a warning instead of a silent drop.
await ctx.emit("session/event", {
  type: "user/message",
  sessionId: "s1",
  message: { content: "夏柠柒，没带 source 的一句话" },
});
check("user/message without source.kind is still recorded", () => {
  assert.equal(logCount(), 5);
});

// (b) user/message without any session id: never recorded — the event
//     gets a fresh ephemeral id and cannot be attributed to a session.
await ctx.emit("session/event", {
  type: "user/message",
  source: { kind: "user" },
  message: { content: "夏柠柒，没有会话 id", source: { kind: "user" } },
});
check("event without a session id is not recorded (fail closed)", () => {
  assert.equal(logCount(), 5);
});

// (c) event without a type: inferred from message.role.
await ctx.emit("session/event", {
  sessionId: "s1",
  source: { kind: "user" },
  message: {
    role: "user",
    content: "夏柠柒，没带 type 的一句话",
    source: { kind: "user" },
  },
});
check("event type is inferred from message.role when missing", () => {
  assert.equal(logCount(), 6);
});

// ---- session rebuild keeps persona (M7) ------------------------------
// Before 0.1.3 agent/created reset the flag unconditionally, so a
// reopened persona window's first half silently dropped out of the
// log until someone said the trigger again. Now the flag is restored
// from the persisted set.
await ctx.emit("agent/created", { agent: { id: "s1" } });
await ctx.emit("session/event", {
  type: "user/message",
  sessionId: "s1",
  source: { kind: "user" },
  message: { content: "重置后的一句话", source: { kind: "user" } },
});
check("re-created persona session keeps its flag (M7)", () => {
  assert.equal(logCount(), 7);
});

const dRebuilt = decision("s1", "查岗怎么说，你还记得吗");
await ctx.emit("agent/pre-step", dRebuilt);
const dRebuiltMessages = dRebuilt.messages as Array<Record<string, unknown>>;
check("rebuilt persona session does not re-append (history already has it)", () => {
  assert.equal(dRebuiltMessages.length, 1, "no second turn-1 append after rebuild");
  const rec = ctx
    .agentCtx("s1")
    .contexts.filter((c) => c.name === "memory-plugin:recall");
  assert.ok(rec.length >= 1, "context carries recall instead");
  assert.ok(rec[rec.length - 1].text.includes("查岗"));
});

// ---- 0.1.4 minor 1: appended ids survive a session rebuild --------
// s3's turn-1 append (d3 above) already put its hits into
// appendedIds; a rebuild used to clear that set, so the next turn
// re-registered the same hits as context (double injection).
const s3CtxBefore = ctx
  .agentCtx("s3")
  .contexts.filter((c) => c.name === "memory-plugin:recall").length;
await ctx.emit("agent/created", { agent: { id: "s3" } });
await ctx.emit("agent/pre-step", decision("s3", "夏柠柒，查岗的事还记得吗"));
check("minor 1: rebuilt session does not re-register turn-1 appended hits (appendedIds persisted)", () => {
  const rec = ctx
    .agentCtx("s3")
    .contexts.filter((c) => c.name === "memory-plugin:recall");
  // Two entries matching the query were recorded AFTER d3's turn-1
  // append ("没带 source" / "没带 type"), so exactly one new
  // context registers — carrying ONLY those fresh hits. If the
  // appended ids had been lost on rebuild, the already-appended
  // "以后每周五查岗" would be re-registered in it too.
  assert.equal(rec.length, s3CtxBefore + 1, "one new context for the fresh hits");
  const newest = rec[rec.length - 1];
  assert.ok(newest.text.includes("没带 source"), "fresh hit is in the new context");
  assert.ok(newest.text.includes("没带 type"), "fresh hit is in the new context");
  assert.ok(
    !newest.text.includes("以后每周五查岗"),
    "already-appended hit is NOT re-registered",
  );
  const appended = JSON.parse(
    readFileSync(join(dir, "appended-ids.json"), "utf8"),
  ) as Record<string, string[]>;
  assert.ok(Array.isArray(appended["s3"]), "appended-ids.json has s3");
  assert.ok(appended["s3"].length >= 1, "s3's appended ids persisted");
});

// ---- real DSH 0.2.1 envelope: (session, event), message in data ----
// (envelope fix 2026-11-06: the old single-arg assumption read the
// session object as the event, so nothing was ever attributed or
// recorded in real DSH. Also covers turn-1 trigger detection: the
// user/message event fires BEFORE pre-step sets persona, so the
// handler must detect the trigger itself or turn 1 is never recorded.)
await ctx.emit("session/event", { id: "s-real" }, {
  type: "user/message",
  data: {
    role: "user",
    content: "夏柠柒，真信封第一句",
    source: { kind: "user" },
  },
});
check("real 2-arg user/message is recorded (turn-1 trigger, no pre-step yet)", () => {
  assert.equal(logCount(), 8);
});
await ctx.emit("session/event", { id: "s-real" }, {
  type: "assistant/message",
  data: { role: "assistant", content: "真信封回一句" },
});
check("real 2-arg assistant/message is recorded", () => {
  assert.equal(logCount(), 9);
});
await ctx.emit("session/event", { id: "s-real-task" }, {
  type: "user/message",
  data: {
    role: "user",
    content: "没有触发词的一句",
    source: { kind: "user" },
  },
});
check("real 2-arg task message is NOT recorded", () => {
  assert.equal(logCount(), 9);
});

// ---- assistant settlement nests the message under data.message ------
// (0.1.2: real DSH appends assistant/message as {turn, step, message,
// usage, stream} — the old code read data.content, which is undefined
// there, so her words were silently skipped. Found 2026-11-06 from a
// real log that held only role:"user" entries.)
await ctx.emit("session/event", { id: "s-real" }, {
  type: "assistant/message",
  data: {
    turn: 1,
    step: 1,
    message: {
      role: "assistant",
      content: [{ type: "text", text: "嵌套里的一句" }],
      source: { provider: "deepseek", model: "deepseek-chat" },
    },
    stream: "stream-1",
  },
});
check("real assistant settlement (message nested in data.message) is recorded", () => {
  assert.equal(logCount(), 10);
});

// ---- content-level extraction (audit minors m5/m6/m7) ----------------
await ctx.emit("session/event", { id: "s-real" }, {
  type: "assistant/message",
  data: {
    turn: 2,
    step: 1,
    message: {
      role: "assistant",
      content: [
        { type: "reasoning", text: "她心里想的悄悄话" },
        { type: "text", text: "说出来的话" },
      ],
      source: { provider: "deepseek", model: "deepseek-chat" },
    },
    stream: "stream-2",
  },
});
check("m5: reasoning blocks are skipped, only spoken words recorded", () => {
  assert.equal(logCount(), 11);
  assert.equal(lastLog().text, "说出来的话");
  assert.equal(lastLog().role, "assistant");
});

await ctx.emit("session/event", { id: "s-real" }, {
  type: "user/message",
  data: {
    role: "user",
    content: [{ type: "image", image_url: "https://example.invalid/pic.jpg" }],
    source: { kind: "user" },
  },
});
check("m6: pure-image message records as [图片]", () => {
  assert.equal(logCount(), 12);
  assert.equal(lastLog().text, "[图片]");
});

await ctx.emit("session/event", { id: "s-real" }, {
  type: "user/message",
  data: {
    role: "user",
    content: [
      { type: "text", text: "看这张" },
      { type: "image", image_url: "https://example.invalid/pic.jpg" },
    ],
    source: { kind: "user" },
  },
});
check("m6: image+text records the text with an [图片] trace", () => {
  assert.equal(logCount(), 13);
  assert.equal(lastLog().text, "看这张 [图片]");
});

await ctx.emit("session/event", { id: "s-real" }, {
  type: "assistant/message",
  data: {
    turn: 3,
    step: 1,
    interrupted: true,
    message: {
      role: "assistant",
      content: "说到一半",
      source: { provider: "deepseek", model: "deepseek-chat" },
    },
    stream: "stream-3",
  },
});
check("m7: interrupted message is marked [未说完]", () => {
  assert.equal(logCount(), 14);
  assert.equal(lastLog().text, "说到一半 [未说完]");
});

// ---- pre-step must RETURN next()'s result (crash fix 0.1.1) --------
// Cordis waterfall returns the outermost listener's return value;
// dropping it makes the whole pre-step decision undefined and DSH's
// model-selection handler crashes reading decision.kind (live
// headless DSH 0.2.1-rc.5, 2026-11-06: every window, every turn).
const fakeDecision = { kind: "proceed" };
const dRet = decision("s-ret", "夏柠柒，查岗还记得吗");
const ret = await (
  ctx.preStep as Handler
).handler(dRet, async () => fakeDecision);
check("pre-step returns next()'s decision (persona path)", () => {
  assert.equal(ret, fakeDecision);
});
const retEmpty = await (
  ctx.preStep as Handler
).handler(
  { agent: { id: "s-ret", ctx: ctx.agentCtx("s-ret") }, messages: [] },
  async () => fakeDecision,
);
check("pre-step returns next()'s decision (empty path)", () => {
  assert.equal(retEmpty, fakeDecision);
});
const retTask = await (
  ctx.preStep as Handler
).handler(
  decision("s-ret", "帮我写个脚本"),
  async () => fakeDecision,
);
check("pre-step returns next()'s decision (task path)", () => {
  assert.equal(retTask, fakeDecision);
});

// ---- B1: two persona sessions, agent-scoped contexts, no collision --
await ctx.emit("agent/created", { agent: { id: "sA" } });
await ctx.emit("agent/pre-step", decision("sA", "夏柠柒，查岗还记得吗"));
await ctx.emit("agent/pre-step", decision("sA", "你还记得好呀吗"));
await ctx.emit("agent/created", { agent: { id: "sB" } });
await ctx.emit("agent/pre-step", decision("sB", "夏柠柒，查岗还记得吗"));
await ctx.emit("agent/pre-step", decision("sB", "你还记得好呀吗"));

check("B1: two persona sessions each get their own agent-scoped recall context", () => {
  const recA = ctx
    .agentCtx("sA")
    .contexts.filter((c) => c.name === "memory-plugin:recall");
  const recB = ctx
    .agentCtx("sB")
    .contexts.filter((c) => c.name === "memory-plugin:recall");
  assert.equal(recA.length, 1, "sA has its own context");
  assert.equal(recB.length, 1, "sB has its own context");
  assert.ok(recA[0].text.includes("好呀"));
  assert.ok(recB[0].text.includes("好呀"));
  const global = ctx.contexts.filter((c) => c.name === "memory-plugin:recall");
  assert.equal(global.length, 0, "no global recall context (no leak, no collision)");
});

// ---- B1 fallback: decisions without agent.ctx use the global layer --
// A second legacy session's duplicate registration must be caught,
// never crash the turn.
const fakeDecision2 = { kind: "proceed" };
const dLeg1: Record<string, unknown> = {
  sessionId: "s-leg1",
  messages: [
    { role: "user", content: "夏柠柒，查岗还记得吗", source: { kind: "user" } },
  ],
};
await (ctx.preStep as Handler).handler(dLeg1, async () => fakeDecision2);
await (ctx.preStep as Handler).handler(
  {
    sessionId: "s-leg1",
    messages: [
      { role: "user", content: "你还记得好呀吗", source: { kind: "user" } },
    ],
  },
  async () => fakeDecision2,
);
const dLeg2: Record<string, unknown> = {
  sessionId: "s-leg2",
  messages: [
    { role: "user", content: "夏柠柒，查岗还记得吗", source: { kind: "user" } },
  ],
};
await (ctx.preStep as Handler).handler(dLeg2, async () => fakeDecision2);
const retLeg2b = await (ctx.preStep as Handler).handler(
  {
    sessionId: "s-leg2",
    messages: [
      { role: "user", content: "你还记得好呀吗", source: { kind: "user" } },
    ],
  },
  async () => fakeDecision2,
);
check("B1 fallback: legacy decisions without agent.ctx use the global layer, duplicate is caught", () => {
  assert.equal(retLeg2b, fakeDecision2, "second legacy turn still returns next()");
  const global = ctx.contexts.filter((c) => c.name === "memory-plugin:recall");
  assert.equal(global.length, 1, "only the first legacy registration landed");
});

// ---- 0.1.4 minor 2: agent-scope registration failure never falls back to global ----
const globalRecallBefore = ctx.contexts.filter(
  (c) => c.name === "memory-plugin:recall",
).length;
// Occupy the name in s-m2's own agent scope, so its context()
// throws on the next registration attempt.
ctx.agentCtx("s-m2").systemPrompt.context({
  name: "memory-plugin:recall",
  order: 500,
  text: "occupied",
});
await ctx.emit("agent/created", { agent: { id: "s-m2" } });
await ctx.emit("agent/pre-step", decision("s-m2", "夏柠柒，查岗还记得吗"));
const m2Ret = await (ctx.preStep as Handler).handler(
  decision("s-m2", "你还记得好呀吗"),
  async () => fakeDecision2,
);
check("minor 2: agent-scope registration failure does not leak into the global layer", () => {
  assert.equal(m2Ret, fakeDecision2, "turn still returns next()");
  assert.equal(
    ctx.contexts.filter((c) => c.name === "memory-plugin:recall").length,
    globalRecallBefore,
    "no global fallback registration",
  );
  assert.equal(
    ctx.agentCtx("s-m2").contexts.filter((c) => c.name === "memory-plugin:recall").length,
    1,
    "only the pre-occupied context exists in the agent scope",
  );
});

// ---- M4: the gate reads the CALLING session from exec ----------------
await ctx.emit("agent/pre-step", decision("s4", "帮我写个脚本")); // current turn = task s4
const execPersona = await rememberTool.execute(
  { text: "exec 认定的那句" },
  { agent: { session: { id: "s-real" } } },
);
check("M4: exec.agent.session.id (persona) wins over the current task turn", () => {
  assert.equal(execPersona.ok, true);
  assert.equal(logCount(), 15);
});
const execTask = await rememberTool.execute(
  { text: "任务窗口的" },
  { agent: { session: { id: "s4" } } },
);
check("M4: exec.agent.session.id (task) refuses even when the current turn is persona", () => {
  assert.equal(execTask.ok, false);
  assert.equal(logCount(), 15);
});
await ctx.emit("agent/pre-step", decision("s-real", "夏柠柒，查岗"));
const fallbackOk = await rememberTool.execute({ text: "fallback 那句" });
check("M4 fallback: no exec -> most recent pre-step session", () => {
  assert.equal(fallbackOk.ok, true);
  assert.equal(logCount(), 16);
});

// ---- B2 / m11: bad tool arguments never write, never throw ----------
const badUndefined = await rememberTool.execute({ text: undefined });
check("B2: memory_remember with no text refuses without writing", () => {
  assert.equal(badUndefined.ok, false);
  assert.equal(logCount(), 16);
});
const badNumber = await rememberTool.execute({ text: 123 });
check("B2: memory_remember with a non-string text refuses without writing", () => {
  assert.equal(badNumber.ok, false);
  assert.equal(logCount(), 16);
});
const searchEmpty = await searchTool.execute({ query: undefined });
check("m11: memory_search with no query returns empty, never throws", () => {
  assert.equal(searchEmpty.hits.length, 0);
});
const searchNoArgs = await searchTool.execute({});
check("m11: memory_search with {} returns empty, never throws", () => {
  assert.equal(searchNoArgs.hits.length, 0);
});

// ---- 0.1.4 minor 4: restore reloads the in-shell persona state ----
// s-r4 goes persona, snapshot; s-r5 goes persona AFTER the snapshot;
// restoring the snapshot must revert the log AND the shell's persona
// flags — otherwise the next markPersona would write the stale set
// back and silently undo the restore.
await ctx.emit("agent/created", { agent: { id: "s-r4" } });
await ctx.emit("session/event", {
  type: "user/message",
  sessionId: "s-r4",
  source: { kind: "user" },
  message: { content: "夏柠柒，恢复一下", source: { kind: "user" } },
});
const snapR4 = await snapshotTool.execute({});
assert.equal(snapR4.ok, true);
const countAtSnap = logCount();
await ctx.emit("agent/created", { agent: { id: "s-r5" } });
await ctx.emit("session/event", {
  type: "user/message",
  sessionId: "s-r5",
  source: { kind: "user" },
  message: { content: "夏柠柒，恢复后的新会话", source: { kind: "user" } },
});
assert.equal(logCount(), countAtSnap + 1);
const restoreR4 = await restoreTool.execute({
  name: snapR4.snapshot as string,
});
check("minor 4: restore reverts the log and the persisted persona set", () => {
  assert.equal(restoreR4.ok, true);
  assert.equal(logCount(), countAtSnap, "log reverted to snapshot state");
  const personaFile = readFileSync(join(dir, "persona-sessions.json"), "utf8");
  assert.ok(!personaFile.includes("s-r5"), "restored persona file has no s-r5");
});
// The decisive check: a non-trigger message in s-r5 must NOT be
// recorded now — if the shell still held the stale in-memory flag,
// it would be.
await ctx.emit("session/event", {
  type: "user/message",
  sessionId: "s-r5",
  source: { kind: "user" },
  message: { content: "没有触发词的一句", source: { kind: "user" } },
});
check("minor 4: after restore, the reverted session is not persona in-shell", () => {
  assert.equal(logCount(), countAtSnap, "no stale in-memory persona flag");
});

// ---- 0.3.1 blocklist (end-to-end): a task window naming her is
// never marked, and an already-marked persona session stays marked
// (one-way latch). Fresh data dir + ctx, so the extra records here
// never disturb the main flow's logCount assertions above.
const dir031 = mkdtempSync(join(tmpdir(), "memory-plugin-031-"));
const ctx031 = new MockContext(dir031);
apply(ctx031 as never, { dataDir: dir031 } as never);
await sleep(50);
const decision031 = (id: string, content: string): Record<string, unknown> => ({
  agent: { id, ctx: ctx031.agentCtx(id) },
  messages: [{ role: "user", content, source: { kind: "user" } }],
});
const logCount031 = (): number => {
  const file = join(dir031, "log.jsonl");
  if (!existsSync(file)) return 0;
  return readFileSync(file, "utf8").trim().split("\n").filter(Boolean).length;
};
const userEvent031 = (sid: string, content: string): Record<string, unknown> => ({
  type: "user/message",
  sessionId: sid,
  source: { kind: "user" },
  message: { content, source: { kind: "user" } },
});

// A task instruction that names her must not mark the session:
// neither the pre-step nor the user/message event may flip it.
await ctx031.emit("agent/created", { agent: { id: "s-block" } });
await ctx031.emit("agent/pre-step", decision031("s-block", "帮我把夏柠柒的 skill 更新一下"));
await ctx031.emit("session/event", userEvent031("s-block", "帮我把夏柠柒的 skill 更新一下"));
await ctx031.emit("agent/pre-step", decision031("s-block", "把夏柠柒的插件升级一下"));
await ctx031.emit("session/event", userEvent031("s-block", "把夏柠柒的插件升级一下"));

check("0.3.1 blocklist: trigger + task word never marks the session", () => {
  assert.equal(logCount031(), 0);
});

// A persona session marked by a clean trigger stays marked when a
// later message carries trigger + task word: the task line inside
// the persona window IS recorded — the verbatim log stays complete,
// the blocklist only gates the marking.
await ctx031.emit("agent/created", { agent: { id: "s-block-p" } });
await ctx031.emit("agent/pre-step", decision031("s-block-p", "夏柠柒，在吗"));
await ctx031.emit("session/event", userEvent031("s-block-p", "夏柠柒，在吗"));
check("0.3.1 blocklist: clean trigger still marks", () => {
  assert.equal(logCount031(), 1);
});
await ctx031.emit("session/event", userEvent031("s-block-p", "夏柠柒，帮我把 skill 更新一下"));
check("0.3.1 blocklist: already-marked session stays marked (latch)", () => {
  assert.equal(logCount031(), 2);
});

// ---- 0.2.0: review-due rerun + starmap + status fields + emotion + recall edge ----
// Fresh data dir + ctx, so the extra records here never disturb the
// main flow's logCount assertions above. Same pattern as the M6
// section: a second MockContext on its own temp dir.
const dir020 = mkdtempSync(join(tmpdir(), "memory-plugin-020-"));
// Pre-seed the persisted persona set (review-9 m-6): the review at
// agent/created runs only for a session already known to be persona.
// Seeding s-020a/b/c simulates a DSH restart where those sessions
// were persona before, so the due-gate tests below exercise the
// review itself, not the fresh-session gate (covered by the m-6 test
// in the main section).
writeFileSync(
  join(dir020, "persona-sessions.json"),
  JSON.stringify(["s-020a", "s-020b", "s-020c"]),
  "utf8",
);
const ctx020 = new MockContext(dir020);
apply(ctx020 as never, { dataDir: dir020 } as never);
await sleep(50);
const decision020 = (id: string, content: string): Record<string, unknown> => ({
  agent: { id, ctx: ctx020.agentCtx(id) },
  messages: [{ role: "user", content, source: { kind: "user" } }],
});
const logCount020 = (): number => {
  const file = join(dir020, "log.jsonl");
  if (!existsSync(file)) return 0;
  return readFileSync(file, "utf8").trim().split("\n").filter(Boolean).length;
};
const logEntries020 = (): Array<Record<string, unknown>> => {
  const file = join(dir020, "log.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
};
const graphEdges020 = (): Array<Record<string, unknown>> =>
  (
    JSON.parse(readFileSync(join(dir020, "graph.json"), "utf8")) as {
      edges: Array<Record<string, unknown>>;
    }
  ).edges;
const attributes020 = (): Record<string, Record<string, unknown>> =>
  (
    JSON.parse(readFileSync(join(dir020, "attributes.json"), "utf8")) as {
      entries: Record<string, Record<string, unknown>>;
    }
  ).entries;

await ctx020.emit("agent/created", { agent: { id: "s-020a" } });
check("0.2.0: first session start runs the review and writes the starmap", () => {
  const state = readReviewState(dir020);
  assert.equal(state.totalReviews, 1);
  assert.ok(existsSync(join(dir020, "starmap.html")));
});

await ctx020.emit("agent/created", { agent: { id: "s-020b" } });
check("0.2.0: second session start inside 24 h skips the review", () => {
  assert.equal(readReviewState(dir020).totalReviews, 1);
});

// Force the review due again (lastReviewedAt back to 0) and delete
// the starmap: the next session start must rerun the review AND
// regenerate starmap.html (core.review regenerates it after the run).
rmSync(join(dir020, "starmap.html"));
{
  const state = readReviewState(dir020);
  state.lastReviewedAt = 0;
  writeFileSync(join(dir020, "review.json"), JSON.stringify(state), "utf8");
}
await ctx020.emit("agent/created", { agent: { id: "s-020c" } });
check("0.2.0: review runs again when due and regenerates starmap.html", () => {
  const state = readReviewState(dir020);
  assert.equal(state.totalReviews, 2, "review reran once it was due");
  assert.ok(
    existsSync(join(dir020, "starmap.html")),
    "starmap.html regenerated by the review",
  );
});

// Recall -> record in one session must leave a recall edge in
// graph.json: pre-step recall surfaces A, the next record in the
// same session links back to it.
await ctx020.emit("agent/created", { agent: { id: "s-edge" } });
await ctx020.emit("agent/pre-step", decision020("s-edge", "夏柠柒"));
await ctx020.emit("session/event", {
  type: "user/message",
  sessionId: "s-edge",
  source: { kind: "user" },
  message: { content: "夏柠柒，蓝莓蛋糕很好吃", source: { kind: "user" } },
});
assert.equal(logCount020(), 1);
await ctx020.emit("agent/pre-step", decision020("s-edge", "夏柠柒，你还记得蓝莓蛋糕吗"));
await ctx020.emit("session/event", {
  type: "user/message",
  sessionId: "s-edge",
  source: { kind: "user" },
  message: { content: "夏柠柒，蓝莓蛋糕确实好吃", source: { kind: "user" } },
});
assert.equal(logCount020(), 2);
check("0.2.0: same-session recall then record adds a recall edge to graph.json", () => {
  const entries = logEntries020();
  const a = entries.find((e) => e.text === "夏柠柒，蓝莓蛋糕很好吃") as { id: string };
  const b = entries.find((e) => e.text === "夏柠柒，蓝莓蛋糕确实好吃") as { id: string };
  assert.ok(a && b, "both entries recorded");
  const recallEdge = graphEdges020().find(
    (e) =>
      e.type === "recall" &&
      ((e.from === a.id && e.to === b.id) ||
        (e.from === b.id && e.to === a.id)),
  );
  assert.ok(recallEdge, "a recall edge links the recalled entry to the next record");
});

// ---- 0.2.0 tools on the fresh ctx ------------------------------------
const status020 = ctx020.registeredTools.find(
  (t) => t.name === "memory_status",
) as unknown as {
  execute: (args: Record<string, unknown>) => Promise<{
    ok: boolean;
    totalEntries?: number;
    graphEdges?: number;
    attributes?: number;
    lastReviewAt?: number | null;
  }>;
};
const remember020 = ctx020.registeredTools.find(
  (t) => t.name === "memory_remember",
) as unknown as {
  execute: (
    args: Record<string, unknown>,
    exec?: unknown,
  ) => Promise<{ ok: boolean; id: string }>;
};
const starmap020 = ctx020.registeredTools.find(
  (t) => t.name === "memory_starmap",
) as unknown as {
  execute: (
    args: Record<string, unknown>,
    exec?: unknown,
  ) => Promise<{
    ok: boolean;
    path?: string;
    nodes?: number;
    edges?: number;
    generatedAt?: number;
    error?: string;
  }>;
};

const status020Res = await status020.execute({});
check("0.2.0: memory_status carries graphEdges, attributes, lastReviewAt", () => {
  assert.equal(status020Res.ok, true);
  assert.equal(typeof status020Res.graphEdges, "number");
  assert.ok((status020Res.graphEdges as number) >= 1, "graph has edges");
  assert.equal(typeof status020Res.attributes, "number");
  assert.ok((status020Res.attributes as number) >= 2, "attributes exist");
  assert.equal(typeof status020Res.lastReviewAt, "number");
  assert.ok((status020Res.lastReviewAt as number) > 0, "a review has run");
});

// memory_remember with emotion: "温暖:0.7" lands in attributes.json
// verbatim; a bare "温暖" defaults to 0.5; an unparseable
// "温暖:abc" is treated as not passed (lexicon fallback, never the
// raw garbage string).
const execEdge = { agent: { session: { id: "s-edge" } } };
const remWarm = await remember020.execute(
  { text: "记住：她喜欢暖阳色的毛衣", emotion: "温暖:0.7" },
  execEdge,
);
check("0.2.0: memory_remember emotion '温暖:0.7' is stored in attributes.json", () => {
  assert.equal(remWarm.ok, true);
  const attrs = attributes020()[remWarm.id] as {
    emotion?: { type?: string; intensity?: number };
  };
  assert.ok(attrs, "attributes row exists for the new entry");
  assert.equal(attrs.emotion?.type, "温暖");
  assert.equal(attrs.emotion?.intensity, 0.7);
});
const remBare = await remember020.execute(
  { text: "记住：她喜欢清晨的雾", emotion: "温暖" },
  execEdge,
);
check("0.2.0: memory_remember emotion '温暖' defaults to intensity 0.5", () => {
  assert.equal(remBare.ok, true);
  const attrs = attributes020()[remBare.id] as {
    emotion?: { type?: string; intensity?: number };
  };
  assert.equal(attrs.emotion?.type, "温暖");
  assert.equal(attrs.emotion?.intensity, 0.5);
});
const remBad = await remember020.execute(
  { text: "记住：她喜欢雨后的青草", emotion: "温暖:abc" },
  execEdge,
);
check("0.2.0: memory_remember emotion '温暖:abc' falls back to the lexicon, never stored raw", () => {
  assert.equal(remBad.ok, true);
  const attrs = attributes020()[remBad.id] as {
    emotion?: { type?: string; intensity?: number };
  };
  assert.ok(attrs, "attributes row exists for the new entry");
  // The lexicon may or may not tag this text — either way the
  // unparseable string must never land in the row: a guessed emotion
  // is a clean type + finite intensity, and no guess at all leaves
  // the field unset.
  if (attrs.emotion) {
    assert.ok(
      !(attrs.emotion?.type as string).includes(":"),
      "the unparseable string was not stored as the type",
    );
    assert.ok(Number.isFinite(attrs.emotion?.intensity));
  } else {
    assert.equal(attrs.emotion, undefined, "no tag when the lexicon has no match");
  }
});

// memory_starmap: ok + counts match the fixture (5 entries, all
// graph edges between picked nodes).
const starRes = await starmap020.execute({}, execEdge);
check("0.2.0: memory_starmap returns ok and counts matching the fixture", () => {
  assert.equal(starRes.ok, true);
  assert.equal(starRes.path, join(dir020, "starmap.html"));
  assert.ok(existsSync(starRes.path as string), "starmap.html exists");
  assert.equal(starRes.nodes, logCount020(), "nodes == recorded entries");
  assert.equal(
    starRes.edges,
    graphEdges020().length,
    "edges == graph.json edge count",
  );
  assert.equal(typeof starRes.generatedAt, "number");
});

const starTask = await starmap020.execute(
  {},
  { agent: { session: { id: "s-never-triggered" } } },
);
check("0.2.0: memory_starmap refuses in a task window", () => {
  assert.equal(starTask.ok, false);
});

// ---- 0.3.0: memory_fragment tool + fragment-aware search/status ----
// Reuses ctx020 / s-edge (persona): its two log entries are both
// about 蓝莓蛋糕 ("夏柠柒，蓝莓蛋糕很好吃" / "夏柠柒，蓝莓蛋糕确实好吃").
const fragment030 = ctx020.registeredTools.find(
  (t) => t.name === "memory_fragment",
) as unknown as {
  execute: (
    args: Record<string, unknown>,
    exec?: unknown,
  ) => Promise<{
    ok: boolean;
    id?: string;
    error?: string;
    reasons?: string[];
  }>;
};
const fragments020 = (): Array<Record<string, unknown>> =>
  (
    JSON.parse(readFileSync(join(dir020, "fragments.json"), "utf8")) as {
      fragments: Array<Record<string, unknown>>;
    }
  ).fragments;
const cakeEntries = logEntries020().filter((e) =>
  String(e.text).includes("蓝莓蛋糕"),
);
assert.equal(cakeEntries.length, 2, "two 蓝莓蛋糕 source entries to fragment");

const fragGood = await fragment030.execute(
  {
    sourceIds: cakeEntries.map((e) => e.id),
    text: "她很喜欢蓝莓蛋糕",
    tone: "很喜欢",
    quotes: ["蛋糕很好吃"],
    topic: "蓝莓蛋糕",
  },
  execEdge,
);
check("0.3.0: memory_fragment accepts a good fragment (persona window)", () => {
  assert.equal(fragGood.ok, true, `good fragment accepted: ${JSON.stringify(fragGood)}`);
  assert.ok(typeof fragGood.id === "string" && (fragGood.id as string).length > 0);
  assert.equal(fragments020().length, 1, "one fragment stored");
  assert.deepEqual(
    fragments020()[0].sourceIds,
    cakeEntries.map((e) => e.id),
    "provenance kept",
  );
});

const fragNovel = await fragment030.execute(
  {
    sourceIds: cakeEntries.map((e) => e.id),
    text: "她很喜欢粉色筷子",
    tone: "很喜欢",
    quotes: ["蛋糕很好吃"],
    topic: "粉色筷子",
  },
  execEdge,
);
check("0.3.0: memory_fragment REJECTS novel contamination (粉色筷子)", () => {
  assert.equal(fragNovel.ok, false, "contaminated fragment rejected");
  assert.ok((fragNovel.reasons ?? []).some((r) => String(r).includes("粉色")), `reason names the invented word: ${JSON.stringify(fragNovel.reasons)}`);
  assert.equal(fragments020().length, 1, "nothing new stored");
});

const fragFreeTone = await fragment030.execute(
  {
    sourceIds: [cakeEntries[0].id],
    text: "蓝莓蛋糕还行",
    tone: "嘴上嫌弃心里喜欢",
    quotes: ["蛋糕很好吃"],
    topic: "蓝莓蛋糕",
  },
  execEdge,
);
check("0.3.0: memory_fragment accepts a free-form tone (not a fixed list)", () => {
  // "蛋糕很好吃" is a mild-positive marker; the free-form tone maps to
  // level unknown, so the tone check is skipped — keyword + quote
  // checks still pass.
  assert.equal(fragFreeTone.ok, true, `free-form tone accepted: ${JSON.stringify(fragFreeTone)}`);
  assert.equal(fragments020().length, 2, "second fragment stored");
  assert.equal(
    (fragments020()[1].tone as { label?: string }).label,
    "嘴上嫌弃心里喜欢",
    "free-form label kept verbatim",
  );
});

const fragTask = await fragment030.execute(
  {
    sourceIds: [cakeEntries[0].id],
    text: "她很喜欢蓝莓蛋糕",
    tone: "很喜欢",
    quotes: ["蛋糕很好吃"],
  },
  { agent: { session: { id: "s-never-triggered" } } },
);
check("0.3.0: memory_fragment refuses in a task window", () => {
  assert.equal(fragTask.ok, false);
  assert.equal(fragments020().length, 2, "task call stored nothing");
});

const fragNoSource = await fragment030.execute(
  { sourceIds: [], text: "她很喜欢蓝莓蛋糕", tone: "很喜欢", quotes: ["蛋糕很好吃"] },
  execEdge,
);
check("0.3.0: memory_fragment refuses without sourceIds (no provenance, no fragment)", () => {
  assert.equal(fragNoSource.ok, false);
  assert.equal(fragments020().length, 2, "no-source call stored nothing");
});

// memory_search now prefers fragments: the 蓝莓蛋糕 hit shows the
// fragment text + tone, not the full originals.
const search030 = ctx020.registeredTools.find(
  (t) => t.name === "memory_search",
) as unknown as {
  execute: (args: Record<string, unknown>) => Promise<{
    layer1: string;
    hits: Array<{
      id: string;
      text: string;
      fragmentId?: string;
      fragmentTone?: string;
    }>;
  }>;
};
const searchRes = await search030.execute({ query: "蓝莓蛋糕", limit: 5 });
check("0.3.0: memory_search returns the fragment text (not the full originals)", () => {
  const fragHit = searchRes.hits.find((h) => h.fragmentId === fragGood.id);
  assert.ok(fragHit, `a fragment hit surfaces: ${JSON.stringify(searchRes.hits)}`);
  assert.equal(fragHit?.text, "她很喜欢蓝莓蛋糕", "hit text is the fragment");
  assert.equal(fragHit?.fragmentTone, "很喜欢", "hit carries the fragment tone");
});

// memory_status carries the fragment counts.
const status030Res = await status020.execute({});
check("0.3.0: memory_status carries fragments + suspectFragments", () => {
  assert.equal(status030Res.ok, true);
  assert.equal(
    (status030Res as unknown as { fragments?: number }).fragments,
    2,
    "two fragments stored",
  );
  assert.equal(
    (status030Res as unknown as { suspectFragments?: number }).suspectFragments,
    0,
    "no suspect fragments",
  );
});

// Free-form emotion: parseEmotion already accepts any string —
// verify it passes varied moods through untouched (no fixed list).
check("0.3.0: parseEmotion passes free-form moods through (傲娇/忐忑/宠溺)", () => {
  for (const mood of ["傲娇", "忐忑", "宠溺", "委屈", "别扭"]) {
    const parsed = parseEmotion(mood);
    assert.equal(parsed?.type, mood, `mood ${mood} kept verbatim`);
    assert.equal(parsed?.intensity, 0.5, "bare mood defaults to 0.5");
  }
  assert.equal(parseEmotion("傲娇:0.8")?.intensity, 0.8, "explicit intensity kept");
});

// M-1 (review-12): the id outlet, end to end — the model searches,
// takes the id straight out of the hit, and calls memory_fragment
// with it. Before the fix the hits carried no id at all, so no
// searched entry could ever be fragmented.
const searchSweater = await search030.execute({ query: "毛衣", limit: 5 });
const sweaterHit = searchSweater.hits.find((h) => h.text.includes("毛衣"));
assert.ok(sweaterHit, `毛衣 search returns a hit: ${JSON.stringify(searchSweater.hits)}`);
assert.ok(
  typeof sweaterHit?.id === "string" && sweaterHit.id.length > 0,
  "the hit carries the log entry id",
);
const fragFromSearch = await fragment030.execute(
  {
    sourceIds: [sweaterHit!.id],
    text: "她喜欢暖阳色的毛衣",
    tone: "很喜欢",
    quotes: ["暖阳色的毛衣"],
    topic: "毛衣",
  },
  execEdge,
);
check("M-1 (review-12): memory_fragment accepts an id taken from a memory_search hit", () => {
  assert.equal(fragFromSearch.ok, true, `fragment from searched id accepted: ${JSON.stringify(fragFromSearch)}`);
  assert.equal(fragments020().length, 3, "third fragment stored");
});

// ---- M3: apply() with an unusable dataDir fails LOUDLY --------------
const badFile = join(tmpdir(), `memory-plugin-bad-${Date.now()}`);
writeFileSync(badFile, "not a directory", "utf8");
const badCtx = new MockContext(badFile);
const warns: string[] = [];
const origWarn = console.warn;
console.warn = (...args: unknown[]) => {
  warns.push(args.map(String).join(" "));
};
let threw: unknown = null;
try {
  apply(badCtx as never, { dataDir: badFile } as never);
} catch (err) {
  threw = err;
} finally {
  console.warn = origWarn;
}
check("M3: apply() with a file as dataDir throws loudly, naming the dir", () => {
  assert.ok(threw instanceof Error, "apply throws");
  assert.ok(
    warns.some((w) => w.includes(badFile)),
    "the warn names the dataDir",
  );
});

// ---- m14: duplicate static section registration is caught -----------
check("m14: applying twice to one ctx does not die on the duplicate section", () => {
  const dupCtx = new MockContext(dir);
  apply(dupCtx as never, { dataDir: dir } as never);
  assert.doesNotThrow(() => apply(dupCtx as never, { dataDir: dir } as never));
});

// ---- 0.1.5: shipped tree carries no private info (blocklist-driven) ----
// The sensitive-word list lives OUTSIDE the repo tree and is never shipped:
//   <workspace>/.memory-plugin-private-blocklist.json
// (a JSON array of strings: real names, emails, personal machine paths...).
// The repo must never contain any of those strings -- and this test must
// never contain them either, so it reads them from that file instead of
// hard-coding them.
// 0.1.7 (review m3): in a packaged/extracted copy the private file is
// absent, so the old code printed "skipping" and the pass proved
// nothing. The test now falls back to a SHIPPED SAMPLE blocklist
// (test/sample-blocklist.json -- fake entries only, zero real personal
// info) and ASSERTS the guard executed: the list must be non-empty,
// and a negative control (minor 5b) proves the scan really flags a
// hit. The private list still wins when present (it is the real one).
// The walk covers the whole memory-plugin tree (repo root, not just
// dsh-plugin/); the sample fixture itself is excluded from the scan
// (it contains the sample terms by design). Binary files are skipped
// (a NUL byte in the first 8 KiB means "not text"); node_modules
// and .git are skipped as well. No absolute local path is ever
// printed: the skip warning names no path.
function loadBlocklist(path: string): string[] | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (Array.isArray(parsed)) {
      const terms = parsed.filter((s) => typeof s === "string") as string[];
      return terms.length > 0 ? terms : null;
    }
  } catch {
    // Missing or unparsable: fall through to the next source.
  }
  return null;
}
const privateBlocklistPath = fileURLToPath(
  new URL("../../../.memory-plugin-private-blocklist.json", import.meta.url),
);
const sampleBlocklistPath = fileURLToPath(
  new URL("./sample-blocklist.json", import.meta.url),
);
const privateTerms = loadBlocklist(privateBlocklistPath);
const sampleTerms = privateTerms ? null : loadBlocklist(sampleBlocklistPath);
const blocklist = privateTerms ?? sampleTerms ?? [];
const blocklistSource = privateTerms
  ? "private"
  : sampleTerms
    ? "sample"
    : "none";
if (blocklistSource === "none") {
  console.warn(
    "[memory-plugin] no blocklist found (private or sample) -- skipping the shipped-tree privacy check",
  );
}
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const sampleFixturePath = sampleBlocklistPath;
function collectTextFiles(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const p = join(dir, entry.name);
    if (p === sampleFixturePath) continue; // holds the sample terms by design
    if (entry.isDirectory()) {
      collectTextFiles(p, out);
    } else if (entry.isFile()) {
      // Bounded sniff: read at most the first 8 KiB to test for NUL.
      // Reading the whole file here crashed the walk on any file
      // over 2 GiB (readFileSync limit), even a binary one.
      const fd = openSync(p, "r");
      try {
        const buf = Buffer.alloc(8192);
        const n = readSync(fd, buf, 0, 8192, 0);
        if (!buf.subarray(0, n).includes(0)) out.push(p);
      } finally {
        closeSync(fd);
      }
    }
  }
}
function scanTreeForTerms(files: string[], terms: string[]): string[] {
  const hits: string[] = [];
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    for (const term of terms) {
      if (text.includes(term)) hits.push(`${f} contains a blocklisted string`);
    }
  }
  return hits;
}
check("minor 5: shipped tree contains no private info (blocklist, whole-tree)", () => {
  // The guard must actually have a list to check against: a pass
  // with no list proves nothing (review m3).
  assert.ok(
    blocklist.length > 0,
    `privacy guard needs a blocklist (source: ${blocklistSource})`,
  );
  const files: string[] = [];
  collectTextFiles(repoRoot, files);
  assert.ok(files.length > 0, "tree walk must find files to check");
  assert.deepEqual(
    scanTreeForTerms(files, blocklist),
    [],
    "shipped tree must not contain a blocklisted string",
  );
});

check("minor 5b: privacy guard really flags a hit (negative control)", () => {
  // Proves the scan above is not vacuous: the same scan over a
  // planted file containing a blocklist term must report it.
  assert.ok(blocklist.length > 0, "need a blocklist for the control");
  const ctrlDir = mkdtempSync(join(tmpdir(), "memory-plugin-privacy-ctrl-"));
  const planted = join(ctrlDir, "planted.txt");
  writeFileSync(planted, `innocent text ${blocklist[0]} more text`, "utf8");
  const hits = scanTreeForTerms([planted], blocklist);
  assert.equal(hits.length, 1, "planted blocklisted term must be flagged");
  rmSync(ctrlDir, { recursive: true, force: true });
});

check("minor 6: dsh-plugin README no longer claims real-DSH testing never happened", () => {
  const readme = readFileSync(
    fileURLToPath(new URL("../README.md", import.meta.url)),
    "utf8",
  );
  assert.ok(!readme.includes("is NOT covered here"), "stale sentence removed");
  assert.ok(
    readme.includes("headless verification against real DSH"),
    "README mentions headless verification",
  );
});

// ---- M-02 (Claude deep review of package v4): README DSH ranges ------
// The two READMEs must state the same DSH range as package.json
// (engines.dsh and the dsh-tools dependency), so a user reading the
// docs does not install against a range that excludes the verified
// prerelease.
check("M-02: README DSH ranges agree with package.json", () => {
  const pkg = JSON.parse(
    readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
  ) as { engines?: { dsh?: string }; dependencies?: Record<string, string> };
  const range = pkg.engines?.dsh;
  assert.ok(range, "engines.dsh present");
  assert.equal(
    pkg.dependencies?.["@deepseek-ai/dsh-tools"],
    range,
    "dependency range equals engines.dsh",
  );
  const rootReadme = readFileSync(
    fileURLToPath(new URL("../../README.md", import.meta.url)),
    "utf8",
  );
  const shellReadme = readFileSync(
    fileURLToPath(new URL("../README.md", import.meta.url)),
    "utf8",
  );
  assert.ok(rootReadme.includes(`DSH \`${range}\``), "root README states the package.json DSH range");
  assert.ok(shellReadme.includes(`DSH \`${range}\``), "dsh-plugin README states the package.json DSH range");
  // And no bare old range (>=0.2.0 <0.3.0 without the prerelease
  // comparator) may remain anywhere in either README — a later
  // section once restated it on its own (deep review of package v5,
  // Minor M-02).
  for (const [name, text] of [["root README", rootReadme], ["dsh-plugin README", shellReadme]] as const) {
    const bare = text.split(range).join("");
    assert.ok(!bare.includes(">=0.2.0 <0.3.0"), `${name} has no bare old DSH range left`);
  }
});

// ---- M6 forced-error coverage (0.1.4): directory in place of a file ----
// Port of the independent re-verification's <tmp>/m6-test.ts: force
// core recall/flush/record to throw WITHOUT editing the plugin, and
// prove the shell degrades (warn + continue) instead of killing the
// turn. MEMORY.md as a directory makes readLayer1 throw EISDIR on
// recall; index.json / log.jsonl as directories make flush / record
// throw.
const m6Dir = mkdtempSync(join(tmpdir(), "memory-plugin-m6-"));
mkdirSync(join(m6Dir, "MEMORY.md")); // a DIRECTORY named MEMORY.md
const m6Ctx = new MockContext(m6Dir);
const m6Warns: string[] = [];
const m6OrigWarn = console.warn;
console.warn = (...args: unknown[]) => {
  m6Warns.push(args.map(String).join(" "));
};
try {
  apply(m6Ctx as never, { dataDir: m6Dir } as never);
  await sleep(50);
  await m6Ctx.emit("agent/created", { agent: { id: "s-m6" } });
  await m6Ctx.emit("session/event", { id: "s-m6" }, {
    type: "user/message",
    data: { role: "user", content: "夏柠柒你好", source: { kind: "user" } },
  });
  check("M6 setup: record works before forced errors", () => {
    const lines = readFileSync(join(m6Dir, "log.jsonl"), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean);
    assert.equal(lines.length, 1);
  });

  // Forced recall failure in pre-step.
  const m6Fake = { kind: "proceed" };
  const m6Decision = {
    agent: { id: "s-m6", ctx: m6Ctx.agentCtx("s-m6") },
    messages: [
      { role: "user", content: "夏柠柒，查岗", source: { kind: "user" } },
    ],
  };
  const m6Ret = await (m6Ctx.preStep as Handler).handler(
    m6Decision,
    async () => m6Fake,
  );
  check("M6-a: recall throws -> pre-step degrades, returns next()", () => {
    assert.equal(m6Ret, m6Fake);
    assert.ok(m6Warns.some((w) => w.includes("recall") && w.includes("失败")));
  });

  // Forced flush failure in turn-stopping.
  rmSync(join(m6Dir, "index.json"));
  mkdirSync(join(m6Dir, "index.json")); // directory in place of the index file
  await m6Ctx.emit("agent/turn-stopping", { sessionId: "s-m6" });
  check("M6-b: flush throws -> turn-stopping degrades, no throw", () => {
    assert.ok(m6Warns.some((w) => w.includes("落盘失败")));
  });

  // Forced record failure in session/event.
  rmSync(join(m6Dir, "log.jsonl"));
  mkdirSync(join(m6Dir, "log.jsonl")); // directory in place of the log file
  await m6Ctx.emit("session/event", { id: "s-m6" }, {
    type: "user/message",
    data: { role: "user", content: "夏柠柒，再一句", source: { kind: "user" } },
  });
  check("M6-c: record throws -> session/event degrades, no throw", () => {
    assert.ok(m6Warns.some((w) => w.includes("记录用户消息失败")));
  });
} finally {
  console.warn = m6OrigWarn;
}

// ---- 0.3.0: daily model review (new layer 2) -----------------------
// Seed yesterday's entries directly in the core (backdated), so the
// review has something to hand the model. "Yesterday" is computed
// from the real clock, so noon yesterday avoids date-boundary
// flakiness. Isolated dir + context.
const revDir = mkdtempSync(join(tmpdir(), "memory-plugin-model-review-"));
writeFileSync(join(revDir, "MEMORY.md"), fixtureMemory, "utf8");
const yNoon = new Date();
yNoon.setDate(yNoon.getDate() - 1);
yNoon.setHours(12, 0, 0, 0);
const yTs = yNoon.getTime();
const seedCore = new MemoryCore({ dataDir: revDir });
const revE1 = seedCore.record({ role: "user", text: "昨天去爬山了", window: "persona", sessionId: "s-rev", ts: yTs });
const revE2 = seedCore.record({ role: "assistant", text: "昨天吃了拉面", window: "persona", sessionId: "s-rev", ts: yTs + 60000 });
seedCore.record({ role: "user", text: "今天要去买菜", window: "persona", sessionId: "s-rev", ts: Date.now() });
seedCore.flush();

const revCtx = new MockContext(revDir);
apply(revCtx as never, { dataDir: revDir } as never);
await sleep(50); // tools register async (loadDefineTool)
const revDecision = (
  id: string,
  content: string,
): Record<string, unknown> => ({
  agent: { id, ctx: revCtx.agentCtx(id) },
  messages: [{ role: "user", content, source: { kind: "user" } }],
});
const revLiveContexts = (id: string) =>
  revCtx
    .agentCtx(id)
    .contexts.filter(
      (c) => c.name === "memory-plugin:daily-review" && !c.disposed,
    );
const readRevAttrs = () =>
  JSON.parse(readFileSync(join(revDir, "attributes.json"), "utf8")) as {
    entries: Record<string, { significance: number; modelMarked?: boolean }>;
  };

// Fresh open: no review (m-6) — the session is not restored yet.
await revCtx.emit("agent/created", { agent: { id: "s-rev" } });
await revCtx.emit("agent/pre-step", revDecision("s-rev", "夏柠柒，在吗"));
check("model review: fresh session gets no review context (m-6)", () => {
  assert.equal(revLiveContexts("s-rev").length, 0, "no review on a fresh session's first open");
});

// Reopen: restored persona -> code review runs (due, first time) ->
// the next turn hands yesterday's messages to the model.
await revCtx.emit("agent/created", { agent: { id: "s-rev" } });
await revCtx.emit("agent/pre-step", revDecision("s-rev", "夏柠柒，在吗"));
check("model review: restored session's first turn registers the review context with yesterday's messages", () => {
  const live = revLiveContexts("s-rev");
  assert.equal(live.length, 1, "one live review context");
  assert.ok(live[0].text.includes("昨天去爬山了"), "yesterday's messages are in the context");
  assert.ok(live[0].text.includes("昨天吃了拉面"));
  // 0.4.4: today's messages are not in yesterday's list — but they
  // MAY appear in the proact proposal section (the review's
  // proactivity proposal is built from today's memories), so the
  // check is positional: "今天要去买菜" must not appear before
  // the proact section marker.
  assert.ok(
    live[0].text.indexOf("今天要去买菜") === -1 ||
      live[0].text.indexOf("今天要去买菜") > live[0].text.indexOf("主动提议"),
    "today's messages are not in yesterday's list (only in the proact proposal)",
  );
  assert.ok(live[0].text.includes("情绪"), "the 20 categories guide the model");
  assert.ok(live[0].text.includes(revE1.id), "entry ids are citable");
});

const dailyReviewTool = revCtx.registeredTools.find(
  (t) => t.name === "memory_daily_review",
) as {
  execute: (args: unknown, exec?: unknown) => Promise<Record<string, unknown>>;
};
const revExec = { agent: { session: { id: "s-rev" } } };

const unparseable = await dailyReviewTool.execute({ ids: "not-an-array" }, revExec);
check("model review: unparseable output is skipped safely (no crash, no partial apply)", () => {
  assert.equal(unparseable.ok, false);
  assert.equal(
    readRevAttrs().entries[revE1.id]?.significance,
    0.4,
    "nothing applied on a garbled result",
  );
  assert.equal(
    revLiveContexts("s-rev").length,
    1,
    "the review context stays so the model can retry",
  );
});

const submitted = await dailyReviewTool.execute({ ids: [revE1.id, "no-such-id"] }, revExec);
check("model review: submitted ids are upgraded to 0.9 and flagged, unknown ids reported", () => {
  assert.equal(submitted.ok, true);
  assert.deepEqual(submitted.applied, [revE1.id]);
  assert.deepEqual(submitted.unknown, ["no-such-id"]);
  const attrs = readRevAttrs();
  assert.equal(attrs.entries[revE1.id].significance, 0.9, "light 0.4 raised to 0.9");
  assert.equal(attrs.entries[revE1.id].modelMarked, true, "flagged model-marked");
  assert.equal(attrs.entries[revE2.id]?.significance, 0.4, "unmarked stays 0.4");
  assert.equal(
    revLiveContexts("s-rev").length,
    0,
    "the review context is disposed once the review is submitted",
  );
});

const taskRefused = await dailyReviewTool.execute({ ids: [revE2.id] }, { agent: { session: { id: "s-task" } } });
check("model review: task window cannot submit a review", () => {
  assert.equal(taskRefused.ok, false);
});
for (const dispose of revCtx.disposers) dispose();

// ---- 0.4.4 (0.4.3 audit issue 2): the review's proactivity
// proposal and invalidation checks reach the model --------------
// Before this the code review computed both and then discarded
// them (proactPrompt had no reader in dsh-plugin at all;
// invalidationChecks were only a flag in attributes.json that
// nothing ever read), so the model could never act on either.
// Seed: yesterday's entries (the review prompt itself), an old
// heavy memory contradicted by a line from today, and a today
// entry so the day is non-empty for the proactivity proposal.
const rev2Dir = mkdtempSync(join(tmpdir(), "memory-plugin-review-outlet-"));
writeFileSync(join(rev2Dir, "MEMORY.md"), fixtureMemory, "utf8");
const seed2Core = new MemoryCore({ dataDir: rev2Dir });
seed2Core.record({ role: "user", text: "昨天去爬山了", window: "persona", sessionId: "s-rev2", ts: yTs });
seed2Core.record({ role: "assistant", text: "昨天吃了拉面", window: "persona", sessionId: "s-rev2", ts: yTs + 60000 });
const rev2Old = seed2Core.record({ role: "user", text: "他喜欢吃辣", window: "persona", importance: "heavy", sessionId: "s-rev2", ts: Date.now() - 40 * 24 * 60 * 60 * 1000 });
seed2Core.record({ role: "user", text: "他不吃辣了", window: "persona", sessionId: "s-rev2", ts: Date.now() });
seed2Core.flush();

const rev2Ctx = new MockContext(rev2Dir);
apply(rev2Ctx as never, { dataDir: rev2Dir } as never);
await sleep(50);
const rev2Decision = (id: string, content: string): Record<string, unknown> => ({
  agent: { id, ctx: rev2Ctx.agentCtx(id) },
  messages: [{ role: "user", content, source: { kind: "user" } }],
});
const rev2LiveContexts = (id: string) =>
  rev2Ctx
    .agentCtx(id)
    .contexts.filter(
      (c) => c.name === "memory-plugin:daily-review" && !c.disposed,
    );

// Fresh open: no review (m-6).
await rev2Ctx.emit("agent/created", { agent: { id: "s-rev2" } });
await rev2Ctx.emit("agent/pre-step", rev2Decision("s-rev2", "夏柠柒，在吗"));
// Reopen: restored persona -> code review runs -> the next turn
// hands yesterday's messages PLUS the proactivity proposal and
// the invalidation checks to the model.
await rev2Ctx.emit("agent/created", { agent: { id: "s-rev2" } });
await rev2Ctx.emit("agent/pre-step", rev2Decision("s-rev2", "夏柠柒，在吗"));
check("0.4.4: daily-review context carries the proact proposal and the invalidation checks", () => {
  const live = rev2LiveContexts("s-rev2");
  assert.equal(live.length, 1, "one live review context");
  assert.ok(live[0].text.includes("昨天去爬山了"), "yesterday's messages still in the context");
  assert.ok(live[0].text.includes("主动提议"), "proact section present");
  assert.ok(live[0].text.includes("要不要主动找他说句话"), "proact proposal text pasted in");
  assert.ok(live[0].text.includes("memory_proact"), "tells her how to act (fresh gate call for the token)");
  assert.ok(live[0].text.includes("可能已经过时"), "invalidation section present");
  assert.ok(live[0].text.includes(rev2Old.id), "invalidation entry id citable");
  assert.ok(live[0].text.includes("他喜欢吃辣"), "invalidation entry text present");
  assert.ok(live[0].text.includes("memory_invalidate"), "tells her how to confirm");
});
const rev2StatusTool = rev2Ctx.registeredTools.find(
  (t) => t.name === "memory_status",
) as unknown as {
  execute: () => Promise<{ ok: boolean; pendingInvalidationChecks?: number }>;
};
const rev2Status = await rev2StatusTool.execute();
check("0.4.4: memory_status returns the pending invalidation-check count", () => {
  assert.equal(rev2Status.ok, true);
  assert.equal(rev2Status.pendingInvalidationChecks, 1, "one check awaiting model review");
});
for (const dispose of rev2Ctx.disposers) dispose();

// ---- 0.4.5 (0.4.3 audit item 4): the review context auto-releases
// after 3 turns without a submission — before this it lived in
// every request until the model called memory_daily_review.
// Fresh dir so the code review is due on reopen.
const rev3Dir = mkdtempSync(join(tmpdir(), "memory-plugin-review-autorelease-"));
writeFileSync(join(rev3Dir, "MEMORY.md"), fixtureMemory, "utf8");
const seed3Core = new MemoryCore({ dataDir: rev3Dir });
seed3Core.record({ role: "user", text: "昨天去爬山了", window: "persona", sessionId: "s-rev3", ts: yTs });
seed3Core.record({ role: "assistant", text: "昨天吃了拉面", window: "persona", sessionId: "s-rev3", ts: yTs + 60000 });
seed3Core.flush();

const rev3Ctx = new MockContext(rev3Dir);
apply(rev3Ctx as never, { dataDir: rev3Dir } as never);
await sleep(50);
const rev3Decision = (id: string, content: string): Record<string, unknown> => ({
  agent: { id, ctx: rev3Ctx.agentCtx(id) },
  messages: [{ role: "user", content, source: { kind: "user" } }],
});
const rev3LiveContexts = (id: string) =>
  rev3Ctx
    .agentCtx(id)
    .contexts.filter(
      (c) => c.name === "memory-plugin:daily-review" && !c.disposed,
    );

// Fresh open + trigger, then reopen: restored persona -> code
// review runs -> the next turn registers the review context.
await rev3Ctx.emit("agent/created", { agent: { id: "s-rev3" } });
await rev3Ctx.emit("agent/pre-step", rev3Decision("s-rev3", "夏柠柒，在吗"));
await rev3Ctx.emit("agent/created", { agent: { id: "s-rev3" } });
await rev3Ctx.emit("agent/pre-step", rev3Decision("s-rev3", "夏柠柒，在吗"));
check("0.4.5: review context registers on the restored session's first turn", () => {
  assert.equal(rev3LiveContexts("s-rev3").length, 1, "one live review context");
});
// Two more turns without submitting: still live.
for (let i = 0; i < MODEL_REVIEW_AUTO_RELEASE_TURNS - 1; i++) {
  await rev3Ctx.emit("agent/pre-step", rev3Decision("s-rev3", "夏柠柒，在吗"));
}
check("0.4.5: review context survives turns without a submission until the limit", () => {
  assert.equal(rev3LiveContexts("s-rev3").length, 1, "still live before the limit");
});
// One more turn (the 3rd since registration): auto-released.
await rev3Ctx.emit("agent/pre-step", rev3Decision("s-rev3", "夏柠柒，在吗"));
check("0.4.5: review context auto-releases after 3 turns without a submission", () => {
  assert.equal(rev3LiveContexts("s-rev3").length, 0, "disposed on the 3rd turn");
});
for (const dispose of rev3Ctx.disposers) dispose();

// ---- 0.4.0 item 1: memory_invalidate tool ---------------------------
// Reuses ctx020 / s-edge (persona). The invalidated entry is the
// warm-sweater one recorded via memory_remember above (never
// fragmented, so a search for 毛衣 must come back empty afterwards);
// the task-refusal probe uses an untouched 蓝莓蛋糕 entry.
const invalidate020 = ctx020.registeredTools.find(
  (t) => t.name === "memory_invalidate",
) as unknown as {
  execute: (
    args: Record<string, unknown>,
    exec?: unknown,
  ) => Promise<{
    ok: boolean;
    invalidated?: string[];
    unknown?: string[];
    error?: string;
  }>;
};
const search020b = ctx020.registeredTools.find(
  (t) => t.name === "memory_search",
) as unknown as {
  execute: (args: Record<string, unknown>) => Promise<{
    hits: Array<{ id: string; text: string }>;
  }>;
};
const readAttrs020b = () =>
  JSON.parse(readFileSync(join(dir020, "attributes.json"), "utf8")) as {
    entries: Record<string, Record<string, unknown>>;
  };
const auditLines020 = (): Array<Record<string, unknown>> => {
  const f = join(dir020, INVALIDATION_AUDIT_FILE);
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
};
const sweaterId = (remWarm as { id: string }).id;
assert.ok(sweaterId, "warm-sweater entry id to invalidate");

const invRes = await invalidate020.execute(
  { entryIds: [sweaterId], reason: "他后来改口说不喜欢暖阳色的毛衣了" },
  execEdge,
);
const searchAfterInv = await search020b.execute({ query: "毛衣" });
check("0.4.0 item 1: memory_invalidate marks the entry invalid, writes the audit line, log untouched", () => {
  assert.equal(invRes.ok, true);
  assert.deepEqual(invRes.invalidated, [sweaterId]);
  assert.deepEqual(invRes.unknown, []);
  assert.equal(
    typeof readAttrs020b().entries[sweaterId].validTo,
    "number",
    "validTo persisted to attributes.json",
  );
  const lines = auditLines020();
  assert.equal(lines.length, 1, "one audit line");
  assert.equal(lines[0].sessionId, "s-edge", "audit names the calling session (who)");
  assert.equal(typeof lines[0].at, "number", "audit carries when");
  assert.equal(lines[0].reason, "他后来改口说不喜欢暖阳色的毛衣了", "audit carries why");
  assert.deepEqual(lines[0].entryIds, [sweaterId]);
  assert.ok(
    !searchAfterInv.hits.some((h) => h.id === sweaterId),
    "invalidated entry no longer recalls through memory_search",
  );
  assert.ok(
    readFileSync(join(dir020, "log.jsonl"), "utf8").includes("暖阳色的毛衣"),
    "log.jsonl original still there — skipped, not deleted",
  );
});

const auditBeforeRefusal = auditLines020().length;
const cakeSecondId = (cakeEntries[1] as { id: string }).id;
const refusedInv = await invalidate020.execute(
  { entryIds: [cakeSecondId], reason: "任务窗口偷偷失效" },
  { agent: { session: { id: "s-never-triggered" } } },
);
const badIdsInv = await invalidate020.execute({ entryIds: [], reason: "x" }, execEdge);
const badReasonInv = await invalidate020.execute(
  { entryIds: [cakeSecondId], reason: "  " },
  execEdge,
);
check("0.4.0 item 1: memory_invalidate refuses in a task window and writes no audit line", () => {
  assert.equal(refusedInv.ok, false);
  assert.equal(
    readAttrs020b().entries[cakeSecondId]?.validTo,
    undefined,
    "task-window call invalidated nothing",
  );
  assert.equal(auditLines020().length, auditBeforeRefusal, "no audit line for a refused call");
});
check("0.4.0 item 1: memory_invalidate refuses empty entryIds / empty reason without writing", () => {
  assert.equal(badIdsInv.ok, false);
  assert.equal(badReasonInv.ok, false);
  assert.equal(
    readAttrs020b().entries[cakeSecondId]?.validTo,
    undefined,
    "invalid args invalidated nothing",
  );
  assert.equal(auditLines020().length, auditBeforeRefusal, "no audit line for invalid args");
});

check("0.4.0 item 1: old data — attributes.json without the new fields loads, invalidate works", () => {
  const dirOld = mkdtempSync(join(tmpdir(), "memory-plugin-invalidate-old-"));
  writeFileSync(join(dirOld, "MEMORY.md"), "# MEMORY\n", "utf8");
  const coreOld = new MemoryCore({ dataDir: dirOld });
  const eOld = coreOld.record({
    role: "user",
    text: "他喜欢吃辣",
    window: "persona",
    importance: "heavy",
    sessionId: "s1",
  });
  // Simulate pre-0.4.0 data: strip the new fields from attributes.json.
  const attrsPath = join(dirOld, "attributes.json");
  const raw = JSON.parse(readFileSync(attrsPath, "utf8")) as {
    entries: Record<string, Record<string, unknown>>;
  };
  for (const row of Object.values(raw.entries)) {
    delete row.validFrom;
    delete row.validTo;
    delete row.needsInvalidationCheck;
  }
  writeFileSync(attrsPath, JSON.stringify(raw), "utf8");
  const coreOld2 = new MemoryCore({ dataDir: dirOld });
  assert.ok(
    coreOld2.recall("吃辣").hits.some((h) => h.entry.id === eOld.id),
    "old attributes recall fine",
  );
  const res = coreOld2.invalidateEntries([eOld.id]);
  assert.deepEqual(res.invalidated, [eOld.id]);
  assert.ok(
    !coreOld2.recall("吃辣").hits.some((h) => h.entry.id === eOld.id),
    "invalidate works on old data",
  );
});

// ---- 0.4.0 item 2: memory_belief tool -------------------------------
// Fresh dir/ctx; two persona entries recorded through session/event
// (the same path real DSH uses), so the tool's verbatim checks run
// against real log text.
const dirBel = mkdtempSync(join(tmpdir(), "memory-plugin-belief-"));
writeFileSync(join(dirBel, "MEMORY.md"), fixtureMemory, "utf8");
const ctxBel = new MockContext(dirBel);
apply(ctxBel as never, { dataDir: dirBel } as never);
await sleep(50); // tools register async (loadDefineTool)
const decisionBel = (id: string, content: string): Record<string, unknown> => ({
  agent: { id, ctx: ctxBel.agentCtx(id) },
  messages: [{ role: "user", content, source: { kind: "user" } }],
});
await ctxBel.emit("agent/created", { agent: { id: "s-bel" } });
await ctxBel.emit("agent/pre-step", decisionBel("s-bel", "夏柠柒"));
await ctxBel.emit("session/event", {
  type: "user/message",
  sessionId: "s-bel",
  source: { kind: "user" },
  message: { content: "夏柠柒，昨晚难过的时候第一个想到的就是你", source: { kind: "user" } },
});
await ctxBel.emit("session/event", {
  type: "user/message",
  sessionId: "s-bel",
  source: { kind: "user" },
  message: { content: "夏柠柒，答应陪你看星星结果没去成", source: { kind: "user" } },
});
await ctxBel.emit("session/event", {
  type: "user/message",
  sessionId: "s-bel",
  source: { kind: "user" },
  message: { content: "夏柠柒，你说过会一直在我身边", source: { kind: "user" } },
});
const logEntriesBel = (): Array<Record<string, unknown>> => {
  const file = join(dirBel, "log.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
};
const belEntry1 = logEntriesBel().find(
  (e) => (e.text as string).includes("昨晚难过的时候第一个想到的就是你"),
) as { id: string };
const belEntry2 = logEntriesBel().find(
  (e) => (e.text as string).includes("答应陪你看星星结果没去成"),
) as { id: string };
const belEntry3 = logEntriesBel().find(
  (e) => (e.text as string).includes("你说过会一直在我身边"),
) as { id: string };
assert.ok(belEntry1 && belEntry2 && belEntry3, "all three belief evidence entries recorded");
const execBel = { agent: { session: { id: "s-bel" } } };
type BeliefToolResult = {
  ok: boolean;
  belief?: { id: string; strength: number; proofCount: number };
  dimensions?: Record<string, { strength: number; uncertainty: number; proofCount: number }>;
  beliefs?: Array<Record<string, unknown>>;
  duplicate?: boolean;
  error?: string;
  reasons?: string[];
};
const beliefBel = ctxBel.registeredTools.find(
  (t) => t.name === "memory_belief",
) as unknown as {
  execute: (args: Record<string, unknown>, exec?: unknown) => Promise<BeliefToolResult>;
};
assert.ok(beliefBel, "memory_belief is registered (9th tool)");

const createBel = await beliefBel.execute(
  {
    action: "create",
    dimension: "trust",
    statement: "他难过时会来找我",
    entryId: belEntry1.id,
    quote: "昨晚难过的时候第一个想到的就是你",
  },
  execBel,
);
check("0.4.0 item 2: memory_belief create writes a belief, non-verbatim quote is rejected", () => {
  assert.equal(createBel.ok, true, JSON.stringify(createBel));
  assert.equal(createBel.belief?.id, "BEL_TRUST_001");
  assert.equal(createBel.belief?.strength, 0.5);
  assert.equal(createBel.belief?.proofCount, 1);
  const stored = JSON.parse(readFileSync(join(dirBel, "beliefs.json"), "utf8")) as {
    beliefs: Array<{ id: string; statement: string }>;
  };
  assert.equal(stored.beliefs.length, 1, "one belief persisted");
  assert.equal(stored.beliefs[0].statement, "他难过时会来找我");
});

const badQuoteCreate = await beliefBel.execute(
  {
    action: "create",
    dimension: "trust",
    statement: "他难过时第一个想到我",
    entryId: belEntry1.id,
    quote: "昨晚难过第一个想到你",
  },
  execBel,
);
check("0.4.0 item 2: memory_belief create with a paraphrased quote is rejected and writes nothing", () => {
  assert.equal(badQuoteCreate.ok, false, "paraphrase must be rejected");
  assert.ok((badQuoteCreate.reasons?.length ?? 0) > 0, "rejection carries reasons");
  const stored = JSON.parse(readFileSync(join(dirBel, "beliefs.json"), "utf8")) as {
    beliefs: Array<unknown>;
  };
  assert.equal(stored.beliefs.length, 1, "rejected create writes nothing");
});

// support without delta: the tool must ask the model to supply it.
// 0.5.1 (0.4.3 item 7): support uses a FRESH entry here —
// belEntry1 is already the create evidence, so supporting with it
// is a duplicate (no move), not a second proof.
const noDelta = await beliefBel.execute(
  { action: "support", beliefId: "BEL_TRUST_001", entryId: belEntry3.id, quote: "你说过会一直在我身边" },
  execBel,
);
const overCap = await beliefBel.execute(
  { action: "support", beliefId: "BEL_TRUST_001", entryId: belEntry3.id, quote: "你说过会一直在我身边", delta: 0.5 },
  execBel,
);
check("0.4.0 item 2: memory_belief support requires delta, clamps an over-cap delta to 0.2 without erroring", () => {
  assert.equal(noDelta.ok, false, "missing delta is an error, not a silent default");
  assert.ok((noDelta.error ?? "").includes("delta"), "error tells the model to supply delta");
  assert.equal(overCap.ok, true, "over-cap delta is clamped, not an error");
  assert.ok(
    Math.abs((overCap.belief?.strength ?? 0) - 0.7) < 1e-9,
    `0.5 clamped to +0.2 (got ${overCap.belief?.strength})`,
  );
});

// Contradict twice with the same entry: only the first deducts.
const contra1 = await beliefBel.execute(
  { action: "contradict", beliefId: "BEL_TRUST_001", entryId: belEntry2.id, quote: "答应陪你看星星结果没去成", delta: 0.1 },
  execBel,
);
const contra2 = await beliefBel.execute(
  { action: "contradict", beliefId: "BEL_TRUST_001", entryId: belEntry2.id, quote: "答应陪你看星星结果没去成", delta: 0.1 },
  execBel,
);
const getBel = await beliefBel.execute({ action: "get" }, execBel);
check("0.4.0 item 2: memory_belief contradict deducts once per entry; get returns three dimensions without full quotes", () => {
  assert.equal(contra1.ok, true);
  assert.ok(Math.abs((contra1.belief?.strength ?? 0) - 0.6) < 1e-9, "first contradict deducts 0.1");
  assert.equal(contra2.ok, true);
  assert.equal(contra2.duplicate, true, "repeat contradict is flagged duplicate");
  assert.ok(Math.abs((contra2.belief?.strength ?? 0) - 0.6) < 1e-9, "duplicate deducts nothing");
  assert.equal(getBel.ok, true);
  assert.ok(getBel.dimensions, "get returns dimensions");
  assert.ok(Math.abs((getBel.dimensions?.trust.strength ?? 0) - 0.6) < 1e-9, "trust reads 0.6");
  assert.equal(getBel.dimensions?.trust.proofCount, 2, "trust proofCount counts the two supports");
  assert.equal(getBel.dimensions?.safety.proofCount, 0, "empty safety reads 0 proofs");
  assert.equal(getBel.dimensions?.safety.uncertainty, 1, "empty safety reads uncertainty 1");
  assert.ok(
    !JSON.stringify(getBel).includes("昨晚难过的时候第一个想到的就是你"),
    "get never returns the full verbatim quote",
  );
  assert.ok(
    (getBel.beliefs ?? []).some((b) => b.id === "BEL_TRUST_001"),
    "get lists the belief (id + statement + numbers, no evidence text)",
  );
});

const statusBel = ctxBel.registeredTools.find(
  (t) => t.name === "memory_status",
) as unknown as {
  execute: (args: Record<string, unknown>) => Promise<{
    ok: boolean;
    beliefs?: number;
    beliefDimensions?: Record<string, { strength: number; proofCount: number }>;
  }>;
};
const statusBelRes = await statusBel.execute({});
check("0.4.0 item 2: memory_status shows beliefs + three dimensions", () => {
  assert.equal(statusBelRes.ok, true);
  assert.equal(statusBelRes.beliefs, 1, "status counts the belief");
  assert.ok(
    Math.abs((statusBelRes.beliefDimensions?.trust.strength ?? 0) - 0.6) < 1e-9,
    "status shows the trust value",
  );
  assert.equal(statusBelRes.beliefDimensions?.trust.proofCount, 2);
});

// Turn 2+ refresh: a memory-cue pre-step re-runs recall and the
// refreshed context must carry the same belief line as the turn-1
// append (the shell's formatRecallBlock call, not just core.recall).
await ctxBel.emit(
  "agent/pre-step",
  decisionBel("s-bel", "夏柠柒，你还记得昨晚难过的时候吗"),
);
check("0.4.0 item 2: turn-2 refresh context carries the belief line", () => {
  const rec = ctxBel
    .agentCtx("s-bel")
    .contexts.filter((c) => c.name === "memory-plugin:recall");
  assert.ok(rec.length >= 1, "a recall context was registered");
  const text = rec.map((c) => c.text).join("\n");
  assert.ok(
    text.includes("关系：信任 0.6（证据 2 条）"),
    `belief line rides the refresh (got: ${JSON.stringify(text)})`,
  );
});

const refusedBel = await beliefBel.execute(
  { action: "get" },
  { agent: { session: { id: "s-never-triggered" } } },
);
const badActionBel = await beliefBel.execute({ action: "dance" }, execBel);
check("0.4.0 item 2: memory_belief refuses in a task window; unknown action is an error", () => {
  assert.equal(refusedBel.ok, false, "task window gets no belief read or write");
  assert.equal(badActionBel.ok, false, "unknown action is rejected");
  const stored = JSON.parse(readFileSync(join(dirBel, "beliefs.json"), "utf8")) as {
    beliefs: Array<unknown>;
  };
  assert.equal(stored.beliefs.length, 1, "refused calls write nothing");
});

{
  const dirBelOld = mkdtempSync(join(tmpdir(), "memory-plugin-belief-old-"));
  writeFileSync(join(dirBelOld, "MEMORY.md"), fixtureMemory, "utf8");
  const ctxBelOld = new MockContext(dirBelOld);
  apply(ctxBelOld as never, { dataDir: dirBelOld } as never);
  await sleep(50);
  const beliefOld = ctxBelOld.registeredTools.find(
    (t) => t.name === "memory_belief",
  ) as unknown as {
    execute: (args: Record<string, unknown>, exec?: unknown) => Promise<BeliefToolResult>;
  };
  await ctxBelOld.emit("agent/created", { agent: { id: "s-bel-old" } });
  await ctxBelOld.emit("agent/pre-step", {
    agent: { id: "s-bel-old", ctx: ctxBelOld.agentCtx("s-bel-old") },
    messages: [{ role: "user", content: "夏柠柒", source: { kind: "user" } }],
  });
  const getOld = await beliefOld.execute(
    { action: "get" },
    { agent: { session: { id: "s-bel-old" } } },
  );
  check("0.4.0 item 2: old data — no beliefs.json starts empty, get works", () => {
    assert.equal(getOld.ok, true);
    assert.deepEqual(getOld.dimensions?.trust, { strength: 0, uncertainty: 1, proofCount: 0, beliefs: 0 });
    assert.deepEqual(getOld.beliefs, []);
    assert.equal(existsSync(join(dirBelOld, "beliefs.json")), false, "get does not create the file");
  });
}

// ---- 0.4.0 item 3: memory_reflect tool -----------------------------
// Fresh dir/ctx; six heavy "累" entries recorded through
// memory_remember (the same path the model uses), so the gate
// opens on real log text: 6 x 0.9 = 5.4 >= 5.
const dirRef = mkdtempSync(join(tmpdir(), "memory-plugin-reflect-"));
writeFileSync(join(dirRef, "MEMORY.md"), fixtureMemory, "utf8");
const ctxRef = new MockContext(dirRef);
apply(ctxRef as never, { dataDir: dirRef } as never);
await sleep(50); // tools register async (loadDefineTool)
const decisionRef = (id: string, content: string): Record<string, unknown> => ({
  agent: { id, ctx: ctxRef.agentCtx(id) },
  messages: [{ role: "user", content, source: { kind: "user" } }],
});
await ctxRef.emit("agent/created", { agent: { id: "s-ref" } });
await ctxRef.emit("agent/pre-step", decisionRef("s-ref", "夏柠柒"));
const execRef = { agent: { session: { id: "s-ref" } } };
type ReflectToolResult = {
  ok: boolean;
  triggered: boolean;
  reflectionId?: string;
  text?: string;
  error?: string;
  reasons?: string[];
};
const rememberRef = ctxRef.registeredTools.find(
  (t) => t.name === "memory_remember",
) as unknown as {
  execute: (
    args: Record<string, unknown>,
    exec?: unknown,
  ) => Promise<{ ok: boolean; id: string }>;
};
const reflectRef = ctxRef.registeredTools.find(
  (t) => t.name === "memory_reflect",
) as unknown as {
  execute: (
    args: Record<string, unknown>,
    exec?: unknown,
  ) => Promise<ReflectToolResult>;
};
assert.ok(reflectRef, "memory_reflect is registered (10th tool)");
const refTexts = [
  "今天好累",
  "昨天也说好累",
  "前天累得不想动",
  "今天又说累",
  "累得睡不着",
  "好累，什么都不想干",
];
const refIds: string[] = [];
for (const text of refTexts) {
  const r = await rememberRef.execute({ text }, execRef);
  assert.ok(r.ok, `remember ${text}`);
  refIds.push(r.id);
}
const readFragmentsRef = (): Array<Record<string, unknown>> => {
  const f = join(dirRef, "fragments.json");
  if (!existsSync(f)) return [];
  return (
    JSON.parse(readFileSync(f, "utf8")) as {
      fragments: Array<Record<string, unknown>>;
    }
  ).fragments;
};

const gateOpen = await reflectRef.execute({}, execRef);
check("0.4.0 item 3: memory_reflect gate opens above the floor and hands the model the prompt", () => {
  assert.equal(gateOpen.ok, true);
  assert.equal(gateOpen.triggered, true, "6 heavy in 24 h clears the floor");
  assert.ok(
    (gateOpen.text ?? "").includes("今天好累"),
    "the prompt carries the triggering memories",
  );
  assert.ok(
    (gateOpen.text ?? "").includes("你自己决定"),
    "the prompt says the decision is the model's",
  );
  assert.equal(gateOpen.reflectionId, undefined, "the gate call saves nothing, so no id");
  assert.equal(readFragmentsRef().length, 0, "the gate call writes nothing");
});

const saveRef = await reflectRef.execute(
  {
    text: "他最近压力大，「今天好累」「昨天也说好累」",
    sourceIds: refIds.slice(0, 3),
  },
  execRef,
);
check("0.4.0 item 3: memory_reflect saves the conclusion as a reflection fragment", () => {
  assert.equal(saveRef.ok, true, JSON.stringify(saveRef));
  assert.equal(saveRef.triggered, true);
  assert.ok(
    (saveRef.reflectionId ?? "").startsWith("refl-"),
    "save returns the reflection id",
  );
  assert.equal(saveRef.text, "他最近压力大，「今天好累」「昨天也说好累」");
  const stored = readFragmentsRef();
  assert.equal(stored.length, 1, "one fragment persisted");
  assert.equal(stored[0].type, "reflection", "stored as a reflection fragment");
  assert.equal(stored[0].id, saveRef.reflectionId);
});

// The three reflected entries no longer count, but the remaining
// three unreflected heavies still open the gate (终版 WP5: no
// arithmetic floor — the model decides whether a second reflection
// is worth it).
const gateAfterSave = await reflectRef.execute({}, execRef);
check("0.4.0 item 3: memory_reflect gate still offers the unreflected entries", () => {
  assert.equal(gateAfterSave.triggered, true, "unreflected entries keep the gate open");
  assert.equal(typeof gateAfterSave.text, "string", "the prompt lists what is left");
});

// Reopen the gate with six fresh heavy entries, then try to save a
// fabricated quote: the whole reflection is void, nothing is stored.
const refTexts2 = [
  "今天累坏了",
  "昨天累得够呛",
  "前天也累",
  "今天还是累",
  "累得不想说话",
  "好累啊好累啊",
];
const refIds2: string[] = [];
for (const text of refTexts2) {
  const r = await rememberRef.execute({ text }, execRef);
  assert.ok(r.ok, `remember ${text}`);
  refIds2.push(r.id);
}
const gateOpen2 = await reflectRef.execute({}, execRef);
assert.equal(gateOpen2.triggered, true, "fresh entries reopen the gate");
const fabricatedSave = await reflectRef.execute(
  {
    text: "他最近压力大，「今天一点都不累」",
    sourceIds: refIds2.slice(0, 3),
  },
  execRef,
);
const noSourceSave = await reflectRef.execute(
  { text: "他最近压力大，「今天累坏了」" },
  execRef,
);
check("0.4.0 item 3: memory_reflect rejects a fabricated quote — whole reflection void, nothing stored", () => {
  assert.equal(fabricatedSave.ok, false, "fabricated quote must be rejected");
  assert.ok((fabricatedSave.reasons?.length ?? 0) > 0, "rejection carries reasons");
  assert.ok(
    (fabricatedSave.reasons ?? []).some((r) => r.includes("今天一点都不累")),
    "the reason names the fabricated quote",
  );
  assert.equal(readFragmentsRef().length, 1, "rejected save stores nothing");
  assert.equal(noSourceSave.ok, false, "save without sourceIds is refused");
  assert.ok(
    (noSourceSave.error ?? "").includes("sourceIds"),
    "the error tells the model to supply sourceIds",
  );
  assert.equal(readFragmentsRef().length, 1, "refused save stores nothing");
});

// 0.4.1 follow-up: sources must come from the CURRENT gate.
// refIds[0] is a real persona entry and the quote is verbatim
// from it — but it was already reflected in the first save, so
// it is not in the gate the model was just shown (refIds2).
// The save must be refused before any quote check, nothing stored.
const staleSourceSave = await reflectRef.execute(
  {
    text: "他最近压力大，「今天好累」",
    sourceIds: [refIds[0]],
  },
  execRef,
);
check("0.4.1 follow-up: memory_reflect refuses a source outside the current gate — even a real persona entry with a verbatim quote", () => {
  assert.equal(staleSourceSave.ok, false, "an out-of-gate source is refused");
  assert.ok(
    (staleSourceSave.error ?? "").includes("不在本次反思提示里"),
    "the error names the gate rule",
  );
  assert.equal(readFragmentsRef().length, 1, "refused save stores nothing");
});

const refusedRefGate = await reflectRef.execute(
  {},
  { agent: { session: { id: "s-never-triggered" } } },
);
const refusedRefSave = await reflectRef.execute(
  {
    text: "他最近压力大，「今天累坏了」",
    sourceIds: refIds2.slice(0, 3),
  },
  { agent: { session: { id: "s-never-triggered" } } },
);
check("0.4.0 item 3: memory_reflect refuses in a task window — gate and save alike, nothing written", () => {
  assert.equal(refusedRefGate.ok, false, "task window gets no gate check");
  assert.equal(refusedRefGate.triggered, false);
  assert.equal(refusedRefSave.ok, false, "task window gets no save");
  assert.equal(readFragmentsRef().length, 1, "refused calls write nothing");
});

// Below the floor: one heavy entry (0.9 < 5) — no prompt, no model
// call. Five more reopen it. The dir has no fragments.json at all,
// so this also covers old data (no reflection rows, no crash).
const dirRefLow = mkdtempSync(join(tmpdir(), "memory-plugin-reflect-low-"));
writeFileSync(join(dirRefLow, "MEMORY.md"), fixtureMemory, "utf8");
const ctxRefLow = new MockContext(dirRefLow);
apply(ctxRefLow as never, { dataDir: dirRefLow } as never);
await sleep(50);
await ctxRefLow.emit("agent/created", { agent: { id: "s-low" } });
await ctxRefLow.emit("agent/pre-step", {
  agent: { id: "s-low", ctx: ctxRefLow.agentCtx("s-low") },
  messages: [{ role: "user", content: "夏柠柒", source: { kind: "user" } }],
});
const execLow = { agent: { session: { id: "s-low" } } };
const rememberLow = ctxRefLow.registeredTools.find(
  (t) => t.name === "memory_remember",
) as unknown as {
  execute: (
    args: Record<string, unknown>,
    exec?: unknown,
  ) => Promise<{ ok: boolean; id: string }>;
};
const reflectLow = ctxRefLow.registeredTools.find(
  (t) => t.name === "memory_reflect",
) as unknown as {
  execute: (
    args: Record<string, unknown>,
    exec?: unknown,
  ) => Promise<ReflectToolResult>;
};
const lowFirst = await rememberLow.execute({ text: "今天好累" }, execLow);
assert.ok(lowFirst.ok, "low-dir first entry recorded");
const gateLow = await reflectLow.execute({}, execLow);
check("终版 WP5: one new entry is enough to open the gate", () => {
  assert.equal(gateLow.ok, true);
  assert.equal(gateLow.triggered, true, "one entry opens the gate (no arithmetic floor)");
  assert.equal(typeof gateLow.text, "string", "a prompt is built");
  assert.equal(existsSync(join(dirRefLow, "fragments.json")), false, "a prompt means no write");
});
for (const text of refTexts.slice(1)) {
  const r = await rememberLow.execute({ text }, execLow);
  assert.ok(r.ok, `remember ${text}`);
}
const gateLowOpen = await reflectLow.execute({}, execLow);
check("0.4.0 item 3: old data — no fragments.json starts empty, the gate still opens at six heavies", () => {
  assert.equal(gateLowOpen.triggered, true, "six heavies reopen the gate on old data");
  assert.ok((gateLowOpen.text ?? "").includes("今天好累"));
});

// Coordinator fix: the save call's text/sourceIds must be declared
// in the schema (optional), not just read leniently — a strict host
// strips undeclared parameters, which would have made saving
// unreachable. The gate call still passes {}.
check("0.4.0 item 3: memory_reflect schema declares optional text and sourceIds for the save call", () => {
  const tool = ctxRefLow.registeredTools.find(
    (t) => t.name === "memory_reflect",
  ) as unknown as {
    parameters: {
      type?: string;
      properties?: Record<string, unknown>;
      required?: string[];
    };
  };
  assert.ok(tool, "memory_reflect is registered");
  assert.equal(tool.parameters?.type, "object");
  assert.ok("text" in (tool.parameters?.properties ?? {}), "text is declared");
  assert.ok("sourceIds" in (tool.parameters?.properties ?? {}), "sourceIds is declared");
  assert.ok(!(tool.parameters?.required ?? []).includes("text"), "text is optional — {} still gates");
  assert.ok(!(tool.parameters?.required ?? []).includes("sourceIds"), "sourceIds is optional — {} still gates");
});

// 0.4.3 reflection gate snapshot (tool level): the save
// validates against the snapshot of the gate prompt the model
// was shown, not a freshly recomputed gate. The clock is stubbed
// (Date.now), never a real 24 h wait: six heavies recorded at
// T0, gate at T0, then the clock jumps to T0 + 25 h before the
// model hands the conclusion back — a fresh recompute at
// T0 + 25 h would find no sources in the window and refuse.
{
  const dirSnap = mkdtempSync(join(tmpdir(), "memory-plugin-reflect-snap-"));
  writeFileSync(join(dirSnap, "MEMORY.md"), fixtureMemory, "utf8");
  const ctxSnap = new MockContext(dirSnap);
  apply(ctxSnap as never, { dataDir: dirSnap } as never);
  await sleep(50);
  await ctxSnap.emit("agent/created", { agent: { id: "s-snap" } });
  await ctxSnap.emit("agent/pre-step", {
    agent: { id: "s-snap", ctx: ctxSnap.agentCtx("s-snap") },
    messages: [{ role: "user", content: "夏柠柒", source: { kind: "user" } }],
  });
  const execSnap = { agent: { session: { id: "s-snap" } } };
  const rememberSnap = ctxSnap.registeredTools.find(
    (t) => t.name === "memory_remember",
  ) as unknown as {
    execute: (
      args: Record<string, unknown>,
      exec?: unknown,
    ) => Promise<{ ok: boolean; id: string }>;
  };
  const reflectSnap = ctxSnap.registeredTools.find(
    (t) => t.name === "memory_reflect",
  ) as unknown as {
    execute: (
      args: Record<string, unknown>,
      exec?: unknown,
    ) => Promise<ReflectToolResult>;
  };
  const readFragmentsSnap = (): Array<Record<string, unknown>> => {
    const f = join(dirSnap, "fragments.json");
    if (!existsSync(f)) return [];
    return (
      JSON.parse(readFileSync(f, "utf8")) as {
        fragments: Array<Record<string, unknown>>;
      }
    ).fragments;
  };
  const realNow = Date.now;
  let fakeNow = realNow();
  Date.now = () => fakeNow;
  try {
    const snapIds: string[] = [];
    for (const text of refTexts) {
      const r = await rememberSnap.execute({ text }, execSnap);
      assert.ok(r.ok, `remember ${text}`);
      snapIds.push(r.id);
    }
    const gateSnap = await reflectSnap.execute({}, execSnap);
    assert.equal(gateSnap.triggered, true, "gate opens at T0");
    // 25 h pass before the model hands the conclusion back: every
    // source has crossed the 24 h boundary by now.
    fakeNow += 25 * 60 * 60 * 1000;
    const saveSnap = await reflectSnap.execute(
      {
        text: "他最近压力大，「今天好累」「昨天也说好累」",
        sourceIds: snapIds.slice(0, 3),
      },
      execSnap,
    );
    check("0.4.3 reflection snapshot: save succeeds after its sources crossed the 24 h boundary", () => {
      assert.equal(saveSnap.ok, true, JSON.stringify(saveSnap));
      assert.ok(
        (saveSnap.reflectionId ?? "").startsWith("refl-"),
        "save returns the reflection id",
      );
      assert.equal(readFragmentsSnap().length, 1, "one reflection fragment persisted");
      assert.equal(
        readFragmentsSnap()[0].id,
        saveSnap.reflectionId,
        "stored fragment is the saved one",
      );
    });
  } finally {
    Date.now = realNow;
  }
}

// The reflection prompt rides the daily-review context: a restored
// persona session with six heavy entries from yesterday gets its
// code review at agent/created, and the first pre-step hands the
// model the reflection prompt with yesterday's messages.
// 0.4.6 (0.4.5 audit new issue 3): this block used
// `Date.now() - 20h` for "yesterday's memory" — at 20:00–24:00
// local that lands today 00:00–04:00, so yesterdayEntries()
// returns 0 and the suite aborts. The clock is pinned to a fixed
// morning instead (like core's local()): yesterday 14:00 is
// yesterday at any hour, and the 24 h reflection gate still sees
// the entries (20 h old). Restored in finally, like the snapshot
// block above.
{
  const refCtxRealNow = Date.now;
  const refCtxFakeNow = new Date(2026, 10, 7, 10, 0, 0, 0).getTime();
  Date.now = () => refCtxFakeNow;
  try {
  const dirRefCtx = mkdtempSync(join(tmpdir(), "memory-plugin-reflect-ctx-"));
  writeFileSync(join(dirRefCtx, "MEMORY.md"), fixtureMemory, "utf8");
  const coreRefCtx = new MemoryCore({ dataDir: dirRefCtx });
  const yest = Date.now() - 20 * 60 * 60 * 1000;
  for (let i = 0; i < 6; i++) {
    coreRefCtx.record({
      role: "user",
      text: refTexts[i],
      window: "persona",
      importance: "heavy",
      sessionId: "s-ref2",
      ts: yest + i * 60 * 1000,
    });
  }
  writeFileSync(
    join(dirRefCtx, "persona-sessions.json"),
    JSON.stringify(["s-ref2"]),
    "utf8",
  );
  const ctxRef2 = new MockContext(dirRefCtx);
  apply(ctxRef2 as never, { dataDir: dirRefCtx } as never);
  await sleep(50);
  await ctxRef2.emit("agent/created", { agent: { id: "s-ref2" } });
  await ctxRef2.emit("agent/pre-step", {
    agent: { id: "s-ref2", ctx: ctxRef2.agentCtx("s-ref2") },
    messages: [{ role: "user", content: "夏柠柒，在吗", source: { kind: "user" } }],
  });
  check("0.4.0 item 3: restored session's first turn registers the review context with the reflection prompt", () => {
    const reviewCtx = ctxRef2
      .agentCtx("s-ref2")
      .contexts.filter((c) => c.name === "memory-plugin:daily-review");
    assert.ok(reviewCtx.length >= 1, "a daily-review context was registered");
    const text = reviewCtx.map((c) => c.text).join("\n");
    assert.ok(text.includes("memory_reflect"), "review context carries the reflection prompt");
    assert.ok(text.includes("今天好累"), "review context carries the triggering memories");
    assert.ok(text.includes("你自己决定"), "review context says the decision is the model's");
  });
  for (const dispose of ctxRef2.disposers) dispose();
  } finally {
    Date.now = refCtxRealNow;
  }
}

// 0.4.6 (0.4.5 audit new issue 4): entriesByIds throwing inside
// registerModelReview degrades to no recent section, never breaks
// the round. Same shape as the reflect-ctx block above, but
// MemoryCore.prototype.entriesByIds is stubbed to throw between
// agent/created (which computes the review and its recent ids)
// and the first pre-step (which resolves those ids to entries).
// The stub is on the prototype, so the shell's own core instance
// — created inside apply(), unreachable from the test — hits it
// too. Restored in finally, with the clock and console.warn.
{
  const dir4 = mkdtempSync(join(tmpdir(), "memory-plugin-review-entriesbyids-"));
  writeFileSync(join(dir4, "MEMORY.md"), fixtureMemory, "utf8");
  const core4 = new MemoryCore({ dataDir: dir4 });
  const realNow4 = Date.now;
  const fakeNow4 = new Date(2026, 10, 7, 10, 0, 0, 0).getTime();
  Date.now = () => fakeNow4;
  const origEntriesByIds = MemoryCore.prototype.entriesByIds;
  const warns4: string[] = [];
  const origWarn4 = console.warn;
  try {
    const yest4 = Date.now() - 20 * 60 * 60 * 1000;
    for (let i = 0; i < 6; i++) {
      core4.record({
        role: "user",
        text: refTexts[i],
        window: "persona",
        importance: "heavy",
        sessionId: "s-ref4",
        ts: yest4 + i * 60 * 1000,
      });
    }
    writeFileSync(
      join(dir4, "persona-sessions.json"),
      JSON.stringify(["s-ref4"]),
      "utf8",
    );
    const ctx4 = new MockContext(dir4);
    apply(ctx4 as never, { dataDir: dir4 } as never);
    await sleep(50);
    await ctx4.emit("agent/created", { agent: { id: "s-ref4" } });
    // From here on the id-resolution read fails.
    MemoryCore.prototype.entriesByIds = (): never => {
      throw new Error("entriesByIds boom");
    };
    console.warn = (...args: unknown[]) => {
      warns4.push(args.map(String).join(" "));
    };
    const fake4 = { kind: "proceed" };
    const ret4 = await (ctx4.preStep as Handler).handler(
      {
        agent: { id: "s-ref4", ctx: ctx4.agentCtx("s-ref4") },
        messages: [{ role: "user", content: "夏柠柒，在吗", source: { kind: "user" } }],
      },
      async () => fake4,
    );
    check("0.4.6 new issue 4: entriesByIds throws -> review context still registers, round survives", () => {
      assert.equal(ret4, fake4, "pre-step still returns next()'s value");
      const reviewCtx = ctx4
        .agentCtx("s-ref4")
        .contexts.filter((c) => c.name === "memory-plugin:daily-review");
      assert.ok(reviewCtx.length >= 1, "a daily-review context was registered despite the failed read");
      const text = reviewCtx.map((c) => c.text).join("\n");
      assert.ok(text.includes("昨天的对话"), "yesterday's section is still in the prompt");
      assert.ok(text.includes("今天好累"), "yesterday's entries are still listed");
      assert.ok(
        text.includes("今天没有值得注意的新对话"),
        "the merged recent section degrades to its empty note instead of breaking the round",
      );
      assert.ok(
        warns4.some((w) => w.includes("最近记忆读取失败")),
        "a warn names the failed read",
      );
    });
    for (const dispose of ctx4.disposers) dispose();
  } finally {
    console.warn = origWarn4;
    MemoryCore.prototype.entriesByIds = origEntriesByIds;
    Date.now = realNow4;
  }
}

// 0.4.7 (0.4.6 audit new issue 1 + 0.4.3 item 8): the audit's
// scenario end to end — 25 fresh 24 h memories, the top one
// already reflected. The merged review section shows it in full
// AND marked; a save citing it is refused, and a save citing an
// unmarked shown entry still succeeds after the entries cross
// the 24 h boundary, because the review path now sets the gate
// snapshot instead of recomputing.
{
  const dirR7 = mkdtempSync(join(tmpdir(), "memory-plugin-review-reflect-mark-"));
  writeFileSync(join(dirR7, "MEMORY.md"), fixtureMemory, "utf8");
  const coreR7 = new MemoryCore({ dataDir: dirR7 });
  const realNowR7 = Date.now;
  const fakeNowR7 = new Date(2026, 10, 7, 10, 0, 0, 0).getTime();
  Date.now = () => fakeNowR7;
  try {
    const yestR7 = Date.now() - 20 * 60 * 60 * 1000;
    const idsR7: string[] = [];
    for (let i = 0; i < 25; i++) {
      const e = coreR7.record({
        role: "user",
        text: `今天好累${i}，聊了好多事`,
        window: "persona",
        importance: "heavy",
        sessionId: "s-r7",
        ts: yestR7 + i * 60 * 1000,
      });
      idsR7.push(e.id);
    }
    const savedR7 = coreR7.saveReflection("他最近很累，「今天好累0」。", [idsR7[0]]);
    assert.equal(savedR7.ok, true, "setup: the first reflection saves");
    // saveReflection does not flush — the shell's core (created
    // inside apply) must read the fragment from fragments.json.
    coreR7.flush();
    writeFileSync(
      join(dirR7, "persona-sessions.json"),
      JSON.stringify(["s-r7"]),
      "utf8",
    );
    const ctxR7 = new MockContext(dirR7);
    apply(ctxR7 as never, { dataDir: dirR7 } as never);
    await sleep(50);
    await ctxR7.emit("agent/created", { agent: { id: "s-r7" } });
    await ctxR7.emit("agent/pre-step", {
      agent: { id: "s-r7", ctx: ctxR7.agentCtx("s-r7") },
      messages: [{ role: "user", content: "夏柠柒，在吗", source: { kind: "user" } }],
    });
    const reflectToolR7 = ctxR7.registeredTools.find(
      (t) => t.name === "memory_reflect",
    ) as {
      execute: (args: unknown, exec?: unknown) => Promise<Record<string, unknown>>;
    };
    check("0.4.7 new issue 1: merged review section marks the reflected entry; the prompt explains the mark", () => {
      const reviewCtx = ctxR7
        .agentCtx("s-r7")
        .contexts.filter((c) => c.name === "memory-plugin:daily-review");
      assert.ok(reviewCtx.length >= 1, "a daily-review context was registered");
      const text = reviewCtx.map((c) => c.text).join("\n");
      const merged = text.slice(text.indexOf("最近 24 小时里值得注意的几条"));
      const reflectedLine = merged
        .split("\n")
        .find((l) => l.includes(`[${idsR7[0]}]`));
      assert.ok(
        reflectedLine?.includes("（本次反思不可引用）"),
        "the reflected entry is shown in full AND marked not citable",
      );
      assert.ok(
        text.includes("带“本次反思不可引用”标记的条目这次不能当引用来源"),
        "the reflection instruction explains the mark",
      );
    });
    // A save citing the marked entry is refused — the prompt told
    // the model not to cite it, and the snapshot enforces it. A
    // failed save keeps the snapshot for the next attempt.
    const refusedR7 = await reflectToolR7.execute(
      { text: "他最近很累，「今天好累0」。", sourceIds: [idsR7[0]] },
      { agent: { session: { id: "s-r7" } } },
    );
    check("0.4.7 new issue 1: citing the marked entry is refused", () => {
      assert.equal(refusedR7.ok, false, "the marked source is refused");
      assert.ok(
        String(refusedR7.error ?? "").includes("不在本次反思提示里"),
        "the refusal names the prompt",
      );
    });
    // Item 8: advance the clock 5 h — the entries are now 25 h
    // old, so a freshly recomputed gate would be empty and
    // refuse. The review-path snapshot must carry the save.
    Date.now = () => fakeNowR7 + 5 * 60 * 60 * 1000;
    const lateR7 = await reflectToolR7.execute(
      { text: "他最近压力大，「今天好累1」。", sourceIds: [idsR7[1]] },
      { agent: { session: { id: "s-r7" } } },
    );
    check("0.4.7 (0.4.3 item 8): the review-path gate snapshot carries a save past the 24 h boundary", () => {
      assert.equal(
        lateR7.ok,
        true,
        "the unmarked shown entry saves via the snapshot, not a recompute",
      );
    });
    for (const dispose of ctxR7.disposers) dispose();
  } finally {
    Date.now = realNowR7;
  }
}

// 0.4.7 (0.4.6 audit new issue 2): the standalone memory_proact
// gate prompt tells the model about the overflow — 200 memories
// in 24 h: 20 shown, 20 as summaries, 160 counted.
{
  const dirP7 = mkdtempSync(join(tmpdir(), "memory-plugin-proact-overflow-"));
  writeFileSync(join(dirP7, "MEMORY.md"), fixtureMemory, "utf8");
  const coreP7 = new MemoryCore({ dataDir: dirP7 });
  const nowP7 = Date.now();
  for (let i = 0; i < 200; i++) {
    coreP7.record({
      role: "user",
      text: `今天好累${i}，聊了好多事`,
      window: "persona",
      importance: "heavy",
      sessionId: "s-p7",
      ts: nowP7 - i * 60_000,
    });
  }
  writeFileSync(
    join(dirP7, "persona-sessions.json"),
    JSON.stringify(["s-p7"]),
    "utf8",
  );
  const ctxP7 = new MockContext(dirP7);
  apply(ctxP7 as never, { dataDir: dirP7 } as never);
  await sleep(50);
  await ctxP7.emit("agent/created", { agent: { id: "s-p7" } });
  await ctxP7.emit("agent/pre-step", {
    agent: { id: "s-p7", ctx: ctxP7.agentCtx("s-p7") },
    messages: [{ role: "user", content: "夏柠柒，在吗", source: { kind: "user" } }],
  });
  const proactToolP7 = ctxP7.registeredTools.find(
    (t) => t.name === "memory_proact",
  ) as {
    execute: (args: unknown, exec?: unknown) => Promise<Record<string, unknown>>;
  };
  const gateP7 = await proactToolP7.execute(
    {},
    { agent: { session: { id: "s-p7" } } },
  );
  check("0.4.7 new issue 2: the proact gate prompt counts the overflow", () => {
    assert.equal(gateP7.ok, true, "a prompt is issued");
    const prompt = String(gateP7.prompt ?? "");
    assert.ok(prompt.includes("另有 160 条未列出"), "the gate prompt counts the hidden overflow");
    assert.equal(
      prompt.split("（摘要）").length - 1,
      20,
      "20 overflow entries are listed as summaries",
    );
  });
  for (const dispose of ctxP7.disposers) dispose();
}

// ---- 0.4.0 item 7: memory_proact tool ----------------------------
// Fresh dir/ctx; two entries recorded through memory_remember (the
// same path the model uses), so the gate prompt carries real log
// text from the last 24 h. Two-call shape, like memory_reflect:
// {} gates + prompts, the second call carries the decision.
const dirPro = mkdtempSync(join(tmpdir(), "memory-plugin-proact-"));
writeFileSync(join(dirPro, "MEMORY.md"), fixtureMemory, "utf8");
const ctxPro = new MockContext(dirPro);
apply(ctxPro as never, { dataDir: dirPro } as never);
await sleep(50); // tools register async (loadDefineTool)
await ctxPro.emit("agent/created", { agent: { id: "s-pro" } });
await ctxPro.emit("agent/pre-step", {
  agent: { id: "s-pro", ctx: ctxPro.agentCtx("s-pro") },
  messages: [{ role: "user", content: "夏柠柒", source: { kind: "user" } }],
});
const execPro = { agent: { session: { id: "s-pro" } } };
type ProactToolResult = {
  ok: boolean;
  action?: Record<string, unknown> | null;
  prompt?: string;
  promptToken?: string;
  text?: string;
  reason?: string;
  error?: string;
};
const rememberPro = ctxPro.registeredTools.find(
  (t) => t.name === "memory_remember",
) as unknown as {
  execute: (
    args: Record<string, unknown>,
    exec?: unknown,
  ) => Promise<{ ok: boolean; id: string }>;
};
const proactRef = ctxPro.registeredTools.find(
  (t) => t.name === "memory_proact",
) as unknown as {
  execute: (
    args: Record<string, unknown>,
    exec?: unknown,
  ) => Promise<ProactToolResult>;
};
assert.ok(proactRef, "memory_proact is registered (12th tool)");
const proEntry1 = await rememberPro.execute(
  { text: "明天有考试，今晚得早点睡" },
  execPro,
);
assert.ok(proEntry1.ok, "remember proact entry 1");
const proEntry2 = await rememberPro.execute(
  { text: "考完想吃顿好的" },
  execPro,
);
assert.ok(proEntry2.ok, "remember proact entry 2");
const readLoopPro = (): Array<Record<string, unknown>> => {
  const f = join(dirPro, "loop.json");
  if (!existsSync(f)) return [];
  return (
    JSON.parse(readFileSync(f, "utf8")) as {
      pendingActions: Array<Record<string, unknown>>;
    }
  ).pendingActions;
};

const gatePro = await proactRef.execute({}, execPro);
check("0.4.1 item 7 (merge 2): memory_proact gate returns the prompt and its token, and stores no action", () => {
  assert.equal(gatePro.ok, true);
  assert.equal(gatePro.action, null, "the gate call stores no action");
  assert.ok(
    (gatePro.prompt ?? "").includes("明天有考试，今晚得早点睡"),
    "the prompt carries today's memory",
  );
  assert.ok(
    (gatePro.prompt ?? "").includes("不要为了主动而主动"),
    "the prompt says not to act for acting's sake",
  );
  assert.ok(
    (gatePro.prompt ?? "").includes("不行动是完全可以接受的回答"),
    "the prompt says not acting is fine",
  );
  assert.ok(
    (gatePro.prompt ?? "").includes(proEntry1.id),
    "the prompt carries the entry id for the trigger",
  );
  assert.ok(
    (gatePro.promptToken ?? "").startsWith("PROACT_"),
    "the gate returns a prompt token",
  );
  const loopAfterGate = JSON.parse(
    readFileSync(join(dirPro, "loop.json"), "utf8"),
  ) as {
    pendingActions: unknown[];
    lastJudgedAt: number;
    pendingPrompt?: { token: string; sourceIds: string[] };
  };
  assert.deepEqual(loopAfterGate.pendingActions, [], "the gate stores no action");
  assert.equal(
    loopAfterGate.lastJudgedAt,
    0,
    "issuing the prompt writes no lastJudgedAt",
  );
  assert.equal(
    loopAfterGate.pendingPrompt?.token,
    gatePro.promptToken,
    "the issued token is persisted",
  );
  assert.ok(
    loopAfterGate.pendingPrompt?.sourceIds.includes(proEntry1.id),
    "the persisted prompt lists the entry id",
  );
});

// channel "qq" is rejected before anything is stored — the
// placeholder must never let a qq action into loop.json.
const qqPro = await proactRef.execute(
  {
    act: true,
    judgment: "模型判断",
    actionText: "模型写的话",
    trigger: proEntry1.id,
    channel: "qq",
  },
  execPro,
);
check("0.4.0 item 7: memory_proact channel qq returns qq_not_connected and stores nothing", () => {
  assert.equal(qqPro.ok, false, "qq is an error, not a stored action");
  assert.equal(qqPro.error, "qq_not_connected", "the error names the missing connection");
  assert.equal(qqPro.action, null);
  assert.equal(readLoopPro().length, 0, "a rejected qq call stores nothing");
});

const savePro = await proactRef.execute(
  {
    act: true,
    judgment: "他明天有考试，今晚会紧张",
    actionText: "模型自己写的一句话",
    trigger: proEntry1.id,
    promptToken: gatePro.promptToken,
  },
  execPro,
);
check("0.4.0 item 7: memory_proact decision call stores the action and hands the words back", () => {
  assert.equal(savePro.ok, true, JSON.stringify(savePro));
  assert.ok(savePro.action, "the decision stores an action");
  assert.equal(savePro.action?.trigger, proEntry1.id, "the trigger is the entry id");
  assert.equal(savePro.action?.judgment, "他明天有考试，今晚会紧张");
  assert.equal(savePro.action?.actionText, "模型自己写的一句话");
  assert.equal(savePro.action?.channel, "session", "channel defaults to session");
  assert.equal(savePro.action?.status, "pending", "a fresh action is pending");
  assert.equal(savePro.text, "模型自己写的一句话", "the tool hands the model's words back for the chat");
  const stored = readLoopPro();
  assert.equal(stored.length, 1, "one action persisted in loop.json");
  assert.equal(stored[0].id, savePro.action?.id, "the persisted row is the returned action");
});

// The day's one action is spent: a second decision (another
// trigger) and a second gate call are both refused, with the
// daily-limit reason — and neither writes anything new.
const secondPro = await proactRef.execute(
  {
    act: true,
    judgment: "模型判断",
    actionText: "模型写的话",
    trigger: proEntry2.id,
  },
  execPro,
);
const gateAfterPro = await proactRef.execute({}, execPro);
check("0.4.0 item 7: memory_proact refuses a second action the same day — decision and gate alike", () => {
  assert.equal(secondPro.ok, true, "a refused decision is still ok:true — it just stores nothing");
  assert.equal(secondPro.action, null, "the second decision stores no action");
  assert.ok(
    (secondPro.reason ?? "").includes("今天已经主动过一次"),
    "the refusal names the daily limit",
  );
  assert.equal(gateAfterPro.action, null, "the gate after an action returns no prompt");
  assert.ok(
    (gateAfterPro.reason ?? "").includes("今天已经主动过一次"),
    "the gate refusal names the daily limit too",
  );
  assert.equal(readLoopPro().length, 1, "refused calls write nothing new");
});

// act:false and a malformed decision both mean "do nothing": no
// action, no crash. (Same dir, same day — the daily limit is
// already spent, but act:false must not even reach it: it returns
// action:null on its own merits.)
const noActPro = await proactRef.execute({ act: false }, execPro);
const malformedPro = await proactRef.execute(
  { act: true, judgment: "模型判断", trigger: proEntry2.id },
  execPro,
);
check("0.4.0 item 7: memory_proact act:false or a malformed decision stores nothing and never crashes", () => {
  assert.equal(noActPro.ok, true);
  assert.equal(noActPro.action, null, "act:false stores nothing");
  assert.equal(malformedPro.ok, true);
  assert.equal(malformedPro.action, null, "a decision without actionText stores nothing");
  assert.equal(readLoopPro().length, 1, "neither call writes anything");
});

const refusedProGate = await proactRef.execute(
  {},
  { agent: { session: { id: "s-never-triggered" } } },
);
const refusedProSave = await proactRef.execute(
  {
    act: true,
    judgment: "模型判断",
    actionText: "模型写的话",
    trigger: proEntry1.id,
  },
  { agent: { session: { id: "s-never-triggered" } } },
);
check("0.4.0 item 7: memory_proact refuses in a task window — gate and save alike, nothing written", () => {
  assert.equal(refusedProGate.ok, false, "task window gets no gate check");
  assert.equal(refusedProGate.action, null);
  assert.equal(refusedProSave.ok, false, "task window gets no save");
  assert.equal(readLoopPro().length, 1, "refused calls write nothing");
});

// Coordinator fix (same as memory_reflect): the decision fields
// must be declared in the schema (optional), not just read
// leniently — a strict host strips undeclared parameters, which
// would have made the second call unreachable. The gate call
// still passes {}.
check("0.4.1 item 7 (merge 2): memory_proact schema declares optional act/judgment/actionText/trigger/promptToken/channel", () => {
  const tool = ctxPro.registeredTools.find(
    (t) => t.name === "memory_proact",
  ) as unknown as {
    parameters: {
      type?: string;
      properties?: Record<string, unknown>;
      required?: string[];
    };
  };
  assert.ok(tool, "memory_proact is registered");
  assert.equal(tool.parameters?.type, "object");
  for (const field of ["act", "judgment", "actionText", "trigger", "promptToken", "channel"]) {
    assert.ok(field in (tool.parameters?.properties ?? {}), `${field} is declared`);
    assert.ok(!(tool.parameters?.required ?? []).includes(field), `${field} is optional — {} still gates`);
  }
});

// Old data: a fresh dir with no loop.json at all — the gate still
// opens on today's entries, and act:false on an empty day stores
// nothing and creates no file.
{
  const dirProOld = mkdtempSync(join(tmpdir(), "memory-plugin-proact-old-"));
  writeFileSync(join(dirProOld, "MEMORY.md"), fixtureMemory, "utf8");
  const ctxProOld = new MockContext(dirProOld);
  apply(ctxProOld as never, { dataDir: dirProOld } as never);
  await sleep(50);
  await ctxProOld.emit("agent/created", { agent: { id: "s-old" } });
  await ctxProOld.emit("agent/pre-step", {
    agent: { id: "s-old", ctx: ctxProOld.agentCtx("s-old") },
    messages: [{ role: "user", content: "夏柠柒", source: { kind: "user" } }],
  });
  const execOld = { agent: { session: { id: "s-old" } } };
  const rememberOld = ctxProOld.registeredTools.find(
    (t) => t.name === "memory_remember",
  ) as unknown as {
    execute: (
      args: Record<string, unknown>,
      exec?: unknown,
    ) => Promise<{ ok: boolean; id: string }>;
  };
  const proactOld = ctxProOld.registeredTools.find(
    (t) => t.name === "memory_proact",
  ) as unknown as {
    execute: (
      args: Record<string, unknown>,
      exec?: unknown,
    ) => Promise<ProactToolResult>;
  };
  const oldEntry = await rememberOld.execute({ text: "明天有考试，今晚得早点睡" }, execOld);
  assert.ok(oldEntry.ok, "old-dir entry recorded");
  const gateOld = await proactOld.execute({}, execOld);
  check("0.4.0 item 7: old data — no loop.json starts empty, the gate still opens on today's entries and issues a token", () => {
    assert.equal(gateOld.ok, true);
    assert.equal(gateOld.action, null);
    assert.ok((gateOld.prompt ?? "").includes("明天有考试，今晚得早点睡"));
    assert.ok(
      (gateOld.promptToken ?? "").startsWith("PROACT_"),
      "the gate issues a token on old data too",
    );
    const loopOld = JSON.parse(
      readFileSync(join(dirProOld, "loop.json"), "utf8"),
    ) as { pendingActions: unknown[]; pendingPrompt?: { token: string } };
    assert.deepEqual(loopOld.pendingActions, [], "the gate stores no action");
    assert.equal(loopOld.pendingPrompt?.token, gateOld.promptToken);
  });
  const noActOld = await proactOld.execute(
    { act: false, promptToken: gateOld.promptToken },
    execOld,
  );
  check("0.4.1 item 7 (merge 2): old data — act:false on a fresh dir stores nothing and voids the token", () => {
    assert.equal(noActOld.ok, true);
    assert.equal(noActOld.action, null);
    const loopOldAfter = JSON.parse(
      readFileSync(join(dirProOld, "loop.json"), "utf8"),
    ) as { pendingActions: unknown[]; pendingPrompt?: unknown };
    assert.deepEqual(loopOldAfter.pendingActions, [], "act:false stores nothing");
    assert.equal(
      loopOldAfter.pendingPrompt,
      undefined,
      "act:false voids the prompt token",
    );
  });
}

// ---- 0.4.1 merge (items 2 + 4): the token at the tool level --------
// A decision must carry the gate's token; a missing/wrong token, or
// a trigger the prompt never showed, stores nothing. act:false with
// the token voids it — the same token can never store afterwards.
// (Token expiry is covered at the core level with explicit clocks;
// the tool always uses Date.now().)
{
  const dirTok = mkdtempSync(join(tmpdir(), "memory-plugin-proact-token-"));
  writeFileSync(join(dirTok, "MEMORY.md"), fixtureMemory, "utf8");
  const ctxTok = new MockContext(dirTok);
  apply(ctxTok as never, { dataDir: dirTok } as never);
  await sleep(50);
  await ctxTok.emit("agent/created", { agent: { id: "s-tok" } });
  await ctxTok.emit("agent/pre-step", {
    agent: { id: "s-tok", ctx: ctxTok.agentCtx("s-tok") },
    messages: [{ role: "user", content: "夏柠柒", source: { kind: "user" } }],
  });
  const execTok = { agent: { session: { id: "s-tok" } } };
  const rememberTok = ctxTok.registeredTools.find(
    (t) => t.name === "memory_remember",
  ) as unknown as {
    execute: (
      args: Record<string, unknown>,
      exec?: unknown,
    ) => Promise<{ ok: boolean; id: string }>;
  };
  const proactTok = ctxTok.registeredTools.find(
    (t) => t.name === "memory_proact",
  ) as unknown as {
    execute: (
      args: Record<string, unknown>,
      exec?: unknown,
    ) => Promise<ProactToolResult>;
  };
  const readLoopTok = (): Array<Record<string, unknown>> => {
    const f = join(dirTok, "loop.json");
    if (!existsSync(f)) return [];
    return (
      JSON.parse(readFileSync(f, "utf8")) as {
        pendingActions: Array<Record<string, unknown>>;
      }
    ).pendingActions;
  };
  const tokEntry = await rememberTok.execute(
    { text: "明天有考试，今晚得早点睡" },
    execTok,
  );
  assert.ok(tokEntry.ok, "token-dir entry recorded");
  const gateTok = await proactTok.execute({}, execTok);
  // act:false with the token voids it; the same token then refuses.
  const noActTok = await proactTok.execute(
    { act: false, promptToken: gateTok.promptToken },
    execTok,
  );
  const deadTok = await proactTok.execute(
    {
      act: true,
      judgment: "模型判断",
      actionText: "模型写的话",
      trigger: tokEntry.id,
      promptToken: gateTok.promptToken,
    },
    execTok,
  );
  check("0.4.1 item 7 (merge 2): act:false voids its prompt token — the same token stores nothing afterwards", () => {
    assert.equal(noActTok.ok, true);
    assert.equal(noActTok.action, null, "act:false stores nothing");
    assert.equal(deadTok.ok, true);
    assert.equal(deadTok.action, null, "a voided token stores nothing");
    assert.equal(
      deadTok.reason,
      "proact_prompt_not_found",
      "the refusal names the missing prompt",
    );
    assert.equal(readLoopTok().length, 0, "no action was stored");
  });
  // A fresh gate issues a fresh token; decisions without one, with
  // a wrong one, or with a trigger outside the prompt are refused.
  const gateTok2 = await proactTok.execute({}, execTok);
  const noToken = await proactTok.execute(
    {
      act: true,
      judgment: "模型判断",
      actionText: "模型写的话",
      trigger: tokEntry.id,
    },
    execTok,
  );
  const wrongToken = await proactTok.execute(
    {
      act: true,
      judgment: "模型判断",
      actionText: "模型写的话",
      trigger: tokEntry.id,
      promptToken: "PROACT_bogus",
    },
    execTok,
  );
  const outsideTrigger = await proactTok.execute(
    {
      act: true,
      judgment: "模型判断",
      actionText: "模型写的话",
      trigger: "mem-never-shown",
      promptToken: gateTok2.promptToken,
    },
    execTok,
  );
  check("0.4.1 item 7 (merge 2): a decision without the token, with a wrong token, or with a trigger outside the prompt is refused", () => {
    assert.notEqual(
      gateTok2.promptToken,
      gateTok.promptToken,
      "a fresh gate issues a fresh token",
    );
    assert.equal(noToken.action, null, "no token stores nothing");
    assert.equal(noToken.reason, "proact_prompt_not_found");
    assert.equal(wrongToken.action, null, "a wrong token stores nothing");
    assert.equal(wrongToken.reason, "proact_prompt_not_found");
    assert.equal(outsideTrigger.action, null, "a trigger outside the prompt stores nothing");
    assert.equal(outsideTrigger.reason, "proact_trigger_not_in_prompt");
    assert.equal(readLoopTok().length, 0, "refused decisions store nothing");
  });
  // The right token stores — and issuing it spent no quota: the
  // gate before it and the store after it both ran on the same day.
  const saveTok = await proactTok.execute(
    {
      act: true,
      judgment: "他明天有考试，今晚会紧张",
      actionText: "模型自己写的一句话",
      trigger: tokEntry.id,
      promptToken: gateTok2.promptToken,
    },
    execTok,
  );
  check("0.4.1 item 7 (merge 2): the issued token stores the action; issuing the prompt spent no quota", () => {
    assert.equal(saveTok.ok, true, JSON.stringify(saveTok));
    assert.ok(saveTok.action, "the decision stores an action");
    assert.equal(saveTok.text, "模型自己写的一句话", "the tool hands the model's words back");
    assert.equal(readLoopTok().length, 1, "one action persisted");
  });
}

// ---- 0.4.0 item 5: spotlight rides the existing single recall —
// no extra model round, no extra tool call. The ☆ candidates and
// the prompt line travel inside the one recall the pre-step already
// runs; the pre-step must therefore trigger zero memory_search tool
// executions, before and after the change (counted, not assumed).
const dirSpot = mkdtempSync(join(tmpdir(), "memory-plugin-spotlight-"));
writeFileSync(join(dirSpot, "MEMORY.md"), fixtureMemory, "utf8");
const ctxSpot = new MockContext(dirSpot);
apply(ctxSpot as never, { dataDir: dirSpot } as never);
await sleep(50); // tools register async (loadDefineTool)
const decisionSpot = (id: string, content: string): Record<string, unknown> => ({
  agent: { id, ctx: ctxSpot.agentCtx(id) },
  messages: [{ role: "user", content, source: { kind: "user" } }],
});
// Seed one persona memory, the way the main flow does.
await ctxSpot.emit("agent/created", { agent: { id: "sp1" } });
await ctxSpot.emit("agent/pre-step", decisionSpot("sp1", "夏柠柒，在吗"));
await ctxSpot.emit("session/event", {
  type: "user/message",
  sessionId: "sp1",
  source: { kind: "user" },
  message: { content: "以后每周五查岗", source: { kind: "user" } },
});
const searchSpot = ctxSpot.tools.get("memory_search") as unknown as {
  execute: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
};
let searchCalls = 0;
const origSearchExecute = searchSpot.execute;
searchSpot.execute = async (args: Record<string, unknown>) => {
  searchCalls += 1;
  return origSearchExecute(args);
};

await ctxSpot.emit("agent/created", { agent: { id: "sp2" } });
const dSpot = decisionSpot("sp2", "夏柠柒，查岗的事还记得吗");
await ctxSpot.emit("agent/pre-step", dSpot);

check("0.4.0 item 5: one pre-step trigger makes zero memory_search tool calls and appends exactly once, with ☆ candidates", () => {
  assert.equal(searchCalls, 0, "pre-step never calls the memory_search tool");
  const msgs = dSpot.messages as Array<Record<string, unknown>>;
  assert.equal(msgs.length, 2, "exactly one append — the single recall");
  const text = (msgs[1].content as Array<{ text: string }>)[0].text;
  assert.ok(text.includes("查岗"), "recall carried");
  assert.ok(text.includes("☆"), "candidate marked ☆ in the append");
  assert.ok(text.includes("不用调工具"), "prompt line rides the same append");
  const rec = ctxSpot
    .agentCtx("sp2")
    .contexts.filter((c) => c.name === "memory-plugin:recall");
  assert.equal(rec.length, 0, "turn 1 registers no extra recall context (m16)");
});

// A direct tool call counts once; a following pre-step must add zero.
await searchSpot.execute({ query: "查岗" });
assert.equal(searchCalls, 1, "one direct tool call counts once");
const dSpot2 = decisionSpot("sp2", "你还记得查岗吗");
await ctxSpot.emit("agent/pre-step", dSpot2);

check("0.4.0 item 5: a pre-step after a direct search adds no further tool calls", () => {
  assert.equal(searchCalls, 1, "pre-step adds zero tool calls on top of the direct one");
});
for (const dispose of ctxSpot.disposers) dispose();

// ---- 0.5.0 step 4: memory_feedback (tool only, no UI) -----------
// Isolated dir + ctx: the wrong-feedback below invalidates a real
// entry, which must not disturb the main dir's later checks.
const dirFb = mkdtempSync(join(tmpdir(), "memory-plugin-feedback-"));
writeFileSync(join(dirFb, "MEMORY.md"), fixtureMemory, "utf8");
const ctxFb = new MockContext(dirFb);
apply(ctxFb as never, { dataDir: dirFb } as never);
await sleep(50);
const fbTools = (name: string) =>
  ctxFb.registeredTools.find((t) => t.name === name) as unknown as {
    execute: (
      args: Record<string, unknown>,
      exec?: unknown,
    ) => Promise<Record<string, unknown>>;
  };
const fbSearch = fbTools("memory_search");
const fbFragment = fbTools("memory_fragment");
const fbFeedback = fbTools("memory_feedback");
const fbStatus = fbTools("memory_status");

check("0.5.0 step 4: 17 tools register, memory_feedback is deferred (deferLoading)", () => {
  const names = ctxFb.registeredTools.map((t) => t.name as string);
  assert.equal(names.length, 17, `17 tools registered: ${names.join(",")}`);
  assert.ok(names.includes("memory_feedback"), "memory_feedback registered");
  const spec = ctxFb.registeredTools.find(
    (t) => t.name === "memory_feedback",
  ) as Record<string, unknown>;
  assert.equal(
    spec.deferLoading,
    true,
    "deferLoading survives compilation (description loads on demand, not every round)",
  );
});

const fbStatusRes = await fbStatus.execute({});
check("0.5.0 step 4: memory_status reports 17 tools by name", () => {
  assert.equal(fbStatusRes.ok, true);
  assert.equal(fbStatusRes.tools, 17);
  assert.ok(
    ((fbStatusRes.toolNames as string[]) ?? []).includes("memory_feedback"),
    `toolNames lists memory_feedback: ${JSON.stringify(fbStatusRes.toolNames)}`,
  );
});

// Mark a persona session and record one line through the real events.
await ctxFb.emit("agent/created", { agent: { id: "s-fb" } });
await ctxFb.emit("agent/pre-step", {
  agent: { id: "s-fb", ctx: ctxFb.agentCtx("s-fb") },
  messages: [
    { role: "user", content: "夏柠柒，我最喜欢喝酸梅汤", source: { kind: "user" } },
  ],
});
await ctxFb.emit("session/event", {
  type: "user/message",
  sessionId: "s-fb",
  source: { kind: "user" },
  message: {
    content: "夏柠柒，我最喜欢喝酸梅汤",
    source: { kind: "user" },
  },
});

const fbSearch1 = await fbSearch.execute({ query: "酸梅汤" });
const fbHitId = ((fbSearch1.hits as Array<Record<string, unknown>>)[0]?.id ??
  "") as string;
check("0.5.0 step 4: setup — the recorded line is searchable", () => {
  assert.ok(fbHitId.length > 0, "search finds the recorded line");
});

// A fragment on top of it, so the correct-feedback path has a
// provenance counter to move.
const fbFrag = await fbFragment.execute({
  sourceIds: [fbHitId],
  text: "他喜欢酸梅汤",
  tone: "喜欢",
  quotes: ["喜欢喝酸梅汤"],
});
check("0.5.0 step 4: setup — fragment created for the feedback loop", () => {
  assert.equal(fbFrag.ok, true, JSON.stringify(fbFrag));
});
const fbFragId = fbFrag.id as string;

const fbSearch2 = await fbSearch.execute({ query: "酸梅汤" });
const fbHit2 = (fbSearch2.hits as Array<Record<string, unknown>>).find(
  (h) => h.fragmentId === fbFragId,
);
const fbVerifiedBefore = (fbHit2?.verifyCount ?? 0) as number;
const fbCorrect = await fbFeedback.execute({
  entryId: fbHitId,
  feedback: "correct",
  fragmentId: fbFragId,
});
check("0.5.0 step 4: feedback correct counts as a verification", () => {
  assert.equal(fbCorrect.ok, true, JSON.stringify(fbCorrect));
  assert.equal(fbCorrect.feedback, "correct");
});
const fbSearch3 = await fbSearch.execute({ query: "酸梅汤" });
const fbHit3 = (fbSearch3.hits as Array<Record<string, unknown>>).find(
  (h) => h.fragmentId === fbFragId,
);
check("0.5.0 step 4: the same question re-asked shows the higher verification count", () => {
  assert.ok(fbHit3, "fragment hit still surfaces after correct feedback");
  assert.ok(
    ((fbHit3?.verifyCount ?? 0) as number) > fbVerifiedBefore,
    `verifyCount rose (${fbVerifiedBefore} -> ${fbHit3?.verifyCount})`,
  );
});

const fbBadKind = await fbFeedback.execute({
  entryId: fbHitId,
  feedback: "meh",
});
check("0.5.0 step 4: an unknown feedback kind is refused", () => {
  assert.equal(fbBadKind.ok, false);
});
const fbUnknown = await fbFeedback.execute({
  entryId: "no-such-id",
  feedback: "wrong",
});
check("0.5.0 step 4: an unknown entry id is refused", () => {
  assert.equal(fbUnknown.ok, false);
});
const fbTask = await fbFeedback.execute(
  { entryId: fbHitId, feedback: "wrong" },
  { agent: { session: { id: "s-task-never-marked" } } },
);
check("0.5.0 step 4: a task window cannot give feedback (persona gate)", () => {
  assert.equal(fbTask.ok, false);
  assert.ok(((fbTask.error as string) ?? "").includes("人设窗口"));
});

const fbWrong = await fbFeedback.execute({
  entryId: fbHitId,
  feedback: "wrong",
  fragmentId: fbFragId,
  reason: "她不喜欢酸梅汤",
});
check("0.5.0 step 4: feedback wrong invalidates the entry", () => {
  assert.equal(fbWrong.ok, true, JSON.stringify(fbWrong));
  assert.deepEqual(fbWrong.invalidated, [fbHitId]);
});
const fbSearch4 = await fbSearch.execute({ query: "酸梅汤" });
check("0.5.0 step 4: the same question re-asked no longer recalls the wrong memory", () => {
  assert.equal(
    (fbSearch4.hits as unknown[]).length,
    0,
    "invalidated entry is gone from recall",
  );
});
check("0.5.0 step 4: wrong feedback writes an audit line (same file as memory_invalidate)", () => {
  const audit = readFileSync(join(dirFb, INVALIDATION_AUDIT_FILE), "utf8");
  assert.ok(audit.includes("memory_feedback wrong"), "audit names the feedback");
  assert.ok(audit.includes(fbHitId), "audit names the entry");
});

// ---- 0.5.0 step 5: 查询改写版混合召回 ----------------------------
// No embedding: the rewrite is a host-injected async function; the
// tests use a deterministic stub (a real model call lives with the
// host — this plugin's context exposes no model-call API).
// (check() is sync, so the awaits run at top level first.)
const rwNoRewriter = await rewriteQuery("酸梅汤", undefined);
const rwUnchanged = await rewriteQuery("酸梅汤", async () => "酸梅汤");
const rwEmpty = await rewriteQuery("酸梅汤", async () => "");
const rwNull = await rewriteQuery("酸梅汤", async () => null);
const rwThrowing = await rewriteQuery("酸梅汤", async () => {
  throw new Error("model down");
});
const rwExpanded = await rewriteQuery(
  "酸梅汤",
  async () => "酸梅汤 冰镇",
  3000,
);
const rwHangT0 = Date.now();
const rwHang = await rewriteQuery(
  "酸梅汤",
  () => new Promise<string>(() => {}),
  20,
);
const rwHangMs = Date.now() - rwHangT0;
check("0.5.0 step 5: rewriteQuery falls back to null on every failure mode", () => {
  assert.equal(rwNoRewriter, null);
  assert.equal(rwUnchanged, null, "an unchanged rewrite is null (nothing to add)");
  assert.equal(rwEmpty, null, "an empty rewrite is null");
  assert.equal(rwNull, null, "a null rewrite is null");
  assert.equal(rwThrowing, null, "a throwing rewriter falls back");
  assert.equal(rwExpanded, "酸梅汤 冰镇", "a real expansion comes back");
  assert.equal(rwHang, null, "a hanging rewriter times out");
  assert.ok(rwHangMs < 1000, "the timeout does not block the turn");
});

// Isolated dir + ctx with a stub rewriter: 天气现象 -> 打雷.
const dirRw = mkdtempSync(join(tmpdir(), "memory-plugin-rewrite-"));
writeFileSync(join(dirRw, "MEMORY.md"), fixtureMemory, "utf8");
const stubRewriter = async (q: string): Promise<string | null> =>
  q.includes("天气现象") ? `${q} 打雷 雷声` : null;
const ctxRw = new MockContext(dirRw);
apply(ctxRw as never, {
  dataDir: dirRw,
  queryRewriter: stubRewriter,
} as never);
await sleep(50);
const rwSearch = ctxRw.registeredTools.find(
  (t) => t.name === "memory_search",
) as unknown as {
  execute: (args: Record<string, unknown>) => Promise<{
    hits: Array<Record<string, unknown>>;
  }>;
};
// Seed one line through the real events (persona session s-rw).
await ctxRw.emit("agent/created", { agent: { id: "s-rw" } });
await ctxRw.emit("agent/pre-step", {
  agent: { id: "s-rw", ctx: ctxRw.agentCtx("s-rw") },
  messages: [
    { role: "user", content: "夏柠柒，我最怕打雷", source: { kind: "user" } },
  ],
});
await ctxRw.emit("session/event", {
  type: "user/message",
  sessionId: "s-rw",
  source: { kind: "user" },
  message: {
    content: "夏柠柒，我最怕打雷",
    source: { kind: "user" },
  },
});

const rwSearchNoRewrite = await rwSearch.execute({
  query: "她害怕什么天气现象",
});
check("0.5.0 step 5: memory_search with the stub rewriter finds what keyword-only misses", () => {
  assert.ok(
    (rwSearchNoRewrite.hits as unknown[]).length >= 1,
    "the rewritten search finds the 打雷 line",
  );
  assert.ok(
    ((rwSearchNoRewrite.hits as Array<Record<string, unknown>>)[0].text as string).includes("打雷"),
    "the hit is the 打雷 line",
  );
});

// Same question, no rewriter: a second ctx proves the miss is real.
const dirRw0 = mkdtempSync(join(tmpdir(), "memory-plugin-rewrite0-"));
writeFileSync(join(dirRw0, "MEMORY.md"), fixtureMemory, "utf8");
const ctxRw0 = new MockContext(dirRw0);
apply(ctxRw0 as never, { dataDir: dirRw0 } as never);
await sleep(50);
await ctxRw0.emit("agent/created", { agent: { id: "s-rw0" } });
await ctxRw0.emit("agent/pre-step", {
  agent: { id: "s-rw0", ctx: ctxRw0.agentCtx("s-rw0") },
  messages: [
    { role: "user", content: "夏柠柒，我最怕打雷", source: { kind: "user" } },
  ],
});
await ctxRw0.emit("session/event", {
  type: "user/message",
  sessionId: "s-rw0",
  source: { kind: "user" },
  message: {
    content: "夏柠柒，我最怕打雷",
    source: { kind: "user" },
  },
});
const rw0Search = ctxRw0.registeredTools.find(
  (t) => t.name === "memory_search",
) as unknown as {
  execute: (args: Record<string, unknown>) => Promise<{
    hits: Array<Record<string, unknown>>;
  }>;
};
const rw0Res = await rw0Search.execute({ query: "她害怕什么天气现象" });
check("0.5.0 step 5: without a rewriter the same question misses (control)", () => {
  assert.equal(
    (rw0Res.hits as unknown[]).length,
    0,
    "keyword-only misses the synonym question",
  );
});

// Pre-step path: turn 1 recall with the stub rewriter appends the hit.
const dRw = {
  agent: { id: "s-rw2", ctx: ctxRw.agentCtx("s-rw2") },
  messages: [
    {
      role: "user",
      content: "夏柠柒，她害怕什么天气现象",
      source: { kind: "user" },
    },
  ],
};
await ctxRw.emit("agent/pre-step", dRw);
check("0.5.0 step 5: pre-step recall with the rewriter injects the rewritten hit", () => {
  const msgs = dRw.messages as Array<Record<string, unknown>>;
  assert.equal(msgs.length, 2, "turn 1 appends (1 original + 1 injected)");
  const text = (msgs[1].content as Array<{ text: string }>)[0].text;
  assert.ok(text.includes("打雷"), "the injected recall carries the 打雷 line");
});

// Hanging rewriter + short timeout: the turn still completes,
// keyword-only.
const dirRwHang = mkdtempSync(join(tmpdir(), "memory-plugin-rewrite-hang-"));
writeFileSync(join(dirRwHang, "MEMORY.md"), fixtureMemory, "utf8");
const ctxRwHang = new MockContext(dirRwHang);
apply(ctxRwHang as never, {
  dataDir: dirRwHang,
  queryRewriter: () => new Promise<string>(() => {}),
  rewriteTimeoutMs: 20,
} as never);
await sleep(50);
const rwHangSearch = ctxRwHang.registeredTools.find(
  (t) => t.name === "memory_search",
) as unknown as {
  execute: (args: Record<string, unknown>) => Promise<{
    hits: Array<Record<string, unknown>>;
  }>;
};
const tHang0 = Date.now();
const rwHangRes = await rwHangSearch.execute({ query: "酸梅汤" });
check("0.5.0 step 5: a hanging rewriter times out instead of blocking the search", () => {
  assert.ok(Date.now() - tHang0 < 1000, "the search returned promptly");
  assert.ok(Array.isArray(rwHangRes.hits), "a result still comes back (keyword-only)");
});

// ---- unload + MEMORY.md untouched ---------------------------------------
for (const dispose of ctx.disposers) dispose();

check("M5/M12: unload runs endSession (a second snapshot exists)", () => {
  const snaps = readdirSync(join(dir, ".snapshots"));
  assert.ok(snaps.length >= 2, "compaction + unload each took a snapshot");
});

check("MEMORY.md bytes unchanged by every shell operation", () => {
  assert.equal(readFileSync(join(dir, "MEMORY.md"), "utf8"), memoryBefore);
});

// ---- 0.5.1 ---------------------------------------------------------
// One check per 0.5.1 item that lives on the shell side (0.4.3
// items 12/14, 0.4.5 new issues 8/9, §四 small items). Each on its
// own dir/context.

// 0.5.1 (0.4.3 item 12): memory_search is persona-only. A
// task-window entry can only get into the log by a direct core
// write (the plugin's session/event never records task windows)
// — which is exactly the hole: once in, it must never surface
// in a persona search.
const srch051Dir = mkdtempSync(join(tmpdir(), "memory-plugin-051-search-window-"));
writeFileSync(join(srch051Dir, "MEMORY.md"), fixtureMemory, "utf8");
const seedSrch051 = new MemoryCore({ dataDir: srch051Dir });
const taskHit051 = seedSrch051.record({ role: "user", text: "任务窗口的秘密备忘酸梅汤", window: "task", sessionId: "s-task" });
const personaHit051 = seedSrch051.record({ role: "user", text: "夏柠柒，酸梅汤真好喝", window: "persona", sessionId: "s-srch" });
seedSrch051.flush();
const srch051Ctx = new MockContext(srch051Dir);
apply(srch051Ctx as never, { dataDir: srch051Dir } as never);
await sleep(50);
const search051 = srch051Ctx.registeredTools.find(
  (t) => t.name === "memory_search",
) as unknown as {
  execute: (args: Record<string, unknown>) => Promise<{
    hits: Array<{ id: string; text: string }>;
  }>;
};
const search051Res = await search051.execute({ query: "酸梅汤", limit: 5 });
check("0.5.1 (0.4.3 item 12): memory_search never returns a task-window entry", () => {
  assert.ok(search051Res.hits.some((h) => h.id === personaHit051.id), "persona entry surfaces");
  assert.ok(!search051Res.hits.some((h) => h.id === taskHit051.id), "task entry does not surface");
});

// 0.5.2: an explicit memory_search from a task window is refused.
const searchTask051 = await (
  search051 as unknown as {
    execute: (
      args: Record<string, unknown>,
      exec: unknown,
    ) => Promise<{ hits: unknown[]; error?: string }>;
  }
).execute(
  { query: "酸梅汤", limit: 5 },
  { agent: { session: { id: "s-task" } } },
);
check("0.5.2: task window cannot call memory_search to read persona memory", () => {
  assert.equal(searchTask051.hits.length, 0, "no hits cross the window boundary");
  assert.ok(
    (searchTask051.error ?? "").includes("只在人设窗口"),
    "the refusal is explicit",
  );
});

check("0.5.1 (0.4.3 §四): belief/reflect/proact load their descriptions on demand", () => {
  for (const n of ["memory_belief", "memory_reflect", "memory_proact", "memory_feedback"]) {
    const t = srch051Ctx.registeredTools.find((x) => x.name === n) as unknown as { deferLoading?: boolean } | undefined;
    assert.equal(t?.deferLoading, true, `${n} has deferLoading`);
  }
});
check("0.5.1 (0.4.5 item 6): memory_status says pending checks await the next review", () => {
  const t = srch051Ctx.registeredTools.find((x) => x.name === "memory_status") as unknown as { description?: string } | undefined;
  assert.ok((t?.description ?? "").includes("待下次复盘确认"), "status copy says the count awaits the next review");
});
for (const dispose of srch051Ctx.disposers) dispose();

// 0.5.1 (0.4.3 item 14): memory_restore is persona-gated;
// memory_snapshot stays open (it only copies files).
const rst051Dir = mkdtempSync(join(tmpdir(), "memory-plugin-051-restore-gate-"));
writeFileSync(join(rst051Dir, "MEMORY.md"), fixtureMemory, "utf8");
const rst051Ctx = new MockContext(rst051Dir);
apply(rst051Ctx as never, { dataDir: rst051Dir } as never);
await sleep(50);
await rst051Ctx.emit("agent/created", { agent: { id: "s-rst" } });
await rst051Ctx.emit("agent/pre-step", { agent: { id: "s-rst", ctx: rst051Ctx.agentCtx("s-rst") }, messages: [{ role: "user", content: "夏柠柒，在吗", source: { kind: "user" } }] });
const snapshot051 = rst051Ctx.registeredTools.find(
  (t) => t.name === "memory_snapshot",
) as unknown as {
  execute: (args: Record<string, unknown>) => Promise<{ ok: boolean; snapshot?: string; error?: string }>;
};
const restore051 = rst051Ctx.registeredTools.find(
  (t) => t.name === "memory_restore",
) as unknown as {
  execute: (args: Record<string, unknown>, exec?: unknown) => Promise<{ ok: boolean; safety?: string; error?: string }>;
};
const snap051 = await snapshot051.execute({});
assert.ok(snap051.ok && typeof snap051.snapshot === "string", "snapshot taken");
const snapsBefore051 = readdirSync(join(rst051Dir, ".snapshots"));
const taskRestore051 = await restore051.execute({ name: snap051.snapshot }, { agent: { session: { id: "s-never-triggered" } } });
check("0.5.1 (0.4.3 item 14): memory_restore refuses in a task window and writes nothing", () => {
  assert.equal(taskRestore051.ok, false, "task restore refused");
  assert.ok((taskRestore051.error ?? "").includes("人设窗口"), `refusal names the persona window: ${taskRestore051.error}`);
  assert.deepEqual(readdirSync(join(rst051Dir, ".snapshots")), snapsBefore051, "no safety snapshot was taken — nothing was written");
});
const snapTask051 = await snapshot051.execute({});
check("0.5.1 (0.4.3 item 14): memory_snapshot stays open — it only copies files, never changes memory", () => {
  assert.equal(snapTask051.ok, true, "snapshot works without a persona gate");
});
const personaRestore051 = await restore051.execute({ name: snap051.snapshot }, { agent: { session: { id: "s-rst" } } });
check("0.5.1 (0.4.3 item 14): memory_restore works in a persona window", () => {
  assert.equal(personaRestore051.ok, true, `persona restore works: ${JSON.stringify(personaRestore051)}`);
  assert.equal(typeof personaRestore051.safety, "string", "a safety snapshot was taken first");
});
for (const dispose of rst051Ctx.disposers) dispose();

// 0.5.1 (0.4.5 item 8): yesterday empty, but the code review
// left proposals (a non-empty day builds a proact proposal) —
// the review still registers instead of early-returning.
const rev4051Dir = mkdtempSync(join(tmpdir(), "memory-plugin-051-review-empty-yesterday-"));
writeFileSync(join(rev4051Dir, "MEMORY.md"), fixtureMemory, "utf8");
const seed4051Core = new MemoryCore({ dataDir: rev4051Dir });
seed4051Core.record({ role: "user", text: "今天去爬山了，累坏了", window: "persona", sessionId: "s-rev4", ts: Date.now() - 3600000 });
seed4051Core.record({ role: "assistant", text: "今天吃了拉面，真好吃", window: "persona", sessionId: "s-rev4", ts: Date.now() - 1800000 });
seed4051Core.flush();
const rev4051Ctx = new MockContext(rev4051Dir);
apply(rev4051Ctx as never, { dataDir: rev4051Dir } as never);
await sleep(50);
const rev4051Decision = (id: string, content: string): Record<string, unknown> => ({
  agent: { id, ctx: rev4051Ctx.agentCtx(id) },
  messages: [{ role: "user", content, source: { kind: "user" } }],
});
const rev4051Live = (id: string) =>
  rev4051Ctx
    .agentCtx(id)
    .contexts.filter((c) => c.name === "memory-plugin:daily-review" && !c.disposed);
await rev4051Ctx.emit("agent/created", { agent: { id: "s-rev4" } });
await rev4051Ctx.emit("agent/pre-step", rev4051Decision("s-rev4", "夏柠柒，在吗"));
await rev4051Ctx.emit("agent/created", { agent: { id: "s-rev4" } });
await rev4051Ctx.emit("agent/pre-step", rev4051Decision("s-rev4", "夏柠柒，在吗"));
check("0.5.1 (0.4.5 item 8): yesterday empty but proposals present — the review still registers", () => {
  const live = rev4051Live("s-rev4");
  assert.equal(live.length, 1, "one live review context despite an empty yesterday");
  assert.ok(live[0].text.includes("主动提议"), "the proact proposal rides along");
  assert.ok(
    live[0].text.includes("今天去爬山了") || live[0].text.includes("今天吃了拉面"),
    "today's entries are in the merged recent section",
  );
  // 0.4.5 item 9b: the merged section tells her the proact
  // prompt in the review carries no token — act only after a
  // fresh memory_proact({}) gate call.
  assert.ok(
    live[0].text.includes("先调用 memory_proact 工具（空参数）"),
    "the review says to take a fresh gate call before acting",
  );
});
for (const dispose of rev4051Ctx.disposers) dispose();

// Control for the same fix: yesterday empty AND no proposals —
// still no review.
const rev6051Dir = mkdtempSync(join(tmpdir(), "memory-plugin-051-review-empty-no-proposals-"));
writeFileSync(join(rev6051Dir, "MEMORY.md"), fixtureMemory, "utf8");
const rev6051Ctx = new MockContext(rev6051Dir);
apply(rev6051Ctx as never, { dataDir: rev6051Dir } as never);
await sleep(50);
const rev6051Decision = (id: string, content: string): Record<string, unknown> => ({
  agent: { id, ctx: rev6051Ctx.agentCtx(id) },
  messages: [{ role: "user", content, source: { kind: "user" } }],
});
const rev6051Live = (id: string) =>
  rev6051Ctx
    .agentCtx(id)
    .contexts.filter((c) => c.name === "memory-plugin:daily-review" && !c.disposed);
await rev6051Ctx.emit("agent/created", { agent: { id: "s-rev6" } });
await rev6051Ctx.emit("agent/pre-step", rev6051Decision("s-rev6", "夏柠柒，在吗"));
await rev6051Ctx.emit("agent/created", { agent: { id: "s-rev6" } });
await rev6051Ctx.emit("agent/pre-step", rev6051Decision("s-rev6", "夏柠柒，在吗"));
check("0.5.1 (0.4.5 item 8): yesterday empty and no proposals — still no review", () => {
  assert.equal(rev6051Live("s-rev6").length, 0, "nothing to review, nothing registered");
});
for (const dispose of rev6051Ctx.disposers) dispose();

// 0.5.1 (0.4.3 §四): memory_daily_review checks the prompt
// whitelist. Fresh fixture (the revCtx one already submitted).
const rev5051Dir = mkdtempSync(join(tmpdir(), "memory-plugin-051-review-allowlist-"));
writeFileSync(join(rev5051Dir, "MEMORY.md"), fixtureMemory, "utf8");
const seed5051Core = new MemoryCore({ dataDir: rev5051Dir });
const wE1051 = seed5051Core.record({ role: "user", text: "昨天去爬山了", window: "persona", sessionId: "s-rev5", ts: yTs });
const wE2051 = seed5051Core.record({ role: "assistant", text: "昨天吃了拉面", window: "persona", sessionId: "s-rev5", ts: yTs + 60000 });
seed5051Core.record({ role: "user", text: "今天要去买菜", window: "persona", sessionId: "s-rev5", ts: Date.now() });
seed5051Core.flush();
const rev5051Ctx = new MockContext(rev5051Dir);
apply(rev5051Ctx as never, { dataDir: rev5051Dir } as never);
await sleep(50);
const rev5051Decision = (id: string, content: string): Record<string, unknown> => ({
  agent: { id, ctx: rev5051Ctx.agentCtx(id) },
  messages: [{ role: "user", content, source: { kind: "user" } }],
});
await rev5051Ctx.emit("agent/created", { agent: { id: "s-rev5" } });
await rev5051Ctx.emit("agent/pre-step", rev5051Decision("s-rev5", "夏柠柒，在吗"));
await rev5051Ctx.emit("agent/created", { agent: { id: "s-rev5" } });
await rev5051Ctx.emit("agent/pre-step", rev5051Decision("s-rev5", "夏柠柒，在吗"));
const daily5051 = rev5051Ctx.registeredTools.find(
  (t) => t.name === "memory_daily_review",
) as unknown as {
  execute: (args: unknown, exec?: unknown) => Promise<Record<string, unknown>>;
};
const rev5051Exec = { agent: { session: { id: "s-rev5" } } };
const readRev5051Attrs = () =>
  JSON.parse(readFileSync(join(rev5051Dir, "attributes.json"), "utf8")) as {
    entries: Record<string, { significance: number; modelMarked?: boolean }>;
  };
// Whitelist live: an in-prompt id applies, a made-up one does not.
const mixed5051 = await daily5051.execute({ ids: [wE1051.id, "made-up-id"] }, rev5051Exec);
check("0.5.1 (0.4.3 §四): a whitelisted id applies, an out-of-prompt id lands in unknown", () => {
  assert.equal(mixed5051.ok, true);
  assert.deepEqual(mixed5051.applied, [wE1051.id]);
  assert.deepEqual(mixed5051.unknown, ["made-up-id"]);
  assert.equal(readRev5051Attrs().entries[wE1051.id]?.significance, 0.9, "whitelisted id raised to 0.9");
});
// The submit above cleared the whitelist (single-use). An entry
// recorded AFTER the review registered is in the log but was
// never in the prompt: the cold-call fallback (yesterday's ids)
// must still refuse it — the old code would have applied it.
const late5051 = seed5051Core.record({ role: "user", text: "刚想起来昨天还买了西瓜", window: "persona", sessionId: "s-rev5", ts: Date.now() });
seed5051Core.flush();
const lateRes5051 = await daily5051.execute({ ids: [late5051.id] }, rev5051Exec);
check("0.5.1 (0.4.3 §四): after the whitelist clears, a non-yesterday id still cannot be marked", () => {
  assert.equal(lateRes5051.ok, true);
  assert.deepEqual(lateRes5051.applied, []);
  assert.deepEqual(lateRes5051.unknown, [late5051.id]);
  assert.notEqual(readRev5051Attrs().entries[late5051.id]?.significance, 0.9, "never shown, never marked");
});
// And the fallback still lets a real yesterday id through.
const fallback5051 = await daily5051.execute({ ids: [wE2051.id] }, rev5051Exec);
check("0.5.1 (0.4.3 §四): cold call falls back to yesterday's ids", () => {
  assert.equal(fallback5051.ok, true);
  assert.deepEqual(fallback5051.applied, [wE2051.id]);
  assert.equal(readRev5051Attrs().entries[wE2051.id]?.significance, 0.9, "yesterday id applies without a live whitelist");
});
for (const dispose of rev5051Ctx.disposers) dispose();

// ---- 0.5.1 expansion: forget / goals / experiences tools,
// factKey remember, status fields, semantic config fallback ------
// One section, one dir/context, persona session s-exp.
const exp051Dir = mkdtempSync(join(tmpdir(), "memory-plugin-051-expansion-"));
writeFileSync(join(exp051Dir, "MEMORY.md"), fixtureMemory, "utf8");
const seedExp051 = new MemoryCore({ dataDir: exp051Dir });
const blueExp051 = seedExp051.record({ role: "user", text: "我最喜欢的颜色是蓝色", window: "persona", sessionId: "s-exp", ts: Date.now() - 60 * 24 * 3600 * 1000, factKey: "最喜欢的颜色" });
seedExp051.flush();
const exp051Ctx = new MockContext(exp051Dir);
apply(exp051Ctx as never, { dataDir: exp051Dir } as never);
await sleep(50);
await exp051Ctx.emit("agent/created", { agent: { id: "s-exp" } });
await exp051Ctx.emit("agent/pre-step", { agent: { id: "s-exp", ctx: exp051Ctx.agentCtx("s-exp") }, messages: [{ role: "user", content: "夏柠柒，在吗", source: { kind: "user" } }] });
const expExec = { agent: { session: { id: "s-exp" } } };
const tool051 = (name: string) =>
  exp051Ctx.registeredTools.find((t) => t.name === name) as unknown as {
    execute: (args: Record<string, unknown>, exec?: unknown) => Promise<Record<string, unknown>>;
    deferLoading?: boolean;
  };
const forget051 = tool051("memory_forget");
const goal051 = tool051("memory_goal");
const expTool051 = tool051("memory_experience");
const remember051 = tool051("memory_remember");
const searchExp051 = tool051("memory_search");
const status051 = tool051("memory_status");

check("0.5.1 exp: all seventeen tools are registered, incl. forget/goal/experience, all three deferLoading", () => {
  const names = exp051Ctx.registeredTools.map((t) => t.name as string);
  for (const n of ["memory_forget", "memory_goal", "memory_experience"]) {
    assert.ok(names.includes(n), `tool ${n} registered`);
  }
  assert.equal(names.length, 17, `17 tools total, got ${names.length}: ${names.join(",")}`);
  for (const n of ["memory_forget", "memory_goal", "memory_experience"]) {
    assert.equal(tool051(n).deferLoading, true, `${n} has deferLoading`);
  }
});

// memory_remember with factKey: the green version supersedes blue.
const green051 = await remember051.execute(
  { text: "我现在最喜欢的颜色是绿色，早就不是蓝色了", importance: "light", factKey: "最喜欢的颜色", supersedes: blueExp051.id },
  expExec,
);
check("0.5.1 exp item 1: memory_remember takes factKey/supersedes", () => {
  assert.equal(green051.ok, true, `remember with factKey works: ${JSON.stringify(green051)}`);
  assert.ok(typeof green051.id === "string", "new version has an id");
});
const nowSearch051 = (await searchExp051.execute({ query: "她现在最喜欢什么颜色", limit: 5 }, expExec)) as unknown as { hits: Array<{ id: string; text: string }> };
check("0.5.1 exp item 1: memory_search answers '现在' with the current version first", () => {
  assert.ok(nowSearch051.hits.length >= 1, "hits come back");
  assert.equal(nowSearch051.hits[0].text, "我现在最喜欢的颜色是绿色，早就不是蓝色了", "current green first");
});
const histSearch051 = (await searchExp051.execute({ query: "她以前最喜欢什么颜色", limit: 5 }, expExec)) as unknown as { hits: Array<{ id: string; text: string }> };
check("0.5.1 exp item 1: memory_search answers '以前' with the old version first", () => {
  assert.ok(histSearch051.hits.length >= 1, "hits come back");
  assert.equal(histSearch051.hits[0].text, "我最喜欢的颜色是蓝色", "old blue first for a history question");
});

// memory_forget: request + dry-run + list; no approve/execute.
const dry051 = (await forget051.execute({ action: "dry-run", entryIds: [blueExp051.id] }, expExec)) as unknown as { ok: boolean; preview: { entries: Array<{ id: string }> } };
check("0.5.1 exp item 1: memory_forget dry-run previews without changing anything", () => {
  assert.equal(dry051.ok, true, "dry-run works");
  assert.equal(dry051.preview.entries.length, 1, "dry-run previews the entry");
  assert.equal(dry051.preview.entries[0].id, blueExp051.id, "dry-run names the entry");
});
const req051 = (await forget051.execute({ action: "request", mode: "hide", entryIds: [blueExp051.id], reason: "mock 测试" }, expExec)) as unknown as { ok: boolean; requestId: string; status: string; note: string };
check("0.5.1 exp item 1: memory_forget request files a pending request and says chat agreement does not count", () => {
  assert.equal(req051.ok, true, "request works");
  assert.equal(req051.status, "pending", "request starts pending");
  assert.ok(typeof req051.requestId === "string", "request has an id");
  assert.ok((req051.note ?? "").includes("我同意"), "note says chat agreement does not count");
});
const list051 = (await forget051.execute({ action: "list" }, expExec)) as unknown as { ok: boolean; requests: Array<{ id: string; status: string }> };
check("0.5.1 exp item 1: memory_forget list shows the pending request, and the entry is still recallable", () => {
  assert.equal(list051.ok, true, "list works");
  assert.ok(list051.requests.some((r) => r.id === req051.requestId && r.status === "pending"), "pending request listed");
});
const noApprove051 = (await forget051.execute({ action: "approve", entryIds: [blueExp051.id] }, expExec)) as unknown as { ok: boolean; error: string };
check("0.5.1 exp item 1: memory_forget has NO approve/execute action", () => {
  assert.equal(noApprove051.ok, false, "approve is not an action");
  assert.ok((noApprove051.error ?? "").includes("request / dry-run / list"), `refusal names the allowed actions: ${noApprove051.error}`);
});
const stillThere051 = (await searchExp051.execute({ query: "蓝色", limit: 5 }, expExec)) as unknown as { hits: Array<{ id: string }> };
check("0.5.1 exp item 1: a filed request hides nothing until the admin approves", () => {
  assert.ok(stillThere051.hits.some((h) => h.id === blueExp051.id), "entry still surfaces after request");
});

// memory_goal: create / list / complete / reopen / get / drop.
const goalCreate051 = (await goal051.execute({ action: "create", title: "增肌到 130 斤", notes: "每周称体重" }, expExec)) as unknown as { ok: boolean; goal: { id: string; status: string } };
check("0.5.1 exp item 5: memory_goal create works", () => {
  assert.equal(goalCreate051.ok, true, "create works");
  assert.equal(goalCreate051.goal.status, "open", "a goal starts open");
});
const goalList051 = (await goal051.execute({ action: "list" }, expExec)) as unknown as { ok: boolean; goals: Array<{ id: string; status: string }> };
check("0.5.1 exp item 5: memory_goal list shows the open goal", () => {
  assert.equal(goalList051.ok, true, "list works");
  assert.ok(goalList051.goals.some((g) => g.id === goalCreate051.goal.id && g.status === "open"), "open goal listed");
});
const goalDone051 = (await goal051.execute({ action: "complete", goalId: goalCreate051.goal.id }, expExec)) as unknown as { ok: boolean; goal: { status: string } };
check("0.5.1 exp item 5: memory_goal complete marks it done", () => {
  assert.equal(goalDone051.ok, true, "complete works");
  assert.equal(goalDone051.goal.status, "done", "status is done");
});
const goalReopen051 = (await goal051.execute({ action: "reopen", goalId: goalCreate051.goal.id }, expExec)) as unknown as { ok: boolean; goal: { status: string } };
check("0.5.1 exp item 5: memory_goal reopen brings it back to open", () => {
  assert.equal(goalReopen051.ok, true, "reopen works");
  assert.equal(goalReopen051.goal.status, "open", "status is open again");
});
const goalGet051 = (await goal051.execute({ action: "get", goalId: goalCreate051.goal.id }, expExec)) as unknown as { ok: boolean; goal: { title: string } };
check("0.5.1 exp item 5: memory_goal get reads it back", () => {
  assert.equal(goalGet051.ok, true, "get works");
  assert.equal(goalGet051.goal.title, "增肌到 130 斤", "title round-trips");
});

// memory_experience: add / list / match.
const expAdd051 = (await expTool051.execute({ action: "add", rule: "测试规矩：问颜色只答当前版", trigger: ["颜色"], source: "mock 测试", sourceIds: [blueExp051.id] }, expExec)) as unknown as { ok: boolean; experience: { id: string; verified: boolean } };
check("0.5.1 exp item 4: memory_experience add works", () => {
  assert.equal(expAdd051.ok, true, "add works");
  assert.ok(typeof expAdd051.experience.id === "string", "experience has an id");
  assert.equal(expAdd051.experience.verified, false, "a new rule is a candidate, not verified");
});
const expConfirm051 = (await expTool051.execute({ action: "confirm", id: expAdd051.experience.id }, expExec)) as unknown as { ok: boolean; error?: string };
check("0.5.4 exp: the model tool cannot confirm its own rule", () => {
  assert.equal(expConfirm051.ok, false, "confirm is refused");
  assert.ok(
    (expConfirm051.error ?? "").includes("只能由用户"),
    "the refusal names the CLI/API channel",
  );
});
const expList051 = (await expTool051.execute({ action: "list" }, expExec)) as unknown as { ok: boolean; experiences: Array<{ id: string }> };
check("0.5.1 exp item 4: memory_experience list includes the new rule (empty store, no seeds)", () => {
  assert.equal(expList051.ok, true, "list works");
  assert.ok(expList051.experiences.length >= 1, `at least 1 experience, got ${expList051.experiences.length}`);
  assert.ok(expList051.experiences.some((e) => e.id === expAdd051.experience.id), "new rule listed");
});
const expMatch051 = (await expTool051.execute({ action: "match", query: "她现在最喜欢什么颜色" }, expExec)) as unknown as { ok: boolean; matched: Array<{ rule: string }> };
check("0.5.1 exp item 4: memory_experience match finds the rule by trigger", () => {
  assert.equal(expMatch051.ok, true, "match works");
  assert.ok(expMatch051.matched.some((m) => m.rule === "测试规矩：问颜色只答当前版"), "rule matches the colour question");
});

// memory_status carries the new fields.
const statusExp051 = (await status051.execute({}, expExec)) as unknown as {
  ok: boolean;
  openGoals: number;
  doneGoals: number;
  pendingForgets: number;
  semantic: { enabled: boolean; modelPresent: boolean; indexSize: number };
};
check("0.5.1 exp: memory_status reports openGoals, doneGoals, pendingForgets and semantic", () => {
  assert.equal(statusExp051.ok, true, "status works");
  assert.equal(statusExp051.openGoals, 1, "one open goal");
  assert.equal(statusExp051.doneGoals, 0, "no done goals (reopened)");
  assert.equal(statusExp051.pendingForgets, 1, "one pending forget request");
  assert.equal(statusExp051.semantic.enabled, false, "semantic off by default");
  assert.equal(
    statusExp051.semantic.modelPresent,
    existsSync(join(process.cwd(), "models", "bge-small-zh-v1.5", "config.json")),
    "modelPresent reflects whether this package variant bundles the model",
  );
});

// The three new tools refuse in a task window.
const taskExec051 = { agent: { session: { id: "s-never-triggered" } } };
const taskRefusals051 = [] as Array<{ ok: boolean; error: string }>;
for (const [tool, args] of [
  [forget051, { action: "list" }],
  [goal051, { action: "list" }],
  [expTool051, { action: "list" }],
] as const) {
  taskRefusals051.push((await tool.execute(args, taskExec051)) as unknown as { ok: boolean; error: string });
}
check("0.5.1 exp: forget/goal/experience refuse in a task window", () => {
  for (const res of taskRefusals051) {
    assert.equal(res.ok, false, "task window refused");
    assert.ok((res.error ?? "").includes("人设窗口"), `refusal names the persona window: ${res.error}`);
  }
});
for (const dispose of exp051Ctx.disposers) dispose();

// 0.5.1 exp item 2: semantic enabled but the model missing —
// apply must not crash, search stays keyword-only, status says so.
const sem051Dir = mkdtempSync(join(tmpdir(), "memory-plugin-051-semantic-fallback-"));
writeFileSync(join(sem051Dir, "MEMORY.md"), fixtureMemory, "utf8");
const seedSem051 = new MemoryCore({ dataDir: sem051Dir });
const plumSem051 = seedSem051.record({ role: "user", text: "我最喜欢喝酸梅汤，夏天一定要冰的", window: "persona", sessionId: "s-sem" });
seedSem051.flush();
const sem051Ctx = new MockContext(sem051Dir);
apply(sem051Ctx as never, {
  dataDir: sem051Dir,
  semanticRecall: { enabled: true, modelDir: join(sem051Dir, "models", "bge-small-zh-v1.5") },
} as never);
await sleep(50);
const semSearch051 = sem051Ctx.registeredTools.find(
  (t) => t.name === "memory_search",
) as unknown as {
  execute: (args: Record<string, unknown>, exec?: unknown) => Promise<{ hits: Array<{ id: string }> }>;
};
const semStatus051 = sem051Ctx.registeredTools.find(
  (t) => t.name === "memory_status",
) as unknown as {
  execute: (args: Record<string, unknown>, exec?: unknown) => Promise<Record<string, unknown>>;
};
const semSearchRes051 = await semSearch051.execute({ query: "酸梅汤", limit: 5 });
check("0.5.1 exp item 2: semantic enabled with a missing model still searches keyword-only", () => {
  assert.ok(semSearchRes051.hits.some((h) => h.id === plumSem051.id), "keyword hit still surfaces with the model missing");
});
const semStatusRes051 = await semStatus051.execute({});
check("0.5.1 exp item 2: memory_status reports semantic enabled but no model present", () => {
  const sem = semStatusRes051.semantic as { enabled: boolean; modelPresent: boolean; indexSize: number };
  assert.equal(sem.enabled, true, "enabled is true from config");
  assert.equal(sem.modelPresent, false, "modelPresent is false — the dir is empty");
  assert.equal(sem.indexSize, 0, "no index was built");
});
for (const dispose of sem051Ctx.disposers) dispose();

// 0.5.1 exp item 2: HybridRetriever with a mock semantic
// retriever (no model) — the fusion itself, at the provider
// level: a semantic-only hit surfaces, scored by similarity.
{
  const hyCore = new MemoryCore({ dataDir: mkdtempSync(join(tmpdir(), "memory-plugin-051-hybrid-")) });
  const plumHy = hyCore.record({ role: "user", text: "我最喜欢喝酸梅汤，夏天一定要冰的", window: "persona", sessionId: "s-hy" });
  hyCore.record({ role: "user", text: "我不喝咖啡，喝了心慌", window: "persona", sessionId: "s-hy" });
  const entries = hyCore.allEntries();
  const mockRetriever = {
    kind: "semantic" as const,
    retrieveIds: () => [plumHy.id],
    similarityOf: (id: string) => (id === plumHy.id ? 0.9 : undefined),
  };
  const hybrid = new HybridRetriever(mockRetriever);
  const kwOnly = hybrid.retrieve("她爱喝的那种甜饮料叫什么", entries, null, { window: "persona", limit: 5, tokenCap: 1500 });
  check("0.5.1 exp item 2: HybridRetriever with a mock semantic retriever surfaces the semantic-only hit first", () => {
    assert.ok(kwOnly.hits.some((h) => h.entry.id === plumHy.id), "semantic-only hit surfaces");
    assert.equal(kwOnly.hits[0].entry.id, plumHy.id, "it ranks first on similarity 0.9");
  });
  const noSim = new HybridRetriever({
    kind: "semantic" as const,
    retrieveIds: () => [plumHy.id],
  });
  const noSimRes = noSim.retrieve("她爱喝的那种甜饮料叫什么", entries, null, { window: "persona", limit: 5, tokenCap: 1500 });
  check("0.5.1 exp item 2: a semantic retriever without similarities scores its hits 0", () => {
    assert.ok(noSimRes.hits.some((h) => h.entry.id === plumHy.id), "the hit still surfaces (valve off)");
    assert.equal(noSimRes.hits.find((h) => h.entry.id === plumHy.id)?.score, 0, "no similarity means score 0");
  });
}

// ---- DSH output contract (regression for the 0.5.5 real-DSH bugs) ----
// Real DSH calls output.render(args, value); a one-param render used to
// render the CALL ARGUMENTS as the tool result. The mock suite never
// called render, so 0.5.5 passed 219 checks and still broke on real DSH.
check("DSH contract: render(args, value) renders the result, not the call args", () => {
  for (const t of ctx.registeredTools) {
    const out = t.output as {
      render?: (args: unknown, value: unknown) => unknown;
    };
    assert.equal(typeof out.render, "function", `${t.name} declares render`);
    assert.ok(
      (out.render as unknown as { length: number }).length >= 2,
      `${t.name} render takes (args, value)`,
    );
    const rendered = JSON.stringify(
      out.render!({ __probe: "ARGS" }, { marker: "VALUE" }),
    );
    assert.ok(rendered.includes("VALUE"), `${t.name} renders the value`);
    assert.ok(!rendered.includes("__probe"), `${t.name} never renders the args`);
  }
});

// Free-form output objects (beliefDimensions, semantic, ...) must stay
// open: DSH closes every object with additionalProperties:false, and a
// closed free-form object rejects every key at output validation time
// (0.5.5 memory_status: INVALID_TOOL_OUTPUT on real DSH).
function assertOpenObjectSchemas(node: unknown, path: string): void {
  if (Array.isArray(node)) {
    node.forEach((child, i) =>
      assertOpenObjectSchemas(child, `${path}[${i}]`),
    );
    return;
  }
  if (typeof node !== "object" || node === null) return;
  const schema = node as Record<string, unknown>;
  if (schema.type === "object" && schema.properties === undefined) {
    assert.equal(
      schema.additionalProperties,
      true,
      `${path} free-form object must stay open`,
    );
  }
  for (const [key, child] of Object.entries(schema)) {
    assertOpenObjectSchemas(child, `${path}.${key}`);
  }
}
check("DSH contract: free-form output objects stay open", () => {
  for (const t of ctx.registeredTools) {
    const out = t.output as { schema?: unknown };
    assertOpenObjectSchemas(out.schema, String(t.name));
  }
});

// ---- 终版 WP1: shell wiring (greeting / task / declaration / restart)
const wdir = mkdtempSync(join(tmpdir(), "memory-plugin-window-"));
const wlogCount = (): number => {
  const f = join(wdir, "log.jsonl");
  if (!existsSync(f)) return 0;
  return readFileSync(f, "utf8").trim().split("\n").filter(Boolean).length;
};
const wlastKind = (): string => {
  const f = join(wdir, "log.jsonl");
  const lines = readFileSync(f, "utf8").trim().split("\n").filter(Boolean);
  return (JSON.parse(lines[lines.length - 1]) as { kind?: string }).kind ?? "";
};
const wmap = (): Record<string, string> =>
  JSON.parse(
    readFileSync(join(wdir, "persona-sessions.json"), "utf8"),
  ) as Record<string, string>;
const emitUser = async (
  c: MockContext,
  sid: string,
  content: string,
): Promise<void> => {
  await c.emit("session/event", {
    type: "user/message",
    sessionId: sid,
    source: { kind: "user" },
    message: { content, source: { kind: "user" } },
  });
};
const emitAssistant = async (
  c: MockContext,
  sid: string,
  content: string,
): Promise<void> => {
  await c.emit("session/event", {
    type: "assistant/message",
    sessionId: sid,
    message: { content, source: { kind: "assistant" } },
  });
};

const wctx = new MockContext(wdir);
apply(wctx as never, { dataDir: wdir } as never);
await sleep(50);
await wctx.emit("agent/created", { agent: { id: "w1" } });

await emitUser(wctx, "w1", "夏柠柒");
assert.equal(wlastKind(), "greeting", "bare trigger records greeting");
assert.equal(wmap().w1, "persona", "bare trigger still marks the session");

await emitUser(wctx, "w1", "我今天好累");
assert.equal(wlastKind(), "persona", "next chat turn is persona");
await emitAssistant(wctx, "w1", "怎么了");
assert.equal(wlastKind(), "persona", "her reply follows the chat turn");

const beforeDecl = wlogCount();
await emitUser(wctx, "w1", "任务窗口");
assert.equal(wlogCount(), beforeDecl, "declaration itself is not recorded");
assert.equal(wmap().w1, "task", "task mode is persisted");
await emitUser(wctx, "w1", "夏柠柒，在吗");
assert.equal(
  wlogCount(),
  beforeDecl,
  "a trigger does not flip a declared task session",
);

await emitUser(wctx, "w1", "人设窗口");
assert.equal(wmap().w1, "persona", "persona declaration switches back");
await emitUser(wctx, "w1", "夏柠柒，帮我把这段文字改得像你说话的口气");
assert.equal(wlastKind(), "task", "work turn inside persona is task");
await emitAssistant(wctx, "w1", "改好了，第三处我换了语气");
assert.equal(wlastKind(), "persona", "short work reply stays her words");

// Restart: the mode must survive a new apply() on the same dir.
wctx.disposers.forEach((fn) => fn());
const wctx2 = new MockContext(wdir);
apply(wctx2 as never, { dataDir: wdir } as never);
await sleep(50);
await wctx2.emit("agent/created", { agent: { id: "w1" } });
const beforeResume = wlogCount();
await emitUser(wctx2, "w1", "在吗");
assert.equal(wlogCount(), beforeResume + 1, "restored persona keeps recording");

// A declared task session survives restart too.
await wctx2.emit("agent/created", { agent: { id: "w2" } });
await emitUser(wctx2, "w2", "任务窗口");
const beforeTask = wlogCount();
await emitUser(wctx2, "w2", "我今天好累");
assert.equal(wlogCount(), beforeTask, "task session records nothing");
wctx2.disposers.forEach((fn) => fn());
const wctx3 = new MockContext(wdir);
apply(wctx3 as never, { dataDir: wdir } as never);
await sleep(50);
await wctx3.emit("agent/created", { agent: { id: "w2" } });
const beforeTask2 = wlogCount();
await emitUser(wctx3, "w2", "我今天好累");
assert.equal(
  wlogCount(),
  beforeTask2,
  "restored task session stays read-only for memory",
);
assert.ok(
  existsSync(join(wdir, "window-audit.jsonl")),
  "mode switches are audited",
);
console.log("PASS WP1 shell: greeting / declaration / task / restart");

// ---- 终版 WP0: config/env conflict -> read-only mode
const rdir = mkdtempSync(join(tmpdir(), "memory-plugin-readonly-"));
const otherDir = mkdtempSync(join(tmpdir(), "memory-plugin-other-"));
process.env.MEMORY_PLUGIN_DATA_DIR = otherDir;
const rctx = new MockContext(rdir);
apply(rctx as never, { dataDir: rdir } as never);
await sleep(50);
const roStatusTool = rctx.tools.get("memory_status") as {
  execute: (args: unknown, exec?: unknown) => Promise<unknown>;
};
const roStatusOut = (await roStatusTool.execute({})) as {
  writeBlocked?: boolean;
  warning?: string;
  dataDir?: string;
};
assert.equal(roStatusOut.writeBlocked, true, "conflict enters read-only mode");
assert.ok(
  String(roStatusOut.warning).includes("冲突"),
  "warning names the conflict",
);
assert.equal(roStatusOut.dataDir, rdir, "config wins for dataDir display");
const roRememberTool = rctx.tools.get("memory_remember") as {
  execute: (args: unknown, exec?: unknown) => Promise<unknown>;
};
const roRememberOut = (await roRememberTool.execute(
  { text: "这条不该写进去" },
  { agent: { session: { id: "ro1" } } },
)) as { ok?: boolean; error?: string };
assert.equal(roRememberOut.ok, false, "write tool is refused");
assert.ok(
  String(roRememberOut.error).includes("拒绝"),
  "refusal explains why",
);
delete process.env.MEMORY_PLUGIN_DATA_DIR;
console.log("PASS WP0: config/env conflict is read-only");

// ---- 终版 WP4: fact warning + candidate wiring
await wctx3.emit("agent/created", { agent: { id: "w1" } });
const wmTool = wctx3.tools.get("memory_remember") as {
  execute: (args: unknown, exec?: unknown) => Promise<unknown>;
};
const wmExec = { agent: { session: { id: "w1" } } };
const wmOut = (await wmTool.execute(
  { text: "我喜欢吃西瓜", importance: "light" },
  wmExec,
)) as { ok?: boolean; id?: string; warning?: string };
assert.equal(wmOut.ok, true);
assert.ok(String(wmOut.warning).includes("factKey"), "missing factKey warns");

const wcOut = (await wmTool.execute(
  { text: "我可能养了一只猫，还没确认", candidate: true },
  wmExec,
)) as { ok?: boolean; id?: string };
assert.equal(wcOut.ok, true);
const wsTool = wctx3.tools.get("memory_search") as {
  execute: (args: unknown, exec?: unknown) => Promise<unknown>;
};
const wsDefault = (await wsTool.execute({ query: "猫" }, wmExec)) as {
  hits?: Array<{ id?: string }>;
};
assert.equal(
  (wsDefault.hits ?? []).some((h) => h.id === wcOut.id),
  false,
  "candidate is not in a default search",
);
const wsCand = (await wsTool.execute(
  { query: "猫", includeCandidates: true },
  wmExec,
)) as { hits?: Array<{ id?: string; candidate?: boolean }> };
assert.ok(
  (wsCand.hits ?? []).some(
    (h) => h.id === wcOut.id && h.candidate === true,
  ),
  "includeCandidates surfaces the candidate",
);
console.log("PASS WP4: fact warning + candidate search");

// ---- 终版 WP6: 8-category profile, sources required, no sensitivity
const wpTool = wctx3.tools.get("memory_profile") as {
  execute: (args: unknown, exec?: unknown) => Promise<unknown>;
};
const wpAdd = (await wpTool.execute(
  {
    category: "偏好",
    items: [{ text: "喜欢吃西瓜", sourceIds: [wmOut.id] }],
  },
  wmExec,
)) as { ok?: boolean; profile?: { categories?: Record<string, unknown[]> }; error?: string };
assert.equal(wpAdd.ok, true, String(wpAdd.error));
assert.ok(wpAdd.profile?.categories?.偏好?.length === 1, "category item stored");

const wpNoSource = (await wpTool.execute(
  { category: "偏好", items: [{ text: "没有来源", sourceIds: [] }] },
  wmExec,
)) as { ok?: boolean; error?: string };
assert.equal(wpNoSource.ok, false, "item without sources is refused");
assert.ok(String(wpNoSource.error).includes("sourceIds"));

const wpRead = (await wpTool.execute({ category: "偏好" }, wmExec)) as {
  ok?: boolean;
  profile?: { categories?: Record<string, unknown[]> };
};
assert.equal(wpRead.ok, true);
assert.ok(wpRead.profile?.categories?.偏好?.length === 1, "read one category");

const wpClear = (await wpTool.execute(
  { category: "偏好", clearCategory: true },
  wmExec,
)) as { ok?: boolean; profile?: { categories?: Record<string, unknown[]> } };
assert.equal(wpClear.ok, true);
assert.equal(wpClear.profile?.categories?.偏好, undefined, "cleared category is gone");
console.log("PASS WP6: profile categories + source validation + clear");

console.log(`\nALL PASS (data dir: ${dir})`);
