// Starmap (0.2.0): render the memory sea as a realistic starry sky.
//
// One self-contained HTML file (starmap.html) in the data dir:
// the data is embedded as JSON, no external resources, no server —
// open it directly in a browser. Local only, nothing is uploaded.
// The HTML contains the user's own memory text (that is the point
// of the map), so it lives next to the log, never in a snapshot and
// never in a review package.
//
// Layout is deterministic (golden-angle spiral + edge relaxation),
// so stars don't jump between regenerations; linked stars are
// pulled toward each other, so constellation lines look connected.
// Nodes are stars: size/brightness by significance + recall count,
// colour by emotion. Click a star for its memory + tags; a time
// bar filters by date.

import { atomicWriteText } from "./atomic.ts";
import { contentTokens } from "./activation.ts";
import { emotionPolarity, retrievability } from "./attributes.ts";
import type { Fragment } from "./fragments.ts";
import type {
  EmotionTag,
  GraphEdge,
  MemoryAttributes,
  MemoryEntry,
} from "./types.ts";

export const STARMAP_FILE = "starmap.html";
/** Layout cap: beyond this, only the most significant nodes are
 *  drawn (the map says so when capped). */
export const MAX_STARMAP_NODES = 800;

export interface StarmapNode {
  id: string;
  x: number;
  y: number;
  r: number;
  color: string;
  brightness: number;
  text: string;
  date: string;
  time: string;
  /** Emotion type, e.g. 温暖; "" when untagged. */
  emotion: string;
  /** Emotion intensity 0..1 (shown as x/10, e.g. 心动 5/10). */
  emotionIntensity: number;
  /** This memory's keywords (提及/常用词), content tokens only. */
  keywords: string[];
  clarity: number;
  recallCount: number;
  significance: number;
  retrievability: number;
  ts: number;
  /** 0.3.0: "fragment" stars are fragments (one star per
   *  fragment); "entry" stars are log entries with no fragment yet. */
  kind: "fragment" | "entry";
  /** 0.3.0: the fragment's free-form tone label, e.g. 很喜欢. */
  toneLabel?: string;
  /** 0.3.0: the fragment's source log entry ids (provenance). */
  sourceIds?: string[];
  /** 0.3.0: the source log entries, so clicking a fragment star
   *  shows its text + tone + the originals (click through). */
  sources?: Array<{ id: string; date: string; time: string; text: string }>;
}

