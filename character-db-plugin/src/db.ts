// Character DB loader + search (read-only).
//
// Semantics mirror query.mjs in the character-db directory exactly:
// - same tokenizer (CJK overlapping bigrams + latin words + single
//   chars, high-frequency empty words excluded from single-char
//   tokens);
// - same filters (type alias, chapter num / range / label, addressee,
//   emotion, stage);
// - same scoring (tags 3 / text 2 / other fields 1 + whole-phrase
//   bonus 5) and same sort (score desc, chapter asc, id asc).
//
// Differences from query.mjs, deliberate:
// - profile.json tags are derived from the file's own name / birth
//   name instead of hardcoding one character's names, so another
//   character's directory reuses this loader unchanged;
// - a corrupt JSON file is skipped with a warning instead of killing
//   the whole load (a single bad file must not blind the plugin);
// - token estimation + token-cap truncation live here, because the
//   tool layer needs them and query.mjs has no cap.
//
// This module NEVER writes: it only reads *.json in dataDir.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

export interface DbEntry {
  id: string;
  type: string;
  chapter: number | null;
  chapter_label: string | null;
  chapter_range: [number, number] | null;
  stage: string | null;
  addressee: string | null;
  emotion: string[];
  tags: string[];
  text: string;
  scene: string | null;
  source: string;
  file: string;
  other: string;
  raw: unknown;
}

export interface CharacterDb {
  character: string;
  characterName: string;
  entries: DbEntry[];
  filesLoaded: string[];
  filesSkipped: string[];
}

// ---------------------------------------------------------------- tokenizer
// Copied semantics from query.mjs (same regexes, same stop set).
const CJK_RUN =
  /[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\u{20000}-\u{2a6df}\u{2a700}-\u{2b73f}\u{2b740}-\u{2b81f}\u{2b820}-\u{2ceaf}\u{2ceb0}-\u{2ebef}\u{30000}-\u{3134a}]+/gu;
const WORD_RUN = /[a-z0-9]+(?:[.'-][a-z0-9]+)*/g;

const CJK_SINGLE_STOP = new Set([
  "的", "了", "在", "是", "有", "和", "就", "都", "也", "还",
  "不", "没", "很", "这", "那", "我", "你", "他", "她", "它", "们",
  "个", "一", "上", "下", "来", "去", "吗", "呢", "吧", "啊", "哦",
  "嗯", "呀", "么",
]);

export function tokenize(text: string): string[] {
  if (typeof text !== "string") return [];
  const out = new Set<string>();
  for (const m of text.toLowerCase().matchAll(WORD_RUN)) out.add(m[0]);
  for (const m of text.matchAll(CJK_RUN)) {
    const run = m[0];
    if (run.length > 1 && run.length <= 6) out.add(run);
    for (const ch of run) {
      if (!CJK_SINGLE_STOP.has(ch)) out.add(ch);
    }
    for (let i = 0; i + 1 < run.length; i++) out.add(run.slice(i, i + 2));
  }
  return [...out];
}

// ---------------------------------------------------------------- loading
export const TYPE_ALIASES: Record<string, string> = {
  lines: "lines",
  line: "lines",
  inner: "inner_monologues",
  inner_monologues: "inner_monologues",
  events: "key_events",
  key_events: "key_events",
  traits: "traits",
  relationships: "relationships",
  rules: "speech_rules",
  speech_rules: "speech_rules",
  arc: "growth_arc",
  growth_arc: "growth_arc",
  profile: "profile",
  flags: "flags",
};

export function resolveTypeAlias(type: string | undefined): string | null {
  if (type === undefined || type === null || `${type}`.trim() === "") {
    return null;
  }
  const key = `${type}`.trim().toLowerCase();
  if (TYPE_ALIASES[key]) return TYPE_ALIASES[key];
  // Accept a bare collection name too (it is the canonical name).
  if (Object.values(TYPE_ALIASES).includes(key)) return key;
  return undefined as unknown as string;
}

function flattenStrings(value: unknown, out: string[]): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => flattenStrings(v, out));
  else if (value && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) {
      flattenStrings(v, out);
    }
  }
  return out;
}

/** Load a character-db directory. Throws when the directory does not
 *  exist or holds no usable entries; a single corrupt file is
 *  skipped with a warning and never kills the load. */
