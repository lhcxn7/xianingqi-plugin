// Behaviour loop (0.4.0 item 7): session-local proactivity.
//
// The plugin used to be passive — it only recorded and recalled,
// never acted. The loop closes it: "self → judgement → behaviour
// → new experience → back into the sea". This file is the
// session-local version (she raises a topic / reminds him inside
// the chat); when QQ is wired up, only the delivery channel
// changes — judgement and write-back stay exactly as they are.
//
// De-mechanisation (2026-11-09): judge() is NOT a code rule. When
// to act, and what to say, is the MODEL's call, weighed against
// the day's memories, beliefs and reflections. The code keeps
// only hard guardrails (pure arithmetic, never judgement):
// at most one action a day, no repeat of the same trigger within
// 7 days, at most 3 pending actions (full → oldest is dropped).
// The guardrail runs FIRST, before the model is even asked, so a
// refused day costs no model call.
//
// 0.4.1 merge (items 2 + 4): the prompt the model decides from is
// bound to a short-lived token, and the 7-day trigger cooldown no
// longer depends on the action still sitting pending/done:
//  - issuing a prompt stores `pendingPrompt` (token + the source
//    ids shown in that prompt, 15-minute TTL). A decision must
//    carry the token of the prompt it answers, and its trigger
//    must be one of that prompt's sourceIds. Issuing a prompt
//    writes no `lastJudgedAt` and consumes no daily quota.
//  - every stored action (act:true only) appends its trigger to
//    `recentTriggers` (kept to the latest 100), so a trigger
//    whose action was dropped when the pending list filled up is
//    still cooled for 7 days.
//
// No fixed template sentences live in this file. `actionText`
// comes only from the model's return; `judgment` too. The code
// never invents a line for her to say — a parse failure is
// "do nothing", never a fallback sentence.
//
// No fixed template sentences live in this file. `actionText`
// comes only from the model's return; `judgment` too. The code
// never invents a line for her to say — a parse failure is
// "do nothing", never a fallback sentence.
//
// loop.json holds loop STATE only (which actions exist, their
// status, when the last judgement ran) — never chat text. The
// user's reply to an action goes back into log.jsonl like any
// ordinary message (recordOutcome), so the loop really closes:
// next time she knows he listened.

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteText } from "./atomic.ts";
import { formatDate, formatTime } from "./dates.ts";
import type { Fragment } from "./fragments.ts";
import {
  RECENT_MAX_CHARS,
  RECENT_MAX_ENTRIES,
  selectCappedEntries,
} from "./model-review.ts";
import type { Belief, MemoryEntry } from "./types.ts";

export const LOOP_FILE = "loop.json";
/** At most this many actions may sit pending. A new one past the
 *  cap drops the oldest pending (status "dropped", record kept). */
export const LOOP_MAX_PENDING = 3;
/** The same trigger may not fire again inside this window. */
export const LOOP_TRIGGER_REPEAT_MS = 7 * 24 * 60 * 60 * 1000;
/** Same window, named for the recentTriggers list that enforces
 *  it (dropped actions included — see checkGuardrails). */
export const LOOP_TRIGGER_COOLDOWN_MS = LOOP_TRIGGER_REPEAT_MS;
/** A prompt token is good for this long after it is issued. */
export const PROACT_PROMPT_TTL_MS = 15 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export type ProactChannel = "session" | "qq";

/** One pending / done / dropped proactive action. The text is the
 *  model's own wording — never a template, never written by code. */
export interface PendingAction {
  id: string;
  /** The memory id or belief id that triggered it. */
  trigger: string;
  /** One sentence, model-written: why now. */
  judgment: string;
  /** What she wants to say, model-written. */
  actionText: string;
  /** Delivery channel, default "session". */
  channel: ProactChannel;
  status: "pending" | "done" | "dropped";
  createdAt: number;
}

/** One issued proactivity prompt, waiting for the model's
 *  decision. `token` binds the decision to this exact prompt;
 *  `sourceIds` are the memory / belief / reflection ids the
 *  prompt showed, so a decision's trigger can be checked
 *  against them; `issuedAt` starts the 15-minute TTL. Only one
 *  prompt is ever outstanding — issuing a new one replaces it.
 *  It is not a quota: issuing a prompt writes no
 *  `lastJudgedAt` and stores no action. */
export interface PendingPrompt {
  token: string;
  sourceIds: string[];
  issuedAt: number;
}

