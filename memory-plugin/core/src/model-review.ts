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

import type { BeliefCandidate, FragmentCandidate, MemoryEntry } from "./types.ts";

/** 0.4.5 (0.4.3 audit item 4): the daily-review prompt is capped.
 *  Yesterday's entries are the review's working set, but a chatty
 *  day must not pin ten thousand words into every request until
 *  the model submits. At most 60 entries, at most 8000 characters
 *  of entry text, highest significance first; the selected list is
 *  then shown chronologically so the model reads a conversation,
 *  not a ranking. When the list is cut, the prompt says so (only
 *  the important part is listed). Without a significanceOf the
 *  entries keep their given order and only the caps apply. */
export const MODEL_REVIEW_MAX_ENTRIES = 60;
export const MODEL_REVIEW_MAX_CHARS = 8000;

/** 0.4.6 (0.4.5 audit new issue 1): the merged recent section
 *  (reflection + proact, both "last 24 h") is capped much tighter
 *  than yesterday's list — it is a pointer to the day's notable
 *  entries, not a second copy of the day. At most 20 entries, at
 *  most 3000 characters of entry text. */
export const RECENT_MAX_ENTRIES = 20;
export const RECENT_MAX_CHARS = 3000;

export interface CappedEntryRow {
  entry: MemoryEntry;
  /** Text to print — the entry's own text, or its first
   *  maxChars characters + "…" when a single oversized entry
   *  would otherwise blow the budget (0.4.5 audit new issue 5). */
  displayText: string;
}

export interface CappedSelection {
  /** Entries shown in full, in chronological order. */
  shown: CappedEntryRow[];
  /** Entries past the caps: id + one-line summary only. The model
   *  may not cite these — it was never shown their full text. */
  overflow: { id: string; summary: string }[];
  /** Overflow entries not listed at all (beyond overflowMax) —
   *  counted, never silently dropped. */
  overflowHidden: number;
  total: number;
  /** True when something was cut: a text truncated, an entry
   *  skipped for budget, or entries overflowed. */
  cut: boolean;
}

export interface CappedSelectOptions {
  maxEntries: number;
  maxChars: number;
  significanceOf?: (entry: MemoryEntry) => number;
  /** Overflow lines at most this many (default 20). */
  overflowMax?: number;
  /** Summary length for overflow lines (default 30 characters). */
  summaryChars?: number;
}

/** 0.5.1 (0.4.3 §四): one line per entry, always — a newline
 *  inside a message must never survive as its own line in the
 *  prompt, or a forged "- [id] ..." line inside a message would
 *  look like a real prompt line. Applied to every displayText,
 *  every overflow summary, and every pasted quote below (and to
 *  the recall block's injected lines in recall.ts, same class). */
function oneLine(s: string): string {
  return s.replace(/[\r\n]+/g, " ");
}

/** Pick entries for a prompt section under an entry count and a
 *  character budget, highest significance first, shown
 *  chronologically. The budget is a hard cap, not a hint: an entry
 *  that does not fit is listed as id + summary instead (a shorter
 *  later one may still fit in full), and the FIRST ranked entry —
 *  which the old code always took whole — is truncated to the
 *  remaining budget instead of blowing the cap, so one
 *  20k-character memory cannot punch through an 8000-character
 *  ceiling. The overflow list itself is capped (overflowMax,
 *  default 20): on a 200-entry day the summaries alone would be
 *  ~9k characters per section, and a cap the overflow can blow is
 *  no cap at all — the rest are counted in overflowHidden. */
