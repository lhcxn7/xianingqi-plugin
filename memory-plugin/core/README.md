# @memory-plugin/core

Shared local-file memory engine. Zero runtime dependencies, no network
calls, no login, no cloud. Runs on Node `^22.19.0 || >=24.0.0` — the
TypeScript sources use only erasable syntax, so Node runs them directly
(type stripping); no build step is needed.

## Division of labour with the skill (anti-conflict rules, v1)

- The plugin writes ONLY its own append-only log (`log.jsonl`, rolled
  into per-month `log-YYYY-MM.jsonl` segments) and its keyword index
  (`index.json`). It NEVER writes `MEMORY.md` — the three-layer
  summaries stay written by the model following the skill.
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
| Recall | `src/recall.ts` | Keyword match + importance + recency, ranked, with a token cap (default 1500) so the caller never injects an unbounded blob. Recall dedupes against MEMORY.md: a log hit whose normalised text (whitespace/punctuation stripped, lowercased) mutually contains a Layer 1 / Layer 2 entry and is ≥10 chars is dropped, keeping the curated MEMORY.md copy; archive hits are exempt (the skill does not read archives at open). Exact/near containment only — no semantic judgement, nothing deleted from disk. |

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

## What it never does

- Never writes `MEMORY.md` (see above). Memory entries are never
  deleted (see above); snapshot *copies* rotate at keep=30.
- Never calls the network, never asks for credentials.
- Never invents a summary with a model. v1 has no LLM call at all.
- Never hooks compaction (no such seam exists), never claims to block
  deletion (no filesystem veto hook exists), never runs a background
  daemon (in-process timers only).
- v1 recall is keyword-only (CJK bigrams + latin words). No
  vector/semantic recall.

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
});

const found = core.recall("每周五查岗"); // { hits, layer1, estimatedTokens, text }
// found.text = raw-log + archive hits ONLY (no layer 1) — ready to inject.
// found.layer1 = parsed current state, for reference (e.g. the stage).

core.endSession(); // snapshot + log rollover if over cap + flush index
```

## Test

```sh
node test/demo.ts
```

Runs record → keyword recall → importance → log rollover → snapshot →
corrupt → restore on sample data in a temp directory, with assertions
(including "MEMORY.md bytes unchanged"). Exits non-zero on any failure.
