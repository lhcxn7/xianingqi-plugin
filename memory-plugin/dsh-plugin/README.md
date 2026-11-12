# @memory-plugin/dsh-plugin

DSH shell around `@memory-plugin/core`: deterministic memory capture,
keyword recall injection and snapshots for persona AIs in DeepSeek
Harness. Local by default — no login, no cloud; the only network step is
the optional one-time `semantic install --yes` (see the root README).

## Install (in DSH)

```sh
dsh plugin --profile <name> add "github:lhcxn7/xianingqi-plugin#v0.5.5&path:/memory-plugin/dsh-plugin"
```

or, for local development, load the patch overlay without installing:

```sh
pnpm dsh web --patch ./dsh-plugin/cordis.patch.yml
```

Requires DSH `0.2.1-rc.5 || 0.2.2-rc.1 || >=0.2.0 <0.3.0` and Node `^22.19.0 || >=24.0.0`.

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

## 0.4.8: dsh-tools schema adapter — tools register with dependencies installed

Same 13 tools, same parameters and return shapes. What changed
under them:

- **Schemas are normalized before either compiler sees them
  (define-tool.ts).** Codex on a real machine (Node 24.22.2,
  `@deepseek-ai/dsh-tools` installed) found the tool compiler
  rejects the schemas — `required: false` in parameters, object
  schemas without `additionalProperties` — and the plugin then
  skips registration, so none of the 13 tools registered. The
  sandbox mock tests never saw it (lenient mock compiler, real
  package never installed). `normalizeSchemaForDshTools` drops
  every `required: false` and adds `additionalProperties: false`
  to every object schema lacking it, nested included;
  `normalizeToolSpec` applies it to `parameters` and
  `output.schema`; the real-defineTool path goes through
  `compileWithDshTools` (plugin's own `execute` handler kept),
  the fallback through `compileToolLocally(normalizeToolSpec(tool))`.
  The 22 `required: false` sites in `index.ts` stay as-is — one
  choke point owns the dialect. Tests: mock 163 PASS (was 161,
  +1 adapter test on nested objects and the output schema, +1
  fallback test: a rejecting compiler falls back locally, warns
  once, keeps the plugin's execute handler).
- **A rejecting compiler no longer silences the plugin.** If the
  real defineTool throws even after normalization,
  `compileWithDshTools` warns once and compiles locally, so the
  tools still register. This is the second layer from the re-check,
  not a fix for a second observed rejection.
- **Install command and lock versions now say 0.4.8.** The README
  install line used to pin `#v0.3.0` (installing by the book would
  have pulled the old release); both lock files recorded 0.1.0 /
  0.1.7. Caveat: the adapter is verified by the mock test only in
  the sandbox; real registration still needs re-verification on a
  machine with the dependency installed.

## 0.4.7: 0.4.6 re-review pre-ship fixes (new issues 1–2) — reflection marking, proact overflow count

Same 13 tools, same parameters and return shapes. What changed
under them:

- **Merged recent section marks what a reflection save would
  refuse (core + shell).** The merged section shows every 24 h
  entry, including already-reflected ones, but the reflection
  gate excludes them — the model used to cite one and be refused.
  `registerModelReview` now calls `core.reflectionCheck()` when
  the section carries the reflection instruction (in try/catch —
  a failure degrades to no marking, never breaks the round) and
  passes its `sourceIds` as `reflectableIds` to
  `buildModelReviewPrompt`; shown entries outside the set carry
  "（本次反思不可引用）" and the instruction explains the mark.
  The same call sets the gate snapshot for the review path
  (0.4.3 item 8, same root). Tests: mock reproduces the audit's
  25-entry scenario end to end — the mark is present, a save
  citing the marked entry is refused, and a save citing an
  unmarked shown entry still succeeds 5 h later, past the 24 h
  boundary.
- **Standalone proact prompt counts its overflow (core).** The
  cap used to happen before `buildProactPrompt`, so the gate
  prompt never saw the overflow. The full 24 h list now goes in
  and the cap happens once inside; the prompt reports "另有 N 条
  未列出" (160 on a 200-entry day, plus 20 summary lines).
  Source ids are unchanged — still exactly the 20 shown entries.
  Tests: core 193 PASS (was 191), mock 161 PASS (was 157).

## 0.4.6: 0.4.5 re-review fixes (new issues 1–4) + 0.4.3 items 15–16 — merged recent section, entriesByIds guarded

Same 13 tools, same parameters and return shapes. What changed
under them:

- **Daily-review prompt: reflection + proact are one merged
  section now (core).** The two pasted prompts each listed all
  24 h of memories verbatim (~37k chars each on a chatty day);
  the merged section lists the notable entries once (top 20 /
  3000 chars, rest as id + summary). The shell carries the
  review's new `recentEntryIds` / `recentKinds` on the session
  from `agent/created` and resolves the ids at the first
  pre-step. The old pasted prompts remain as a fallback when no
  recent entries were carried.
- **A failing id-resolution read degrades, never breaks the
  round.** Both `core.entriesByIds` calls in
  `registerModelReview` are wrapped in try/catch degrading to
  `[]` (same rule as `yesterdayEntries`); a failed read warns
  once and the review context still registers.
- **Invalidation section capped (core).** At most 10 entries /
  2000 chars, overflow as id + summary — one oversized entry
  cannot blow the prompt (the first-entry truncation rule
  applies to all four sections).
- **Log + lock fixes (core).** Appends terminate a torn line
  first; a failing stale-lock reclaim yields and times out with
  a counted error instead of tight-looping (see core README
  0.4.6).
- **Mock test hour-proof (new issue 3).** The reflect-ctx block
  pins the clock to a fixed morning; the suite passes at any
  hour. Tests: mock 157 PASS (was 156: +1 entriesByIds), core
  191 PASS (was 184).

## 0.4.5: 0.4.3 review fixes, items 4 and 5 — review context capped, graph backfill idempotent

Same 13 tools, same parameters and return shapes. What changed
under them:

- **Daily-review prompt is capped (core).** Yesterday's entries
  are ranked by significance (the shell passes
  `core.significanceOf`), at most 60 entries / 8000 characters
  of entry text, shown chronologically; when the list is cut the
  prompt says only the important part is listed.
- **Review context auto-releases after 3 turns.** The
  daily-review context used to live in every request until the
  model called `memory_daily_review` — a chatty day pinned ten
  thousand words into the prompt indefinitely. Now the shell
  disposes it itself after `MODEL_REVIEW_AUTO_RELEASE_TURNS = 3`
  pre-step turns without a submission (the registration turn is
  turn 0: the model sees the context on 3 turns, then it is
  gone). Submitting via `memory_daily_review` still disposes on
  success; the auto-release is only the backstop, and it never
  fires on the registration turn itself.
- **Graph backfill is idempotent (core).** The daily review's
  backfill call is unchanged — it just stops growing the graph:
  the keyword-edge cap counts a node's existing live keyword
  edges, a second backfill adds no edges, and a session edge
  that also shares a rare keyword upgrades to keyword in place
  (type only, weight and clock untouched). Existing over-grown
  edges are NOT pruned in this release (prevent future growth
  only; pruning is a later decision).

## 0.4.4: 0.4.3 review fixes, items 1 and 2 — review proposals reach the model

Same 13 tools, same parameters and return shapes, except
`memory_status` gains one field. What changed under them:

- **Daily review carries the proactivity proposal.** The code
  review's `proactPrompt` used to be computed and discarded
  (no reader in this shell at all). It now travels on the
  session from `agent/created` and is pasted into the
  daily-review prompt next to the fragment / belief /
  reflection sections. The pasted text is the proposal's
  content; its token line is about a live gate call, not this
  review prompt — the prompt says so explicitly, so to act she
  calls `memory_proact` with `{}` first and gets a fresh
  prompt+token; not acting needs no call and consumes nothing.
- **Daily review carries the invalidation checks.** The review's
  `invalidationChecks` used to be only a flag in
  `attributes.json` that nothing ever read. The ids now travel
  on the session, are resolved to entries at the first pre-step
  (`core.entriesByIds`), and are pasted into the daily-review
  prompt with id + text; the model confirms via
  `memory_invalidate`, or leaves a check alone to be proposed
  again at the next review.
- **`memory_status` gains `pendingInvalidationChecks`.** The
  count of memories flagged for invalidation review and not yet
  invalidated — the same set the daily-review prompt draws its
  invalidation section from. The flag clears when the model
  invalidates the entry, when the opposing statement ages past
  the 30-day window, or when the entry drops out of the check's
  population; there is no explicit "still valid" confirmation
  (`memory_invalidate` has no keep-action — inaction + lapse is
  the answer).
- **Parser fix (core).** `- [HH:MM]` entries in MEMORY.md and
  archives now parse (see core README 0.4.4).

## 0.4.3: 0.4.2 review fixes — no tool changes

Same 13 tools, same parameters and return shapes. What changed
under them:

- **`memory_search`**: `layer1` now follows `profile.json` —
  after `memory_profile` writes a name/stage, the search
  result's `layer1` and `profileText` describe the same person
  (core `mergeProfile` change; no tool code changed).
- **`memory_reflect` save**: validates its sources against the
  snapshot of the gate prompt the model was shown, not a
  freshly recomputed gate — a source that crossed the 24 h
  boundary while the model was thinking is no longer refused.
  With no snapshot (never gated, or last gate below the floor)
  the save falls back to a fresh check.
- **`memory_proact`**: the prompt now tells the model to carry
  the gate's `promptToken` on the decision, `act: false`
  included (voids the prompt). `core.proactSave` takes no token
  parameter by decision: the token is enforced at this tool
  layer, core direct calls stay test-compatible.
- **Starmap labels**: two-line preview by product decision —
  the pill shows at most two lines of the original sentence,
  the full text is in the bottom panel on star click.
- **`memory_snapshot` / `memory_restore`**: `profile.json`
  is now snapshotted and restored with the log; audit trail,
  beliefs and loop state still are not.

## 0.4.2: starmap labels only — no tool changes

`memory_starmap` behaviour, parameters and return shape are
unchanged. The generated page now shows a two-line preview of each
star's original sentence beside it when the camera is close (11px
pill, max 24 visible, fades with distance; the pill text is
CSS-clamped to two lines — click the star for the full text in the
bottom panel), the bottom-panel badge shows the keyword
without its `约定.` / `ta.` prefix, and lone-star badges never
slice bigrams off the text (clean content word, else the category
name). See `core/README.md` for the rules.

## 0.4.1: merge of 4 increments from the independent 0.4.1 build

- **`memory_profile`** (persona only, 13th tool): writes name /
  stage / relationshipStage to `profile.json`; read call (`{}`)
  returns the current profile + `profileText` without writing.
  Profile injection still rides recall hits only.
- **`memory_proact` now carries a prompt token**: the gate returns
  `{prompt, promptToken}` (15 min TTL); a decision must carry the
  token and its trigger must be one of that prompt's sourceIds.
  Issuing a prompt spends no quota; `act: false` spends nothing
  and voids the token.
- **Core persona-source checks**: belief and reflection writes now
  require persona-window source entries at the core layer.
- **`recentTriggers`**: dropped actions' triggers stay cooled for
  7 days.
- **`memory_reflect` save enforces gate sources**: a save may only
  cite the ids in the current gate's prompt (`ReflectionCheck`
  carries `sourceIds`); out-of-gate sources are refused before
  any quote check.

