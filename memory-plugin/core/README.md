# @memory-plugin/core

Shared local-file memory engine. Zero runtime dependencies, no network
calls, no login, no cloud. Runs on Node `^22.19.0 || >=24.0.0` — the
TypeScript sources use only erasable syntax, so Node runs them directly
(type stripping); no build step is needed.

## Division of labour with the skill (anti-conflict rules, v1)

- The plugin writes ONLY its own files: the append-only log
  (`log.jsonl`, rolled into per-month `log-YYYY-MM.jsonl`
  segments), its keyword index (`index.json`), and since 0.2.0 the
  graph (`graph.json`), per-memory attributes (`attributes.json`),
  review state (`review.json` + compressed summaries) and the
  derived starmap (`starmap.html`); since 0.3.0 the fragments
  (`fragments.json`, a summary layer on top of the log). It NEVER
  writes `MEMORY.md` — the three-layer summaries stay written by
  the model following the skill.
- The core READS `MEMORY.md` (all three layers + monthly archives) for
  recall, and reads layer 1 so it knows the stage — but it injects only
  what the skill has NOT already read (raw-log fragments and archive
  detail), never layer 1 itself, so the same memory never appears twice
  in context.
- The plugin injects facts only and never makes stage judgments; stage
  comes from `MEMORY.md` layer 1.
- Nothing is ever deleted by the core *as memory*: log rollover MOVES
  entries into segments; snapshots copy; restore snapshots first and
  only replaces files present in the snapshot (files outside the
  snapshot, e.g. the diary, are left alone). Snapshots themselves
  rotate (default keep=30) — old snapshot *copies* are deleted, not
  memory entries.
- Multi-process writes to one directory are protected by the file
  lock (`src/lock.ts`): every write (record, rollover, snapshot,
  restore, index rebuild) holds an atomic-mkdir lock in
  `<dataDir>/.locks/write.lock` (PID + timestamp inside, 5 s
  acquire timeout, stale only when older than 30 s AND the owner
  PID is gone, Windows-safe, no flock). A writer that cannot get
  the lock errors back instead of writing; a writer that finds
  another writer moved first reloads before appending, so a flush
  never saves a stale index. Reads stay safe (torn lines are
  skipped). One limit remains: a process only recalls what it
  loaded — another process's entries become visible at its next
  flush or restart.

## What it does

| Concern | Module | Behaviour |
| --- | --- | --- |
| Append-only log | `src/log.ts` | Every recorded message appended as one JSON line: timestamp, role, session id, window kind (persona/task), importance, text. A torn last line (crash mid-write) is skipped on read, never fatal. |
| Keyword index | `src/keyword-index.ts` | Word → entry ids, updated on every write, persisted to `index.json` on flush. Tokeniser handles CJK (overlapping bigrams + short runs) and latin words. |
| Three-layer files | `src/memory-file.ts` | READ-ONLY reader for `MEMORY.md` and `MEMORY-YYYY-MM.md` in the existing Xia format (see below). Parser is tolerant of hand-written files. |
| Importance | `src/core.ts` | `heavy` (promises, firsts, fights-and-reconciliations, bottom lines, stage changes) outranks `light` in recall and is never dropped from the index. Month-end compression of `MEMORY.md` stays model-side. |
| Atomic writes | `src/atomic.ts` | Write temp file in the same directory → fsync → rename over target → fsync directory. A crash leaves either the old or the new file, never a half-written one. |
| Snapshots | `src/snapshot.ts` | Dated full copies of the data folder (default keep 30). Restore first snapshots the current state, so restore is itself reversible. |
| Log rollover | `src/core.ts` | When the current log passes the entry cap (default 1000), or at session end, its entries move into per-month `log-YYYY-MM.jsonl` segments. Segments stay indexed and searchable. NOT a compaction hook — DSH has none. |
| File lock | `src/lock.ts` | Atomic-mkdir lock (`<dataDir>/.locks/write.lock`, PID + timestamp in `owner.json`): mkdir wins the lock, retry with a 5 s cap, stale only when older than 30 s AND the owner PID is dead, release removes only a lock it still owns. Works on Windows (no flock). `withWriteLock` wraps every write; re-entrant within one instance. |
| Recall | `src/recall.ts` | Keyword match + importance + recency, ranked, with a token cap (default 1500) so the caller never injects an unbounded blob. Recall dedupes against MEMORY.md: a log hit whose normalised text (whitespace/punctuation stripped, lowercased) mutually contains a Layer 1 / Layer 2 entry and is ≥10 chars is dropped, keeping the curated MEMORY.md copy; archive hits are exempt (the skill does not read archives at open). Exact/near containment only — no semantic judgement, nothing deleted from disk. 0.2.0: hits are ranked by five-factor activation (see below), the graph expands them 1–2 hops, and the 心光 valve caps what is injected. |
| Graph | `src/graph.ts` | Links between memories, persisted in `graph.json`: `session` (adjacent entries in one session), `keyword` (a shared rare keyword), `recall` (entry A was recalled and the conversation then moved to B). Recall expands keyword + recall edges 1–2 hops (content × edge weight, halved on the second hop), so a memory with no shared keyword can still surface through a recall edge; session-only neighbours are NOT expanded. |
| Attributes | `src/attributes.ts` | Per-memory attributes in `attributes.json`: emotion `{type, intensity}` (model-supplied via `record({emotion})`, otherwise guessed from a keyword lexicon), clarity (1.0 fresh, decays with time, rises on recall, never reaches 0), recallCount, significance (heavy 0.9, light 0.4, promise/first/fight keywords 0.8; review raises it for repeatedly recalled entries). Retrievability is computed from these fields, never stored. |
| Activation | `src/activation.ts` | Five factors multiply: content × relationship × emotion × time × attention. Any zero factor is zero. Content is the keyword match; relationship comes from the session/recall-link history; emotion from the stored tag; time from age and clarity; attention from the session's recent user texts (the shell passes them). |
| Review | `src/review.ts` | Daily sedimentation (`review.json`): decay clarity on old memories (important ones decay slower), promote repeatedly recalled memories, compress light old memories (≥30 days, significance < 0.5) to one line in `summary-YYYY-MM.jsonl` — the original log entry is NEVER touched — and backfill graph edges for entries that predate the graph. Runs only when due (>24 h since the last review, `review(force)` overrides) and only while DSH is open: there is no background service, so the DSH shell calls it at session start. A review regenerates the starmap afterwards. |
| Starmap | `src/starmap.ts` | 思维星空海: `generateStarmap()` renders the current graph + attributes + log into a local `starmap.html` (no external URLs, no network) using the 拾光 single-file UI (0.3.1): memories are stars on two spiral arms, sized by significance, coloured by category (fragment gold / event blue / emotion pink); a click opens a bottom detail panel (text, date, key badge, and for fragment stars the tone + verbatim source lines); drag rotates, wheel zooms, and the newest star pings on load. There is no search, no time-flow slider, no 常用词 field, no brightness control — the old 0.2.0/0.3.0 SVG renderer (and its emotion-coloured stars, recall-chain lighting and time slider) is gone. Emotion / clarity / recallCount are still carried in DATA but 拾光 does not render them. A derived artifact — excluded from snapshots, regenerated on review and on demand (the shell's `memory_starmap` tool). |

## The three-layer format (read by the core, written by the skill)

`MEMORY.md`, in the skill's existing shape (skill v2.4 is canonical;
the parser also reads the plugin's older hand-written shape, see
below):

