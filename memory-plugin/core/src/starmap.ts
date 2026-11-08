// Starmap (0.3.1): the memory sea rendered with the 拾光 UI.
//
// One self-contained HTML file (starmap.html) in the data dir:
// the data is embedded as JSON, no external resources, no server —
// open it directly in a browser. Local only, nothing is uploaded.
// The HTML contains the user's own memory text (that is the point
// of the map), so it lives next to the log, never in a snapshot and
// never in a review package.
//
// UI: 拾光 (workspace/user/files/index.html, 655 lines, user-given,
// 2026-11-08) — the user fixed this as THE starmap UI. The template
// below (SHIGUANG_HEAD / SHIGUANG_TAIL) is that file verbatim
// except for six marked patches, applied by
// test-evidence/gen-starmap-template.py
// (P1–P6, each marked inline at its site below), plus dead-code
// removal of three lines that are dead in the original too
// (SELF_NAME, tMax, the DATA.demo branch — see m-6, review-15).
//   P1  DATA line: the file's 6 sample memories are replaced
//       by a split point; renderStarmapHtml injects the real DATA
//       there. Sample data never ships in the plugin — not one
//       line of it, not as data, defaults, comments, or tests.
//   P2  stat line: capped totals are shown — "N 颗记忆 · 全部
//       M 颗（只显示前 N 颗）" when capped, else "N 颗记忆".
//   P3  showPanel: fragment stars append tone + source entries
//       ("原文 …") to the body, so a fragment star still shows
//       its provenance. 拾光 on its own only shows the text.
//   P4  CSS: `#panel .p-body` gains `white-space:pre-line`, so
//       the newlines added by P3 render as line breaks.
//   P5  Defaults: 拾光's fallback counterpart name is replaced
//       with 你, so no sample identity can ever leak in through
//       a missing DATA field. (The SELF_NAME fallback line was
//       dead code in the original — never read — and is deleted.)
//   P6  Star carry-through: 拾光 builds each star from a DATA
//       memory but only copies id/text/at/imp/key/tags/related/
//       cat — toneLabel and sources would be dropped, so the P3
//       panel patch would never fire. The star literal now also
//       carries toneLabel and sources (empty when absent).
// Nothing else is changed: no legend, no time slider, no recall
// input, no dials — 拾光 has none of those, and the old
// 0.2.0/0.3.0 starmap UI (SVG circles, toolbar, time slider,
// dials, drift) is gone with it. 拾光's own #tools row (重播 /
// 竖屏 / 全屏 buttons) is kept as-is.
//
// Mapping (real data -> 拾光 DATA), all in buildStarmapData:
//   imp   = significance, clamped to [0, 1], rounded to 2dp.
//   cat   = fragment -> "stable_profile"; entry with an emotion
//           tag -> "emotion"; entry without one -> "event".
//           "other" is never emitted here; 拾光 itself falls
//           back to "other" for an unknown cat value.
//   tags / related = the star's keywords, de-duplicated, capped
//           at 8 (both fields carry the same list; 拾光's kinOf
//           builds constellations from their union, so what
//           matters is the shared set).
//   key / owner (heuristic — arms are a visual grouping, not a
//           claim about who a memory is "about"):
//             fragment          -> "ta.<topic>"   (ta. arm)
//             assistant entry   -> "ta.<keyword>" (ta. arm)
//             user entry        -> "约定.<keyword>" (约定. arm)
//           where <topic>/<keyword> is the most-shared badge word
//           across this batch of stars (DF; ties longest, then
//           latest — review-15 m-2). Words sliced across a
//           COMMON_TOKENS word are never badge candidates —
//           trigrams (review-16 N-1), content tokens
//           (review-17) and fragment topic/keywords (review-18):
//           今天/明天 and the like are dropped as
//           tokens, but the bigrams/trigrams sliced across them
//           (天我, 天要, 今天我, 天要去) would otherwise survive
//           and collapse a whole group of stars onto one
//           meaningless badge, or crowd out a real shared word
//           (考试 losing to 天我). The fragment channel is the
//           same collapse wearing a different coat: a ~10-token
//           summary opens with 今天/明天/那天 so naturally that
//           two fragments summarising similar days converge on
//           ta.今天 through their topic/keywords alone, so those
//           go through the same overlap filter, against the
//           fragment's own text (review-18).
//           Only when every word occurs once does it fall back to
//           the first short keyword (2–4 chars), else the first
//           keyword. (A 3-char preference was tried for review-16
//           N-2 and reverted — measured wash, see keySuffix.)
//           Sanitised (no dots or whitespace, max 8 chars,
//           fallback "记忆").
//           In 拾光's code, key "ta.*" maps to owner 'her' (the
//           DATA.user side, right core) and "约定|我|项目.*"
//           maps to owner 'me' (the DATA.self side, left core).
//           self is 夏柠柒, user is "你": the plugin core has no
//           counterpart custom-name setting anywhere (checked
//           2026-11-08), so "你" is the only honest default.
//   traces = [] always. 拾光 never renders traces, and no recall
//           query is persisted anywhere in the plugin, so any
//           trace with a q would be invented. Graph recall edges
//           still exist in StarmapData.edges.
//   at    = local time, "YYYY-MM-DDTHH:MM:00" built from the
//           entry's date/time (no UTC shift).
//   generatedAt = new Date(now).toISOString().
//   Cap: at most 800 stars, ranked by significance, then
//           recallCount, then recency (unchanged from 0.3.0);
//           capped + total are carried in DATA for the stat line.
//   Fragments: one star per fragment (its sources fold into it),
//           with toneLabel + sources so the panel (P3) can show
//           the originals; unfragmented entries still get a star.
//   Edges: graph edges remapped through fragments (as before)
//           and returned in StarmapData.edges / StarmapResult.
//           NOTE: 拾光 draws constellations from shared
//           tags/related (kinOf), not from these edges, so a
//           session/recall edge with no shared keyword will not
//           draw a line. Keyword edges and kinOf overlap agree
//           by construction (both come from shared rare tokens).
//
// Deleted in 0.3.1 (old 0.2.0/0.3.0 renderer, no longer used by
// 拾光): layoutStarmap (golden-angle spiral + edge relaxation),
// nodeRadius/nodeBrightness, backgroundStars, hashSeed/mulberry32,
// escAttr, and the StarmapNode x/y/r/color/brightness fields.
// emotionColor is kept: it is still exported and still tested
// (free-form emotion fallback), even though 拾光 colours by cat.
// emotionLabel was deleted in review-15 (m-6): no caller anywhere.

import { COMMON_TOKENS, contentTokens } from "./activation.ts";
import { emotionPolarity } from "./attributes.ts";
import type { Fragment } from "./fragments.ts";
import type {
  GraphEdge,
  MemoryAttributes,
  MemoryEntry,
} from "./types.ts";

export const STARMAP_FILE = "starmap.html";
/** Layout cap: beyond this, only the most significant nodes are
 *  drawn (the map says so in its stat line when capped). */
export const MAX_STARMAP_NODES = 800;

/** The persona the map belongs to (拾光 DATA.self). */
export const SHIGUANG_SELF = "夏柠柒";
/** The counterpart (拾光 DATA.user). The core has no custom-name
 *  setting, so the honest default is "你". */
export const SHIGUANG_USER = "你";

/** 拾光 cat values. Colours are fixed by 拾光: stable_profile
 *  gold, event blue, emotion pink, other purple. */
export type ShiguangCat =
  | "stable_profile"
  | "event"
  | "emotion"
  | "other";

/** One 拾光 memory star. Fields beyond 拾光's own
 *  (id/text/imp/at/cat/tags/related/key) are carried for
 *  provenance and for the P3 panel patch; 拾光 ignores the ones
 *  it does not know. */