export function selectCappedEntries(
  entries: MemoryEntry[],
  opts: CappedSelectOptions,
): CappedSelection {
  const ranked = [...entries];
  if (opts.significanceOf) {
    const sig = opts.significanceOf;
    ranked.sort((a, b) => sig(b) - sig(a) || a.ts - b.ts);
  }
  const overflowMax = opts.overflowMax ?? 20;
  const summaryChars = opts.summaryChars ?? 30;
  const shown: CappedEntryRow[] = [];
  const overflow: { id: string; summary: string }[] = [];
  let overflowHidden = 0;
  let chars = 0;
  let cut = false;
  const summarize = (text: string): string => {
    const t = oneLine(text);
    return t.length > summaryChars ? t.slice(0, summaryChars) + "…" : t;
  };
  const pushOverflow = (e: MemoryEntry): void => {
    if (overflow.length < overflowMax) {
      overflow.push({ id: e.id, summary: summarize(e.text) });
    } else {
      overflowHidden += 1;
    }
    cut = true;
  };
  for (const e of ranked) {
    if (shown.length >= opts.maxEntries) {
      pushOverflow(e);
      continue;
    }
    if (chars + e.text.length > opts.maxChars) {
      if (shown.length === 0) {
        shown.push({
          entry: e,
          displayText: oneLine(e.text).slice(0, Math.max(0, opts.maxChars)) + "…",
        });
        chars = opts.maxChars;
        cut = true;
      } else {
        // Over budget but not first: id + summary, never dropped.
        pushOverflow(e);
      }
      continue;
    }
    shown.push({ entry: e, displayText: oneLine(e.text) });
    chars += e.text.length;
  }
  shown.sort((a, b) => a.entry.ts - b.entry.ts);
  return { shown, overflow, overflowHidden, total: entries.length, cut };
}

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
 *  model had no id outlet for fragments at all. 0.4.0 item 2: the
 *  same prompt also carries the code review's belief candidates
 *  (entry clusters that may support a belief about the
 *  relationship). The model writes the statement, picks the
 *  dimension and confirms via memory_belief (create) — the prompt
 *  only proposes, exactly like the fragment candidates.
 *  0.4.4: the same prompt also carries the code review's
 *  proactivity proposal (proactPrompt) and invalidation checks
 *  (invalidationEntries) — before this both were computed and then
 *  discarded (the prompt had no outlet in DSH; the checks were
 *  only a flag in attributes.json that nothing ever read), so the
 *  model could never act on either. The review only proposes;
 *  the model confirms via memory_proact / memory_invalidate.
 *  0.4.6 (0.4.5 audit new issue 1): the two pasted prompts above
 *  are replaced by ONE merged recent section when the caller
 *  passes recentEntries + recentReflection / recentProact — each
 *  pasted prompt listed all 24 h of memories verbatim (~37k
 *  characters each on a chatty day). The merged section lists the
 *  notable entries once (top 20 / 3000 characters, the rest as id
 *  + summary) with short instructions for both tools. The old
 *  pasted sections stay as a fallback for callers that still hand
 *  over pre-built strings. */
/** Render a capped selection's overflow (id + summary lines) and,
 *  when some overflow entries were not listed at all, say how
 *  many — the model must know the list is partial, and the
 *  entries must not vanish without a trace. */
function pushOverflowLines(lines: string[], sel: CappedSelection): void {
  for (const o of sel.overflow) {
    lines.push(`- [${o.id}] （摘要）${o.summary}`);
  }
  if (sel.overflowHidden > 0) {
    lines.push(`（另有 ${sel.overflowHidden} 条未列出。）`);
  }
}

