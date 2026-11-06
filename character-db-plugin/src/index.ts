// @character-db/dsh-plugin — DSH shell around a character database.
//
// What it does: registers TWO read-only tools and nothing else.
// - character_search: keyword search over the character db (same
//   tokenizer / filters / scoring as query.mjs), with a token cap.
// - character_lookup: fetch one entry by id.
//
// What it deliberately does NOT do (design decision, see README):
// - NO agent/pre-step, NO session/event listeners, NO
//   systemPrompt.context, NO session-start injection, NO
//   ctx.effect. The ONE prompt-layer addition is a single static
//   systemPrompt.section (tool-usage instructions only — it names
//   the two tools and when to call them, and carries no canon
//   content, no entries, no memories). This plugin never puts
//   anything else into a prompt by itself. The skill's iron law is
//   that novel plot NEVER enters dialogue unasked: an auto-injected
//   canon fact would shove the original story into the chat whether
//   the user wanted it or not. The model only reads the db when it
//   decides it needs a canon check, and the skill's rules still
//   govern what it may say.
// - NEVER writes the database. loadDb only reads *.json.
// - NO network, NO login, NO cloud. Zero runtime dependencies.
//
// Config arrives as apply's SECOND parameter in Cordis/DSH — never
// as ctx.config (that property does not exist on a real Context;
// reading it throws "cannot get property config without inject" and
// the plugin fails to activate). The mock test covers this: it calls
// apply through a Proxy that throws on any ctx.config access.
//
// Tool parameters are compiled to real JSON Schema locally when
// @deepseek-ai/dsh-tools does not resolve (it never resolves in a
// link: install — verified 2026-11-06 for the sibling memory
// plugin) and self-checked after register. Argument validation is
// done inside each execute(): a bad call returns an error object,
// never throws and never writes anything (there is nothing to
// write).

import { homedir } from "node:os";
import { join } from "node:path";
import {
  applyFilters,
  loadDb,
  lookupDb,
  parseChapterSpec,
  resolveTypeAlias,
  searchDb,
} from "./db.ts";
import type { CharacterDb } from "./db.ts";
import { isObjectSchema, loadDefineTool } from "./define-tool.ts";
import type {
  CharacterDbPluginConfig,
  CharacterDbPluginContext,
} from "./types.ts";

export const name = "character-db";
export const inject = ["tools", "systemPrompt"];

export const DEFAULT_TOKEN_CAP = 1500;

// Static tool-usage section (0.1.1). The one prompt-layer addition:
// it tells the model the two tools exist and when to call them, and
// nothing else. It carries NO canon content, NO entry text, NO
// memories — the model only ever sees db content by calling a tool.
// Exported so the mock test can assert the registered section is
// exactly this text.
export const TOOLS_SECTION_NAME = "character-db:tools";
export const TOOLS_SECTION_TEXT =
  "人物数据库工具已启用：有两个只读工具可供调用。character_search——按关键词加过滤器（集合类型、章节、对象、情绪、阶段）检索人物数据库，返回按相关度排序的意译条目；character_lookup——按 id 取一条完整条目。只在需要核对原著细节时才调用：某句台词的口吻、某件事的来龙去脉、某个人物的关系、某个名字的写法。不要为了闲聊主动查库。返回的条目是意译、不是她的原话，绝不能当作她说过的话直接引用；关键事件是小说背景，绝不是与聊天使用者的共同经历。";

export function resolveDataDir(config?: CharacterDbPluginConfig): string {
  const fromConfig = config?.dataDir;
  if (fromConfig) return fromConfig;
  const fromEnv = process.env.CHARACTER_DB_DATA_DIR;
  if (fromEnv) return fromEnv;
  return join(homedir(), "workspace", "character-db", "xia-ningqi");
}