- **Layer 1 — current state, at the head, always read on open, never
  archived away:** name, stage, 喜好, 厌恶, agreements, counters,
  `最后更新时间`, and `重要记忆` (heavy entries kept as standing lines).
- **Layer 2 — recent 30 days:** dated sections `## YYYY/MM/DD`, entries
  `[HH:MM] 事件一句话` with minute-precision times.
- **Layer 3 — monthly summaries:** `旧月份总结区` with lines like
  `- YYYY-MM: 共 N 条, 其中重要 M 条; 大事: ...`, plus detail in
  `MEMORY-YYYY-MM.md`, retrievable by month or keyword.

Older plugin-shaped files are still read: dated sections
`### YYYY/MM/DD`, entries `- HH:MM [role|window|importance] text`,
layer-1 keys `喜欢` / `不喜欢`, layer 3 titled `月度归档`.

Existing memory files carry over untouched: the parser reads the
documented shape even when it was written by hand (or by the model
following the skill), without requiring the exact canonical markers.

## 0.2.0: graph, attributes, activation, valve, review, starmap

The skill is the person and its rules; the core is the notebook and
the calculation. 0.2.0 adds memory that links, fades and resurfaces —
still keyword-only, still local files, still never writing MEMORY.md.

- **Graph (three edge types, 1–2 hops).** Every `record()` links the
  new entry: `session` to the previous entry in the same session,
  `keyword` to entries sharing a rare keyword, `recall` to the
  entries a recall surfaced just before this record (tracked
  per-session by the shell passing `sessionId` to `recall()`).
  Recall expands keyword + recall edges 1–2 hops from the keyword
  seeds — a memory with no shared keyword still surfaces when a
  recall edge connects it — and session-only neighbours do not
  expand. A second hop halves the inherited content.
- **Attributes.** Each entry carries emotion, clarity, recallCount
  and significance in `attributes.json` (see the table above).
  `record()` takes an optional `emotion: {type, intensity}` —
  model-supplied; when absent the keyword lexicon guesses. Recall
  bumps a surfaced entry (`recallCount++`, clarity +0.15,
  persisted at `flush()`).