## 0.4.0: four new tools (judgement to the model, arithmetic to code)

- **`memory_invalidate`** (persona only): marks entries and their
  graph edges expired by id; recall filters them out. Review only
  proposes; the model confirms — and since 0.4.4 the proposal
  reaches the model in the daily-review prompt (id + text), is
  re-listed at every review while the opposition is live, and
  `memory_status` shows the pending count. Audit trail in
  `invalidation-audit.jsonl` (append-only, not snapshotted).
- **`memory_belief`** (persona only): `create` / `support` /
  `contradict` / `get` over the safety / trust / closeness beliefs.
  `delta` is set by the model from evidence strength (required for
  support/contradict, clamped to ±0.2, strength stays 0..1); every
  quote must be verbatim from the log; the same contradicting entry
  deducts only once. `get` returns the three dimensions (strength /
  uncertainty / proofCount), no full quotes. `memory_status` also
  shows the three dimensions.
- **`memory_reflect`** (persona only): `{}` checks the tiny
  anti-disturbance floor (last-24 h new significance < 5 →
  `{triggered: false}`, no prompt, no model call); above the floor
  it hands the model the prompt and the model decides whether and
  what to reflect; a second call with `{text, sourceIds}` saves the
  conclusion as a `type: "reflection"` fragment (gold
  `stable_profile` star), 「」 quotes verified verbatim.