export interface StarmapData {
  generatedAt: string;
  nodes: StarmapNode[];
  edges: Array<{ from: string; to: string }>;
  capped: boolean;
  total: number;
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
 *  nothing, never a crash. */
export function emotionColor(type?: string): string {
  if (!type) return DEFAULT_STAR_COLOR;
  const known = EMOTION_COLORS[type];
  if (known) return known;
  const pol = emotionPolarity(type);
  if (pol === "positive") return "#ffd166";
  if (pol === "negative") return "#7aa7ff";
  return DEFAULT_STAR_COLOR;
}

export function emotionLabel(emotion?: EmotionTag): string {
  if (!emotion) return "未标注";
  return `${emotion.type} ${emotion.intensity.toFixed(1)}`;
}

/** FNV-1a hash, for deterministic seeds. */
export function hashSeed(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Deterministic PRNG (mulberry32). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function nodeRadius(significance: number, recallCount: number): number {
  return 2.2 + significance * 3.2 + Math.min(recallCount, 10) * 0.25;
}

function nodeBrightness(significance: number, recallCount: number): number {
  const v = 0.6 * significance + 0.4 * (Math.min(recallCount, 10) / 10);
  return 0.45 + 0.55 * Math.min(1, Math.max(0, v));
}

/** Deterministic layout: golden-angle spiral (most significant at
 *  the centre), then edge relaxation pulls linked stars together.
 *  O(edges x passes), no O(n^2) — fine for any log size. */
export function layoutStarmap(
  nodes: Array<{ id: string; x: number; y: number }>,
  edges: Array<{ from: string; to: string }>,
): void {
  const n = nodes.length;
  const byId = new Map(nodes.map((nd) => [nd.id, nd]));
  const GOLDEN = 2.399963;
  for (let i = 0; i < n; i++) {
    const angle = i * GOLDEN;
    const radius = 40 + 430 * Math.sqrt(n <= 1 ? 0 : i / n);
    nodes[i].x = 500 + radius * Math.cos(angle);
    nodes[i].y = 500 + radius * Math.sin(angle);
  }
  const usable = edges.filter((e) => byId.has(e.from) && byId.has(e.to));
  for (let pass = 0; pass < 24; pass++) {
    for (const e of usable) {
      const a = byId.get(e.from) as { x: number; y: number };
      const b = byId.get(e.to) as { x: number; y: number };
      const dx = (b.x - a.x) * 0.06;
      const dy = (b.y - a.y) * 0.06;
      a.x += dx;
      a.y += dy;
      b.x -= dx;
      b.y -= dy;
    }
    for (const nd of nodes) {
      nd.x += (500 - nd.x) * 0.005;
      nd.y += (500 - nd.y) * 0.005;
    }
  }
  for (const nd of nodes) {
    nd.x = Math.min(976, Math.max(24, nd.x));
    nd.y = Math.min(976, Math.max(24, nd.y));
  }
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
    retrievability: number;
    color: string;
    emotion: string;
    emotionIntensity: number;
    keywords: string[];
    toneLabel?: string;
    sourceIds?: string[];
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
    const retrievabilityMax = Math.max(
      ...sources.map((s) => {
        const a = attrs.get(s.id);
        return a ? retrievability(a, s, now) : 0;
      }),
    );
    // Fragment colour from its tone level (free-form tone has no
    // level: neutral default). Positive gold, negative red, lukewarm
    // the neutral star colour.
    const toneColor =
      f.tone.level === "strong-positive" || f.tone.level === "mild-positive"
        ? "#ffd166"
        : f.tone.level === "strong-negative" || f.tone.level === "mild-negative"
          ? "#ff6b6b"
          : DEFAULT_STAR_COLOR;
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
      retrievability: Math.round(retrievabilityMax * 100) / 100,
      color: toneColor,
      emotion: "",
      emotionIntensity: 0,
      keywords: f.keywords.slice(0, 8),
      toneLabel: f.tone.label,
      sourceIds: [...f.sourceIds],
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
      retrievability: a
        ? Math.round(retrievability(a, e, now) * 100) / 100
        : 0,
      color: emotionColor(a?.emotion?.type),
      emotion: a?.emotion?.type ?? "",
      emotionIntensity: a?.emotion?.intensity ?? 0,
      keywords: [...contentTokens(e.text)].slice(0, 8),
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
  const placed: Array<{ id: string; x: number; y: number }> = picked.map(
    (e) => ({ id: e.id, x: 500, y: 500 }),
  );
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
  layoutStarmap(
    placed,
    usableEdges.map((e) => ({ from: e.from, to: e.to })),
  );
  const pos = new Map(placed.map((p) => [p.id, p]));
  const nodes: StarmapNode[] = picked.map((e) => {
    const p = pos.get(e.id) as { x: number; y: number };
    return {
      id: e.id,
      x: Math.round(p.x * 10) / 10,
      y: Math.round(p.y * 10) / 10,
      r: Math.round(nodeRadius(e.significance, e.recallCount) * 10) / 10,
      color: e.color,
      brightness:
        Math.round(nodeBrightness(e.significance, e.recallCount) * 100) / 100,
      text: e.text,
      date: e.date,
      time: e.time,
      emotion: e.emotion,
      emotionIntensity: e.emotionIntensity,
      keywords: e.keywords,
      clarity: e.clarity,
      recallCount: e.recallCount,
      significance: Math.round(e.significance * 100) / 100,
      retrievability: e.retrievability,
      ts: e.ts,
      kind: e.kind,
      toneLabel: e.toneLabel,
      sourceIds: e.sourceIds,
      sources: e.sources,
    };
  });
  return {
    generatedAt: new Date(now).toISOString(),
    nodes,
    edges: usableEdges,
    capped,
    total: entries.length,
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

function escAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

/** Decorative background stars: seeded, so the sky is stable. */
function backgroundStars(rng: () => number): string {
  const parts: string[] = [];
  for (let i = 0; i < 220; i++) {
    const x = Math.round(rng() * 1000);
    const y = Math.round(rng() * 1000);
    const r = (0.3 + rng() * 0.9).toFixed(2);
    const o = (0.25 + rng() * 0.6).toFixed(2);
    const dur = (2 + rng() * 3.5).toFixed(1);
    const delay = (-rng() * 5).toFixed(1);
    parts.push(
      `<circle class="bgstar" cx="${x}" cy="${y}" r="${r}" fill="#cdd8ff" style="--o:${o};animation-duration:${dur}s;animation-delay:${delay}s"/>`,
    );
  }
  return parts.join("");
}


export function renderStarmapHtml(data: StarmapData): string {
  const rng = mulberry32(20261107);
  const bg = backgroundStars(rng);
  // One index lookup per edge, not a linear scan per endpoint:
  // the old code did data.nodes.find() twice per edge (O(edges x
  // nodes)), which is ~800k comparisons at 1500 memories.
  const nodeById = new Map(data.nodes.map((n) => [n.id, n]));
  const edgeSvg = data.edges
    .map((e) => {
      const a = nodeById.get(e.from);
      const b = nodeById.get(e.to);
      if (!a || !b) return "";
      return `<line class="edge" data-a="${escAttr(e.from)}" data-b="${escAttr(e.to)}" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}"/>`;
    })
    .join("");
  const stars = data.nodes
    .map((n) => {
      const dur = (2.5 + ((hashSeed(n.id) % 100) / 100) * 3).toFixed(1);
      const delay = (-((hashSeed(n.id) % 50) / 10)).toFixed(1);
      return `<circle class="star" data-id="${escAttr(n.id)}" data-ts="${n.ts}" cx="${n.x}" cy="${n.y}" r="${n.r}" fill="${n.color}" style="--o:${n.brightness};animation-duration:${dur}s;animation-delay:${delay}s"><title>${escAttr(n.date)} ${escAttr(n.time)}</title></circle>`;
    })
    .join("");
  const cappedNote = data.capped
    ? `<span class="capped">只显示前 ${MAX_STARMAP_NODES} 颗（按重要性）</span>`
    : "";
  const legend = Object.entries(EMOTION_COLORS)
    .map(
      ([type, color]) =>
        `<span class="lg"><i style="background:${color}"></i>${type}</span>`,
    )
    .join("");
  const json = safeJsonForHtml(data);
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>记忆星空</title>
<style>
html,body{margin:0;padding:0;height:100%;overflow:hidden;background:#04060f;color:#dfe6ff;font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif}
.sky{position:fixed;inset:0;background:radial-gradient(1200px 800px at 70% 20%,#0d1530 0%,#070b1d 45%,#04060f 100%)}
.nebula{position:fixed;border-radius:50%;filter:blur(70px);pointer-events:none;opacity:.55}
.n1{width:560px;height:560px;left:-120px;top:-140px;background:radial-gradient(circle,rgba(124,92,255,.28),transparent 65%)}
.n2{width:640px;height:640px;right:-180px;bottom:-220px;background:radial-gradient(circle,rgba(45,170,190,.22),transparent 65%)}
.n3{width:420px;height:420px;left:38%;top:52%;background:radial-gradient(circle,rgba(90,120,255,.20),transparent 65%)}
.milkyway{position:fixed;left:-30%;top:34%;width:160%;height:230px;transform:rotate(-24deg);background:linear-gradient(90deg,transparent,rgba(150,170,255,.08) 18%,rgba(205,185,255,.16) 50%,rgba(150,170,255,.08) 82%,transparent);filter:blur(16px);pointer-events:none}
svg#map{position:fixed;inset:0;width:100%;height:100%}
.bgstar{opacity:var(--o,.6);animation:tw 3s ease-in-out infinite}
.star{cursor:pointer;opacity:var(--o,.8);filter:url(#glow);animation:tw 3.5s ease-in-out infinite}
.star:hover{stroke:#fff;stroke-width:1.2}
.star.past{opacity:calc(var(--o,.8)*.45)}
.star.dimmed{opacity:.05;animation:none}
.star.dimmed:not(.recall){pointer-events:none}
.star.lit{stroke:#fff;stroke-width:1.4}
.star.recall{stroke:#ffd166;stroke-width:2}
@keyframes tw{0%,100%{opacity:var(--o,.8)}50%{opacity:calc(var(--o,.8)*.55)}}
.edge{stroke:rgba(170,190,255,.22);stroke-width:1;transition:stroke .4s}
.edge.lit{stroke:rgba(200,215,255,.75);stroke-width:1.4}
.edge.recall-line{stroke:rgba(255,209,102,.9);stroke-width:2}
.edge.hidden{display:none}
#controls{position:fixed;top:14px;left:14px;right:14px;display:flex;flex-wrap:wrap;gap:8px 18px;align-items:center;background:rgba(6,10,26,.72);border:1px solid rgba(150,170,255,.18);border-radius:12px;padding:10px 14px;backdrop-filter:blur(6px);font-size:13px}
#controls h1{font-size:15px;margin:0 6px 0 0;font-weight:600;letter-spacing:.12em}
#controls .meta{opacity:.75}
#controls input[type=range]{width:150px;accent-color:#8aa8ff}
#controls input[type=text]{background:rgba(20,28,56,.9);border:1px solid rgba(150,170,255,.3);color:#dfe6ff;border-radius:8px;padding:6px 10px;font-size:13px;width:170px;outline:none}
#controls button{background:rgba(60,80,160,.85);border:1px solid rgba(150,170,255,.35);color:#fff;border-radius:8px;padding:6px 12px;font-size:13px;cursor:pointer}
#controls button:hover{background:rgba(80,105,200,.9)}
#recall-status{opacity:.9;min-width:120px}
#time-label{opacity:.85;min-width:190px}
#legend{display:flex;flex-wrap:wrap;gap:4px 10px;font-size:12px;opacity:.85}
#legend .lg i{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:4px;vertical-align:0}
.capped{color:#ffd166}
#dials{display:flex;gap:16px;font-size:12px;opacity:.9}
#dials .dial{min-width:110px}
#dials .bar{height:5px;border-radius:3px;background:rgba(150,170,255,.18);margin-top:3px;overflow:hidden}
#dials .bar i{display:block;height:100%;background:#8aa8ff;border-radius:3px}
#panel{position:fixed;left:50%;transform:translate(-50%,120%);bottom:18px;width:min(680px,92vw);background:rgba(8,12,30,.92);border:1px solid rgba(150,170,255,.25);border-radius:14px;padding:16px 18px;transition:transform .25s ease;box-shadow:0 12px 40px rgba(0,0,0,.55);font-size:14px;line-height:1.7}
#panel.open{transform:translate(-50%,0)}
#p-date{opacity:.7;font-size:12px;letter-spacing:.08em}
#p-text{margin:6px 0 10px;font-size:15px}
#p-tags{font-size:12.5px;opacity:.9;border-top:1px solid rgba(150,170,255,.18);padding-top:8px}
#p-tags div{padding:1px 0}
#p-close{position:absolute;top:8px;right:12px;background:none;border:none;color:#dfe6ff;font-size:18px;cursor:pointer;opacity:.7}
#hint{position:fixed;bottom:16px;left:16px;font-size:12px;opacity:.55}
</style>
</head>
<body>
<div class="sky"></div>
<div class="nebula n1"></div><div class="nebula n2"></div><div class="nebula n3"></div>
<div class="milkyway"></div>
<svg id="map" viewBox="0 0 1000 1000" preserveAspectRatio="xMidYMid slice">
<defs><filter id="glow" x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="2.5" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>
<g id="bg">${bg}</g>
<g id="edges">${edgeSvg}</g>
<g id="stars">${stars}</g>
</svg>
<div id="controls">
<h1>记忆星空</h1>
<span class="meta">共 ${data.nodes.length} 颗星 · ${data.edges.length} 条线${data.total > data.nodes.length ? ` · 全部 ${data.total} 条` : ""}</span>${cappedNote}
<span id="legend">${legend}<span class="lg"><i style="background:#e8ecff"></i>未标注</span></span>
<span><input id="recall-input" type="text" placeholder="输入一个触发词，比如 酸梅汤"><button id="recall-btn">想起</button><button id="recall-clear">清除</button></span>
<span id="recall-status"></span>
<span>时间流速 <input id="time-slider" type="range" min="0" max="1000" value="1000"><button id="time-play">▶</button></span>
<span id="time-label"></span>
<span id="dials"></span>
</div>
<div id="panel"><button id="p-close" aria-label="关闭">×</button><div id="p-date"></div><div id="p-text"></div><div id="p-tags"></div></div>
<div id="hint">点一颗星看那条记忆 · 悬停看它连着的线 · 拖时间条看不同时间的记忆</div>
<script type="application/json" id="starmap-data">${json}</script>
<script>
(function(){
var data = JSON.parse(document.getElementById('starmap-data').textContent);
var byId = {};
data.nodes.forEach(function(n){ byId[n.id] = n; });
var svg = document.getElementById('map');
var panel = document.getElementById('panel');
var panelDate = document.getElementById('p-date');
var panelText = document.getElementById('p-text');
var panelTags = document.getElementById('p-tags');
var panelClose = document.getElementById('p-close');
var recallInput = document.getElementById('recall-input');
var recallBtn = document.getElementById('recall-btn');
var recallClear = document.getElementById('recall-clear');
var recallStatus = document.getElementById('recall-status');
var timeSlider = document.getElementById('time-slider');
var timePlay = document.getElementById('time-play');
var timeLabel = document.getElementById('time-label');
var dialsEl = document.getElementById('dials');
var selectedId = null;
function hashStr(s){ var h = 0; for (var i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; } return Math.abs(h); }
function clearLit(){
svg.querySelectorAll('.edge.lit').forEach(function(e){ e.classList.remove('lit'); });
svg.querySelectorAll('.star.lit').forEach(function(e){ e.classList.remove('lit'); });
}
function paintHighlight(id){
clearLit();
if (!id) return;
var c = svg.querySelector('[data-id="' + id + '"]');
if (c) c.classList.add('lit');
data.edges.forEach(function(e){
if (e.from !== id && e.to !== id) return;
var line = svg.querySelector('[data-a="' + e.from + '"][data-b="' + e.to + '"]');
if (line) line.classList.add('lit');
var other = e.from === id ? e.to : e.from;
var oc = svg.querySelector('[data-id="' + other + '"]');
if (oc) oc.classList.add('lit');
});
}
function setTags(n){
panelTags.textContent = '';
var rows = [
['时间', n.date + ' ' + n.time],
['情绪', n.emotion ? n.emotion + ' ' + Math.round(n.emotionIntensity * 10) + '/10' : '未标注'],
['清晰度', Math.round(n.clarity * 100) + '%'],
['被想起', n.recallCount + ' 次'],
['重要性', n.significance.toFixed(2)],
['可检索性', n.retrievability.toFixed(2)],
['常用词', n.keywords && n.keywords.length ? n.keywords.join('、') : '暂无']
];
if (n.kind === 'fragment') {
rows.unshift(['类型', '片段 · 语气 ' + (n.toneLabel || '未标注')]);
}
rows.forEach(function(r){
var div = document.createElement('div');
div.textContent = r[0] + '  ' + r[1];
panelTags.appendChild(div);
});
if (n.sources && n.sources.length) {
n.sources.forEach(function(s){
var div = document.createElement('div');
div.textContent = '原文 ' + s.date + ' ' + s.time + '：' + s.text;
panelTags.appendChild(div);
});
}
}
function show(n){
selectedId = n.id;
paintHighlight(n.id);
panelDate.textContent = n.date + ' ' + n.time;
panelText.textContent = n.text;
setTags(n);
panel.classList.add('open');
}
svg.addEventListener('click', function(ev){
var t = ev.target;
if (t && t.classList && t.classList.contains('star')) {
var n = byId[t.getAttribute('data-id')];
if (n) show(n);
}
});
svg.addEventListener('mouseover', function(ev){
var t = ev.target;
if (t && t.classList && t.classList.contains('star')) {
paintHighlight(t.getAttribute('data-id'));
}
});
svg.addEventListener('mouseout', function(ev){
var t = ev.target;
if (t && t.classList && t.classList.contains('star')) {
paintHighlight(selectedId);
}
});
panelClose.addEventListener('click', function(){ panel.classList.remove('open'); selectedId = null; paintHighlight(null); });
var CJK_RUN = /[\\u3400-\\u9fff\\uf900-\\ufaff\\u3040-\\u30ff\\u{20000}-\\u{2a6df}\\u{2a700}-\\u{2b73f}\\u{2b740}-\\u{2b81f}\\u{2b820}-\\u{2ceaf}\\u{2ceb0}-\\u{2ebef}\\u{30000}-\\u{3134a}]+/gu;
var WORD_RUN = /[a-z0-9]+(?:[.'-][a-z0-9]+)*/g;
var STOP = new Set('的了在是有和就都也还不没很这那我你他她它们个一上下來去吗呢吧啊哦嗯呀么'.split(''));
function tokenize(text){
var out = new Set();
var low = String(text).toLowerCase();
var m = low.matchAll(WORD_RUN);
for (var w of m) out.add(w[0]);
var r = String(text).matchAll(CJK_RUN);
for (var run of r) {
var s = run[0];
if (s.length > 1 && s.length <= 6) out.add(s);
for (var ch of s) { if (!STOP.has(ch)) out.add(ch); }
for (var i = 0; i + 1 < s.length; i++) out.add(s.slice(i, i + 2));
}
return out;
}
var tokenSets = {};
data.nodes.forEach(function(n){ tokenSets[n.id] = tokenize(n.text); });
var recallTimers = [];
function clearRecall(){
recallTimers.forEach(function(t){ clearTimeout(t); });
recallTimers = [];
svg.querySelectorAll('.recall').forEach(function(e){ e.classList.remove('recall'); });
svg.querySelectorAll('.recall-line').forEach(function(e){ e.classList.remove('recall-line'); });
recallStatus.textContent = '';
}
function shortText(t){ return t.length > 12 ? t.slice(0, 12) + '…' : t; }
function runRecall(){
var q = recallInput.value.trim();
if (!q) { recallStatus.textContent = '先输入一个词'; return; }
clearRecall();
var qt = tokenize(q);
var seeds = data.nodes.filter(function(n){
var ts = tokenSets[n.id];
var it = qt.values();
var hit = false;
var cur = it.next();
while (!cur.done) { if (ts.has(cur.value)) { hit = true; break; } cur = it.next(); }
return hit;
});
if (seeds.length === 0) { recallStatus.textContent = '没有想起什么，换个词试试'; return; }
var lit = [];
var litSet = new Set();
function light(nodes, connecting){
nodes.forEach(function(n){
if (litSet.has(n.id)) return;
litSet.add(n.id);
lit.push(n);
var c = svg.querySelector('[data-id="' + n.id + '"]');
if (c) c.classList.add('recall');
});
if (connecting) {
connecting.forEach(function(e){
var line = svg.querySelector('[data-a="' + e.from + '"][data-b="' + e.to + '"]');
if (line) line.classList.add('recall-line');
});
}
recallStatus.textContent = '想起「' + q + '」，顺着线亮起了：' + lit.map(function(n){ return shortText(n.text); }).join('、');
}
light(seeds, null);
var frontier = seeds;
var level = 0;
function nextLevel(){
level += 1;
if (level > 2) return;
var next = [];
var connecting = [];
frontier.forEach(function(n){
data.edges.forEach(function(e){
if (e.from !== n.id && e.to !== n.id) return;
var otherId = e.from === n.id ? e.to : e.from;
if (litSet.has(otherId)) return;
var other = byId[otherId];
if (!other) return;
next.push(other);
connecting.push(e);
});
});
if (next.length === 0) return;
frontier = next;
recallTimers.push(setTimeout(function(){ light(next, connecting); nextLevel(); }, 450));
}
recallTimers.push(setTimeout(nextLevel, 450));
}
recallBtn.addEventListener('click', runRecall);
recallInput.addEventListener('keydown', function(ev){ if (ev.key === 'Enter') runRecall(); });
recallClear.addEventListener('click', clearRecall);
var minTs = data.nodes.reduce(function(m,n){ return Math.min(m,n.ts); }, Infinity);
var maxTs = data.nodes.reduce(function(m,n){ return Math.max(m,n.ts); }, -Infinity);
function fmt(ts){ var d = new Date(ts); return d.getFullYear() + '/' + ('0'+(d.getMonth()+1)).slice(-2) + '/' + ('0'+d.getDate()).slice(-2); }
function applyTime(){
var v = +timeSlider.value;
if (!isFinite(minTs) || !isFinite(maxTs)) { timeLabel.textContent = '暂无记忆'; return; }
var span = maxTs - minTs;
var cursor = minTs + span * v / 1000;
var pastEdge = cursor - span / 3;
var litCount = 0;
svg.querySelectorAll('.star').forEach(function(c){
var ts = +c.getAttribute('data-ts');
c.classList.remove('dimmed');
c.classList.remove('past');
if (ts > cursor) { c.classList.add('dimmed'); }
else if (ts < pastEdge) { c.classList.add('past'); }
else { litCount += 1; }
});
svg.querySelectorAll('.edge').forEach(function(l){
var a = svg.querySelector('[data-id="' + l.getAttribute('data-a') + '"]');
var b = svg.querySelector('[data-id="' + l.getAttribute('data-b') + '"]');
var hide = (a && a.classList.contains('dimmed')) || (b && b.classList.contains('dimmed'));
l.classList.toggle('hidden', !!hide);
});
timeLabel.textContent = fmt(cursor) + ' · ' + litCount + ' 颗星';
}
timeSlider.addEventListener('input', applyTime);
var playTimer = null;
timePlay.addEventListener('click', function(){
if (playTimer) { clearInterval(playTimer); playTimer = null; timePlay.textContent = '▶'; return; }
if (+timeSlider.value >= 1000) timeSlider.value = '0';
timePlay.textContent = '⏸';
playTimer = setInterval(function(){
var v = +timeSlider.value + 8;
if (v >= 1000) { v = 1000; clearInterval(playTimer); playTimer = null; timePlay.textContent = '▶'; }
timeSlider.value = String(v);
applyTime();
}, 100);
});
applyTime();
var POSITIVE = { '开心': 1, '兴奋': 1, '温暖': 1, '安心': 1, '害羞': 1, '思念': 1 };
var NEGATIVE = { '难过': 1, '委屈': 1, '生气': 1, '紧张': 1, '疲惫': 1, '吃醋': 1 };
var CALM = { '安心': 1, '温暖': 1 };
var AROUSED = { '兴奋': 1, '开心': 1, '生气': 1 };
function renderDials(){
var recent = data.nodes.slice().sort(function(a,b){ return b.ts - a.ts; }).slice(0, 20);
var pos = 0, neg = 0, calm = 0, aroused = 0, counted = 0;
recent.forEach(function(n){
var e = n.emotion;
if (!e) return;
counted += 1;
if (POSITIVE[e]) pos += 1;
if (NEGATIVE[e]) neg += 1;
if (CALM[e]) calm += 1;
if (AROUSED[e]) aroused += 1;
});
dialsEl.textContent = '';
function dial(label, pct, note){
var wrap = document.createElement('span');
wrap.className = 'dial';
var t = document.createElement('span');
t.textContent = label + ' ' + (pct === null ? '—' : pct + '%');
wrap.appendChild(t);
var bar = document.createElement('span');
bar.className = 'bar';
var fill = document.createElement('i');
fill.style.width = (pct === null ? 0 : pct) + '%';
bar.appendChild(fill);
wrap.appendChild(bar);
dialsEl.appendChild(wrap);
}
if (counted === 0) {
var none = document.createElement('span');
none.textContent = '状态：暂无情绪数据';
dialsEl.appendChild(none);
return;
}
var balance = Math.round(100 * (1 - Math.abs(pos - neg) / counted));
dial('平衡', balance);
dial('安心', Math.round(100 * calm / counted));
dial('澎湃', Math.round(100 * aroused / counted));
var note = document.createElement('span');
note.textContent = '按最近 20 条记忆的情绪算';
note.style.opacity = '0.6';
dialsEl.appendChild(note);
}
renderDials();
var basePos = {};
data.nodes.forEach(function(n){ basePos[n.id] = { x: n.x, y: n.y, ph: (hashStr(n.id) % 628) / 100, sp: 0.25 + (hashStr(n.id) % 100) / 100 * 0.35 }; });
var driftTimer = null;
function driftTick(){
var t = Date.now() / 1000;
var offs = {};
svg.querySelectorAll('.star').forEach(function(c){
var id = c.getAttribute('data-id');
var b = basePos[id];
if (!b) return;
var dx = Math.sin(t * b.sp + b.ph) * 2.2;
var dy = Math.cos(t * b.sp * 0.9 + b.ph) * 2.2;
offs[id] = { dx: dx, dy: dy };
c.setAttribute('transform', 'translate(' + dx.toFixed(2) + ' ' + dy.toFixed(2) + ')');
});
svg.querySelectorAll('.edge').forEach(function(l){
var a = basePos[l.getAttribute('data-a')];
var b = basePos[l.getAttribute('data-b')];
if (!a || !b) return;
var oa = offs[l.getAttribute('data-a')] || { dx: 0, dy: 0 };
var ob = offs[l.getAttribute('data-b')] || { dx: 0, dy: 0 };
l.setAttribute('x1', (a.x + oa.dx).toFixed(1));
l.setAttribute('y1', (a.y + oa.dy).toFixed(1));
l.setAttribute('x2', (b.x + ob.dx).toFixed(1));
l.setAttribute('y2', (b.y + ob.dy).toFixed(1));
});
}
driftTimer = setInterval(driftTick, 200);
window.__starmap = { stop: function(){ if (driftTimer) { clearInterval(driftTimer); driftTimer = null; } if (playTimer) { clearInterval(playTimer); playTimer = null; } }, data: data };
})();
</script>
</body>
</html>`;
}
