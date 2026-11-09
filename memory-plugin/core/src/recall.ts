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
  emotionRetain,
  initialSignificance,
  tagEmotion,
  type AttributeStore,
} from "./attributes.ts";
import { formatBeliefLine, type BeliefStore } from "./beliefs.ts";
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

/** 0.4.0 item 1: true when this validity window has closed — the
 *  memory/edge stopped being true at or before `now` (null or
 *  absent = still valid). */
export function isExpired(validTo: number | null | undefined, now: number): boolean {
  return validTo != null && validTo <= now;
}

/** 0.4.0 item 1: mark entries invalid from `at` — write ONLY
 *  validTo, nothing else (the log text and every other field are
 *  untouched), and persist attributes.json. Ids with no stored
 *  attribute row are reported as unknown, never created.
 *
 *  NOTE on the signature: the spec's `invalidateEntries(ids, at)`
 *  has nowhere to persist to — recall.ts holds no store instance
 *  (it only receives one through RecallOptions), so the store is a
 *  third parameter. MemoryCore.invalidateEntries() is the
 *  lock-guarded wrapper the DSH tool calls (it also stamps the
 *  incident graph edges). */
export function invalidateEntries(
  ids: string[],
  at: number,
  store: AttributeStore,
): { invalidated: string[]; unknown: string[] } {
  const result = store.invalidate(ids, at);
  store.save();
  return result;
}

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
  /** 0.4.0 item 2: the belief store. When present, the recall
   *  block gains one compact belief line at the end (see
   *  formatRecallBlock) — it takes no token-cap budget, like the
   *  profile block, and no line is added when there are no
   *  beliefs. Absent = old caller: no belief line. */
  beliefs?: BeliefStore;
}

/** Attributes for an entry: the stored row when available, else
 *  computed defaults (never persisted here). */
