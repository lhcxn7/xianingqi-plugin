// Minimal structural subset of the DSH Cordis Context that this plugin
// uses. The real Context (passed in by DSH at runtime) structurally
// matches this; the plugin never imports DSH types, so it loads without
// the host packages installed (used by the local mock test).
//
// Event/handler shapes follow the hooks verified in
// research_notes/dsh-plugin-api-memory-hooks-20261105-0930/report.md:
// - agent/pre-step is a waterfall (awaited): handler receives
//   (decision, next); appending to decision.messages injects recall.
// - session/event is emit (fire-and-forget): real DSH 0.2.1
//   dispatches it as (session, event) — the first arg is the session
//   object (with .id), the second is the event ({type, data, seq}).
//   The message lives in event.data ({role, content, source}).
//   Verified 2026-11-06 in a live headless DSH 0.2.1-rc.5 run; the
//   old single-arg assumption read the session object as if it were
//   the event, so nothing was ever attributed or recorded. A
//   single-arg call is still tolerated (legacy shape / mock test).
// - systemPrompt.section/context and tools.register are as in
//   dsh-honcho (systemPrompt injection + defineTool registration).
// - systemPrompt.section/context and tools.register are as in
//   dsh-honcho (systemPrompt injection + defineTool registration).

export interface ChatMessage {
  role?: string;
  content?: unknown;
  source?: { kind?: string };
  [key: string]: unknown;
}

export interface PreStepDecision {
  messages?: ChatMessage[];
  /** Real DSH 0.2.1: the fused dispatcher adds `agent` to every
   *  pre-step payload (agentEvents fuses it in); agent.id is the
   *  shared agent/session id and agent.ctx is the per-agent scoped
   *  context — the dynamic recall context is registered there, not
   *  on the global layer (audit B1/M1). There is deliberately NO
   *  sessionId field: real DSH never provides one (audit m9). */
  agent?: {
    id?: string;
    ctx?: { systemPrompt?: SystemPromptRegistry };
  };
  [key: string]: unknown;
}

export interface SessionEvent {
  type?: string;
  name?: string;
  kind?: string;
  sessionId?: string;
  session?: { id?: string };
  agentId?: string;
  /** Real DSH 0.2.1 agent/created payload: {agent, source}. The
   *  agent object carries .id (the shared agent/session id). */
  agent?: { id?: string; session?: { id?: string } };
  /** Real DSH 0.2.1: the message payload lives here. */
  data?: unknown;
  message?: ChatMessage;
  text?: string;
  content?: unknown;
  source?: { kind?: string };
  [key: string]: unknown;
}

export interface SystemPromptRegistry {
  section(opts: { name: string; order: number; text: string }): void;
  context(opts: {
    name: string;
    order: number;
    text: string;
  }): unknown;
}

export interface ToolRegistry {
  register(tool: unknown): void;
  /** Real DSH ToolRegistry: look a registered tool up (global view
   *  when scope is omitted) so the shell can self-check the
   *  model-visible parameters after register (audit M2). */
  get?(name: string, scope?: unknown): unknown;
  schemas?(scope?: unknown): unknown[];
}

