// Recall: keyword match + importance + recency, ranked, with a token
// cap so the caller never injects an unbounded blob into context.
// v1 is keyword-only (CJK bigrams + latin words). No vector/semantic
// recall.
//
// No-match behaviour (fixed 2026-11-05): when nothing matches the
// query keywords, recall returns NO hits and empty injectable text.
// v1 fell back to "most recent, heavy first", which injected unrelated
// memories (and burned tokens) on every unrelated question, including
// in task windows. A search with no matches is an empty result, not
// an excuse to inject something else.

import {
  ACTIVATION_THRESHOLD,
  GRAPH_HOP_DECAY,
  activationFor,
  applyValveTop,
  computeActivation,
  contentFactor,
  detectQueryEmotion,
  emotionFactor,
  relationshipFactor,
  timeFactor,
  attentionFactor,
  topicOf,
} from "./activation.ts";
import {
  defaultClarity,
  initialSignificance,
  tagEmotion,
  type AttributeStore,
} from "./attributes.ts";
import { ageDays } from "./dates.ts";
import { TRAVERSABLE_TYPES, type MemoryGraph } from "./graph.ts";
import { estimateTokens, tokenize } from "./tokenize.ts";
import type { FragmentStore } from "./fragments.ts";
import type {
  Layer1State,
  MemoryAttributes,
  MemoryEntry,
  RecallHit,
  RecallResult,
} from "./types.ts";

export const DEFAULT_TOKEN_CAP = 1500;

export interface RecallOptions {
  /** Default "persona": only persona-window records. "all" includes task
   *  records (never injected as persona experience by default). */
  window?: "persona" | "task" | "all";
  /** Max estimated tokens for the returned block. Default 1500. */
  tokenCap?: number;
  /** Max hits. Default 10. */
  limit?: number;
  /** Restrict the log scan to these entry ids (e.g. a keyword-index
   *  lookup). Archive entries are exempt — they are not in the index
   *  (audit m1). */
  candidateIds?: Set<string>;
  /** Layer-2 entries from MEMORY.md (recent 30 days). The skill reads
   *  these at open, so a log hit saying the same thing is dropped in
   *  favour of the curated copy (0.1.6 recall dedupe). */
  layer2?: MemoryEntry[];
  /** 0.2.0: current session id (relationship factor: same session
   *  scores 1.0). */
  sessionId?: string;
  /** 0.2.0: recent turns' user messages (attention factor). */
  recentTexts?: string[];
  /** 0.2.0: the memory graph (graph expansion follows keyword +
   *  recall edges from direct hits). */
  graph?: MemoryGraph;
  /** 0.2.0: attribute store (activation factors + compression).
   *  When absent, defaults are computed, not persisted. */
  attributes?: AttributeStore;
  /** 0.2.0: entryId -> compressed one-line summary (review). */
  summaries?: Map<string, string>;
  /** 0.2.0: run the 心光 valve (threshold + per-topic cap +
   *  top-5). Default: on when no explicit limit is passed (the
   *  injection path), off for explicit searches. */
  valve?: boolean;
  /** 0.3.0: the fragment store. When present, a hit whose entry
   *  is covered by a fragment injects the fragment text (with its
   *  tone tag) instead of the full original — after the fragment
   *  passes its retrieval-time re-check against its sources. A
   *  fragment that fails the re-check falls back to the verbatim
   *  source text and is marked suspect in the store. */
  fragments?: FragmentStore;
}

/** Attributes for an entry: the stored row when available, else
 *  computed defaults (never persisted here). */
function attrsFor(
  entry: MemoryEntry,
  store: AttributeStore | undefined,
  now: number,
): MemoryAttributes {
  if (store) return store.ensure(entry, undefined, now);
  return {
    emotion: tagEmotion(entry.text),
    clarity: defaultClarity(entry, now),
    recallCount: 0,
    significance: initialSignificance(entry),
  };
}

export function scoreEntry(
  entry: MemoryEntry,
  matchedCount: number,
  now: number,
): number {
  const keyword = matchedCount * 2;
  const importance = entry.importance === "heavy" ? 3 : 0;
  const recency = 1 / (1 + ageDays(entry.ts, now));
  return keyword + importance + recency;
}

/** Normalise text for the 0.1.6 recall dedupe: strip whitespace and
 *  punctuation, lowercase. CJK punctuation (、。！？ etc.) is \p{P},
 *  symbols (including most emoji) are \p{S}, so one pattern covers
 *  both scripts. */
export function normalizeForDedupe(text: string): string {
  if (typeof text !== "string") return "";
  return text.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");
}