export interface ShiguangMemory {
  id: string;
  text: string;
  /** significance, clamped to [0, 1]. */
  imp: number;
  /** Local time, "YYYY-MM-DDTHH:MM:00". */
  at: string;
  cat: ShiguangCat;
  /** De-duplicated keywords, max 8. */
  tags: string[];
  /** Same list as tags (拾光 builds constellations from the
   *  union of tags + related). */
  related: string[];
  /** Owner/arm key: "ta.<topic>" or "约定.<keyword>". */
  key: string;
  kind: "fragment" | "entry";
  /** Fragment tone label, e.g. 很喜欢 (fragment stars only). */
  toneLabel?: string;
  /** Fragment source log entries (fragment stars only). */
  sources?: Array<{ id: string; date: string; time: string; text: string }>;
  /** Carried, not rendered by 拾光: emotion, clarity, recall
   *  count, so the data is not lost with the old UI. */
  emotion: string;
  emotionIntensity: number;
  clarity: number;
  recallCount: number;
}

/** A past recall path. 拾光 never renders traces and no recall
 *  query is persisted, so buildStarmapData always returns []. */
export interface ShiguangTrace {
  at: number;
  q: string;
  p: string[];
}

/** 拾光 DATA, as injected into the template. `edges` is the
 *  remapped graph edge list (kept for StarmapResult/tests);
 *  拾光 itself draws constellations from tags/related overlap. */
export interface StarmapData {
  self: string;
  user: string;
  generatedAt: string;
  /** Total stars before the 800 cap (review-15 m-3): same source
   *  as memories.length, so the capped stat line never mixes
   *  log-entry counts with star counts. Fragment folding counts
   *  here — 14 entries folding into 13 stars is total 13. */
  total: number;
  capped: boolean;
  memories: ShiguangMemory[];
  edges: Array<{ from: string; to: string }>;
  traces: ShiguangTrace[];
}

export const EMOTION_COLORS: Record<string, string> = {
  开心: "#ffd166",
  兴奋: "#ffcf5c",
  温暖: "#ffb08a",
  安心: "#8ce99a",
  难过: "#7aa7ff",
  委屈: "#8aa8ff",
  生气: "#ff6b6b",
  紧张: "#c77dff",
  害羞: "#ff8fab",
  吃醋: "#f783ac",
  思念: "#b197fc",
  疲惫: "#94a3b8",
};
export const DEFAULT_STAR_COLOR = "#e8ecff";

/** Star colour for an emotion type. Known types use the map;
 *  free-form types the map never saw fall back to a coarse
 *  polarity colour (positive gold, negative blue) and then to the
 *  neutral default — an unknown word still renders a star, never
 *  nothing, never a crash. Kept from 0.3.0 (still exported and
 *  tested); 拾光 itself colours by cat, not by emotion. */
export function emotionColor(type?: string): string {
  if (!type) return DEFAULT_STAR_COLOR;
  const known = EMOTION_COLORS[type];
  if (known) return known;
  const pol = emotionPolarity(type);
  if (pol === "positive") return "#ffd166";
  if (pol === "negative") return "#7aa7ff";
  return DEFAULT_STAR_COLOR;
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.min(1, Math.max(0, v));
}

/** De-duplicate (first occurrence wins), cap at 8. */
function dedupCap(words: readonly string[], cap = 8): string[] {
  const out: string[] = [];
  for (const w of words) {
    const t = typeof w === "string" ? w.trim() : "";
    if (!t || out.includes(t)) continue;
    out.push(t);
    if (out.length >= cap) break;
  }
  return out;
}

/** Key suffix (review-15 m-2, review-16 N-1/N-2): pick by document
 *  frequency across this batch of stars — the most-shared word of
 *  the star's word list wins. Ties break by longest, then
 *  latest-appearing. Longest first, because the shortest shared
 *  word is usually the sliced half of a longer word (奖学 of 奖学金,
 *  吃拉 of 吃拉面, 得睡不 of 睡不着); latest, because the completed
 *  word trails its sliced prefix in the line (有点 … 难过, 得睡不 …
 *  睡不着). (The review suggested shortest-first; verified on the
 *  14-sample page it keeps the sliced words — shortest picks 吃拉
 *  over 拉面/安心 and 奖学 over nothing longer — so the tie-break is
 *  longest, not shortest. The 6 bad badges are gone either way
 *  only under this rule; see the mapping tests.)
 *  Badge candidates never include a slice of a COMMON_TOKENS
 *  word: trigrams, content tokens and fragment topic/keywords
 *  overlapping one are dropped before they reach this function —
 *  see coveredRuns / hasClearOccurrence for the rule (review-16
 *  N-1, review-17, review-18).
 *  Only when every word occurs once does it fall back to the
 *  first short keyword (2–4 chars), else the first keyword.
 *  (Review-16 N-2 proposed preferring a 3-char candidate here
 *  instead — 酸梅汤 over 酸梅. It was implemented, measured, and
 *  REVERTED in this package, because the measurement showed a
 *  wash, not a fix: on the two sample pages the sliced-badge
 *  count stayed 3 -> 3 (酸梅 fixed to 酸梅汤, but 今晚 -> 今晚吃
 *  and 雨天 -> 雨天你 regressed, and 明天要去爬山 -> 要去爬,
 *  not the whole run the review predicted — after the N-1 filter
 *  the surviving trigrams are 要去爬 / 去爬山, and the first
 *  3-char candidate is 要去爬). A lone short memory whose own
 *  trigrams are all slices cannot be fixed by preferring
 *  trigrams; telling a complete 3-char word (酸梅汤) from a
 *  sliced one (今晚吃) needs a lexicon, which this plugin does
 *  not have. So the fallback stays first-short-keyword, and
 *  lone-star slices remain a known limit — see the checklist.
 *  No dots/whitespace, max 8 chars, fallback "记忆". */
function keySuffix(
  words: readonly string[],
  docFreq?: Map<string, number>,
): string {
  const trimmed: string[] = [];
  for (const w of words) {
    const t = typeof w === "string" ? w.trim() : "";
    if (t && !trimmed.includes(t)) trimmed.push(t);
  }
  if (docFreq) {
    let best: string | undefined;
    let bestDf = 1;
    for (const w of trimmed) {
      const df = docFreq.get(w) ?? 0;
      if (df <= 1) continue;
      if (
        best === undefined ||
        df > bestDf ||
        (df === bestDf && w.length > best.length) ||
        (df === bestDf &&
          w.length === best.length &&
          trimmed.indexOf(w) > trimmed.indexOf(best))
      ) {
        best = w;
        bestDf = df;
      }
    }
    if (best !== undefined) {
      const clean = best.replace(/[\s./\\]+/g, "").slice(0, 8);
      if (clean) return clean;
    }
  }
  const short = trimmed.find((w) => w.length >= 2 && w.length <= 4);
  const raw = short ?? trimmed[0] ?? "";
  const clean = raw.replace(/[\s./\\]+/g, "").slice(0, 8);
  return clean || "记忆";
}

/** One CJK run plus the positions in it covered by a COMMON_TOKENS
 *  occurrence. Shared by cjkTrigrams and the badge-word filter
 *  (review-17): both are the same "sliced across a common word"
 *  problem, so both read the same covered set. Computed once per
 *  text by badgeWords and passed down to cjkTrigrams (review-18) —
 *  the review-17 checklist said "once per text" but badgeWords
 *  computed it once and cjkTrigrams recomputed it inside, i.e.
 *  twice; the runs are now a parameter, not a recomputation. */
interface CoveredRun {
  run: string;
  covered: Set<number>;
}

function coveredRuns(text: string): CoveredRun[] {
  const out: CoveredRun[] = [];
  for (const m of text.matchAll(
    /[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff]+/gu,
  )) {
    const run = m[0];
    const covered = new Set<number>();
    for (let i = 0; i < run.length; i++) {
      for (const w of COMMON_TOKENS) {
        if (w.length > 1 && run.startsWith(w, i)) {
          for (let j = i; j < i + w.length; j++) covered.add(j);
        }
      }
    }
    out.push({ run, covered });
  }
  return out;
}