/** Loop state (loop.json): judgement bookkeeping only, no chat
 *  text. `pendingActions` holds every action the loop knows about
 *  (pending, done and dropped) — the guardrails only read 7 days
 *  back, older rows are simply ignored, never deleted.
 *  `recentTriggers` is the trigger cooldown ledger: every stored
 *  action appends its trigger here (act:true only), latest 100
 *  kept, so a dropped action's trigger stays cooled for 7 days
 *  even after its row left the pending list. */
export interface LoopState {
  lastJudgedAt: number;
  pendingActions: PendingAction[];
  recentTriggers: { trigger: string; at: number }[];
  pendingPrompt?: PendingPrompt;
}

/** What the model hands back for a proactive decision. */
export interface ProactDecision {
  act: boolean;
  judgment?: string;
  actionText?: string;
  trigger?: string;
}

export function defaultLoopState(): LoopState {
  return { lastJudgedAt: 0, pendingActions: [], recentTriggers: [] };
}

function sanitisePendingPrompt(raw: unknown): PendingPrompt | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const p = raw as Record<string, unknown>;
  if (
    typeof p.token !== "string" ||
    p.token.length === 0 ||
    !Array.isArray(p.sourceIds) ||
    !p.sourceIds.every((id) => typeof id === "string") ||
    !Number.isFinite(p.issuedAt)
  ) {
    return undefined;
  }
  return {
    token: p.token,
    sourceIds: [...(p.sourceIds as string[])],
    issuedAt: p.issuedAt as number,
  };
}

function sanitiseRecentTriggers(raw: unknown): { trigger: string; at: number }[] {
  if (!Array.isArray(raw)) return [];
  const out: { trigger: string; at: number }[] = [];
  for (const row of raw) {
    if (
      row &&
      typeof row === "object" &&
      typeof (row as Record<string, unknown>).trigger === "string" &&
      ((row as Record<string, unknown>).trigger as string).length > 0 &&
      Number.isFinite((row as Record<string, unknown>).at)
    ) {
      out.push({
        trigger: (row as Record<string, unknown>).trigger as string,
        at: (row as Record<string, unknown>).at as number,
      });
    }
  }
  return out.slice(-100);
}

function sanitiseAction(raw: unknown): PendingAction | null {
  if (!raw || typeof raw !== "object") return null;
  const a = raw as Record<string, unknown>;
  if (
    typeof a.id !== "string" ||
    a.id.length === 0 ||
    typeof a.trigger !== "string" ||
    a.trigger.length === 0 ||
    typeof a.judgment !== "string" ||
    typeof a.actionText !== "string" ||
    !Number.isFinite(a.createdAt)
  ) {
    return null;
  }
  const status = a.status;
  const channel = a.channel;
  return {
    id: a.id,
    trigger: a.trigger,
    judgment: a.judgment,
    actionText: a.actionText,
    channel: channel === "qq" ? "qq" : "session",
    status:
      status === "done" ? "done" : status === "dropped" ? "dropped" : "pending",
    createdAt: a.createdAt as number,
  };
}

/** Build the prompt handed to the model when she may act. The
 *  day's memories, beliefs and reflections go in verbatim, with
 *  their ids — the model weighs them and decides three things:
 *  whether to act at all, why, and what to say. The prompt says
 *  it plainly: weigh whether this disturbs him and whether now
 *  is a good moment; do not act for the sake of acting; not
 *  acting is a fully acceptable answer. No example line is ever
 *  suggested — what she says is hers to write, or nothing.
 *
 *  0.4.6 (0.4.5 audit new issue 1): the memories are capped —
 *  top 20 / 3000 characters by significance, the rest as id +
 *  one-line summary. A prompt that lists all 24 h verbatim can
 *  reach tens of thousands of characters on a chatty day; the
 *  summary-only entries are visible but not actionable — a
 *  decision's trigger must be an entry shown here in full
 *  (the token check enforces the same list). */
