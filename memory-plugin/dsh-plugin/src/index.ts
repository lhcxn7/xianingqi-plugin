// @memory-plugin/dsh-plugin — DSH shell around @memory-plugin/core.
//
// What it does (hooks verified live in headless DSH 0.2.1-rc.5,
// 2026-11-06 — the event envelope is no longer "unverified"):
// - agent/created: track a new session; a rebuilt persona session
//   keeps its persona flag (restored from the persisted set, audit
//   M7) and its turn-1 appended ids (restored from appended-ids.json,
//   0.1.4 minor 1 — without them the next turn would re-register the
//   same hits as context), and the old session's dynamic context is
//   disposed first. 0.2.0: also runs the daily review once here, but
//   ONLY for a session already known to be persona (restored from
//   the persisted set, review-9 m-6 — a fresh session cannot be told
//   apart from a task session yet, so it gets its first review on
//   its next open). core.review(), 24 h gate inside, never forced —
//   a review failure is caught and warned, never breaks the session.
// - agent/pre-step (awaited waterfall, {prepend:true}): run keyword
//   recall on the incoming user message(s), PERSONA windows only;
//   0.2.0: recall gets the session id (recall-link tracking +
//   relationship factor) and the session's last 5 user texts
//   (attention factor); the recent-texts list is updated AFTER the
//   recall, so the current turn never attends to itself.
// - agent/pre-step (awaited waterfall, {prepend:true}): run keyword
//   recall on the incoming user message(s), PERSONA windows only;
//   turn 1 appends the recall to decision.messages (the only seam
//   before the first model request); later turns refresh the dynamic
//   recall context, registered per-agent through agent.ctx so two
//   windows never collide on the global layer (audit B1/M1).
//   Session-start injection is done here, NOT in agent/created (emit,
//   not awaited — can miss turn 1). A pre-step with no user text does
//   not consume the turn-1 append slot. A recall failure degrades to
//   "no injection this turn" and never kills the turn (audit M6).
// - session/event user/message + assistant/message: record into the
//   core's append-only log, persona windows only (see below), skipping
//   plugin-injected messages (source.kind !== "user") so injected
//   memory is never re-recorded. Reasoning blocks are skipped (they
//   are the model's inner voice, not her words); pure-image messages
//   are recorded as [图片]; interrupted half-sentences are marked
//   [未说完] (audit m5/m6/m7).
// - session/event compaction/start: flush the index AND take a
//   snapshot (audit M5 — one of the only two moments a snapshot can
//   actually run).
// - agent/turn-stopping: flush at the turn boundary.
// - ctx.effect disposer: endSession() — snapshot + rollover + flush
//   (audit M5/M12; before 0.1.3 endSession existed but nothing ever
//   called it, so the "snapshot protection" never ran).
// - memory_search / memory_remember / memory_fragment /
//   memory_snapshot / memory_restore / memory_status /
//   memory_starmap / memory_daily_review tools (fallback for the
//   model). memory_remember takes an optional emotion ("温暖" or
//   "温暖:0.7"); memory_fragment creates a fragment on top of the
//   log (0.3.0, code-verified against its sources);
//   memory_daily_review submits the daily model review's picks
//   (0.3.0, new layer 2); memory_starmap regenerates starmap.html
//   on demand. Write tools are gated to persona windows like
//   the rest.
//   Tool parameters are compiled to real JSON Schema locally when
//   @deepseek-ai/dsh-tools does not resolve (audit M2 — it never
//   resolves in a link: install) and self-checked after register.
//   memory_remember is gated to persona windows by the calling
//   session (exec.agent.session.id, audit M4).
//
// Recall / injection rules (fixed 2026-11-05):
// - No keyword match means NO injection (recall returns empty hits).
//   v1 fell back to "most recent, heavy first" and injected unrelated
//   memories on every unrelated question, in task windows too.
// - Task windows get no recall injection at all — not even turn 1.
//   (The skill's task window already reads layer 1 + recent 30 days
//   at open; the plugin adds nothing there.)
// - Turn 2+ never re-injects what the turn-1 append already put into
//   session history (audit m16): only hits not covered by the append
//   are registered as context, so the same memory never appears twice
//   in one prompt. The appended-id set is persisted per session
//   (appended-ids.json, capped) so a REBUILT session does not
//   re-register them either (0.1.4 minor 1 — the rebuild used to
//   clear the set and double-inject on the next turn).
//
// Event-envelope tolerance (defensive, 2026-11-05; shapes verified
// live 2026-11-06):
// - If an event arrives without source.kind, the shell no longer
//   silently drops it: for a user/message event it falls back to the
//   event type itself (the type says it is a user message) and logs
//   one warning. Plugin-injected messages are still skipped — they
//   carry source.kind === "memory-plugin".
// - If an event arrives without any session id, the shell mints a
//   fresh ephemeral id per event instead of sharing one "default"
//   session: persona state can never leak across sessions, and events
//   without an id are never recorded as persona memory (their session
//   cannot be attributed) — the returned `attributable` flag tells the
//   caller.
// - If an event arrives without any type/name/kind, the shell infers
//   the type from message.role when possible, and ignores it otherwise.
//
// What it deliberately does NOT do (v1 design correction):
// - NO tools/pre-execute deletion veto. The skill (v2.3+) routes a
//   delete of skill/memory/diary through the persona, stage-based, and
//   late stage may actively execute it. A blanket plugin veto would
//   make late-stage execution impossible and fight the skill, and the
//   plugin cannot judge whether the persona consented. Deletion is
//   governed by the skill's persona rule + snapshots/backups.
// - NEVER writes MEMORY.md. The core writes only its own log + index;
//   the three-layer summaries stay model-written per the skill.
// - Injects facts only, never stage judgments; stage comes from
//   MEMORY.md layer 1. Recall text excludes layer 1 (the skill already
//   reads it at open) so the same memory never appears twice.
// - No compaction-hook rotation (no such seam exists) and no background
//   daemon (in-process timers only).
//
// Persona vs task windows: the plugin uses the skill's own trigger — a
// session becomes a persona session when a user message in it contains
// 夏柠柒 / 柠柒 (configurable via triggerWords). Task windows never
// trigger, so their messages are never recorded. 0.3.1: a user message
// that contains the trigger AND a task-blocklist word (TASK_BLOCKLIST:
// technical words like GitHub / SKILL.md / 插件, or task-action words
// like 更新 / 安装 / 升级) does NOT mark the session — the task
// instruction is recognised as a task, not a chat. Once marked, a
// session stays persona for its whole lifetime (one-way latch); the
// blocklist only gates the marking, never un-marks a session and never
// filters individual messages out of the verbatim log. By design,
// messages sent BEFORE the first trigger word in a session never enter
// the log: the plugin only knows a session is a persona window once the
// trigger appears (audit m15 — the skill's own MEMORY.md summary may
// still retain them, the verbatim log does not).

import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  MemoryCore,
  MODEL_REVIEW_CATEGORIES,
  atomicWriteText,
  buildModelReviewPrompt,
  formatLayer1,
  formatRecallBlock,
  parseModelReviewIds,
} from "../../core/src/index.ts";
import type {
  FragmentCandidate,
  MemoryEntry,
  RecallResult,
  ReviewResult,
} from "../../core/src/index.ts";
import { isObjectSchema, loadDefineTool } from "./define-tool.ts";
import type {
  MemoryPluginConfig,
  MemoryPluginContext,
  PreStepDecision,
  SessionEvent,
  SystemPromptRegistry,
} from "./types.ts";

export const name = "memory-plugin";
export const inject = ["tools", "systemPrompt"];

export const DEFAULT_TRIGGER_WORDS = ["夏柠柒", "柠柒"];
export const DEFAULT_TOKEN_CAP = 1500;

/** 0.3.0: substrings marking a mid-turn user message as explicitly
 *  reaching for the past — condition (a) of the restrained
 *  mid-conversation recall trigger. Small and literal by design:
 *  the recall's own keyword match is the second filter, so a cue
 *  with no matching memory injects nothing. Configurable via
 *  MemoryPluginConfig.memoryCueWords. */
