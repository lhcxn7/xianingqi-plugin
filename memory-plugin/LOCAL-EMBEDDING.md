# Local embedding (0.5.1): how semantic recall works

Semantic recall is an **opt-in** second signal next to keyword
recall. It finds memories that mean the same thing in different
words ("酸酸甜甜的饮品" → 酸梅汤, "检查我" → 查岗) — the cases
keyword recall cannot see at all. It runs entirely on the local
machine: one small ONNX model, no network, no API key.

## What it is

- **Model:** `bge-small-zh-v1.5`, ONNX int8 export
  (`Xenova/bge-small-zh-v1.5`, pinned revision — see `MODELS.md`
  for the files, sizes and hashes). 512 dimensions, `cls`
  pooling, ~23 MiB on disk.
- **Runtime:** `@huggingface/transformers@3.8.1` (an
  `optionalDependency` of `core` — a build without it still
  compiles and runs, semantic just stays unavailable).
- **Query prefix:** `为这个句子生成表示以用于检索相关文章：`
  is added to queries only, never to documents. Mixing that up
  makes the vectors incompatible with the index, which is why the
  prefix is part of the pinned index identity.

## How it plugs in (plan §3.2, one deviation)

Recall is synchronous; embedding is async. So the timeout cannot
live inside recall, and it does not: the async call site (the
plugin's pre-step, `memory_search`, or `core.semanticCandidateIds`)
embeds the query and races it against `timeoutMs` (default
2000 ms), then hands recall a **synchronous** slot
(`opts.semantic: {kind: "semantic", retrieveIds, similarityOf}`).
Recall merges those ids into the same ranking as the keyword
hits — no second ranking, no separate top-5 (`HybridRetriever` in
`retrieval.ts` is the same merge as a provider).

The deviation from the plan's §3.2 sketch: the plan wrote
`opts.semantic?: {retriever, timeoutMs, maxCandidates, enabled}`
as if recall could time out internally. It cannot — recall is
sync — so the timeout lives at the async call site and recall
keeps the sync slot it already had since 0.5.0 step 5.

## Scoring (the part the benchmark forced)

Two things the first version got wrong, both caught by
`core/test/semantic-benchmark.ts` (24 queries, 4 classes) before
release:

1. **Semantic-only hits scored by recency, not by similarity.**
   A 0.45-similarity hit from yesterday outranked a
   0.65-similarity hit from a year ago. Now a semantic-only hit
   (no keyword tokens) scores `similarity × 4` — a 0.65 hit lands
   at ~2.6, around a 1–2 token keyword hit. The similarity rides
   along with the ids (`similarityOf`); a provider without scores
   gives its hits 0.
2. **No similarity floor.** Without one, the searcher returns its
   top-N whatever the scores are, and a no-evidence query injects
   unrelated memories (the mock run showed 6/6 false positives).
   The floor is `minSimilarity`, default **0.5**, measured on the
   benchmark: true answers score 0.436–0.802, the top *unrelated*
   entry for a no-evidence query scores up to 0.476 in the
   20-entry benchmark corpus. At 0.5 the false-positive rate is
   1/6 — the keyword baseline — while synonym Recall@5 still rises
   0.625 → 0.875. At 0.3 it would be 1.000, but with 6/6 false
   positives; a false memory injected is worse than a missed one,
   so 0.5 is the default. It is a tuning knob
   (`semanticRecall.minSimilarity`), and a bigger real corpus
   pushes unrelated tops down — re-measure before lowering it.

## What the numbers are (real model, 2026-11-10)

`node test/semantic-real-model.ts` (default floor 0.5), keyword
vs hybrid on the 24-query benchmark:

| | Keyword | Hybrid |
|---|---|---|
| Recall@5 (all) | 0.833 | **0.944** |
| MRR (all) | 0.778 | **0.852** |
| Synonym Recall@5 | 0.625 | **0.875** |
| Synonym MRR | 0.500 | **0.667** |
| Time Recall@5 / MRR | 1.000 / 1.000 | 1.000 / 1.000 |
| Conflict Recall@5 / MRR | 1.000 / 1.000 | 1.000 / 1.000 |
| No-evidence false positives | 1/6 | 1/6 |
| Avg latency per query | 3.4 ms | 17.4 ms |

The one synonym query hybrid still misses is q02 ("她什么时候
会检查我" → 查岗): its answer scores 0.436, below the 0.5
floor. That is the documented cost of the floor, not a bug.

The mock run (`node test/semantic-benchmark.ts`, hashed
bag-of-words vectors) scores identically to keyword on every
class — it only proves the fusion path runs, never that semantic
is better. Its numbers must never be quoted as a semantic gain.

## Index lifecycle

- **File:** `<dataDir>/semantic-index.json`. Derived data —
  rebuildable from the log and fragments, never the source of
  truth.
- **Build:** first enable, or `ensureSemanticIndex({rebuild:
  true})`. Embeds every live entry (batches of 16), saves only
  on full success — a failed batch never leaves a half-built
  index behind.
- **Identity check:** on load, version / modelId / revision /
  dimensions / pooling / queryPrefix must all match, or the index
  is discarded (`discarded-mismatch`) and rebuilt. A corrupt
  file is backed up (`.corrupt-*`) and discarded
  (`discarded-corrupt`).
- **Updates:** `record()` upserts the new entry's vector
  (fire-and-forget); `editEntry` re-embeds; forget-delete drops
  the vectors with the entries.
- **Size:** ~2 MB of vectors per 1000 entries (the JSON text is
  bigger than the raw floats). No reranker; no incremental
  re-embedding of old entries when the model changes — the whole
  index rebuilds instead.

## Configuration

```jsonc
// dsh-plugin config (MemoryPluginConfig.semanticRecall)
{
  "semanticRecall": {
    "enabled": false,        // default: off (keyword-only)
    // optional override; by default the bundled
    // dsh-plugin/models/bge-small-zh-v1.5 (or a copy in
    // <dataDir>/models/bge-small-zh-v1.5) is used
    "modelDir": "<optional override>",
    "modelId": "Xenova/bge-small-zh-v1.5",
    "modelRevision": "75c43b069aac4d136ba6bc1122f995fedcfd2781",
    "timeoutMs": 2000,       // per-query embed timeout, then keyword-only
    "maxCandidates": 50,     // semantic candidates per query
    "minSimilarity": 0.5     // floor; see "Scoring" above
  }
}
```

`memory_status` reports `semantic: {enabled, modelPresent,
indexSize}` so you can see whether the model and the index are
actually there.

## Known limits

- **Pre-step injection stays keyword-gated.** A semantic-only
  hit has a content factor of 0, so the activation valve drops it
  from the automatic per-turn injection — semantic helps explicit
  `memory_search` (and any later retrieval that passes the slot),
  not the auto-injected block. Letting high-similarity hits inject
  needs a similarity-aware valve; deliberately not done in 0.5.1.
- **CPU only, no reranker.** 10k-entry rebuild time was not
  measured; a few hundred entries take seconds.
- **The 0.5 floor was measured on a 20-entry benchmark.**
  Re-measure on real data before changing it.
- **Real-DSH behaviour unverified** (like `deferLoading` and the
  0.4.8 install): the model loads and searches on this VM, but no
  real DSH run has confirmed it yet.