- **`memory_proact`** (persona only): `{}` checks the guardrails
  (1 action/day, same trigger once per 7 days, max 3 pending) and
  returns the prompt; a second call hands back the model's decision
  (`act` / `judgment` / `actionText` / `trigger`), which is parsed,
  re-checked against the guardrails and stored in `loop.json`.
  `act: false` or an unparseable decision means no action, no crash,
  no fallback sentence. `channel` is `"session"` only — `"qq"`
  returns `qq_not_connected`. Action text is always the model's own
  words; `loop.ts` contains no fixed sentences.

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

## 0.5.5: local-only follow-ups

- **One total injection budget.** `composeInjection` measures the
  final block (profile + hit lines + belief + experience) and trims
  in order: experience rules, belief line, lowest-ranked hits,
  profile; only a single over-budget profile is hard-truncated.
  `formatRecallBlock` itself stays budget-free for search results.
- **Fact chains are a validated version DAG.** When `supersedes` is
  present, a chain must have existing targets in the same factKey,
  at most one successor per version, exactly one current, and no
  cycle. Invalid chains keep a display current but contribute no
  ranking factor; entries with no links keep the old time-order
  fallback.
- **Experience governance.** `confirm` is CLI/API-only, `revoke` and
  optional `expiresAt` are available; a one-character trigger or a
  one-character shared token no longer fires. Expired/revoked rules
  are not injected; the model tool still cannot confirm itself.