export const DEFAULT_MEMORY_CUE_WORDS = [
  "还记得",
  "还记不记得",
  "你说过",
  "以前",
  "那次",
  "那家",
  "我们去过",
  "当时",
  "那时候",
  "之前",
  "曾经",
];

export function isPersonaTrigger(
  text: string,
  triggerWords: string[] = DEFAULT_TRIGGER_WORDS,
): boolean {
  return triggerWords.some((w) => w.length > 0 && text.includes(w));
}

/** 0.3.1: substrings that mark a user message as a TASK instruction
 *  rather than a persona chat, even when it also contains the
 *  trigger. Two groups: technical words (almost never spoken in a
 *  persona chat) and task-action words (the verbs of task
 *  instructions). Checked only against USER messages, only for the
 *  persona-marking decision — DSH/assistant output never triggers
 *  marking and is never checked against this list, and once a
 *  session is marked persona it stays persona (one-way latch);
 *  the blocklist never un-marks a session and never filters
 *  individual messages out of the verbatim log (the log stays
 *  complete — a gap would break fragment verification and the
 *  daily review). Substring match, same as the trigger itself. */
export const TASK_BLOCKLIST: string[] = [
  // Technical words — almost never in a persona chat.
  "GitHub",
  "github",
  "dsh plugin",
  "memory-plugin",
  "SKILL.md",
  "dataDir",
  "log.jsonl",
  "agentPreset",
  "preset",
  "cordis",
  "commit",
  "push",
  "分支",
  "仓库",
  "v0.",
  "profile",
  "记忆插件",
  "代码",
  "命令",
  "路径",
  // Task-action words — the verbs of task instructions.
  "更新",
  "安装",
  "覆盖",
  "下载",
  "报错",
  "重启",
  "配置",
  "打包",
  "审查",
  "推送",
  "修改",
  "测试",
  "版本",
  "skill",
  "插件",
  "升级",
  "修复",
  "优化",
  "发布",
  "部署",
  "构建",
  "备份",
  "删除",
  "导入",
  "导出",
  "创建",
  "同步",
];

/** 0.3.1: true when the text contains any task-blocklist word. */
export function hasTaskBlocklistWord(
  text: string,
  blocklist: string[] = TASK_BLOCKLIST,
): boolean {
  return blocklist.some((w) => w.length > 0 && text.includes(w));
}

/** 0.3.1: the persona-marking gate — true when the user message
 *  carries the trigger AND no task-blocklist word. A task
 *  instruction that mentions her name ("帮我把夏柠柒的 skill
 *  更新一下") does not mark the session; a plain address
 *  ("夏柠柒，在吗") does. */
export function shouldMarkPersona(
  text: string,
  triggerWords: string[] = DEFAULT_TRIGGER_WORDS,
  blocklist: string[] = TASK_BLOCKLIST,
): boolean {
  return (
    isPersonaTrigger(text, triggerWords) &&
    !hasTaskBlocklistWord(text, blocklist)
  );
}

/** 0.3.0: true when the text explicitly reaches for the past
 *  (contains one of the memory-cue substrings). */
export function hasMemoryCue(
  text: string,
  cueWords: string[] = DEFAULT_MEMORY_CUE_WORDS,
): boolean {
  return cueWords.some((w) => w.length > 0 && text.includes(w));
}

/** 0.2.0: parse a model-supplied emotion tag for memory_remember:
 *  "温暖" or "温暖:0.7" (full-width ： also accepted) into
 *  {type, intensity}. Anything unparseable returns undefined and the
 *  caller treats it as "not passed" — the core's keyword lexicon
 *  guesses instead. Intensity is clamped to 0..1. */
export function parseEmotion(
  raw: unknown,
): { type: string; intensity: number } | undefined {
  if (typeof raw !== "string") return undefined;
  const s = raw.trim().replace(/：/g, ":");
  if (!s) return undefined;
  const idx = s.lastIndexOf(":");
  if (idx === -1) return { type: s, intensity: 0.5 };
  const type = s.slice(0, idx).trim();
  const n = Number(s.slice(idx + 1).trim());
  if (!type || !Number.isFinite(n)) return undefined;
  return { type, intensity: Math.min(1, Math.max(0, n)) };
}

function resolveDataDir(config?: MemoryPluginConfig): string {
  const fromConfig = config?.dataDir;
  if (fromConfig) return fromConfig;
  const fromEnv = process.env.MEMORY_PLUGIN_DATA_DIR;
  if (fromEnv) return fromEnv;
  return join(homedir(), ".dsh", "xia-ningqi-data");
}

function messageText(message: unknown): string {
  if (typeof message === "string") return message;
  if (message && typeof message === "object") {
    const m = message as { content?: unknown; text?: unknown };
    if (typeof m.content === "string") return m.content;
    if (typeof m.text === "string") return m.text;
    if (Array.isArray(m.content)) {
      const texts: string[] = [];
      let hasImage = false;
      let hasFile = false;
      for (const part of m.content) {
        if (typeof part === "string") {
          texts.push(part);
          continue;
        }
        if (part && typeof part === "object") {
          const p = part as {
            type?: unknown;
            text?: unknown;
            image_url?: unknown;
            image?: unknown;
            name?: unknown;
          };
          // Reasoning blocks are the model's inner voice, not her
          // spoken words — never record or recall them as if she
          // said them (audit m5). Tool-call parts are not words
          // either.
          if (
            p.type === "reasoning" ||
            p.type === "tool-call" ||
            p.type === "tool_use"
          ) {
            continue;
          }
          if (typeof p.text === "string") {
            texts.push(p.text);
            continue;
          }
          // Image / file parts carry no text: leave a trace that
          // something was there, or the log silently loses the
          // message entirely (audit m6).
          if (p.type === "image" || p.type === "image_url" || p.image_url || p.image) {
            hasImage = true;
            continue;
          }
          if (p.type === "file" || p.name) {
            hasFile = true;
            continue;
          }
        }
      }
      const joined = texts.join("");
      const mediaTag = hasImage ? " [图片]" : hasFile ? " [附件]" : "";
      if (!joined && mediaTag) return mediaTag.trim();
      if (joined && mediaTag) return `${joined}${mediaTag}`;
      return joined;
    }
  }
  return "";
}

// Every real user message in the decision (audit m17): two messages
// arriving before turn 1 used to recall only the last one's keywords.
// Plugin-injected recall (a user-role message with source.kind
// "memory-plugin", committed from turn 1's append) is skipped — it
// must neither trigger persona nor drive recall, or recall would
// chase its own tail.
function allUserTexts(decision: PreStepDecision): string[] {
  const messages = decision.messages ?? [];
  const out: string[] = [];
  for (const m of messages) {
    if (m?.role !== "user") continue;
    if (m?.source?.kind === "memory-plugin") continue;
    const t = messageText(m);
    if (t) out.push(t);
  }
  return out;
}

// The message payload of a session event. Real DSH 0.2.1 puts it in
// event.data ({role, content, source}); the older assumed shape put
// it in event.message. Prefer data, fall back to message.
// NOTE (0.1.2): an assistant/message settlement nests the message one
// level deeper — data is {turn, step, message, usage, stream}, the
// words live in data.message.content. Reading data.content directly
// yields "" there, so her words were silently skipped until this
// unwrap was added (found 2026-11-06 from the user's log: only
// role:"user" entries, no assistant entries).
function eventMessage(ev: SessionEvent): unknown {
  const raw =
    ev.data !== undefined && ev.data !== null ? ev.data : ev.message;
  if (raw && typeof raw === "object") {
    const nested = (raw as { message?: unknown }).message;
    if (
      nested &&
      typeof nested === "object" &&
      ("content" in nested || "role" in nested)
    ) {
      return nested;
    }
  }
  return raw;
}

function eventType(ev: SessionEvent): string {
  const direct = (ev.type ?? ev.name ?? ev.kind ?? "").toString();
  if (direct) return direct;
  // No type field at all: infer from the message role when possible.
  const role = (eventMessage(ev) as { role?: unknown } | undefined)?.role;
  if (role === "user") return "user/message";
  if (role === "assistant") return "assistant/message";
  return "";
}