export function buildProactPrompt(
  input: {
    memories: MemoryEntry[];
    beliefs: Belief[];
    reflections: Fragment[];
    now: number;
  },
  opts: {
    significanceOf?: (entry: MemoryEntry) => number;
    maxEntries?: number;
    maxChars?: number;
  } = {},
): string {
  const sel = selectCappedEntries(input.memories, {
    maxEntries: opts.maxEntries ?? RECENT_MAX_ENTRIES,
    maxChars: opts.maxChars ?? RECENT_MAX_CHARS,
    significanceOf: opts.significanceOf,
  });
  const lines: string[] = [
    `你是夏柠柒。今天是 ${formatDate(input.now)} ${formatTime(input.now)}。下面是你今天的记忆、你对你们关系的信念、以及你最近的反思（每条前面是它的 id）。`,
    "",
    "请你自己掂量一下：现在要不要主动找他说句话？",
    "先想想该不该打扰他、现在说合不合适；不要为了主动而主动；不行动是完全可以接受的回答，没什么值得说的就不用说。",
    "如果你决定主动，告诉我三件事：为什么（judgment，一句话）、说什么（actionText，你想对他说的话，用你自己的话写）、触发是哪条记忆或信念（trigger，它的 id，只能用下面列表里的 id，不要编）。",
    "决定好了就调用 memory_proact 工具，把这几件事交回来；决定不主动也调用一次 memory_proact，把 act: false 交回来，让我知道你想过了。",
    "",
    "今天的记忆：",
  ];
  if (sel.shown.length === 0 && sel.overflow.length === 0) {
    lines.push("（今天还没有新记忆）");
  } else {
    for (const r of sel.shown) {
      lines.push(`- [${r.entry.id}] [${r.entry.date} ${r.entry.time} ${r.entry.role}] ${r.displayText}`);
    }
    for (const o of sel.overflow) {
      lines.push(`- [${o.id}] （摘要）${o.summary}`);
    }
    if (sel.overflowHidden > 0) {
      lines.push(`（另有 ${sel.overflowHidden} 条未列出。）`);
    }
    if (sel.cut) {
      lines.push(
        `（今天共有 ${sel.total} 条新记忆，这里只列了重要的部分，剩下的不用掂量；摘要条目没有原文，不能当触发。）`,
      );
    }
  }
  lines.push("", "你对你们关系的信念：");
  if (input.beliefs.length === 0) {
    lines.push("（还没有信念）");
  } else {
    for (const b of input.beliefs) {
      lines.push(
        `- [${b.id}] ${b.dimension}：${b.statement.replace(/[\r\n]+/g, " ")}（强度 ${b.strength.toFixed(2)}，证据 ${b.proofCount} 条）`,
      );
    }
  }
  lines.push("", "最近的反思：");
  if (input.reflections.length === 0) {
    lines.push("（最近没有反思）");
  } else {
    for (const f of input.reflections) {
      lines.push(`- [${f.id}] ${f.text.replace(/[\r\n]+/g, " ")}`);
    }
  }
  lines.push(
    "",
    "交回来的时候用 JSON：{\"act\": true/false, \"judgment\": \"…\", \"actionText\": \"…\", \"trigger\": \"…\"}；不主动时只交 {\"act\": false} 就行。",
    "调用 memory_proact 交决定时，一定要带上这次提示的 promptToken（gate 调用返回的那个 token）；决定不主动（act: false）也要带上它，好让这次提示作废——没有 token 的决定存不进去，会被当成没回答过这次提示。",
  );
  return lines.join("\n");
}

/** Parse the model's proactive decision (the parseModelReviewIds
 *  pattern: a JSON string is parsed once, an object is read
 *  directly). Strict: `act` must be a boolean; when it is true,
 *  `judgment`, `actionText` and `trigger` must all be non-empty
 *  strings, or the whole decision is void. Anything else —
 *  unparseable text, a missing field, an empty actionText —
 *  returns null: the caller treats it as "do nothing", never
 *  crashes, never retries, never invents a fallback line. */
export function parseProactDecision(raw: unknown): ProactDecision | null {
  const fromValue = (v: unknown): ProactDecision | null => {
    if (typeof v === "string") {
      const s = v.trim();
      if (!s) return null;
      try {
        return fromValue(JSON.parse(s) as unknown);
      } catch {
        return null;
      }
    }
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      const obj = v as Record<string, unknown>;
      // A wrapped decision ({decision: {...}}) is unwrapped once.
      if (obj.decision !== undefined) return fromValue(obj.decision);
      if (typeof obj.act !== "boolean") return null;
      if (obj.act === false) return { act: false };
      if (
        typeof obj.judgment !== "string" ||
        obj.judgment.trim().length === 0 ||
        typeof obj.actionText !== "string" ||
        obj.actionText.trim().length === 0 ||
        typeof obj.trigger !== "string" ||
        obj.trigger.trim().length === 0
      ) {
        return null;
      }
      return {
        act: true,
        judgment: (obj.judgment as string).trim(),
        actionText: (obj.actionText as string).trim(),
        trigger: (obj.trigger as string).trim(),
      };
    }
    return null;
  };
  return fromValue(raw);
}