/** The MEMORY.md texts the skill already reads at open: layer-1 items
 *  (likes, dislikes, agreements, heavy notes, unrecognised lines) plus
 *  layer-2 entry texts. Normalised, and only the ones long enough to
 *  match reliably (>= 10 chars) are kept — a short phrase ("查岗",
 *  "酸梅汤") appears in too many unrelated lines to prove a duplicate. */
export function memoryDedupeTexts(
  layer1: Layer1State | null,
  layer2: MemoryEntry[],
): string[] {
  const raw: string[] = [];
  if (layer1) {
    raw.push(
      ...layer1.likes,
      ...layer1.dislikes,
      ...layer1.agreements,
      ...layer1.heavyNotes,
      ...layer1.extra,
    );
  }
  for (const e of layer2) {
    if (typeof e.text === "string") raw.push(e.text);
  }
  const out: string[] = [];
  for (const t of raw) {
    const n = normalizeForDedupe(t);
    if (n.length >= 10) out.push(n);
  }
  return out;
}

/** True when the normalised log text is a duplicate of one of the
 *  normalised MEMORY.md texts — and dropping it loses nothing.
 *  (0.1.7 remainder rule; 0.1.6 dropped on any containment either
 *  way, which swallowed a log turn that carried a known fact PLUS a
 *  new fact.) Two cases:
 *  - The log text is the longer side and contains the MEMORY.md
 *    fact: drop ONLY if removing the fact leaves < 10 chars — the
 *    log turn is (nearly) just that one fact. If more substance
 *    remains, the turn carries new information and is kept.
 *  - The log text is the shorter side and is contained in the
 *    MEMORY.md text: the log adds nothing the skill does not
 *    already have, so drop it.
 *  The shorter side must be >= 10 chars, so a short generic phrase
 *  never matches. This is a containment check only — no semantic
 *  judgement, and it never deletes anything: the caller drops the
 *  log copy and keeps the curated MEMORY.md copy (which the skill
 *  already has). */
function duplicatesMemoryText(
  logNorm: string,
  memoryNorms: string[],
): boolean {
  if (logNorm.length < 10) return false;
  for (const m of memoryNorms) {
    if (m.length < 10) continue;
    if (logNorm.length >= m.length) {
      if (logNorm.includes(m) && logNorm.replace(m, "").length < 10) {
        return true;
      }
    } else if (m.includes(logNorm)) {
      return true;
    }
  }
  return false;
}

