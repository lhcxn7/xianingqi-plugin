// Reflection trigger (0.4.0 item 3, Generative Agents reflection).
//
// The plugin used to only store what happened, never synthesise
// "what does this add up to". A reflection is the model's own
// conclusion from a cluster of recent memories ("他最近压力大"
// from three separate "累"), stored as a special fragment so the
// next recall can bring the conclusion, not just the three
// originals.
//
// De-mechanisation (2026-11-09): there is NO score threshold that
// decides whether to reflect — the old 50-point hard gate never
// even existed in code, and no such gate is added here. Judgement
// belongs to the model: the code only (a) checks a tiny
// anti-disturbance floor (REFLECTION_MIN_FLOOR) so a near-empty
// day never even builds a prompt, and (b) hands the model the
// prompt. Whether to reflect, and what to conclude, is the
// model's call — the code never blocks it above the floor.
//
// Verification is quote-only, by design: a reflection's insight
// is NEW ("压力" appears in no source that only says "累"), so
// the fragment rule that every key term must appear in the
// sources would reject the spec's own example. What the code
// checks instead is the grounding: every 「」-quoted phrase in
// the conclusion must appear verbatim in one of its sources
// (the verifyFragment quote check, quoteOnly mode). A conclusion
// whose quotes cannot be found is void in full — nothing is
// stored. A conclusion with no quotes at all is void too: an
// ungrounded insight has nothing to check against. That is the
// same honest limit as fragments — the code catches fabricated
// citations, not a wrong judgement.

import { randomBytes } from "node:crypto";
import type {
  Fragment,
  FragmentStore,
  FragmentTone,
} from "./fragments.ts";
import { fragmentKeyTerms, verifyFragment } from "./fragments.ts";
import { newProvenance } from "./provenance.ts";
import {
  RECENT_MAX_CHARS,
  RECENT_MAX_ENTRIES,
  selectCappedEntries,
} from "./model-review.ts";
import type { MemoryEntry } from "./types.ts";

/** Only memories from the last 24 h can trigger a reflection. */
export const REFLECTION_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Anti-disturbance floor, on the sum of the last 24 h of new
 *  memories' significance (heavy 0.9, light 0.4 — see
 *  attributes.ts initialSignificance). Below this, no prompt is
 *  built and no model is called: a near-empty day must not
 *  interrupt her. Above it, the model decides — the code never
 *  blocks a reflection. ~6 heavy memories in a day clears it. */
export const REFLECTION_MIN_FLOOR = 5;
/** A cited quote must be at least this long — a 1-char match
 *  ("他", "了") proves nothing. */
export const REFLECTION_MIN_QUOTE_CHARS = 2;
/** 0.5.1 (0.4.3 §四): a saved reflection conclusion is capped at
 *  1000 characters — a reflection is one short insight, not an
 *  essay, and an unbounded conclusion bloats every later proact
 *  prompt that pastes it. At most 200 stored reflections: past
 *  that, saveReflection refuses and the model must let an old
 *  one go (there is no delete yet — refusing is honest, silently
 *  dropping the oldest would lose history without asking). The
 *  prompt side is already capped (buildReflectionPrompt: 20
 *  entries / 3000 chars, 0.4.6). */
export const REFLECTION_MAX_CHARS = 1000;
export const REFLECTION_MAX_COUNT = 200;

export interface ReflectionGate {
  /** Recent persona entries not yet folded into a reflection. */
  entries: MemoryEntry[];
  /** Sum of their significance. */
  significanceSum: number;
  /** True when the floor is reached (sum >= REFLECTION_MIN_FLOOR). */
  reached: boolean;
}

/** The gate: recent (24 h) persona entries, minus any already
 *  folded into a reflection fragment, with their significance
 *  summed. Task-window entries never count — a reflection is
 *  persona memory, same rule as the fragment/belief candidates.
 *  The caller supplies significance (the attribute store); the
 *  gate itself does no scoring beyond the sum. */
export function reflectionGate(
  entries: MemoryEntry[],
  significanceOf: (entry: MemoryEntry) => number,
  now: number = Date.now(),
  reflectedIds: ReadonlySet<string> = new Set<string>(),
): ReflectionGate {
  const recent = entries.filter(
    (e) =>
      e.window === "persona" &&
      !reflectedIds.has(e.id) &&
      now - e.ts >= 0 &&
      now - e.ts <= REFLECTION_WINDOW_MS,
  );
  let sum = 0;
  for (const e of recent) {
    const s = significanceOf(e);
    if (Number.isFinite(s)) sum += s;
  }
  return {
    entries: recent,
    significanceSum: sum,
    reached: sum >= REFLECTION_MIN_FLOOR,
  };
}

