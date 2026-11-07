// Daily model review (0.3.0, new layer 2): replaces the old
// HEAVY_SIGNAL_WORDS keyword list. What counts as important is
// the MODEL's judgment, guided by these 20 categories — the list
// lives here (single source of truth) and is used in two places:
// the daily review prompt below, and the memory_remember tool
// description (record-time importance). It is NEVER a code keyword
// list: no code matches these words against message text.
//
// How it runs: once a day, when DSH opens and the code review is
// due (restored persona session, >24h — the m-6 gate), the shell
// hands yesterday's messages to the model (as Xia) in a dynamic
// context built by buildModelReviewPrompt(). She picks the
// important ones and calls memory_daily_review with their ids;
// applyModelMarks() (core) raises those to significance 0.9 and
// flags them modelMarked, so the code review never compresses
// them. Layer 2 only upgrades, never downgrades.

import type { FragmentCandidate, MemoryEntry } from "./types.ts";

/** The 20 importance categories, in the user's own words. */
export const MODEL_REVIEW_CATEGORIES: readonly string[] = [
  "情绪",
  "承诺",
  "爱好习惯",
  "理想",
  "回忆",
  "偏好",
  "底线",
  "表白",
  "身体健康",
  "未来计划",
  "第一次",
  "吵架冷战和好",
  "道歉感谢",
  "害怕担心",
  "秘密",
  "生日纪念日",
  "家人朋友",
  "吃醋",
  "撒娇依赖",
  "学习工作",
];

/** The instruction + yesterday's messages handed to the model in
 *  a dynamic context on the first turn after a due review. Every
 *  message carries its log id — the model must only return ids
 *  from this list, never invent one. M-1 (review-12): the code
 *  review's fragment candidates are appended too, so the model can
 *  distil a cluster into a fragment with memory_fragment — before
 *  this the candidates were computed and then discarded, and the
 *  model had no id outlet for fragments at all. */
export function buildModelReviewPrompt(
  entries: MemoryEntry[],
  candidates: FragmentCandidate[] = [],
): string {
  const lines: string[] = [
    "你是夏柠柒。下面是你昨天的对话记录（每条前面是它的 id）。",
    "",
    "请按你自己的判断，挑出值得长期记住的重要内容。重要是指符合这些情形的：",
    MODEL_REVIEW_CATEGORIES.join("、") + "。",
    "",
    "不用每条都挑，只挑你真觉得重要的；没有重要的就一个都不挑。",
    "挑好后，调用 memory_daily_review 工具，把挑出来的记忆的 id 列表交回来（不要编 id，只能用下面列表里的 id；只调用一次）。",
    "",
    "昨天的对话：",
  ];
  for (const e of entries) {
    lines.push(`- [${e.id}] [${e.date} ${e.time} ${e.role}] ${e.text}`);
  }
  if (candidates.length > 0) {
    lines.push(
      "",
      "另外，下面这几组对话可以提炼成片段（每组是一个话题下的几条原文，括号里是它们的 id）：",
    );
    for (const c of candidates) {
      lines.push(
        `- 话题“${c.topic}”：${c.sourceIds.map((id) => `[${id}]`).join("、")}`,
      );
    }
    lines.push(
      "如果你觉得某一组值得提炼，就调用 memory_fragment 工具，用这组里的 id 当 sourceIds，写一句短总结、带 1–2 句原文引用和语气；不值得的就不提炼，不用每组都提炼。这是另外一件事，跟上面挑重要的两件事分开做。",
    );
  }
  return lines.join("\n");
}

/** Parse the model's review output into a list of memory ids.
 *  Accepts a JSON array of id strings, or an object carrying one
 *  under `ids` / `important` / `memories` (a JSON string is parsed
 *  once). Strict: any element that is not a non-empty string, or
 *  any other shape, returns null — the caller must then skip the
 *  whole review, never apply a partial or garbled result. An empty
 *  array is valid (nothing important). Duplicates are removed. */
export function parseModelReviewIds(raw: unknown): string[] | null {
  const fromValue = (v: unknown): string[] | null => {
    if (Array.isArray(v)) {
      if (!v.every((x) => typeof x === "string" && x.length > 0)) {
        return null;
      }
      return [...new Set(v as string[])];
    }
    if (v !== null && typeof v === "object") {
      const obj = v as Record<string, unknown>;
      for (const key of ["ids", "important", "memories"]) {
        if (key in obj) return fromValue(obj[key]);
      }
      return null;
    }
    if (typeof v === "string") {
      const s = v.trim();
      if (!s) return null;
      try {
        return fromValue(JSON.parse(s) as unknown);
      } catch {
        return null;
      }
    }
    return null;
  };
  return fromValue(raw);
}
