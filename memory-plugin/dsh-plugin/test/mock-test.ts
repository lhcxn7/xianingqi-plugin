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

import { strict as assert } from "node:assert";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { apply, inject, isPersonaTrigger, name } from "../src/index.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function check(label: string, fn: () => void): void {
  fn();
  console.log(`PASS ${label}`);
}

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

check("registers directives section and all five fallback tools (compiled JSON Schema)", () => {
  assert.ok(
    ctx.sections.some((s) => s.name === "memory-plugin:directives"),
  );
  const names = ctx.registeredTools.map((t) => t.name as string);
  for (const n of [
    "memory_search",
    "memory_remember",
    "memory_snapshot",
    "memory_restore",
    "memory_status",
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
  // The shell self-checks via ctx.tools.get: the registered copy must
  // also carry a legal schema.
  const viaGet = ctx.tools.get("memory_search") as {
    parameters?: { type?: string };
  };
  assert.equal(viaGet?.parameters?.type, "object");
  assert.equal(ctx.disposers.length, 1);
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

const d4 = decision("s3", "夏柠柒，好呀是什么意思");
await ctx.emit("agent/pre-step", d4);
const d4messages = d4.messages as Array<Record<string, unknown>>;

check("turn 2 does NOT append again; fresh hits register as context", () => {
  assert.equal(d4messages.length, 1);
  const rec = ctx
    .agentCtx("s3")
    .contexts.filter((c) => c.name === "memory-plugin:recall");
  assert.equal(rec.length, 1, "one context registered on turn 2");
  assert.ok(rec[0].text.includes("好呀"), "fresh hit (not in the turn-1 append) is the context");
});

const d4b = decision("s3", "夏柠柒，好呀是什么意思");
await ctx.emit("agent/pre-step", d4b);

check("turn 3 refreshes the context (old disposed)", () => {
  const rec = ctx
    .agentCtx("s3")
    .contexts.filter((c) => c.name === "memory-plugin:recall");
  assert.equal(rec.length, 2, "context refreshed on turn 3");
  assert.equal(rec[0].disposed, true, "old context disposed");
  assert.ok(rec[1].text.includes("好呀"));
});

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

const dRebuilt = decision("s1", "查岗怎么说");
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
await ctx.emit("agent/pre-step", decision("sA", "夏柠柒，好呀是什么意思"));
await ctx.emit("agent/created", { agent: { id: "sB" } });
await ctx.emit("agent/pre-step", decision("sB", "夏柠柒，查岗还记得吗"));
await ctx.emit("agent/pre-step", decision("sB", "夏柠柒，好呀是什么意思"));

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
      { role: "user", content: "夏柠柒，好呀是什么意思", source: { kind: "user" } },
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
      { role: "user", content: "夏柠柒，好呀是什么意思", source: { kind: "user" } },
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
  decision("s-m2", "夏柠柒，好呀是什么意思"),
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
  message: { content: "夏柠柒，恢复测试", source: { kind: "user" } },
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
// (a JSON array of strings: real names, emails, personal machine paths…).
// The repo must never contain any of those strings — and this test must
// never contain them either, so it reads them from that file instead of
// hard-coding them. If the file is absent (e.g. a fresh public clone),
// the check is skipped with a warning.
// 0.1.6: the check walks the WHOLE tree (not just the four docs), so a
// sensitive string added anywhere later is caught too. Binary files are
// skipped (a NUL byte in the first 8 KiB means "not text"); node_modules
// and .git are skipped as well.
const blocklistPath = fileURLToPath(
  new URL("../../../.memory-plugin-private-blocklist.json", import.meta.url),
);
let blocklist: string[] = [];
try {
  const parsed: unknown = JSON.parse(readFileSync(blocklistPath, "utf8"));
  if (Array.isArray(parsed)) {
    blocklist = parsed.filter((s) => typeof s === "string") as string[];
  }
} catch {
  console.warn(
    "[memory-plugin] private blocklist not found at " +
      blocklistPath +
      " — skipping the shipped-tree privacy check",
  );
}
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
function collectTextFiles(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectTextFiles(p, out);
    } else if (entry.isFile()) {
      const buf = readFileSync(p);
      if (!buf.subarray(0, 8192).includes(0)) out.push(p);
    }
  }
}
check("minor 5: shipped tree contains no private info (blocklist, whole-tree)", () => {
  const files: string[] = [];
  collectTextFiles(repoRoot, files);
  assert.ok(files.length > 0, "tree walk must find files to check");
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    for (const term of blocklist) {
      assert.ok(
        !text.includes(term),
        `${f} must not contain a blocklisted string`,
      );
    }
  }
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

// ---- M6 forced-error coverage (0.1.4): directory in place of a file ----
// Port of the independent re-verification's /tmp/m6-test.ts: force
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

// ---- unload + MEMORY.md untouched ---------------------------------------
for (const dispose of ctx.disposers) dispose();

check("M5/M12: unload runs endSession (a second snapshot exists)", () => {
  const snaps = readdirSync(join(dir, ".snapshots"));
  assert.ok(snaps.length >= 2, "compaction + unload each took a snapshot");
});

check("MEMORY.md bytes unchanged by every shell operation", () => {
  assert.equal(readFileSync(join(dir, "MEMORY.md"), "utf8"), memoryBefore);
});

console.log(`\nALL PASS (data dir: ${dir})`);
