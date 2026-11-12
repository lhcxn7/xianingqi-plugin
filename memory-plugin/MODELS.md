# Models shipped with the plugin

Local semantic recall (see `LOCAL-EMBEDDING.md`) runs one embedding
model, on CPU, inside the plugin.

- **Full package** (`plugin-1.0.0.zip` and later): the model is inside
  the package at `dsh-plugin/models/bge-small-zh-v1.5/`. **No download
  and no manual copy** — the plugin finds it automatically.
- **No-model package** (`*-nomodel.zip`): the model is deliberately
  absent. Copy the six files (below) to
  `dsh-plugin/models/bge-small-zh-v1.5/` or
  `<dataDir>/models/bge-small-zh-v1.5/` before enabling semantic recall.

The plugin prefers `<dataDir>/models/bge-small-zh-v1.5/` when present
(so an operator can override the bundled model), otherwise it uses
`dsh-plugin/models/bge-small-zh-v1.5/`. A missing model is reported as
unavailable; it never downloads at runtime.

## bge-small-zh-v1.5 (ONNX int8 export)

| | |
|---|---|
| Base model | `BAAI/bge-small-zh-v1.5` (Chinese/English, 24M params) |
| Shipped export | `Xenova/bge-small-zh-v1.5` (ONNX, transformers.js) |
| Pinned revision | `75c43b069aac4d136ba6bc1122f995fedcfd2781` (40-char commit SHA of the export repo) |
| Runtime modelId | `Xenova/bge-small-zh-v1.5` |
| License | MIT (see `config.json` / the export repo) |
| Dimensions | 512 |
| Pooling | `cls` |
| Dtype | `int8` — transformers.js v3 has no `quantized` dtype; the shipped file is the int8 ONNX export (`onnx/model_int8.onnx`), same size class |
| Query prefix | `为这个句子生成表示以用于检索相关文章：` (queries only, never documents — the prefix is part of the index identity) |
| Total size | 24,453,267 bytes (~23.3 MiB) |

### Files (sha256, measured 2026-11-10)

| File | Bytes | sha256 |
|---|---|---|
| `config.json` | 716 | `d4193ead3a810fd694fa8a31d7fc72fbaebc0668b603e398734bf2f6538ff42f` |
| `tokenizer.json` | 439,125 | `48cea5d44424912a6fd1ea647bf4fe50b55ab8b1e5879c3275f80e339e8fae26` |
| `tokenizer_config.json` | 367 | `e6f3b96db926a37d4039995fbf5ad17de158dfb8f6343d607e4dbaad18d75f5a` |
| `vocab.txt` | 109,540 | `45bbac6b341c319adc98a532532882e91a9cefc0329aa57bac9ae761c27b291c` |
| `special_tokens_map.json` | 125 | `b6d346be366a7d1d48332dbc9fdf3bf8960b5d879522b7799ddba59e76237ee3` |
| `onnx/model_int8.onnx` | 23,903,394 | `b9837c19ce154ff0726d398ee77abbc03a7faf0476c6f93016c84e531be7ebb5` |

Verify after copying:

```powershell
# PowerShell (the DSH machine)
Get-FileHash <dataDir>\models\bge-small-zh-v1.5\onnx\model_int8.onnx -Algorithm SHA256
# must print b9837c19ce154ff0726d398ee77abbc03a7faf0476c6f93016c84e531be7ebb5
```

## Install

0. Install the optional inference runtime:
   - when the plugin is installed with npm / DSH's plugin manager,
     `@huggingface/transformers@3.8.1` is an `optionalDependency` and
     is installed with the plugin;
   - for a portable/unzipped copy, run
     `npm install --prefix dsh-plugin` (or
     `npm install --prefix <dataDir> @huggingface/transformers@3.8.1`).
   Without it semantic recall stays disabled and falls back to
   keyword-only; `memory_status` reports the runtime as unavailable.
1. **Full package**: nothing else to do. The model is already at
   `dsh-plugin/models/bge-small-zh-v1.5/`.
2. **No-model package**: copy `dsh-plugin/models/bge-small-zh-v1.5/`
   (the six files above) into place, or copy it to
   `<dataDir>/models/bge-small-zh-v1.5/`.
3. In the plugin config, set `semanticRecall.enabled: true`
   (default is `false` — keyword-only until you opt in).
4. Restart DSH / re-apply the plugin. The first turn builds
   `semantic-index.json` in the data dir (one embed per entry,
   ~30 ms each on CPU for this model; a few hundred memories take
   seconds). Later turns reuse the index.

## Changing the model

If any of modelId / revision / dimensions / pooling / query
prefix changes, the index is discarded and rebuilt from the log
automatically (`SemanticIndex.load()` returns
`discarded-mismatch`). The old index file is left alone; the
rebuild overwrites it only after a full successful build. Never
hand-edit `semantic-index.json` — it is derived data, rebuildable
from the log and fragments.
