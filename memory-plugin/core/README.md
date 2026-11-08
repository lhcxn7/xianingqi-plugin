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