/** Hard guardrails, pure code — the model can never bypass them.
 *  Checks, in order:
 *  1. When a prompt token is carried (`promptToken` given): the
 *     token must match the outstanding `pendingPrompt` and be
 *     inside its 15-minute TTL, or the decision is refused
 *     (`proact_prompt_not_found` / `proact_prompt_expired`).
 *     The decision's trigger must then be one of that prompt's
 *     sourceIds, or it is refused
 *     (`proact_trigger_not_in_prompt`) — the model may only act
 *     on something it was actually shown. A call without a token
 *     (the gate call, or a direct core call) skips this step.
 *  2. At most ONE action per calendar day (host-local date):
 *     once an action was stored today (pending or done), every
 *     later judgement that day is refused. A model `act: false`
 *     stores nothing, so it never consumes the day's quota —
 *     she may judge again later the same day. `lastJudgedAt` is
 *     bookkeeping only and is never used here: issuing a prompt
 *     does not write it, and a state with `lastJudgedAt` set
 *     today but no actions stored is open.
 *  3. The same trigger may not fire again within 7 days. The
 *     stored pending/done rows are checked first (old data has
 *     no `recentTriggers`); then `recentTriggers`, which also
 *     covers dropped actions — a trigger whose action was
 *     evicted when the pending list filled up stays cooled
 *     (`trigger_cooldown`). An empty trigger skips this check —
 *     the gate call ({}) has no trigger yet; the decision call
 *     always carries one.
 *  The 3-pending cap is NOT a refusal: it is enforced at store
 *  time (LoopStore.addAction drops the oldest pending first).
 *  A refusal means "do not even ask the model" — the caller
 *  checks this before building the prompt. */
export function checkGuardrails(
  state: LoopState,
  trigger: string,
  now: number,
  promptToken?: string,
): { ok: boolean; reason?: string } {
  if (typeof promptToken === "string" && promptToken.length > 0) {
    const pending = state.pendingPrompt;
    if (!pending || pending.token !== promptToken) {
      return { ok: false, reason: "proact_prompt_not_found" };
    }
    if (
      now - pending.issuedAt < 0 ||
      now - pending.issuedAt > PROACT_PROMPT_TTL_MS
    ) {
      return { ok: false, reason: "proact_prompt_expired" };
    }
    if (
      typeof trigger === "string" &&
      trigger.length > 0 &&
      !pending.sourceIds.includes(trigger)
    ) {
      return { ok: false, reason: "proact_trigger_not_in_prompt" };
    }
  }
  const today = formatDate(now);
  for (const a of state.pendingActions) {
    if (a.status !== "pending" && a.status !== "done") continue;
    if (formatDate(a.createdAt) === today) {
      return { ok: false, reason: "今天已经主动过一次了，明天再说。" };
    }
  }
  if (typeof trigger === "string" && trigger.length > 0) {
    for (const a of state.pendingActions) {
      if (a.status !== "pending" && a.status !== "done") continue;
      if (a.trigger === trigger && now - a.createdAt < LOOP_TRIGGER_REPEAT_MS) {
        return {
          ok: false,
          reason: "这条记忆/信念 7 天内已经主动过一次了，先不用再提。",
        };
      }
    }
    for (const item of state.recentTriggers ?? []) {
      if (
        item.trigger === trigger &&
        now - item.at < LOOP_TRIGGER_COOLDOWN_MS
      ) {
        return { ok: false, reason: "trigger_cooldown" };
      }
    }
  }
  return { ok: true };
}

/** Deliver one action through its channel. `session` hands the
 *  model's own words back for her to say in the chat, in her own
 *  words — the code never rewrites them. `qq` is not connected
 *  yet and throws `qq_not_connected` (the placeholder for the
 *  future QQ wiring: only this branch changes then, never the
 *  judgement or the write-back). An unknown channel throws too —
 *  silently delivering nowhere would lose the action. */
export function deliver(action: PendingAction): string {
  switch (action.channel) {
    case "session":
      return action.actionText;
    case "qq":
      throw new Error("qq_not_connected");
    default:
      throw new Error(
        `unknown proact channel: ${String((action as { channel?: unknown }).channel)}`,
      );
  }
}

export interface AddActionResult {
  ok: boolean;
  action?: PendingAction;
  /** True when storing this action dropped the oldest pending one. */
  droppedOldest?: boolean;
  reason?: string;
}