- **No real-machine requirement** for this batch: budget, DAG and
  governance are covered by local unit/integration tests; real DSH
  and real BGE remain a separate acceptance step.

## 0.5.4: second external review fixes

- **Admin CLI token.** `serve` prints `token: ...` and a ready
  `curl -H "Authorization: Bearer ..."` line; `--token` lets the
  operator choose one. The API still requires the header.
- **Experience confirm is not a model action.** The `memory_experience`
  tool refuses `confirm`; confirmation is CLI / local admin API only,
  and records `confirmedBy` + `confirmedAt`. Unconfirmed rules never
  inject.
- **Goal/Experience writes use the Core lock.** Tools, CLI and API go
  through `MemoryCore.createGoal/updateGoal/setStatus/removeGoal` and
  `recordExperience/confirmExperience/removeExperience`, which take
  the write lock, refresh stale state and validate live persona
  sources. No direct Store save from the shell.
- **Delete transaction covers forgetting state.** `forgotten.json` and
  `forget-requests.json` are in the snapshot; an interrupted delete
  restores log + derived data + tombstones + request state. If the
  snapshot is missing/unreadable, the journal is kept as evidence.
- **Snapshot covers experiences/goals.** Restore reloads them with the
  log and revalidates `sourceIds`; an Experience with no live source
  drops back to unconfirmed, a Goal drops invalid source ids.
- **Model is bundled and automatic.** The model ships at
  `dsh-plugin/models/bge-small-zh-v1.5/`; the plugin finds it without a
  manual copy. `<dataDir>/models/bge-small-zh-v1.5/` still wins if
  present. `@huggingface/transformers` is an optionalDependency, so a
  normal plugin install brings the runtime; a portable zip needs one
  `npm install --prefix dsh-plugin`.

## 0.5.3: remaining audit closures

- **Delete journal.** `forget-journal.json` is written before the
  first delete mutation and marked `committed` after the last one.
  A restart that finds a non-committed journal restores the safety
  snapshot taken just before the delete, then reloads every store.