/** The prompt handed to the model when the floor is reached: the
 *  triggering memories verbatim, plus the instruction to decide
 *  for herself whether there is anything new to see. No
 *  conclusion is suggested — the model writes it, or writes
 *  nothing at all.
 *
 *  0.4.6 (0.4.5 audit new issue 1): the list is capped — top 20
 *  entries / 3000 characters by significance, the rest as id +
 *  one-line summary. A prompt that lists all 24 h verbatim can
 *  reach tens of thousands of characters on a chatty day; the
 *  summary-only entries are visible but not citable — a
 *  reflection may only quote entries shown here in full. */
export function buildReflectionPrompt(
  entries: MemoryEntry[],
  opts: {
    significanceOf?: (entry: MemoryEntry) => number;
    maxEntries?: number;
    maxChars?: number;
  } = {},
): string {
  const sel = selectCappedEntries(entries, {
    maxEntries: opts.maxEntries ?? RECENT_MAX_ENTRIES,
    maxChars: opts.maxChars ?? RECENT_MAX_CHARS,
    significanceOf: opts.significanceOf,
  });
  const lines: string[] = [
    "你是夏柠柒。下面是你最近 24 小时内的对话（每条前面是它的 id）。",
    "",
    "请你自己看看：这些对话放在一起，能看出什么新东西吗？比如他最近的状态、你们之间有什么变化、他反复提到的事背后是什么意思。",
    "",
    "做不做反思由你自己决定，不用每轮都反思；没看出新东西就不用反思，一个字都不用写。",
    "如果你决定反思，写一句结论就行；结论里引用的每一句话都要用「」括起来，从下面的原文里逐字抄，不能改写；不要编原文里没有的词，不要编他没说过的事。",
    "",
    "最近 24 小时的对话：",
  ];
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
      `（最近 24 小时共有 ${sel.total} 条，这里只列了重要的部分，剩下的不用反思；摘要条目没有原文，不能当引用来源。）`,
    );
  }
  lines.push(
    "",
    "反思好了就调用 memory_reflect 工具，把结论（text）和来源 id（sourceIds）交回来保存；不反思就不用调这个工具。",
  );
  return lines.join("\n");
}

/** Quoted phrases inside a reflection text: 「…」 / “…” /
 *  "…" / '…' — de-duplicated, trimmed, empties dropped. The
 *  prompt tells the model to use 「」, the other forms are
 *  accepted so a differently-quoted conclusion is not rejected
 *  for punctuation alone. */
export function extractReflectionQuotes(text: string): string[] {
  if (typeof text !== "string") return [];
  const out: string[] = [];
  const patterns: RegExp[] = [
    /「([^」]+)」/g,
    /“([^”]+)”/g,
    /"([^"]+)"/g,
    /'([^']+)'/g,
  ];
  for (const re of patterns) {
    for (const m of text.matchAll(re)) {
      const q = m[1].trim();
      if (q.length >= REFLECTION_MIN_QUOTE_CHARS && !out.includes(q)) {
        out.push(q);
      }
    }
  }
  return out;
}

export interface ReflectionVerifyResult {
  ok: boolean;
  reasons: string[];
  quotes: string[];
}

/** Quote-only verification of a reflection conclusion against its
 *  sources: every 「」-quoted phrase must appear verbatim in some
 *  source entry, and there must be at least one quote. The
 *  conclusion's own new words are NOT checked — they are the
 *  insight, not a citation. A failure voids the whole
 *  reflection; the caller stores nothing. */
export function verifyReflection(
  text: string,
  sources: MemoryEntry[],
): ReflectionVerifyResult {
  const quotes = extractReflectionQuotes(text);
  const tone: FragmentTone = {
    label: "反思",
    level: "unknown",
    intensity: 0.5,
  };
  // quoteOnly: skip the fragment key-term + tone checks — the
  // insight's words are new by design. Only the quotes are
  // checked, verbatim, against the sources.
  const checked = verifyFragment({ text, tone, quotes }, sources, {
    quoteOnly: true,
  });
  const reasons = checked.reasons.filter(
    (r) => !r.startsWith("没有逐字引用："),
  );
  if (quotes.length === 0) {
    reasons.unshift(
      "结论里没有任何引用：反思必须带至少一句从来源原文逐字抄来的话（用「」括起来），不然没法核对它是不是真的。",
    );
  }
  return { ok: reasons.length === 0, reasons, quotes };
}

export interface ReflectionSaveResult {
  ok: boolean;
  fragment?: Fragment;
  reasons: string[];
}