/** True when the word has at least one occurrence in the text that
 *  touches no COMMON_TOKENS-covered position. A word whose every
 *  occurrence overlaps a covered position is a slice of a common
 *  word, not a grouping key: 天我 of 今天我, 天要 of 明天要
 *  (review-17 — the bigram channel review-16 N-1 left open; the
 *  re-review's round-3 §3 measured it: four memories opening
 *  今天我 collapsed onto 约定.天我, and a real shared word,
 *  考试, lost to the slice). Words that never occur inside a CJK
 *  run (latin words, and fragment keywords not verbatim in the
 *  text) have nothing to overlap, so they are kept. */
function hasClearOccurrence(runs: CoveredRun[], word: string): boolean {
  let found = false;
  for (const { run, covered } of runs) {
    let p = run.indexOf(word);
    while (p !== -1) {
      found = true;
      let clear = true;
      for (let j = p; j < p + word.length; j++) {
        if (covered.has(j)) {
          clear = false;
          break;
        }
      }
      if (clear) return true;
      p = run.indexOf(word, p + 1);
    }
  }
  // Never occurs inside a CJK run: nothing to overlap, keep it.
  return !found;
}

/** CJK trigrams of each run: the 3-char words that overlapping
 *  bigrams slice apart (奖学金 -> 奖学 / 学金). Badge candidates
 *  only — recall indexing and tags are untouched.
 *  Review-16 N-1: a trigram overlapping a COMMON_TOKENS word in
 *  its run is dropped. 今天/明天 and the like are already dropped
 *  as tokens, but the trigrams sliced across them survive — 今天我
 *  (starts with 今天) and 天要去 (the 天 belongs to 明天) — and
 *  with df >= 2 they collapse a whole group of stars onto one
 *  meaningless badge. The review suggested dropping only trigrams
 *  that START with a common word; that misses 天要去, the review's
 *  own example, so the filter is overlap, not prefix: any trigram
 *  touching a covered position is out. Trigrams clear of common
 *  words (酸梅汤, 奖学金, 吃拉面) are unaffected.
 *  Review-17 extends the same overlap rule to content-token
 *  bigrams via hasClearOccurrence (same covered set, same
 *  problem — 天我 / 天要 are the bigram form of 今天我 /
 *  天要去); this function itself is unchanged by that round.
 *  Review-18: the runs are an optional parameter — badgeWords
 *  computes them once per text and passes them in, so the
 *  covered positions are computed once, not once here and once
 *  in the caller. Called without runs (no other caller) it
 *  still computes them itself. */
function cjkTrigrams(text: string, runs?: CoveredRun[]): string[] {
  const list = runs ?? coveredRuns(text);
  const out: string[] = [];
  for (const { run, covered } of list) {
    for (let i = 0; i + 2 < run.length; i++) {
      if (covered.has(i) || covered.has(i + 1) || covered.has(i + 2)) {
        continue;
      }
      const t = run.slice(i, i + 3);
      if (!out.includes(t)) out.push(t);
    }
  }
  return out;
}

/** Local ISO time for 拾光's Date.parse, without a UTC shift. */
function localIso(date: string, time: string): string {
  return `${date.replace(/\//g, "-")}T${time}:00`;
}

function shiguangCat(kind: "fragment" | "entry", emotionType: string): ShiguangCat {
  if (kind === "fragment") return "stable_profile";
  if (emotionType) return "emotion";
  return "event";
}

export function buildStarmapData(
  entries: MemoryEntry[],
  edges: GraphEdge[],
  attrs: Map<string, MemoryAttributes>,
  now: number,
  fragments: Fragment[] = [],
): StarmapData {
  const byId = new Map(entries.map((e) => [e.id, e]));
  // 0.3.0: one star per fragment (its sources fold into it) plus
  // one star per log entry with no fragment yet — unfragmented
  // entries are never hidden or deleted. A fragment's edges come
  // from its sources' edges (remapped below). An entry covered by
  // two fragments folds into the earliest-created one.
  const fragmentOfEntry = new Map<string, Fragment>();
  const liveFragments: Fragment[] = [];
  for (const f of [...fragments].sort((a, b) => a.createdAt - b.createdAt)) {
    const sources = f.sourceIds
      .map((id) => byId.get(id))
      .filter((e): e is MemoryEntry => e !== undefined);
    if (sources.length === 0) continue; // sources gone: no star
    liveFragments.push(f);
    for (const s of sources) {
      if (!fragmentOfEntry.has(s.id)) fragmentOfEntry.set(s.id, f);
    }
  }
  interface Item {
    id: string;
    kind: "fragment" | "entry";
    text: string;
    date: string;
    time: string;
    ts: number;
    significance: number;
    recallCount: number;
    clarity: number;
    emotion: string;
    emotionIntensity: number;
    keywords: string[];
    role?: MemoryEntry["role"];
    topic?: string;
    toneLabel?: string;
    sources?: Array<{ id: string; date: string; time: string; text: string }>;
  }
  const sigOf = (e: MemoryEntry): number => attrs.get(e.id)?.significance ?? 0.4;
  const items: Item[] = [];
  for (const f of liveFragments) {
    const sources = f.sourceIds
      .map((id) => byId.get(id))
      .filter((e): e is MemoryEntry => e !== undefined);
    const latest = sources.reduce((a, b) => (b.ts > a.ts ? b : a));
    const significance = Math.max(...sources.map(sigOf));
    const recallCount = Math.max(
      ...sources.map((s) => attrs.get(s.id)?.recallCount ?? 0),
    );
    const clarity = Math.min(
      ...sources.map((s) => attrs.get(s.id)?.clarity ?? 1),
    );
    items.push({
      id: f.id,
      kind: "fragment",
      text: f.text,
      date: latest.date,
      time: latest.time,
      ts: latest.ts,
      significance,
      recallCount,
      clarity: Math.round(clarity * 100) / 100,
      emotion: "",
      emotionIntensity: 0,
      keywords: f.keywords.slice(0, 8),
      topic: f.topic,
      toneLabel: f.tone.label,
      sources: sources.map((s) => ({
        id: s.id,
        date: s.date,
        time: s.time,
        text: s.text,
      })),
    });
  }
  for (const e of entries) {
    if (fragmentOfEntry.has(e.id)) continue;
    const a = attrs.get(e.id);
    const significance = a?.significance ?? 0.4;
    items.push({
      id: e.id,
      kind: "entry",
      text: e.text,
      date: e.date,
      time: e.time,
      ts: e.ts,
      significance,
      recallCount: a?.recallCount ?? 0,
      clarity: Math.round(((a?.clarity ?? 1) * 100)) / 100,
      emotion: a?.emotion?.type ?? "",
      emotionIntensity: a?.emotion?.intensity ?? 0,
      keywords: [...contentTokens(e.text)].slice(0, 8),
      role: e.role,
    });
  }
  const sorted = items.sort(
    (a, b) =>
      b.significance - a.significance ||
      b.recallCount - a.recallCount ||
      b.ts - a.ts,
  );
  const capped = sorted.length > MAX_STARMAP_NODES;
  const picked = capped ? sorted.slice(0, MAX_STARMAP_NODES) : sorted;
  const pickedIds = new Set(picked.map((e) => e.id));
  // Remap graph edges through fragments: an edge between two
  // entries becomes an edge between their stars (fragment or
  // entry); duplicates collapse, self-loops (two sources of one
  // fragment) drop.
  const nodeIdForEntry = (entryId: string): string =>
    fragmentOfEntry.get(entryId)?.id ?? entryId;
  const edgeKeys = new Set<string>();
  const usableEdges: Array<{ from: string; to: string }> = [];
  for (const e of edges) {
    const from = nodeIdForEntry(e.from);
    const to = nodeIdForEntry(e.to);
    if (from === to) continue;
    if (!pickedIds.has(from) || !pickedIds.has(to)) continue;
    const key = from < to ? `${from}\0${to}` : `${to}\0${from}`;
    if (edgeKeys.has(key)) continue;
    edgeKeys.add(key);
    usableEdges.push({ from, to });
  }
  // Badge words for the key-suffix rule (review-15 m-2): the
  // star's content keywords (full set, NOT the 8-capped tags)
  // plus the CJK trigrams of its text, so a 3-char word the
  // bigrams sliced apart can still win. Content tokens that are
  // slices of a COMMON_TOKENS word are filtered out first
  // (review-17, hasClearOccurrence). Fragments add their
  // topic first; entries use their full text tokens. The
  // covered positions are computed ONCE per text here and
  // passed to cjkTrigrams (review-18) — before this round
  // badgeWords computed them and cjkTrigrams recomputed them,
  // so "once per text" was twice.
  const badgeWords = (e: Item): string[] => {
    const words: string[] = [];
    const push = (w: string) => {
      if (w && !words.includes(w)) words.push(w);
    };
    const runs = coveredRuns(e.text);
    if (e.kind === "fragment") {
      // Review-18 (re-review round 4): fragment topic/keywords
      // go through the same overlap filter as entry content
      // tokens, against the fragment's own text. A ~10-token
      // summary opens with 今天/明天 so naturally that two
      // fragments summarising similar days both carry 今天 as
      // topic/keyword and converge on ta.今天 via DF — the same
      // collapse as the entry channel, easier to hit. A word
      // whose every occurrence overlaps a covered position is a
      // slice, not a badge word. A curator word that never
      // occurs in the fragment text has nothing to overlap
      // (hasClearOccurrence returns true when !found), so an
      // explicitly passed topic/keyword is kept, not injured.
      if (e.topic && hasClearOccurrence(runs, e.topic)) push(e.topic);
      for (const w of e.keywords) {
        if (hasClearOccurrence(runs, w)) push(w);
      }
    } else {
      // Review-17: content tokens go through the same overlap
      // filter as the trigrams — a token whose every occurrence
      // overlaps a COMMON_TOKENS word (天我 of 今天我, 天要 of
      // 明天要) is a slice, not a badge word.
      for (const w of contentTokens(e.text)) {
        if (hasClearOccurrence(runs, w)) push(w);
      }
    }
    for (const w of cjkTrigrams(e.text, runs)) push(w);
    return words;
  };
  // Document frequency of each badge word across the picked stars,
  // for the key-suffix rule (review-15 m-2). One count per star.
  const docFreq = new Map<string, number>();
  for (const e of picked) {
    for (const w of new Set(badgeWords(e))) {
      docFreq.set(w, (docFreq.get(w) ?? 0) + 1);
    }
  }
  const memories: ShiguangMemory[] = picked.map((e) => {
    const keywords = dedupCap(e.keywords);
    const suffix = keySuffix(badgeWords(e), docFreq);
    // Key / owner (heuristic, see header): fragments and
    // assistant (夏柠柒's own) lines -> "ta.*"; user lines ->
    // "约定.*". 拾光 maps "ta.*" to the DATA.user core and
    // "约定.*" to the DATA.self core.
    const key =
      e.kind === "fragment" || e.role === "assistant"
        ? `ta.${suffix}`
        : `约定.${suffix}`;
    return {
      id: e.id,
      text: e.text,
      imp: Math.round(clamp01(e.significance) * 100) / 100,
      at: localIso(e.date, e.time),
      cat: shiguangCat(e.kind, e.emotion),
      tags: keywords,
      related: keywords,
      key,
      kind: e.kind,
      toneLabel: e.toneLabel,
      sources: e.sources,
      emotion: e.emotion,
      emotionIntensity: e.emotionIntensity,
      clarity: e.clarity,
      recallCount: e.recallCount,
    };
  });
  return {
    self: SHIGUANG_SELF,
    user: SHIGUANG_USER,
    generatedAt: new Date(now).toISOString(),
    total: sorted.length,
    capped,
    memories,
    edges: usableEdges,
    // No recall query is persisted anywhere, and 拾光 never
    // renders traces: an empty list, never invented traces.
    traces: [],
  };
}