- **Embedding runtime from the data dir.** The provider resolves
  `@huggingface/transformers` from `<dataDir>/node_modules` first
  (`npm install --prefix <dataDir> @huggingface/transformers@3.8.1`)
  and falls back to the normal import. The install path no longer
  depends on DSH's plugin-folder layout.
- **Experience provenance.** `memory_experience add` requires
  `sourceIds` pointing at live persona entries; a new rule is
  unverified and is NOT injected until `confirm`. Old rows without
  the confirmation bit are candidates, not trusted prompt rules.
- **Forget boundary disclosed.** `dry-run` lists `MEMORY.md` /
  `MEMORY-YYYY-MM.md` copies. `executeForget({purgeSkillFiles:true})`
  is an explicit opt-in that backs up each skill file and removes
  only lines containing the exact deleted text.
- **Admin API auth.** Loopback alone is no longer accepted: every
  request needs `Authorization: Bearer <token>`; the token is
  returned by `startAdminServer()`.
- **Log diagnostics.** A corrupt JSONL line in the middle (not just
  the torn last line) warns once per file instead of silently
  shrinking the log.
- **Review scope.** Daily review processes persona, non-tombstoned
  entries only; task rows no longer get attributes/compression/edges.

## 0.5.2: audit fixes (privacy + data integrity)

- **Hidden means hidden everywhere.** `proactPrompt`, the review
  input, the reflection gate, the starmap, and every fragment /
  belief / reflection source check now exclude tombstoned entries.
  A hidden memory can no longer reappear through a belief line or a
  proactivity prompt.
- **Forget loading never fails open.** `forgotten.json` is loaded
  independently of `forget-requests.json`; a corrupt tombstone table
  sets `forgottenLoadFailed` and `isForgotten()` returns true for
  every id until the operator restores it. The request list is
  separate: a corrupt request file only loses pending requests.
- **Owner-only files on POSIX.** New data dirs are `0700`, the raw
  log is `0600`, atomic writes already were. (Windows uses ACL
  inheritance; the mode argument is ignored there.)
- **Restore is a rollback, not a merge.** Plugin-owned files that
  exist now but are absent from the snapshot are removed; the
  semantic index and pending reflection gate are dropped and the
  starmap is regenerated.
- **No developer seeds.** `ExperienceStore` starts empty; the three
  project debug rules are test fixtures, not user prompt content.
- **Task windows cannot read persona memory.** An explicit
  `memory_search` with a task-window caller is refused (automatic
  pre-step injection was already gated).
- **Goal/edit/vector hygiene.** `Goal.update` rejects non-finite
  `dueAt`, oversized `notes`, and malformed `sourceIds`;
  `MemoryAdmin.editEntry` refreshes the vector; semantic rebuild
  clears first, top-N is filtered by the allowed id set, a failed
  provider load is retryable, and cosine rejects dimension/NaN
  mismatches.
- **Test/type portability.** Windows skips POSIX mode assertions;
  the process-start assertion uses a generous window; a type-only
  shim lets a clean package `tsc` without the optional
  `@huggingface/transformers` runtime.

## 0.5.1: review fixes (0.4.3 + 0.4.5)

- **Persona windows only.** `memory_search` defaults to `window:
  "persona"` — a task-window log entry never surfaces in a persona
  search (the log is append-only, so a direct write is the only way
  a task entry gets in, and the window filter is the fence).
  `memory_restore` refuses in a task window (and writes nothing —
  no safety snapshot either); `memory_snapshot` is deliberately
  ungated, since it only copies files and changes no memory.
  `memory_daily_review` checks the ids it is given against the ids
  the review prompt actually showed (whitelist, capped at 60,
  single-use); a call with no live whitelist falls back to
  yesterday's ids, so an id recorded after the review registered
  can never be marked. Fragments can only be built from persona
  sources — `createFragment` rejects a task-window source with the
  same wording the belief/reflection checks use.
- **Early exit, fixed twice.** The 0.4.5 fix for "yesterday empty
  kills the proposals" first read the review kinds object as a
  proposal even when both kinds were false; the condition now reads
  the kinds' values. Yesterday empty AND no proposals still
  registers nothing.
