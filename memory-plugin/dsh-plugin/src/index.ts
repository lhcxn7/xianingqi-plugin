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
//   model). memory_invalidate (0.4.0 item 1) marks entries invalid
//   from now and appends one audit line per call to
//   invalidation-audit.jsonl (who / when / why); it never touches
//   log.jsonl. memory_belief (0.4.0 item 2, 9th tool) reads/writes
//   the evidence-backed belief layer (get / create / support /
//   contradict); every quote is verified verbatim against the log,
//   deltas are model-supplied and clamped to ±0.2, and one
//   contradicting entry deducts only once. memory_reflect (0.4.0
//   item 3, 10th tool) is the reflection gate: with {} it checks
//   the tiny anti-disturbance floor and hands the model the
//   reflection prompt when due (the model decides whether to
//   reflect); with {text, sourceIds} it saves the conclusion as a
//   type: "reflection" fragment, after verifying every 「」 quote
//   verbatim — a fabricated quote voids the whole reflection.
//   memory_proact (0.4.0 item 7, 12th tool) is the behaviour loop:
//   with {} it checks the hard guardrails first (one action a day,
//   no repeat of a trigger within 7 days) and hands the model the
//   proactivity prompt when due, together with a 15-minute prompt
//   token (the model decides whether to act, why, and what to
//   say); with a decision ({act, judgment, actionText, trigger,
//   promptToken}) it re-checks the guardrails — the token must
//   match the issued prompt and the trigger must be one of that
//   prompt's source ids — and stores the action in loop.json,
//   returning {action} for her to say in the chat in her own
//   words. Issuing the prompt writes no lastJudgedAt and consumes
//   no daily quota; act:false stores nothing and voids the token.
//   channel is "session" only — "qq" returns qq_not_connected
//   (QQ is not wired up).
//   memory_profile (0.4.1 item 1, 13th tool) reads/writes the
//   standing profile in profile.json (name/stage/relationshipStage),
//   persona windows only, at least one field to update; it never
//   touches MEMORY.md, log.jsonl or the keyword index, and the
//   profile only ever rides along with a recall that has hits —
//   a no-hit turn injects nothing, profile or not.
//   memory_feedback (0.5.0 step 4, 14th tool) takes the user's
//   verdict on a recalled memory — correct / wrong / irrelevant.
//   Wrong invalidates the entry (same path as memory_invalidate,
//   with an audit line); irrelevant demotes it in later recall;
//   correct counts as a verification. Tool only, no UI; its
//   description is deferred (deferLoading) so it costs nothing
//   on rounds where it is not used.
//   memory_remember takes an optional emotion ("温暖" or
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
import { appendFileSync, closeSync, existsSync, fsyncSync, openSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  MemoryCore,
  MODEL_REVIEW_CATEGORIES,
  MODEL_REVIEW_MAX_CHARS,
  MODEL_REVIEW_MAX_ENTRIES,
  PROFILE_CATEGORIES,
  RECENT_MAX_CHARS,
  RECENT_MAX_ENTRIES,
  SOURCE_TYPE_CN,
  atomicWriteText,
  buildModelReviewPrompt,
  deliver,
  entryProvenance,
  composeInjection,
  formatLayer1,
  formatProfileBlock,
  parseModelReviewIds,
  parseProactDecision,
  selectCappedEntries,
} from "../core/src/index.ts";
import type {
  BeliefCandidate,
  FragmentCandidate,
  MemoryEntry,
  PersonaProfile,
  ProfileCategory,
  ProfileItem,
  RecallHit,
  RecallResult,
  ReviewResult,
} from "../core/src/index.ts";
import { isObjectSchema, loadDefineTool } from "./define-tool.ts";
import {
  DEFAULT_DECLARATION_PHRASES,
  classifyAssistantReply,
  classifyContent,
  matchDeclaration,
  parsePersonaSessions,
  serializePersonaSessions,
} from "./window.ts";
import type { EntryKind, SessionMode } from "./window.ts";
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

/** 0.4.5 (0.4.3 audit item 4): how many pre-step turns the
 *  daily-review context may live without a submission. The model
 *  submits via memory_daily_review (which disposes on success);
 *  this is the backstop — after this many turns the shell disposes
 *  it itself, so a chatty day cannot pin ten thousand words into
 *  every request indefinitely. Counted in pre-step turns since
 *  registration (the registration turn is turn 0): the model sees
 *  the context on 3 turns, then it is gone. */
export const MODEL_REVIEW_AUTO_RELEASE_TURNS = 3;

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

/** 0.5.0 step 2: the blocklist is split in two — the old single
 *  list is kept as the union (TASK_BLOCKLIST) so hasTaskBlocklistWord
 *  and old callers behave exactly as before.
 *
 *  - TASK_TECHNICAL_WORDS: almost never spoken in a persona chat
 *    (GitHub / SKILL.md / 插件 / 代码 …). One of these alone blocks
 *    marking, as before.
 *  - TASK_ACTION_WORDS: ordinary verbs that also show up in chat
 *    (同步 / 更新 / 测试 / 创建 / 版本 …). One of these alone must
 *    NOT block — "夏柠柒，我想和你同步一下近况" is a greeting,
 *    not a task. An action word blocks only when the message is
 *    task-shaped as well: an imperative marker (帮我 / 请 / 把 …)
 *    or a bare task phrase (nothing chatty left after stripping
 *    the trigger + the action words, e.g. "夏柠柒，恢复测试").
 *    Greeting/question words (在吗 / 回来了 / 聊天 …) always save
 *    the message from the bare-phrase rule.
 *
 *  The split fixes the measured 0.4.8 gap: 6 opening lines, 4 not
 *  marked (同步 / 测试 / 创建 / 更新). The one-way latch and the
 *  complete log are untouched: the list only gates marking, never
 *  un-marks a session and never filters a recorded message. */
export const TASK_TECHNICAL_WORDS: string[] = [
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
  "skill",
  "插件",
];

export const TASK_ACTION_WORDS: string[] = [
  // Task-action words — the verbs of task instructions, but also
  // ordinary chat words (同步近况 / 更新近况 / 测试一下你在不在
  // / 创建了新习惯 / 你是什么版本). Only task-shaped use blocks.
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

/** 0.5.0 step 2: imperative markers — when one of these stands
 *  next to a task-action word, the message is an instruction
 *  ("帮我更新一下你的记忆"), not chat. Checked only together
 *  with an action word, so "我把饭吃完了" (no action word) is
 *  unaffected. */
export const TASK_IMPERATIVE_MARKERS: string[] = [
  "帮我",
  "请你",
  "请",
  "把",
  "给",
  "替我",
  "替",
  "让",
  "需要你",
  "麻烦",
  "帮",
  "你来",
];

/** 0.5.0 fix: memory objects — an action word next to one of
 *  these is a task even when the bare-phrase threshold misses it
 *  ("更新一下记忆" leaves "一下记忆", length 4 > 2). Chatty context
 *  words save the message ("更新一下记忆，我想你" is still chat). */
export const TASK_MEMORY_OBJECT_WORDS: string[] = [
  "记忆",
  "日志",
  "聊天记录",
  "条目",
  "记忆文件",
];

/** 0.5.0 fix: chatty context that saves an action-word +
 *  memory-object message from being treated as a task. */
export const TASK_MEMORY_CHAT_WORDS: string[] = [
  "心情",
  "近况",
  "习惯",
  "想你",
  "在吗",
  "在么",
  "在不在",
  "好吗",
  "你好",
];

/** 0.5.0 step 2: greeting / question words that save a message
 *  from the bare-task-phrase rule — "测试一下，你在吗" is a
 *  greeting that happens to contain 测试. */
export const PERSONA_GREETING_WORDS: string[] = [
  "在吗",
  "在么",
  "在不在",
  "在不",
  "好吗",
  "你好",
  "想你",
  "回来了",
  "在干嘛",
  "干嘛呢",
  "聊天",
  "说话",
];

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
 *  daily review). Substring match, same as the trigger itself.
 *  0.5.0: this is the UNION of the two split lists above — the
 *  raw "contains any blocklist word" check (hasTaskBlocklistWord)
 *  is unchanged; the marking gate (shouldMarkPersona) refines it. */
export const TASK_BLOCKLIST: string[] = [
  ...TASK_TECHNICAL_WORDS,
  ...TASK_ACTION_WORDS,
];

/** 0.3.1: true when the text contains any task-blocklist word. */
export function hasTaskBlocklistWord(
  text: string,
  blocklist: string[] = TASK_BLOCKLIST,
): boolean {
  return blocklist.some((w) => w.length > 0 && text.includes(w));
}

/** 0.5.0 step 2: true when the text contains a technical
 *  blocklist word (one of these alone blocks marking). */
export function hasTaskTechnicalWord(
  text: string,
  technical: string[] = TASK_TECHNICAL_WORDS,
): boolean {
  return technical.some((w) => w.length > 0 && text.includes(w));
}

/** 0.5.0 step 2: true when the text contains a task-action word
 *  (one of these alone does NOT block marking — see
 *  shouldMarkPersona). */
export function hasTaskActionWord(
  text: string,
  actionWords: string[] = TASK_ACTION_WORDS,
): boolean {
  return actionWords.some((w) => w.length > 0 && text.includes(w));
}

/** 0.5.0 step 2: true when the message is (nearly) just the
 *  trigger + task-action words and nothing chatty — e.g.
 *  "夏柠柒，恢复测试" or "夏柠柒，更新一下". Strip the trigger
 *  words, the action words and all punctuation/space; what is
 *  left must be at most 2 chars, and the message must carry no
 *  greeting/question word. A longer remainder ("我想和你同步
 *  一下近况") or a greeting ("测试一下，你在吗") is chat, not a
 *  bare task phrase. */
export function isBareTaskPhrase(
  text: string,
  triggerWords: string[] = DEFAULT_TRIGGER_WORDS,
  actionWords: string[] = TASK_ACTION_WORDS,
): boolean {
  let stripped = text;
  for (const w of [...triggerWords, ...actionWords]) {
    if (w.length > 0) stripped = stripped.split(w).join("");
  }
  stripped = stripped.replace(/[\s\p{P}\p{S}]/gu, "");
  if (stripped.length > 2) return false;
  return !PERSONA_GREETING_WORDS.some((g) => text.includes(g));
}

/** 0.3.1: the persona-marking gate — true when the user message
 *  carries the trigger AND no task-blocklist word. A task
 *  instruction that mentions her name ("帮我把夏柠柒的 skill
 *  更新一下") does not mark the session; a plain address
 *  ("夏柠柒，在吗") does.
 *  0.5.0 step 2: refined — a technical word still blocks on its
 *  own, but a task-action word blocks only when the message is
 *  task-shaped (imperative marker, or a bare task phrase).
 *  Ordinary chat use of an action word ("同步一下近况" /
 *  "测试一下，你在吗" / "创建了一个新习惯" / "更新一下我的近况")
 *  now marks. A caller passing a custom blocklist (anything but
 *  the default union) gets the old rule: any hit blocks. */
export function shouldMarkPersona(
  text: string,
  triggerWords: string[] = DEFAULT_TRIGGER_WORDS,
  blocklist: string[] = TASK_BLOCKLIST,
  actionWords: string[] = TASK_ACTION_WORDS,
): boolean {
  if (!isPersonaTrigger(text, triggerWords)) return false;
  if (blocklist !== TASK_BLOCKLIST) {
    return !hasTaskBlocklistWord(text, blocklist);
  }
  if (hasTaskTechnicalWord(text)) return false;
  if (!hasTaskActionWord(text, actionWords)) return true;
  // 0.5.0 fix (P0): action word + memory object = task, unless the
  // message also carries chatty context. This catches
  // "更新一下记忆 / 删除这条记忆 / 同步一下记忆", which the ≤2-char
  // bare-phrase rule missed (they leave 4 chars after stripping).
  if (
    TASK_MEMORY_OBJECT_WORDS.some((w) => text.includes(w)) &&
    !TASK_MEMORY_CHAT_WORDS.some((w) => text.includes(w))
  ) {
    return false;
  }
  // "让" is imperative in "让我更新一下", but narrative in
  // "你让我更新一下心情" — the narrator is not giving an order.
  const narrativeLet = /(你|他|她|它)让我/.test(text);
  if (
    !narrativeLet &&
    TASK_IMPERATIVE_MARKERS.some((m) => text.includes(m))
  ) {
    return false;
  }
  if (isBareTaskPhrase(text, triggerWords, actionWords)) return false;
  return true;
}

/** 0.5.0 step 5: run the host-injected query rewriter with a
 *  timeout. Returns the rewritten query, or null when there is no
 *  rewriter, it returns nothing usable, it throws, or it times
 *  out — every failure mode falls back to the original query,
 *  keyword-only, and never blocks the turn. An unchanged rewrite
 *  (same text back) is also null: there is nothing to add. The
 *  losing promise is left to finish on its own (it cannot be
 *  cancelled); only its result is ignored. */
