// Three-layer MEMORY.md READER — read-only.
//
// The plugin NEVER writes MEMORY.md. The three-layer summaries stay
// written by the model following the skill (v2.4): layer 1 current
// state at the head, layer 2 recent-30-days entries, layer 3 monthly
// summaries plus MEMORY-YYYY-MM.md archives. The core reads all three
// layers (and the archives) for recall, and reads layer 1 so it knows
// the stage — but it injects only what the skill has NOT already read
// (raw-log fragments and archive detail), never layer 1 itself, so the
// same memory never appears twice in context. The core also never makes
// stage judgments; stage comes from MEMORY.md layer 1.
//
// Two file shapes are accepted (the skill's real format AND the
// plugin's older hand-written format), so old fixtures keep working:
// - Skill v2.4 (canonical): date headings `## 2026/11/02`, entries
//   `[14:32] 事件一句话` (no dash, no metadata), layer-1 keys
//   `喜好` / `厌恶` / `最后更新时间`, layer 3 titled `旧月份总结区`.
// - Plugin format: date headings `### 2026/11/02`, entries
//   `- HH:MM [role|window|importance] text`, layer-1 keys `喜欢` /
//   `不喜欢`, layer 3 titled `月度归档`.
//
// The parser is tolerant: it reads the documented shape even when the
// file was written by hand (or by the model following the skill)
// without the exact canonical markers, and it preserves unrecognised
// layer-1 lines verbatim in `extra`.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseDateHeading } from "./dates.ts";
import { tokenize } from "./tokenize.ts";
import type {
  Layer1State,
  MemoryEntry,
  MonthlySummary,
  ParsedMemoryFile,
} from "./types.ts";

// Skill format uses ##, plugin format uses ### — both are accepted.
const DATE_HEADING = /^#{2,3}\s+(\d{4}\/\d{2}\/\d{2})\s*$/;
// Plugin format: "- HH:MM [role|window|importance] text".
const ENTRY_LINE =
  /^-\s+(\d{2}:\d{2})\s+(?:\[([^\]]+)\]\s+)?(.*)$/;
// Skill v2.4 format: "[HH:MM] text" — no dash, no metadata.
const SKILL_ENTRY_LINE = /^\[(\d{2}:\d{2})\]\s+(.*)$/;
// Layer-3 summary lines: "- YYYY-MM: ..." or bare "YYYY-MM: ...".
const MONTH_LINE = /^(?:-\s+)?(\d{4}-\d{2})[:：]\s*(.*)$/;
// Fallback summary line without a colon: "YYYY-MM 共 N 条 ...".
const MONTH_LINE_LOOSE = /^(?:-\s+)?(\d{4}-\d{2})\s+(.+)$/;
const SECTION_HEADING = /^##\s+(.*)$/;

function emptyLayer1(): Layer1State {
  return {
    likes: [],
    dislikes: [],
    agreements: [],
    counters: {},
    heavyNotes: [],
    extra: [],
  };
}

/** Stable id for a parsed entry: date + time + content hash. The same
 *  line always gets the same id, so a raw-log fragment and its archive
 *  copy dedupe; different lines (almost) never collide. */
function entryId(date: string, time: string, text: string): string {
  const hash = createHash("sha256")
    .update(`${date}|${time}|${text}`)
    .digest("hex")
    .slice(0, 16);
  return `md-${date}-${time}-${hash}`;
}

function parseBracket(
  raw: string | undefined,
): Pick<MemoryEntry, "role" | "window" | "importance"> {
  const out: Pick<MemoryEntry, "role" | "window" | "importance"> = {
    role: "user",
    window: "persona",
    importance: "light",
  };
  if (!raw) return out;
  for (const part of raw.split(/[|,\s]+/)) {
    if (part === "user" || part === "assistant") out.role = part;
    else if (part === "persona" || part === "task") out.window = part;
    else if (part === "heavy" || part === "light") out.importance = part;
  }
  return out;
}