- **Deferral.** `memory_belief`, `memory_reflect` and
  `memory_proact` now carry `deferLoading: true`, like
  `memory_feedback`; the flag is passed through by both compilers.
  Runtime behaviour on real DSH is still unverified (0.4.8 was
  never installed on a real machine either).
- **Review copy.** `memory_status` now describes
  `pendingInvalidationChecks` as "awaiting the next review"
  (expired-but-unreviewed marks still count until the next review
  clears them). The merged recent section tells her to take a fresh
  `memory_proact({})` gate call before acting on a proact proposal
  — the prompt text itself carries no token, and a model that calls
  `memory_proact` straight from the review gets the gate's token
  and a fresh prompt, not the review's copy.
- **Benchmark (0.5.1).** Keyword-only: coverage 0.923, Recall@5
  0.8, MRR 0.733, no-evidence false positives 0.167 (was 0.5).
  `--rewrite`: 1.0 / 1.0. q15 conflict order is fixed in this
  version (fact chain below) — it no longer waits for 0.6.0.
- **Fact version chain.** `memory_remember` takes optional
  `factKey` / `supersedes`: same fact, new version. "现在" ranks
  the current version first (q15 美式 rank 1, was 4); "以前"
  ranks the old version first; a superseded hit shows `·旧版`.
- **Forgetting, governed.** `memory_forget` (persona-gated,
  `deferLoading`) only files a request, dry-runs, or lists —
  it has no approve / execute action at all. Approval lives in
  the admin CLI / local API only, on a non-model channel; a chat
  "我同意" can never authorise a deletion or a hide. See the
  core README for the hide / delete mechanics and the 7-day TTL.
- **Local embedding.** `semanticRecall` config (`enabled`,
  `modelDir`, `modelRevision`, `timeoutMs`, `maxCandidates`,
  `minSimilarity`); default off. When enabled, the plugin builds
  the index in the background (never blocks activation) and the
  pre-step / `memory_search` paths await semantic candidates
  with the configured timeout, falling back to keyword-only.
  The model files ship inside the plugin under
  `dsh-plugin/models/bge-small-zh-v1.5/`; the plugin finds them
  automatically (a copy in `<dataDir>/models/bge-small-zh-v1.5/`
  takes precedence). A nomodel package needs the model copied in
  manually — see `MODELS.md` for hashes. Measured: synonym Recall@5
  0.625 → 0.875, MRR 0.500 → 0.667, false positives 1/6 (see
  `LOCAL-EMBEDDING.md`).
- **Admin centre (CLI + local API first).** No web UI yet. The
  plugin itself does not serve the API — run
  `node core/src/admin-cli.ts --dataDir <dir> serve` (or
  `… serve --port N --token T`). The command prints the bearer
  token; every request needs
  `Authorization: Bearer <token>`.
- **Experience learning + goals.** Two new persona-gated,
  `deferLoading` tools: `memory_experience` (add / list / match
  — rules learned from mistakes, injected as `经验：` rows when
  they match) and `memory_goal` (create / list / get / update /
  complete / reopen / drop / remove). `memory_status` now
  reports `openGoals`, `doneGoals`, `pendingForgets` and
  `semantic: {enabled, modelPresent, indexSize}`. Seventeen
  tools total.

## 0.5.0 (fixed): provenance, feedback, rewritten recall

0.5.0 is the five-step release: (1) an honest benchmark set, (2) the
record-side split, (3) provenance / trust, (4) the fourteenth tool
(`memory_feedback`), (5) query-rewrite hybrid recall. Embedding stays
out of scope — no model file ships.

- **Provenance** (`core/src/provenance.ts`): every fragment and belief
  carries `sourceIds`, `sourceType` (`user_quote` / `model_quote` /
  `model_summary` / `model_inference` / `legacy`), a code-computed
  `confidence`, `verifyCount` and `lastVerifiedAt`. The model proposes
  the type only; the number is recomputed on read. Pre-0.5.0 rows load
  as `legacy` with `confidence: null` — never forged. `memory_search`
  hits carry all seven fields; low-confidence fragment hits are demoted,
  not deleted.
