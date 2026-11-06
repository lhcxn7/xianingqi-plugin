// Minimal structural subset of the DSH Cordis Context that this
// plugin uses. The real Context (passed in by DSH at runtime)
// structurally matches this; the plugin never imports DSH types, so
// it loads without the host packages installed (used by the local
// mock test).
//
// This plugin is tools-only by design: it registers two tools and
// ONE static systemPrompt section (tool-usage instructions only —
// the section names the tools and when to call them, and carries no
// canon content, no entries, no memories). It never calls ctx.on,
// never registers ctx.effect, and never touches
// systemPrompt.context — so the interface below exposes ONLY
// ctx.tools and ctx.systemPrompt.section. If a future version ever
// needs a hook or dynamic context, the interface must grow with it
// and the README's "tools-only" claim must be re-examined first
// (the skill's iron law — novel plot never enters dialogue unasked
// — is the reason auto-injection is off the table).

export interface ToolRegistry {
  register(tool: unknown): void;
  /** Real DSH ToolRegistry: look a registered tool up (global view
   *  when scope is omitted) so the shell can self-check the
   *  model-visible parameters after register. */
  get?(name: string, scope?: unknown): unknown;
  schemas?(scope?: unknown): unknown[];
}

/** Minimal systemPrompt surface this plugin uses: the static
 *  section() only. There is deliberately NO context() here — the
 *  plugin never registers dynamic context (that would inject
 *  content into the prompt every turn), and the type must not let a
 *  future edit call it by accident. */
export interface SystemPromptRegistry {
  section(opts: { name: string; order: number; text: string }): void;
}

export interface CharacterDbPluginConfig {
  /** Character-db directory (a folder holding the collection JSON
   *  files, e.g. xia-ningqi/). Default:
   *  ~/workspace/character-db/xia-ningqi. Overridable by the
   *  CHARACTER_DB_DATA_DIR environment variable. */
  dataDir?: string;
  /** Max estimated tokens for one character_search answer.
   *  Default 1500. Results past the cap are dropped (lowest score
   *  first) and the answer says so. */
  tokenCap?: number;
}

export interface CharacterDbPluginContext {
  // NOTE: there is deliberately NO config field here. In real
  // Cordis/DSH the plugin's own config arrives as the SECOND
  // parameter of apply(ctx, config); ctx.config does not exist and
  // reading it throws "cannot get property config without inject",
  // which fails plugin activation. (Found 2026-11-05 in a live DSH
  // 0.2.1-rc.5 run for the sibling memory plugin; the mock test
  // covers this with a Proxy that throws on any ctx.config access.)
  // There is also deliberately NO on / effect / systemPrompt.context
  // here: this plugin registers tools and one static section, and
  // nothing else. The section is static text (tool usage only) —
  // registering it needs the "systemPrompt" inject (see the inject
  // export in index.ts), which is why systemPrompt is a required
  // field here, not an optional one.
  tools: ToolRegistry;
  systemPrompt: SystemPromptRegistry;
}
