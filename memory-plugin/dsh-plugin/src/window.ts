// 终版 WP1 — window boundary: permission (session mode) is separate
// from content (entry kind).
//
// The old shell guessed one thing — "is this a persona window?" — from
// a trigger word, latched it forever, and then recorded every message
// in that session as persona memory. A task that happened to mention
// her name, or a work turn inside a chat session, became "her memory".
//
// This module keeps the judgement small and testable:
//   - session mode is switched ONLY by an exact declaration phrase
//     ("任务窗口" / "人设窗口") after trigger words and punctuation
//     are stripped; a trigger word alone never demotes a declared
//     task session;
//   - every user message is classified as persona / task / greeting;
//   - a bare trigger ("夏柠柒") is a greeting: it still marks the
//     session (the latch must survive), but the line is not memory;
//   - the assistant reply follows the turn: her conversational words
//     are persona, work output (code / table / long dump) is task.
//
// Pure functions, no I/O — the shell does the recording and the tests
// call these directly.

export type SessionMode = "persona" | "task";
export type EntryKind = "persona" | "task" | "greeting";

export const DEFAULT_DECLARATION_PHRASES: {
  task: string[];
  persona: string[];
} = {
  task: ["任务窗口", "切任务", "按任务处理", "进入任务"],
  persona: ["人设窗口", "切回人设", "回到人设", "进入人设"],
};

/** Words that ask for work (must pair with a work object). */
const IMPERATIVE_MARKERS: string[] = [
  "帮我",
  "帮忙",
  "请你",
  "请帮",
  "把",
  "给我",
  "替我",
  "改",
  "写",
  "生成",
  "整理",
  "检查",
  "导出",
  "翻译",
  "总结",
  "润色",
  "校对",
  "做个",
  "弄个",
  "处理",
  "修",
  "优化",
  "重构",
  "部署",
  "安装",
  "更新",
  "删除",
  "重写",
  "复制",
  "移动",
  "截图",
  "识别",
  "解析",
  "转换",
  "格式化",
  "补全",
  "注释",
  "翻译成",
  "改成",
  "写成",
  "整理成",
  "检查一下",
  "看一下",
  "看看",
  "读一下",
  "跑一下",
];

/** Things that can be worked on. A task needs one of these. */
const WORK_OBJECTS: string[] = [  "文档",
  "文件",
  "代码",
  "表格",
  "清单",
  "报告",
  "邮件",
  "文案",
  "段落",
  "句子",
  "标题",
  "链接",
  "图片",
  "附件",
  "数据",
  "这段",
  "这篇",
  "这份",
  "这段文字",
  "文本",
  "文字",
  "内容",
  "项目",
  "仓库",
  "脚本",
  "函数",
  "接口",
  "页面",
  "网站",
  "程序",
  "日志",
  "配置",
  "需求",
  "方案",
  "提纲",
  "导图",
  "ppt",
  "word",
  "excel",
  "markdown",
  "json",
  "yaml",
  "ts",
  "js",
  "py",
  "sql",
  "code",
];

/** Chat signals: greetings, feelings, relationship talk. Deliberately
 *  not single characters ("累" would fire on "累加器"). */
const PERSONA_CUES: string[] = [
  "在吗",
  "在不在",
  "你在干嘛",
  "干嘛呢",
  "你好",
  "您好",
  "早安",
  "早上好",
  "晚安",
  "晚上好",
  "嗨",
  "哈喽",
  "好久不见",
  "想你",
  "想我",
  "喜欢你",
  "爱我",
  "爱我吗",
  "疼我",
  "哄我",
  "陪我",
  "抱抱",
  "亲亲",
  "聊天",
  "说说话",
  "好累",
  "累了",
  "很累",
  "有点累",
  "好困",
  "困了",
  "好饿",
  "饿了",
  "难过",
  "不开心",
  "开心",
  "生气",
  "害怕",
  "孤单",
  "寂寞",
  "想哭",
  "委屈",
  "我好看",
  "我美",
  "美不美",
  "我今天",
  "你觉得我",
  "你是不是",
  "吃了吗",
  "睡了吗",
  "怎么了",
  "想你了",
];

/** Strip trigger words, then whitespace / punctuation / symbols. */
export function stripDecorations(
  text: string,
  triggerWords: string[],
): string {
  let out = text;
  for (const w of triggerWords) {
    if (w.length > 0) out = out.split(w).join("");
  }
  return out.replace(/[\s\p{P}\p{S}]/gu, "");
}

/** An exact mode declaration, or null. The trigger words and all
 *  punctuation are stripped first, so "夏柠柒，任务窗口" counts and
 *  "我们按任务处理这件事吧" does not. */
export function matchDeclaration(
  text: string,
  triggerWords: string[],
  phrases: { task: string[]; persona: string[] } = DEFAULT_DECLARATION_PHRASES,
): SessionMode | null {
  const stripped = stripDecorations(text, triggerWords);
  if (stripped.length === 0) return null;
  if (phrases.task.some((p) => stripped === p)) return "task";
  if (phrases.persona.some((p) => stripped === p)) return "persona";
  return null;
}

/** True when the message is nothing but trigger words (plus
 *  punctuation): "夏柠柒" / "夏柠柒，柠柒" — a call, not a message. */