export interface MemoryPluginConfig {
  /** Data directory (xia-ningqi-data style). Default ~/.dsh/xia-ningqi-data. */
  dataDir?: string;
  /** Max estimated tokens for injected recall. Default 1500. */
  tokenCap?: number;
  /** 终版 WP5: how many recall candidates the valve keeps for the
   *  model to choose from. Default 8, clamped 1..10. This is soft
   *  guidance, not a "use exactly N" rule. */
  valveTop?: number;
  /** Substrings marking a session as a persona window. Default the
   *  skill's own trigger: messages containing 夏柠柒 / 柠柒. */
  triggerWords?: string[];
  /** 0.3.0: substrings marking a mid-turn message as explicitly
   *  reaching for the past (condition (a) of the restrained
   *  mid-conversation recall trigger). Default
   *  DEFAULT_MEMORY_CUE_WORDS. */
  memoryCueWords?: string[];
  /** 终版 WP1: exact phrases that switch the session mode. The text
   *  is stripped of trigger words and punctuation first; the rest
   *  must equal one of these. Defaults to
   *  DEFAULT_DECLARATION_PHRASES. */
  declarationPhrases?: { task: string[]; persona: string[] };
  /** 终版 WP1: an assistant reply longer than this (in code points)
   *  is treated as task output, not her words. Only applies to a
   *  turn whose user message was task/greeting. Default 800. */
  assistantPersonaMaxChars?: number;
  /** 2026-11-12 工作区隔离：只有工作目录落在这些人设工作区（含子目录）里的会话，
   *  才允许被触发词标成 persona、才记录消息。空或未配置 = 旧行为（不限工作区）。
   *  单工作区版里设成角色的工作区，例如 'C:\\夏柠柒'。 */
  personaWorkspace?: string;
  /** 0.5.0 step 5: query rewriter — a host-injected async
   *  function that rewrites / expands the user's question before
   *  recall (the model call lives with the host: this plugin's
   *  context exposes no model-call API). Absent = keyword-only,
   *  exactly as before. The rewritten text is passed to core
   *  alongside the original query; its tokens union with the
   *  original's, so a bad rewrite can never lose the original
   *  recall. Return null / undefined / "" to skip rewriting for
   *  this turn. */
  queryRewriter?: (
    query: string,
  ) => Promise<string | null | undefined>;
  /** 0.5.0 step 5: how long to wait for the rewriter per recall
   *  turn (ms). A timeout falls back to the original query,
   *  keyword-only — it never blocks the turn. Default 3000. */
  rewriteTimeoutMs?: number;
  /** 0.5.1 item 2: local embedding (bge-small-zh-v1.5, ONNX
   *  int8, CPU). Default OFF — disabled means the model is never
   *  loaded and recall is exactly keyword-only. When enabled, the
   *  plugin builds the index once at startup (background) and
   *  awaits the semantic search per turn with timeoutMs, falling
   *  back to keyword-only on timeout or any error. modelDir
   *  defaults to <dataDir>/models/bge-small-zh-v1.5/ — copy the
   *  shipped models/ directory there first (see MODELS.md). */
  semanticRecall?: {
    enabled?: boolean;
    /** 终版 WP9: when `enabled` is omitted, auto-enable if runtime +
     *  model are present. Default true. */
    autoEnable?: boolean;
    modelId?: string;
    modelDir?: string;
    modelRevision?: string;
    timeoutMs?: number;
    maxCandidates?: number;
    /** 终版 WP8: max vectors in the semantic index (default 10000).
     *  Over the cap, the rebuild keeps importance × recency. */
    maxEntries?: number;
    /** Similarity floor for semantic candidates (default 0.5). */
    minSimilarity?: number;
  };
}

export interface MemoryPluginContext {
  // NOTE: there is deliberately NO config field here. In real
  // Cordis/DSH the plugin's own config arrives as the SECOND
  // parameter of apply(ctx, config); ctx.config does not exist and
  // reading it throws "cannot get property config without inject",
  // which fails plugin activation. (Found 2026-11-05 in a live DSH
  // 0.2.1-rc.5 run; the mock test used to hide it because the fake
  // ctx was a plain object carrying config.)
  // agent/pre-step is a waterfall: the handler receives
  // (decision, next) and MUST return next()'s result (see the NOTE
  // in index.ts). Its `next` is typed here so a handler can call it
  // under --strict; the generic overload below would leave it
  // `unknown` (truthiness-narrowed to `{}`), which is uncallable.
  on(
    event: "agent/pre-step",
    handler: (decision: unknown, next: () => unknown) => unknown,
    opts?: { prepend?: boolean },
  ): void;
  on(
    event: string,
    handler: (...args: unknown[]) => unknown,
    opts?: { prepend?: boolean },
  ): void;
  systemPrompt: SystemPromptRegistry;
  tools: ToolRegistry;
  effect(fn: () => () => void): void;
}