export function loadDb(dataDir: string): CharacterDb {
  if (!existsSync(dataDir)) {
    throw new Error(`人物数据库目录不存在：${dataDir}`);
  }
  const files = readdirSync(dataDir)
    .filter((f) => f.endsWith(".json") && f !== "index.json")
    .sort();
  const entries: DbEntry[] = [];
  const filesLoaded: string[] = [];
  const filesSkipped: string[] = [];
  let character = basename(dataDir);
  let characterName = "";
  for (const file of files) {
    let data: unknown;
    try {
      data = JSON.parse(readFileSync(join(dataDir, file), "utf8")) as unknown;
    } catch (err) {
      filesSkipped.push(file);
      console.warn(
        `[character-db] 跳过损坏的文件 ${file}：${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    if (!data || typeof data !== "object") {
      filesSkipped.push(file);
      console.warn(`[character-db] 跳过空文件 ${file}：不是 JSON 对象。`);
      continue;
    }
    const obj = data as {
      character?: unknown;
      character_name?: unknown;
      collection?: unknown;
      profile?: Record<string, unknown>;
      entries?: unknown[];
    };
    if (typeof obj.character === "string" && obj.character) {
      character = obj.character;
    }
    if (typeof obj.character_name === "string" && obj.character_name) {
      characterName = obj.character_name;
    }
    if (obj.profile) {
      // profile.json is a single object: flatten it into one
      // searchable record, like query.mjs does.
      const profile = obj.profile;
      const name =
        typeof profile.name === "string" ? profile.name : characterName;
      const birthName =
        typeof profile.birth_name === "string" ? profile.birth_name : "";
      const flat = flattenStrings(profile, []).join(" / ");
      entries.push({
        id: "profile",
        type: "profile",
        chapter: null,
        chapter_label: null,
        chapter_range: null,
        stage: null,
        addressee: null,
        emotion: [],
        tags: ["档案", name, birthName].filter(Boolean),
        text: flat,
        scene: null,
        source: "v2.4-portrayal",
        file: basename(file),
        other: "",
        raw: profile,
      });
      filesLoaded.push(file);
      continue;
    }
    const list = Array.isArray(obj.entries) ? obj.entries : [];
    for (const e of list) {
      if (!e || typeof e !== "object") continue;
      const entry = e as Record<string, unknown>;
      const other: string[] = [];
      for (const k of [
        "person",
        "relation",
        "rule",
        "trait",
        "title",
        "event",
        "range_label",
        "flag_type",
        "status",
      ]) {
        if (typeof entry[k] === "string") other.push(entry[k] as string);
      }
      entries.push({
        id: typeof entry.id === "string" ? entry.id : "",
        type:
          typeof entry.type === "string"
            ? entry.type
            : typeof obj.collection === "string"
              ? obj.collection
              : basename(file, ".json"),
        chapter:
          typeof entry.chapter === "number" ? entry.chapter : null,
        chapter_label:
          typeof entry.chapter_label === "string"
            ? entry.chapter_label
            : null,
        chapter_range: Array.isArray(entry.chapter_range)
          ? (entry.chapter_range as [number, number])
          : null,
        stage: typeof entry.stage === "string" ? entry.stage : null,
        addressee:
          typeof entry.addressee === "string" ? entry.addressee : null,
        emotion: Array.isArray(entry.emotion)
          ? (entry.emotion as string[])
          : [],
        tags: Array.isArray(entry.tags) ? (entry.tags as string[]) : [],
        text: typeof entry.text === "string" ? entry.text : "",
        scene: typeof entry.scene === "string" ? entry.scene : null,
        source: typeof entry.source === "string" ? entry.source : "",
        file: basename(file),
        other: other.join(" / "),
        raw: e,
      });
    }
    filesLoaded.push(file);
  }
  if (entries.length === 0) {
    throw new Error(
      `人物数据库目录 ${dataDir} 里没有可用的条目（已读 ${filesLoaded.length} 个文件，跳过 ${filesSkipped.length} 个）。`,
    );
  }
  return { character, characterName, entries, filesLoaded, filesSkipped };
}

// ---------------------------------------------------------------- filters
export type ChapterSpec =
  | { kind: "num"; num: number }
  | { kind: "range"; min: number; max: number }
  | { kind: "label"; num: number; label: string }
  | { kind: "unknown"; raw: string };

export function parseChapterSpec(spec: string): ChapterSpec {
  const s = `${spec}`.trim().toLowerCase();
  const range = s.match(/^(\d+)\s*-\s*(\d+)$/);
  if (range) return { kind: "range", min: +range[1], max: +range[2] };
  const label = s.match(/^(\d+)([a-z])$/);
  if (label) return { kind: "label", num: +label[1], label: s };
  const num = s.match(/^(\d+)$/);
  if (num) return { kind: "num", num: +num[1] };
  return { kind: "unknown", raw: s };
}

export function chapterMatches(entry: DbEntry, spec: ChapterSpec): boolean {
  const ch = entry.chapter;
  const range = entry.chapter_range;
  if (spec.kind === "label") {
    return (entry.chapter_label ?? "").toLowerCase() === spec.label;
  }
  if (spec.kind === "num") {
    if (ch === spec.num) return true;
    if (range && spec.num >= range[0] && spec.num <= range[1]) return true;
    return false;
  }
  if (spec.kind === "range") {
    if (ch !== null && ch >= spec.min && ch <= spec.max) return true;
    if (range && range[0] <= spec.max && range[1] >= spec.min) return true;
    return false;
  }
  return false;
}

export interface SearchFilters {
  type?: string | null;
  chapter?: string | null;
  addressee?: string | null;
  emotion?: string | null;
  stage?: string | null;
}

export function applyFilters(
  entries: DbEntry[],
  filters: SearchFilters,
): DbEntry[] {
  return entries.filter((e) => {
    if (filters.type && e.type !== filters.type) return false;
    if (
      filters.chapter &&
      !chapterMatches(e, parseChapterSpec(filters.chapter))
    ) {
      return false;
    }
    if (filters.addressee && e.addressee !== filters.addressee) return false;
    if (filters.emotion && !(e.emotion ?? []).includes(filters.emotion)) {
      return false;
    }
    if (filters.stage && e.stage !== filters.stage) return false;
    return true;
  });
}

// ---------------------------------------------------------------- scoring
// Same weights as query.mjs: tags 3 / text 2 / other fields 1,
// whole-phrase bonus 5.
export function scoreEntry(
  entry: DbEntry,
  queryTokens: string[],
  queryRaw: string,
): number {
  const tagTokens = new Set(tokenize((entry.tags ?? []).join(" ")));
  const textTokens = new Set(tokenize(entry.text));
  const otherTokens = new Set(
    tokenize([entry.scene, entry.other].filter(Boolean).join(" ")),
  );
  let score = 0;
  for (const t of queryTokens) {
    if (tagTokens.has(t)) score += 3;
    else if (textTokens.has(t)) score += 2;
    else if (otherTokens.has(t)) score += 1;
  }
  if (queryRaw.length >= 2) {
    if (entry.text.includes(queryRaw)) score += 5;
    if ((entry.tags ?? []).join(" ").includes(queryRaw)) score += 5;
  }
  return score;
}

function compareScored(
  a: { e: DbEntry; score: number },
  b: { e: DbEntry; score: number },
): number {
  return (
    b.score - a.score ||
    (a.e.chapter ?? 9999) - (b.e.chapter ?? 9999) ||
    String(a.e.id).localeCompare(String(b.e.id))
  );
}

// ---------------------------------------------------------------- tokens
/** Rough token estimate for CJK-heavy text: one CJK char ≈ 1 token,
 *  latin text ≈ 1 token per 4 chars. Rough on purpose — it only
 *  drives truncation, never billing. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (
      /[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\u{20000}-\u{2a6df}\u{2a700}-\u{2b73f}\u{2b740}-\u{2b81f}\u{2b820}-\u{2ceaf}\u{2ceb0}-\u{2ebef}\u{30000}-\u{3134a}]/u.test(
        ch,
      )
    ) {
      cjk += 1;
    } else {
      other += 1;
    }
  }
  return Math.max(1, Math.ceil(cjk + other / 4));
}

export interface SearchOptions extends SearchFilters {
  query?: string;
  limit?: number;
  tokenCap?: number;
}

export interface SearchOutcome {
  results: Array<DbEntry & { _score: number; _estimatedTokens: number }>;
  totalHits: number;
  truncated: boolean;
  dropped: number;
  estimatedTokens: number;
}

export function searchDb(db: CharacterDb, opts: SearchOptions): SearchOutcome {
  const queryRaw = (opts.query ?? "").trim();
  const limit = Math.min(
    20,
    Math.max(1, Number.isFinite(opts.limit) ? Number(opts.limit) : 5),
  );
  const tokenCap =
    Number.isFinite(opts.tokenCap) && (opts.tokenCap as number) > 0
      ? Math.floor(opts.tokenCap as number)
      : 1500;
  const pool = applyFilters(db.entries, opts);
  let scored: Array<{ e: DbEntry; score: number }>;
  if (queryRaw) {
    const queryTokens = tokenize(queryRaw);
    scored = pool
      .map((e) => ({ e, score: scoreEntry(e, queryTokens, queryRaw) }))
      .filter((r) => r.score > 0)
      .sort(compareScored);
  } else {
    scored = pool
      .map((e) => ({ e, score: 0 }))
      .sort(
        (a, b) =>
          (a.e.chapter ?? 9999) - (b.e.chapter ?? 9999) ||
          String(a.e.id).localeCompare(String(b.e.id)),
      );
  }
  const totalHits = scored.length;
  const candidates = scored.slice(0, limit);
  // Token-cap truncation: keep results in score order until the next
  // one would break the cap; always keep at least the first hit so a
  // search never returns empty when it matched something.
  const results: SearchOutcome["results"] = [];
  let used = 0;
  let dropped = 0;
  for (const { e, score } of candidates) {
    const cost = estimateTokens(
      `${e.id} ${e.text} ${e.scene ?? ""} ${e.source}`,
    );
    if (results.length > 0 && used + cost > tokenCap) {
      dropped += 1;
      continue;
    }
    results.push({ ...e, _score: score, _estimatedTokens: cost });
    used += cost;
  }
  return {
    results,
    totalHits,
    truncated: dropped > 0,
    dropped,
    estimatedTokens: used,
  };
}

export function lookupDb(db: CharacterDb, id: string): DbEntry | null {
  const want = `${id}`.trim();
  if (!want) return null;
  return db.entries.find((e) => e.id === want) ?? null;
}