function eventText(ev: SessionEvent): string {
  const msg = eventMessage(ev);
  let text = "";
  if (msg) text = messageText(msg);
  else if (typeof ev.text === "string") text = ev.text;
  else if (typeof ev.content === "string") text = ev.content;
  if (!text) return "";
  // An interrupted stream is a half-sentence, not a complete one
  // (audit m7): mark it so the log never presents it as finished.
  const interrupted = (ev.data as { interrupted?: unknown } | undefined)
    ?.interrupted;
  if (interrupted === true) return `${text} [未说完]`;
  return text;
}

function eventSourceKind(ev: SessionEvent): string {
  return (
    (eventMessage(ev) as { source?: { kind?: string } } | undefined)?.source
      ?.kind ??
    ev.source?.kind ??
    ""
  ).toString();
}

interface SessionState {
  persona: boolean;
  turns: number;
  /** Disposer for this session's dynamic recall context (per-session,
   *  so interleaved sessions never release each other's context). */
  disposer: (() => void) | null;
  /** Entry ids already injected into this session via the turn-1
   *  append. The append is committed to session history and stays
   *  there, so those hits are never re-registered as context
   *  (audit m16). */
  appendedIds: Set<string>;
  /** 0.2.0: this session's most recent user texts (max 5), fed to
   *  recall as recentTexts for the attention factor. Updated AFTER
   *  each recall, so the current turn never attends to itself.
   *  In-memory only — a rebuilt session starts empty. */
  recentUserTexts: string[];
  /** 0.3.0 daily model review: set at agent/created when the code
   *  review ran (restored persona, >24h — the m-6 gate); the first
   *  pre-step after that hands yesterday's messages to the model
   *  and marks it done, so it happens once per session-open. */
  modelReviewDue: boolean;
  modelReviewDone: boolean;
  /** M-1 (review-12): fragment candidates from the code review that
   *  just ran at agent/created (persona entries only — review.ts
   *  filters task windows). Handed to the model with yesterday's
   *  messages on the first pre-step, then cleared. In-memory only. */
  modelReviewCandidates: FragmentCandidate[] | null;
  /** Disposer for the daily-review dynamic context (per-session,
   *  like the recall disposer). Cleared when the model submits
   *  the review (memory_daily_review) or the session rebuilds. */
  reviewDisposer: (() => void) | null;
}

// Persona-session ids, persisted in the data dir so a rebuilt session
// (agent/created re-fires) keeps its persona flag across DSH restarts
// (audit M7). Plugin-owned file, covered by snapshots.
const PERSONA_FILE = "persona-sessions.json";

// Turn-1 appended entry ids, per session, persisted in the data dir
// (0.1.4 minor 1). The turn-1 append is committed to session history
// and stays there across a rebuild, so the appended ids must survive
// the rebuild too — otherwise the next turn re-registers the same
// hits as context and the model sees the memory twice. Plugin-owned
// file, covered by snapshots (like persona-sessions.json).
const APPENDED_FILE = "appended-ids.json";
// Cap: newest 500 sessions, each keeping its newest 200 ids. A
// session's turn-1 append adds only a handful of ids, but the file
// must not grow forever as sessions accumulate.
const APPENDED_MAX_SESSIONS = 500;
const APPENDED_MAX_IDS_PER_SESSION = 200;