function splitList(value: string): string[] {
  return value
    .split(/[,、，]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseLayer1(lines: string[]): Layer1State {
  const layer1 = emptyLayer1();
  let mode: "none" | "agreements" | "heavy" = "none";
  for (const line of lines) {
    const trimmed = line.trim();
    // Layer-1 keys may or may not carry a "- " prefix; the skill's
    // own wording is 喜好 / 厌恶, the plugin's older wording is
    // 喜欢 / 不喜欢 — both are accepted.
    const m = /^(?:-\s+)?([^:：]+)[:：]\s*(.*)$/.exec(trimmed);
    if (m) {
      const key = m[1].trim();
      const value = m[2].trim();
      if (key === "名字") {
        layer1.name = value;
        mode = "none";
      } else if (key === "阶段") {
        layer1.stage = value;
        mode = "none";
      } else if (key === "喜欢" || key === "喜好") {
        layer1.likes = splitList(value);
        mode = "none";
      } else if (key === "不喜欢" || key === "厌恶") {
        layer1.dislikes = splitList(value);
        mode = "none";
      } else if (key === "约定") {
        mode = "agreements";
        if (value) layer1.agreements.push(value);
      } else if (key === "计数") {
        mode = "none";
        for (const part of value.split(/[;；]/)) {
          const kv = /^([^=]+)=(.+)$/.exec(part.trim());
          if (kv) layer1.counters[kv[1].trim()] = Number(kv[2]) || 0;
        }
      } else if (key === "重要记忆") {
        mode = "heavy";
        if (value) layer1.heavyNotes.push(value);
      } else if (key === "最后更新时间") {
        layer1.lastUpdated = value;
        mode = "none";
      } else {
        layer1.extra.push(line);
        mode = "none";
      }
      continue;
    }
    // Continuation lines under 约定 / 重要记忆 (dash optional).
    const item = /^(?:-\s+)?(.+)$/.exec(trimmed);
    if (item) {
      if (mode === "agreements") layer1.agreements.push(item[1].trim());
      else if (mode === "heavy") layer1.heavyNotes.push(item[1].trim());
      else if (trimmed) layer1.extra.push(line);
      continue;
    }
    if (trimmed) layer1.extra.push(line);
  }
  return layer1;
}

function parseEntryLine(
  line: string,
  date: string,
): MemoryEntry | null {
  const m = ENTRY_LINE.exec(line);
  const skill = m ? null : SKILL_ENTRY_LINE.exec(line);
  if (!m && !skill) return null;
  const time = m ? m[1] : (skill as RegExpExecArray)[1];
  const text = (m ? m[3] : (skill as RegExpExecArray)[2]).trim();
  const meta = m ? parseBracket(m[2]) : { role: "user" as const, window: "persona" as const, importance: "light" as const };
  const ts =
    (parseDateHeading(date) ?? 0) +
    Number(time.slice(0, 2)) * 3_600_000 +
    Number(time.slice(3, 5)) * 60_000;
  return {
    id: entryId(date, time, text),
    ts,
    date,
    time,
    role: meta.role,
    window: meta.window,
    sessionId: "",
    importance: meta.importance,
    text,
  };
}

export function parseMemoryText(text: string): ParsedMemoryFile {
  const lines = text.split("\n");
  const layer1Lines: string[] = [];
  const layer2: MemoryEntry[] = [];
  const layer3: MonthlySummary[] = [];
  let section: "layer1" | "layer2" | "layer3" = "layer1";
  let currentDate: string | null = null;

  for (const line of lines) {
    // Date headings must be checked BEFORE section headings: a skill
    // date heading ("## 2026/11/02") also matches SECTION_HEADING,
    // and the old order swallowed it as a section title (layer 2
    // parsed as 0 entries).
    const date = DATE_HEADING.exec(line);
    if (date) {
      section = "layer2";
      currentDate = date[1];
      continue;
    }
    const heading = SECTION_HEADING.exec(line);
    if (heading) {
      const title = heading[1];
      if (/最近|30天/.test(title)) section = "layer2";
      else if (/归档|月度|旧月份|总结/.test(title)) section = "layer3";
      continue;
    }
    if (section === "layer1") {
      layer1Lines.push(line);
    } else if (section === "layer2" && currentDate) {
      const entry = parseEntryLine(line, currentDate);
      if (entry) layer2.push(entry);
    } else if (section === "layer3") {
      const m = MONTH_LINE.exec(line) ?? MONTH_LINE_LOOSE.exec(line);
      if (m) {
        layer3.push({
          month: m[1],
          total: 0,
          heavy: 0,
          events: m[2] ? [m[2]] : [],
        });
      }
    }
  }

  layer2.sort((a, b) => a.ts - b.ts);
  layer3.sort((a, b) => a.month.localeCompare(b.month));
  return { layer1: parseLayer1(layer1Lines), layer2, layer3 };
}

export function parseArchiveText(month: string, text: string): MemoryEntry[] {
  const entries: MemoryEntry[] = [];
  let currentDate: string | null = null;
  for (const line of text.split("\n")) {
    const date = DATE_HEADING.exec(line);
    if (date) {
      currentDate = date[1];
      continue;
    }
    if (!currentDate) continue;
    const entry = parseEntryLine(line, currentDate);
    // Archive rows carry no role metadata in the skill format (they
    // default to role "user" in parseEntryLine); mark the source so
    // recall never labels her words as [user] (audit m8).
    if (entry) entries.push({ ...entry, source: "archive" });
  }
  entries.sort((a, b) => a.ts - b.ts);
  return entries;
}

export function archiveFileName(month: string): string {
  return `MEMORY-${month}.md`;
}

/** Read-only access to the skill's memory files. Parsed results are
 *  cached by file mtime+size, so a per-turn recall does not re-read
 *  and re-parse MEMORY.md and every archive on every turn; any write
 *  changes mtime/size and the cache is dropped. */
export class MemoryFile {
  private readonly dir: string;
  private memCache: { key: string; parsed: ParsedMemoryFile } | null =
    null;
  private archiveCache = new Map<
    string,
    { key: string; entries: MemoryEntry[] }
  >();

  constructor(dir: string) {
    this.dir = dir;
  }

  get path(): string {
    return join(this.dir, "MEMORY.md");
  }

  private fileKey(path: string): string | null {
    try {
      const s = statSync(path);
      return `${s.mtimeMs}:${s.size}`;
    } catch {
      return null;
    }
  }

  load(): ParsedMemoryFile {
    if (!existsSync(this.path)) {
      this.memCache = null;
      return { layer1: emptyLayer1(), layer2: [], layer3: [] };
    }
    const key = this.fileKey(this.path);
    if (key && this.memCache && this.memCache.key === key) {
      return this.memCache.parsed;
    }
    const parsed = parseMemoryText(readFileSync(this.path, "utf8"));
    if (key) this.memCache = { key, parsed };
    return parsed;
  }

  listArchiveMonths(): string[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((f) => /^MEMORY-\d{4}-\d{2}\.md$/.test(f))
      .map((f) => f.slice("MEMORY-".length, -".md".length))
      .sort();
  }

  readArchive(month: string): MemoryEntry[] {
    const file = join(this.dir, archiveFileName(month));
    if (!existsSync(file)) return [];
    const key = this.fileKey(file);
    if (key) {
      const cached = this.archiveCache.get(month);
      if (cached && cached.key === key) return cached.entries;
    }
    const entries = parseArchiveText(month, readFileSync(file, "utf8"));
    if (key) this.archiveCache.set(month, { key, entries });
    return entries;
  }

  /** Keyword search across all monthly archives (token match on text). */
  searchArchives(tokens: string[]): MemoryEntry[] {
    const hits: MemoryEntry[] = [];
    for (const month of this.listArchiveMonths()) {
      for (const e of this.readArchive(month)) {
        const entryTokens = new Set(tokenize(e.text));
        if (tokens.some((t) => entryTokens.has(t))) hits.push(e);
      }
    }
    return hits;
  }
}