// Guard text the model sees on both tools. The db holds PARAPHRASED
// canon, not her words and not shared history: entries must never be
// quoted as something she said, and key_events are novel background
// only — never presented as something that happened between her and
// the person chatting.
const CANON_GUARD =
  "只读查询人物数据库（原著 canon 的意译摘要）。返回的条目是意译、不是她的原话，绝不能当作她说过的话直接引用；关键事件是小说背景，绝不是与聊天使用者的共同经历；只有在需要核对原著细节（她某句话的口吻、某件事的来龙去脉、某个人物的关系）时才调用，不要为了闲聊主动查库。";

function publicResult(e: {
  id: string;
  type: string;
  chapter: number | null;
  chapter_label: string | null;
  chapter_range: [number, number] | null;
  stage: string | null;
  addressee: string | null;
  emotion: string[];
  scene: string | null;
  text: string;
  source: string;
  _score?: number;
}): Record<string, unknown> {
  return {
    id: e.id,
    type: e.type,
    chapter: e.chapter,
    chapter_label: e.chapter_label,
    chapter_range: e.chapter_range,
    stage: e.stage,
    addressee: e.addressee,
    emotion: e.emotion,
    scene: e.scene,
    text: e.text,
    source: e.source,
    score: e._score ?? null,
  };
}