export async function rewriteQuery(
  query: string,
  rewriter:
    | ((query: string) => Promise<string | null | undefined>)
    | undefined,
  timeoutMs: number = 3000,
): Promise<string | null> {
  if (!rewriter) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const raced = await Promise.race([
      rewriter(query),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
    if (typeof raced !== "string") return null;
    const trimmed = raced.trim();
    if (!trimmed || trimmed === query.trim()) return null;
    return trimmed;
  } catch {
    return null;
  } finally {
    // 0.5.0 fix: the timeout arm must not keep the event loop alive
    // for 3 s after a fast rewriter returned.
    if (timer !== undefined) clearTimeout(timer);
  }
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

/** 终版 WP4: accept epoch-ms or an ISO date string for validFrom /
 *  observedAt. An unparseable value means "not passed". */
function parseTimeArg(raw: unknown): number | undefined {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw !== "string") return undefined;
  const s = raw.trim();
  if (!s) return undefined;
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    return Number.isFinite(n) ? n : undefined;
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? undefined : t;
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
  /** 终版 WP1: the session's current mode. persona = memory tools and
   *  injection allowed; task = nothing is recorded or injected. */
  mode: SessionMode;
  /** True when the mode came from an explicit declaration. A declared
   *  task session is NOT flipped back to persona by a later trigger
   *  word — only another declaration changes it. */
  modeLocked: boolean;
  /** 终版 WP1: the kind of the current turn's user message. The
   *  assistant reply follows it (see classifyAssistantReply). */
  lastKind: EntryKind | null;
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
  /** 0.6.0 (人味改造): impression ids already injected into this
   *  session. An impression is a standing judgement, not a new
   *  fact — repeating it every turn reads like nagging, so a
   *  session shows each one at most once. In-memory only; a
   *  rebuilt session may show it again (it is a new conversation
   *  and the judgement is still live). */
  injectedImpressionIds: Set<string>;
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
  /** 0.4.0 item 2: belief candidates from the same code review —
   *  entry clusters that may support a belief about the
   *  relationship. Same handling as the fragment candidates: handed
   *  to the model with yesterday's messages on the first pre-step,
   *  then cleared. The review only proposes; the model confirms via
   *  memory_belief. In-memory only. */
  modelReviewBeliefCandidates: BeliefCandidate[] | null;
  /** 0.4.0 item 3: reflection prompt from the same code review —
   *  present only when the last 24 h of new memories cleared the
   *  anti-disturbance floor. Handed to the model with yesterday's
   *  messages on the first pre-step, then cleared. The review only
   *  proposes; the model decides whether to reflect and saves via
   *  memory_reflect. In-memory only. */
  modelReviewReflectionPrompt: string | null;
  /** 0.4.4: proactivity prompt from the same code review — present
   *  only when the review built one (non-empty day). Same handling
   *  as the reflection prompt: handed to the model with yesterday's
   *  messages on the first pre-step, then cleared. The review only
   *  proposes; the model decides whether to act and submits via
   *  memory_proact (the token comes from a fresh gate call, not
   *  from this prompt — see buildModelReviewPrompt). In-memory
   *  only. */
  modelReviewProactPrompt: string | null;
  /** 0.4.4: invalidation-check entry ids from the same code review
   *  — old memories a later entry may contradict. Resolved to
   *  entries at the first pre-step (the prompt needs their text,
   *  not just ids) and handed to the model with yesterday's
   *  messages, then cleared. The review only proposes; the model
   *  confirms via memory_invalidate. In-memory only. */
  modelReviewInvalidationIds: string[] | null;
  /** 0.4.6 (0.4.5 audit new issue 1): the entry ids behind the
   *  ONE merged recent section (reflection entries ∪ proact
   *  memories, deduped) from the same code review. Resolved to
   *  entries at the first pre-step and handed to the model with
   *  yesterday's messages, then cleared. The merged section
   *  replaces the two pasted prompts (reflection + proact) — each
   *  used to list all 24 h of memories verbatim (~37k characters
   *  each on a chatty day). In-memory only. */
  modelReviewRecentEntryIds: string[] | null;
  /** 0.4.6: which halves the merged recent section carries —
   *  reflection and/or proactivity — from the same code review.
   *  Same handling as the ids above, then cleared. In-memory
   *  only. */
  modelReviewRecentKinds: { reflection: boolean; proact: boolean } | null;
  /** Disposer for the daily-review dynamic context (per-session,
   *  like the recall disposer). Cleared when the model submits
   *  the review (memory_daily_review) or the session rebuilds. */
  reviewDisposer: (() => void) | null;
  /** 0.4.5 (0.4.3 audit item 4): the pre-step turn on which the
   *  daily-review context was registered (null when no review
   *  context is live). The context auto-releases after
   *  MODEL_REVIEW_AUTO_RELEASE_TURNS turns without a submission —
   *  the backstop for a model that never calls
   *  memory_daily_review. */
  modelReviewRegisteredTurn: number | null;
  /** 0.5.1 (0.4.3 §四): the ids the live review prompt actually
   *  showed (yesterday's capped list + candidate sourceIds +
   *  belief-candidate sourceIds + merged-recent ids +
   *  invalidation ids, in that order, capped at
   *  MODEL_REVIEW_MAX_ENTRIES) — the whitelist
   *  memory_daily_review checks submitted ids against. An id
   *  outside it lands in `unknown`, never applied. Null when no
   *  review context is live (a cold call falls back to
   *  yesterday's ids). Cleared on submit and on auto-release.
   *  In-memory only. */
  modelReviewAllowedIds: string[] | null;
}

// Persona-session ids, persisted in the data dir so a rebuilt session
// (agent/created re-fires) keeps its persona flag across DSH restarts
// (audit M7). Plugin-owned file, covered by snapshots.
const PERSONA_FILE = "persona-sessions.json";

// 终版 WP1: append-only audit of explicit mode switches (who declared
// what, when, and which session). Never snapshot-owned: a restore must
// not rewind the record of a declaration.
const WINDOW_AUDIT_FILE = "window-audit.jsonl";

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

// 0.4.0 item 1: append-only audit log for memory_invalidate — one
// JSON line per (persona-window) call: who (calling session id),
// when, which entries, why. A separate file on purpose: log.jsonl
// is the verbatim conversation and must never carry tool metadata
// (it would poison fragment verification and recall), and the audit
// is deliberately NOT in the snapshot allowlist — a restore reverts
// memory, never the record of who invalidated what.
export const INVALIDATION_AUDIT_FILE = "invalidation-audit.jsonl";

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
  // 终版 WP5: soft-guidance candidate count (clamped in the core).
  const valveTop = config?.valveTop ?? 8;
  const triggerWords = config?.triggerWords ?? DEFAULT_TRIGGER_WORDS;
  const declarationPhrases =
    config?.declarationPhrases ?? DEFAULT_DECLARATION_PHRASES;
  const assistantPersonaMaxChars = config?.assistantPersonaMaxChars ?? 800;
  const memoryCueWords =
    config?.memoryCueWords ?? DEFAULT_MEMORY_CUE_WORDS;

  // 2026-11-12 工作区隔离：记忆插件原本没有任何工作区概念，任务窗口里提一句
  // 「夏柠柒」就会把整个会话标成 persona 并开始记录（实测把默认工作区的
  // 81 条技术讨论记进了人设记忆）。这里加一层：只有 cwd 落在人设工作区
  // （含子目录）里的会话，才允许被触发词标成 persona、才记录消息。
  // 未配置 personaWorkspace 时保持旧行为，不改变其他部署。
  // 0.5.6: the env var is the fallback for installs that cannot edit the
  // plugin patch (single-workdir personas need this whitelist to exist,
  // or a task window that merely says her name starts recording again).
  // config.personaWorkspace wins over the env var.
  const personaWorkspace = String(
    config?.personaWorkspace ??
      process.env.MEMORY_PLUGIN_PERSONA_WORKSPACE ??
      "",
  ).trim();
  const normalizePath = (p: string): string =>
    p.replace(/[\\/]+/g, "\\").replace(/\\+$/, "").toLowerCase();
  const inPersonaWorkspace = (cwd: unknown): boolean => {
    if (!personaWorkspace) return true;
    const raw = typeof cwd === "string" ? cwd.trim() : "";
    if (!raw) return false;
    const cur = normalizePath(raw);
    const root = normalizePath(personaWorkspace);
    return cur === root || cur.startsWith(`${root}\\`);
  };
  const cwdOf = (agentOrSession: unknown): string | null => {
    const anyObj = agentOrSession as
      | { session?: { header?: { cwd?: string } }; header?: { cwd?: string }; cwd?: string }
      | null
      | undefined;
    return anyObj?.session?.header?.cwd ?? anyObj?.header?.cwd ?? anyObj?.cwd ?? null;
  };
  // 0.5.0 step 5: host-injected query rewriter (model call lives
  // with the host) + its per-turn timeout. Absent = keyword-only.
  const queryRewriter = config?.queryRewriter;
  const rewriteTimeoutMs = config?.rewriteTimeoutMs ?? 3000;
  // 0.5.1 item 2: local embedding config (default off — see
  // MemoryPluginConfig.semanticRecall).
  const semanticRecall = config?.semanticRecall;

  // 终版 WP0: one dataDir, one source of truth. Two explicit sources
  // (config + env) that disagree is a configuration error, not a
  // preference: enter read-only mode rather than write half the
  // memory into one folder and half into another. A stray MEMORY.md
  // in another candidate is a warning (first installs legitimately
  // have no MEMORY.md in the new dataDir yet).
  const defaultDataDir = join(homedir(), ".dsh", "xia-ningqi-data");
  const configuredDir =
    typeof config?.dataDir === "string" && config.dataDir.trim().length > 0
      ? config.dataDir
      : null;
  const envDir = process.env.MEMORY_PLUGIN_DATA_DIR?.trim() || null;
  const samePath = (a: string, b: string): boolean =>
    resolve(a) === resolve(b);
  const explicitConflict =
    configuredDir !== null &&
    envDir !== null &&
    !samePath(configuredDir, envDir);
  const memoryFilePresent = existsSync(join(dataDir, "MEMORY.md"));
  const secondMemoryFiles = [configuredDir, envDir, defaultDataDir]
    .filter((p): p is string => typeof p === "string" && p.length > 0)
    .filter(
      (p, i, arr) =>
        arr.findIndex((x) => samePath(x, p)) === i && !samePath(p, dataDir),
    )
    .filter((p) => existsSync(join(p, "MEMORY.md")));
  const dataDirWarning = explicitConflict
    ? `数据目录来源冲突：config.dataDir=${configuredDir ?? ""}，MEMORY_PLUGIN_DATA_DIR=${envDir ?? ""}；已进入只读模式（聊天不受影响，写入全部拒绝）。`
    : secondMemoryFiles.length > 0
      ? `发现另一份 MEMORY.md：${secondMemoryFiles.join("、")}；当前 dataDir=${dataDir}${memoryFilePresent ? "" : "（这里没有 MEMORY.md）"}。可能分家了。`
      : "";
  const writeBlocked = explicitConflict;
  const writeBlockedMessage = dataDirWarning
    ? `记忆写入已被拒绝：${dataDirWarning}`
    : "记忆写入已被拒绝：数据目录未对齐。";
  // 终版 WP0: every model-facing write tool is refused in read-only
  // mode. Reads (memory_search / memory_status) keep working, so the
  // problem is visible instead of silent.
  const WRITE_TOOLS = new Set<string>([
    "memory_profile",
    "memory_remember",
    "memory_daily_review",
    "memory_fragment",
    "memory_snapshot",
    "memory_restore",
    "memory_starmap",
    "memory_invalidate",
    "memory_belief",
    "memory_reflect",
    "memory_proact",
    "memory_feedback",
    "memory_forget",
    "memory_goal",
    "memory_experience",
  ]);
  if (dataDirWarning) {
    console.warn(`[memory-plugin] ${dataDirWarning}`);
  }

  // Warn once per distinct problem (not on every event).
  const warned = new Set<string>();

  // 0.5.0 step 4: names of the tools that actually registered, in
  // order — memory_status reports the count (17 once
  // memory_forget / memory_goal / memory_experience are in). Read at call time: tools register
  // async, so an early status call may legitimately see fewer.
  const registeredToolNames: string[] = [];
  const warnOnce = (key: string, message: string): void => {
    if (warned.has(key)) return;
    warned.add(key);
    console.warn(`[memory-plugin] ${message}`);
  };

  /** 终版 WP5: when the token cap trims candidates, leave a trace the
   *  model/user can inspect. Ids and a query prefix only — never the
   *  dropped text. */
  const logRecallDropped = (
    sid: string,
    query: string,
    dropped: RecallHit[],
  ): void => {
    if (dropped.length === 0) return;
    try {
      appendFileSync(
        join(dataDir, "recall-dropped.jsonl"),
        `${JSON.stringify({
          ts: Date.now(),
          sessionId: sid,
          query: query.slice(0, 80),
          ids: dropped.map((h) => h.entry.id),
          reasons: dropped.map((h) => (h.viaGraph ? "graph" : "keyword")),
        })}\n`,
        { encoding: "utf8" },
      );
    } catch {
      // A logging failure must never break the turn.
    }
  };

  // Audit M3: a failing core must fail LOUDLY, naming the dataDir and
  // the cause — never silently half-load. (Cordis only logs a fiber
  // error when apply() throws, so the message has to carry the
  // diagnosis itself.) No silent fallback to the default directory:
  // recording into the wrong folder would split her memory in two.
  let core: MemoryCore;
  try {
    core = new MemoryCore({ dataDir, semanticRecall });
  } catch (err) {
    console.warn(
      `[memory-plugin] 记忆插件加载失败：打不开数据目录 ${dataDir}（${err instanceof Error ? err.message : String(err)}）。插件未加载，DSH 本身不受影响；请检查 dataDir 路径、盘符与权限后再重启 DSH。`,
    );
    throw err;
  }

  // 0.5.1 item 2: when semantic recall is enabled, build the
  // index once in the background — never blocks activation. A
  // missing model or a failed build just leaves keyword-only
  // (the per-turn adapter below also degrades silently).
  if (core.semanticEnabled()) {
    void core
      .ensureSemanticIndex()
      .then(() => core.warmSemantic())
      .catch((err: unknown) => {
        warnOnce(
          "semantic-index-failed",
          `语义索引构建失败，本轮起只用关键词召回（${err instanceof Error ? err.message : String(err)}）。检查模型目录 ${core.semanticModelDir()} 是否已放入包里的 models/bge-small-zh-v1.5/。`,
        );
      });
  }

  /** 0.5.1 item 2: the sync semantic slot for one recall turn.
   *  Awaits the (async) semantic search with the core's timeout;
   *  any failure returns undefined (keyword-only). The candidate
   *  list is the live persona entries — the same set recall
   *  searches. */
  const semanticAdapter = async (
    query: string,
  ): Promise<
    | {
        kind: "semantic";
        retrieveIds: (q: string, entries: MemoryEntry[]) => string[];
        similarityOf: (id: string) => number | undefined;
      }
    | undefined
  > => {
    if (!core.semanticEnabled()) return undefined;
    try {
      const candidates = core
        .allEntries()
        .filter(
          (e) =>
            e.window === "persona" &&
            (e.kind ?? "persona") === "persona" &&
            !core.forget.isForgotten(e.id),
        );
      // One search call: the similarities ride along with the ids
      // so recall can score semantic-only hits by similarity
      // (0.5.1 item 2), not by recency. Filtered by the core's
      // configured floor.
      const hits = await core.semanticSearch(query, candidates);
      // 终版 WP5: per-type floor — fact-like entries (factKey set)
      // keep the measured 0.5 floor; episodic entries may use 0.45.
      // The 0.4 tie-break tier stays OFF until the 48-case eval
      // proves it does not raise false positives.
      const candidateById = new Map(candidates.map((e) => [e.id, e]));
      const kept = hits.filter((h) => {
        const entry = candidateById.get(h.id);
        const floor = entry?.factKey ? 0.5 : 0.45;
        return h.similarity >= floor;
      });
      if (kept.length === 0) return undefined;
      const byId = new Map(kept.map((h) => [h.id, h.similarity]));
      return {
        kind: "semantic",
        retrieveIds: () => kept.map((h) => h.id),
        similarityOf: (id) => byId.get(id),
      };
    } catch {
      return undefined;
    }
  };

  const loadPersonaSessions = (): Map<string, SessionMode> => {
    try {
      const raw = readFileSync(join(dataDir, PERSONA_FILE), "utf8");
      return parsePersonaSessions(raw);
    } catch {
      // Missing or corrupt: start empty; the file is rebuilt on the
      // next persona transition.
      return new Map<string, SessionMode>();
    }
  };

  const savePersonaSessions = (map: Map<string, SessionMode>): void => {
    try {
      atomicWriteText(
        join(dataDir, PERSONA_FILE),
        serializePersonaSessions(map),
      );
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

  // 0.4.0 item 1: one audit line per memory_invalidate call (who /
  // when / which entries / why). Append-only, fsynced, never
  // rewritten. A failed write warns once and never fails the call —
  // the invalidation itself already landed in attributes.json.
  const appendInvalidationAudit = (row: {
    at: number;
    sessionId: string | null;
    entryIds: string[];
    reason: string;
    invalidated: string[];
    unknown: string[];
  }): void => {
    try {
      const fd = openSync(join(dataDir, INVALIDATION_AUDIT_FILE), "a");
      try {
        appendFileSync(fd, `${JSON.stringify(row)}\n`, "utf8");
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    } catch (err) {
      warnOnce(
        "invalidation-audit-failed",
        `失效审计日志写入失败（${err instanceof Error ? err.message : String(err)}），失效本身已写 attributes.json，本次调用无审计记录。`,
      );
    }
  };

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
    for (const [id, mode] of restored) personaSessions.set(id, mode);
    const restoredAppended = loadAppendedIds();
    appendedIdsMap.clear();
    for (const [id, ids] of restoredAppended) appendedIdsMap.set(id, ids);
    for (const [sid, state] of sessions) {
      const mode = personaSessions.get(sid);
      state.mode = mode ?? "task";
      state.persona = mode === "persona";
      state.modeLocked = mode === "task";
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
        mode: "task",
        modeLocked: false,
        lastKind: null,
        turns: 0,
        disposer: null,
        appendedIds: new Set(),
        recentUserTexts: [],
        injectedImpressionIds: new Set(),
        modelReviewDue: false,
        modelReviewDone: false,
        modelReviewCandidates: null,
        modelReviewBeliefCandidates: null,
        modelReviewReflectionPrompt: null,
        modelReviewProactPrompt: null,
        modelReviewInvalidationIds: null,
        modelReviewRecentEntryIds: null,
        modelReviewRecentKinds: null,
        reviewDisposer: null,
        modelReviewRegisteredTurn: null,
        modelReviewAllowedIds: null,
      };
      sessions.set(id, s);
    }
    return s;
  };

  const markPersona = (sid: string): void => {
    const session = getSession(sid);
    // 终版 WP1: a declared task session is not re-marked by a later
    // trigger word — only "人设窗口" switches it back.
    if (session.modeLocked && session.mode === "task") return;
    if (session.persona && session.mode === "persona") return;
    session.persona = true;
    session.mode = "persona";
    personaSessions.set(sid, "persona");
    savePersonaSessions(personaSessions);
  };

  /** 终版 WP1: an explicit "任务窗口" / "人设窗口" declaration. The
   *  mode is persisted (so it survives a DSH restart) and audited. */
  const declareMode = (
    sid: string,
    mode: SessionMode,
    rawText: string,
  ): void => {
    const session = getSession(sid);
    const from = session.mode;
    session.mode = mode;
    session.persona = mode === "persona";
    session.modeLocked = true;
    personaSessions.set(sid, mode);
    savePersonaSessions(personaSessions);
    if (from === mode) return;
    try {
      appendFileSync(
        join(dataDir, WINDOW_AUDIT_FILE),
        `${JSON.stringify({
          ts: Date.now(),
          sessionId: sid,
          from,
          to: mode,
          text: rawText.slice(0, 40),
        })}\n`,
        { encoding: "utf8" },
      );
    } catch (err) {
      warnOnce(
        "window-audit-failed",
        `窗口切换审计写入失败（${err instanceof Error ? err.message : String(err)}），切换本身已生效。`,
      );
    }
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

  // 0.5.6: the old global "memory-plugin:directives" section is GONE.
  // It was registered on the process-wide prompt layer, so every
  // session — task windows, subagents, other profiles — got a line
  // saying "阶段、关系与人设以 MEMORY.md 第一层为准". In a task window
  // that line reads as "there is a persona here", and it was one of the
  // two cues that made a plain 「你好」 in the default workspace answer
  // in-character. The same guard rails already exist where they belong:
  // the persona workspace's AGENTS.md, the persona plugin's rendered
  // block, and the header of each injected recall.

  // 终版 WP9: a one-time setup hint when semantic is wanted but the
  // optional runtime is missing. The plugin does not install by
  // itself; it names the command that installs (network once).
  try {
    const sem = core.semanticStatus();
    const wantsSemantic = config?.semanticRecall?.enabled !== false;
    if (
      wantsSemantic &&
      sem.dependency.modelPresent &&
      !sem.dependency.runtimePresent
    ) {
      ctx.systemPrompt.section({
        name: "memory-plugin:semantic-install",
        order: 710,
        text:
          "语义召回还没启用：本地运行库 @huggingface/transformers 还没装。要启用，运行 " +
          `\`${sem.dependency.installCommand}\` ` +
          "（会联网一次；装不上继续关键词召回，不影响聊天）。不需要语义可以忽略这条。",
      });
    }
  } catch {
    // A missing status must never break activation.
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
  // layer. 0.5.1 (0.4.5 audit new issue 8): no entries yesterday
  // means nothing to review ONLY when the code review also left
  // no proposals — a fragment/belief candidate, a reflection or
  // proact proposal, an invalidation check, or a merged-recent
  // section computed from today's messages is still something
  // to hand over, even on a yesterday-empty day.
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
    const session = getSession(sid);
    const hasProposals =
      (session.modelReviewCandidates?.length ?? 0) > 0 ||
      (session.modelReviewBeliefCandidates?.length ?? 0) > 0 ||
      session.modelReviewReflectionPrompt !== null ||
      session.modelReviewProactPrompt !== null ||
      (session.modelReviewInvalidationIds?.length ?? 0) > 0 ||
      (session.modelReviewRecentEntryIds?.length ?? 0) > 0 ||
      // The kinds object itself is always set by the review (even
      // as {reflection:false, proact:false}) — only a true kind
      // is a proposal.
      session.modelReviewRecentKinds?.reflection === true ||
      session.modelReviewRecentKinds?.proact === true;
    if (entries.length === 0 && !hasProposals) return;
    if (!agentCtx?.systemPrompt) {
      warnOnce(
        "model-review-no-agent-ctx",
        "没有 agent.ctx，本次跳过模型复盘（昨日记忆不进全局上下文）。",
      );
      return;
    }
    // M-1 (review-12): candidates captured at agent/created travel
    // with the review context; consumed once here, then cleared.
    const candidates = session.modelReviewCandidates ?? [];
    session.modelReviewCandidates = null;
    // 0.4.0 item 2: belief candidates travel the same way — the
    // review only proposes, the model confirms via memory_belief.
    const beliefCandidates = session.modelReviewBeliefCandidates ?? [];
    session.modelReviewBeliefCandidates = null;
    // 0.4.0 item 3: the reflection prompt travels the same way —
    // present only when the 24 h floor was cleared. The model
    // decides whether to reflect and saves via memory_reflect.
    // 0.4.6: kept as a fallback only — when the review also
    // carried recentEntryIds + recentKinds, the merged recent
    // section below replaces both pasted prompts (issue 1).
    const reflectionPrompt = session.modelReviewReflectionPrompt ?? "";
    session.modelReviewReflectionPrompt = null;
    // 0.4.4: the proactivity prompt travels the same way —
    // present only on a non-empty day. The model decides whether
    // to act and submits via memory_proact (the token comes from
    // a fresh gate call, not from this prompt).
    const proactPrompt = session.modelReviewProactPrompt ?? "";
    session.modelReviewProactPrompt = null;
    // 0.4.6 (0.4.5 audit new issue 1): the merged recent
    // section's entries and kinds — reflection entries ∪ proact
    // memories, deduped. Resolved to entries here; the prompt
    // needs their text, not just ids.
    const recentIds = session.modelReviewRecentEntryIds ?? [];
    session.modelReviewRecentEntryIds = null;
    const recentKinds = session.modelReviewRecentKinds;
    session.modelReviewRecentKinds = null;
    let recentEntries: MemoryEntry[] = [];
    if (recentIds.length > 0) {
      try {
        recentEntries = core.entriesByIds(recentIds);
      } catch (err) {
        // New issue 4 (M6-class): a read failure here must not
        // break the round — degrade to no recent entries, the
        // merged section falls back to its empty note.
        warnOnce(
          "model-review-recent-read-failed",
          `最近记忆读取失败，本次复盘不含最近一节（${err instanceof Error ? err.message : String(err)}）。`,
        );
        recentEntries = [];
      }
    }
    // 0.4.4: the invalidation-check ids travel the same way.
    // Resolved to entries here — the prompt needs their text,
    // not just ids. Unknown ids are skipped by entriesByIds.
    const invalidationIds = session.modelReviewInvalidationIds ?? [];
    session.modelReviewInvalidationIds = null;
    let invalidationEntries: MemoryEntry[] = [];
    if (invalidationIds.length > 0) {
      try {
        invalidationEntries = core.entriesByIds(invalidationIds);
      } catch (err) {
        // New issue 4 (M6-class): same rule as above — a read
        // failure degrades to no invalidation section, never
        // breaks the round.
        warnOnce(
          "model-review-invalidation-read-failed",
          `失效核查记忆读取失败，本次复盘不含失效核查一节（${err instanceof Error ? err.message : String(err)}）。`,
        );
        invalidationEntries = [];
      }
    }
    try {
      session.reviewDisposer?.();
    } catch {
      // Disposer failures must not break the turn.
    }
    session.reviewDisposer = null;
    session.modelReviewRegisteredTurn = null;
    // 0.4.7 (0.4.6 audit new issue 1): the merged section may
    // show an already-reflected entry in full, but memory_reflect's
    // gate excludes reflected entries — the model would cite it
    // and be refused ("来源 X 不在本次反思提示里"). Call the gate
    // here, so (a) the snapshot is set for the review path too
    // (0.4.3 item 8: the review path never set one — the save
    // fell back to a freshly recomputed gate), and (b) the prompt
    // can mark the shown entries the gate will not accept. Only
    // when the merged section will carry the reflection
    // instruction; a failure here must not break the round — no
    // marking, and the save path falls back to a fresh check as
    // before.
    let reflectableIds: string[] | undefined;
    if (recentKinds?.reflection) {
      try {
        reflectableIds = core.reflectionCheck().sourceIds;
      } catch {
        reflectableIds = undefined;
      }
    }
    // 0.5.1 (0.4.3 §四): the whitelist memory_daily_review will
    // check submitted ids against — the ids this prompt actually
    // shows, in prompt order, capped at MODEL_REVIEW_MAX_ENTRIES.
    // Yesterday's list and the merged-recent list are recomputed
    // with the same caps the prompt builder uses (shown +
    // overflow); the invalidation section with its own caps
    // (10 / 2000); candidate sourceIds are all printed. The cap
    // is a safety bound, not a mirror: on a day whose union tops
    // 60, an id that IS in the prompt but past the cap is not
    // citable — in practice yesterday's list rarely tops 60, and
    // the review's working set is yesterday's list anyway. A
    // computation failure leaves the whitelist null, and the
    // submit path falls back to yesterday's ids (old behaviour),
    // never blocks the round.
    try {
      const allowedIds: string[] = [];
      const seenAllowed = new Set<string>();
      const pushAllowed = (id: string): void => {
        if (allowedIds.length >= MODEL_REVIEW_MAX_ENTRIES) return;
        if (seenAllowed.has(id)) return;
        seenAllowed.add(id);
        allowedIds.push(id);
      };
      const sigOf = (e: MemoryEntry): number => core.significanceOf(e);
      const yesterdaySel = selectCappedEntries(entries, {
        maxEntries: MODEL_REVIEW_MAX_ENTRIES,
        maxChars: MODEL_REVIEW_MAX_CHARS,
        significanceOf: sigOf,
      });
      for (const r of yesterdaySel.shown) pushAllowed(r.entry.id);
      for (const o of yesterdaySel.overflow) pushAllowed(o.id);
      for (const c of candidates) {
        for (const id of c.sourceIds) pushAllowed(id);
      }
      for (const c of beliefCandidates) {
        for (const id of c.sourceIds) pushAllowed(id);
      }
      const recentSel = selectCappedEntries(recentEntries, {
        maxEntries: RECENT_MAX_ENTRIES,
        maxChars: RECENT_MAX_CHARS,
        significanceOf: sigOf,
      });
      for (const r of recentSel.shown) pushAllowed(r.entry.id);
      for (const o of recentSel.overflow) pushAllowed(o.id);
      const invSel = selectCappedEntries(invalidationEntries, {
        maxEntries: 10,
        maxChars: 2000,
      });
      for (const r of invSel.shown) pushAllowed(r.entry.id);
      for (const o of invSel.overflow) pushAllowed(o.id);
      session.modelReviewAllowedIds = allowedIds;
    } catch (err) {
      warnOnce(
        "model-review-allowlist-failed",
        `复盘白名单计算失败，本次提交回退到昨日 id（${err instanceof Error ? err.message : String(err)}）。`,
      );
      session.modelReviewAllowedIds = null;
    }
    try {
      const handle = agentCtx.systemPrompt.context({
        name: "memory-plugin:daily-review",
        order: 500,
        // 0.4.5 (0.4.3 audit item 4): the prompt is capped (top 60
        // by significance / 8000 chars) — the significance comes
        // from the core's attribute store.
        text: buildModelReviewPrompt(entries, candidates, beliefCandidates, reflectionPrompt, proactPrompt, invalidationEntries, {
          significanceOf: (e) => core.significanceOf(e),
          // 0.4.6 (0.4.5 audit new issue 1): the merged recent
          // section — when the review carried recent entries +
          // kinds, it replaces the two pasted prompts above.
          recentEntries,
          recentReflection: recentKinds?.reflection ?? false,
          recentProact: recentKinds?.proact ?? false,
          // 0.4.7 (0.4.6 audit new issue 1): the gate's citable
          // ids, so the merged section can mark what a reflection
          // save would refuse.
          reflectableIds,
        }),
      });
      if (typeof handle === "function") {
        session.reviewDisposer = handle as () => void;
        // 0.4.5: start the auto-release clock — counted in
        // pre-step turns (this turn is turn 0). Only when a
        // disposer actually exists: without one there is nothing
        // the shell could release.
        session.modelReviewRegisteredTurn = session.turns;
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
    const restoredMode = personaSessions.get(id);
    const restored = restoredMode !== undefined;
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
      persona: restoredMode === "persona",
      mode: restoredMode ?? "task",
      modeLocked: restoredMode === "task",
      lastKind: null,
      turns: restored ? 1 : 0,
      disposer: null,
      appendedIds,
      recentUserTexts: [],
      injectedImpressionIds: new Set(),
      modelReviewDue: false,
      modelReviewDone: false,
      modelReviewCandidates: null,
      modelReviewBeliefCandidates: null,
      modelReviewReflectionPrompt: null,
      modelReviewProactPrompt: null,
      modelReviewInvalidationIds: null,
      modelReviewRecentEntryIds: null,
      modelReviewRecentKinds: null,
      reviewDisposer: null,
      modelReviewRegisteredTurn: null,
      modelReviewAllowedIds: null,
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
    if (restored && restoredMode === "persona" && !writeBlocked) {
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
          // 0.4.0 item 2: the review's belief candidates travel
          // the same way — the model confirms via memory_belief.
          state.modelReviewBeliefCandidates =
            reviewResult.beliefCandidates ?? [];
          // 0.4.0 item 3: the review's reflection prompt travels
          // the same way — present only when the 24 h floor was
          // cleared. The model decides whether to reflect and
          // saves via memory_reflect.
          state.modelReviewReflectionPrompt =
            reviewResult.reflectionPrompt ?? null;
          // 0.4.4: the review's proactivity prompt travels the
          // same way — present only on a non-empty day. The model
          // decides whether to act and submits via memory_proact.
          state.modelReviewProactPrompt =
            reviewResult.proactPrompt ?? null;
          // 0.4.4: the review's invalidation-check ids travel the
          // same way — old memories a later entry may contradict.
          // Resolved to entries at the first pre-step (the prompt
          // needs their text). The model confirms via
          // memory_invalidate.
          state.modelReviewInvalidationIds =
            reviewResult.invalidationChecks ?? [];
          // 0.4.6 (0.4.5 audit new issue 1): the merged recent
          // section's entries and kinds travel the same way — the
          // section replaces the two pasted prompts (reflection +
          // proact). Resolved to entries at the first pre-step.
          state.modelReviewRecentEntryIds =
            reviewResult.recentEntryIds ?? [];
          state.modelReviewRecentKinds =
            reviewResult.recentKinds ?? null;
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
      // 终版 WP1: an explicit mode declaration wins over the trigger
      // guess; then the trigger marks the session (unless the session
      // was explicitly declared task).
      for (const text of userTexts) {
        const declared = matchDeclaration(
          text,
          triggerWords,
          declarationPhrases,
        );
        if (declared !== null) declareMode(sid, declared, text);
      }
      // 2026-11-12 工作区隔离：不在人设工作区的会话，触发词不许把它标成 persona。
      const inWs = inPersonaWorkspace(cwdOf(agent) ?? cwdOf(ev));
      if (!inWs) {
        session.persona = false;
      } else if (personaWorkspace) {
        // 0.5.6: when a persona-workdir whitelist IS configured, a
        // session inside that workdir is a persona window by default —
        // same cadence as persona-plugin's defaultPersona and the
        // skill's "every turn writes memory". Without the whitelist the
        // old trigger-word rule stays exactly as before, so other
        // deployments and the mock tests are unaffected. A session that
        // explicitly declared 任务窗口 keeps task: markPersona returns
        // early on modeLocked+task.
        markPersona(sid);
      } else if (userTexts.some((t) => shouldMarkPersona(t, triggerWords))) {
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
      // 0.4.5 (0.4.3 audit item 4): the review context auto-releases
      // after MODEL_REVIEW_AUTO_RELEASE_TURNS turns without a
      // submission — before this it lived in every request until
      // the model called memory_daily_review, so a chatty day pinned
      // ten thousand words into the prompt indefinitely. The submit
      // path still disposes on success; this is the backstop, and
      // it never fires on the registration turn itself (diff 0).
      if (
        session.reviewDisposer !== null &&
        session.modelReviewRegisteredTurn !== null &&
        session.turns - session.modelReviewRegisteredTurn >= MODEL_REVIEW_AUTO_RELEASE_TURNS
      ) {
        try {
          session.reviewDisposer();
        } catch {
          // Disposer failures must not break the turn.
        }
        session.reviewDisposer = null;
        session.modelReviewRegisteredTurn = null;
        // 0.5.1 (0.4.3 §四): the whitelist dies with the context
        // — a later cold call falls back to yesterday's ids.
        session.modelReviewAllowedIds = null;
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
        // 0.4.0 item 4: no recall ran here, so no profile block.
        result = { hits: [], layer1: null, profileText: "", estimatedTokens: 0, text: "" };
      } else {
        try {
          // 0.5.0 step 5: query rewrite — one model call (the
          // host-injected rewriter) expands the question before
          // recall. Timeout / failure / empty all fall back to the
          // original query, keyword-only; tokenCap 1500 and top 5
          // are unchanged (the rewrite only changes which tokens
          // match, never the budget).
          const rewritten = await rewriteQuery(
            query,
            queryRewriter,
            rewriteTimeoutMs,
          );
          const semantic = await semanticAdapter(query);
          result = core.recall(query, {
            tokenCap,
            valveTop,
            sessionId: sid,
            recentTexts: session.recentUserTexts,
            rewrittenQuery: rewritten ?? undefined,
            semantic,
          });
        } catch (err) {
          warnOnce(
            "recall-failed",
            `本轮 recall 失败，不注入（${err instanceof Error ? err.message : String(err)}），对话继续。`,
          );
          result = { hits: [], layer1: null, profileText: "", estimatedTokens: 0, text: "" };
        }
      }
      // Update the recent-texts list AFTER the recall: the current
      // turn's own words must not feed its own attention factor.
      session.recentUserTexts = [...session.recentUserTexts, ...userTexts].slice(-5);
      // 0.6.0: an impression can ride in even when no keyword hit
      // survives — it is her standing judgement, not a fact hit.
      // Each impression is shown to a session ONCE: repeating the
      // same judgement every turn reads like nagging.
      const freshImpressions = (result.impressions ?? []).filter(
        (i) => !session.injectedImpressionIds.has(i.id),
      );
      if (result.hits.length > 0 || freshImpressions.length > 0) {
        // 0.4.0 item 4: the profile block rides with the recall — it
        // is the head of every injection (turn-1 append and the
        // refreshed context alike), never a standalone injection:
        // when there are no hits, nothing is injected at all.
        const injectedText = composeInjection(
          result.profileText,
          result.hits,
          core.beliefLine() || undefined,
          (result.experiences ?? []).map((e) => e.rule),
          tokenCap,
          (dropped) => logRecallDropped(sid, query, dropped),
          freshImpressions,
        );
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
            content: [{ type: "text", text: injectedText }],
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
        // 0.4.0 item 2: the belief line rides with the refreshed
        // context too (same line as the turn-1 append's) — empty
        // when there are no beliefs, so the refresh is unchanged
        // until the first belief exists.
        const freshHits = result.hits.filter(
          (h) => !session.appendedIds.has(h.entry.id),
        );
        // 0.6.0: on turn 1 the append above already carried the
        // impressions; later turns carry them through the refreshed
        // context. Either way a session sees each impression once,
        // so it is marked only after this turn's injection.
        const impsForContext = session.turns <= 1 ? [] : freshImpressions;
        refreshRecallContext(
          sid,
          freshHits.length > 0 || impsForContext.length > 0
            ? composeInjection(
                result.profileText,
                freshHits,
                core.beliefLine() || undefined,
                undefined,
                tokenCap,
                (dropped) => logRecallDropped(sid, query, dropped),
                impsForContext,
              )
            : "",
          agentCtx,
        );
        for (const imp of freshImpressions) {
          session.injectedImpressionIds.add(imp.id);
        }
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
      if (writeBlocked) return;
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
      // 2026-11-12 工作区隔离：不在人设工作区的会话，一个字都不记。
      if (!inPersonaWorkspace(cwdOf(subject) ?? cwdOf(event))) return;
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
      // 终版 WP1: declaration first, then the trigger latch, then the
      // content kind. "夏柠柒" alone records as greeting (not memory);
      // work inside a persona session records as task.
      const declared = matchDeclaration(
        text,
        triggerWords,
        declarationPhrases,
      );
      if (declared !== null) declareMode(sid, declared, text);
      if (shouldMarkPersona(text, triggerWords)) {
        markPersona(sid);
      }
      if (!session.persona) return;
      const contentKind = classifyContent(
        text,
        session.mode,
        triggerWords,
        declarationPhrases,
      );
      if (contentKind === "skip") return;
      // Unattributable events are never recorded, even if they carry
      // the trigger (fail closed — audit issue 3).
      if (!attributable) return;
      session.lastKind = contentKind;
      if (writeBlocked) {
        warnOnce("write-blocked-record", writeBlockedMessage);
        return;
      }
      try {
        const entry = core.record({
          role: "user",
          text,
          window: "persona",
          kind: contentKind,
          sessionId: sid,
        });
        // 0.5.1 item 2: append the new vector when semantic is on
        // — fire-and-forget, never blocks the turn.
        void core.semanticUpsertEntry(entry);
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
      // 终版 WP1: her reply follows the turn. A short conversational
      // answer stays persona even after a task request; a code block,
      // table, 5+ item list or >800 chars is work output.
      const kind = classifyAssistantReply(
        session.lastKind ?? "persona",
        text,
        assistantPersonaMaxChars,
      );
      if (writeBlocked) {
        warnOnce("write-blocked-record", writeBlockedMessage);
        return;
      }
      try {
        const entry = core.record({
          role: "assistant",
          text,
          window: "persona",
          kind,
          sessionId: sid,
        });
        void core.semanticUpsertEntry(entry);
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
    if (writeBlocked) return;
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
      if (writeBlocked) return;
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
        const specName = (spec as { name?: unknown } | null)?.name;
        if (
          writeBlocked &&
          typeof specName === "string" &&
          WRITE_TOOLS.has(specName)
        ) {
          spec = {
            ...(spec as Record<string, unknown>),
            execute: async () => ({ ok: false, error: writeBlockedMessage }),
          };
        }
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
        registeredToolNames.push(
          String((compiled as { name?: unknown } | null)?.name ?? ""),
        );
      };

      // 0.4.1 item 1: the profile write path (A's memory_profile,
      // kept on B's rules — the block still only rides with a
      // recall that has hits, and the format stays B's ≤5 lines).
      // The write goes through MemoryCore.updateProfile (write
      // lock, profile.json), and read-back merges profile.json
      // over the layer-1 assembly inside recall/readLayer1.
      registerTool({
        name: "memory_profile",
        description:
          "更新或读取人设画像常驻块（名字、阶段、关系阶段），以及 8 类结构化画像（爱好习惯、理想、偏好、底线、身体健康、害怕担心、秘密、家人朋友）。画像独立保存在 profile.json，不修改 MEMORY.md、log.jsonl 或关键词索引。只允许在人设窗口调用；至少提供一个字段才会更新。8 类画像不做敏感分级，但每条都必须带 sourceIds（真实人设记忆的 id），没有来源的画像条目会被拒绝。",
        parameters: {
          name: { type: "string", required: false, description: "人设名称" },
          stage: { type: "string", required: false, description: "人设当前阶段" },
          relationshipStage: { type: "string", required: false, description: "当前关系阶段" },
          category: {
            type: "string",
            required: false,
            description:
              "可选：8 类之一（爱好习惯 / 理想 / 偏好 / 底线 / 身体健康 / 害怕担心 / 秘密 / 家人朋友）。只传 category 不传 items/removeTexts/clearCategory 时只读这一类。",
          },
          items: {
            type: "array",
            required: false,
            description:
              "可选：替换这一类的内容。每项必须带 text 和 sourceIds（真实人设记忆的 id）。",
            items: {
              type: "object",
              properties: {
                text: { type: "string" },
                sourceIds: { type: "array", items: { type: "string" } },
              },
              required: ["text", "sourceIds"],
            },
          },
          removeTexts: {
            type: "array",
            required: false,
            description: "可选：按 text 精确删除这一类里的几条。",
            items: { type: "string" },
          },
          clearCategory: {
            type: "boolean",
            required: false,
            description: "可选：清空这一类。",
          },
        },
        output: {
          schema: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              profile: { type: "object", additionalProperties: true },
              profileText: { type: "string" },
              error: { type: "string" },
            },
          },
          render: (_args: unknown, value: unknown) => [{ type: "text", text: JSON.stringify(value, null, 2) }],
        },
        execute: async (args: unknown, exec?: unknown) => {
          const { persona } = toolSession(exec);
          if (!persona) return { ok: false, error: "memory_profile 只允许在人设窗口调用；任务窗口已拒绝。" };
          const a = (args ?? {}) as Record<string, unknown>;
          const patch: Partial<PersonaProfile> = {};
          if (typeof a.name === "string") patch.name = a.name;
          if (typeof a.stage === "string") patch.stage = a.stage;
          if (typeof a.relationshipStage === "string") patch.relationshipStage = a.relationshipStage;
          try {
            // 终版 WP6: 8-category structured profile. Every item
            // must cite real persona entries; no sensitivity tier.
            const rawCategory = typeof a.category === "string" ? a.category : undefined;
            if (rawCategory !== undefined) {
              const category = rawCategory as ProfileCategory;
              if (!PROFILE_CATEGORIES.includes(category)) {
                throw new Error(
                  `category 必须是这 8 类之一：${PROFILE_CATEGORIES.join(" / ")}`,
                );
              }
              const existing = core.readLayer1().profile?.categories?.[category] ?? [];
              let nextItems: ProfileItem[] | undefined;
              if (a.clearCategory === true) {
                nextItems = [];
              } else if (a.items !== undefined) {
                if (!Array.isArray(a.items)) throw new Error("items 必须是数组");
                const byId = new Map(core.allEntries().map((e) => [e.id, e]));
                const now = Date.now();
                nextItems = [];
                for (const raw of a.items) {
                  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
                    throw new Error("items 里每一项必须是 { text, sourceIds }");
                  }
                  const item = raw as Record<string, unknown>;
                  const text = typeof item.text === "string" ? item.text.trim() : "";
                  if (!text) throw new Error("items 里的 text 不能为空");
                  const sourceIds = Array.isArray(item.sourceIds)
                    ? [...new Set(item.sourceIds.filter((x): x is string => typeof x === "string" && x.length > 0))]
                    : [];
                  if (sourceIds.length === 0) {
                    throw new Error(`画像条目「${text}」没有 sourceIds，拒绝写入`);
                  }
                  for (const id of sourceIds) {
                    const entry = byId.get(id);
                    if (!entry) throw new Error(`sourceId ${id} 不在日志里`);
                    if (entry.window !== "persona" || (entry.kind ?? "persona") !== "persona") {
                      throw new Error(`sourceId ${id} 不是人设聊天条目（task/greeting 不能当画像来源）`);
                    }
                    if (core.forget.isForgotten(id)) {
                      throw new Error(`sourceId ${id} 已被隐藏，不能当画像来源`);
                    }
                  }
                  nextItems.push({ text, sourceIds, updatedAt: now });
                }
              } else if (a.removeTexts !== undefined) {
                if (!Array.isArray(a.removeTexts)) throw new Error("removeTexts 必须是数组");
                const doomed = new Set(
                  a.removeTexts.filter((x): x is string => typeof x === "string"),
                );
                nextItems = existing.filter((item) => !doomed.has(item.text));
              }
              if (nextItems !== undefined) {
                patch.categories = { [category]: nextItems };
              }
            }
            if (Object.keys(patch).length > 0) {
              core.updateProfile(patch);
            } else if (
              a.name !== undefined ||
              a.stage !== undefined ||
              a.relationshipStage !== undefined ||
              a.category !== undefined
            ) {
              // Read-only category query is allowed; a non-string
              // name/stage/relationshipStage is still an error.
              if (
                a.name !== undefined &&
                typeof a.name !== "string"
              ) {
                throw new Error("profile_fields_must_be_strings");
              }
            }
            const layer1 = core.readLayer1();
            const profile = layer1.profile ?? {};
            const cleanProfile = Object.fromEntries(
              Object.entries(profile).filter(([, v]) => v !== undefined),
            );
            return {
              ok: true,
              profile: cleanProfile,
              profileText: formatProfileBlock(layer1) ?? "",
            };
          } catch (err) {
            return { ok: false, error: `画像更新失败：${err instanceof Error ? err.message : String(err)}` };
          }
        },
      });

      registerTool({
        name: "memory_search",
        description:
          "按关键词搜索本地记忆 (原始对话记录与月度归档细节), 返回相关记忆与当前状态。只搜人设窗口的记忆——任务窗口的记录不会出现在这里。",
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
          includeWork: {
            type: "boolean",
            required: false,
            description:
              "可选：把干活轮次（kind=task）的条目也搜进来，默认不搜。只在人设窗口可用；用于找回\"上次让你改的那段\"。",
          },
          includeCandidates: {
            type: "boolean",
            required: false,
            description:
              "可选：把证据不足的候选事实（candidate=true）也搜进来，默认不搜；候选不是既定事实，别当成确认过的记忆用。",
          },
        },
        output: {
          schema: {
            type: "object",
            properties: {
              // 0.4.0 item 4: the standing profile block, first —
              // it is not a recall hit, takes no valve slot and no
              // token-cap budget (see core/src/recall.ts).
              profileText: { type: "string" },
              layer1: { type: "string" },
              hits: { type: "array" },
              // 0.6.0: live impressions (id + text + strategy), so
              // the model can name one in memory_feedback.
              impressions: { type: "array" },
              error: { type: "string" },
            },
          },
          render: (_args: unknown, value: unknown) => [
            { type: "text", text: JSON.stringify(value, null, 2) },
          ],
        },
        execute: async (args: unknown, exec?: unknown) => {
          // 0.5.2: reading persona memory is a persona-window action.
          // Automatic pre-step injection was already gated; without
          // this an explicit memory_search from a task window could
          // still read the private persona log.
          const { persona } = toolSession(exec);
          if (exec !== undefined && !persona) {
            return {
              profileText: "",
              layer1: "",
              hits: [],
              error:
                "memory_search 只在人设窗口可用：当前会话不是人设窗口（没有触发夏柠柒/柠柒），不读取人设记忆。",
            };
          }
          // Argument validation (audit B2/M2): the local compiler
          // does not validate args the way real defineTool does, so
          // a bad call returns empty instead of throwing or writing
          // garbage. An empty/non-string query never throws (m11).
          const q =
            args &&
            typeof (args as { query?: unknown }).query === "string"
              ? ((args as { query: string }).query as string)
              : "";
          const rawLimit =
            args && typeof (args as { limit?: unknown }).limit === "number"
              ? ((args as { limit: number }).limit as number)
              : 5;
          const limit = Number.isFinite(rawLimit)
            ? Math.max(1, Math.min(50, Math.floor(rawLimit)))
            : 5;
          const includeWork =
            (args as { includeWork?: unknown } | undefined)?.includeWork ===
            true;
          const includeCandidates =
            (args as { includeCandidates?: unknown } | undefined)
              ?.includeCandidates === true;
          try {
            // 0.5.0 step 5: same rewrite as the pre-step recall —
            // the rewritten query unions with the original, and a
            // timeout / failure falls back to keyword-only.
            const rewritten = await rewriteQuery(
              q,
              queryRewriter,
              rewriteTimeoutMs,
            );
            const semantic = await semanticAdapter(q);
            const result = core.recall(q, {
              // 0.5.1 (0.4.3 audit item 12): persona only — a
              // task window's entries must never surface in a
              // persona search (and vice versa: fragment sources
              // are persona-checked in the core too).
              window: "persona",
              includeWork,
              includeCandidates,
              limit,
              rewrittenQuery: rewritten ?? undefined,
              semantic,
            });
            return {
              profileText: result.profileText,
              layer1: result.layer1 ? formatLayer1(result.layer1) : "",
              // 0.6.0 (人味改造 第 3 项): the live impressions, with
              // ids — injected blocks carry no ids, so this is where
              // the model gets the impressionId it needs when the
              // user denies one (memory_feedback + wrong).
              impressions: core.listImpressions(),
              hits: result.hits.map((h) => {
                // 0.5.0 step 3: every hit carries its provenance —
                // the fragment's when fragment-backed, otherwise
                // the verbatim log line itself. sourceSummary is
                // one readable line (date + source kind + how many
                // times it was verified); the model must never
                // treat a model_inference hit as a quoted fact.
                const prov = h.provenance ?? entryProvenance(h.entry);
                const sourceTypeCn =
                  SOURCE_TYPE_CN[prov.sourceType] ?? prov.sourceType;
                return {
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
                  kind: h.entry.kind ?? "persona",
                  candidate: h.entry.candidate === true,
                  validFrom: h.entry.validFrom ?? null,
                  observedAt: h.entry.observedAt ?? null,
                  importance: h.entry.importance,
                  // 0.3.0: a fragment hit shows the fragment text
                  // (with its tone) instead of the full original.
                  text: h.displayText ?? h.entry.text,
                  fragmentId: h.fragmentId ?? "",
                  fragmentTone: h.fragmentTone ?? "",
                  fragmentFallback: h.fragmentFallback === true,
                  sourceIds: prov.sourceIds,
                  sourceType: prov.sourceType,
                  sourceTypeCn,
                  confidence: prov.confidence,
                  verifyCount: prov.verifyCount,
                  lastVerifiedAt: prov.lastVerifiedAt,
                  sourceSummary:
                    `${h.entry.date} ${sourceTypeCn}` +
                    (prov.verifyCount > 0
                      ? ` · 已验证 ${prov.verifyCount} 次`
                      : " · 未验证"),
                };
              }),
            };
          } catch (err) {
            warnOnce(
              "search-failed",
              `memory_search 失败（${err instanceof Error ? err.message : String(err)}），返回空结果。`,
            );
            return { profileText: "", layer1: "", hits: [] };
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
          factKey: {
            type: "string",
            required: false,
            description:
              "可选：这条记忆属于哪个事实（比如 “最喜欢的颜色”“喝咖啡”）。同一事实的新版本传同一个 factKey，旧版就成了历史版——问“现在”只答当前版，问“以前”答历史版。不确定就别传，没 factKey 的记忆召回和以前一模一样。",
          },
          supersedes: {
            type: "string",
            required: false,
            description:
              "可选：这条记忆替代的旧条目 id（见 memory_search 的 hits）。和 factKey 一起传，旧条目必须和新条目同一个 factKey。",
          },
          validFrom: {
            type: "string",
            required: false,
            description:
              "可选：这条事实从什么时候开始成立（ISO 日期如 2024-01-01，或 epoch 毫秒）。不传按写入时间算；补记旧事时传它，别让旧事变成“现在”。",
          },
          observedAt: {
            type: "string",
            required: false,
            description:
              "可选：你是什么时候知道这件事的（ISO 日期或 epoch 毫秒）。和 validFrom 分开：事情何时成立、系统何时知道，不是一回事。",
          },
          candidate: {
            type: "boolean",
            required: false,
            description:
              "可选：证据不足、还不确定的事实时传 true。候选会留在原文里，但默认不注入、不当成既定事实；显式搜索才能看到。",
          },
        },
        output: {
          schema: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              id: { type: "string" },
              warning: { type: "string" },
              error: { type: "string" },
            },
          },
          render: (_args: unknown, value: unknown) => [
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
            const factKey =
              typeof (args as { factKey?: unknown })?.factKey === "string" &&
              ((args as { factKey: string }).factKey as string).length > 0
                ? (args as { factKey: string }).factKey
                : undefined;
            const supersedes =
              typeof (args as { supersedes?: unknown })?.supersedes ===
                "string" &&
              ((args as { supersedes: string }).supersedes as string).length > 0
                ? (args as { supersedes: string }).supersedes
                : undefined;
            const validFrom = parseTimeArg(
              (args as { validFrom?: unknown } | undefined)?.validFrom,
            );
            const observedAt = parseTimeArg(
              (args as { observedAt?: unknown } | undefined)?.observedAt,
            );
            const candidate =
              (args as { candidate?: unknown } | undefined)?.candidate ===
              true;
            // 终版 WP4: a nudge, not a verdict — the model decides
            // what is a fact. A missing factKey is recorded, but the
            // reply says the old and new statements may both recall.
            const looksLikeFact =
              factKey === undefined &&
              /我(住|住在|是|在|喜欢|爱|已经|搬|养|叫|的[^，。]{0,12}是)/.test(
                text,
              );
            const warning = looksLikeFact
              ? "这条像事实，但没带 factKey：以后新旧说法可能同时被召回、互相矛盾。事实类记忆请带 factKey（同一件事用同一个）。"
              : undefined;
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
              // 0.5.1 item 1: fact version chain — an explicit
              // identity + supersedes link; core.record validates
              // the target exists and shares the factKey.
              ...(factKey !== undefined ? { factKey } : {}),
              ...(supersedes !== undefined ? { supersedes } : {}),
              // 终版 WP4: two clocks + candidate flag.
              ...(validFrom !== undefined ? { validFrom } : {}),
              ...(observedAt !== undefined ? { observedAt } : {}),
              ...(candidate ? { candidate: true } : {}),
            });
            // 0.5.1 item 2: append the new vector when semantic is
            // on — fire-and-forget, never blocks the reply.
            void core.semanticUpsertEntry(entry);
            return { ok: true, id: entry.id, ...(warning ? { warning } : {}) };
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
          "提交昨日记忆复盘的结果：把你认为值得长期记住的记忆的 id 列表交回来，插件会把它们的重要度提到最高（0.9），以后永不压缩。只在人设窗口可用。id 只能用复盘上下文里给的昨日消息列表里的 id，不要编；不在复盘上下文里的 id 会进 unknown、不应用；没有重要的就传空列表。",
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
          render: (_args: unknown, value: unknown) => [
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
          // 0.5.1 (0.4.3 §四): capture the whitelist BEFORE
          // clearing it — the submit below filters against this
          // snapshot, and the whitelist is single-use: a submitted
          // review cannot be re-used to mark more ids later.
          const allowedSnapshot =
            sid !== null
              ? (sessions.get(sid)?.modelReviewAllowedIds ?? null)
              : null;
          if (sid !== null) {
            const state = sessions.get(sid);
            if (state) {
              try {
                state.reviewDisposer?.();
              } catch {
                // Disposer failures must not break the tool call.
              }
              state.reviewDisposer = null;
              // 0.4.5: stop the auto-release clock too — the review
              // is done, there is nothing left to release.
              state.modelReviewRegisteredTurn = null;
              state.modelReviewAllowedIds = null;
            }
          }
          // 0.5.1 (0.4.3 §四): whitelist — only ids the live
          // review prompt showed may be marked. Outside the
          // whitelist an id lands in `unknown`, never applied. No
          // whitelist (cold call, context released, session
          // rebuilt) falls back to yesterday's ids — the old
          // behaviour's scope, so a review submitted without a
          // live context still cannot mark an arbitrary entry.
          // applyModelMarks still reports ids it cannot find in
          // the log as unknown.
          let submitIds = ids;
          let outOfScope: string[] = [];
          const allowed = allowedSnapshot;
          if (allowed !== null) {
            const set = new Set(allowed);
            submitIds = ids.filter((id) => set.has(id));
            outOfScope = ids.filter((id) => !set.has(id));
          } else {
            try {
              const yesterdayIds = new Set(
                core.yesterdayEntries().map((e) => e.id),
              );
              submitIds = ids.filter((id) => yesterdayIds.has(id));
              outOfScope = ids.filter((id) => !yesterdayIds.has(id));
            } catch {
              // Yesterday unreadable: apply as before;
              // applyModelMarks still reports ids it cannot find
              // as unknown.
            }
          }
          try {
            const res = core.applyModelMarks(submitIds);
            return {
              ok: true,
              applied: res.applied,
              unknown: [...res.unknown, ...outOfScope],
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
          "把几条原文提炼成一条短片段（约 10 token），存在 fragments.json 里：以后召回时优先注入片段而不是整段原文，省 token；星空图里片段就是一颗星。片段必须注明来源（sourceIds，必填）、带 1–2 句从原文逐字抄来的引用（quotes，必填），语气（tone）用你自己的词写就行，不限固定列表（比如 “很喜欢”“嘴上嫌弃心里喜欢”“有点喜欢但不太确定”，可加 :强度如 很喜欢:0.9）。插件会用代码逐字核对：正文关键词、引用、语气都必须和来源对得上，对不上就拒绝保存并告诉你原因——不要编来源里没有的词，不要改写引用，不要把语气写得比来源更重。想留一条「印象」（你对他现在的判断 + 你打算怎么对他），就传 kind: \"impression\" + strategy（一句对策），印象会带天数、到点自己过期。",
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
          // 0.5.0 step 3: 来源类型是你自己的判断（用户原话 /
          // 模型原话 / 模型总结 / 模型推断），不填默认模型总结；
          // 可信度那个数不是你填的，是代码按类型和验证次数算的，
          // 别自己写。
          sourceType: {
            type: "string",
            required: false,
            description: "来源类型：user_quote（用户原话）/ model_quote（模型原话）/ model_summary（模型总结）/ model_inference（模型推断）；不填默认 model_summary",
          },
          keywords: {
            type: "array",
            items: { type: "string" },
            required: false,
            description: "关键词列表；不填时从正文里取",
          },
          // 0.6.0 (人味改造 第 1 项): 印象是「你现在的看法 + 你打算
          // 怎么对他」，不是普通片段。写了 kind:"impression" 就必须
          // 带 strategy；印象会按 validUntil 过期，默认为 14 天。
          kind: {
            type: "string",
            required: false,
            description:
              "填 \"impression\" 表示这是一条印象（你对他的判断 + 你打算怎么对他）；普通片段不填。填了就必须带 strategy。",
          },
          strategy: {
            type: "string",
            required: false,
            description:
              "印象专用：一句你打算怎么对他（如「别催他早睡，给他留盏灯」）。只有看法没有对策的不是印象。",
          },
          validUntil: {
            type: "string",
            required: false,
            description:
              "印象专用：这条印象到什么时候就不算数了（YYYY-MM-DD 或毫秒时间戳）；不填默认 14 天。到期后不会再用它说话。",
          },
          voiced: {
            type: "string",
            required: false,
            description:
              "可选：这句记忆你自己的口吻版（一句话，按你现在这个阶段说话的样子写）；注入时用这一句，检索仍用 text。",
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
          render: (_args: unknown, value: unknown) => [
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
            sourceType?: unknown;
            keywords?: unknown;
            kind?: unknown;
            strategy?: unknown;
            validUntil?: unknown;
            voiced?: unknown;
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
          const sourceType =
            typeof a.sourceType === "string" ? a.sourceType : undefined;
          const keywords = Array.isArray(a.keywords)
            ? a.keywords.filter((x): x is string => typeof x === "string")
            : undefined;
          const kind = typeof a.kind === "string" ? a.kind : undefined;
          const strategy =
            typeof a.strategy === "string" ? a.strategy : undefined;
          const voiced = typeof a.voiced === "string" ? a.voiced : undefined;
          const validUntil =
            typeof a.validUntil === "string" || typeof a.validUntil === "number"
              ? a.validUntil
              : undefined;
          try {
            const result = core.createFragment({
              sourceIds,
              text,
              tone,
              quotes,
              topic,
              sourceType,
              keywords,
              kind,
              strategy,
              validUntil,
              voiced,
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
        // 0.5.1 (0.4.3 audit item 14): no persona gate on purpose
        // — a snapshot only copies the plugin's own files into a
        // snapshot directory, it never changes memory content, so
        // a task window taking one is harmless. memory_restore is
        // the gated one: it reverts memory.
        description:
          "立即对插件自己的记忆文件 (log + 索引) 做一次快照，可用于事后恢复。快照不覆盖 MEMORY.md、月度归档或日记。快照只复制文件、不改记忆内容，所以任务窗口也可以调；恢复（memory_restore）只在人设窗口可用。",
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
          render: (_args: unknown, value: unknown) => [
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
          "把插件自己的记忆文件 (log + 索引) 恢复到指定快照。恢复前先对当前状态做安全快照，可再恢复回来。MEMORY.md、月度归档与日记不受影响。只在人设窗口可用——任务窗口调会被拒绝，且不写任何文件。",
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
          render: (_args: unknown, value: unknown) => [
            { type: "text", text: JSON.stringify(value) },
          ],
        },
        execute: async (args: unknown, exec?: unknown) => {
          // 0.5.1 (0.4.3 audit item 14): same persona gate as
          // the other write tools — a restore reverts memory, so
          // a task window is refused before anything is written.
          const { persona } = toolSession(exec);
          if (!persona) {
            return {
              ok: false,
              error:
                "memory_restore 只在人设窗口可用：当前会话不是人设窗口，本次不恢复任何文件。",
            };
          }
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
          "返回本地记忆的统计：总条数、最近 30 天条数、归档月份、索引词数、快照列表、图边数、属性条数、上次复盘时间（0.2.0）、片段数与存疑片段数（0.3.0）、信念数与三维信念值（0.4.0）、待下次复盘确认的失效提议数（0.4.4：打勾等模型确认的旧记忆，还没作废的；这个数是提议数，不是已确认失效数——过期但还没复盘的标记也算在内，等下次复盘时确认或放过）、未完成目标数与已完成目标数（0.5.1）、待处理的遗忘请求数（0.5.1）、语义索引状态（0.5.1）。",
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
              // 0.5.5: a fresh install has never run a review, so
              // core.stats() reports null here. The host checks this
              // schema strictly ("value.lastReviewAt must be a number")
              // and fails the whole call — the execute below normalizes
              // null to 0 ("never reviewed"), so keep the schema number.
              lastReviewAt: { type: "number" },
              fragments: { type: "number" },
              suspectFragments: { type: "number" },
              // 0.4.0 item 2: the three dimensions' current values
              // (safety / trust / closeness, each strength /
              // uncertainty / proofCount) — same summary memory_belief
              // get returns, visible here without another call.
              beliefs: { type: "number" },
              beliefDimensions: { type: "object", additionalProperties: true },
              // 0.4.4 item 2: memories flagged for invalidation
              // review and not yet invalidated ("awaiting model
              // review") — the count the daily review prompt draws
              // its invalidation section from.
              pendingInvalidationChecks: { type: "number" },
              // 0.5.0 step 4: tools that actually registered (17
              // once memory_feedback and the 0.5.1 expansion tools
              // are in) and their names — read at call time, so an
              // early call may see fewer.
              tools: { type: "number" },
              toolNames: { type: "array" },
              // 0.5.1 item 5: goals with completion status.
              openGoals: { type: "number" },
              doneGoals: { type: "number" },
              // 0.5.1 item 1: forget requests awaiting a decision.
              pendingForgets: { type: "number" },
              // 0.5.1 item 2: semantic index state.
              semantic: { type: "object", additionalProperties: true },
              // 终版 WP0: where memory actually lives, whether
              // MEMORY.md is there, and any split-brain warning.
              dataDir: { type: "string" },
              memoryFilePresent: { type: "boolean" },
              writeBlocked: { type: "boolean" },
              warning: { type: "string" },
              // 终版 WP1: persona / task / greeting entry counts.
              kinds: { type: "object", additionalProperties: true },
              error: { type: "string" },
            },
          },
          render: (_args: unknown, value: unknown) => [
            { type: "text", text: JSON.stringify(value, null, 2) },
          ],
        },
        execute: async () => {
          try {
            const goals = core.goals.all();
            const stats = core.stats();
            return {
              ok: true,
              ...stats,
              // 0.5.5: core.stats() returns null before the first daily
              // review; the host's output-schema check rejects null for
              // a number field and the whole status call dies. 0 reads
              // as "never reviewed" and always satisfies the schema.
              lastReviewAt:
                typeof stats.lastReviewAt === "number"
                  ? stats.lastReviewAt
                  : 0,
              tools: registeredToolNames.length,
              toolNames: [...registeredToolNames],
              openGoals: goals.filter((g) => g.status === "open").length,
              doneGoals: goals.filter((g) => g.status === "done").length,
              pendingForgets: core
                .listForgetRequests()
                .filter((r) => r.status === "pending" || r.status === "approved")
                .length,
              semantic: core.semanticStatus(),
              dataDir,
              memoryFilePresent: existsSync(join(dataDir, "MEMORY.md")),
              writeBlocked,
              warning: dataDirWarning,
            };
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
          render: (_args: unknown, value: unknown) => [
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

      // 0.4.0 item 1: mark entries invalid from now (Graphiti 双时间
      // 戳失效). Only writes validTo — in attributes.json and on the
      // incident graph edges — the log text is never touched, so an
      // invalidated memory stays readable in history and just stops
      // recalling. Gated to persona windows like the other write
      // tools; every accepted call appends one audit line (who /
      // when / which entries / why) to invalidation-audit.jsonl.
      // A refused task-window call writes nothing, audit included.
      registerTool({
        name: "memory_invalidate",
        description:
          "把几条记忆标为失效（用户改主意了，旧说法不再是现况）：以后召回直接跳过它们，但 log 里的原文还在，翻历史能查到。只在人设窗口可用。reason 必须写清楚为什么失效（比如“他后来改口说不吃辣了”）。",
        parameters: {
          entryIds: {
            type: "array",
            items: { type: "string" },
            required: true,
            description: "要失效的记忆条目 id 列表（见 memory_search 的 hits）",
          },
          reason: {
            type: "string",
            required: true,
            description: "失效原因：为什么这几条不再是现况（会写进审计日志）",
          },
        },
        output: {
          schema: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              invalidated: { type: "array" },
              unknown: { type: "array" },
              error: { type: "string" },
            },
          },
          render: (_args: unknown, value: unknown) => [
            { type: "text", text: JSON.stringify(value) },
          ],
        },
        execute: async (args: unknown, exec?: unknown) => {
          const { sid, persona } = toolSession(exec);
          if (!persona) {
            return {
              ok: false,
              invalidated: [],
              unknown: [],
              error:
                "memory_invalidate 只在人设窗口可用：当前会话不是人设窗口（没有触发夏柠柒/柠柒），本次不标失效。",
            };
          }
          const a = (args ?? {}) as {
            entryIds?: unknown;
            reason?: unknown;
          };
          const entryIds = Array.isArray(a.entryIds)
            ? a.entryIds.filter((x): x is string => typeof x === "string")
            : [];
          const reason =
            typeof a.reason === "string" ? a.reason.trim() : "";
          if (entryIds.length === 0) {
            return {
              ok: false,
              invalidated: [],
              unknown: [],
              error: "memory_invalidate 需要非空的 entryIds 列表。",
            };
          }
          if (!reason) {
            return {
              ok: false,
              invalidated: [],
              unknown: [],
              error: "memory_invalidate 需要说明原因 reason（为什么失效）。",
            };
          }
          try {
            const at = Date.now();
            const res = core.invalidateEntries(entryIds, at);
            appendInvalidationAudit({
              at,
              sessionId: sid,
              entryIds,
              reason,
              invalidated: res.invalidated,
              unknown: res.unknown,
            });
            return {
              ok: true,
              invalidated: res.invalidated,
              unknown: res.unknown,
              error: "",
            };
          } catch (err) {
            return {
              ok: false,
              invalidated: [],
              unknown: [],
              error: `失效失败：${err instanceof Error ? err.message : String(err)}`,
            };
          }
        },
      });
      // 0.4.0 item 2: evidence-backed beliefs + the three
      // dimensions (safety / trust / closeness). The model confirms
      // a review-proposed belief cluster (action "create": write
      // one sentence + pick a dimension, with one verbatim quote
      // from the log as its first evidence), strengthens it with
      // further evidence ("support") or weakens it with a
      // conflicting one ("contradict"), and reads the three
      // dimensions ("get"). The delta is the MODEL's call — how
      // strong this evidence is — so it is required for support /
      // contradict (missing delta returns an error telling the
      // model to supply it); the code only clamps a single move to
      // ±0.2 and strength to 0..1. Every quote is verified word
      // for word against the log (the memory_fragment pattern): a
      // non-verbatim quote is rejected and nothing is stored. A
      // contradict for an already-charged entry is ignored, never
      // deducted twice. Gated to persona windows like the other
      // write tools; get is a read but still persona-gated (beliefs
      // are persona memory — a task window has no business reading
      // them either).
      registerTool({
        name: "memory_belief",
        // 0.5.1 (0.4.3 §四): low-frequency tool — description
        // loads on demand (same as memory_feedback).
        deferLoading: true,
        description:
          "查/写关于你们关系的信念（带证据的三维信念：safety 安全感 / trust 信任 / closeness 亲近）。action \"get\"：返回三维当前值（每维 strength / uncertainty / proofCount）和已有信念列表，不返回原文全文。action \"create\"：确认复盘里提议的一组对话、建成一条信念——自己写一句话 statement、选一个 dimension，entryId 用那组里的 id、quote 用复盘提示词里引号中的原话（必须是逐字抄的，不能改写）；delta 可选，是初始 strength（0–1，默认 0.5）。action \"support\"：用一条新证据加强一条信念。action \"contradict\"：用一条冲突证据削弱一条信念。support / contradict 时 delta 必填（这次证据有多强，你自己按证据强度定，0–0.2 之间；超过 0.2 代码会夹到 0.2，不报错；缺了会返回错误让你补给），entryId + quote 必填，quote 必须是那条原文里逐字抄来的话，对不上就拒绝写入。同一条冲突证据只扣一次分，重复提交会被忽略。只在人设窗口可用。",
        parameters: {
          action: {
            type: "string",
            required: true,
            description: "get / create / support / contradict 之一",
          },
          beliefId: {
            type: "string",
            required: false,
            description: "support / contradict 时要动的那条信念的 id（见 get 返回的列表，如 BEL_TRUST_001）；create 时不用传",
          },
          dimension: {
            type: "string",
            required: false,
            description: "create 时信念属于哪个维度：safety / trust / closeness 之一",
          },
          statement: {
            type: "string",
            required: false,
            description: "create 时一句话信念，如“他难过时会来找我”",
          },
          entryId: {
            type: "string",
            required: false,
            description: "create / support / contradict 时证据来自哪条原文（log 条目 id）",
          },
          quote: {
            type: "string",
            required: false,
            description: "create / support / contradict 时从那条原文逐字抄来的一句话（必填，不能改写）",
          },
          delta: {
            type: "number",
            required: false,
            description: "support / contradict 时必填：这次证据有多强（0–0.2，超过 0.2 会被夹到 0.2）；create 时可选，是初始 strength（0–1，默认 0.5）",
          },
        },
        output: {
          schema: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              dimensions: { type: "object", additionalProperties: true },
              beliefs: { type: "array" },
              belief: { type: "object", additionalProperties: true },
              duplicate: { type: "boolean" },
              error: { type: "string" },
              reasons: { type: "array" },
            },
          },
          render: (_args: unknown, value: unknown) => [
            { type: "text", text: JSON.stringify(value) },
          ],
        },
        execute: async (args: unknown, exec?: unknown) => {
          const { persona } = toolSession(exec);
          if (!persona) {
            return {
              ok: false,
              error:
                "memory_belief 只在人设窗口可用：当前会话不是人设窗口（没有触发夏柠柒/柠柒），本次不读写信念。",
            };
          }
          const a = (args ?? {}) as {
            action?: unknown;
            beliefId?: unknown;
            dimension?: unknown;
            statement?: unknown;
            entryId?: unknown;
            quote?: unknown;
            delta?: unknown;
          };
          const action = typeof a.action === "string" ? a.action : "";
          const beliefId = typeof a.beliefId === "string" ? a.beliefId : "";
          const dimension = typeof a.dimension === "string" ? a.dimension : "";
          const statement = typeof a.statement === "string" ? a.statement : "";
          const entryId = typeof a.entryId === "string" ? a.entryId : "";
          const quote = typeof a.quote === "string" ? a.quote : "";
          const delta =
            typeof a.delta === "number" ? (a.delta as number) : undefined;
          if (action === "get") {
            try {
              return {
                ok: true,
                dimensions: core.beliefSummary(),
                beliefs: core.listBeliefs().map((b) => ({
                  id: b.id,
                  dimension: b.dimension,
                  statement: b.statement,
                  strength: b.strength,
                  uncertainty: b.uncertainty,
                  proofCount: b.proofCount,
                })),
              };
            } catch (err) {
              return {
                ok: false,
                error: `读取失败：${err instanceof Error ? err.message : String(err)}`,
              };
            }
          }
          if (action === "create") {
            if (
              dimension !== "safety" &&
              dimension !== "trust" &&
              dimension !== "closeness"
            ) {
              return {
                ok: false,
                error:
                  "memory_belief create 需要 dimension：safety / trust / closeness 之一。",
              };
            }
            if (!statement.trim()) {
              return {
                ok: false,
                error: "memory_belief create 需要一句话 statement，不能为空。",
              };
            }
            if (!entryId) {
              return {
                ok: false,
                error:
                  "memory_belief create 需要 entryId：第一条证据来自哪条原文。",
              };
            }
            if (!quote.trim()) {
              return {
                ok: false,
                error:
                  "memory_belief create 需要 quote：从那条原文逐字抄来的一句话，不能改写。",
              };
            }
            try {
              const res = core.createBelief({
                dimension,
                statement,
                strength: delta,
                entryId,
                quote,
              });
              if (!res.ok || !res.belief) {
                return { ok: false, error: "信念被拒绝，未保存。", reasons: res.reasons };
              }
              return { ok: true, belief: res.belief };
            } catch (err) {
              return {
                ok: false,
                error: `写入失败：${err instanceof Error ? err.message : String(err)}`,
              };
            }
          }
          if (action === "support" || action === "contradict") {
            if (!beliefId) {
              return {
                ok: false,
                error: `memory_belief ${action} 需要 beliefId（见 get 返回的列表）。`,
              };
            }
            if (!entryId) {
              return {
                ok: false,
                error: `memory_belief ${action} 需要 entryId：这次证据来自哪条原文。`,
              };
            }
            if (!quote.trim()) {
              return {
                ok: false,
                error: `memory_belief ${action} 需要 quote：从那条原文逐字抄来的一句话，不能改写。`,
              };
            }
            if (delta === undefined) {
              return {
                ok: false,
                error:
                  `memory_belief ${action} 需要 delta：这次证据有多强，你自己按证据强度定一个 0–0.2 之间的数（强证据多给、弱证据少给），再调一次。`,
              };
            }
            try {
              const res =
                action === "support"
                  ? core.supportBelief(beliefId, entryId, quote, delta)
                  : core.contradictBelief(beliefId, entryId, quote, delta);
              if (!res.ok || !res.belief) {
                return { ok: false, error: "信念调整被拒绝，未保存。", reasons: res.reasons };
              }
              return {
                ok: true,
                belief: res.belief,
                duplicate: res.duplicate === true,
              };
            } catch (err) {
              return {
                ok: false,
                error: `写入失败：${err instanceof Error ? err.message : String(err)}`,
              };
            }
          }
          return {
            ok: false,
            error:
              "memory_belief 的 action 只能是 get / create / support / contradict 之一。",
          };
        },
      });

      // 0.4.0 item 3: reflection trigger (Generative Agents 反思).
      // Two modes, one tool — the gate call takes NO parameters
      // (the spec's {}), the save call carries the conclusion:
      // - Gate: call with {} — the code checks only the tiny
      //   anti-disturbance floor (last 24 h of new persona
      //   memories' significance sum < 5: {triggered: false}, no
      //   prompt is built, no model is called). Above the floor
      //   it returns {triggered: true, text: <reflection prompt>}
      //   and the MODEL decides whether to reflect and what to
      //   conclude — the code never blocks it above the floor,
      //   and there is no score threshold for reflecting.
      // - Save: call with {text, sourceIds} after deciding to
      //   reflect — the conclusion is saved as a type:
      //   "reflection" fragment (fragments.json), after the code
      //   verifies every 「」-quoted phrase verbatim against the
      //   sources. A quote that is not verbatim voids the whole
      //   reflection (nothing is stored, reasons come back);
      //   below the floor the save is refused outright. The
      //   insight's own new words are never checked — they are
      //   the conclusion, not a citation. The save parameters are
      //   declared optional in the schema below (the gate call
      //   still passes {} and never saves anything), so a strict
      //   host that strips undeclared parameters still forwards
      //   them on the save call.
      // Gated to persona windows like the other write tools; a
      // task-window call reads and writes nothing.
      registerTool({
        name: "memory_reflect",
        // 0.5.1 (0.4.3 §四): low-frequency tool — description
        // loads on demand (same as memory_feedback).
        deferLoading: true,
        description:
          "反思触发器：先问 24 小时里有没有新的 persona 记忆，再由你自己决定要不要反思。两种用法：① 只传 {} 查一下——24 小时内没有新的 persona 记忆时返回 {triggered: false}，这时不用反思；有则返回 {triggered: true, text: 反思提示词}，提示词里是最近 24 小时的原文，你自己判断有没有新发现、要不要反思、反思出什么结论，代码不拦你；② 决定反思后，再调一次 memory_reflect，把结论（text，一句就行）和来源 id（sourceIds）传回来保存：来源必须是提示词里给的那几条原文的 id，拿提示词之外的条目当来源会被拒绝；结论里引用的每一句话都要用「」括起来、从原文逐字抄，不能改写，引不上原文的整条作废、不保存；结论自己的新词不用和原文一字不差，那是你看出来的新东西。保存成功返回 {triggered: true, reflectionId, text}。只在人设窗口可用。",
        parameters: {
          text: {
            type: "string",
            required: false,
            description: "保存反思时才传：你看出来的结论，一句就行，结论里引用的每一句话用「」括起来、从原文逐字抄；只查门控时不传",
          },
          sourceIds: {
            type: "array",
            items: { type: "string" },
            required: false,
            description: "保存反思时才传：结论是从哪几条原文看出来的，来源条目 id 列表（见提示词里的 id）；只查门控时不传",
          },
        },
        output: {
          schema: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              triggered: { type: "boolean" },
              reflectionId: { type: "string" },
              text: { type: "string" },
              error: { type: "string" },
              reasons: { type: "array" },
            },
          },
          render: (_args: unknown, value: unknown) => [
            { type: "text", text: JSON.stringify(value) },
          ],
        },
        execute: async (args: unknown, exec?: unknown) => {
          const { persona } = toolSession(exec);
          if (!persona) {
            return {
              ok: false,
              triggered: false,
              error:
                "memory_reflect 只在人设窗口可用：当前会话不是人设窗口（没有触发夏柠柒/柠柒），本次不反思、不保存。",
            };
          }
          const a = (args ?? {}) as {
            text?: unknown;
            sourceIds?: unknown;
          };
          const text = typeof a.text === "string" ? a.text : "";
          const sourceIds = Array.isArray(a.sourceIds)
            ? a.sourceIds.filter((x): x is string => typeof x === "string")
            : [];
          // Save mode: the model decided to reflect and hands back
          // its conclusion. The citable sources are the SNAPSHOT
          // of the gate prompt the model was shown (0.4.3:
          // core.reflectionGateSnapshot()), not a freshly
          // recomputed gate — a source that crossed the 24 h
          // boundary while the model was thinking must not be
          // refused for arriving late. No snapshot (the model
          // never asked the gate, or the last gate was below the
          // floor) falls back to a fresh check, which refuses
          // below the floor exactly as before.
          if (text.trim().length > 0) {
            const snapshot = core.reflectionGateSnapshot();
            let allowed: Set<string>;
            if (snapshot && snapshot.length > 0) {
              allowed = new Set(snapshot);
            } else {
              const check = core.reflectionCheck();
              if (!check.reached) {
                return {
                  ok: false,
                  triggered: false,
                  error:
                    "24 小时内没有新的 persona 记忆，这次不反思、不保存。",
                };
              }
              allowed = new Set(check.sourceIds ?? []);
            }
            if (sourceIds.length === 0) {
              return {
                ok: false,
                triggered: true,
                error:
                  "memory_reflect 保存反思需要 sourceIds：结论是从哪几条原文看出来的（见提示词里的 id），再调一次传回来。",
              };
            }
            // 0.4.1 follow-up (0.4.3: against the gate SNAPSHOT,
            // not a fresh check — see above): sources must come
            // from the gate prompt just issued. A conclusion
            // citing an old batch or another set of entries is
            // refused before anything is stored, even if the
            // quotes happen to check out: a reflection must be
            // grounded in the memories the model was actually
            // shown, not in any entry it can name.
            const outside = sourceIds.filter((id) => !allowed.has(id));
            if (outside.length > 0) {
              return {
                ok: false,
                triggered: true,
                error: `memory_reflect 保存被拒绝：来源 ${outside.slice(0, 5).join("、")} 不在本次反思提示里——结论只能引用提示词里给的那几条原文的 id，请按提示词里的 id 重新传。`,
              };
            }
            try {
              const res = core.saveReflection(text, sourceIds);
              if (!res.ok || !res.fragment) {
                return {
                  ok: false,
                  triggered: true,
                  error: "反思被拒绝，未保存。",
                  reasons: res.reasons,
                };
              }
              return {
                ok: true,
                triggered: true,
                reflectionId: res.fragment.id,
                text: res.fragment.text,
              };
            } catch (err) {
              return {
                ok: false,
                triggered: true,
                error: `保存失败：${err instanceof Error ? err.message : String(err)}`,
              };
            }
          }
          // Gate mode (params {}): below the floor, no prompt and
          // no model call — triggered: false, nothing else. Above
          // it, hand the model the prompt; it decides.
          try {
            const check = core.reflectionCheck();
            if (!check.reached) return { ok: true, triggered: false };
            return { ok: true, triggered: true, text: check.prompt ?? "" };
          } catch (err) {
            return {
              ok: false,
              triggered: false,
              error: `触发判断失败：${err instanceof Error ? err.message : String(err)}`,
            };
          }
        },
      });

      registerTool({
        name: "memory_proact",
        // 0.5.1 (0.4.3 §四): low-frequency tool — description
        // loads on demand (same as memory_feedback).
        deferLoading: true,
        description:
          "行为回流·会话内主动：她自己决定要不要主动找他说句话。两种用法：① 只传 {} 查一下——今天已经主动过一次时返回 {action: null, reason}，不要再问模型；还没主动过时返回 {action: null, prompt: 主动提示词, promptToken}，提示词里是今天的记忆、信念和反思，你自己掂量该不该打扰、现在说合不合适，不要为了主动而主动，不行动完全可以；② 决定行动后，再调一次 memory_proact，把决定交回来（act: true，judgment 一句话为什么、actionText 你想说的话用你自己的话写、trigger 触发它的记忆或信念 id，只能用提示词里的 id，还要带上 gate 调用返回的 promptToken——没有它或过期了都存不进去；决定不行动就交 act: false，也带上 promptToken，好让这次提示作废）：代码再过一次护栏，通过了就存进 loop.json，返回 {action}，你再在聊天里用自己的话把 actionText 说出来；护栏不过或解析失败返回 {action: null}，不行动。channel 现在只允许 \"session\"，传 \"qq\" 返回错误 qq_not_connected（QQ 还没接）。只在人设窗口可用。",
        parameters: {
          act: {
            type: "boolean",
            required: false,
            description: "决定行动时才传：true 行动，false 不行动；只查门控时不传",
          },
          judgment: {
            type: "string",
            required: false,
            description: "决定行动时才传：为什么现在该主动，一句话，你自己写的判断",
          },
          actionText: {
            type: "string",
            required: false,
            description: "决定行动时才传：你想对他说的话，用你自己的话写，不要用固定套话",
          },
          trigger: {
            type: "string",
            required: false,
            description: "决定行动时才传：触发这次行动的记忆 id 或信念 id，只能用提示词里的 id，不要编",
          },
          promptToken: {
            type: "string",
            required: false,
            description: "gate 调用返回的 promptToken；交决定时必须带上（act: false 也带，好让这次提示作废）；没带、带错或超过 15 分钟都存不进去",
          },
          channel: {
            type: "string",
            required: false,
            description: "投递渠道，默认 \"session\"（在聊天里说出来）；\"qq\" 还没接，传了返回错误 qq_not_connected",
          },
        },
        output: {
          schema: {
            // 0.5.5-real-dsh fix: gate replies carry action: null,
            // so a closed object property would reject them. The
            // whole output is a free object on purpose.
            type: "object",
            additionalProperties: true,
          },
          render: (_args: unknown, value: unknown) => [
            { type: "text", text: JSON.stringify(value) },
          ],
        },
        execute: async (args: unknown, exec?: unknown) => {
          const { persona } = toolSession(exec);
          if (!persona) {
            return {
              ok: false,
              action: null,
              error:
                "memory_proact 只在人设窗口可用：当前会话不是人设窗口（没有触发夏柠柒/柠柒），本次不主动、不保存。",
            };
          }
          const a = (args ?? {}) as {
            act?: unknown;
            judgment?: unknown;
            actionText?: unknown;
            trigger?: unknown;
            promptToken?: unknown;
            channel?: unknown;
          };
          // Channel is "session" only for now — "qq" is the
          // placeholder for the future QQ wiring: it errors here
          // and never reaches the store, so no qq action can ever
          // be saved by mistake.
          const channel =
            typeof a.channel === "string" ? a.channel : "session";
          if (channel === "qq") {
            return { ok: false, action: null, error: "qq_not_connected" };
          }
          if (channel !== "session") {
            return {
              ok: false,
              action: null,
              error:
                "memory_proact 的 channel 现在只允许 \"session\"（\"qq\" 还没接）。",
            };
          }
          const promptToken =
            typeof a.promptToken === "string" ? a.promptToken : undefined;
          // Decision mode: the model hands its decision back (the
          // fields are the decision itself — parseProactDecision
          // reads them straight off the args object). act: false
          // or an unparseable decision means "do nothing": no
          // action, no crash, no retry, no fallback line. An
          // explicit act:false also voids the prompt token it
          // carried, so the prompt can never be answered twice.
          const hasDecision =
            typeof a.act === "boolean" ||
            typeof a.judgment === "string" ||
            typeof a.actionText === "string" ||
            typeof a.trigger === "string";
          if (hasDecision) {
            const decision = parseProactDecision(a);
            if (!decision) {
              return { ok: true, action: null };
            }
            if (decision.act === false) {
              if (promptToken) core.discardProactPrompt(promptToken);
              return { ok: true, action: null };
            }
            try {
              // Daily quota first (no token): a day already spent
              // is refused with the daily-limit reason, whatever
              // token the call carries.
              const guard = core.proactCheck(
                decision.trigger ?? "",
                Date.now(),
              );
              if (!guard.ok) {
                return { ok: true, action: null, reason: guard.reason };
              }
              // Then the token: a decision must answer the prompt
              // it was given, inside its 15-minute TTL.
              if (!promptToken) {
                return {
                  ok: true,
                  action: null,
                  reason: "proact_prompt_not_found",
                };
              }
              const saved = core.proactSave(
                decision,
                "session",
                Date.now(),
                promptToken,
              );
              if (!saved.ok || !saved.action) {
                return {
                  ok: true,
                  action: null,
                  reason: saved.reason ?? "保存失败，本次不行动。",
                };
              }
              // deliver() is the channel seam: session hands the
              // model's own words back for her to say in the chat.
              return {
                ok: true,
                action: saved.action,
                text: deliver(saved.action),
              };
            } catch (err) {
              return {
                ok: false,
                action: null,
                error: `保存失败：${err instanceof Error ? err.message : String(err)}`,
              };
            }
          }
          // Gate mode (params {}): the guardrail runs FIRST — a
          // refusal costs no model call, so no prompt is built.
          // Otherwise hand the model the prompt and its token; it
          // decides. Issuing the prompt writes no lastJudgedAt
          // and consumes no daily quota — only the token is
          // recorded, so the decision can be bound to this
          // prompt.
          try {
            const prepared = core.prepareProactPrompt(Date.now());
            if (!prepared.prompted) {
              return { ok: true, action: null, reason: prepared.reason };
            }
            if (!prepared.prompt) return { ok: true, action: null };
            return {
              ok: true,
              action: null,
              prompt: prepared.prompt,
              promptToken: prepared.promptToken,
            };
          } catch (err) {
            return {
              ok: false,
              action: null,
              error: `触发判断失败：${err instanceof Error ? err.message : String(err)}`,
            };
          }
        },
      });

      // 0.5.0 step 4: user feedback on a recalled memory — correct /
      // wrong / irrelevant. Tool only, no UI. Wrong invalidates the
      // entry (same path as memory_invalidate, with an audit line);
      // irrelevant demotes it in later recall (ranking halves, and
      // significance halves); correct counts as a verification
      // (a named fragment's provenance verifyCount + 1).
      // deferLoading: the description loads on demand, not into
      // every request's system prompt (17 tools now cost ~3–4k
      // tokens/round). The flag is passed through untouched by both
      // compilers (define-tool.ts spreads the spec); there is NO
      // local copy of dsh-tools to verify the flag name against
      // the host version — that needs a real-DSH check — so the
      // description below is kept to one short line as the real
      // mitigation: even if the host ignores the flag, this tool
      // costs one line. Gated to persona windows like the other
      // write tools.
      registerTool({
        name: "memory_feedback",
        deferLoading: true,
        description:
          "对刚才召回的某条记忆给反馈：correct 对了 / wrong 错了 / irrelevant 不相关。wrong 会让它失效，irrelevant 会降权，correct 记一次验证。如果这条是“印象”（注入块最上面那句你对他的判断），用户一句话否定了它（“我没焦虑”“我不累”），就直接传 impressionId + wrong，这条印象立刻作废、以后不再用。",
        parameters: {
          entryId: {
            type: "string",
            required: false,
            description: "记忆条目 id（见 memory_search 的 hits）；只压印象时可只传 impressionId",
          },
          feedback: {
            type: "string",
            required: true,
            description: "correct / wrong / irrelevant 之一",
          },
          impressionId: {
            type: "string",
            required: false,
            description: "印象的 id（注入块里那条判断的 id，或 memory_search 的印象 id）。用户一句话否定它时传这个 + wrong，印象立刻作废。",
          },
          fragmentId: {
            type: "string",
            required: false,
            description: "命中带的 fragmentId（有就传，片段也会跟着改：对了记一次验证，错了标存疑）",
          },
          reason: {
            type: "string",
            required: false,
            description: "为什么错 / 为什么不相关，一句话（错了会进审计日志）",
          },
        },
        output: {
          schema: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              entryId: { type: "string" },
              feedback: { type: "string" },
              invalidated: { type: "array" },
              significance: { type: "number" },
              impressionRejected: { type: "boolean" },
              counts: { type: "object", additionalProperties: true },
              error: { type: "string" },
            },
          },
          render: (_args: unknown, value: unknown) => [
            { type: "text", text: JSON.stringify(value) },
          ],
        },
        execute: async (args: unknown, exec?: unknown) => {
          const { sid, persona } = toolSession(exec);
          if (!persona) {
            return {
              ok: false,
              entryId: "",
              feedback: "",
              invalidated: [],
              error:
                "memory_feedback 只在人设窗口可用：当前会话不是人设窗口（没有触发夏柠柒/柠柒），本次不改记忆。",
            };
          }
          const a = (args ?? {}) as {
            entryId?: unknown;
            feedback?: unknown;
            impressionId?: unknown;
            fragmentId?: unknown;
            reason?: unknown;
          };
          const entryId =
            typeof a.entryId === "string" ? a.entryId : "";
          const feedback =
            typeof a.feedback === "string" ? a.feedback : "";
          const impressionId =
            typeof a.impressionId === "string" && a.impressionId.length > 0
              ? a.impressionId
              : undefined;
          const fragmentId =
            typeof a.fragmentId === "string" && a.fragmentId.length > 0
              ? a.fragmentId
              : undefined;
          const reason =
            typeof a.reason === "string" ? a.reason : undefined;
          if (!entryId && !impressionId) {
            return {
              ok: false,
              entryId: "",
              feedback,
              invalidated: [],
              error:
                "memory_feedback 需要 entryId（见 memory_search 的 hits）或 impressionId（印象）之一。",
            };
          }
          if (
            feedback !== "correct" &&
            feedback !== "wrong" &&
            feedback !== "irrelevant"
          ) {
            return {
              ok: false,
              entryId,
              feedback,
              invalidated: [],
              error:
                "memory_feedback 的 feedback 只能是 correct / wrong / irrelevant 之一。",
            };
          }
          try {
            const res = core.applyFeedback({
              entryId: entryId || undefined,
              kind: feedback,
              fragmentId,
              impressionId,
              reason,
            });
            if (!res.ok) {
              return {
                ok: false,
                entryId,
                feedback,
                invalidated: [],
                error: res.reason ?? "反馈失败。",
              };
            }
            if (res.invalidated.length > 0) {
              appendInvalidationAudit({
                at: Date.now(),
                sessionId: sid,
                entryIds: res.invalidated,
                reason: `memory_feedback wrong${reason ? `：${reason}` : ""}`,
                invalidated: res.invalidated,
                unknown: [],
              });
            }
            return {
              ok: true,
              entryId,
              feedback,
              invalidated: res.invalidated,
              significance: res.significance,
              impressionRejected: res.impressionRejected,
              counts: res.feedback,
            };
          } catch (err) {
            return {
              ok: false,
              entryId,
              feedback,
              invalidated: [],
              error: `反馈失败：${err instanceof Error ? err.message : String(err)}`,
            };
          }
        },
      });
      // 0.5.1 item 1: forgetting — the model may FILE a request
      // and dry-run it, nothing more. There is deliberately NO
      // approve / execute action here: forgetting is authorised
      // only on a non-model channel (the admin CLI `memory-admin
      // forget approve|execute`, or the local admin API). A chat
      // "我同意" can never approve a forgetting — the approval
      // record can only be written by the CLI / API, and
      // core.approve() refuses any other channel.
      registerTool({
        name: "memory_forget",
        deferLoading: true,
        description:
          "申请遗忘某条记忆（hide 藏起来可恢复 / delete 物理删除）：request 提交申请并返回干跑预览，dry-run 只看会动到什么、什么都不改，list 看待处理的申请。注意：提交只是申请，删/藏要等管理中心（命令行或本地接口）批准后才会执行，聊天里说“我同意”不算批准；这个工具没有批准和执行操作。",
        parameters: {
          action: {
            type: "string",
            required: true,
            description: "request / dry-run / list 之一",
          },
          mode: {
            type: "string",
            required: false,
            description: "hide 或 delete（request 时必填）",
          },
          entryIds: {
            type: "array",
            items: { type: "string" },
            required: false,
            description: "要遗忘的记忆条目 id 列表（见 memory_search 的 hits）",
          },
          reason: {
            type: "string",
            required: false,
            description: "为什么遗忘，一句话（进审计日志）",
          },
        },
        output: {
          schema: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              requestId: { type: "string" },
              status: { type: "string" },
              preview: { type: "object", additionalProperties: true },
              requests: { type: "array" },
              note: { type: "string" },
              error: { type: "string" },
            },
          },
          render: (_args: unknown, value: unknown) => [
            { type: "text", text: JSON.stringify(value) },
          ],
        },
        execute: async (args: unknown, exec?: unknown) => {
          const { persona } = toolSession(exec);
          if (!persona) {
            return {
              ok: false,
              error:
                "memory_forget 只在人设窗口可用：当前会话不是人设窗口（没有触发夏柠柒/柠柒）。",
            };
          }
          const a = (args ?? {}) as {
            action?: unknown;
            mode?: unknown;
            entryIds?: unknown;
            reason?: unknown;
          };
          const action = typeof a.action === "string" ? a.action : "";
          try {
            if (action === "list") {
              return { ok: true, requests: core.listForgetRequests() };
            }
            if (action === "dry-run") {
              const ids = Array.isArray(a.entryIds)
                ? (a.entryIds as unknown[]).filter(
                    (x): x is string => typeof x === "string",
                  )
                : [];
              if (ids.length === 0) {
                return { ok: false, error: "dry-run 需要 entryIds。" };
              }
              return { ok: true, preview: core.dryRunForget(ids) };
            }
            if (action === "request") {
              if (a.mode !== "hide" && a.mode !== "delete") {
                return {
                  ok: false,
                  error: 'request 需要 mode 为 hide 或 delete。',
                };
              }
              const ids = Array.isArray(a.entryIds)
                ? (a.entryIds as unknown[]).filter(
                    (x): x is string => typeof x === "string",
                  )
                : [];
              if (ids.length === 0) {
                return { ok: false, error: "request 需要 entryIds。" };
              }
              const req = core.requestForget({
                mode: a.mode,
                entryIds: ids,
                reason:
                  typeof a.reason === "string" ? a.reason : undefined,
                createdBy: "model",
              });
              return {
                ok: true,
                requestId: req.id,
                status: req.status,
                preview: core.dryRunForget(ids),
                note: "申请已提交，等待管理中心（命令行 memory-admin forget approve / 本地接口）批准后才会执行；聊天里说“我同意”不算批准。",
              };
            }
            return {
              ok: false,
              error: "action 只能是 request / dry-run / list。",
            };
          } catch (err) {
            return {
              ok: false,
              error: `遗忘申请失败：${err instanceof Error ? err.message : String(err)}`,
            };
          }
        },
      });

      // 0.5.1 item 5: goals / todos — the model reads the open
      // ones, creates them when the user states an aim, and marks
      // them done / dropped when the user says so. Gated to
      // persona windows like the other write tools.
      registerTool({
        name: "memory_goal",
        deferLoading: true,
        description:
          "目标/待办：create 建目标，list 看目标（带完成状态），complete 完成，reopen 重新打开，drop 放弃，remove 删除，update 改标题/截止/备注。只在人设窗口可用。",
        parameters: {
          action: {
            type: "string",
            required: true,
            description:
              "create / list / get / update / complete / reopen / drop / remove 之一",
          },
          goalId: {
            type: "string",
            required: false,
            description: "目标 id（list 以外必填，见 list 的返回）",
          },
          title: {
            type: "string",
            required: false,
            description: "目标标题（create 时必填）",
          },
          status: {
            type: "string",
            required: false,
            description: "list 时按状态过滤：open / done / dropped",
          },
          dueAt: {
            type: "number",
            required: false,
            description: "截止时间，毫秒时间戳（可选）",
          },
          notes: {
            type: "string",
            required: false,
            description: "备注（可选）",
          },
        },
        output: {
          schema: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              goal: { type: "object", additionalProperties: true },
              goals: { type: "array" },
              removed: { type: "boolean" },
              error: { type: "string" },
            },
          },
          render: (_args: unknown, value: unknown) => [
            { type: "text", text: JSON.stringify(value) },
          ],
        },
        execute: async (args: unknown, exec?: unknown) => {
          const { persona } = toolSession(exec);
          if (!persona) {
            return {
              ok: false,
              error:
                "memory_goal 只在人设窗口可用：当前会话不是人设窗口（没有触发夏柠柒/柠柒）。",
            };
          }
          const a = (args ?? {}) as {
            action?: unknown;
            goalId?: unknown;
            title?: unknown;
            status?: unknown;
            dueAt?: unknown;
            notes?: unknown;
          };
          const action = typeof a.action === "string" ? a.action : "";
          const goalId = typeof a.goalId === "string" ? a.goalId : "";
          try {
            if (action === "list") {
              const status =
                a.status === "open" || a.status === "done" || a.status === "dropped"
                  ? a.status
                  : undefined;
              const goals = core.goals.all();
              return {
                ok: true,
                goals: status ? goals.filter((g) => g.status === status) : goals,
              };
            }
            if (action === "create") {
              if (typeof a.title !== "string" || a.title.trim().length === 0) {
                return { ok: false, error: "create 需要非空 title。" };
              }
              return {
                ok: true,
                goal: core.createGoal({
                  title: a.title,
                  ...(typeof a.dueAt === "number" ? { dueAt: a.dueAt } : {}),
                  ...(typeof a.notes === "string" ? { notes: a.notes } : {}),
                }),
              };
            }
            if (!goalId) {
              return { ok: false, error: "这个操作需要 goalId。" };
            }
            if (action === "get") {
              const g = core.goals.get(goalId);
              if (!g) return { ok: false, error: `no goal ${goalId}` };
              return { ok: true, goal: g };
            }
            if (action === "complete" || action === "reopen" || action === "drop") {
              const g = core.setGoalStatus(
                goalId,
                action === "complete" ? "done" : action === "reopen" ? "open" : "dropped",
              );
              if (!g) return { ok: false, error: `no goal ${goalId}` };
              return { ok: true, goal: g };
            }
            if (action === "update") {
              const g = core.updateGoal(goalId, {
                ...(typeof a.title === "string" ? { title: a.title } : {}),
                ...(typeof a.dueAt === "number" ? { dueAt: a.dueAt } : {}),
                ...(typeof a.notes === "string" ? { notes: a.notes } : {}),
              });
              if (!g) return { ok: false, error: `no goal ${goalId}` };
              return { ok: true, goal: g };
            }
            if (action === "remove") {
              return { ok: true, removed: core.removeGoal(goalId) };
            }
            return {
              ok: false,
              error:
                "action 只能是 create / list / get / update / complete / reopen / drop / remove。",
            };
          } catch (err) {
            return {
              ok: false,
              error: `目标操作失败：${err instanceof Error ? err.message : String(err)}`,
            };
          }
        },
      });

      // 0.5.1 item 4: experience learning — record a rule learned
      // from a mistake (with its trigger and source), list them,
      // or match them against a question. Gated to persona
      // windows like the other write tools.
      registerTool({
        name: "memory_experience",
        deferLoading: true,
        description:
          "经验：从做错的事里学规矩。add 把一条教训写成可复用的经验（rule 一两句话 + trigger 触发词 + source 哪错的），list 看全部经验，match 看某句话会触发哪条经验。只在人设窗口可用。",
        parameters: {
          action: {
            type: "string",
            required: true,
            description: "add / list / match 之一",
          },
          rule: {
            type: "string",
            required: false,
            description: "经验规则，一两句话（add 时必填）",
          },
          trigger: {
            type: "array",
            items: { type: "string" },
            required: false,
            description: "触发词列表（add 时必填）",
          },
          source: {
            type: "string",
            required: false,
            description: "哪错的、在哪错的（add 时必填）",
          },
          sourceIds: {
            type: "array",
            items: { type: "string" },
            required: false,
            description: "来源记忆 id（add 时必填，必须是人设窗口、未隐藏的真实条目）",
          },
          id: {
            type: "string",
            required: false,
            description: "经验 id（confirm 时必填）",
          },
          query: {
            type: "string",
            required: false,
            description: "要匹配的问题（match 时必填）",
          },
        },
        output: {
          schema: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              experience: { type: "object", additionalProperties: true },
              experiences: { type: "array" },
              matched: { type: "array" },
              error: { type: "string" },
            },
          },
          render: (_args: unknown, value: unknown) => [
            { type: "text", text: JSON.stringify(value) },
          ],
        },
        execute: async (args: unknown, exec?: unknown) => {
          const { persona } = toolSession(exec);
          if (!persona) {
            return {
              ok: false,
              error:
                "memory_experience 只在人设窗口可用：当前会话不是人设窗口（没有触发夏柠柒/柠柒）。",
            };
          }
          const a = (args ?? {}) as {
            action?: unknown;
            rule?: unknown;
            trigger?: unknown;
            source?: unknown;
            sourceIds?: unknown;
            id?: unknown;
            query?: unknown;
          };
          const action = typeof a.action === "string" ? a.action : "";
          try {
            if (action === "list") {
              return { ok: true, experiences: core.experiences.all() };
            }
            if (action === "match") {
              if (typeof a.query !== "string" || a.query.length === 0) {
                return { ok: false, error: "match 需要 query。" };
              }
              return {
                ok: true,
                matched: core.experiences.match(a.query, 5, true).map((m) => ({
                  id: m.experience.id,
                  rule: m.experience.rule,
                  source: m.experience.source,
                  verified: m.experience.verified,
                  score: m.score,
                })),
              };
            }
            if (action === "confirm") {
              return {
                ok: false,
                error:
                  "confirm 只能由用户通过 admin CLI 或本地管理 API 执行；模型工具不能给自己写的经验盖章。",
              };
            }
            if (action === "add") {
              if (typeof a.rule !== "string" || a.rule.trim().length === 0) {
                return { ok: false, error: "add 需要非空 rule。" };
              }
              if (typeof a.source !== "string" || a.source.trim().length === 0) {
                return { ok: false, error: "add 需要 source（哪错的）。" };
              }
              const trigger = Array.isArray(a.trigger)
                ? (a.trigger as unknown[]).filter(
                    (x): x is string => typeof x === "string",
                  )
                : [];
              if (trigger.length === 0) {
                return { ok: false, error: "add 需要至少一个 trigger。" };
              }
              const sourceIds = Array.isArray(a.sourceIds)
                ? (a.sourceIds as unknown[]).filter(
                    (x): x is string => typeof x === "string" && x.length > 0,
                  )
                : [];
              if (sourceIds.length === 0) {
                return {
                  ok: false,
                  error:
                    "add 需要 sourceIds：先 memory_search 找到那条真实记忆，再把 id 传进来；没有来源的经验不能注入。",
                };
              }
              const found = core.entriesByIds(sourceIds);
              if (found.length !== sourceIds.length) {
                return { ok: false, error: "sourceIds 里有不存在的记忆 id。" };
              }
              if (
                found.some(
                  (e) => e.window !== "persona" || core.forget.isForgotten(e.id),
                )
              ) {
                return {
                  ok: false,
                  error: "sourceIds 必须是未隐藏的人设窗口记忆。",
                };
              }
              return {
                ok: true,
                experience: core.recordExperience({
                  rule: a.rule,
                  trigger,
                  source: a.source,
                  sourceIds,
                }),
              };
            }
            return { ok: false, error: "action 只能是 add / list / match。" };
          } catch (err) {
            return {
              ok: false,
              error: `经验操作失败：${err instanceof Error ? err.message : String(err)}`,
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