/** JSON.stringify + escape <, > and & so the payload can never
 *  break out of its <script> tag, whatever the memory text says. */
export function safeJsonForHtml(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
}

// P1 — DATA split point: SHIGUANG_HEAD ends at the DATA line and
// SHIGUANG_TAIL resumes after it; renderStarmapHtml splices the
// real DATA in between, so the original file's sample data never
// ships. See the header for P1–P6.
const SHIGUANG_HEAD = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>拾光</title>
<style>
  html,body{margin:0;height:100%;background:#000;overflow:hidden}
  #stage{position:fixed;inset:0;overflow:hidden;background:#03020a}
  canvas{display:block;width:100%;height:100%;cursor:grab;touch-action:none}
  canvas.drag{cursor:grabbing}
  /* 竖屏模式（V）：中间一条 9:16，外边全黑，字自动放大 */
  body.vmode #stage{inset:0 auto 0 50%;transform:translateX(-50%);
        width:min(100vw,calc(100vh * 9 / 16));background:#03020a}
  body.vmode #panel{padding:20px 7vw 26px}
  body.vmode #panel .p-title{font-size:26px;line-height:1.45}
  body.vmode #panel .p-body{font-size:17px;line-height:1.9}
  body.vmode #panel .p-meta{font-size:12px}
  body.vmode #hint b{display:none}
  #hint{position:absolute;left:0;right:0;bottom:18px;text-align:center;pointer-events:none;
        font:11px/1.8 Georgia,serif;font-style:italic;letter-spacing:.18em;color:#4b4463}
  #stat{position:absolute;left:26px;top:26px;font:11px/1.9 ui-sans-serif,system-ui,"Microsoft YaHei",sans-serif;
        letter-spacing:.08em;color:#413a5c;pointer-events:none}
  #tools{position:absolute;right:22px;bottom:20px;display:flex;gap:8px;transition:opacity .6s}
  #tools.idle{opacity:.18}
  /* 沉浸模式（H）：只留星空，界面全藏起来 */
  body.no-ui #stat,
  body.no-ui #hint,
  body.no-ui #tools{opacity:0;pointer-events:none}
  #tools button{padding:7px 14px;cursor:pointer;
        background:rgba(20,14,38,.55);border:1px solid rgba(150,130,220,.35);border-radius:999px;
        color:#9d90c4;font:11px/1.4 ui-sans-serif,system-ui,"Microsoft YaHei",sans-serif;letter-spacing:.12em;
        backdrop-filter:blur(6px);transition:color .25s,border-color .25s,background .25s}
  #tools button:hover{color:#e6dcff;border-color:rgba(190,170,255,.7);background:rgba(30,20,56,.75)}
  #panel{position:absolute;left:0;right:0;bottom:0;padding:26px 6vw 34px;pointer-events:none;
         background:linear-gradient(to top,rgba(4,2,10,.86) 0%,rgba(4,2,10,.55) 55%,rgba(4,2,10,0) 100%);
         opacity:0;transform:translateY(14px);transition:opacity .45s ease,transform .45s ease}
  #panel.on{opacity:1;transform:translateY(0)}
  #panel .p-inner{max-width:1180px}
  #panel .p-top{display:flex;align-items:center;gap:14px}
  #panel .p-mark{width:24px;height:24px;flex:0 0 auto;display:flex;align-items:center;justify-content:center;
        filter:drop-shadow(0 0 10px rgba(220,200,255,.9))}
  #panel .p-title{font:600 27px/1.5 ui-sans-serif,system-ui,"Microsoft YaHei",sans-serif;
        letter-spacing:.05em;color:#f2eaff}
  #panel .p-meta{margin-top:10px;display:flex;align-items:center;gap:14px;
        font:12px/1.6 ui-sans-serif,system-ui,"Microsoft YaHei",sans-serif;letter-spacing:.1em;color:#9488b8}
  #panel .p-badge{padding:3px 10px;border:1px solid rgba(190,160,255,.45);border-radius:3px;color:#c9b8f2}
  #panel .p-body{margin-top:14px;font:17px/2 ui-sans-serif,system-ui,"Microsoft YaHei",sans-serif;
        letter-spacing:.03em;color:#ddd3f0;white-space:pre-line} /* P4 */
