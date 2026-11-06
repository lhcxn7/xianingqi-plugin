# @memory-plugin/dsh-plugin

DSH shell around `@memory-plugin/core`: deterministic memory capture,
keyword recall injection and snapshots for persona AIs in DeepSeek
Harness. Local only — no network, no login, no cloud.

## Install (in DSH)

```sh
dsh plugin --profile <name> add github:<owner>/memory-plugin
```

or, for local development, load the patch overlay without installing:

```sh
pnpm dsh web --patch ./dsh-plugin/cordis.patch.yml
```

Requires DSH `>=0.2.0 <0.3.0` and Node `^22.19.0 || >=24.0.0`.

## Config

Declared on the plugin (defaults in parentheses). In Cordis/DSH the
config arrives as the **second parameter of `apply(ctx, config)`** —
never as `ctx.config`, which does not exist on a real Context
(reading it throws and the plugin fails to activate; fixed
2026-11-05 after a live DSH 0.2.1-rc.5 run caught it — the mock test
had hidden it because the fake ctx carried config):

- `dataDir` — memory data directory
  (default `~/.dsh/xia-ningqi-data`; env `MEMORY_PLUGIN_DATA_DIR`
  overrides it too).
- `tokenCap` — max estimated tokens for injected recall (default 1500).
- `triggerWords` — substrings marking a session as a persona window
  (default `["夏柠柒", "柠柒"]`, the skill's own trigger).

## Hooks (verified against the research report)

| Hook | What it does |
| --- | --- |
| `agent/created` | Track a new session. A rebuilt persona session keeps its flag (restored from the persisted `persona-sessions.json` in the data dir) and its turn-1 appended ids (restored from `appended-ids.json`, so the next turn does not re-register the same hits as context), and the old session's dynamic context is disposed first — never reset unconditionally. |
| `agent/pre-step` (awaited, `{prepend:true}`) | Keyword recall on the incoming user message(s), **persona windows only** (task windows get no recall injection at all). Turn 1 appends the recall to `decision.messages` (the only seam before the first model request, with a UUID id and array content like a real DSH message); later turns refresh the dynamic `systemPrompt.context`, registered per-agent through `agent.ctx` (never the global layer — two windows never collide on the name, and recall never leaks into task windows; if the per-agent registration itself fails, that turn simply skips injection instead of falling back to global). Two messages arriving before turn 1 recall on both (joined query). A pre-step with no user text does not consume the turn-1 append slot. No keyword match means no injection (no "most recent" fallback). A recall failure degrades to "no injection this turn" and never kills the turn. Turn 2+ never re-injects what the turn-1 append already put into session history (only not-yet-appended hits are registered as context). |
| `session/event` → `user/message` | Record into the core log — persona sessions only, real user messages only (plugin-injected messages carry `source.kind === "memory-plugin"` and are skipped so injected memory is never re-recorded). Real DSH 0.2.1 dispatches `session/event` as `(session, event)` with the message in `event.data` (verified live headless 2026-11-06; the handler also detects the trigger itself so the turn-1 message is recorded even though the event fires before pre-step). If `source.kind` is missing, the event type itself is trusted and one warning is logged instead of silently dropping the message. If the session id is missing, a fresh ephemeral id is minted per event and the message is not recorded. Pure-image messages record as `[图片]`; interrupted half-sentences are marked `[未说完]`. |
| `session/event` → `assistant/message` | Record into the core log — persona sessions only. Reasoning blocks are skipped (the model's inner voice, not her words). |
| `session/event` → `compaction/start` | Flush the pending index to disk AND take a snapshot (last chance before history is shadowed). |
| `agent/turn-stopping` | Flush the index at the turn boundary (a flush failure never fails the turn). |
| `ctx.effect` disposer | `endSession()` on unload: snapshot + rollover + flush. |
| `tools` | `memory_search` / `memory_remember` / `memory_snapshot` / `memory_restore` / `memory_status` fallback tools for the model to call on its own initiative. `memory_remember` is gated by the calling session (`exec.agent.session.id`): a task-window call is refused with `{ok:false}` instead of writing. Tool parameters are compiled to real JSON Schema (by the real `defineTool` when it resolves, otherwise by the local compiler) and self-checked after register. `memory_restore` only accepts a plain snapshot directory name (`/`, `\` and `..` are rejected, in the tool and in the core); after a successful restore the shell reloads the persisted persona state (`persona-sessions.json` + `appended-ids.json`) from disk, so the in-memory flags follow the restored snapshot instead of silently undoing it. |

Injection uses `ctx.systemPrompt.section()` (stable directives: facts
only, no stage judgments) + `ctx.systemPrompt.context()` (dynamic
recall, refreshed every turn).

## Persona vs task windows

The plugin uses the skill's own trigger: a session becomes a persona
session when a user message in it contains 夏柠柒 / 柠柒. Task windows
never trigger, so their messages are never recorded — and since v1.1
they get no recall injection either (not even turn 1). Known limitation:
a task-window message that happens to contain the trigger is recorded
too — the same ambiguity the skill itself has.

By design, messages sent BEFORE the first trigger word in a session
never enter the verbatim log: the plugin only knows a session is a
persona window once the trigger appears. The skill's own MEMORY.md
summary may still retain those lines (the model writes it); the
plugin's verbatim log does not.

## Real-DSH envelope: verified (headless 0.2.1-rc.5, 2026-11-06)

The hook shapes above were verified live in headless DSH 0.2.1-rc.5
on this machine (fake key; the turn fails at the model call with
401, as expected): `session/event` really is `(session, event)` with
the message in `event.data`, assistant settlements really nest the
message under `data.message`, and the pre-step decision really
carries `agent` (with `agent.ctx` for per-agent registration). The
remaining check is a full live conversation on the user's own DSH:
check `log.jsonl` grows for persona turns and stays still for task
turns, and that a second window's persona turn does not crash.

## What it deliberately does NOT do (v1)

- **No deletion veto.** There is no `tools/pre-execute` listener in
  this plugin. The skill (v2.3+) routes a delete of skill/memory/diary
  through the persona, stage-based, and late stage may actively
  execute it — a blanket plugin veto would make late-stage execution
  impossible and fight the skill, and the plugin cannot judge whether
  the persona consented. Deletion is governed by the skill's persona
  rule + snapshots/backups. The plugin never claims to block a user
  deleting files in Explorer, or any deletion outside DSH.
- **Never writes `MEMORY.md`.** The core writes only its own log +
  index; the three-layer summaries stay model-written per the skill.
- **Injects facts only, never stage judgments;** stage comes from
  `MEMORY.md` layer 1. Recall text excludes layer 1 (the skill already
  reads it at open).
- No compaction-hook rotation (no such seam exists), no background
  daemon (in-process only), no vector/semantic recall (keyword only).

## Test (no real DSH needed)

```sh
node test/mock-test.ts
```

Drives every hook with a fake Cordis context: session tracking,
persona/task separation, turn-1 append vs turn-2 context refresh,
injected-message filtering, flush points, both fallback tools, and
"MEMORY.md bytes unchanged". Exits non-zero on any failure.

Real-DSH testing: the mock suite does not cover a live
conversation, but headless verification against real DSH 0.2.1-rc.5
has been run repeatedly (event envelope, tool registration,
recording, snapshots) — see the audit notes. A live conversation on
the user's own DSH is still the final check for her writing MEMORY.md
summaries.

## Publish notes

- `main` points at `./src/index.ts` for local dev (Node runs the TS
  directly). A published package needs a build step (`tsc` producing
  `index.js` + `lib/`, wired through the `prepare` script) because a
  GitHub install fetches sources, not built artifacts — see the
  research report §1.
- `@deepseek-ai/dsh-tools` is loaded dynamically, but it NEVER
  resolves in a `link:` install (live verified 2026-11-06) — so the
  loader compiles tool parameters to JSON Schema locally instead
  (flat spec map → `{type:"object", properties, required}`), warns
  loudly once when the real package is missing, and the shell
  self-checks every registered tool's parameters after register. In
  DSH the real `defineTool` is used when it resolves. Its version
  range in `package.json` mirrors the DSH engine range
  (`>=0.2.0 <0.3.0`) and must be aligned with the installed DSH
  release at publish time; for a published package, vendor or build
  `dsh-tools` into the artifact so the real compiler is present.