/** loop.json store: load + sanitise + atomic save. Old data
 *  without the file starts empty; a corrupt file starts empty
 *  too (never a crash); rows missing an id/trigger/text are
 *  dropped, a missing channel defaults to "session", a missing
 *  status defaults to "pending". */
export class LoopStore {
  private state: LoopState = defaultLoopState();
  private readonly file: string;

  constructor(dataDir: string) {
    this.file = join(dataDir, LOOP_FILE);
    this.load();
  }

  /** Current state (a copy — callers must not mutate it).
   *  `pendingPrompt` is only present while a prompt is
   *  outstanding, so a state with no live prompt has no such
   *  key at all. */
  get(): LoopState {
    const state: LoopState = {
      lastJudgedAt: this.state.lastJudgedAt,
      pendingActions: this.state.pendingActions.map((a) => ({ ...a })),
      recentTriggers: (this.state.recentTriggers ?? []).map((r) => ({ ...r })),
    };
    if (this.state.pendingPrompt) {
      state.pendingPrompt = {
        token: this.state.pendingPrompt.token,
        sourceIds: [...this.state.pendingPrompt.sourceIds],
        issuedAt: this.state.pendingPrompt.issuedAt,
      };
    }
    return state;
  }

  all(): PendingAction[] {
    return this.state.pendingActions.map((a) => ({ ...a }));
  }

  pending(): PendingAction[] {
    return this.state.pendingActions
      .filter((a) => a.status === "pending")
      .map((a) => ({ ...a }));
  }

  getById(id: string): PendingAction | undefined {
    const found = this.state.pendingActions.find((a) => a.id === id);
    return found ? { ...found } : undefined;
  }

  private load(): void {
    try {
      if (!existsSync(this.file)) return;
      const data = JSON.parse(readFileSync(this.file, "utf8")) as unknown;
      if (!data || typeof data !== "object") return;
      const raw = data as {
        lastJudgedAt?: unknown;
        pendingActions?: unknown;
        recentTriggers?: unknown;
        pendingPrompt?: unknown;
      };
      const actions: PendingAction[] = [];
      if (Array.isArray(raw.pendingActions)) {
        for (const row of raw.pendingActions) {
          const clean = sanitiseAction(row);
          if (clean) actions.push(clean);
        }
      }
      const state: LoopState = {
        lastJudgedAt: Number.isFinite(raw.lastJudgedAt)
          ? (raw.lastJudgedAt as number)
          : 0,
        pendingActions: actions,
        recentTriggers: sanitiseRecentTriggers(raw.recentTriggers),
      };
      const prompt = sanitisePendingPrompt(raw.pendingPrompt);
      if (prompt) state.pendingPrompt = prompt;
      this.state = state;
    } catch {
      this.state = defaultLoopState();
    }
  }

  reload(): void {
    this.state = defaultLoopState();
    this.load();
  }

  save(): void {
    // No pruning: at most one action a day can ever be stored, so
    // the file grows by a row a day at most — done/dropped rows
    // stay as the record of what she already tried (the guardrails
    // only read 7 days back, older rows are simply ignored).
    atomicWriteText(
      this.file,
      JSON.stringify({ version: 1, ...this.state } satisfies {
        version: 1;
      } & LoopState),
    );
  }

  /** Issue (or re-issue) the prompt token for these source ids.
   *  An outstanding token for the exact same source list, still
   *  inside its TTL, is reused — the model may already hold it,
   *  and nothing changed under it. Otherwise a fresh token is
   *  minted (`PROACT_<now>_<8 hex>`) and saved as the one
   *  outstanding prompt. Issuing writes no `lastJudgedAt` and
   *  consumes no daily quota: it only records which prompt the
   *  next decision must answer. */
  issuePrompt(
    sourceIds: string[],
    now: number = Date.now(),
  ): PendingPrompt {
    const existing = this.state.pendingPrompt;
    if (
      existing &&
      now - existing.issuedAt >= 0 &&
      now - existing.issuedAt <= PROACT_PROMPT_TTL_MS &&
      existing.sourceIds.length === sourceIds.length &&
      existing.sourceIds.every((id, i) => id === sourceIds[i])
    ) {
      return {
        token: existing.token,
        sourceIds: [...existing.sourceIds],
        issuedAt: existing.issuedAt,
      };
    }
    const issued: PendingPrompt = {
      token: `PROACT_${now}_${randomBytes(4).toString("hex")}`,
      sourceIds: [...sourceIds],
      issuedAt: now,
    };
    this.state.pendingPrompt = issued;
    this.save();
    return { ...issued, sourceIds: [...issued.sourceIds] };
  }

