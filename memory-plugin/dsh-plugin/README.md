# @memory-plugin/dsh-plugin

DSH shell around `@memory-plugin/core`: deterministic memory capture,
keyword recall injection and snapshots for persona AIs in DeepSeek
Harness. Local only — no network, no login, no cloud.

## Install (in DSH)

```sh
dsh plugin --profile <name> add "github:lhcxn7/xianingqi-plugin#v0.3.0&path:/memory-plugin/dsh-plugin"
```

or, for local development, load the patch overlay without installing:

```sh
pnpm dsh web --patch ./dsh-plugin/cordis.patch.yml
```

Requires DSH `0.2.1-rc.5 || >=0.2.0 <0.3.0` and Node `^22.19.0 || >=24.0.0`.

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
| `agent/created` | Track a new session. A rebuilt persona session keeps its flag (restored from the persisted `persona-sessions.json` in the data dir) and its turn-1 appended ids (restored from `appended-ids.json`, so the next turn does not re-register the same hits as context), and the old session's dynamic context is disposed first — never reset unconditionally. 0.2.0: also runs the daily review once here, but ONLY for a session already known to be persona (restored from the persisted set — a fresh session cannot be told apart from a task session yet, so it gets its first review on its next open; review-9 m-6). `core.review()`, 24 h gate inside, never forced — a review failure is caught and warned, never breaks the session; a due review regenerates the starmap. |
| `agent/pre-step` (awaited, `{prepend:true}`) | Keyword recall on the incoming user message(s), **persona windows only** (task windows get no recall injection at all). 0.2.0: recall gets the session id (recall-link tracking + relationship factor) and the session's last 5 user texts (attention factor, updated after the recall so the current turn never attends to itself). Turn 1 appends the recall to `decision.messages` (the only seam before the first model request, with a UUID id and array content like a real DSH message); later turns refresh the dynamic `systemPrompt.context`, registered per-agent through `agent.ctx` (never the global layer — two windows never collide on the name, and recall never leaks into task windows; if the per-agent registration itself fails, that turn simply skips injection instead of falling back to global). Two messages arriving before turn 1 recall on both (joined query). A pre-step with no user text does not consume the turn-1 append slot. No keyword match means no injection (no "most recent" fallback). A recall failure degrades to "no injection this turn" and never kills the turn. Turn 2+ never re-injects what the turn-1 append already put into session history (only not-yet-appended hits are registered as context). |
| `session/event` → `user/message` | Record into the core log — persona sessions only, real user messages only (plugin-injected messages carry `source.kind === "memory-plugin"` and are skipped so injected memory is never re-recorded). Real DSH 0.2.1 dispatches `session/event` as `(session, event)` with the message in `event.data` (verified live headless 2026-11-06; the handler also detects the trigger itself so the turn-1 message is recorded even though the event fires before pre-step). If `source.kind` is missing, the event type itself is trusted and one warning is logged instead of silently dropping the message. If the session id is missing, a fresh ephemeral id is minted per event and the message is not recorded. Pure-image messages record as `[图片]`; interrupted half-sentences are marked `[未说完]`. |
| `session/event` → `assistant/message` | Record into the core log — persona sessions only. Reasoning blocks are skipped (the model's inner voice, not her words). |
| `session/event` → `compaction/start` | Flush the pending index to disk AND take a snapshot (last chance before history is shadowed). |
| `agent/turn-stopping` | Flush the index at the turn boundary (a flush failure never fails the turn). |
| `ctx.effect` disposer | `endSession()` on unload: snapshot + rollover + flush. |
| `tools` | `memory_search` / `memory_remember` / `memory_fragment` / `memory_snapshot` / `memory_restore` / `memory_status` / `memory_starmap` fallback tools for the model to call on its own initiative. `memory_remember` is gated by the calling session (`exec.agent.session.id`): a task-window call is refused with `{ok:false}` instead of writing; it takes an optional `emotion` — free-form, any mood in the model's own words (`"温暖"`, `"委屈"`, `"傲娇"`, `"忐忑"` …, or `"温暖:0.7"`, parsed to `{type, intensity}`, unparseable means "not passed" and the core's keyword lexicon guesses). `memory_fragment` (0.3.0, also persona-gated) creates a fragment on top of the log: `sourceIds` + `text` (~10 tokens) + free-form `tone` + 1–2 verbatim `quotes`; the core code-verifies it against the sources and rejects it (with reasons) when the key terms, quotes or tone do not match. `memory_status` also returns `graphEdges`, `attributes` and `lastReviewAt` (0.2.0) plus `fragments` and `suspectFragments` (0.3.0). `memory_search` returns the fragment text (with its tone) for fragment-covered hits. `memory_starmap` regenerates `starmap.html` on demand and returns `{ok, path, nodes, edges, generatedAt}`; it is gated to persona windows like the other write tools. Tool parameters are compiled to real JSON Schema (by the real `defineTool` when it resolves, otherwise by the local compiler) and self-checked after register. `memory_restore` only accepts a plain snapshot directory name (`/`, `\` and `..` are rejected, in the tool and in the core); after a successful restore the shell reloads the persisted persona state (`persona-sessions.json` + `appended-ids.json`) from disk, so the in-memory flags follow the restored snapshot instead of silently undoing it. |

Injection uses `ctx.systemPrompt.section()` (stable directives: facts
only, no stage judgments) + `ctx.systemPrompt.context()` (dynamic
recall, refreshed every turn).

## 0.2.0: graph, attributes, activation, valve, review, starmap

The core does the calculation (see its README); the shell wires it
into DSH. Nothing here changes the persona/task rules: only persona
windows record and inject, task windows only read, and the plugin
still never writes MEMORY.md.

- **Graph (three edge types, 1–2 hops).** Memories link in
  `graph.json`: `session` (adjacent entries in one session),
  `keyword` (a shared rare keyword), `recall` (an entry a recall
  surfaced, and the conversation then moved to the next record in
  that session — the shell makes this possible by passing the
  session id to every recall). Recall expands keyword + recall
  edges 1–2 hops from the keyword seeds, so a memory with no
  shared keyword can still surface through a recall edge; a
  session-only neighbour does not expand.
- **Attributes.** Each entry carries emotion `{type, intensity}`,
  clarity, recallCount and significance in `attributes.json`.
  `memory_remember` takes an optional `emotion` string
  (`"温暖"` or `"温暖:0.7"`); the shell parses it and hands it to
  the core, and when it is absent or unparseable the core's
  keyword lexicon guesses. Retrievability is computed from these
  fields, never stored.
- **Five-factor activation.** Every recall candidate scores
  content × relationship × emotion × time × attention. The shell
  feeds two of the factors: relationship (the session id) and
  attention (the session's last 5 user texts, kept in session
  state and updated after each recall).
- **The 心光 valve, in two stages.** Stage 1, before the token
  cap: the activation threshold (0.02) drops diluted hits. Stage
  2, after the token cap: at most 2 hits per topic, at most 5
  hits total; an oversized entry that blows the token cap does
  NOT occupy a topic slot. Stage 2 runs on the injection path
  only — an explicit `limit` (the `memory_search` tool) disables
  it, but graph expansion still runs.
- **Daily review (24 h gate, only while DSH is open).** The shell
  calls `core.review()` once per `agent/created` — never forced,
  so it returns `null` inside the 24 h window and runs decay /
  promotion / compression / edge backfill only when due, then
  regenerates the starmap. There is no background service: a week
  without opening DSH is a week without review. A review failure
  is caught, warned once, and never breaks the session.
  `memory_status` reports the last review time (`lastReviewAt`)
  and the review's `lastStats` live in `review.json`.
- **Starmap (思维星空海).** `starmap.html` in the data dir, local
  only, no network: the 拾光 UI (0.3.1) — memories are stars on
  two spiral arms, sized by significance, coloured by category;
  a click opens a bottom detail panel (text, date, key badge,
  and for fragment stars the tone + verbatim source lines).
  There is no search, no time-flow slider, no 常用词 field, no
  brightness control — the old SVG renderer and its panel fields
  (emotion + intensity, clarity, recallCount, mentioned words)
  are gone. Regenerated after every review, and on demand via
  the `memory_starmap` tool (persona windows only), which returns
  `{ok, path, nodes, edges, generatedAt}`. It is a derived
  artifact — excluded from snapshots.

## 0.3.0: fragments + free-form emotion/tone

- **Fragments.** The `memory_fragment` tool (persona windows only)
  creates a fragment on top of the verbatim log — the log is never
  edited, the fragment only points at it (`sourceIds`). The model
  writes the short summary text, a free-form tone in its own words,
  and 1–2 verbatim quotes; the core verifies all three against the
  sources in code and rejects the fragment (with reasons) when they
  do not match. Recall then injects the fragment instead of the full
  originals, and the starmap draws one star per fragment (click
  shows text + tone + the source entries). The review proposes
  fragment clusters (`fragmentCandidates`) but never creates
  fragments itself. See the core README for the verification rules
  and the honest limit (subtle tone can still slip through).
- **Free-form emotion/tone.** Emotion and tone are the model's own
  words — no fixed list anywhere in the tagging path. The tool
  descriptions say so explicitly (with varied examples, not just
  温暖) so the model does not anchor on common emotions. The
  emotion lexicon was deliberately NOT expanded: it stays a coarse
  fallback for when the model is silent, and the tone lexicon
  likewise stays a verification vocabulary. Downstream handles
  arbitrary words: the activation emotion factor falls back from
  an exact type match to a coarse polarity match, and the starmap
  colours unknown types by polarity or the neutral default.

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
  daemon (in-process only), no vector/semantic recall (keyword only
  — 0.2.0 ranks keyword hits by five-factor activation, it does not
  add semantic search).

## Test (no real DSH needed)

```sh
node test/mock-test.ts
```

Drives every hook with a fake Cordis context: session tracking,
persona/task separation, turn-1 append vs turn-2 context refresh,
injected-message filtering, flush points, all seven fallback tools,
the 0.2.0 review gate / recall edge / emotion / starmap checks, the
0.3.0 fragment tool / fragment-aware search + status / free-form
emotion checks, and "MEMORY.md bytes unchanged". Exits non-zero on
any failure.

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
  (`0.2.1-rc.5 || >=0.2.0 <0.3.0`) and must be aligned with the installed DSH
  release at publish time; for a published package, vendor or build
  `dsh-tools` into the artifact so the real compiler is present.