function attrsFor(
  entry: MemoryEntry,
  store: AttributeStore | undefined,
  now: number,
): MemoryAttributes {
  if (store) return store.ensure(entry, undefined, now);
  // 0.4.0 item 6: no store — the defaults are age-correct, not
  // fresh: detail starts at the aged defaultClarity, emotion at
  // the age-computed retention (a 90-day-old entry recalled
  // without a store must not pretend its feeling is brand new).
  const significance = initialSignificance(entry);
  const clarity = defaultClarity(entry, now);
  const base: MemoryAttributes = {
    emotion: tagEmotion(entry.text),
    clarity,
    recallCount: 0,
    significance,
  };
  return {
    ...base,
    detailClarity: clarity,
    emotionRetain: emotionRetain(base, entry, now),
    // This default is a snapshot as of `now` (both tracks were
    // just aged to it above), so stamp it — otherwise timeFactor
    // would see no lastReviewedAt, assume the snapshot is as of
    // entry.ts, and decay the already-aged values a second time.
    lastReviewedAt: now,
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
  // 0.4.0 item 1: expired memories never enter the candidate set —
  // they are skipped before scoring, not deleted: the log text
  // stays on disk and stays searchable by hand. Only a stored row
  // can expire an entry (no row = old data = never invalidated).
  // Archive hits have no attribute row and are never expired here.
  const live = scoped.filter(
    (e) => !isExpired(opts.attributes?.get(e.id)?.validTo, now),
  );
  const byId = new Map(live.map((e) => [e.id, e]));

  // Keyword hits. A candidateIds set (from the keyword index) bounds
  // the log scan; archive rows are exempt (they are not in the index).
  const matched = new Map<string, string[]>(); // entry id -> matched tokens
  if (tokens.length > 0) {
    for (const e of live) {
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
    for (const e of live) {
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
          // 0.4.0 item 5: a direct hit walked no edge, so its
          // spotlight sort factor is 1.
          edgeWeight: 1,
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
        // 0.4.0 item 1: an expired edge is never walked — the link
        // stays in graph.json, only skipped.
        if (isExpired(edge.validTo, now)) continue;
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
          // 0.4.0 item 5: the edge this hit arrived through — the
          // spotlight sort key (activation × edge weight) needs it,
          // and activation alone already folded this weight into
          // its content factor once. Read before the traverse bump
          // at the end of recall (the bump runs after selection).
          edgeWeight: edge.weight,
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

  // 0.4.0 item 5 (心光选择): pick the spotlight candidates from
  // the FINAL hits — the ones actually injected, after the token
  // cap and the valve. The score only ranks candidates (activation
  // × edge weight, one per topic, top 3); the single ★ is the
  // in-session model's call, made from the ☆ prompt line in
  // formatRecallBlock below — no extra model call, no new tool.
  // Runs on the final list whether the valve is on or off (an
  // explicit search still gets at most 3 candidates).
  if (finalHits.length > 0) {
    selectSpotlightCandidates(finalHits);
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
    // 0.4.0 item 4: the standing profile block rides along with
    // every recall, computed from layer 1 only — it never touches
    // the keyword match, the valve or the token cap, so it cannot
    // crowd out a hit (see the item-4 tests in test/demo.ts).
    profileText: formatProfileBlock(layer1),
    estimatedTokens: used,
    // 0.4.0 item 2: the belief line rides at the end of the block
    // — one compact line, no token-cap budget (it is ~20 tokens
    // and never the bulk of the 1500 cap), and no line at all when
    // there are no beliefs (an empty belief layer never pollutes
    // recall). Computed from the store when one was passed.
    text: formatRecallBlock(
      finalHits,
      opts.beliefs ? formatBeliefLine(opts.beliefs.all()) : undefined,
    ),
  };
}

/** 0.4.0 item 5 (心光选择 + 传播激活, 小凌识海心光 + HippoRAG
 *  PPR, 2026-11-09 改版): pick the spotlight candidates from a
 *  recall's final hits. The score ONLY ranks candidates — it never
 *  picks the single ★: sort by activation × edge weight (a direct
 *  hit's edge weight is 1; a graph hit's is the edge it arrived
 *  through), keep at most one per topic (topicOf, same topic the
 *  valve uses), take the top 3, and mark them
 *  `spotlightCandidate = true` in place (the same objects the
 *  caller injects, so formatRecallBlock sees the flags). Ties
 *  break by score, then recency. Returns the candidates (at most
 *  3, in rank order); non-candidates are left unmarked. Pure
 *  arithmetic, no model call — the choice itself happens in the
 *  session that is already replying, via the ☆ prompt line. */
export function selectSpotlightCandidates(hits: RecallHit[]): RecallHit[] {
  const ranked = [...hits].sort(
    (a, b) =>
      b.activation * (b.edgeWeight ?? 1) -
        a.activation * (a.edgeWeight ?? 1) ||
      b.score - a.score ||
      b.entry.ts - a.entry.ts,
  );
  const seenTopics = new Set<string>();
  const out: RecallHit[] = [];
  for (const h of ranked) {
    if (out.length >= 3) break;
    if (seenTopics.has(h.topic)) continue;
    seenTopics.add(h.topic);
    h.spotlightCandidate = true;
    out.push(h);
  }
  return out;
}

/** 0.4.0 item 4 (画像常驻块, Memobase): the standing profile block
 *  — who she is, what stage the relationship is at, one standing
 *  like and one standing agreement. At most 5 lines, one field per
 *  line; a field with no data is skipped, never left as a blank
 *  line. Pure assembly, no judgement: `profile.*` wins over the
 *  layer-1 keys of the same meaning (name/stage), likes/agreements
 *  come from the layer-1 lists (the profile has no fields for
 *  them). Null / empty layer 1 (no profile, no name, no stage, no
 *  likes, no agreements) returns "" — never null, never throws.
 *  The block is computed fresh from the layer-1 object handed in,
 *  so changing the profile needs no index rebuild: the next recall
 *  simply reads the new layer 1. */
export function formatProfileBlock(layer1: Layer1State | null): string {
  if (!layer1) return "";
  const profile = layer1.profile ?? {};
  const lines: string[] = [];
  const name = profile.name ?? layer1.name;
  if (name) lines.push(`她：${name}`);
  const stage = profile.stage ?? layer1.stage;
  if (stage) lines.push(`阶段：${stage}`);
  if (profile.relationshipStage) {
    lines.push(`关系：${profile.relationshipStage}`);
  }
  if (layer1.likes.length > 0) lines.push(`喜欢：${layer1.likes[0]}`);
  if (layer1.agreements.length > 0) {
    lines.push(`约定：${layer1.agreements[0]}`);
  }
  return lines.slice(0, 5).join("\n");
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
 *  was distrusted this turn. 0.4.0 item 5: a spotlight candidate
 *  line is marked ☆, and when at least one candidate exists a
 *  single prompt line follows the list, asking the model already
 *  replying in this session to pick the one most worth noting and
 *  mention it in its own words — no tool call, no separate
 *  explanation, no extra model round. No candidates means no ☆
 *  marks and no prompt line (and no hits still means ""). 0.4.0
 *  item 2: an optional belief line (one compact line, e.g.
 *  `关系：信任 0.7（证据 6 条）· 亲近 0.4`) is appended at the very
 *  end, after the spotlight prompt line. Empty / absent means no
 *  line — an empty belief layer never pollutes the block. */
export function formatRecallBlock(hits: RecallHit[], beliefLine?: string): string {
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
      `- ${hit.spotlightCandidate ? "☆ " : ""}[${hit.entry.date} ${hit.entry.time} ${label}${mark}] ${hit.displayText ?? hit.entry.text}`,
    );
  }
  if (hits.some((h) => h.spotlightCandidate)) {
    parts.push(
      "心光：上面标 ☆ 的是这次最值得注意的候选（最多 3 条），请挑其中最值得注意的一条，在回复里用自己的话自然点出来，不用调工具、不用单独解释。",
    );
  }
  if (beliefLine) {
    parts.push(beliefLine);
  }
  return parts.join("\n");
}
