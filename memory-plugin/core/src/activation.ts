// Activation scoring (0.2.0): five factors multiplied.
//   activation = content x relationship x emotion x time x attention
// Any factor near zero pulls the product toward zero, so a memory
// must score on ALL five to surface. The product is the GATE
// (the 心光 valve's threshold); ranking among survivors keeps the
// existing keyword + importance + recency score, so the heavy-first
// behaviour from 0.1.x is unchanged.
//
// Factor semantics (all in [0, 1]):
// - content: share of the query's tokens this entry matches
//   (graph hits: the seed's content x edge weight, halved per hop).
// - relationship: 1.0 when the entry is from the same session as
//   the query, 0.7 otherwise (no session context).
// - emotion: 1.0 when the query's emotion matches the entry's,
//   0.2 on a mismatch, 0.7 when either side has no emotion.
// - time: 0.4.0 item 6 — the 0.7/0.3 blend of the two clarity
//   tracks (detail 0.7 + emotion 0.3), floored at 0.3 — time
//   never zeroes a memory out; an important old memory can still
//   surface. The old form was retrievability (a single decay
//   curve); the blend reads the review-maintained stored tracks,
//   lazily decayed from lastReviewedAt to now (see timeFactor),
//   so a missed review never freezes decay — and a row born
//   fresh for an old entry never props its activation up.
// - attention: 1.0 when the entry shares a content token with the
//   recent turns' user messages, 0.5 otherwise (no recent context).

import {
  detailLambda,
  emotionLambda,
  emotionPolarity,
  emotionRetain,
  tagEmotion,
} from "./attributes.ts";
import { tokenize } from "./tokenize.ts";
import type {
  EmotionTag,
  MemoryAttributes,
  MemoryEntry,
} from "./types.ts";

export const ACTIVATION_THRESHOLD = 0.02;
export const VALVE_TOP = 5;
export const VALVE_PER_TOPIC = 2;
/** Second graph hop halves the inherited content. */
export const GRAPH_HOP_DECAY = 0.5;

/** Common words that must not count as "attention": they appear in
 *  every other line and would make every memory "on topic".
 *  Exported for the starmap badge filter (review-16 N-1): a CJK
 *  trigram overlapping one of these words is a function-word
 *  trigram, not a grouping key.
 *  Review-19: 那天 joins the day words (今天/明天/昨天) — the
 *  same class, left out until the r4-tail residual was fixed; it
 *  also stops counting as an attention token (see contentTokens).
 *  Review-19 r5: 这个 was overwritten by 那天 in that edit and is
 *  restored here — the list is shared with recall's attentionFactor,
 *  so losing a high-frequency demonstrative silently widened the
 *  attention match and reopened the 约定.这个 badge collapse.
 *  Day words first, demonstratives after. */
export const COMMON_TOKENS = new Set([
  "今天",
  "明天",
  "昨天",
  "那天",
  // 0.5.1 (0.4.3 item 6): the remaining relative-time words —
  // they only anchor a sentence in time, so like the day words
  // they are never a topic, never a strong recall token, and
  // never an attention token.
  "上周",
  "这周",
  "下周",
  "去年",
  "今年",
  "上次",
  "这次",
  "这个",
  "那个",
  "什么",
  "怎么",
  "为什么",
  "可以",
  "应该",
  "觉得",
  "知道",
  "时候",
  "东西",
  "事情",
  "一下",
  "有点",
  "真的",
  "很好",
  "不错",
  "好的",
  "现在",
  "然后",
  "就是",
  "还是",
  "没有",
  "不用",
  "不要",
  "这样",
  "那样",
  "这里",
  "那里",
  "我们",
  "你们",
  "他们",
  "自己",
  "一点",
  "一些",
  "可能",
  "如果",
  "因为",
  "所以",
  "但是",
  "不过",
  "而且",
  "或者",
  "已经",
  "正在",
  "刚才",
  "一直",
  "总是",
]);

export interface ActivationFactors {
  content: number;
  relationship: number;
  emotion: number;
  time: number;
  attention: number;
}

/** Pure product. A zero anywhere is a zero everywhere — that is
 *  the point of multiplying instead of adding. */
export function computeActivation(f: ActivationFactors): number {
  const v =
    f.content * f.relationship * f.emotion * f.time * f.attention;
  return Math.min(1, Math.max(0, v));
}

export function contentFactor(
  matchedCount: number,
  queryTokenCount: number,
): number {
  if (queryTokenCount <= 0) return 0;
  return Math.min(1, matchedCount / queryTokenCount);
}

export function relationshipFactor(
  entry: MemoryEntry,
  sessionId?: string,
): number {
  if (sessionId && entry.sessionId === sessionId) return 1;
  return 0.7;
}

export function emotionFactor(
  queryEmotion: EmotionTag | undefined,
  entryEmotion: EmotionTag | undefined,
): number {
  if (!queryEmotion || !entryEmotion) return 0.7;
  if (queryEmotion.type === entryEmotion.type) return 1;
  // 0.3.0 free-form: emotion types are the model's own words, so
  // an exact match is rare — after the exact match, fall back to a
  // coarse polarity match (same polarity 0.7, opposite 0.2). A
  // type with no known polarity on either side, or an explicitly
  // NEUTRAL type (傲娇/别扭 — ambivalent, neither positive nor
  // negative), is 0.5: neither a match nor a mismatch, never a
  // crash or a zero.
  const qPol = emotionPolarity(queryEmotion.type);
  const ePol = emotionPolarity(entryEmotion.type);
  if (qPol === undefined || ePol === undefined) return 0.5;
  if (qPol === "neutral" || ePol === "neutral") return 0.5;
  return qPol === ePol ? 0.7 : 0.2;
}