export function recallFromEntries(
  entries: MemoryEntry[],
  layer1: Layer1State | null,
  query: string,
  opts: RecallOptions = {},
  now = Date.now(),
): RecallResult {
  const window = opts.window ?? "persona";
  const tokenCap = opts.tokenCap ?? DEFAULT_TOKEN_CAP;
  const limit = opts.limit ?? 10;
  const tokens = tokenize(query);
  const queryEmotion = detectQueryEmotion(query);
  const recentTexts = opts.recentTexts ?? [];
  const valveOn = opts.valve ?? opts.limit === undefined;

  const scoped = entries.filter(
    (e) => window === "all" || e.window === window,
  );
  const byId = new Map(scoped.map((e) => [e.id, e]));

  // Keyword hits. A candidateIds set (from the keyword index) bounds
  // the log scan; archive rows are exempt (they are not in the index).
  const matched = new Map<string, string[]>(); // entry id -> matched tokens
  if (tokens.length > 0) {
    for (const e of scoped) {
      if (typeof e.text !== "string") continue; // defensive (audit B2)
      if (
        opts.candidateIds &&
        e.source !== "archive" &&
        !opts.candidateIds.has(e.id)
      ) {
        continue;
      }
      const entryTokens = new Set(tokenize(e.text));
      const hits = tokens.filter((t) => entryTokens.has(t));
      if (hits.length > 0) matched.set(e.id, hits);
    }
  }

  // Document frequency over the scoped entries, for the valve's
  // topic (rarest matched token). Only computed when there are hits.
  let docFreq = new Map<string, number>();
  if (matched.size > 0) {
    for (const e of scoped) {
      for (const t of new Set(tokenize(e.text))) {
        docFreq.set(t, (docFreq.get(t) ?? 0) + 1);
      }
    }
  }

  // Ranked direct hits with 0.2.0 activation. No keyword match (or
  // empty query) means no hits at all — see the header note. There
  // is deliberately no "most recent" fallback.
  let ranked: RecallHit[] = [];
  if (matched.size > 0) {
    ranked = [...matched.entries()]
      .map(([id, matchedTokens]) => {
        const entry = byId.get(id) as MemoryEntry;
        const attrs = attrsFor(entry, opts.attributes, now);
        const { activation } = activationFor(entry, {
          matchedCount: matchedTokens.length,
          queryTokenCount: tokens.length,
          sessionId: opts.sessionId,
          queryEmotion,
          attrs,
          recentTexts,
          now,
        });
        return {
          entry,
          score: scoreEntry(entry, matchedTokens.length, now),
          matchedTokens,
          activation,
          topic: topicOf(matchedTokens, docFreq),
        };
      })
      .sort((a, b) => b.score - a.score || b.entry.ts - a.entry.ts);
  }

  // Dedupe BEFORE the token cap, but only across sources (audit m2):
  // a raw-log fragment and its monthly-archive copy are the same
  // memory and must not eat two cap slots — the first copy in ranked
  // order wins, whichever source it is. Genuine repeats INSIDE the
  // log ("好的" said twice, the same question on two days) are kept:
  // the second occurrence has its own time and context.
  const dedupeCrossSource = (list: RecallHit[]): RecallHit[] => {
    const seenLogTexts = new Set<string>();
    const seenArchiveTexts = new Set<string>();
    return list.filter((hit) => {
      const key = hit.entry.text.trim();
      if (hit.entry.source === "archive") {
        if (seenLogTexts.has(key) || seenArchiveTexts.has(key)) return false;
        seenArchiveTexts.add(key);
        return true;
      }
      if (seenArchiveTexts.has(key)) return false;
      seenLogTexts.add(key);
      return true;
    });
  };

  // 0.1.6 recall dedupe (remainder rule since 0.1.7): the skill
  // already reads layer 1 + layer 2 (recent 30 days) at open. A
  // raw-log hit saying the same thing as a MEMORY.md entry would
  // appear twice in context — drop the log copy, keep the curated
  // one (the skill already has it; nothing is deleted from disk,
  // the log entry stays). Archive hits are exempt: the skill does
  // NOT read archives at open, so an archive hit is new
  // information, not a repeat. Only log-source hits are filtered,
  // and only when the log turn is (nearly) just the one MEMORY.md
  // fact — a turn that also carries a new fact survives (0.1.7:
  // the remainder after removing the matched fact must be < 10
  // normalised chars). No semantic judgement, and short overlaps
  // never match.
  const memoryNorms = memoryDedupeTexts(layer1, opts.layer2 ?? []);
  const dedupeMemory = (list: RecallHit[]): RecallHit[] => {
    if (memoryNorms.length === 0) return list;
    return list.filter((hit) => {
      if (hit.entry.source === "archive") return true;
      return !duplicatesMemoryText(
        normalizeForDedupe(hit.entry.text),
        memoryNorms,
      );
    });
  };

  ranked = dedupeMemory(dedupeCrossSource(ranked));

  // 0.2.0 graph expansion: from the surviving direct hits, climb
  // keyword + recall edges one to two hops. Session edges are NOT
  // followed (see graph.ts). A graph hit's content is the seed's
  // content x edge weight (halved on the second hop); its other
  // factors come from the neighbour itself. Dedupe runs on graph
  // hits too, so a neighbour that only repeats MEMORY.md never
  // surfaces through the back door.
  //
  // Edge weights are NOT bumped here. expand() only proposes
  // candidates; the threshold, the token cap and the valve may still
  // drop them. A neighbour that never surfaces must not gain weight
  // for a walk that never happened — the bump runs at the end, only
  // for the hits that actually made the final injection list.
  const traversedCandidates = new Map<string, { from: string; to: string }>();
  if (opts.graph && ranked.length > 0) {
    const graphHits: RecallHit[] = [];
    const seenGraph = new Set<string>(ranked.map((h) => h.entry.id));
    const seeds = ranked.slice(0, 8);
    const expand = (
      seed: RecallHit,
      seedContent: number,
      hop: 1 | 2,
    ): RecallHit[] => {
      const out: RecallHit[] = [];
      const edges = opts.graph?.neighbors(seed.entry.id) ?? [];
      let considered = 0;
      for (const edge of edges) {
        if (!TRAVERSABLE_TYPES.has(edge.type)) continue;
        if (considered >= 10) break;
        considered += 1;
        const otherId = opts.graph?.otherEnd(edge, seed.entry.id) ?? "";
        const other = byId.get(otherId);
        if (!other || seenGraph.has(otherId)) continue;
        const content =
          seedContent * edge.weight * (hop === 2 ? GRAPH_HOP_DECAY : 1);
        const attrs = attrsFor(other, opts.attributes, now);
        const activation = computeActivation({
          content,
          relationship: relationshipFactor(other, opts.sessionId),
          emotion: emotionFactor(queryEmotion, attrs.emotion),
          time: timeFactor(other, attrs, now),
          attention: attentionFactor(other.text, recentTexts),
        });
        seenGraph.add(otherId);
        // Candidate only — the weight bump happens at the end, and
        // only when this neighbour actually surfaces (see below).
        traversedCandidates.set(otherId, {
          from: seed.entry.id,
          to: otherId,
        });
        out.push({
          entry: other,
          score: scoreEntry(other, 0, now),
          matchedTokens: seed.matchedTokens,
          activation,
          viaGraph: true,
          topic: seed.topic,
        });
      }
      return out;
    };
    for (const seed of seeds) {
      const seedContent = contentFactor(seed.matchedTokens.length, tokens.length);
      const hop1 = expand(seed, seedContent, 1);
      graphHits.push(...hop1);
      for (const h1 of hop1) {
        if (h1.activation < ACTIVATION_THRESHOLD) continue;
        const h1Content =
          seedContent *
          (opts.graph?.find(seed.entry.id, h1.entry.id)?.weight ?? 0);
        graphHits.push(...expand(h1, h1Content, 2));
      }
    }
    if (graphHits.length > 0) {
      const combined = [...ranked, ...graphHits].sort(
        (a, b) => b.score - a.score || b.entry.ts - a.entry.ts,
      );
      ranked = dedupeMemory(dedupeCrossSource(combined));
    }
  }

  // 0.2.0 心光 valve, stage 1 (before the token cap): the
  // activation threshold only. A hit below it never deserves cap
  // budget. Stage 2 (per-topic cap + top 5) runs AFTER the cap, so
  // an over-cap entry cannot eat a topic slot (audit m3).
  if (valveOn) {
    ranked = ranked.filter((h) => h.activation >= ACTIVATION_THRESHOLD);
  }

  // Apply the token cap to the hits. Layer 1 is NOT part of the
  // injectable text: the skill already reads it at open, and the same
  // memory must never appear twice in context. (Layer 1 is returned
  // separately in the result for reference — e.g. the stage.)
  // An over-cap entry is SKIPPED, not a stop sign (audit m3): the
  // first hit is bound by the cap like any other, and smaller fitting
  // entries behind a giant one are still collected.
  // 0.2.0: a review-compressed entry injects its one-line summary
  // instead of the full text (details faded, original untouched).
  // 0.3.0: a fragment beats both — it is shorter than the summary
  // and fresher than the verbatim text — but ONLY after it passes
  // its retrieval-time re-check against its sources. A fragment
  // that fails falls back to the verbatim source text (never the
  // compressed summary: the fallback must be the exact words) and
  // is marked suspect, so the next review can fix or drop it.
  // The verification map covers ALL entries, not just the
  // window-scoped ones: a fragment's sources may sit in another
  // window, and that must not make the check fail.
  const allById = new Map(entries.map((e) => [e.id, e]));
  // Fragment ids already injected this recall: two source entries
  // of the same fragment surfacing together must not inject the
  // same fragment text twice — one fragment is one injected item.
  const injectedFragmentIds = new Set<string>();
  let used = 0;
  const hits: RecallHit[] = [];
  for (const hit of ranked) {
    if (hits.length >= limit) break;
    const attrs = opts.attributes?.get(hit.entry.id);
    const summary =
      attrs?.compressed && opts.summaries
        ? opts.summaries.get(hit.entry.id)
        : undefined;
    let displayText = summary ?? hit.entry.text;
    let fragmentId: string | undefined;
    let fragmentTone: string | undefined;
    let fragmentFallback = false;
    const frags = opts.fragments?.forEntry(hit.entry.id) ?? [];
    // A suspect fragment is never injected again — it already
    // failed once, so it goes straight to the verbatim fallback.
    const live = frags.find((f) => !f.suspect);
    if (live && opts.fragments) {
      const check = opts.fragments.verifyStored(live, allById);
      if (check.ok) {
        displayText = live.text;
        fragmentId = live.id;
        fragmentTone = live.tone.label;
      } else {
        fragmentFallback = true;
        displayText = hit.entry.text;
        opts.fragments.markSuspect(
          live.id,
          check.reasons.join("；"),
        );
      }
    } else if (frags.some((f) => f.suspect)) {
      // No live fragment left, only suspect ones: this hit is still
      // a fragment fallback (the verbatim source, never the
      // compressed summary), it is just not re-marked — the
      // fragment was already marked suspect when it first failed.
      fragmentFallback = true;
      displayText = hit.entry.text;
    }
    if (fragmentId !== undefined) {
      if (injectedFragmentIds.has(fragmentId)) continue;
      injectedFragmentIds.add(fragmentId);
    }
    const cost = estimateTokens(displayText) + 8; // + date/time line
    if (used + cost > tokenCap) continue;
    hits.push({
      ...hit,
      // m-1 (review-12): a fragment fallback injects the VERBATIM
      // original, never the compressed summary — but the old condition
      // (fragmentId !== undefined) fell through to `summary` whenever
      // the fragment was gone, so the injected text was the summary
      // while the mark said ·原文. The flag below is fixed the same
      // way: a fallback hit is not a compressed hit.
      displayText:
        fragmentId !== undefined || fragmentFallback ? displayText : summary,
      compressed:
        summary !== undefined && fragmentId === undefined && !fragmentFallback,
      fragmentId,
      fragmentTone,
      fragmentFallback: fragmentFallback || undefined,
    });
    used += cost;
  }

  // 0.2.0 心光 valve, stage 2 (after the token cap): per-topic cap
  // + top 5. The token count is recomputed from the final hits so
  // estimatedTokens matches what is actually injected.
  let finalHits = hits;
  if (valveOn) {
    finalHits = applyValveTop(hits);
    used = 0;
    for (const h of finalHits) {
      used += estimateTokens(h.displayText ?? h.entry.text) + 8;
    }
  }

  // Graph weight bump — only for neighbours that actually surfaced.
  // A candidate that was dropped by the threshold, the token cap or
  // the valve never entered context, so its edge must not gain
  // weight for a walk that never happened.
  if (opts.graph) {
    for (const h of finalHits) {
      if (!h.viaGraph) continue;
      const edge = traversedCandidates.get(h.entry.id);
      if (edge) opts.graph.traverse(edge.from, edge.to, now);
    }
  }

  return {
    hits: finalHits,
    layer1,
    estimatedTokens: used,
    text: formatRecallBlock(finalHits),
  };
}