export function isBareTrigger(
  text: string,
  triggerWords: string[],
): boolean {
  if (!triggerWords.some((w) => w.length > 0 && text.includes(w))) {
    return false;
  }
  return stripDecorations(text, triggerWords).length === 0;
}

/** Technical signals that make a message work even without an
 *  imperative ("夏柠柒agent工作版……讲讲你的看法" is a task about the
 *  plugin, not chat). Deliberately excludes ambiguous words like
 *  "版本" that appear in ordinary chat. */
const TECHNICAL_WORDS: string[] = [
  "插件",
  "代码",
  "仓库",
  "github",
  "skill.md",
  "接口",
  "部署",
  "脚本",
  "函数",
  "数据库",
  "服务器",
  "配置",
  "日志",
  "报错",
  "编译",
  "测试",
  "提交",
  "合并",
  "分支",
  "依赖",
  "安装包",
  "json",
  "yaml",
];

/** Imperative marker AND a concrete work object. "帮我看看我今天美不美"
 *  has the marker but no object, so it stays chat; "帮我把这段文字改得
 *  像你说话的口气" has both, so it is work. A technical word is work
 *  on its own (a question about the plugin is not a chat turn even
 *  without "帮我"). */
export function isTaskShaped(text: string): boolean {
  const lower = text.toLowerCase();
  if (TECHNICAL_WORDS.some((w) => lower.includes(w))) return true;
  const hasImperative = IMPERATIVE_MARKERS.some((w) =>
    lower.includes(w.toLowerCase()),
  );
  if (!hasImperative) return false;
  return WORK_OBJECTS.some((w) => lower.includes(w.toLowerCase()));
}

/** Greeting / feeling / relationship signal. */
export function hasPersonaCue(text: string): boolean {
  return PERSONA_CUES.some((w) => text.includes(w));
}

/** Classify one user message. "skip" = do not record at all
 *  (declaration, or a task-window message with no persona content). */
export function classifyContent(
  text: string,
  mode: SessionMode,
  triggerWords: string[],
  phrases?: { task: string[]; persona: string[] },
): EntryKind | "skip" {
  if (matchDeclaration(text, triggerWords, phrases) !== null) return "skip";
  if (isBareTrigger(text, triggerWords)) return "greeting";
  if (isTaskShaped(text)) return "task";
  if (hasPersonaCue(text)) return "persona";
  return mode === "persona" ? "persona" : "skip";
}

/** Count code points (emoji-safe) for the length threshold. */
export function countCodePoints(text: string): number {
  return [...text].length;
}

/** Code fence, markdown table, or a list of 5+ items — the shapes
 *  that mean "work output" rather than "her words". */
export function hasWorkArtifact(text: string): boolean {
  if (/```|~~~/.test(text)) return true;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length - 1; i += 1) {
    if (/\|/.test(lines[i]) && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1])) {
      return true;
    }
  }
  const listItems = lines.filter((l) =>
    /^\s*(?:[-*+]\s+|\d+[.)]\s+)/.test(l),
  ).length;
  return listItems >= 5;
}

/** Classify the assistant reply that follows a user turn of `userKind`.
 *  - greeting turn -> greeting (not memory);
 *  - persona turn -> persona, unless the reply is a work artifact
 *    (a 1200-char confession stays persona — the 800 limit does not
 *    apply to chat turns);
 *  - task turn -> task when it carries an artifact or exceeds
 *    maxChars; otherwise the short conversational reply stays persona. */
export function classifyAssistantReply(
  userKind: EntryKind,
  text: string,
  maxChars = 800,
): EntryKind {
  if (userKind === "greeting") return "greeting";
  if (userKind === "persona") {
    return hasWorkArtifact(text) ? "task" : "persona";
  }
  if (hasWorkArtifact(text)) return "task";
  if (countCodePoints(text) > maxChars) return "task";
  return "persona";
}

/** Parse persona-sessions.json, accepting both shapes:
 *  - old:   ["session-a", "session-b"]           -> all persona
 *  - new:   {"session-a":"persona","s":"task"}   -> as written
 *  Corrupt / missing -> empty map (never throws). */
export function parsePersonaSessions(
  raw: string,
): Map<string, SessionMode> {
  const out = new Map<string, SessionMode>();
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      for (const id of parsed) {
        if (typeof id === "string" && id.length > 0) out.set(id, "persona");
      }
      return out;
    }
    if (parsed && typeof parsed === "object") {
      for (const [sid, mode] of Object.entries(
        parsed as Record<string, unknown>,
      )) {
        if (mode === "persona" || mode === "task") out.set(sid, mode);
        else if (mode === true) out.set(sid, "persona");
      }
    }
  } catch {
    // Missing or corrupt: empty; the file is rebuilt on the next switch.
  }
  return out;
}

/** Serialize the mode map (newest 500, matching the old cap). */
export function serializePersonaSessions(
  map: Map<string, SessionMode>,
): string {
  const obj: Record<string, SessionMode> = {};
  for (const [sid, mode] of [...map.entries()].slice(-500)) {
    obj[sid] = mode;
  }
  return `${JSON.stringify(obj)}\n`;
}