- **Five-factor activation.** Every candidate scores
  content × relationship × emotion × time × attention; any factor
  at zero zeroes the whole score. The shell feeds the relationship
  factor (via `recall({sessionId})`) and the attention factor (via
  `recall({recentTexts})` — the session's recent user texts).
- **The 心光 valve, in two stages.** Stage 1, before the token cap:
  the activation threshold (0.02) drops diluted hits — a short
  query can still surface an old hit the threshold would otherwise
  drop, because the query's own content factor is higher. Stage 2,
  after the token cap: at most 2 hits per topic, at most 5 hits
  total; an oversized entry that blows the token cap does NOT
  occupy a topic slot. Stage 2 runs on the injection path only: an
  explicit `limit` (e.g. the `memory_search` tool) disables it,
  but graph expansion still runs — expansion is part of recall
  itself, not of the valve.
- **Daily review.** `core.review()` runs decay / promotion /
  compression / edge backfill and writes `review.json`
  (`lastStats`: decayed / promoted / compressed / edgesAdded),
  then regenerates the starmap. It returns `null` when the last
  review was under 24 h ago; `review(true)` forces it. It runs
  only while DSH is open — there is no background service, so the
  shell calls it at `agent/created` and a week without opening DSH
  is a week without review.
- **Starmap.** `core.generateStarmap()` returns
  `{path, nodes, edges, generatedAt}` and writes `starmap.html`
  into the data dir. The DSH shell exposes it as the
  `memory_starmap` tool (persona windows only) and regenerates it
  after every review. `core.stats()` now also returns `graphEdges`,
  `attributes` and `lastReviewAt`; `core.flush()` persists the
  index + graph + attributes together.

## 0.3.0: fragments (summary layer on top of the log)

The log stays the ground-truth base, verbatim, never edited, with
NO tone in it. `fragments.json` holds short model-written summaries
(~10 tokens each): `id`, `sourceIds` (provenance, mandatory),
`text`, `tone` (free-form label in the model's own words +
`level` + `intensity`), `quotes` (1–2 verbatim phrases copied from
the source), `topic`/`keywords`, `createdAt`, `verified`.

- **Creation is verified by code, twice over.** `core.createFragment(input)`
  (the `memory_fragment` tool) rejects a fragment whose key terms
  or quotes do not appear in its source entries' text, whose text
  is longer than 30 estimated tokens, or whose KNOWN tone tag is
  more than 1 level from the sources' attitude markers — and
  returns the reasons so the caller can fix it. Nothing is saved
  on rejection. A free-form tone the lexicon cannot place maps to
  level `unknown` and the tone check is skipped for it (never
  failed on tone alone); only a clear contradiction fails.
- **Retrieval re-checks and falls back.** `recall()` injects the
  fragment text (with its tone tag, marked `·片段·<tone>`) instead
  of the full originals — one fragment injected once even when
  several of its sources surface — and the token cap + valve are
  unchanged. A fragment that fails its retrieval-time re-check
  injects the verbatim source instead (marked `·原文`) and is
  marked `suspect` in memory (persisted at `flush()`), so the next
  review can fix or drop it; a suspect fragment is never injected
  again. A fragment's edges in the starmap come from its sources'
  edges; unfragmented entries still appear as their own stars.
- **Review proposes, never creates.** `core.review()` returns
  `fragmentCandidates` (clusters of 2+ entries sharing a rare topic
  token, none already fragmented, max 5) — the model then creates
  fragments through `memory_fragment`, so both paths share the same
  verification. `core.stats()` also returns `fragments` and
  `suspectFragments`; `core.flush()` persists fragments too;
  snapshots cover `fragments.json`.
- **Honest limit.** Code checks catch gross fabrication and clear
  tone mismatches, but subtle tone can still slip through — a
  fragment that paraphrases without any lexicon word, or a free-form
  tone the lexicon cannot place, passes the tone check as
  inconclusive. Verification is a safety net, not a guarantee.
- **Free-form emotion/tone.** Emotion and tone are the model's own
  words — no fixed list anywhere in the tagging path. The emotion
  lexicon (`tagEmotion`) was deliberately NOT expanded: it stays a
  coarse fallback for when the model is silent, and the tone
  lexicon stays a verification vocabulary. Downstream handles
  arbitrary words: `emotionFactor` tries an exact type match, then
  a coarse polarity match (same polarity 0.7, opposite 0.2, unknown
  or explicitly neutral polarity 0.5); `emotionColor` falls back to a polarity
  colour, then the neutral default — an unknown word still renders
  a star.

## 0.4.8: dsh-tools schema adapter + install/lock version fixes

Fixes the Codex real-environment finding (2026-11-10, real Node
24.22.2 + installed `@deepseek-ai/dsh-tools`): with dependencies
installed, the tool compiler rejected the tool schemas — parameters
carry `required: false`, and object schemas have no
`additionalProperties` — the plugin caught the error and skipped
registration, so none of the 13 tools registered. The sandbox mock
tests never saw it: the mock compiler is lenient and the real package
was never installed there. The fix is a single choke point in
`dsh-plugin/src/define-tool.ts`, not 22 edits in `index.ts`:

- **`normalizeSchemaForDshTools`** walks a schema recursively,
  drops every `required: false`, and adds `additionalProperties:
  false` to every object schema lacking it (nested objects
  included).
- **`normalizeToolSpec`** applies it to a tool's `parameters` and
  its `output.schema`.
- **`compileWithDshTools`** normalizes before the real defineTool
  compiles the schemas, and keeps the plugin's own `execute`
  handler (defineTool still compiles both schemas).
- The local fallback path normalizes too:
  `compileToolLocally(normalizeToolSpec(tool))`.

The 22 `required: false` sites in `dsh-plugin/src/index.ts` are
deliberately left as-is — the concise declarations stay readable
and the adapter owns the dialect. A second layer (from the
re-check): if the real compiler still rejects a normalized schema,
`compileWithDshTools` catches it, warns once (`dsh-tools defineTool
编译失败，改用本地 schema 编译`), and falls back to the local
compiler — the tools register anyway instead of the whole plugin
going silent. Install command and guide text
now say v0.4.8; both lock files now record 0.4.8 (were 0.1.0 /
0.1.7). Tests: core 193 PASS, mock 163 PASS (was 161, +1 adapter
test covering nested objects and the output schema, +1 fallback
test covering a rejecting compiler and the once-only warning), `tsc` 0
errors on core. Caveat: the adapter is verified by the mock test
only in the sandbox; real registration still needs re-verification
on a machine with the dependency installed.

## 0.4.7: 0.4.6 re-review pre-ship fixes (new issues 1–2)

Fixes from the 0.4.6 independent re-review (real data + real DSH
source), both pre-ship items. The blocklist item is NOT touched
(user decision: "先不管" stands); 0.4.3 items 6–14 and 0.4.5-review
new issues 6–9 are not in this release.

- **The merged recent section marks what a reflection save would
  refuse (new issue 1).** The merged section shows every 24 h
  entry, including already-reflected ones — but the reflection
  gate excludes reflected entries, so the model used to cite one
  and be refused ("来源 X 不在本次反思提示里"). The shell now
  calls `core.reflectionCheck()` when building the merged section
  and passes its `sourceIds` as `reflectableIds` to
  `buildModelReviewPrompt`: a shown entry outside the set carries
  "（本次反思不可引用）" and the reflection instruction explains
  the mark. The mark is deliberately neutral, not "already
  reflected": an entry can also fall outside the gate's shown top
  20 when new entries arrived after the review was computed. The
  same call sets the gate snapshot for the review path (0.4.3
  item 8, same root) — before this the review path never set one
  and the save fell back to a freshly recomputed gate, which
  could refuse a source that crossed the 24 h boundary while the
  model was thinking. Tests: 25 fresh memories, the top one
  already reflected — the merged section marks exactly that row,
  a save citing it is refused, and a save citing an unmarked
  shown entry still succeeds 5 h later, past the boundary.
- **The standalone proact prompt counts its overflow (new issue
  2).** `proactShownMemories` used to cap the list before
  `buildProactPrompt`, so the prompt never saw any overflow — on
  a 200-entry day the model was never told 180 more memories
  existed. `proactPrompt` now hands the full 24 h list to
  `buildProactPrompt` (which caps once, top 20 / 3000 chars) and
  `proactPromptSourceIds` reads the same cap through a shared
  `proactSelection`, so the source ids are still exactly the
  entries shown in full. Tests: 200 entries → 20 shown + 20
  summaries + "另有 160 条未列出", source ids still 20.

## 0.4.6: 0.4.5 re-review fixes (new issues 1–4) + 0.4.3 review items 15 and 16

Fixes from the 0.4.5 independent re-review (real data + real DSH
source) and the remaining data-loss / deadlock items of the 0.4.3
review. The blocklist item is NOT touched (user decision:
"先不管" stands); 0.4.3 items 6–14 and 0.4.5-review new issues
6–9 are not in this release.

- **The daily-review prompt has a cap as a whole, not just its
  yesterday section.** The 0.4.5 cap (top 60 / 8000 chars) only
  covered "yesterday's conversation": the reflection and proact
  sections each listed all 24 h of memories verbatim (~37k chars
  each on a chatty day, 84,955 total on real data — bigger than
  0.4.3). Both now travel as ONE merged recent section
  (`recentEntries` + `recentReflection` / `recentProact` options
  on `buildModelReviewPrompt`): the notable entries listed once
  (top 20 / 3000 chars by significance, the rest as id + one-line
  summary, at most 20 summary lines, the unlisted remainder
  counted), with short instructions for both tools. The old
  pasted prompts stay as a fallback for callers that still hand
  over pre-built strings. The shared helper is
  `selectCappedEntries` (exported): rank by significance, show
  chronologically, hard character budget per section. Tests: a
  200-yesterday + 200-today chatty day builds a prompt of
  ~11.4k chars (assert < 20000); the merged section replaces the
  pasted prompts (their marker text is absent when kinds are set).
- **One oversized memory can no longer blow a cap (new issue
  5, folded into issue 1).** 0.4.5 took the first ranked entry
  whole ("always taken", so a single 20k-char memory punched
  straight through the 8000 cap). `selectCappedEntries` now
  truncates an over-budget first entry to the remaining budget +
  "…" — in all four sections (yesterday, merged recent,
  reflection, proact) and in the invalidation section too.
  Entries skipped for budget are listed as id + summary, never
  dropped silently. Tests: a 20k-char first entry truncates to
  3000 + "…"; overflow beyond 20 summary lines is counted
  ("另有 N 条未列出").
- **Reflection and proact prompts are capped the same way.**
  `buildReflectionPrompt` / `buildProactPrompt` take the same
  top-20 / 3000-char cap (optional `significanceOf` /
  `maxEntries` / `maxChars` overrides); the gates pass
  `significanceOf` through, and the core keeps prompt and
  sourceIds consistent: `reflectionCheck` snapshots only the
  SHOWN entries (a save may only cite memories the model was
  shown in full — summaries are not citable), and
  `proactPrompt` / `proactPromptSourceIds` share one capped
  list. Tests: 200-entry prompts stay under 6000 chars;
  `reflectionCheck` on 30 gate entries returns exactly 20
  sourceIds, all shown in full in the prompt.
- **Invalidation checks stop flagging the persona's own name
  (new issue 2).** The old rule flagged any two persona memories
  sharing one ≥2-char token with different negation: on real
  data it flagged "夏柠柒，我喜欢你" and "夏柠柒" as possibly
  outdated — they share only her name, the negation sat in an
  unrelated spot. Topic tokens now exclude the persona name /
  trigger words (from the profile name), `COMMON_TOKENS`, and
  tokens with document frequency > 5 over persona entries; a
  negation only counts when its span overlaps the shared token
  (strict, required for a lone shared token) or sits within 1
  char (loose, allowed with ≥2 shared words); and a check needs
  ≥2 shared real words, or a single shared token that is itself
  a phrase — with the two sides differing on that attachment.
  The review also returns `recentEntryIds` (reflection entries
  ∪ proact memories, deduped) and `recentKinds`
  (`{reflection, proact}`) so the shell can build the merged
  section. Tests: the two real-data cases are no longer flagged;
  7 entries sharing 酸梅汤 are not flagged; the true
  contradiction ("他喜欢吃辣" vs "他不吃辣了") still is.
- **Log append terminates a torn line first (0.4.3 item 15).**
  `AppendLog.append` used to append straight onto a torn last
  line (crash mid-append): the new line glued onto the torn
  half, the whole JSON line failed to parse, and `readAll`
  skipped both — the new entry and the torn half together. If
  the file is non-empty and its last byte is not `\n`, a newline
  is written first; the torn half stays as its own (skipped)
  line and the new entry survives. Tests: torn half-line + one
  append → both real entries readable.
- **A failing stale-lock reclaim yields and times out (0.4.3
  item 16).** `acquireWriteLock`'s stale branch `continue`d on
  both outcomes, skipping the deadline check and the sleep: when
  `deleteDirIfOwnerMatches` kept returning false (rm throws —
  on Windows a lock dir held open by another process cannot be
  removed), the loop spun forever without yielding or ever timing
  out. Only a successful reclaim `continue`s now; a failed one
  falls through to the deadline/sleep like a live lock, counts
  the failure, and the timeout error reports it ("N stale-lock
  reclaim attempt(s) failed"). A test hook
  (`LOCK_TEST_RECLAIM_FAIL=1`, following the
  `LOCK_TEST_BREAK_DELAY_MS` precedent) forces the failure so
  the test can prove it. Tests: stale lock + forced reclaim
  failure → throws within the 500 ms timeout naming the reclaim
  failures; the stale lock is left alone, and a normal acquire
  breaks it once the hook is off.
- **Mock test no longer depends on the hour (new issue 3).**
  `mock-test.ts` built "yesterday's memory" as `Date.now() -
  20h`, which lands today 00:00–04:00 at 20:00–24:00 local, so
  `yesterdayEntries()` returned 0 and the suite aborted at 139
  PASS. The reflect-ctx block now pins `Date.now` to a fixed
  morning (2026-11-07 10:00, like core's `local()`), restored in
  `finally`. The suite passes at 22:xx local. Tests: mock 157
  PASS (was 156 + 1 new).
- **Shell: `entriesByIds` failures degrade, never break the
  round (new issue 4, dsh-plugin).** Both `entriesByIds` calls
  in `registerModelReview` (recent entries, invalidation
  entries) were outside any try — an I/O error inside
  `refreshIfStale()` would propagate out of the awaited
  `agent/pre-step` and kill the whole round. Each is now wrapped
  in try/catch degrading to `[]` (same rule as
  `yesterdayEntries`), with a distinct warn. Tests: a mock test
  stubs `MemoryCore.prototype.entriesByIds` to throw between
  `agent/created` and the first pre-step and asserts the round
  still returns `next()`'s value, the daily-review context still
  registers with yesterday's entries, and the merged section
  degrades to its empty note.
- Tests: core 191 PASS (was 184: +1 invalidation, +4 prompt
  caps, +1 log, +1 lock), mock 157 PASS (was 156: +1
  entriesByIds), `tsc` 0 errors on core.

## 0.4.5: 0.4.3 review fixes, items 4 and 5

Fixes from the 0.4.3 independent review (real data + real DSH
source). The blocklist item is NOT touched (user decision:
"先不管" stands); items 1–2 were fixed in 0.4.4, items 6–16 are
not in this release.

- **Daily-review prompt is capped.** `buildModelReviewPrompt`
  takes an optional trailing `significanceOf` (the shell passes
  `core.significanceOf`, a read-only accessor over the attribute
  store — a missing row falls back to the entry's initial
  significance, never creates a row). Yesterday's entries are
  ranked by significance, at most 60 entries / 8000 characters
  of entry text, then shown chronologically so the model reads a
  conversation, not a ranking; when the list is cut the prompt
  says so ("只列了重要的部分", with the day's total). Without a
  significance function the entries keep their given order and
  only the caps apply. The first ranked entry is always taken, so
  a single oversized entry cannot blank the whole review. Tests:
  100 entries → top 60 by significance, 200-char entries → 40
  fit in 8000 chars, no note when the whole day fits.
- **Graph backfill is idempotent.** The keyword-edge cap used to
  count only the edges made in the current call, so every daily
  backfill added up to 3 more edges to colder tokens (real data:
  156 edges, one node at keyword degree 15, design cap 3). The
  cap now counts the node's existing live keyword edges
  (expired/invalidated ones do not diffuse, so they do not
  consume the budget either): a second backfill adds no edges,
  and total keyword edges are bounded by 3 per entry. A popular
  node can still hold more than 3 edges in total — its own 3
  plus incoming ones from other entries' processing — but the
  total stops growing. Also, a backfill may now upgrade a session
  edge to a keyword edge in place (type only, weight and clock
  untouched, so decay survives) when the pair also shares a rare
  keyword; keyword edges are built before the session edge, so a
  fresh pair gets the keyword edge at keyword weight directly.
  Existing over-grown edges are NOT pruned in this release
  (user decision: prevent future growth only; pruning is a later
  decision). Tests: backfill twice / three times adds no edges,
  degree does not grow, upgrade keeps weight 0.5 and clock.

## 0.4.4: 0.4.3 review fixes, items 1 and 2

Fixes from the 0.4.3 independent review (real data + real DSH
source). The blocklist item is NOT touched (user decision:
"先不管" stands); items 4–5 and 6–16 are not in this release.

- **Parser reads the real `- [HH:MM]` shape.** The model
  writes layer-2 entries as `- [18:07] text` (dash + bracketed
  time); the old `SKILL_ENTRY_LINE` only matched the bare
  `[HH:MM]` shape, so a real MEMORY.md parsed as 0 layer-2
  entries — `layer2Count` 0, memory_status "最近 30 天条数"
  stuck at 0, layer-2 dedup dead, and the next monthly archive
  would not recall. The regex is now
  `/^\s*(?:[-*+]\s+)?\[(\d{2}:\d{2})\]\s+(.*)$/`; archives share
  the line parser so they get the fix for free. The demo fixture
  now mixes both shapes, and a new test builds a 74-entry
  real-shape file and asserts all 74 parse and `layer2Count`
  is 74.
- **Invalidation checks stop being write-only.** The 0.4.0 code
  skipped a flagged entry forever (`if
  (attrs.needsInvalidationCheck) continue`), so a check the model
  never acted on vanished from every later review — and nothing
  anywhere read the flag, so the model could never have acted on
  it in the first place. Now a flagged entry is re-evaluated and
  re-listed at every review while the opposition is still live.
  The flag only clears when the check is resolved: the model
  invalidates the entry (`attributes.invalidate` clears it), the
  opposing statement ages past the 30-day window (lapse — the
  model had up to 30 days of daily prompts to act), or the entry
  drops out of the check's population (invalidated, or
  significance below the 0.5 floor). There is no explicit "still
  valid" confirmation: `memory_invalidate` has no keep-action,
  so inaction + lapse is the answer — the entry stays valid and
  the flag goes away on its own. Tests: re-list at the next
  review, lapse at 31 days, invalidate clears the flag.
- **Review proposals reach the model.** `buildModelReviewPrompt`
  takes two new trailing parameters (`proactPrompt`,
  `invalidationEntries`) and appends two sections after the
  reflection section: the proactivity proposal (pasted verbatim,
  with a note that its token line is about a live gate call, not
  this review prompt — to act she calls `memory_proact` with `{}`
  first and gets a fresh prompt+token; not acting needs no call)
  and the invalidation checks (id + text each, confirmed via
  `memory_invalidate`). Both sections are absent when the review
  built nothing. Tests assert both sections present / absent.
- **Pending count.** `stats()` gains `pendingInvalidationChecks`
  (flagged and not yet invalidated) and `MemoryCore` gains
  `entriesByIds(ids)` (unknown ids skipped) so the shell can
  resolve review ids to text for the prompt.

## 0.4.3: 0.4.2 review fixes (P1 × 2 + P2)

Fixes from the 0.4.2 single review, no new features.

- **P1-1 — labels are a two-line preview.** The P7 pill's
  `textContent` holds the whole sentence, but the CSS clamps it
  to two lines (`-webkit-line-clamp: 2`, `max-width: 240px`) —
  the READMEs and the P7 test said "full original text", which
  the screen never showed. Product decision (user-approved):
  the label IS the preview; the full text lives in the bottom
  panel on star click. All three READMEs, the starmap header
  comment and the P7 test now say "two-line preview", and the
  test pins the clamp (`html.includes("-webkit-line-clamp:2")`).
  Clamp, width and the 24-label cap are untouched.
- **P1-2 — `memory_search` layer1 follows profile.json.**
  `mergeProfile` now copies `profile.name/stage` onto the
  layer-1 fields themselves (layer-1 keys are the fallback when
  the profile leaves a field unset), so `readLayer1()` /
  `recall()` / `formatLayer1()` and `formatProfileBlock()` all
  describe the same person. `relationshipStage` has no layer-1
  counterpart and stays inside `profile`; likes/agreements
  still come from the layer-1 lists. The `core/src/index.ts`
  comment that described the old behaviour is corrected, and a
  `memory_search`-layer test (write profile, then recall)
  asserts `layer1.name/stage` and `profileText` agree.
- **P9 — punctuation / 1-char boundaries.** The 2–3 char
  whole-memory suffix strips `\p{P}` before the length check
  ("好。" is a 1-char memory, not a 2-char suffix; "走吧！"
  keeps 走吧), and `keySuffix`'s clean pool strips
  punctuation too and filters out 1-char words — a fragment
  1-char topic included — so a lone star with only 1-char
  candidates falls back to its category name instead of a
  single char. Tests: three punctuation samples + one
  1-char-topic fragment (→ `ta.画像`).
- **Proact prompt token hint.** `buildProactPrompt` now ends
  by telling the model to carry the gate's `promptToken` on
  the `memory_proact` decision — `act: false` included, so
  the prompt is voided — or the decision is refused with
  `proact_prompt_not_found`. Test asserts the prompt contains
  `promptToken`.
- **Reflection gate snapshot.** `reflectionCheck()` remembers
  the last issued gate's sourceIds on the core
  (`reflectionGateSnapshot()`, memory only, never on disk);
  the `memory_reflect` save validates against that snapshot
  instead of recomputing the gate, so a source crossing the
  24 h boundary while the model thinks is not refused. A new
  gate overwrites it, a below-floor gate or a successful save
  clears it, a failed save keeps it for a retry; with no
  snapshot the save falls back to a fresh check (below-floor
  refusal unchanged). Core test uses a controlled clock (no
  real 24 h wait); mock test stubs `Date.now` and jumps it
  25 h between gate and save.
- **`profile.json` in the snapshot whitelist.** It is
  tool-writable plugin state (`memory_profile` writes it), so
  a snapshot now carries it and a restore reverts it together
  with the log. Still excluded, deliberately:
  `invalidation-audit.jsonl` (append-only audit trail),
  `beliefs.json` and `loop.json` — restoring them would rewind
  audit history / beliefs / pending actions. Test asserts the
  snapshot contents and a profile restore.
- **Docs.** `core/src/profile.ts` no longer calls the profile
  "always-on" (injection still rides recall hits only);
  `memory_profile` scope is documented (name / stage /
  relationshipStage only); A-data migration documented (wrap
  a bare-array `beliefs.json` as `{"version": 1,
  "beliefs": [...]}` before use — the loader ignores a bare
  array). P7 tests now also pin hovered/selected stars showing
  no label; the no-ui rule is pinned as rendered CSS (the
  stub-DOM VM cannot observe a stylesheet taking effect — a
  real-browser H check is still open, see below).

Not done, by decision: P7 label collision avoidance (no
browser verification, risk outweighs gain); a token parameter
on `core.proactSave` (tool layer enforces it; core direct
calls stay test-compatible — documented in the dsh README).

## 0.4.2: starmap labels, badge prefix, lone-star suffix

Starmap only (`core/src/starmap.ts`, template patches P7–P9). No
tool, blocklist, log, belief, reflection or loop behaviour changed.
(This package also includes the 0.4.1 follow-up — reflection gate
source check, `ReflectionCheck.sourceIds` — which landed in the
same tree after the 0.4.1 merge; the "starmap only" above is about
the 0.4.2 delta itself, not the whole tree.)

- **Original-sentence labels (P7).** A `#labels` overlay inside
  `#stage` holds a pool of 24 reusable divs. Each shows a
  two-line preview of its star's original text in an 11px pill
  (one size smaller than the v6 preview), positioned above the
  star so it never covers it. The pill is a preview only: the
  `textContent` holds the whole sentence, but the CSS clamps it
  to two lines (`-webkit-line-clamp: 2`, `max-width: 240px`) —
  click the star to read the full text in the bottom panel.
  Visible only when the intro is done (`intro > 4.2`) AND the
  camera is close (`dist ≤ 7.5`, `LABEL_DIST_MAX`) AND the star is
  big enough on screen (`ps = q.s / REF`: invisible below 1.5,
  full opacity above 2.5, linear fade between); on-screen only,
  hovered/selected stars skipped, nearest 24 by depth. At dist
  9.2 (default) no label shows; at dist 4 near-side stars fade
  in; at dist 16 all fade out again. `updateLabels()` runs once
  per frame after `draw()`; hidden in no-ui mode. `window.__map`
  gains `setDist(d)` as a debug handle (same style as the
  existing exposure).
- **Panel badge (P8).** `showPanel` displays `badgeText(key)` —
  the `约定.` / `ta.` owner prefix stripped — while the key
  itself is untouched (`ownerOf` still splits arms/cores on it).
- **Lone-star suffix (P9).** `badgeWords` now returns
  `{ all, fallback }`: `all` is the unchanged DF pool (content
  tokens + trigrams, overlap-filtered); `fallback` is the
  lone-star pool — curator fragment topic/keywords first, then
  clean content words (`isCleanContentWord`: 2–3 chars, first
  char not a pronoun/demonstrative/particle, last char not a
  pronoun/particle), trigrams never included; a whole 2–3 char
  memory is its own suffix outright. `keySuffix` falls back to
  the pool, then the category name (`CAT_LABEL`: 画像/事件/情绪/
  其他). The DF path is unchanged — a word shared by 2+ stars
  is still validated by repetition. The 14-sample badge multiset
  is unchanged (0/13 move); the review-17 group now reads
  很想/拉面/拿到/爬山 instead of 我吃/我很/我拿/我爬.

## 0.4.1: merge of 4 increments from the independent 0.4.1 build

Onto 0.4.0, judgement still to the model, arithmetic still to code.
Only these four were merged (see MERGE-0.4.1.md for what was
deliberately left out):

- **Profile write path.** `profile.json` (`loadProfile` /
  `saveProfile` / `mergeProfile`) is now the profile source:
  `MemoryCore.updateProfile()` writes it under the write lock and
  `readLayer1()` / `recall()` merge it over the layer-1 assembly.
  The 13th tool `memory_profile` (persona only) writes name /
  stage / relationshipStage — and only those three: likes and
  agreements still come from MEMORY.md's layer 1, the profile
  has no fields for them. Injection still rides recall hits
  only — no hit, no injection.
- **A-data migration (`beliefs.json`).** The A build stored
  beliefs as a bare JSON array; this tree only reads the
  versioned object shape. Before using an A `beliefs.json`,
  wrap it as `{"version": 1, "beliefs": [...]}` — the loader
  ignores a bare array (loads empty) rather than crashing, so
  an unwrapped file silently reads as no beliefs.
- **Proact prompt token.** `memory_proact` gate returns a
  `promptToken` (15 min TTL); a decision must carry the token and
  its trigger must be one of that prompt's sourceIds. Issuing a
  prompt writes no `lastJudgedAt` and consumes no quota;
  `act: false` consumes nothing and voids the token.
- **Core persona-source checks.** `createBelief` / `supportBelief` /
  `contradictBelief` and `saveReflection` now require every source
  entry to be a persona-window entry (`source_entry_not_found`
  otherwise) — the tool-layer persona check alone is not enough.
- **`recentTriggers` cooling.** Stored triggers are kept (latest
  100) so a trigger whose action was dropped when the pending list
  filled up stays cooled for 7 days.
- **Reflection gate sources (follow-up).** `reflectionCheck()`
  returns the gate entry ids (`ReflectionCheck.sourceIds`) and
  `memory_reflect` save refuses any sourceId outside the current
  gate's prompt — a reflection can only cite the memories the
  model was actually shown.

## 0.4.0: invalidation, per-rate decay, profile, spotlight, beliefs, reflection, proactive loop

Judgement belongs to the model, arithmetic stays in code (2026-11-09,
user decision). Fixed belief steps (+0.05 / -0.1) and the 50-point
reflection threshold are gone; the model sets belief deltas and
decides whether to reflect or act, behind code guardrails.

- **Invalidation.** `MemoryAttributes` / `GraphEdge` carry optional
  `validFrom` / `validTo`; `MemoryCore.invalidateEntries()` marks
  entries and their graph edges expired (recall filters them out);
  review only proposes invalidation, the model confirms — and
  since 0.4.4 the proposal actually reaches the model: the
  checks travel in the daily-review prompt (id + text, confirmed
  via `memory_invalidate`), a flagged entry is re-listed at every
  review while the opposition is live, and `memory_status`
  returns the pending count (`pendingInvalidationChecks`).
- **Per-rate decay.** Detail clarity half-life 14 + 30×S days,
  emotion retention 60 + 120×S days, facts never decay; the
  activation time factor is 0.7 detail + 0.3 emotion, floor 0.3.
- **Profile block.** `formatProfileBlock(layer1)` (≤5 lines) rides
  recall as `profileText`, outside the token cap and the valve.
- **Spotlight + diffusion.** Keyword hits diffuse two hops over
  `keyword` / `recall` edges only (second hop ×0.5), traversed
  edges +0.05; `selectSpotlightCandidates()` ranks by
  activation × edge weight, ≤3 candidates, one per topic, marked ☆
  in the recall block for the replying model to pick — no extra
  model call.
- **Beliefs.** `beliefs.json` holds safety / trust / closeness
  beliefs with verbatim evidence; `support` / `contradict` take a
  model-supplied `delta` (clamped to ±0.2, strength 0..1), the same
  contradicting entry never deducts twice, strength decays ×0.99/day.
  Review only proposes candidates (`beliefCandidates`).
- **Reflection.** No score threshold: when the last 24 h of new
  persona memories sum to `REFLECTION_MIN_FLOOR` (5) significance
  the prompt goes to the model, which decides whether and what to
  reflect; the conclusion is stored as a `type: "reflection"`
  fragment, its 「」 quotes verified verbatim.
- **Proactive loop.** `loop.json` holds only loop state;
  `buildProactPrompt()` asks the model whether to act, why, and
  what to say; `checkGuardrails()` (code) allows 1 action/day,
  one trigger per 7 days, max 3 pending; `deliver()` returns the
  model's own words for `session`, throws `qq_not_connected` for
  `qq`. No fixed action sentences anywhere in `loop.ts`.

## What it never does

- Never writes `MEMORY.md` (see above). Memory entries are never
  deleted (see above); snapshot *copies* rotate at keep=30.
- Never calls the network, never asks for credentials.
- Never invents a summary with a model. v1 has no LLM call at all.
- Never hooks compaction (no such seam exists), never claims to block
  deletion (no filesystem veto hook exists), never runs a background
  daemon (in-process timers only).
- Recall is keyword-only (CJK bigrams + latin words), ranked by
  five-factor activation since 0.2.0. No vector/semantic recall:
  that would need an online embedding call (costs money) or a local
  model (slow, takes disk), and neither has been chosen.

## Usage

```ts
import { MemoryCore } from "./src/index.ts";

const core = new MemoryCore({ dataDir: "./xia-ningqi-data" });

const entry = core.record({
  role: "user",
  text: "以后每周五查岗",
  window: "persona",
  importance: "heavy",
  sessionId: "sess-1",
  emotion: { type: "温暖", intensity: 0.7 }, // 0.2.0, optional
});

const found = core.recall("每周五查岗"); // { hits, layer1, estimatedTokens, text }
// found.text = raw-log + archive hits ONLY (no layer 1) — ready to inject.
// found.layer1 = parsed current state, for reference (e.g. the stage).

core.review(); // daily review when due (> 24 h), else null; regenerates the starmap
core.generateStarmap(); // { path, nodes, edges, generatedAt } — starmap.html
core.stats(); // + graphEdges, attributes, lastReviewAt (0.2.0); + fragments, suspectFragments (0.3.0)

// 0.3.0: create a fragment on top of the log (code-verified).
const frag = core.createFragment({
  sourceIds: [entry.id],
  text: "她很喜欢酸梅湯",
  tone: "很喜欢", // free-form: any words, e.g. "嘴上嫌弃心里喜欢"
  quotes: ["真好喝"], // must be verbatim from the source
  topic: "酸梅湯",
});
// frag.ok === false means rejected (nothing saved) — frag.reasons says why.

core.endSession(); // snapshot + log rollover if over cap + flush index
```

## Test

```sh
node test/demo.ts
```

Runs record → keyword recall → importance → log rollover → snapshot →
corrupt → restore on sample data in a temp directory, with assertions
(including "MEMORY.md bytes unchanged"). Exits non-zero on any failure.
