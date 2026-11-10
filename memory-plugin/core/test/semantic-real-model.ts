// Real-model semantic run (0.5.1 item 2) — a standalone, skippable
// entry point for the --real leg of core/test/semantic-benchmark.ts.
//   node test/semantic-real-model.ts
// Model dir: --modelDir, SEMANTIC_MODEL_DIR, <package>/models/
// bge-small-zh-v1.5, or ~/workspace/tmp-push/models/bge-small-zh-v1.5.
// If the model is missing this prints "真实模型未验证" and exits
// 0 — it never invents numbers.
import { runSemanticBenchmark } from "./semantic-benchmark.ts";

const modelDirFlag = process.argv.indexOf("--modelDir");
const modelDir = modelDirFlag >= 0 ? process.argv[modelDirFlag + 1] : undefined;
const json = process.argv.includes("--json");
console.log("语义基准（真实模型）—— bge-small-zh-v1.5");
await runSemanticBenchmark({ real: true, modelDir, json });