- **`memory_feedback`** (14th tool, persona windows only): `correct`
  counts a verification, `wrong` invalidates through the same path as
  `memory_invalidate` (audit line included), `irrelevant` halves
  significance for the first two calls and caps the ranking factor at
  0.25×. The description is one short line and `deferLoading: true`;
  the flag is passed through by both compilers.
- **Query rewrite** (`queryRewriter` on `MemoryPluginConfig`): the host
  injects the model call; the plugin awaits it with a 3 s timeout and
  falls back to keyword-only on timeout / throw / empty / unchanged.
  The rewritten tokens union with the original ones, so a bad rewrite
  can never lose the original recall. No rewriter = exactly the old
  keyword path. `SemanticRetriever` is interface-only.
- **Benchmark** (`core/test/benchmark-050.*`): 18 memories, 21 queries
  (6 synonym / 6 time / 3 conflict / 6 no-evidence), 6 sessions.
  Keyword-only: coverage 0.923, Recall@5 0.8, MRR 0.683, no-evidence
  false positives 0.5, 62.6 injected tokens. The `--rewrite` run uses a
  deterministic six-pair synonym stub, not a model: its 1.0 / 0.922
  proves the pipeline only; with the stub table emptied it falls back
  to 0.8 / 0.5. q02/q05 are the recall regression (single-char
  bridges); q06 was already `rank null` in 0.4.8. q15 conflict order is
  still open (0.6.0 fact-version chain).
- **Fixes in this archive**: the record-side memory-object rule
  (`更新一下记忆` / `删除这条记忆` no longer mark a persona session);
  `irrelevant` stops halving significance after two calls; legacy
  fragments no longer gain a `verifyCount` from a recall; the rewrite
  timeout is cleared; the lock files say 0.5.0; `engines.dsh` now also
  lists `0.2.2-rc.1`.

## Known limitations (0.5.0 fixed — verified 2026-11-10)

- **DSH baseline.** `engines.dsh` is
  `0.2.1-rc.5 || 0.2.2-rc.1 || >=0.2.0 <0.3.0`; semver 7.8.6 says
  this covers the user's own **0.2.2-rc.1** as well as the verified
  `0.2.1-rc.5`. It has NOT been run on 0.2.2-rc.1 yet — a real-DSH
  smoke test is still needed. Node engines
  (`^22.19.0 || >=24.0.0`) were verified here on Node v24.22.1.
- **`deferLoading` on `memory_feedback`.** Verified locally against
  `@deepseek-ai/dsh-tools@0.2.1-rc.5`: `defineTool` keeps the flag and
  `schemaOf` projects it onto the model-facing schema; the current
  host's `ToolSchema` also declares `deferLoading?: true`. The actual
  deferred-loading behaviour still needs a real-DSH check; the
  one-line description is the mitigation if the host ignores it.
- **Query rewrite needs a host-injected `queryRewriter`.** The
  plugin context exposes no model-call API, so the model call
  lives with the host (`MemoryPluginConfig.queryRewriter`). Without
  one, recall is keyword-only exactly as before. The rewriter in
  the tests and the benchmark is a deterministic synonym stub,
  not a model.
- **`SemanticRetriever` is interface-only.** No embedding model
  ships, nothing is downloaded or bundled; a real provider plugs
  into the `opts.semantic` slot later.

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
  daemon (in-process only), no vector/semantic recall ships
  (keyword + query-rewrite hybrid — 0.5.0 ranks keyword hits by
  five-factor activation, the rewrite only adds query words, and
  SemanticRetriever is an interface-only slot with no embedding
  bundled).

## Test (no real DSH needed)

```sh
node test/mock-test.ts
```

Drives every hook with a fake Cordis context: session tracking,
persona/task separation, turn-1 append vs turn-2 context refresh,
injected-message filtering, flush points, all fourteen tools,
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
  (`0.2.1-rc.5 || 0.2.2-rc.1 || >=0.2.0 <0.3.0`) and must be aligned with the installed DSH
  release at publish time; for a published package, vendor or build
  `dsh-tools` into the artifact so the real compiler is present.