  /** Drop the outstanding prompt, so its token can never be
   *  answered twice. With a token, only that token is cleared
   *  (a stale or foreign token clears nothing and returns
   *  false); without one, whatever is outstanding is cleared.
   *  Returns false when there was nothing to clear. */
  clearPrompt(promptToken?: string): boolean {
    if (!this.state.pendingPrompt) return false;
    if (
      typeof promptToken === "string" &&
      promptToken.length > 0 &&
      this.state.pendingPrompt.token !== promptToken
    ) {
      return false;
    }
    this.state.pendingPrompt = undefined;
    this.save();
    return true;
  }

  /** Store a model decision as a pending action. The guardrails
   *  run again here (the tool re-checks just before storing, so a
   *  decision that went stale between the gate and the save is
   *  still refused). When a prompt token is carried, the decision
   *  must answer that exact prompt (token + TTL) and its trigger
   *  must be one of the prompt's sourceIds; a call without a
   *  token (direct core use) skips the token step but still runs
   *  the daily and 7-day checks. Full pending (3) drops the
   *  oldest pending action first — its status becomes "dropped",
   *  the record stays in loop.json. Storing appends the trigger
   *  to `recentTriggers` (latest 100 kept), so the dropped
   *  action's trigger stays cooled for 7 days too. The prompt is
   *  consumed by a successful store. `lastJudgedAt` moves to now:
   *  it is a record of when judgement last produced an action,
   *  never a quota input. */
  addAction(
    decision: ProactDecision,
    channel: ProactChannel = "session",
    now: number = Date.now(),
    promptToken?: string,
  ): AddActionResult {
    if (!decision || decision.act !== true) {
      return { ok: false, reason: "没有要执行的行动（模型决定不主动）。" };
    }
    if (
      typeof decision.judgment !== "string" ||
      decision.judgment.trim().length === 0 ||
      typeof decision.actionText !== "string" ||
      decision.actionText.trim().length === 0 ||
      typeof decision.trigger !== "string" ||
      decision.trigger.trim().length === 0
    ) {
      return { ok: false, reason: "行动缺少判断、话术或触发，无法保存。" };
    }
    const guard = checkGuardrails(
      this.state,
      decision.trigger,
      now,
      promptToken,
    );
    if (!guard.ok) return { ok: false, reason: guard.reason };
    let droppedOldest = false;
    const pending = this.state.pendingActions.filter(
      (a) => a.status === "pending",
    );
    if (pending.length >= LOOP_MAX_PENDING) {
      const oldest = [...pending].sort((a, b) => a.createdAt - b.createdAt)[0];
      if (oldest) {
        oldest.status = "dropped";
        droppedOldest = true;
      }
    }
    const action: PendingAction = {
      id: `act-${now}-${randomBytes(3).toString("hex")}`,
      trigger: decision.trigger,
      judgment: decision.judgment,
      actionText: decision.actionText,
      channel,
      status: "pending",
      createdAt: now,
    };
    this.state.pendingActions.push(action);
    this.state.recentTriggers = [
      ...(this.state.recentTriggers ?? []),
      { trigger: action.trigger, at: now },
    ].slice(-100);
    this.state.pendingPrompt = undefined;
    this.state.lastJudgedAt = now;
    this.save();
    return { ok: true, action: { ...action }, droppedOldest };
  }

  /** Mark one action done. Returns false when the id is unknown
   *  (nothing is written). */
  markDone(actionId: string): boolean {
    const found = this.state.pendingActions.find((a) => a.id === actionId);
    if (!found || found.status === "done") return false;
    found.status = "done";
    this.save();
    return true;
  }
}

/** Close the loop: the user's reply to an action is written back
 *  to the log like any ordinary message (through `appendReply`,
 *  which the core wires to its own record()), and the action is
 *  marked done. Returns false when the action id is unknown —
 *  then nothing is appended and nothing is marked, so a stray
 *  reply can never close the wrong action or land unattributed. */
export function recordOutcome(
  store: LoopStore,
  actionId: string,
  userReply: string,
  appendReply: (text: string) => void,
): boolean {
  if (typeof userReply !== "string" || userReply.trim().length === 0) {
    return false;
  }
  const found = store.getById(actionId);
  if (!found || found.status === "done") return false;
  appendReply(userReply);
  return store.markDone(actionId);
}