</style>
</head>
<body>
<div id="stage">
<canvas id="c"></canvas>
<div id="stat"></div>
<div id="hint">拖动 · 环视　　滚轮 · 靠近　　点一颗星，点亮它的星座</div>
<div id="tools">
  <button id="replay" title="重播开场（R）">↻ 重播</button>
  <button id="vert" title="竖屏模式（V）">▯ 竖屏</button>
  <button id="fs" title="全屏（F）">⛶ 全屏</button>
</div>
<div id="panel">
  <div class="p-inner">
    <div class="p-top">
      <span class="p-mark"><svg width="22" height="22" viewBox="0 0 24 24"><path d="M12 0 L13.7 10.3 L24 12 L13.7 13.7 L12 24 L10.3 13.7 L0 12 L10.3 10.3 Z" fill="#fff"/></svg></span>
      <span class="p-title" id="pTitle"></span>
    </div>
    <div class="p-meta"><span id="pDate"></span><span class="p-badge" id="pBadge"></span></div>
    <div class="p-body" id="pBody"></div>
  </div>
</div>
</div>
<script>
const DATA = `;

const SHIGUANG_TAIL = `;

(function () {
  'use strict';

  let T0 = performance.now();
  const mT = location.search.match(/[?&]t=([0-9.]+)/);   // 调试用：?t=3.2 定格在开场第 3.2 秒
  const FORCE_T = mT ? parseFloat(mT[1]) : null;
  const cv = document.getElementById('c');
  const ctx = cv.getContext('2d', { alpha: false });
  const panel = document.getElementById('panel');
  const pTitle = document.getElementById('pTitle');
  const pDate = document.getElementById('pDate');
  const pBadge = document.getElementById('pBadge');
  const pBody = document.getElementById('pBody');

  // P5: fallback counterpart name is 你. (The SELF_NAME line was
  // here in the original and is deleted: never read, dead code.)
  const USER_NAME = (DATA && DATA.user) || '你';

  // ── 相机 ────────────────────────────────────────────────
  let W = 0, H = 0, DPR = 1, FOCAL = 900, REF = 100;
  let theta = 0.5, phi = 0.30, dist = 13.5, distGoal = 9.2;
  let dragging = false, lastPointer = null, downAt = null;
  let hovered = null, selected = null;
  let intro = 0;
  // 中心呼吸光的叠加强度；地址后面加 ?gain=3 可以临时试别的值
  const CORE_GAIN = Number((location.search.match(/gain=([0-9.]+)/) || [])[1]) || 1;
  let frameNo = 0;
  let vmode = false;
  let cvRect = { left: 0, top: 0 };
  let phiOff = 0;

  const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
  const TAU = Math.PI * 2;
  function hash(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0) / 4294967295;
  }
  function gauss() { return (Math.random() + Math.random() + Math.random()) / 1.5 - 1; }
  function easeOutBack(x) {
    const c1 = 1.70158, c3 = c1 + 1;
    return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
  }

  // ── 投影 ────────────────────────────────────────────────
  let cosT = 1, sinT = 0, cosP = 1, sinP = 0;
  function project(x, y, z) {
    const x1 = x * cosT + z * sinT;
    const z1 = -x * sinT + z * cosT;
    const y2 = y * cosP - z1 * sinP;
    const z2 = y * sinP + z1 * cosP;
    const vz = dist - z2;
    if (vz < 0.6) return null;
    const s = FOCAL / vz;
    return { x: W / 2 + x1 * s, y: H / 2 - y2 * s, s: s, vz: vz };
  }

  // ── 颜色 ────────────────────────────────────────────────
  const PAL = {
    stable_profile: '255,214,150',
    event: '178,204,255',
    emotion: '255,170,212',
    other: '216,206,255'
  };
  const RGB_CORE = '236,226,255';

  // ── 粒子：真 3D 点云，按颜色分桶（省掉每帧几万次 fillStyle 拼接） ──
  const GAL_R = 5.8;
  const SPIRAL = 1.22;
  const buckets = new Map();

  function pushPart(x, y, z, size, alpha, rgb, slow) {
    if (!buckets.has(rgb)) buckets.set(rgb, []);
    buckets.get(rgb).push({
      x: x, y: y, z: z, s: size, a: alpha,
      ph: Math.random() * TAU, sp: 0.4 + Math.random() * 1.2,
      d: Math.random(),                      // 开场点亮的先后
      slow: !!slow                           // 隔帧才更新 → 会闪
    });
  }

  // 旋臂：两条主臂 + 臂间散点，盘厚、越外越薄
  for (let i = 0; i < 17000; i++) {
    const r = 0.05 + Math.pow(Math.random(), 0.60) * GAL_R;
    const arm = Math.random() < 0.5 ? 0 : Math.PI;
    const spread = 0.28 + 0.85 * (r / GAL_R);
    const stray = Math.random() < 0.42;                     // 四成不贴着臂走
    const a = arm + SPIRAL * r + gauss() * spread * (stray ? 2.8 : 1);
    const thin = 1 - Math.min(1, r / GAL_R) * 0.5;
    const y = gauss() * 0.62 * thin;
    const k = Math.min(1, r / GAL_R);
    const rgb = k < 0.22 ? '255,240,250' : (k < 0.55 ? '214,198,255' : '158,170,240');
    pushPart(Math.cos(a) * r, y, Math.sin(a) * r, 0.42 + Math.random() * 0.9, 0.12 + Math.random() * 0.42, rgb);
  }
  // 核球
  for (let i = 0; i < 1500; i++) {
    const r = Math.pow(Math.random(), 1.7) * 1.05;
    const a = Math.random() * TAU;
    pushPart(Math.cos(a) * r, gauss() * 0.55, Math.sin(a) * r, 0.45 + Math.random() * 0.85, 0.18 + Math.random() * 0.5, '255,244,252');
  }
  // 晕：大球，撑起纵深（隔帧更新，会轻微地闪）
  for (let i = 0; i < 3200; i++) {
    const r = 1.2 + Math.pow(Math.random(), 0.7) * 5.2;
    const a = Math.random() * TAU;
    pushPart(Math.cos(a) * r, gauss() * (0.8 + r * 0.3), Math.sin(a) * r, 0.4 + Math.random() * 0.7, 0.20 + Math.random() * 0.45, '198,204,252', true);
  }
  // 满天繁星：远处，几乎不动
  for (let i = 0; i < 5200; i++) {
    const r = 6 + Math.random() * 16;
    const u = Math.random() * 2 - 1, a = Math.random() * TAU;
    const sq = Math.sqrt(1 - u * u);
    pushPart(r * sq * Math.cos(a), r * u * 0.85, r * sq * Math.sin(a),
      0.32 + Math.random() * 0.8, 0.34 + Math.random() * 0.56, Math.random() < 0.12 ? '255,226,180' : '228,232,255', true);
  }
  // 亮巨星
  for (let i = 0; i < 320; i++) {
    const r = 0.2 + Math.pow(Math.random(), 0.7) * GAL_R * 0.95;
    const arm = Math.random() < 0.5 ? 0 : Math.PI;
    const a = arm + SPIRAL * r + gauss() * 0.6;
    pushPart(Math.cos(a) * r, gauss() * 0.5, Math.sin(a) * r, 1.2 + Math.random() * 1.3,
      0.45 + Math.random() * 0.45, Math.random() < 0.2 ? '255,226,185' : '235,230,255');
  }

  // ── 记忆星 ──────────────────────────────────────────────
  const memories = (DATA.memories || []).filter(function (m) { return m && m.text; });
  const stamps = memories.map(function (m) { return Date.parse(m.at || '') || 0; });
  const tMin = Math.min.apply(null, stamps.concat([Date.now()]));
  // (m-6: the original's tMax line was here; never read, deleted.)

  const CORE = { me: { x: -0.30, y: 0, z: 0 }, her: { x: 0.30, y: 0, z: 0 } };

  function ownerOf(m) {
    const k = String(m.key || '');
    if (/^ta\\./.test(k)) return 'her';
    if (/^(约定|我|项目)\\./.test(k)) return 'me';
    return new RegExp('^(ta|' + USER_NAME + ')').test(String(m.text)) ? 'her' : 'me';
  }

  const stars = [];
  let newest = null;
  const sorted = memories.slice().sort(function (a, b) {
    return (Date.parse(a.at || '') || 0) - (Date.parse(b.at || '') || 0);   // 早的在前
  });
  sorted.forEach(function (m, i) {
    const at = Date.parse(m.at || '') || tMin;
    const rank = sorted.length > 1 ? i / (sorted.length - 1) : 0.5;
    const h = hash(String(m.id || m.text));
    // 半径按时间排名铺开 + 抖动，别都挤在一条线上
    const r = 0.85 + 4.30 * Math.pow(rank, 0.85) + (h - 0.5) * 1.0;
    const o = ownerOf(m);
    const base = o === 'her' ? 0 : Math.PI;
    const a = base + SPIRAL * r + (h - 0.5) * 1.45;
    const imp = clamp(typeof m.imp === 'number' ? m.imp : 0.5, 0, 1);
    const n = {
      id: String(m.id || ''), text: String(m.text || ''), at: at, imp: imp,
      key: String(m.key || ''),
      tags: Array.isArray(m.tags) ? m.tags : [],
      related: Array.isArray(m.related) ? m.related : [],
      cat: PAL[m.cat] ? m.cat : 'other',
      rgb: PAL[m.cat] || PAL.other,
      owner: o,
      x: Math.cos(a) * r,
      y: (h - 0.5) * 2.2 + gauss() * 0.5,          // 上下也拉开，真的浮在空间里
      z: Math.sin(a) * r,
      size: 4.2 + imp * 3.4 + (m.cat === 'stable_profile' ? 1.4 : 0),
      phase: h * TAU,
      ping: 0,
      // P6: carry toneLabel + sources through (拾光 drops them).
      toneLabel: m.toneLabel || '',
      sources: Array.isArray(m.sources) ? m.sources : []
    };
    stars.push(n);
    if (!newest || n.at > newest.at) newest = n;
  });

  // ── 光斑贴图（圆点） ────────────────────────────────────
  const spriteCache = new Map();
  function dot(rgb) {
    let s = spriteCache.get(rgb);
    if (s) return s;
    const S = 128, c = document.createElement('canvas');
    c.width = c.height = S;
    const g = c.getContext('2d');
    const cx = S / 2;
    const rg = g.createRadialGradient(cx, cx, 0, cx, cx, cx);
    rg.addColorStop(0, 'rgba(' + rgb + ',1)');
    rg.addColorStop(0.12, 'rgba(' + rgb + ',0.72)');
    rg.addColorStop(0.34, 'rgba(' + rgb + ',0.16)');
    rg.addColorStop(1, 'rgba(' + rgb + ',0)');
    g.fillStyle = rg;
    g.fillRect(0, 0, S, S);
    spriteCache.set(rgb, c);
    return c;
  }
  function drawSprite(s, x, y, r, a) {
    if (a <= 0.004) return;
    ctx.globalAlpha = a > 1 ? 1 : a;
    ctx.drawImage(s, x - r, y - r, r * 2, r * 2);
    ctx.globalAlpha = 1;
  }

  // ── 关系 ────────────────────────────────────────────────
  function kinOf(n) {
    const mine = new Set(n.tags.concat(n.related).map(String));
    const out = [];
    stars.forEach(function (o) {
      if (o === n) return;
      let w = 0;
      o.tags.concat(o.related).forEach(function (t) { if (mine.has(String(t))) w++; });
      if (w > 0) out.push({ o: o, w: w });
    });
    return out.sort(function (a, b) { return b.w - a.w; }).slice(0, 7);
  }

  // ── 尺寸 ────────────────────────────────────────────────
  function resize() {
    DPR = Math.min(2, window.devicePixelRatio || 1);
    const rect = cv.getBoundingClientRect();
    cvRect = rect;
    W = Math.max(2, Math.round(rect.width)); H = Math.max(2, Math.round(rect.height));
    cv.width = Math.round(W * DPR);
    cv.height = Math.round(H * DPR);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    FOCAL = Math.min(W, H) * 1.05;
    REF = FOCAL / 9.2;
  }

  // ── 绘制 ────────────────────────────────────────────────
  function draw(t) {
    if (W < 20 || H < 20) return;   // 还没量到尺寸，先别画（否则一片黑）
    cosT = Math.cos(theta); sinT = Math.sin(theta);
    cosP = Math.cos(phi + phiOff); sinP = Math.sin(phi + phiOff);

    ctx.globalCompositeOperation = 'source-over';
    const bg = ctx.createRadialGradient(W * 0.5, H * 0.5, 0, W * 0.5, H * 0.5, Math.max(W, H) * 0.75);
    const dark = clamp(intro / 0.7, 0, 1);          // 开场先黑一下
    bg.addColorStop(0, 'rgba(' + Math.round(2 * dark) + ',' + Math.round(2 * dark) + ',' + Math.round(10 * dark) + ',1)');
    bg.addColorStop(0.5, 'rgba(' + Math.round(1 * dark) + ',' + Math.round(1 * dark) + ',' + Math.round(3 * dark) + ',1)');
    bg.addColorStop(1, 'rgba(0,0,0,1)');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    ctx.globalCompositeOperation = 'lighter';

    // 中心柔光
    const c0 = project(0, 0, 0);
    const reveal = clamp((intro - 0.8) / 1.6, 0, 1);
    if (c0 && reveal > 0) {
      const br = 1 + 0.10 * Math.sin(t * 1.1);
      const R0 = 470 * (c0.s / REF) * br;
      const rg = ctx.createRadialGradient(c0.x, c0.y, 0, c0.x, c0.y, R0);
      rg.addColorStop(0, 'rgba(246,241,255,' + (0.42 * reveal).toFixed(3) + ')');
      rg.addColorStop(0.22, 'rgba(206,194,250,' + (0.18 * reveal).toFixed(3) + ')');
      rg.addColorStop(0.62, 'rgba(150,136,225,' + (0.045 * reveal).toFixed(3) + ')');
      rg.addColorStop(1, 'rgba(110,100,190,0)');
      ctx.fillStyle = rg;
      for (let g = 0; g < CORE_GAIN; g++) ctx.fillRect(c0.x - R0, c0.y - R0, R0 * 2, R0 * 2);
    }

    // 粒子（按颜色分桶，一次 fillStyle 画一组）
    frameNo++;
    buckets.forEach(function (list, rgb) {
      ctx.fillStyle = 'rgb(' + rgb + ')';
      for (let i = 0; i < list.length; i++) {
        const p = list[i];
        if (p.slow && ((frameNo + ((p.ph * 7) | 0)) & 1)) continue;   // 隔帧更新 → 闪
        const q = project(p.x, p.y, p.z);
        if (!q) continue;
        // 开场：每颗按自己的 d 慢慢点亮
        const lit = clamp((intro - 0.55 - p.d * 1.7) / 0.5, 0, 1);
        if (lit <= 0) continue;
        const tw = p.slow
          ? 0.35 + 0.65 * Math.abs(Math.sin(t * p.sp * 2.4 + p.ph))
          : 0.74 + 0.26 * Math.sin(t * p.sp + p.ph);
        const a = Math.min(1, p.a * 2.0 * lit * tw * clamp(1.25 - 0.45 * (q.vz / dist), 0.15, 1.2));
        if (a < 0.01) continue;
        const sz = Math.max(0.6, p.s * (q.s / REF) * 1.2);
        // 远处 / 边缘的星：画成糊开的光斑（假的景深）
        if (p.slow) {
          drawSprite(dot(rgb), q.x, q.y, Math.max(1.6, sz * 2.1), Math.min(0.85, a * 1.15));
        } else {
          ctx.globalAlpha = a > 1 ? 1 : a;
          if (sz < 1.5) ctx.fillRect(q.x, q.y, sz, sz);
          else { ctx.beginPath(); ctx.arc(q.x, q.y, sz * 0.5, 0, 6.2832); ctx.fill(); }
        }
      }
    });
    ctx.globalAlpha = 1;

    // 两个核：呼吸
    const breathe = 1 + 0.20 * Math.sin(t * 1.1);
    ['me', 'her'].forEach(function (k) {
      const c = CORE[k];
      const q = project(c.x, c.y, c.z);
      if (!q || reveal <= 0) return;
      const ps = q.s / REF;
      drawSprite(dot(RGB_CORE), q.x, q.y, 92 * ps * breathe, 0.34 * reveal);
      drawSprite(dot(RGB_CORE), q.x, q.y, 30 * ps, 0.85 * reveal);
      drawSprite(dot('255,255,255'), q.x, q.y, 7 * ps, 1.0 * reveal);
    });

    // 星座连线
    if (selected) {
      const q0 = project(selected.x, selected.y, selected.z);
      if (q0) {
        kinOf(selected).forEach(function (r) {
          const q1 = project(r.o.x, r.o.y, r.o.z);
          if (!q1) return;
          const al = 0.46 + r.w * 0.12;
          ctx.strokeStyle = 'rgba(' + selected.rgb + ',' + al.toFixed(3) + ')';
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(q0.x, q0.y);
          ctx.lineTo(q1.x, q1.y);
          ctx.stroke();
        });
      }
    }

    // 记忆星
    stars.forEach(function (n) {
      const q = project(n.x, n.y, n.z);
      if (!q) return;
      let lit = clamp((intro - 0.9 - n.phase * 0.4) / 0.8, 0, 1);
      let pop = 1;
      // 最后一颗（最新的那条记忆）等银河亮完再亮，慢慢"叮"一下
      if (n === newest) {
        const raw = clamp((intro - 3.0) / 1.0, 0, 1);
        lit = raw;
        pop = raw <= 0 ? 0 : easeOutBack(raw);
      }
      if (lit <= 0) return;
      const ps = q.s / REF;
      const tw = 0.88 + 0.12 * Math.sin(t * 1.1 + n.phase);
      const isSel = n === selected;
      const isHov = n === hovered;
      const hot = isSel ? 1 : (isHov ? 0.75 : 0);
      const r = n.size * ps * (isSel ? 2.0 : isHov ? 1.35 : 1) * (n === newest ? Math.max(0.6, pop) : 1);
      const al = lit * (n === newest ? Math.min(1.6, Math.max(0, pop)) : 1);

      drawSprite(dot(n.rgb), q.x, q.y, r * 4.0, (0.14 + hot * 0.26) * al);
      drawSprite(dot(n.rgb), q.x, q.y, r * 1.5, ((0.42 + n.imp * 0.34) * tw + hot * 0.28) * al);
      drawSprite(dot('255,255,255'), q.x, q.y, r * 0.42, 0.55 * al);
      n.ping *= 0.93;

      if (isHov && !isSel) {
        ctx.globalCompositeOperation = 'source-over';
        const label = n.text.length > 26 ? n.text.slice(0, 26) + '…' : n.text;
        ctx.font = '13px ui-sans-serif, system-ui, "Microsoft YaHei", sans-serif';
        ctx.textAlign = 'center';
        const tw2 = ctx.measureText(label).width;
        ctx.fillStyle = 'rgba(8,5,20,0.72)';
        ctx.fillRect(q.x - tw2 / 2 - 8, q.y - r * 3.6 - 26, tw2 + 16, 22);
        ctx.fillStyle = 'rgba(236,226,255,0.95)';
        ctx.fillText(label, q.x, q.y - r * 3.6 - 10);
        ctx.globalCompositeOperation = 'lighter';
      }
    });

    // ── 「叮」：最新那条记忆亮起来的那一下
    if (newest && intro > 3.0) {
      const e = intro - 3.0;
      const q = project(newest.x, newest.y, newest.z);
      if (q) {
        const ps = q.s / REF;
        // 一下白光
        const fl = Math.max(0, 1 - e / 0.5);
        if (fl > 0) {
          drawSprite(dot(newest.rgb), q.x, q.y, 42 * ps * (1.3 - fl * 0.3), 0.85 * fl * fl);
          drawSprite(dot(newest.rgb), q.x, q.y, 26 * ps, 0.55 * fl);
        }
        // 一圈软光散开（更像光，不像线框）
        const us = clamp(e / 1.25, 0, 1);
        if (us > 0 && us < 1) {
          const rr = (9 + 66 * (1 - Math.pow(1 - us, 2))) * ps;
          const g2 = ctx.createRadialGradient(q.x, q.y, rr * 0.62, q.x, q.y, rr);
          g2.addColorStop(0, 'rgba(255,255,255,0)');
          g2.addColorStop(0.72, 'rgba(' + newest.rgb + ',' + (0.30 * (1 - us)).toFixed(3) + ')');
          g2.addColorStop(1, 'rgba(' + newest.rgb + ',0)');
          ctx.fillStyle = g2;
          ctx.beginPath();
          ctx.arc(q.x, q.y, rr, 0, TAU);
          ctx.fill();
        }
        // 一道细细的光环
        const u = clamp((e - 0.1) / 1.5, 0, 1);
        if (u > 0 && u < 1) {
          const rr = (6 + 46 * (1 - Math.pow(1 - u, 2))) * ps;
          ctx.strokeStyle = 'rgba(' + newest.rgb + ',' + (0.45 * (1 - u) * (1 - u)).toFixed(3) + ')';
          ctx.lineWidth = 1.6 * (1 - u) + 0.4;
          ctx.beginPath();
          ctx.arc(q.x, q.y, rr, 0, TAU);
          ctx.stroke();
        }
        // 亮完之后留一点点余辉，几秒内慢慢收回
        const after = clamp((e - 1.6) / 12, 0, 1);
        if (after < 1) {
          drawSprite(dot(newest.rgb), q.x, q.y, 30 * ps, 0.20 * (1 - after));
        }
      }
    }

    if (selected) kinOf(selected).forEach(function (r) { r.o.ping = Math.max(r.o.ping, 0.35); });

    // ── 暗角 + 薄雾：边缘沉下去，中间亮起来（景深错觉）
    ctx.globalCompositeOperation = 'source-over';
    const vg = ctx.createRadialGradient(W / 2, H * 0.52, Math.min(W, H) * 0.26, W / 2, H * 0.52, Math.max(W, H) * 0.80);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(0.55, 'rgba(1,1,4,0.20)');
    vg.addColorStop(1, 'rgba(1,1,4,0.70)');
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, W, H);

    const fg2 = ctx.createRadialGradient(W / 2, H * 0.55, 0, W / 2, H * 0.55, Math.max(W, H) * 0.55);
    fg2.addColorStop(0, 'rgba(126,112,196,0.055)');
    fg2.addColorStop(0.55, 'rgba(96,84,168,0.030)');
    fg2.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = fg2;
    ctx.fillRect(0, 0, W, H);
  }

  // ── 交互 ────────────────────────────────────────────────
  function pick(mx, my) {
    let best = null, bd = 1e9;
    for (let i = 0; i < stars.length; i++) {
      const n = stars[i];
      const q = project(n.x, n.y, n.z);
      if (!q) continue;
      const dx = q.x - mx, dy = q.y - my;
      const d = dx * dx + dy * dy;
      const r = Math.max(17, n.size * 1.7);
      if (d < r * r && d < bd) { bd = d; best = n; }
    }
    return best;
  }

  function showPanel(n) {
    if (!n) { panel.classList.remove('on'); return; }
    pTitle.textContent = n.text.length > 24 ? n.text.slice(0, 24) + '…' : n.text;
    pDate.textContent = new Date(n.at).toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }).replace(/\\//g, '.');
    pBadge.textContent = n.key ? n.key : (n.owner === 'her' ? '关于' + USER_NAME : '关于我');
    pBody.textContent = n.text;
    // P3: fragment stars append tone + source entries to the body.
    // 0.3.1 拾光适配：碎片星要能看到原文来源，拾光原版只显示正文。
    // toneLabel / sources 是 DATA 里的额外字段，拾光原版会忽略它们；
    // 这里只在它们存在时追加到正文后面（P4 的 pre-line 让换行生效）。
    if (n.toneLabel) { pBody.textContent += '\\n片段 · 语气 ' + n.toneLabel; }
    if (n.sources && n.sources.length) {
      n.sources.forEach(function (s) {
        pBody.textContent += '\\n原文 ' + s.date + ' ' + s.time + '：' + s.text;
      });
    }
    panel.classList.add('on');
  }

  cv.addEventListener('pointerdown', function (e) {
    dragging = true;
    lastPointer = { x: e.clientX, y: e.clientY };
    downAt = { x: e.clientX, y: e.clientY };
    cv.classList.add('drag');
    try { cv.setPointerCapture(e.pointerId); } catch (err) { }
  });

  cv.addEventListener('pointermove', function (e) {
    if (dragging && lastPointer) {
      theta += (e.clientX - lastPointer.x) * 0.005;
      phi = clamp(phi + (e.clientY - lastPointer.y) * 0.0035, -1.25, 1.25);
      lastPointer = { x: e.clientX, y: e.clientY };
      return;
    }
    const n = pick(e.clientX - cvRect.left, e.clientY - cvRect.top);
    if (n !== hovered) { hovered = n; cv.style.cursor = n ? 'pointer' : 'grab'; }
  });

  function endDrag(e) {
    if (!dragging) return;
    dragging = false;
    cv.classList.remove('drag');
    if (e && e.pointerId !== undefined) {
      try { if (cv.hasPointerCapture(e.pointerId)) cv.releasePointerCapture(e.pointerId); } catch (err) { }
    }
    if (e && downAt && Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) < 6) {
      const n = pick(e.clientX - cvRect.left, e.clientY - cvRect.top);
      selected = n;
      showPanel(n);
    }
    downAt = null;
  }
  cv.addEventListener('pointerup', endDrag);
  cv.addEventListener('pointercancel', endDrag);
  cv.addEventListener('pointerleave', function () { hovered = null; });

  cv.addEventListener('wheel', function (e) {
    e.preventDefault();
    if (intro < 3.2) return;                       // 开场运镜期间先别抢
    distGoal = clamp(distGoal * Math.exp(e.deltaY * 0.0011), 3.4, 20);
  }, { passive: false });

  // ── 全屏（录屏用）
  const fsBtn = document.getElementById('fs');
  function toggleFS() {
    if (!document.fullscreenElement) {
      const p = document.documentElement.requestFullscreen && document.documentElement.requestFullscreen();
      if (p && p.catch) p.catch(function () { });
    } else if (document.exitFullscreen) {
      document.exitFullscreen();
    }
  }
  fsBtn.addEventListener('click', function (e) { e.stopPropagation(); toggleFS(); });
  document.addEventListener('fullscreenchange', function () {
    fsBtn.textContent = document.fullscreenElement ? '✕ 退出全屏' : '⛶ 全屏';
  });

  // 重播开场：不用刷新页面，直接从头再亮一次（录屏用）
  const replayBtn = document.getElementById('replay');
  function replay() {
    T0 = performance.now();
    intro = 0;
    theta = 0.5; phi = 0.30; dist = 13.5; distGoal = 9.2;
    selected = null; hovered = null;
    showPanel(null);
  }
  replayBtn.addEventListener('click', function (e) { e.stopPropagation(); replay(); });

  // 竖屏模式：中间一条 9:16，外边全黑（录抖音用）
  const vertBtn = document.getElementById('vert');
  function toggleVert() {
    vmode = !vmode;
    document.body.classList.toggle('vmode', vmode);
    vertBtn.textContent = vmode ? '▭ 横屏' : '▯ 竖屏';
    resize();
    requestAnimationFrame(resize);
  }
  vertBtn.addEventListener('click', function (e) { e.stopPropagation(); toggleVert(); });

  // 窗格被拖动 / 浏览器缩放时，尺寸要跟着变（工作台里尤其需要）
  if (window.ResizeObserver) {
    new ResizeObserver(function () { resize(); }).observe(document.getElementById('stage'));
  }

  // 鼠标不动就把按钮淡下去，录的时候不碍眼
  const tools = document.getElementById('tools');
  let idleTimer = null;
  function wake() {
    tools.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(function () { tools.classList.add('idle'); }, 2600);
  }
  window.addEventListener('mousemove', wake);
  wake();

  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { selected = null; showPanel(null); }
    if (e.key === 'f' || e.key === 'F') toggleFS();
    if (e.key === 'r' || e.key === 'R') replay();
    if (e.key === 'h' || e.key === 'H') document.body.classList.toggle('no-ui');
    if (e.key === 'v' || e.key === 'V') toggleVert();
  });

  window.addEventListener('resize', resize);

  // ── 主循环 ──────────────────────────────────────────────
  let last = performance.now();
  function loop(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    intro = FORCE_T != null ? FORCE_T : (now - T0) / 1000;

    // 开场运镜：从远到近，头 4 秒慢慢推
    const k = clamp(intro / 4.2, 0, 1);
    const ease = 1 - Math.pow(1 - k, 3);
    if (!dragging) theta += dt * 0.035;
    phiOff = Math.sin(intro * 0.85) * 0.11 * (1 - ease);   // 开场那点漂浮感
    dist = ((13.5 - 4.3 * ease) + (distGoal - 9.2) * ease) * (vmode ? 1.5 : 1);   // 推近之后交回滚轮

    draw(now / 1000);
    requestAnimationFrame(loop);
  }

  // P2: capped stat line, in 颗 (review-15 m-3: total is the star
  // count before the cap). The original's DATA.demo prefix is gone:
  // buildStarmapData never writes demo (m-6).
  document.getElementById('stat').textContent =
    stars.length + ' 颗记忆' + (DATA.capped ? ' · 全部 ' + DATA.total + ' 颗（只显示前 ' + stars.length + ' 颗）' : '');

  window.__map = { stars: stars, project: project, state: function () { return { theta: theta, phi: phi, dist: dist, intro: intro }; } };

  resize();
  // 兜底：窗格刚开 / 刚从后台切回来时，尺寸可能量早了
  setTimeout(function () { if (W < 20 || H < 20) resize(); }, 300);
  setTimeout(resize, 1500);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) resize(); });
  requestAnimationFrame(function (t0) { last = t0; loop(t0); });
})();
</script>
</body>
</html>
`;

/** Render the 拾光 page for this DATA. The template is split at
 *  the DATA line so the payload is spliced in, never searched
 *  for: safeJsonForHtml escapes <, > and &, so memory text can
 *  never break out of the script tag. */
export function renderStarmapHtml(data: StarmapData): string {
  return SHIGUANG_HEAD + safeJsonForHtml(data) + SHIGUANG_TAIL;
}