/** 0.4.0 item 6: the time factor is the 0.7/0.3 blend of the two
 *  clarity tracks — detail 0.7 (min(detailClarity, 1), falling back
 *  to the legacy clarity when the row predates the split) + emotion
 *  0.3 (stored emotionRetain, or the age-computed value when the
 *  row has none yet). Floored at 0.3, capped at 1: time never
 *  zeroes a memory out — that iron rule is unchanged.
 *
 *  The stored tracks are snapshots as of lastReviewedAt (or the
 *  entry's ts when never reviewed), so both are lazily decayed
 *  over the gap to `now` — exactly the math decayClarity applies
 *  at review time, evaluated early. Without this, a row recorded
 *  for an old entry would read as brand new (clarity 1.0) until
 *  the first review ran, and a missed review would freeze decay
 *  entirely; with it, the value review would write is the value
 *  activation already sees, and review never double-counts (it
 *  decays from lastReviewedAt and moves the stamp forward). */
export function timeFactor(
  entry: MemoryEntry,
  attrs: MemoryAttributes,
  now: number,
): number {
  const since = attrs.lastReviewedAt ?? entry.ts;
  const days = Math.max(0, (now - since) / 86_400_000);
  const detail =
    Math.min(1, attrs.detailClarity ?? attrs.clarity) *
    Math.exp(-detailLambda(attrs.significance) * days);
  // 0.4.0 item 6 (coordinator fix): the stored emotionRetain is a
  // snapshot at lastReviewedAt, so it needs the extra decay to now —
  // but the age-based fallback already decays to now, and multiplying
  // it again would square the decay. Only the stored value gets the
  // extra factor.
  const emotion =
    attrs.emotionRetain != null
      ? attrs.emotionRetain *
        Math.exp(-emotionLambda(attrs.significance) * days)
      : emotionRetain(attrs, entry, now);
  return Math.min(1, Math.max(0.3, 0.7 * detail + 0.3 * emotion));
}

/** Content tokens only (length >= 2, not in COMMON_TOKENS).
 *  Shared content token with the recent turns -> on topic. */
export function contentTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const t of tokenize(text)) {
    if (t.length >= 2 && !COMMON_TOKENS.has(t)) out.add(t);
  }
  return out;
}

export function attentionFactor(
  entryText: string,
  recentTexts: string[],
): number {
  if (recentTexts.length === 0) return 0.5;
  const recent = new Set<string>();
  for (const t of recentTexts) {
    for (const tok of contentTokens(t)) recent.add(tok);
  }
  if (recent.size === 0) return 0.5;
  for (const tok of contentTokens(entryText)) {
    if (recent.has(tok)) return 1;
  }
  return 0.5;
}

export function detectQueryEmotion(text: string): EmotionTag | undefined {
  return tagEmotion(text);
}

/** Full five-factor activation for a direct keyword hit. */
export function activationFor(
  entry: MemoryEntry,
  opts: {
    matchedCount: number;
    queryTokenCount: number;
    sessionId?: string;
    queryEmotion?: EmotionTag;
    attrs: MemoryAttributes;
    recentTexts?: string[];
    now: number;
  },
): { activation: number; factors: ActivationFactors } {
  const factors: ActivationFactors = {
    content: contentFactor(opts.matchedCount, opts.queryTokenCount),
    relationship: relationshipFactor(entry, opts.sessionId),
    emotion: emotionFactor(opts.queryEmotion, opts.attrs.emotion),
    time: timeFactor(entry, opts.attrs, opts.now),
    attention: attentionFactor(entry.text, opts.recentTexts ?? []),
  };
  return { activation: computeActivation(factors), factors };
}

/** Topic of a hit: its rarest matched token (lowest document
 *  frequency, ties broken by token string). Two hits sharing a
 *  topic are "the same conversation" for the valve's per-topic
 *  cap. Graph hits inherit their seed's topic. */
export function topicOf(
  matchedTokens: string[],
  docFreq: Map<string, number>,
): string {
  let best = "";
  let bestDf = Infinity;
  for (const t of matchedTokens) {
    const df = docFreq.get(t) ?? 0;
    if (df < bestDf || (df === bestDf && t < best)) {
      best = t;
      bestDf = df;
    }
  }
  return best;
}

export interface ValveHit {
  activation: number;
  topic: string;
}

// NOTE: the old combined applyValve() (threshold + per-topic + top-5
// in one pass) was deleted — no production code called it (recall.ts
// inlines the threshold before the token cap and uses applyValveTop
// after it), only the demo did. The real valve path is tested
// through recallFromEntries / MemoryCore.recall, not through a
// helper nothing ships. See demo "0.2.0 valve" checks.
/** 心光 valve, stage 2 only: per-topic cap + top 5, no threshold.
 *  Runs AFTER the token cap: an over-cap entry must not eat a
 *  topic slot (audit m3 — the giant entry is skipped by the cap and
 *  the smaller fitting ones behind it are still collected; a
 *  pre-cap per-topic cut would drop them instead). The threshold
 *  is stage 1 and runs before the cap (a below-threshold hit never
 *  deserves cap budget). */
export function applyValveTop<T extends ValveHit>(hits: T[]): T[] {
  const out: T[] = [];
  const perTopic = new Map<string, number>();
  for (const h of hits) {
    const n = perTopic.get(h.topic) ?? 0;
    if (n >= VALVE_PER_TOPIC) continue;
    perTopic.set(h.topic, n + 1);
    out.push(h);
    if (out.length >= VALVE_TOP) break;
  }
  return out;
}
