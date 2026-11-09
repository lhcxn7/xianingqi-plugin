# memory-plugin

Local-file memory plugin for persona AIs in DeepSeek Harness (DSH).
First persona: 夏柠柒 / Xia Ningqi.

The skill file holds the persona, the tone and the memory *rules*. This
plugin provides only the memory *machinery*: it deterministically records
every line of a persona conversation to local files, and injects keyword
recall of older history back into the conversation — so the persona
remembers things from months ago, mid-conversation, without anyone
asking her to go look.

- **Local only.** No network calls, no login, no cloud. All memory lives
  in local files the user can open and read. Verify it in the code:
  there is no `fetch`, no socket, no credential anywhere in `src/`.
- **Skill stays untouched.** The plugin never writes `MEMORY.md`
  (the model keeps writing the three-layer summaries per the skill)
  and never touches the persona, the tone or the stage. Stage still
  comes from `MEMORY.md` layer 1.
- **One core, thin shells.** `core/` is the shared memory engine (pure
  local-file operations, zero runtime dependencies). `dsh-plugin/` is
  the DSH shell around it. The MCP server shell is deferred.

## Requirements

- DSH `0.2.1-rc.5 || >=0.2.0 <0.3.0` (verified on 0.2.1-rc.5).
- Node `^22.19.0 || >=24.0.0`.
- No build step: the plugin runs TypeScript directly (erasable syntax
  only), so a GitHub install works without `tsc` or `prepare`.

## Install

The plugin lives in the `dsh-plugin/` subdirectory and relatively
imports `../../core`, so the whole tree must stay together — never
install the `dsh-plugin/` folder alone.

### Option A — one line (DSH plugin command)

```sh
dsh plugin --profile <name> add "github:lhcxn7/xianingqi-plugin#v0.3.0&path:/memory-plugin/dsh-plugin"
```

Replace `<name>` with your DSH profile name (often `web` or
`desktop`). If the command reports an error, copy the error verbatim —
do not guess. Then restart DSH yourself (the agent cannot restart its
own host).

### Option B — clone, then local install (always works)

```sh
git clone https://github.com/lhcxn7/xianingqi-plugin.git
dsh plugin --profile <name> add ./xianingqi-plugin/memory-plugin/dsh-plugin
```

Then restart DSH yourself.

## Install by asking your own DSH agent (plain language)

Paste this into your own DSH agent and let it do the work. It installs
the plugin; you restart DSH by hand afterwards.

> 帮我装一个 DSH 记忆插件：从 GitHub 把 lhcxn7/xianingqi-plugin
> 这个仓库的 v0.3.0 版装进来（我的 profile 是 <你的 profile 名>）。
> 插件在仓库的 memory-plugin/dsh-plugin 子目录，core 在 memory-plugin/core 目录，两个目录
> 必须在一起，装的时候别只拷 dsh-plugin 一个目录。装完告诉我
> 结果，报错原文发我；装好后我自己重启 DSH。我的记忆数据文件夹
> 在 <你的记忆数据文件夹路径>，帮我把插件的 dataDir 指到它
> （插件配置或环境变量 MEMORY_PLUGIN_DATA_DIR），不要用默认路
> 径，也不要新建空文件夹。

## Config

Declared on the plugin (defaults in parentheses). In Cordis/DSH the
config arrives as the **second parameter of `apply(ctx, config)`**.

- `dataDir` — memory data directory (default `~/.dsh/xia-ningqi-data`;
  env `MEMORY_PLUGIN_DATA_DIR` overrides it too). **The default is
  Xia Ningqi's folder. If you use this plugin for any other persona,
  you MUST point `dataDir` at your own data folder** — otherwise the
  plugin records into Xia's folder (or a fresh empty one).
