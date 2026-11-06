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
  /** Substrings marking a session as a persona window. Default the
   *  skill's own trigger: messages containing 夏柠柒 / 柠柒. */
  triggerWords?: string[];
}

export interface MemoryPluginContext {
  // NOTE: there is deliberately NO config field here. In real
  // Cordis/DSH the plugin's own config arrives as the SECOND
  // parameter of apply(ctx, config); ctx.config does not exist and
  // reading it throws "cannot get property config without inject",
  // which fails plugin activation. (Found 2026-11-05 in a live DSH
  // 0.2.1-rc.5 run; the mock test used to hide it because the fake
  // ctx was a plain object carrying config.)
  on(
    event: string,
    handler: (...args: unknown[]) => unknown,
    opts?: { prepend?: boolean },
  ): void;
  systemPrompt: SystemPromptRegistry;
  tools: ToolRegistry;
  effect(fn: () => () => void): void;
}