/** Layer-1 display for memory_search. Uses the skill's own wording
 *  (喜好 / 厌恶); unrecognised layer-1 lines are shown verbatim so
 *  nothing the skill wrote is silently dropped from the display. */
export function formatLayer1(layer1: Layer1State): string {
  const lines: string[] = ["当前状态:"];
  if (layer1.name) lines.push(`名字: ${layer1.name}`);
  if (layer1.stage) lines.push(`阶段: ${layer1.stage}`);
  if (layer1.lastUpdated) lines.push(`最后更新时间: ${layer1.lastUpdated}`);
  if (layer1.likes.length > 0) lines.push(`喜好: ${layer1.likes.join(", ")}`);
  if (layer1.dislikes.length > 0) {
    lines.push(`厌恶: ${layer1.dislikes.join(", ")}`);
  }
  if (layer1.agreements.length > 0) {
    lines.push(`约定: ${layer1.agreements.join("; ")}`);
  }
  if (layer1.heavyNotes.length > 0) {
    lines.push(`重要记忆: ${layer1.heavyNotes.join("; ")}`);
  }
  for (const extra of layer1.extra) lines.push(extra);
  return lines.join("\n");
}

/** Injectable block: raw-log and archive hits ONLY — no layer 1.
 *  Archive rows are labelled [归档], not [user]: the skill format
 *  carries no role metadata for them, and her words must not be
 *  presented as his (audit m8). 0.2.0: a review-compressed hit
 *  injects its one-line summary, marked [·压缩]. 0.3.0: a fragment
 *  hit injects the fragment text, marked [·片段·<tone>] so the
 *  model sees the tone tag; a fragment-fallback hit injects the
 *  verbatim source, marked [·原文] so the model knows the fragment
 *  was distrusted this turn. */
export function formatRecallBlock(hits: RecallHit[]): string {
  if (hits.length === 0) return "";
  const parts: string[] = ["相关记忆:"];
  for (const hit of hits) {
    const label =
      hit.entry.source === "archive" ? "归档" : hit.entry.role;
    const mark = hit.fragmentId
      ? `·片段·${hit.fragmentTone ?? ""}`
      : hit.fragmentFallback
        ? "·原文"
        : hit.compressed
          ? "·压缩"
          : "";
    parts.push(
      `- [${hit.entry.date} ${hit.entry.time} ${label}${mark}] ${hit.displayText ?? hit.entry.text}`,
    );
  }
  return parts.join("\n");
}