export function buildModelReviewPrompt(
  entries: MemoryEntry[],
  candidates: FragmentCandidate[] = [],
  beliefCandidates: BeliefCandidate[] = [],
  reflectionPrompt: string = "",
  proactPrompt: string = "",
  invalidationEntries: MemoryEntry[] = [],
  options: {
    significanceOf?: (entry: MemoryEntry) => number;
    /** 0.4.6 (0.4.5 audit new issue 1): the entries behind the
     *  ONE merged recent section (reflection entries ∪ proact
     *  memories). When provided together with recentReflection /
     *  recentProact, the merged section replaces the two pasted
     *  prompt strings below — the old path is kept only for
     *  callers that still hand over pre-built strings. */
    recentEntries?: MemoryEntry[];
    /** The merged section carries the reflection instruction. */
    recentReflection?: boolean;
    /** The merged section carries the proactivity instruction. */
    recentProact?: boolean;
    /** 0.4.7 (0.4.6 audit new issue 1): the ids the reflection
     *  gate will accept as sources — the shell passes
     *  core.reflectionCheck().sourceIds here, which is also the
     *  gate snapshot the save path validates against (0.4.3 item
     *  8). A shown entry outside this set is marked in the merged
     *  section, so the model never cites an entry the save would
     *  refuse. When absent no marking happens (old callers). */
    reflectableIds?: string[];
  } = {},
): string {
  const sel = selectCappedEntries(entries, {
    maxEntries: MODEL_REVIEW_MAX_ENTRIES,
    maxChars: MODEL_REVIEW_MAX_CHARS,
    significanceOf: options.significanceOf,
  });
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
  if (sel.cut) {
    lines.push(
      `（昨天共有 ${sel.total} 条对话，这里只列了重要的部分：按重要度排在前面的 ${sel.shown.length} 条，剩下的不用复盘。）`,
    );
  }
  for (const r of sel.shown) {
    lines.push(`- [${r.entry.id}] [${r.entry.date} ${r.entry.time} ${r.entry.role}] ${r.displayText}`);
  }
  pushOverflowLines(lines, sel);
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
  if (beliefCandidates.length > 0) {
    lines.push(
      "",
      "另外，下面这几组对话可能支撑一条关于你们关系的信念（每组是一个话题下的几条原文，括号里是它们的 id，引号里是从原文逐字抄来的话）：",
    );
    for (const c of beliefCandidates) {
      lines.push(
        `- 话题“${c.topic}”：${c.sourceIds.map((id) => `[${id}]`).join("、")}；原文摘录：${c.quotes.map((q) => `“${oneLine(q)}”`).join("、")}`,
      );
    }
    lines.push(
      "如果你觉得某一组确实说明了他/你们关系里的一点，就调用 memory_belief 工具（action: \"create\"），自己写一句话信念、选一个维度（safety 安全感 / trust 信任 / closeness 亲近），用这组里的 id 当 entryId、把上面引号里的原话当 quote 传回来；引用必须是逐字抄的，不能改写。不值得的就不建，不用每组都建。",
    );
  }
  // 0.4.6 (0.4.5 audit new issue 1): the reflection and proact
  // proposals travel as ONE merged section, not two pasted prompts.
  // Each used to list all 24 h of memories verbatim (~37k
  // characters each on a chatty day) — the merged section lists
  // the notable entries once (top 20 / 3000 characters, the rest
  // as id + summary), and the instructions say how to act on them
  // (the standalone gates build their own full prompts when the
  // model calls memory_reflect / memory_proact). The old pasted
  // sections below are kept only for callers that still hand over
  // pre-built strings and pass no recent entries.
  const useMerged = Boolean(
    options.recentReflection || options.recentProact,
  );
  if (useMerged) {
    const recent = selectCappedEntries(options.recentEntries ?? [], {
      maxEntries: RECENT_MAX_ENTRIES,
      maxChars: RECENT_MAX_CHARS,
      significanceOf: options.significanceOf,
    });
    const kinds =
      options.recentReflection && options.recentProact
        ? "一份主动提议和一次反思机会"
        : options.recentProact
          ? "一份主动提议"
          : "一次反思机会";
    lines.push(
      "",
      `另外，复盘还算出了${kinds}——最近 24 小时里值得注意的几条对话如下（每条前面是它的 id，按重要度排在前面的几条列出原文，其余只给 id 和一句话摘要）：`,
      "",
    );
    if (recent.shown.length === 0 && recent.overflow.length === 0) {
      lines.push("（今天没有值得注意的新对话。）");
    } else {
      // 0.4.7 (0.4.6 audit new issue 1): a shown entry the
      // reflection gate will not accept as a source is marked, so
      // the model never cites it — the merged section shows every
      // 24 h entry (including already-reflected ones, which the
      // gate excludes), but the save path only accepts the gate's
      // sourceIds. The mark is deliberately neutral ("本次反思不
      // 可引用", not "已反思"): an entry can also fall outside
      // the gate's shown top 20 when new entries arrived after
      // the review was computed. Only when the section carries
      // the reflection instruction AND the caller passed the
      // gate's ids; without them there is no marking, as before.
      const reflectable =
        options.recentReflection && options.reflectableIds
          ? new Set(options.reflectableIds)
          : null;
      for (const r of recent.shown) {
        const mark =
          reflectable && !reflectable.has(r.entry.id)
            ? "（本次反思不可引用）"
            : "";
        lines.push(`- [${r.entry.id}] [${r.entry.date} ${r.entry.time} ${r.entry.role}] ${r.displayText}${mark}`);
      }
      pushOverflowLines(lines, recent);
      if (recent.cut) {
        lines.push(
          `（最近 24 小时共有 ${recent.total} 条，这里只列了重要的部分，剩下的不用复盘。）`,
        );
      }
    }
    if (options.recentProact) {
      lines.push(
        "",
        "请你自己掂量一下：现在要不要主动找他说句话？先想想该不该打扰他、现在说合不合适；不要为了主动而主动；不行动是完全可以接受的回答，没什么值得说的就不用说。",
        "如果你觉得值得主动，先调用 memory_proact 工具（空参数）拿当次的提示和 token，再把决定交回来；这份复盘提示没有给你发 token——它里面说的 promptToken 不是这份提示里的东西。不主动就什么都不用调。",
      );
    }
    if (options.recentReflection) {
      lines.push(
        "",
        "另外，这些对话放在一起，能看出什么新东西吗？比如他最近的状态、你们之间有什么变化、他反复提到的事背后是什么意思。做不做反思由你自己决定，不用每轮都反思；没看出新东西就不用反思，一个字都不用写。",
        // 0.4.7: when the caller passed the gate's ids, shown
        // entries outside it carry the mark — say so, or the mark
        // is unexplained noise. Without the ids the old wording
        // stands (old callers, fallback prompts).
        "如果你决定反思，写一句结论就行；结论里引用的每一句话都要用「」括起来，从上面列出原文的条目里逐字抄，不能改写（摘要条目没有原文，不能当引用来源" +
          (options.reflectableIds
            ? "；带“本次反思不可引用”标记的条目这次不能当引用来源" : "") +
          "）；不要编原文里没有的词，不要编他没说过的事。反思好了就调用 memory_reflect 工具，把结论和来源 id 交回来保存。",
      );
    }
  } else {
    // 0.4.0 item 3: the code review's reflection prompt travels
    // with the daily review too — the review only proposes (the
    // prompt exists only when the 24 h floor was cleared); the
    // model decides whether to reflect and saves the conclusion
    // via memory_reflect. No prompt, no section: below the floor
    // she is never asked.
    if (reflectionPrompt.trim().length > 0) {
      lines.push("", "另外，最近 24 小时里新对话攒够了，值得你想想有没有新发现：", "");
      lines.push(reflectionPrompt);
    }
    // 0.4.4: the code review's proactivity proposal travels with the
    // daily review too — the review only proposes (the prompt exists
    // only when the day was non-empty); the model decides whether to
    // act and submits via memory_proact. The pasted text is the
    // proposal's CONTENT (what she might say and why) — its token
    // line is about a live gate call, not this review prompt: this
    // prompt issues no token, so to act she first calls
    // memory_proact with {} and gets a fresh prompt+token, then
    // submits the decision. No prompt, no section: an empty day
    // never asks her.
    if (proactPrompt.trim().length > 0) {
      lines.push(
        "",
        "另外，复盘还算出了一份主动提议——今天可能值得你主动找他说句话（下面是这份提议的原文）：",
        "",
        proactPrompt,
        "",
        "上面这份提议是复盘时算出来的，不是现在新发的提示：它里面说的 promptToken 不是这份复盘提示里的东西。这份复盘提示没有给你发 token——如果你觉得值得主动，先调用 memory_proact 工具（空参数）拿当次的提示和 token，再把决定交回来；它里面“不主动也调一次”那句是对着当次 gate 提示说的，不是对着这份复盘提示说的，不主动就什么都不用调。",
      );
    }
  }
  // 0.4.4: the code review's invalidation checks travel with the
  // daily review too — the review only proposes. Each entry carries
  // its id and text; the model confirms via memory_invalidate, or
  // leaves it alone (it will be proposed again at the next review
  // until she acts or the opposing statement itself ages past 30
  // days, when the check lapses on its own). 0.4.6: the section is
  // capped like the others (10 entries / 2000 characters) — the
  // first-entry budget rule applies to all four sections, so one
  // oversized entry cannot blow the prompt.
  if (invalidationEntries.length > 0) {
    const inv = selectCappedEntries(invalidationEntries, {
      maxEntries: 10,
      maxChars: 2000,
    });
    lines.push(
      "",
      "另外，下面这几条旧记忆可能已经过时了（每条后面是它的 id 和原文）：",
    );
    for (const r of inv.shown) {
      lines.push(`- [${r.entry.id}] [${r.entry.date} ${r.entry.time} ${r.entry.role}] ${r.displayText}`);
    }
    pushOverflowLines(lines, inv);
    lines.push(
      "如果你觉得某条确实不再是现况，就调用 memory_invalidate 工具，把它的 id 和原因交回来；如果你觉得它其实没过时，就不用管它——下次复盘还会再问你，直到你作废它，或者那句反话本身也过了 30 天。",
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