/** Save a reflection conclusion as a special fragment:
 *  `type: "reflection"`, stored in fragments.json like any other
 *  fragment (same file, same shape) so recall and the starmap
 *  pick it up unchanged — a reflection star is a gold
 *  stable_profile star, like any fragment star. The fragment's
 *  keywords come from its verbatim quotes only (grounded words),
 *  never from the insight's new words, so a novel word can never
 *  leak into constellation grouping. A failed verification voids
 *  the whole reflection: nothing is stored, and the reasons come
 *  back so the model can fix it. */
export function saveReflection(
  text: string,
  sourceIds: string[],
  entriesById: Map<string, MemoryEntry>,
  fragments: FragmentStore,
  now: number = Date.now(),
): ReflectionSaveResult {
  if (typeof text !== "string" || text.trim().length === 0) {
    return { ok: false, reasons: ["反思结论不能为空。"] };
  }
  // 0.5.1 (0.4.3 §四): length + count caps (see the constants
  // above). Checked before verification, so a too-long conclusion
  // fails fast with a usable reason instead of after the quote
  // check.
  if (text.trim().length > REFLECTION_MAX_CHARS) {
    return {
      ok: false,
      reasons: [
        `反思结论太长（${text.trim().length} 字，上限 ${REFLECTION_MAX_CHARS} 字）：反思是一句短结论，不是长文，缩短再存。`,
      ],
    };
  }
  const storedReflections = fragments
    .all()
    .filter((f) => f.type === "reflection").length;
  if (storedReflections >= REFLECTION_MAX_COUNT) {
    return {
      ok: false,
      reasons: [
        `已存反思 ${storedReflections} 条，到了 ${REFLECTION_MAX_COUNT} 条上限：先处理掉旧的反思再存新的。`,
      ],
    };
  }
  if (!Array.isArray(sourceIds) || sourceIds.length === 0) {
    return {
      ok: false,
      reasons: ["sourceIds 不能为空：反思必须注明它是从哪几条原文来的。"],
    };
  }
  const missingIds = sourceIds.filter((id) => !entriesById.has(id));
  if (missingIds.length > 0) {
    return {
      ok: false,
      reasons: [`来源条目不存在：${missingIds.slice(0, 5).join("、")}`],
    };
  }
  // 0.4.1 (A) core-layer persona-source check: every source must be
  // a persona-window entry — a task-window id passed in as a source
  // is rejected with the whole reflection, same as a missing id.
  // B's rejection idiom is kept ({ok:false} with reasons, not a
  // throw), so the existing unknown-source contract is unchanged;
  // A 的 1800 字硬上限没有搬过来。
  const nonPersonaIds = sourceIds.filter(
    (id) => entriesById.get(id)?.window !== "persona",
  );
  if (nonPersonaIds.length > 0) {
    return {
      ok: false,
      reasons: [
        `来源条目不是人设窗口记忆：${nonPersonaIds.slice(0, 5).join("、")}——反思只能用人设窗口的原文做来源，任务窗口的条目不能当反思证据。`,
      ],
    };
  }
  const sources = sourceIds
    .map((id) => entriesById.get(id) as MemoryEntry)
    .filter(Boolean);
  const checked = verifyReflection(text, sources);
  if (!checked.ok) return { ok: false, reasons: checked.reasons };
  const keywords = fragmentKeyTerms(checked.quotes.join("\n"));
  const fragment: Fragment = {
    id: `refl-${now}-${randomBytes(3).toString("hex")}`,
    type: "reflection",
    sourceIds: [...sourceIds],
    // 0.5.0 step 3: a reflection is a model inference from the
    // sources; its quote check passed at save time, so creation
    // counts as the first verification.
    provenance: newProvenance(sourceIds, "model_inference", now),
    text: text.trim(),
    tone: { label: "反思", level: "unknown", intensity: 0.5 },
    quotes: checked.quotes,
    topic: keywords[0] ?? "反思",
    keywords,
    createdAt: now,
    verified: true,
  };
  fragments.add(fragment);
  return { ok: true, fragment, reasons: [] };
}

/** What memory_reflect's gate check returns: whether the floor
 *  is reached, how much new significance there is, how many
 *  entries triggered, and — only when reached — the prompt for
 *  the model. Below the floor there is no prompt at all. */
export interface ReflectionCheck {
  reached: boolean;
  significanceSum: number;
  entryCount: number;
  /** Ids of the entries in this gate's prompt — the only sources a
   *  save may cite. The tool enforces this: a conclusion citing
   *  an entry outside the current gate is refused, so a
   *  reflection can only be grounded in the memories the model
   *  was actually shown. */
  sourceIds: string[];
  prompt?: string;
}
