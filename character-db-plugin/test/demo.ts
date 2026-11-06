// Demo: run the four headline queries against the REAL character db
// and print the top hits. No DSH, no network, read-only.
// Usage: node test/demo.ts
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadDb, lookupDb, searchDb } from "../src/db.ts";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const DB_DIR = join(TEST_DIR, "..", "..", "xia-ningqi");

const db = loadDb(DB_DIR);
console.log(
  `人物数据库：${db.characterName || db.character}，${db.entries.length} 条（${db.filesLoaded.length} 个文件，跳过 ${db.filesSkipped.length} 个）\n`,
);

function show(label: string, query: string): void {
  const out = searchDb(db, { query, limit: 5, tokenCap: 1500 });
  console.log(`== ${label}（关键词：${query}，命中 ${out.totalHits} 条，返回 ${out.results.length} 条）==`);
  for (const e of out.results) {
    const ch = e.chapter_label
      ? `ch.${e.chapter_label}`
      : e.chapter !== null
        ? `ch.${e.chapter}`
        : e.chapter_range
          ? `ch.${e.chapter_range[0]}-${e.chapter_range[1]}`
          : "";
    console.log(
      `  [${e._score}] ${e.type} ${e.id} ${ch} ${e.stage ?? ""}${e.addressee ? ` 对${e.addressee}` : ""} [${e.emotion.join(",")}]`,
    );
    if (e.scene) console.log(`    场景：${e.scene}`);
    console.log(`    ${e.text}`);
    console.log(`    来源：${e.source}`);
  }
  console.log("");
}

show("绑架", "绑架");
show("考研", "考研");
show("日记", "日记");
show("姜萍", "姜萍");

const ev = lookupDb(db, "event-238");
console.log(
  `== lookup event-238 ==\n  ${ev ? `${ev.type} ${ev.id}：${ev.text}` : "未找到"}`,
);