// Plugin config arrives as apply's SECOND parameter in Cordis/DSH —
// never as ctx.config (that property does not exist on a real Context;
// reading it throws "cannot get property config without inject" and
// the plugin fails to activate). The mock test covers this: it calls
// apply through a Proxy that throws on any ctx.config access.
export function apply(
  ctx: MemoryPluginContext,
  config?: MemoryPluginConfig,
): void {
  const dataDir = resolveDataDir(config);
  const tokenCap = config?.tokenCap ?? DEFAULT_TOKEN_CAP;
  const triggerWords = config?.triggerWords ?? DEFAULT_TRIGGER_WORDS;
  const memoryCueWords =
    config?.memoryCueWords ?? DEFAULT_MEMORY_CUE_WORDS;

  // Warn once per distinct problem (not on every event).
  const warned = new Set<string>();
  const warnOnce = (key: string, message: string): void => {
    if (warned.has(key)) return;
    warned.add(key);
    console.warn(`[memory-plugin] ${message}`);
  };

  // Audit M3: a failing core must fail LOUDLY, naming the dataDir and
  // the cause — never silently half-load. (Cordis only logs a fiber
  // error when apply() throws, so the message has to carry the
  // diagnosis itself.) No silent fallback to the default directory:
  // recording into the wrong folder would split her memory in two.
  let core: MemoryCore;
  try {
    core = new MemoryCore({ dataDir });
  } catch (err) {
    console.warn(
      `[memory-plugin] 记忆插件加载失败：打不开数据目录 ${dataDir}（${err instanceof Error ? err.message : String(err)}）。插件未加载，DSH 本身不受影响；请检查 dataDir 路径、盘符与权限后再重启 DSH。`,
    );
    throw err;
  }

  const loadPersonaSessions = (): Set<string> => {
    try {
      const raw = readFileSync(join(dataDir, PERSONA_FILE), "utf8");
      const arr = JSON.parse(raw) as unknown;
      if (Array.isArray(arr)) {
        return new Set(
          arr.filter((x): x is string => typeof x === "string"),
        );
      }
    } catch {
      // Missing or corrupt: start empty; the file is rebuilt on the
      // next persona transition.
    }
    return new Set<string>();
  };

  const savePersonaSessions = (set: Set<string>): void => {
    try {
      // Keep the newest 500; stale ids are harmless but the file
      // must not grow forever.
      const arr = [...set].slice(-500);
      atomicWriteText(join(dataDir, PERSONA_FILE), `${JSON.stringify(arr)}\n`);
    } catch (err) {
      warnOnce(
        "persona-save-failed",
        `人设会话标记保存失败（${err instanceof Error ? err.message : String(err)}），重启后重建的人设窗口可能要重新触发一次。`,
      );
    }
  };

  // 0.1.4 minor 1: appended ids, persisted per session. Format:
  // {"<sessionId>": ["<entryId>", ...]}. Corrupt or missing file
  // starts empty — worst case a rebuilt session re-registers a few
  // hits as context (the pre-0.1.4 behaviour), never a crash.
  const loadAppendedIds = (): Map<string, Set<string>> => {
    try {
      const raw = readFileSync(join(dataDir, APPENDED_FILE), "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const out = new Map<string, Set<string>>();
        for (const [sid, ids] of Object.entries(parsed)) {
          if (Array.isArray(ids)) {
            out.set(
              sid,
              new Set(ids.filter((x): x is string => typeof x === "string")),
            );
          }
        }
        return out;
      }
    } catch {
      // Missing or corrupt: start empty.
    }
    return new Map<string, Set<string>>();
  };

  const saveAppendedIds = (map: Map<string, Set<string>>): void => {
    try {
      const obj: Record<string, string[]> = {};
      for (const [sid, ids] of [...map.entries()].slice(
        -APPENDED_MAX_SESSIONS,
      )) {
        obj[sid] = [...ids].slice(-APPENDED_MAX_IDS_PER_SESSION);
      }
      atomicWriteText(join(dataDir, APPENDED_FILE), `${JSON.stringify(obj)}\n`);
    } catch (err) {
      warnOnce(
        "appended-save-failed",
        `turn-1 已注入条目标记保存失败（${err instanceof Error ? err.message : String(err)}），重建会话后可能重复注入同一段记忆一次。`,
      );
    }
  };

  const personaSessions = loadPersonaSessions();
  const appendedIdsMap = loadAppendedIds();
  const sessions = new Map<string, SessionState>();

  /** Re-read the persisted persona state from disk and sync the live
   *  session map to it. Called after a successful memory_restore
   *  (0.1.4 minor 4): the restore reverts persona-sessions.json and
   *  appended-ids.json to snapshot time, and the in-shell copies must
   *  follow — otherwise the next markPersona would write the stale
   *  set back to disk and silently undo the restore. The alternative
   *  (keeping persona-sessions.json out of snapshots) was rejected:
   *  the flags ARE plugin state and a restore should restore them. */
  const reloadPersonaState = (): void => {
    const restored = loadPersonaSessions();
    personaSessions.clear();
    for (const id of restored) personaSessions.add(id);
    const restoredAppended = loadAppendedIds();
    appendedIdsMap.clear();
    for (const [id, ids] of restoredAppended) appendedIdsMap.set(id, ids);
    for (const [sid, state] of sessions) {
      state.persona = personaSessions.has(sid);
      state.appendedIds = appendedIdsMap.get(sid) ?? new Set<string>();
    }
  };

  // Session id resolution. Real DSH 0.2.1 dispatches session/event as
  // (session, event): the session object carries .id — that is the
  // primary source (passed in as subjectId). A missing id mints a
  // FRESH ephemeral id per event (never a shared "default"): persona
  // state can never leak across sessions, and events without an id
  // are never recorded as persona memory (their session cannot be
  // attributed) — the returned `attributable` flag tells the caller.
  let ephemeralCounter = 0;
  const resolveSessionId = (
    ev: SessionEvent,
    subjectId?: unknown,
  ): { id: string; attributable: boolean } => {
    const id =
      subjectId ??
      ev.sessionId ??
      ev.session?.id ??
      ev.agent?.id ??
      ev.agent?.session?.id ??
      ev.agentId;
    if (id !== undefined && id !== null && `${id}`.length > 0) {
      return { id: `${id}`, attributable: true };
    }
    warnOnce(
      "missing-session-id",
      "session/event 缺少会话 id，无法归属会话：本次事件用临时代号处理，不记入人设记忆。请核对真实 DSH 的事件信封。",
    );
    ephemeralCounter += 1;
    return {
      id: `ephemeral-${ephemeralCounter}-${randomBytes(3).toString("hex")}`,
      attributable: false,
    };
  };

  const getSession = (id: string): SessionState => {
    let s = sessions.get(id);
    if (!s) {
      s = {
        persona: false,
        turns: 0,
        disposer: null,
        appendedIds: new Set(),
        recentUserTexts: [],
        modelReviewDue: false,
        modelReviewDone: false,
        modelReviewCandidates: null,
        reviewDisposer: null,
      };
      sessions.set(id, s);
    }
    return s;
  };

  const markPersona = (sid: string): void => {
    const session = getSession(sid);
    if (session.persona) return;
    session.persona = true;
    personaSessions.add(sid);
    savePersonaSessions(personaSessions);
  };

  /** Session id of the most recent pre-step that carried a user
   *  message. Fallback for the memory_remember gate only (audit M4):
   *  the gate prefers exec.agent.session.id, the calling session's
   *  own id, and uses this only when exec carries no agent. */
  let currentTurnSessionId: string | null = null;

  /** Persona gate shared by the write tools (audit M4, 0.2.0):
   *  the calling session's OWN id comes from
   *  exec.agent.session.id (dsh-tools calls tool.execute(
   *  exec.arguments, exec)); the most recent pre-step session is
   *  only a fallback when exec carries no agent. A task-window call
   *  is refused, not recorded — the v1.6 "task windows never write
   *  memory" rule holds on the plugin's own write paths too. */
  const toolSession = (
    exec?: unknown,
  ): { sid: string | null; persona: boolean } => {
    const execSid = (
      exec as { agent?: { session?: { id?: unknown } } } | undefined
    )?.agent?.session?.id;
    const sid =
      execSid !== undefined && execSid !== null && `${execSid}`.length > 0
        ? `${execSid}`
        : currentTurnSessionId;
    const current = sid !== null ? sessions.get(sid) : undefined;
    return { sid, persona: current?.persona === true };
  };

  // Stable directives: facts only, no stage judgments. Duplicate
  // registration (plugin applied twice in one process, e.g. two
  // profiles) must not kill the plugin (audit m14).
  try {
    ctx.systemPrompt.section({
      name: "memory-plugin:directives",
      order: 700,
      text: "记忆插件已启用: 以下注入的记忆是过去对话的原始事实片段, 仅供参考; 阶段、关系与人设以 MEMORY.md 第一层为准, 不要自行推断阶段; 不要把注入的片段当成小说剧情。",
    });
  } catch (err) {
    console.warn(
      `[memory-plugin] 静态 directives section 注册失败（可能是插件在同一进程里被加载了两次：${err instanceof Error ? err.message : String(err)}），插件继续运行，记忆注入不受影响。`,
    );
  }

  // Dynamic recall context, refreshed every turn (dispose-then-register),
  // tracked PER SESSION so interleaved sessions never release each
  // other's context. Registered through the calling agent's own
  // scoped context (audit B1/M1): a global registration collides the
  // moment a second window (or a rebuilt session) registers the same
  // name — dsh-system-prompt throws `prompt context "…" is already
  // registered` — and leaks the recall into every other window's
  // prompt (the global layer is the base of every scope's merge).
  // When agent.ctx is unavailable (old host / mock), fall back to
  // the global layer. When agent.ctx IS available but registration
  // fails, do NOT fall back: the global layer would leak this
  // session's recall into every window (0.1.4 minor 2) — a failure
  // only skips injection for that turn, it never breaks the turn.
  const refreshRecallContext = (
    sid: string,
    text: string,
    agentCtx?: { systemPrompt?: SystemPromptRegistry },
  ): void => {
    const session = getSession(sid);
    try {
      session.disposer?.();
    } catch {
      // Disposer failures must not break the turn.
    }
    session.disposer = null;
    if (!text) return;
    const targets: Array<{ systemPrompt?: SystemPromptRegistry }> = [];
    if (agentCtx?.systemPrompt) {
      targets.push(agentCtx);
    } else {
      targets.push(ctx);
    }
    const errors: string[] = [];
    for (const target of targets) {
      const registry = target.systemPrompt;
      if (!registry) continue;
      try {
        const handle = registry.context({
          name: "memory-plugin:recall",
          order: 500,
          text,
        });
        if (typeof handle === "function") {
          session.disposer = handle as () => void;
        }
        return;
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }
    }
    warnOnce(
      "recall-context-failed",
      `动态 recall 上下文注册失败（${errors.join("；")}），本轮不注入上下文，对话继续。`,
    );
  };

  // 0.3.0 daily model review: hand yesterday's messages to the
  // model (as Xia) on the first turn after a due code review, so
  // she can pick the important ones with memory_daily_review.
  // Per-session context, like the recall context — and like it,
  // never the global layer: yesterday's messages must not leak
  // into every other window. When agent.ctx is unavailable the
  // review is skipped (one warn), never forced onto the global
  // layer. No entries yesterday means nothing to review.
  const registerModelReview = (
    sid: string,
    agentCtx?: { systemPrompt?: SystemPromptRegistry },
  ): void => {
    let entries: MemoryEntry[];
    try {
      entries = core.yesterdayEntries();
    } catch (err) {
      warnOnce(
        "model-review-read-failed",
        `昨日记忆读取失败，本次跳过模型复盘（${err instanceof Error ? err.message : String(err)}）。`,
      );
      return;
    }
    if (entries.length === 0) return;
    if (!agentCtx?.systemPrompt) {
      warnOnce(
        "model-review-no-agent-ctx",
        "没有 agent.ctx，本次跳过模型复盘（昨日记忆不进全局上下文）。",
      );
      return;
    }
    const session = getSession(sid);
    // M-1 (review-12): candidates captured at agent/created travel
    // with the review context; consumed once here, then cleared.
    const candidates = session.modelReviewCandidates ?? [];
    session.modelReviewCandidates = null;
    try {
      session.reviewDisposer?.();
    } catch {
      // Disposer failures must not break the turn.
    }
    session.reviewDisposer = null;
    try {
      const handle = agentCtx.systemPrompt.context({
        name: "memory-plugin:daily-review",
        order: 500,
        text: buildModelReviewPrompt(entries, candidates),
      });
      if (typeof handle === "function") {
        session.reviewDisposer = handle as () => void;
      }
    } catch (err) {
      warnOnce(
        "model-review-context-failed",
        `模型复盘上下文注册失败（${err instanceof Error ? err.message : String(err)}），本次跳过模型复盘。`,
      );
    }
  };

  // Session start: only tracked here; the memory read that turn 1
  // depends on happens in agent/pre-step (awaited). A rebuilt
  // persona session keeps its flag (audit M7) — never reset
  // unconditionally, or the first half of a reopened persona
  // conversation silently drops out of the log until someone says
  // the trigger again. turns starts at 1 for a restored persona
  // session: its turn-1 append already lives in the rehydrated
  // history, so the next turn must not append it a second time.
  ctx.on("agent/created", (ev) => {
    const { id } = resolveSessionId(ev as SessionEvent);
    const old = sessions.get(id);
    if (old?.disposer) {
      try {
        old.disposer();
      } catch {
        // Disposer failures must not break session tracking.
      }
    }
    if (old?.reviewDisposer) {
      try {
        old.reviewDisposer();
      } catch {
        // Disposer failures must not break session tracking.
      }
    }
    const restored = personaSessions.has(id);
    // 0.1.4 minor 1: restore the turn-1 appended ids too — the
    // append already lives in the rehydrated history, and without
    // these the next turn would re-register the same hits as context
    // (double injection). Refresh recency in the map.
    let appendedIds = appendedIdsMap.get(id);
    if (appendedIds) {
      appendedIdsMap.delete(id);
      appendedIdsMap.set(id, appendedIds);
    } else {
      appendedIds = new Set<string>();
    }
    sessions.set(id, {
      persona: restored,
      turns: restored ? 1 : 0,
      disposer: null,
      appendedIds,
      recentUserTexts: [],
      modelReviewDue: false,
      modelReviewDone: false,
      modelReviewCandidates: null,
      reviewDisposer: null,
    });
    // 0.2.0: daily review at session start — ONLY for a session
    // already known to be persona (restored from the persisted
    // set, review-9 m-6). At agent/created a fresh session has
    // said no trigger word yet, so it cannot be told apart from a
    // task session: running the review here would write
    // attributes.json / graph.json / review.json / summary-*.jsonl
    // / starmap.html for task agents too, contradicting "task
    // windows read-only" and slowing session start. A brand-new
    // persona session gets its first review on its next open (when
    // it is restored as persona). core.review() is NOT forced — it
    // returns null when the last review was under 24 h ago, and
    // runs decay / promotion / compression / edge backfill +
    // starmap regeneration when due. There is no background
    // service, so this is the only moment review can run. A review
    // failure must NEVER break the session: one warn line, nothing
    // else — the session, the log and recall are all unaffected.
    // 0.3.0: when the code review runs, the daily MODEL review is
    // due too — the flag is picked up on the session's first
    // pre-step, which hands yesterday's messages to the model (as
    // Xia) for her own importance judgment. Same trigger, same
    // timing, no new schedule.
    if (restored) {
      let reviewResult: ReviewResult | null = null;
      try {
        reviewResult = core.review();
      } catch (err) {
        warnOnce(
          "review-failed",
          `每日复盘失败，本次跳过（${err instanceof Error ? err.message : String(err)}），记忆本身不受影响，下次打开 DSH 时再试。`,
        );
      }
      if (reviewResult !== null) {
        const state = sessions.get(id);
        if (state) {
          state.modelReviewDue = true;
          // M-1 (review-12): the review's fragment candidates were
          // computed and then discarded (only a boolean was kept),
          // so the model could never see them. Keep them on the
          // session; the first pre-step hands them to the model with
          // yesterday's messages (buildModelReviewPrompt).
          state.modelReviewCandidates =
            reviewResult.fragmentCandidates ?? [];
        }
      }
    }
  });

  // Per-turn recall + injection (awaited waterfall). Persona windows
  // only; task windows get no recall injection at all.
  ctx.on(
    "agent/pre-step",
    async (ev, next: () => unknown) => {
      const decision = ev as PreStepDecision;
      const userTexts = allUserTexts(decision);
      // No user text in this pre-step: it is not a real turn — do not
      // consume the turn-1 append slot and do not touch recall.
      // NOTE (fix 2026-11-06, 0.1.1): a Cordis waterfall returns the
      // OUTERMOST listener's return value. Calling next() without
      // returning its result makes the whole pre-step decision
      // `undefined`, and DSH's model-selection handler (also prepend,
      // registered later so it runs outer) crashes reading
      // `decision.kind` — "Cannot read properties of undefined
      // (reading 'kind')" on every turn, every window. Every path
      // below must `return next()`.
      if (userTexts.length === 0) {
        if (next) return next();
        return;
      }
      // Session id comes from the pre-step decision's own agent
      // (audit m9): real DSH never provides decision.sessionId.
      const agent = decision.agent;
      const agentCtx = agent?.ctx as
        | { systemPrompt?: SystemPromptRegistry }
        | undefined;
      const sid =
        agent?.id !== undefined &&
        agent?.id !== null &&
        `${agent.id}`.length > 0
          ? `${agent.id}`
          : resolveSessionId(ev as SessionEvent).id;
      const session = getSession(sid);
      currentTurnSessionId = sid;
      session.turns += 1;
      if (userTexts.some((t) => shouldMarkPersona(t, triggerWords))) {
        markPersona(sid);
      }
      if (!session.persona) {
        if (next) return next();
        return;
      }
      // 0.3.0 daily model review: on the first turn after a due
      // code review, hand yesterday's messages to the model. Once
      // per session-open — the flag is set at agent/created (only
      // for a restored persona session) and consumed here, so a
      // fresh session never gets it (m-6) and a later turn never
      // re-registers it. The review context is separate from the
      // recall context below; the model submits via
      // memory_daily_review, which disposes it.
      if (session.modelReviewDue && !session.modelReviewDone) {
        session.modelReviewDone = true;
        registerModelReview(sid, agentCtx);
      }
      // Recall failure degrades to "no injection this turn", never
      // kills the turn (audit M6 — same waterfall mechanics as the
      // 0.1.1 decision.kind crash). 0.2.0: recall gets the session id
      // (recall-link tracking + relationship factor) and the
      // session's recent user texts (attention factor).
      //
      // 0.3.0 restrained mid-turn trigger: turn 1 is the
      // session-start recall and is UNCHANGED. From turn 2 on, recall
      // runs ONLY when the user is explicitly reaching for the past
      // (a memory-cue substring in the message) or the words touch
      // a high-significance memory (significance >= 0.8 in the
      // index). Otherwise nothing is injected this turn and the
      // conversation stays in the present — an ordinary message
      // that merely shares a keyword with a light memory must not
      // drag the past into the turn. When the gate opens, the recall
      // is the same call as turn 1 (same token cap, same valve:
      // top 5, max 2/topic) — no extra number or token cap is added
      // here; the recall selects, and the model decides how many of
      // the injected memories to actually mention. A gate failure
      // degrades to "no injection", never kills the turn.
      const query = userTexts.join("\n");
      let skipRecall = false;
      if (session.turns > 1) {
        const wantsMemory = userTexts.some((t) =>
          hasMemoryCue(t, memoryCueWords),
        );
        let heavyMatch = false;
        if (!wantsMemory) {
          try {
            heavyMatch = core.hasHighSignificanceMatch(query);
          } catch (err) {
            warnOnce(
              "midturn-gate-failed",
              `中途触发判断失败，本轮不注入（${err instanceof Error ? err.message : String(err)}），对话继续。`,
            );
          }
        }
        skipRecall = !wantsMemory && !heavyMatch;
      }
      let result: RecallResult;
      if (skipRecall) {
        result = { hits: [], layer1: null, estimatedTokens: 0, text: "" };
      } else {
        try {
          result = core.recall(query, {
            tokenCap,
            sessionId: sid,
            recentTexts: session.recentUserTexts,
          });
        } catch (err) {
          warnOnce(
            "recall-failed",
            `本轮 recall 失败，不注入（${err instanceof Error ? err.message : String(err)}），对话继续。`,
          );
          result = { hits: [], layer1: null, estimatedTokens: 0, text: "" };
        }
      }
      // Update the recent-texts list AFTER the recall: the current
      // turn's own words must not feed its own attention factor.
      session.recentUserTexts = [...session.recentUserTexts, ...userTexts].slice(-5);
      if (result.hits.length > 0) {
        // Turn 1: append directly — a context registered during
        // pre-step would otherwise not reach the first request.
        // Later turns: the refreshed systemPrompt.context carries it.
        // The append gets a UUID id and array content, like a real
        // DSH message (audit m10): a bare string content with no id
        // is not what DSH commits, and id/sequence-based downstream
        // logic may skip it.
        if (session.turns <= 1) {
          if (!decision.messages) decision.messages = [];
          decision.messages.push({
            id: randomUUID(),
            role: "user",
            content: [{ type: "text", text: result.text }],
            source: { kind: "memory-plugin" },
          });
          for (const h of result.hits) session.appendedIds.add(h.entry.id);
          // Persist the appended ids (0.1.4 minor 1): a rebuilt
          // session must know these hits are already in its history.
          appendedIdsMap.set(sid, session.appendedIds);
          saveAppendedIds(appendedIdsMap);
        }
        // Audit m16: the turn-1 append is committed to session
        // history and stays there, so re-registering the same hits
        // as context would show the model the same memory twice.
        // Only hits NOT covered by the append are registered.
        const freshHits = result.hits.filter(
          (h) => !session.appendedIds.has(h.entry.id),
        );
        refreshRecallContext(
          sid,
          freshHits.length > 0 ? formatRecallBlock(freshHits) : "",
          agentCtx,
        );
      } else {
        refreshRecallContext(sid, "", agentCtx);
      }
      // See the NOTE above: must return next()'s result, not just await it.
      if (next) return next();
    },
    { prepend: true },
  );

  // Capture + flush. Observe-only; nothing here blocks the turn.
  // Real DSH 0.2.1 dispatches session/event as (session, event):
  // the FIRST arg is the session object (with .id), the SECOND is
  // the event ({type, data, seq}); the message lives in event.data.
  // (Found 2026-11-06 in a live headless run: the old single-arg
  // assumption read the session object as if it were the event, so
  // nothing was ever attributed or recorded.) A single-arg call is
  // still tolerated (legacy shape / mock test): then the one arg is
  // the event itself.
  ctx.on("session/event", (subject, eventArg) => {
    const event = ((eventArg ?? subject) as SessionEvent) ?? {};
    const subjectId = (
      eventArg === undefined
        ? undefined
        : (subject as { id?: unknown } | undefined)
    )?.id;
    const type = eventType(event);
    const { id: sid, attributable } = resolveSessionId(event, subjectId);
    const session = getSession(sid);

    if (type === "compaction/start") {
      // Last chance before history is shadowed: persist the index
      // AND take a snapshot (audit M5). A snapshot that never runs
      // is no protection at all.
      try {
        core.flush();
      } catch (err) {
        warnOnce(
          "flush-failed",
          `compaction 前落盘失败（${err instanceof Error ? err.message : String(err)}）。`,
        );
      }
      try {
        core.snapshot();
      } catch (err) {
        warnOnce(
          "snapshot-failed",
          `compaction 前快照失败（${err instanceof Error ? err.message : String(err)}），本次没有留下可恢复的快照。`,
        );
      }
      return;
    }
    if (type === "user/message") {
      // Skip plugin-injected messages (our own recall) and anything
      // that is not a real user message, or injected memory would be
      // re-recorded as if the user said it. When source.kind is
      // MISSING, fall back to the event type itself (it says this is a
      // user message) and warn once instead of silently dropping it.
      const kind = eventSourceKind(event);
      if (kind && kind !== "user") return;
      if (!kind) {
        warnOnce(
          "missing-source-kind",
          "session/event user/message 缺少 source.kind，按事件类型当作真实用户消息处理；请核对真实 DSH 的事件信封。",
        );
      }
      const text = eventText(event);
      if (!text) return;
      // The user/message event is committed when the message arrives,
      // which is BEFORE pre-step runs for that turn — so the persona
      // flag set by pre-step is not visible yet for the very first
      // trigger message. Detect the trigger here too, so turn 1 is
      // recorded. (Same rule as pre-step: the skill's own trigger,
      // gated by the 0.3.1 task blocklist.)
      if (shouldMarkPersona(text, triggerWords)) {
        markPersona(sid);
      }
      if (!session.persona) return;
      // Unattributable events are never recorded, even if they carry
      // the trigger (fail closed — audit issue 3).
      if (!attributable) return;
      try {
        core.record({
          role: "user",
          text,
          window: "persona",
          sessionId: sid,
        });
      } catch (err) {
        // session/event listeners are DSH-wrapped (a throw only
        // warns), but the loss must say WHAT was lost (audit M6).
        warnOnce(
          "record-failed",
          `记录用户消息失败，本条不进 log（${err instanceof Error ? err.message : String(err)}）。`,
        );
      }
      return;
    }
    if (type === "assistant/message") {
      if (!session.persona) return;
      if (!attributable) return;
      const text = eventText(event);
      if (!text) return;
      try {
        core.record({
          role: "assistant",
          text,
          window: "persona",
          sessionId: sid,
        });
      } catch (err) {
        warnOnce(
          "record-failed",
          `记录助手消息失败，本条不进 log（${err instanceof Error ? err.message : String(err)}）。`,
        );
      }
      return;
    }
  });

  // Turn boundary: persist the index. A flush failure must not fail
  // the turn — her reply is already generated (audit M6).
  ctx.on("agent/turn-stopping", () => {
    try {
      core.flush();
    } catch (err) {
      warnOnce(
        "flush-failed",
        `轮次结束落盘失败（${err instanceof Error ? err.message : String(err)}）。`,
      );
    }
  });

  // Unload: endSession() — snapshot + rollover + flush (audit
  // M5/M12). Before 0.1.3 this only flushed, and endSession existed
  // but nothing ever called it, so the snapshot protection never ran.
  ctx.effect(() => {
    return () => {
      try {
        core.endSession();
      } catch (err) {
        console.warn(
          `[memory-plugin] 会话结束快照/落盘失败：${err instanceof Error ? err.message : String(err)}`,
        );
      }
    };
  });

  // Fallback tools for the model to call on its own initiative.
  // Parameters are compiled to real JSON Schema (by the real
  // defineTool when it resolves, otherwise by the local compiler in
  // define-tool.ts) and self-checked after register (audit M2):
  // register() does not validate parameters, so a raw-DSL tool used
  // to register silently with a model-visible schema that had no
  // type/properties/required.
  void loadDefineTool()
    .then((defineTool) => {
      const registerTool = (spec: unknown): void => {
        let compiled: unknown;
        try {
          compiled = defineTool(spec);
        } catch (err) {
          console.warn(
            `[memory-plugin] 工具编译失败，跳过注册：${err instanceof Error ? err.message : String(err)}`,
          );
          return;
        }
        const params = (compiled as { parameters?: unknown } | null)
          ?.parameters;
        if (!isObjectSchema(params)) {
          console.warn(
            `[memory-plugin] 工具 ${(compiled as { name?: unknown } | null)?.name} 的 parameters 不是合法 JSON Schema，跳过注册（模型看不到它）。`,
          );
          return;
        }
        try {
          ctx.tools.register(compiled);
        } catch (err) {
          console.warn(
            `[memory-plugin] 工具 ${(compiled as { name?: unknown } | null)?.name} 注册失败：${err instanceof Error ? err.message : String(err)}`,
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
              `[memory-plugin] 工具 ${(compiled as { name?: unknown } | null)?.name} 注册后自检失败：注册表里的 parameters 不是合法 JSON Schema，模型可能无法正确调用它。`,
            );
          }
        }
      };

      registerTool({
        name: "memory_search",
        description:
          "按关键词搜索本地记忆 (原始对话记录与月度归档细节), 返回相关记忆与当前状态。",
        parameters: {
          query: {
            type: "string",
            required: true,
            description: "要搜索的关键词或句子",
          },
          limit: {
            type: "number",
            required: false,
            description: "最多返回几条, 默认 5",
          },
        },
        output: {
          schema: {
            type: "object",
            properties: {
              layer1: { type: "string" },
              hits: { type: "array" },
            },
          },
          render: (value: unknown) => [
            { type: "text", text: JSON.stringify(value, null, 2) },
          ],
        },
        execute: async (args: unknown) => {
          // Argument validation (audit B2/M2): the local compiler
          // does not validate args the way real defineTool does, so
          // a bad call returns empty instead of throwing or writing
          // garbage. An empty/non-string query never throws (m11).
          const q =
            args &&
            typeof (args as { query?: unknown }).query === "string"
              ? ((args as { query: string }).query as string)
              : "";
          const limit =
            args && typeof (args as { limit?: unknown }).limit === "number"
              ? ((args as { limit: number }).limit as number)
              : 5;
          try {
            const result = core.recall(q, { window: "all", limit });
            return {
              layer1: result.layer1 ? formatLayer1(result.layer1) : "",
              hits: result.hits.map((h) => ({
                // M-1 (review-12): the hit MUST carry the log entry
                // id — memory_fragment's sourceIds come from these
                // hits ("见 memory_search 的 hits"), and without an
                // id the model could never create a fragment from a
                // searched entry. The id is the log's ts-counter-hash.
                id: h.entry.id,
                date: h.entry.date,
                time: h.entry.time,
                role: h.entry.role,
                window: h.entry.window,
                importance: h.entry.importance,
                // 0.3.0: a fragment hit shows the fragment text
                // (with its tone) instead of the full original.
                text: h.displayText ?? h.entry.text,
                fragmentId: h.fragmentId ?? "",
                fragmentTone: h.fragmentTone ?? "",
                fragmentFallback: h.fragmentFallback === true,
              })),
            };
          } catch (err) {
            warnOnce(
              "search-failed",
              `memory_search 失败（${err instanceof Error ? err.message : String(err)}），返回空结果。`,
            );
            return { layer1: "", hits: [] };
          }
        },
      });

      registerTool({
        name: "memory_remember",
        description:
          `把一条值得长期保留的事实、约定或偏好记进本地记忆 (重要)。只在人设窗口可用：任务窗口调用会被拒绝。重要是指符合这些情形的：${MODEL_REVIEW_CATEGORIES.join("、")}。`,
        parameters: {
          text: {
            type: "string",
            required: true,
            description: "要记住的内容",
          },
          importance: {
            type: "string",
            required: false,
            description: "heavy 或 light, 默认 heavy",
          },
          emotion: {
            type: "string",
            required: false,
            description:
              "可选情绪标签，用你自己的词写就行，不限固定列表：比如 “温暖”“委屈”“傲娇”“忐忑”“宠溺”，想打什么心情就打什么心情；可加 :强度（如 “温暖:0.7”，强度 0–1，默认 0.5）。解析失败时当没传，按关键词词表兜底",
          },
        },
        output: {
          schema: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              id: { type: "string" },
              error: { type: "string" },
            },
          },
          render: (value: unknown) => [
            { type: "text", text: JSON.stringify(value) },
          ],
        },
        execute: async (args: unknown, exec?: unknown) => {
          // Argument validation BEFORE any write (audit B2): a call
          // without text used to append a text-less row and then
          // throw — the poisoned row crashed every later load.
          const text =
            args && typeof (args as { text?: unknown }).text === "string"
              ? ((args as { text: string }).text as string)
              : "";
          if (text.trim().length === 0) {
            return {
              ok: false,
              id: "",
              error: "memory_remember 需要一个非空字符串 text。",
            };
          }
          // Persona gate (audit M4): the calling session's OWN id
          // comes from exec.agent.session.id (dsh-tools calls
          // tool.execute(exec.arguments, exec)); the most recent
          // pre-step session is only a fallback when exec carries no
          // agent. A task-window call is refused, not recorded — the
          // v1.6 "task windows never write memory" rule holds on the
          // plugin's own write path too.
          const { sid, persona } = toolSession(exec);
          if (!persona) {
            return {
              ok: false,
              id: "",
              error:
                "memory_remember 只在人设窗口可用：当前会话不是人设窗口（没有触发夏柠柒/柠柒），本次不写记忆。",
            };
          }
          try {
            const entry = core.record({
              role: "user",
              text,
              window: "persona",
              importance:
                args &&
                (args as { importance?: unknown }).importance === "light"
                  ? "light"
                  : "heavy",
              // 0.2.0: model-supplied emotion tag; unparseable means
              // "not passed" — the core's keyword lexicon guesses.
              emotion: parseEmotion(
                (args as { emotion?: unknown } | null)?.emotion,
              ),
              sessionId: sid as string,
            });
            return { ok: true, id: entry.id };
          } catch (err) {
            return {
              ok: false,
              id: "",
              error: `写入失败：${err instanceof Error ? err.message : String(err)}`,
            };
          }
        },
      });

      // 0.3.0: daily model review — the model submits yesterday's
      // important memory ids (from the memory-plugin:daily-review
      // context). The core raises them to significance 0.9 and
      // flags them modelMarked (never compressed). Strict parse:
      // an unparseable output is skipped entirely — no partial
      // apply, no crash — and the review context stays so the
      // model can retry; a parsed result (even empty) disposes it.
      // Gated to persona windows like the other write tools.
      registerTool({
        name: "memory_daily_review",
        description:
          "提交昨日记忆复盘的结果：把你认为值得长期记住的记忆的 id 列表交回来，插件会把它们的重要度提到最高（0.9），以后永不压缩。只在人设窗口可用。id 只能用复盘上下文里给的昨日消息列表里的 id，不要编；没有重要的就传空列表。",
        parameters: {
          ids: {
            type: "array",
            items: { type: "string" },
            required: true,
            description: "昨日消息里你认为重要的记忆 id 列表（从复盘上下文里抄过来，不要编）；没有重要的就传 []",
          },
        },
        output: {
          schema: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              applied: { type: "array" },
              unknown: { type: "array" },
              error: { type: "string" },
            },
          },
          render: (value: unknown) => [
            { type: "text", text: JSON.stringify(value) },
          ],
        },
        execute: async (args: unknown, exec?: unknown) => {
          const { sid, persona } = toolSession(exec);
          if (!persona) {
            return {
              ok: false,
              applied: [],
              unknown: [],
              error:
                "memory_daily_review 只在人设窗口可用：当前会话不是人设窗口，本次不应用复盘结果。",
            };
          }
          const ids = parseModelReviewIds(args);
          if (ids === null) {
            warnOnce(
              "model-review-unparseable",
              "模型复盘结果解析失败，本次跳过（不应用任何条目），请按 id 的 JSON 列表重新提交。",
            );
            return {
              ok: false,
              applied: [],
              unknown: [],
              error: "复盘结果解析失败：请传 id 的 JSON 列表。",
            };
          }
          // Parsed (even empty): the review is done — dispose the
          // context so yesterday's messages leave the prompt.
          if (sid !== null) {
            const state = sessions.get(sid);
            if (state) {
              try {
                state.reviewDisposer?.();
              } catch {
                // Disposer failures must not break the tool call.
              }
              state.reviewDisposer = null;
            }
          }
          try {
            const res = core.applyModelMarks(ids);
            return {
              ok: true,
              applied: res.applied,
              unknown: res.unknown,
              error: "",
            };
          } catch (err) {
            return {
              ok: false,
              applied: [],
              unknown: [],
              error: `应用失败：${err instanceof Error ? err.message : String(err)}`,
            };
          }
        },
      });

      // 0.3.0: create a fragment on top of the verbatim log. The
      // model writes the summary + tone + quotes; the core verifies
      // them against the source entries (key terms + verbatim quotes
      // + tone) and REJECTS the fragment when they do not match —
      // nothing is saved, and the reasons come back so the model can
      // fix it. Gated to persona windows like the other write tools.
      registerTool({
        name: "memory_fragment",
        description:
          "把几条原文提炼成一条短片段（约 10 token），存在 fragments.json 里：以后召回时优先注入片段而不是整段原文，省 token；星空图里片段就是一颗星。片段必须注明来源（sourceIds，必填）、带 1–2 句从原文逐字抄来的引用（quotes，必填），语气（tone）用你自己的词写就行，不限固定列表（比如 “很喜欢”“嘴上嫌弃心里喜欢”“有点喜欢但不太确定”，可加 :强度如 很喜欢:0.9）。插件会用代码逐字核对：正文关键词、引用、语气都必须和来源对得上，对不上就拒绝保存并告诉你原因——不要编来源里没有的词，不要改写引用，不要把语气写得比来源更重。",
        parameters: {
          sourceIds: {
            type: "array",
            items: { type: "string" },
            required: true,
            description: "来源原文的条目 id 列表（必填，至少 1 条，见 memory_search 的 hits 或星空图）",
          },
          text: {
            type: "string",
            required: true,
            description: "片段正文，一句短总结，约 10 token（关键词必须用来源原文里的词）",
          },
          tone: {
            type: "string",
            required: true,
            description: "对这个话题的态度，用你自己的词写，不限固定列表（如 很喜欢 / 嘴上嫌弃心里喜欢 / 有点喜欢但不太确定；可加 :强度，如 很喜欢:0.9）",
          },
          quotes: {
            type: "array",
            items: { type: "string" },
            required: true,
            description: "1–2 句从来源原文逐字抄来的短语（必填，不能改写），用来保住原文的语气",
          },
          topic: {
            type: "string",
            required: false,
            description: "话题词，如 酸梅汤；不填时从正文里取",
          },
          keywords: {
            type: "array",
            items: { type: "string" },
            required: false,
            description: "关键词列表；不填时从正文里取",
          },
        },
        output: {
          schema: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              id: { type: "string" },
              error: { type: "string" },
              reasons: { type: "array" },
            },
          },
          render: (value: unknown) => [
            { type: "text", text: JSON.stringify(value) },
          ],
        },
        execute: async (args: unknown, exec?: unknown) => {
          const { persona } = toolSession(exec);
          if (!persona) {
            return {
              ok: false,
              id: "",
              error:
                "memory_fragment 只在人设窗口可用：当前会话不是人设窗口（没有触发夏柠柒/柠柒），本次不写记忆。",
            };
          }
          const a = (args ?? {}) as {
            sourceIds?: unknown;
            text?: unknown;
            tone?: unknown;
            quotes?: unknown;
            topic?: unknown;
            keywords?: unknown;
          };
          const sourceIds = Array.isArray(a.sourceIds)
            ? a.sourceIds.filter((x): x is string => typeof x === "string")
            : [];
          const text = typeof a.text === "string" ? a.text : "";
          const tone = typeof a.tone === "string" ? a.tone : "";
          const quotes = Array.isArray(a.quotes)
            ? a.quotes.filter((x): x is string => typeof x === "string")
            : [];
          const topic = typeof a.topic === "string" ? a.topic : undefined;
          const keywords = Array.isArray(a.keywords)
            ? a.keywords.filter((x): x is string => typeof x === "string")
            : undefined;
          try {
            const result = core.createFragment({
              sourceIds,
              text,
              tone,
              quotes,
              topic,
              keywords,
            });
            if (!result.ok || !result.fragment) {
              return {
                ok: false,
                id: "",
                error: "片段被拒绝，未保存。",
                reasons: result.reasons,
              };
            }
            return { ok: true, id: result.fragment.id };
          } catch (err) {
            return {
              ok: false,
              id: "",
              error: `写入失败：${err instanceof Error ? err.message : String(err)}`,
            };
          }
        },
      });

      registerTool({
        name: "memory_snapshot",
        description:
          "立即对插件自己的记忆文件 (log + 索引) 做一次快照，可用于事后恢复。快照不覆盖 MEMORY.md、月度归档或日记。",
        parameters: {},
        output: {
          schema: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              snapshot: { type: "string" },
              error: { type: "string" },
            },
          },
          render: (value: unknown) => [
            { type: "text", text: JSON.stringify(value) },
          ],
        },
        execute: async () => {
          try {
            return { ok: true, snapshot: core.snapshot() };
          } catch (err) {
            return {
              ok: false,
              error: `快照失败：${err instanceof Error ? err.message : String(err)}`,
            };
          }
        },
      });

      registerTool({
        name: "memory_restore",
        description:
          "把插件自己的记忆文件 (log + 索引) 恢复到指定快照。恢复前先对当前状态做安全快照，可再恢复回来。MEMORY.md、月度归档与日记不受影响。",
        parameters: {
          name: {
            type: "string",
            required: true,
            description: "快照名 (见 memory_status 的 snapshots 列表)",
          },
        },
        output: {
          schema: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              safety: { type: "string" },
              error: { type: "string" },
            },
          },
          render: (value: unknown) => [
            { type: "text", text: JSON.stringify(value) },
          ],
        },
        execute: async (args: unknown) => {
          const snapshotName =
            args && typeof (args as { name?: unknown }).name === "string"
              ? ((args as { name: string }).name as string)
              : "";
          if (snapshotName.trim().length === 0) {
            return {
              ok: false,
              error: "memory_restore 需要一个非空字符串 name。",
            };
          }
          // 0.1.4 minor 3: the name is a directory name, never a
          // path — reject traversal here (core.restore validates
          // again) so a crafted name never reaches the filesystem.
          if (
            snapshotName.includes("/") ||
            snapshotName.includes("\\") ||
            snapshotName.includes("..")
          ) {
            return {
              ok: false,
              error: "memory_restore 的 name 只能是快照目录名，不能含 /、\\ 或 ..。",
            };
          }
          try {
            const safety = core.restore(snapshotName);
            // 0.1.4 minor 4: the restore reverted
            // persona-sessions.json (and appended-ids.json) to
            // snapshot time — reload the in-shell copies, or the
            // next markPersona would write the stale set back to
            // disk and silently undo the restore.
            reloadPersonaState();
            return { ok: true, safety };
          } catch (err) {
            return {
              ok: false,
              error: `恢复失败：${err instanceof Error ? err.message : String(err)}`,
            };
          }
        },
      });

      registerTool({
        name: "memory_status",
        description:
          "返回本地记忆的统计：总条数、最近 30 天条数、归档月份、索引词数、快照列表、图边数、属性条数、上次复盘时间（0.2.0）、片段数与存疑片段数（0.3.0）。",
        parameters: {},
        output: {
          schema: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              totalEntries: { type: "number" },
              layer2Count: { type: "number" },
              archiveMonths: { type: "array" },
              indexTokens: { type: "number" },
              snapshots: { type: "array" },
              graphEdges: { type: "number" },
              attributes: { type: "number" },
              lastReviewAt: { type: "number" },
              fragments: { type: "number" },
              suspectFragments: { type: "number" },
              error: { type: "string" },
            },
          },
          render: (value: unknown) => [
            { type: "text", text: JSON.stringify(value, null, 2) },
          ],
        },
        execute: async () => {
          try {
            return { ok: true, ...core.stats() };
          } catch (err) {
            return {
              ok: false,
              error: `读取失败：${err instanceof Error ? err.message : String(err)}`,
            };
          }
        },
      });

      // 0.3.1 拾光: regenerate the starmap (拾光星海) on demand. The
      // HTML is a derived artifact — generated from the current
      // graph + attributes + log, local only, excluded from
      // snapshots, and also regenerated automatically after every
      // daily review. Gated to persona windows like the other write
      // tools: a task window must not trigger a write into the data
      // dir.
      registerTool({
        name: "memory_starmap",
        description:
          "重新生成拾光星海（starmap.html，本地 HTML：记忆是星星，点星看详情，共享关键词的星连成星座）。只在人设窗口可用：任务窗口调用会被拒绝。",
        parameters: {},
        output: {
          schema: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              path: { type: "string" },
              nodes: { type: "number" },
              edges: { type: "number" },
              generatedAt: { type: "number" },
              error: { type: "string" },
            },
          },
          render: (value: unknown) => [
            { type: "text", text: JSON.stringify(value, null, 2) },
          ],
        },
        execute: async (_args: unknown, exec?: unknown) => {
          const { persona } = toolSession(exec);
          if (!persona) {
            return {
              ok: false,
              error:
                "memory_starmap 只在人设窗口可用：当前会话不是人设窗口（没有触发夏柠柒/柠柒），本次不生成星空图。",
            };
          }
          try {
            const r = core.generateStarmap();
            return {
              ok: true,
              path: r.path,
              nodes: r.nodes,
              edges: r.edges,
              generatedAt: r.generatedAt,
            };
          } catch (err) {
            return {
              ok: false,
              error: `生成失败：${err instanceof Error ? err.message : String(err)}`,
            };
          }
        },
      });
    })
    .catch((err: unknown) => {
      // Tool registration must never break the plugin load, but a
      // failure must not be silent either: without the fallback tools
      // the model loses memory_search / memory_remember.
      console.warn(
        "[memory-plugin] fallback 工具注册失败 (工具不可用，记与召回本身不受影响):",
        err,
      );
    });
}