// Plugin config arrives as apply's SECOND parameter in Cordis/DSH —
// never as ctx.config (see the NOTE in types.ts). Tools only: no
// listeners, no effect, no dynamic context — one static section
// (tool usage only, registered below after the db loads).
export function apply(
  ctx: CharacterDbPluginContext,
  config?: CharacterDbPluginConfig,
): void {
  const dataDir = resolveDataDir(config);
  const tokenCap =
    typeof config?.tokenCap === "number" &&
    Number.isFinite(config.tokenCap) &&
    config.tokenCap > 0
      ? Math.floor(config.tokenCap)
      : DEFAULT_TOKEN_CAP;

  // A failing db must fail LOUDLY, naming the dataDir and the cause
  // — never silently half-load. (Cordis only logs a fiber error when
  // apply() throws, so the message has to carry the diagnosis
  // itself.) No silent fallback to the default directory: answering
  // from the wrong character's db would be worse than not loading.
  let db: CharacterDb;
  try {
    db = loadDb(dataDir);
  } catch (err) {
    console.warn(
      `[character-db] 人物数据库插件加载失败：打不开数据目录 ${dataDir}（${err instanceof Error ? err.message : String(err)}）。插件未加载，DSH 本身不受影响；请检查 dataDir 路径与权限（见 README 的配置一节）后再重启 DSH。`,
    );
    throw err;
  }
  if (db.filesSkipped.length > 0) {
    console.warn(
      `[character-db] 已加载 ${db.entries.length} 条（${db.characterName || db.character}），跳过损坏文件：${db.filesSkipped.join("、")}。`,
    );
  }

  // Static tool-usage section: the one prompt-layer addition (0.1.1).
  // It names the two tools and when to call them — nothing else. No
  // canon content, no entries, no memories are ever injected; the
  // model only reads the db when it calls a tool. Registered only
  // once the db has loaded: advertising tools that do not exist
  // would be worse than silence. Duplicate registration (plugin
  // applied twice in one process, e.g. two profiles) must not kill
  // the plugin — same guard as the memory plugin's directives
  // section.
  try {
    ctx.systemPrompt.section({
      name: TOOLS_SECTION_NAME,
      order: 700,
      text: TOOLS_SECTION_TEXT,
    });
  } catch (err) {
    console.warn(
      `[character-db] 工具说明 section 注册失败（可能是插件在同一进程里被加载了两次：${err instanceof Error ? err.message : String(err)}），工具本身不受影响。`,
    );
  }

  // Fallback tools for the model to call on its own initiative.
  // Parameters are compiled to real JSON Schema (by the real
  // defineTool when it resolves, otherwise by the local compiler in
  // define-tool.ts) and self-checked after register: register()
  // does not validate parameters, so a raw-DSL tool used to register
  // silently with a model-visible schema that had no
  // type/properties/required.
  void loadDefineTool()
    .then((defineTool) => {
      const registerTool = (spec: unknown): void => {
        let compiled: unknown;
        try {
          compiled = defineTool(spec);
        } catch (err) {
          console.warn(
            `[character-db] 工具编译失败，跳过注册：${err instanceof Error ? err.message : String(err)}`,
          );
          return;
        }
        const params = (compiled as { parameters?: unknown } | null)
          ?.parameters;
        if (!isObjectSchema(params)) {
          console.warn(
            `[character-db] 工具 ${(compiled as { name?: unknown } | null)?.name} 的 parameters 不是合法 JSON Schema，跳过注册（模型看不到它）。`,
          );
          return;
        }
        try {
          ctx.tools.register(compiled);
        } catch (err) {
          console.warn(
            `[character-db] 工具 ${(compiled as { name?: unknown } | null)?.name} 注册失败：${err instanceof Error ? err.message : String(err)}`,
          );
          return;
        }
        const registered = ctx.tools.get?.(
          String((compiled as { name?: unknown } | null)?.name ?? ""),
        );
        if (registered !== undefined) {
          const rp = (registered as { parameters?: unknown } | null)
            ?.parameters;
          if (!isObjectSchema(rp)) {
            console.warn(
              `[character-db] 工具 ${(compiled as { name?: unknown } | null)?.name} 注册后自检失败：注册表里的 parameters 不是合法 JSON Schema，模型可能无法正确调用它。`,
            );
          }
        }
      };

      registerTool({
        name: "character_search",
        description: `按关键词检索人物数据库，返回按相关度排序的条目（id、章节、对象、情绪、意译文本、来源）。${CANON_GUARD}`,
        parameters: {
          query: {
            type: "string",
            required: false,
            description:
              "要搜索的关键词或短语。为空时按过滤条件列出条目；关键词和过滤条件至少要给一个。",
          },
          type: {
            type: "string",
            required: false,
            description:
              "集合类型：lines（台词）/ inner（内心独白）/ events（关键事件）/ traits / relationships / rules / arc / profile / flags。默认全部集合。",
          },
          chapter: {
            type: "string",
            required: false,
            description:
              "章节过滤：单章如 107，范围如 131-165，重号如 151a。",
          },
          addressee: {
            type: "string",
            required: false,
            description: "说话对象过滤，如 祁南、叶安苒、林小小。",
          },
          emotion: {
            type: "string",
            required: false,
            description: "情绪过滤，如 吃醋、冷拒、撒娇、害羞。",
          },
          stage: {
            type: "string",
            required: false,
            description: "阶段过滤：early / mid / late。",
          },
          limit: {
            type: "number",
            required: false,
            description: "最多返回几条，默认 5，最多 20。",
          },
        },
        output: {
          schema: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              totalHits: { type: "number" },
              returned: { type: "number" },
              truncated: { type: "boolean" },
              dropped: { type: "number" },
              estimatedTokens: { type: "number" },
              results: { type: "array" },
              error: { type: "string" },
            },
          },
          render: (value: unknown) => [
            { type: "text", text: JSON.stringify(value, null, 2) },
          ],
        },
        execute: async (args: unknown) => {
          const a = (args ?? {}) as Record<string, unknown>;
          const query =
            typeof a.query === "string" ? (a.query as string).trim() : "";
          const limit =
            typeof a.limit === "number" ? (a.limit as number) : 5;
          const hasFilter =
            typeof a.type === "string" ||
            typeof a.chapter === "string" ||
            typeof a.addressee === "string" ||
            typeof a.emotion === "string" ||
            typeof a.stage === "string";
          if (!query && !hasFilter) {
            return {
              ok: false,
              error:
                "character_search 需要一个关键词 query，或至少一个过滤条件（type / chapter / addressee / emotion / stage）。",
            };
          }
          // Type alias validation: an unknown type is a caller
          // mistake, not an empty result — say so.
          let type: string | null = null;
          if (typeof a.type === "string") {
            const resolved = resolveTypeAlias(a.type);
            if (resolved === undefined) {
              return {
                ok: false,
                error: `未知的 type：${a.type}。可用：lines / inner / events / traits / relationships / rules / arc / profile / flags。`,
              };
            }
            type = resolved;
          }
          if (typeof a.chapter === "string") {
            const spec = parseChapterSpec(a.chapter);
            if (spec.kind === "unknown") {
              return {
                ok: false,
                error: `chapter 格式不对：${a.chapter}。用单章（107）、范围（131-165）或重号（151a）。`,
              };
            }
          }
          if (
            typeof a.stage === "string" &&
            !["early", "mid", "late"].includes(
              (a.stage as string).trim().toLowerCase(),
            )
          ) {
            return {
              ok: false,
              error: `stage 只能是 early / mid / late，收到：${a.stage}。`,
            };
          }
          try {
            const outcome = searchDb(db, {
              query,
              type,
              chapter:
                typeof a.chapter === "string"
                  ? (a.chapter as string)
                  : null,
              addressee:
                typeof a.addressee === "string"
                  ? (a.addressee as string)
                  : null,
              emotion:
                typeof a.emotion === "string"
                  ? (a.emotion as string)
                  : null,
              stage:
                typeof a.stage === "string"
                  ? (a.stage as string).trim().toLowerCase()
                  : null,
              limit,
              tokenCap,
            });
            return {
              ok: true,
              character: db.character,
              character_name: db.characterName,
              query,
              totalHits: outcome.totalHits,
              returned: outcome.results.length,
              truncated: outcome.truncated,
              dropped: outcome.dropped,
              estimatedTokens: outcome.estimatedTokens,
              tokenCap,
              note: outcome.truncated
                ? `结果超过 token 上限（${tokenCap}），已按分数从低到高截掉 ${outcome.dropped} 条；想看被截掉的条目请缩小范围（加过滤条件或换更具体的关键词）再查。`
                : "",
              results: outcome.results.map(publicResult),
            };
          } catch (err) {
            return {
              ok: false,
              error: `检索失败：${err instanceof Error ? err.message : String(err)}`,
            };
          }
        },
      });

      registerTool({
        name: "character_lookup",
        description: `按 id 取人物数据库里的一条完整条目（全部字段）。${CANON_GUARD}`,
        parameters: {
          id: {
            type: "string",
            required: true,
            description:
              "条目 id，如 line-107-01、event-238、trait-04、profile。",
          },
        },
        output: {
          schema: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              found: { type: "boolean" },
              entry: { type: "object" },
              error: { type: "string" },
            },
          },
          render: (value: unknown) => [
            { type: "text", text: JSON.stringify(value, null, 2) },
          ],
        },
        execute: async (args: unknown) => {
          const a = (args ?? {}) as Record<string, unknown>;
          const id = typeof a.id === "string" ? (a.id as string).trim() : "";
          if (!id) {
            return {
              ok: false,
              found: false,
              error: "character_lookup 需要一个非空字符串 id。",
            };
          }
          try {
            const entry = lookupDb(db, id);
            if (!entry) {
              return {
                ok: true,
                found: false,
                error: `没有 id 为 ${id} 的条目。先用 character_search 查到 id 再取。`,
              };
            }
            // Full raw entry (all fields) plus its collection type.
            return {
              ok: true,
              found: true,
              entry: { ...(entry.raw as Record<string, unknown>), _type: entry.type },
            };
          } catch (err) {
            return {
              ok: false,
              found: false,
              error: `读取失败：${err instanceof Error ? err.message : String(err)}`,
            };
          }
        },
      });
    })
    .catch((err: unknown) => {
      // Tool registration must never break the plugin load, but a
      // failure must not be silent either: without the tools the
      // model cannot read the db at all.
      console.warn(
        "[character-db] 工具注册失败 (工具不可用，数据库本身未被改动):",
        err,
      );
    });
}

// Re-exported for the mock test / demo (not part of the DSH surface).
export { applyFilters, loadDb, lookupDb, searchDb };