- `tokenCap` — max estimated tokens for injected recall (default 1500).
- `triggerWords` — substrings marking a session as a persona window
  (default `["夏柠柒", "柠柒"]`, the skill's own trigger). For another
  persona, set your own trigger words.

## Verify it works

1. Restart DSH, open a persona window, and make the first message
   contain a trigger word (e.g. 夏柠柒). Chat a few lines.
2. Check the data directory: `log.jsonl` must have grown, and its
   last lines must be the words you just said (the skill never writes
   that file — only the plugin does).
3. Cross-session check: in one session tell her something new to
   remember; open a new session and, **without asking about it
   directly**, drop a keyword for it mid-conversation. If she brings
   it up herself, recall works. (Asking directly does not prove
   anything: the skill reads recent history and archives on its own.)

## Layout

```
memory-plugin/
  core/                 # shared memory engine (TypeScript, zero deps)
    src/                # types, atomic writes, append-only log, keyword
                        # index, three-layer MEMORY.md READER, snapshots,
                        # recall, MemoryCore
    test/demo.ts        # end-to-end demo/test on sample data (temp dir)
  dsh-plugin/           # DSH shell: hooks + systemPrompt injection +
                        # memory_search/memory_remember/memory_fragment/
                        # memory_snapshot/memory_restore/memory_status/
                        # memory_starmap tools
    src/                # apply(ctx), trigger-based session tracking
    test/mock-test.ts   # mock-DSH test, no real DSH needed
  mcp-server/           # DEFERRED (DSH first, per user decision)
```

## Status

- [x] 0.4.7 (2026-11-09) — fixes from the 0.4.6 independent
      re-review (its two pre-ship items, new issues 1–2). The
      blocklist item is NOT touched (user decision — "先不管"
      stands); 0.4.3 items 6–14 and 0.4.5-review new issues 6–9
      are not in this release. (1) The merged recent section
      marks what a reflection save would refuse: the shell calls
      `core.reflectionCheck()` when the section carries the
      reflection instruction and passes its sourceIds as
      `reflectableIds` — a shown entry outside the set carries
      "（本次反思不可引用）" and the instruction explains the
      mark. The call also sets the gate snapshot for the review
      path (0.4.3 item 8, same root: the save used to fall back
      to a freshly recomputed gate). (2) The standalone proact
      prompt gets the full 24 h list and caps once inside
      `buildProactPrompt`, so the model is told about the
      overflow (20 shown + 20 summaries + 160 counted on a
      200-entry day); source ids are still exactly the shown 20.
      Tests: core 193 PASS (was 191), mock 161 PASS (was 157),
      `tsc` 0 errors on core.
- [x] 0.4.6 (2026-11-09) — fixes from the 0.4.5 independent
      re-review (its new issues 1–4) plus 0.4.3 review items 15
      and 16. The blocklist item is NOT touched (user decision —
      "先不管" stands); 0.4.3 items 6–14 and 0.4.5-review new
      issues 6–9 are not in this release. (1) The daily-review
      prompt is capped as a whole: reflection + proact travel as
      ONE merged recent section (top 20 / 3000 chars, rest as id
      + summary, at most 20 summary lines); a 200-yesterday +
      200-today chatty day builds ~11.4k chars (assert < 20000,
      vs 84,955 on real data in 0.4.5). The first entry is
      truncated to the remaining budget + "…" instead of being
      taken whole (one 20k-char memory used to punch through the
      8000 cap — new issue 5, folded into issue 1); the same cap
      applies to the reflection / proact gate prompts, and the
      core keeps prompt and sourceIds consistent (only shown
      entries are citable). (2) Invalidation checks stop flagging
      the persona's own name: topic tokens exclude the persona
      name / trigger words, COMMON_TOKENS and high-df tokens
      (df > 5); negation must attach to the shared token; ≥2
      shared real words or a shared phrase required. The two
      real-data false positives ("夏柠柒，我喜欢你" / "夏柠柒")
      are no longer flagged; a true contradiction still is. (3)
      Mock test pins its clock to a fixed morning (the
      `Date.now() - 20h` "yesterday" landed today at 20:00–24:00
      local and aborted the suite at 139 PASS). (4) Both
      `entriesByIds` calls in `registerModelReview` are wrapped
      in try/catch degrading to `[]`, so a read failure never
      breaks the round. (15) Log append terminates a torn line
      first, so the next entry survives. (16) A failing stale-lock
      reclaim falls through to deadline/sleep and counts the
      failures in the timeout error instead of tight-looping.
      Tests: core 191 PASS (was 184), mock 157 PASS (was 156),
      `tsc` 0 errors on core.
- [x] 0.4.5 (2026-11-09) — fixes from the 0.4.3 independent review
      (its items 4 and 5; the blocklist item 3 is NOT touched, by
      user decision — "先不管" stands; items 6–16 are not in this
      release). (4) The daily-review prompt is capped: yesterday's
      entries are ranked by significance, at most 60 entries /
      8000 characters of entry text, shown chronologically, and the
      prompt says only the important part is listed; the context
      also auto-releases after 3 turns without a submission
      (submitting via memory_daily_review still disposes on
      success — the auto-release is the backstop, so a chatty day
      can no longer pin ten thousand words into every request
      indefinitely). (5) Graph backfill is idempotent: the
      keyword-edge cap now counts a node's existing live keyword
      edges instead of only the ones made in this call, so a second
      daily backfill adds no edges (a popular node can still hold
      more than 3 edges in total — its own 3 plus incoming ones —
      but the total is bounded by 3 per entry); and a backfill may
      upgrade a session edge to a keyword edge in place (type only,
      weight and clock untouched, so decay survives) when the pair
      also shares a rare keyword. Existing over-grown edges are
      NOT pruned in this release (user decision: prevent future
      growth only; pruning is a later decision). New checks: +3
      core, +3 mock (184 core / 156 mock, executed, exit 0; `tsc`
      0 errors on core).
- [x] 0.4.4 (2026-11-09) — fixes from the 0.4.3 independent review
      (its items 1 and 2; the blocklist item 3 is NOT touched, by
      user decision — "先不管" stands; items 4–5 and 6–16 are not
      in this release). (1) The MEMORY.md parser now reads the
      shape the model actually writes: `- [HH:MM] text` (dash +
      bracketed time). The old regex only matched `[HH:MM]` and
      `- HH:MM [meta]`, so a real MEMORY.md parsed as 0 layer-2
      entries (74 real entries, `layer2Count` 0, memory_status
      "最近 30 天条数" stuck at 0, layer-2 dedup dead, and the
      next monthly archive would not recall). `SKILL_ENTRY_LINE`
      is now `/^\s*(?:[-*+]\s+)?\[(\d{2}:\d{2})\]\s+(.*)$/`;
      archives share the line parser so they get the fix for
      free. The demo fixture now mixes both shapes, and a new
      test builds a 74-entry real-shape file and asserts all 74
      parse and `layer2Count` is 74. (2) The daily review's two
      computed proposals finally reach the model: `proactPrompt`
      and `invalidationChecks` are now carried on the session
      from `agent/created` and pasted into `buildModelReviewPrompt`
      next to the fragment / belief / reflection sections — the
      proactivity proposal (with a note that its token line is
      about a live gate call, not this review prompt: to act she
      calls `memory_proact` with `{}` first and gets a fresh
      prompt+token) and the invalidation checks (id + text each,
      confirmed via `memory_invalidate`, or left alone to be
      proposed again). `memory_status` now returns
      `pendingInvalidationChecks` (flagged and not yet
      invalidated). The permanent skip is gone: a flagged entry
      is re-evaluated and re-listed at every review while the
      opposition is still live; the flag only clears when the
      check is resolved — the model invalidates the entry
      (`attributes.invalidate` clears it), the opposing statement
      ages past the 30-day window, or the entry drops out of the
      check's population. There is no explicit "still valid"
      confirmation (`memory_invalidate` has no keep-action, and
      its params are untouched by decision): inaction + lapse is
      the answer — the entry stays valid and the flag goes away
      on its own. New checks: +6 core (181 core / 153 mock,
      executed, exit 0; `tsc` 0 errors). One existing mock
      assertion was updated for the intended behaviour change:
      today's messages may now appear in the review context
      inside the proact proposal section (they are still absent
      from yesterday's list).
- [x] 0.4.3 (2026-11-09) — fixes from the 0.4.2 single review
      (P1 × 2 + the P2 items worth doing). (P1-1) Starmap labels
      are now a two-line preview by product decision, not "full
      original text": the pill's `textContent` holds the whole
      sentence but the CSS clamps it to two lines
      (`-webkit-line-clamp: 2`, 24-label cap and pill style
      unchanged); click the star for the full text in the bottom
      panel. READMEs and the P7 test now say "two-line preview",
      and a test pins the clamp. (P1-2) `mergeProfile` now copies
      `profile.name/stage` onto the layer-1 fields themselves
      (layer-1 keys are the fallback), so `memory_search`'s
      `layer1` and `profileText` describe the same person; the
      stale `mergeProfile` comment in `core/src/index.ts` is
      corrected. (P2) P9 punctuation / 1-char boundaries: the
      2–3 char whole-memory suffix strips `\p{P}` first
      ("好。" no longer becomes "约定.好。"), and the fallback
      pool filters out 1-char words (fragment 1-char topics
      included) so a lone star falls back to its category name.
      `buildProactPrompt` now tells the model to carry the
      gate's `promptToken` on the `memory_proact` decision,
      `act: false` included (voids the prompt). Reflection gate
      snapshot: `reflectionCheck()` remembers the last issued
      gate's sourceIds on the core; the `memory_reflect` save
      validates against that snapshot instead of recomputing the
      gate, so a source crossing the 24 h boundary while the
      model thinks is not refused — a new gate overwrites it, a
      below-floor gate or a successful save clears it, a failed
      save keeps it for a retry. `profile.json` joins the
      snapshot whitelist (tool-writable plugin state); the
      audit trail, beliefs and loop state still do not.
      `memory_profile` scope is now documented (name / stage /
      relationshipStage only; likes/agreements still come from
      MEMORY.md layer 1), `core/src/profile.ts` no longer calls
      the profile "always-on" (injection still rides recall
      hits only), and the A-data migration is documented (wrap
      a bare-array `beliefs.json` as `{"version": 1,
      "beliefs": [...]}` before use). P7 tests now also pin
      hovered/selected stars showing no label; the no-ui rule is
      pinned as rendered CSS (the stub-DOM VM cannot observe a
      stylesheet taking effect — a real-browser H check is
      still open). No changes to the 24-label cap, the label
      clamp/width, TASK_BLOCKLIST, belief/reflection/reflux
      core logic (except the gate snapshot above), or the
      snapshot treatment of audit/beliefs/loop. Not done, by
      decision: P7 label collision avoidance (no browser
      verification, risk outweighs gain) and a token parameter
      on `core.proactSave` (tool layer enforces it; core direct
      calls stay test-compatible — documented). New checks: +4
      core (175 core / 151 mock, executed, exit 0; `tsc` 0 errors).
- [x] 0.4.2 (2026-11-09) — starmap labels only, on top of 0.4.1-final.
      (1) Original-sentence labels: every memory star carries a
      small pill with a two-line preview of its original text (11px, one size
      smaller than the v6 preview), hidden by default, fading in
      only when the camera is close (dist ≤ 7.5 and on-screen size
      ps > 1.5, full at ps > 2.5); a pool of 24 reusable divs, at
      most 24 visible, nearest by depth; the pill sits above the
      star and never covers it; hovered/selected stars show no
      label (they already have tooltip/panel); hidden in no-ui
      mode. The label is a preview only — two lines, CSS-clamped
      (`-webkit-line-clamp: 2`); click the star to read the full
      text in the bottom panel. This package also includes the
      0.4.1 follow-up (reflection gate source check — a save may
      only cite the ids in the current gate's prompt), which
      landed in the same tree after the 0.4.1 merge. (2) Panel badge shows the keyword only — the
      "约定." / "ta." prefix is stripped for display; the key
      itself is untouched, arms/cores unchanged. (3) Lone-star
      suffix: the fallback pool is now curator fragment words
      first, then clean content words (2–3 chars, no pronoun /
      demonstrative / sentence-particle at either end), then the
      category name （画像/事件/情绪/其他） — no more sliced
      bigrams (我以/了拉/的对); a whole 2–3 char memory is its
      own suffix outright. No tool, blocklist, log, belief,
      reflection or loop behaviour changed. New checks: +2 core
      (171 core / 150 mock, executed, exit 0; `tsc` 0 errors).
      The 14-sample badge multiset is unchanged by the new
      fallback (0/13 move).
- [x] 0.4.1 (2026-11-09) — merge of 4 increments from the independent
      0.4.1 (GPT) build onto 0.4.0: `memory_profile` write path (13th
      tool, persona only; `profile.json` is now the profile source,
      wired into `recall` / `readLayer1`), proact prompt token (15
      min TTL) + trigger whitelist, core persona-source checks for
      beliefs/reflection, `recentTriggers` 7-day cooling that also
      covers dropped actions. Deliberately NOT merged: A bare-array
      `beliefs.json`, A's snapshot whitelist change, review writing
      `loop.json`, `actionId + userReply` loop, always-on profile
      injection, 30-day proact prompt, 1800-char reflection cap.
      B's quota semantics kept: issuing a prompt writes no
      `lastJudgedAt` and consumes nothing, `act: false` consumes
      nothing. New checks: +11 core, +9 mock (168 core / 149 mock,
      both executed here, exit 0; `tsc` 0 errors). Follow-up the
      same day: `memory_reflect` save now requires every sourceId
      to come from the current gate's prompt (`ReflectionCheck`
      carries `sourceIds`; the tool refuses out-of-gate sources
      before any quote check); the 13-tool count is accepted as
      final (the 13th, `memory_profile`, is the profile write
      path, not scope creep). `memory_profile` only covers
      name / stage / relationshipStage — likes and agreements
      still come from MEMORY.md's layer 1, the profile has no
      fields for them. Follow-up checks: +1 core, +1 mock
      (169 core / 150 mock, executed, exit 0). A-data migration:
      if a `beliefs.json` from the A build is a bare JSON array,
      wrap it as `{"version": 1, "beliefs": [...]}` before use —
      the loader only reads the versioned object shape and
      ignores a bare array (loads empty) rather than crashing.
- [x] 0.4.0 (2026-11-09) — dual-timestamp invalidation (items 1),
      per-rate decay (6), profile block (4), spotlight + graph
      diffusion (5), evidence-backed 3-dimension beliefs (2),
      model-decided reflection (3), proactive loop, session-only
      (7). Judgement belongs to the model, arithmetic stays in
      code: fixed steps (+0.05 / -0.1) and the 50-point reflection
      threshold are gone; the model sets belief deltas (clamped to
      ±0.2, strength 0..1) and decides whether/when to reflect and
      to act, behind code guardrails (1 action/day, same trigger
      once per 7 days, max 3 pending, persona windows only, qq
      returns `qq_not_connected`). New tools: `memory_invalidate`,
      `memory_belief`, `memory_reflect`, `memory_proact` (12 total).
      Verified by `core/test/demo.ts` (157 PASS) and
      `dsh-plugin/test/mock-test.ts` (140 PASS), `tsc` 0 errors.
- [x] Core (v1.1, 2026-11-05) — record, keyword recall, importance,
      log rollover, snapshots, restore. Verified by
      `core/test/demo.ts`. v1.1 fixes (independent re-audit
      `REVIEW-2026-11-05.md`): parser reads the skill's REAL MEMORY.md
      format (`##` dates, `[HH:MM]` entries, 喜好/厌恶) as well as the
      plugin's older format; restore never deletes files outside the
      snapshot (diary safe); no-match recall returns empty (no
      unrelated fallback injection); index staleness uses per-file
      size+mtime; rollover truncate is atomic; log appends fsync.
- [x] DSH plugin shell (v1.1, 2026-11-05) — agent/created,
      agent/pre-step injection (persona windows only), session/event
      capture (persona windows only), compaction/start + turn-stopping
      flush, memory_search/memory_remember tools (memory_remember is
      now persona-gated). Verified by `dsh-plugin/test/mock-test.ts`
      (mock DSH, no API key).
- [x] Full audit fix (0.1.3, 2026-11-06, `AUDIT-2026-11-06.md`) —
      every finding fixed in one pass: agent-scoped recall context
      (B1, no more multi-session name collision or task-window leak),
      record/input validation + poison defence (B2), tools compile
      parameters to real JSON Schema locally (M2, defineTool never
      resolves in a link: install), memory_remember gated by the
      calling session (M4), snapshots actually run on compaction and
      unload (M5), recall/flush failures degrade instead of killing
      turns (M6), apply() fails loudly naming the dataDir (M3),
      persona flag persisted across session rebuilds (M7), snapshots
      cover only plugin-owned files (never MEMORY.md/archives/diary),
      plus minors m1–m17 (index actually queried, source-aware
      dedupe, token-cap skip, single-char tokens with stopwords,
      reasoning/image/interrupted extraction, neutral archive label,
      UUID turn-1 appends, empty-query safety, dead code wired or
      removed, empty-dataDir warning, pre-trigger lines documented).
- [x] Real-DSH envelope verified (2026-11-06, headless DSH
      0.2.1-rc.5 on this machine, fake key): the 0.1.1 crash root
      cause was the pre-step waterfall not returning `next()`; fixed,
      and the session/event 2-arg envelope + nested assistant
      settlement confirmed live. Full live conversation on the user's
      own DSH is still the final check.
- [x] Re-verification fix (0.1.4, 2026-11-06) — independent
      re-check of 0.1.3 passed (26/26 audit items verified, core
      33/33 + mock 52/52, headless real-DSH run) and found 6 new
      minors, all fixed in one pass: turn-1 appended ids persist
      across session rebuilds (`appended-ids.json`, capped 500
      sessions × 200 ids) so a rebuilt session never double-injects;
      agent-scope registration failure no longer falls back to the
      global layer (no task-window leak); `memory_restore` rejects
      path-traversal snapshot names (tool + core); after a restore
      the shell reloads the persisted persona state from disk;
      shipped docs carry no real user name; dsh-plugin README no
      longer claims real-DSH testing never happened. M6 forced-error
      coverage (directory-in-place-of-file) is now in the mock suite.
- [x] Privacy scrub for public release (0.1.5, 2026-11-06) — all
      personal info removed from the shipped tree (real name, email,
      personal machine paths, profile names, test-workspace paths,
      first-person references to the author in the audit notes); the
      shipped-tree privacy guard now reads its sensitive-word list
      from a blocklist file outside the repo
      (`.memory-plugin-private-blocklist.json`, never shipped) instead
      of hard-coding any name in the test, and walks the WHOLE tree
      (not just the docs) so a sensitive string added anywhere later
      is caught too.
- [x] File lock + recall dedupe (0.1.6, 2026-11-06) — two DSH
      processes (or two processes) writing the same dataDir no
      longer lose records or corrupt the index: every write
      (record, rollover, snapshot, restore, index rebuild) holds a
      core-level lock — atomic mkdir of
      `<dataDir>/.locks/write.lock` (PID + timestamp inside), 5 s
      acquire timeout, stale only when older than 30 s AND the
      owner PID is gone, Windows-safe (no flock); a writer that
      cannot get the lock errors back instead of writing, and a
      writer that finds another writer moved first reloads before
      appending, so a flush never saves a stale index. Recall now
      dedupes against MEMORY.md: a log hit whose normalised text
      (whitespace/punctuation stripped, lowercased) mutually
      contains a Layer 1 / Layer 2 entry and is ≥10 chars is
      dropped, keeping the curated MEMORY.md copy; archive hits are
      exempt (the skill does not read archives at open), and
      nothing is ever deleted from disk by the dedupe.
- [x] Public release (0.1.6, 2026-11-06) — public repo
      https://github.com/lhcxn7/xianingqi-plugin, tag v0.1.6
      (branch stand-in until a real tag is made); GitHub install
      still to be verified from a clean profile once the repo exists.
- [x] Lock TOCTOU race fix + dedupe remainder rule + packaged
      privacy guard (0.1.7, 2026-11-07) — the lock was redesigned
      around an arbiter: every operation on the canonical lock dir
      (`<dataDir>/.locks/write.lock`) runs under a separate arbiter
      lock (`<dataDir>/.locks/arbiter.lock`, atomic mkdir), and the
      canonical dir is NEVER moved (earlier claim-and-verify renames
      opened a window in which a third process could take the path
      while it was renamed away). Stale locks are reclaimed by rmSync
      under the arbiter, releases delete only on an in-place token
      match. The arbiter release deletes in place only on a token
      match — a mismatch (or a gone dir) means it is not ours, so it
      is left alone; there is no rename and no retry. The orphan race
      of the rename design (a breaker moving the dir while its holder
      releases it) cannot happen under NO-RENAME. Multi-process mutex test (3 outer rounds x 4 workers x
      15 rounds, START/END log never overlapping) proves at most one
      holder. Recall dedupe now drops a log hit only when the remainder after
      removing the matched MEMORY.md fact is < 10 chars, so a log
      turn holding a known fact PLUS a new fact survives. The
      shipped-tree privacy guard now falls back to a shipped SAMPLE
      blocklist (fake entries only) when the private blocklist is
      absent, and asserts the guard actually executed (plus a
      negative control that plants a blocklisted term and expects
      it flagged) — a packaged copy can no longer "pass" by
      skipping the check.
- [x] 片段层 (0.3.0, 2026-11-07) — fragments on top of the
      verbatim log (core/src/fragments.ts, fragments.json): the log
      stays the ground-truth base, verbatim, one line per message,
      never edited, with NO tone in it; a fragment is a short
      model-written summary (~10 tokens) with mandatory provenance
      (sourceIds), a free-form tone tag in the model's own words
      (e.g. 很喜欢 / 嘴上嫌弃心里喜欢 — NOT a fixed list), 1–2
      verbatim quotes copied from the source, topic/keywords, and a
      verified flag. Fragments are the visible stars in the star
      map (one fragment = one star; clicking shows its text + tone
      + the source log entries); log entries with no fragment yet
      still appear as stars. Created through the new
      `memory_fragment` tool (persona windows only) or proposed as
      clusters by the daily review — both paths share the same code
      verification, which runs at creation AND at retrieval: the
      fragment's key terms and quotes must appear in the source
      entries' text, and a KNOWN tone tag must be within 1 level of
      the sources' attitude markers. A fragment that fails at
      creation is REJECTED (nothing saved, reasons returned); a
      fragment that fails at retrieval falls back to the verbatim
      source log entry and is marked suspect (never silently
      deleted — the next review can fix or drop it). Recall injects
      the fragment text (with its tone tag) instead of the full
      originals — one fragment injected once even when several of
      its sources surface — so injection costs ~10 tokens per memory
      instead of ~100; the 1500-token cap and the 心光 valve (top 5,
      max 2/topic) are unchanged. Fragments are snapshotted with the
      log (fragments.json is plugin-owned). Honest limit: code
      checks catch gross fabrication (a "粉色筷子" the source never
      mentions) and clear tone mismatches ("很喜欢酸梅湯" from
      "酸梅湯还行吧，也就那样"), but subtle tone — a fragment that
      paraphrases without using any lexicon word, or a free-form tone
      the lexicon cannot place — can still slip through; the tone
      check is skipped, never failed, for an unlisted tone word.
      Verification is a safety net, not a guarantee; the iron rule
      （只记真实对话不许编） is enforced by provenance +
      verification, not by trust. 核对是按字面逐字比对的：片段必须
      用来源原文里的字（湯/汤算两个字），对不上时拒绝原因会点名缺
      了哪个词，模型照着改就行。 Free-form tagging (0.3.0 design
      update): emotion and tone are the model's own words — the
      `memory_remember` emotion param and the `memory_fragment` tone
      param explicitly invite any mood the model perceives (委屈/
      傲娇/吃醋/害羞/无奈/宠溺/期待/忐忑/别扭/赌气/窝心/失落/心动/
      安心/澎湃 …), not a fixed list; the emotion lexicon
      (attributes.ts) was deliberately NOT expanded — it stays a
      coarse fallback that only fires when the model is silent, and
      the tone lexicon likewise stays a verification vocabulary, not
      a vocabulary list. Downstream handles arbitrary words: the
      activation emotion factor tries an exact type match, then a
      coarse polarity match (same polarity 0.7, opposite 0.2, unknown
      or explicitly neutral polarity 0.5), and the starmap colours unknown types by
      polarity (positive gold, negative blue) or the neutral default
      — an unknown word still renders a star, never nothing.
- [x] 识海升级 (0.2.0, 2026-11-07) — six new things on top of 0.1.7:
      graph (core/src/graph.ts, graph.json: nodes are log entries,
      three edge kinds — same-session adjacency, shared rare keyword
      df≤5, recall co-occurrence; weight +0.05 on traversal capped
      1.0, review decay ×0.95 floored 0.1; recall climbs 1–2 hops
      over keyword + recall edges only, never session edges);
      attributes (core/src/attributes.ts, attributes.json: per-memory
      emotion+intensity, clarity, recall count, significance,
      computed retrievability — emotion model-tagged via
      memory_remember, keyword-lexicon fallback);
      activation (core/src/activation.ts: five-factor product —
      content × relationship × emotion × time × attention — a gate
      only, ranking still uses the old score);
      心光 valve (recall.ts: threshold 0.02 before the token cap,
      per-topic max 2 + top 5 after it, explicit limit disables it);
      daily review (core/src/review.ts, review.json: runs at session
      start when >24 h since the last one — decay, compress light old
      memories to summary-YYYY-MM.jsonl, promote often-recalled ones,
      backfill edges, regenerate the starmap; only while DSH is open,
      no background service; runs only for a session already known
      to be persona — a brand-new persona session gets its first
      review on its next open);
      思维星空海 (core/src/starmap.ts, starmap.html: local 拾光
      star map — memories as stars on two spiral arms, click a
      star for its detail panel; no search, no time-flow slider,
      no 常用词 field). Known limits: real-DSH verification is
      mock-only so far (review on session start, starmap generation,
      pre-step envelope fields); still keyword-only, no vector /
      semantic search; review runs only while DSH is open. Deep audit
      of the first 0.2.0 build found 6 Major + 9 Minor, no Blocker;
      all fixed except m6/m7 (design tradeoffs: memory_search returns
      full text of compressed entries by design; record() writes
      graph.json + attributes.json on every call by design), each with
      a regression test (core demo 117 PASS, mock 105 PASS).
- [ ] MCP server shell — deferred.

## Guarantees that hold

- Local-only (verifiable in the code: no `fetch`, no sockets, no credentials).
- Format-compatible with the existing `xia-ningqi-data/` memory files
  (the core READS the same three-layer `MEMORY.md` and `MEMORY-YYYY-MM.md`
  archives) — existing memory files carry over untouched, no migration.
- The plugin NEVER writes `MEMORY.md` (the model keeps writing the
  three-layer summaries per the skill). Memory entries are never
  deleted: log rollover moves entries into segments, snapshots keep
  dated copies of the plugin's own files only (log + index +
  segments + persona-sessions.json + graph.json + attributes.json +
  review.json + fragments.json — never MEMORY.md, monthly
  archives or the diary), restore snapshots first and only replaces
  files present in the snapshot. Snapshots themselves rotate (default
  keep=30) — that rotation deletes old snapshot *copies*, not memory
  entries. Multi-process writes to one directory are protected by
  the file lock (atomic mkdir lock in `<dataDir>/.locks/`, 5 s
  acquire timeout, stale only when older than 30 s and the owner
  PID is gone): two DSH processes writing the same dataDir no
  longer lose records or corrupt the index. Reads stay safe (torn
  lines are skipped); a process only recalls what it loaded, so
  another process's entries become visible at its next flush or
  restart.
- NO deletion veto in v1 (cut by design correction): a blanket veto
  would fight the skill's stage-based deletion rule (late stage may
  actively execute a deletion). Deletion is governed by the skill's
  persona rule + snapshots/backups.

## Hard limits (by design, not bugs)

- No compaction-hook rotation — DSH exposes no `PreCompact` hook, so
  the log rolls over by message-count threshold and at session end instead.
- No deletion blocking — no filesystem veto hook exists, and the v1
  design cut the tool-call veto (it would fight the skill's
  stage-based deletion rule); protection is the skill's persona rule +
  snapshots + storing outside the workspace.
- No background daemon — in-process timers only.
- v1 recall is keyword-only (CJK bigrams + single characters +
  latin words; single-character stopwords such as 的/了/不 are
  excluded so an unrelated query does not recall every line that
  contains one). No vector/semantic recall, so paraphrases and
  synonyms are not found — only the words actually said.
  Recall dedupes against MEMORY.md (exact/near containment on
  normalised text, ≥10 chars, log copy dropped, curated copy kept,
  archive hits exempt) — it never judges meaning, so a same-topic
  but different fact is never removed.
- By design, messages sent BEFORE the first trigger word in a
  session never enter the verbatim log: the plugin only knows a
  session is a persona window once the trigger appears (the skill's
  own MEMORY.md summary may still retain them; the verbatim log does
  not).
