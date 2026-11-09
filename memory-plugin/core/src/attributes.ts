// Per-memory attributes (0.2.0): emotion + intensity, clarity,
// recall count, significance, retrievability (computed, never
// stored). Persisted to attributes.json (atomic write). Old log
// entries with no stored row get computed defaults — nothing is
// ever lost.
//
// Emotion tagging: model-supplied when available (record input /
// memory_remember tool), otherwise a keyword lexicon fallback.
// No network, no model call in the core: the lexicon is
// deterministic and deliberately coarse — it guesses the flavour
// of a line, it never invents facts.
//
// Retrievability (the 小凌 video's R): base x time decay x recall
// boost x emotion strength. Important memories decay slower
// (longer halflife); recalling a memory raises it; a strong
// emotion holds it. Clarity is separate: how crisp the detail
// still is — it decays with time and rises when recalled.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ageDays } from "./dates.ts";
import { atomicWriteText } from "./atomic.ts";
import type {
  EmotionTag,
  Importance,
  MemoryAttributes,
  MemoryEntry,
} from "./types.ts";

export const ATTRIBUTES_FILE = "attributes.json";

/** [keyword, emotion type, base intensity]. First match wins;
 *  order is the priority. Coarse by design. */
const EMOTION_LEXICON: Array<[string, string, number]> = [
  ["哈哈", "开心", 0.7],
  ["开心", "开心", 0.6],
  ["高兴", "开心", 0.6],
  ["难过", "难过", 0.7],
  ["伤心", "难过", 0.7],
  ["哭", "难过", 0.7],
  ["生气", "生气", 0.7],
  ["愤怒", "生气", 0.8],
  ["气死", "生气", 0.8],
  ["紧张", "紧张", 0.6],
  ["害怕", "紧张", 0.7],
  ["怕", "紧张", 0.5],
  ["温暖", "温暖", 0.6],
  ["暖", "温暖", 0.5],
  ["贴心", "温暖", 0.7],
  ["安心", "安心", 0.6],
  ["放心", "安心", 0.6],
  ["踏实", "安心", 0.6],
  ["害羞", "害羞", 0.5],
  ["脸红", "害羞", 0.6],
  ["吃醋", "吃醋", 0.6],
  ["醋", "吃醋", 0.5],
  ["委屈", "委屈", 0.7],
  ["兴奋", "兴奋", 0.7],
  ["激动", "兴奋", 0.7],
  ["想念", "思念", 0.6],
  ["思念", "思念", 0.6],
  ["想你", "思念", 0.6],
  ["累", "疲惫", 0.5],
  ["疲惫", "疲惫", 0.6],
];

/** Coarse sentiment polarity of an emotion type (0.3.0): the
 *  activation factor and the starmap colour fall back to this when
 *  they meet a free-form type they have never seen — "委屈" still
 *  matches "难过" better than "开心", and an unknown word still
 *  gets a sensible star colour instead of nothing. Words in
 *  neither set and not explicitly neutral (a wholly free-form word
 *  the lists never saw) have NO polarity — undefined, not neutral:
 *  callers must treat "unknown" as neither a match nor a mismatch. */
const POSITIVE_EMOTIONS: ReadonlySet<string> = new Set([
  "开心", "兴奋", "温暖", "安心", "害羞", "思念", "宠溺", "期待",
  "窝心", "羞涩", "撒娇", "依赖", "眷恋", "骄傲", "得意", "心动",
]);
const NEGATIVE_EMOTIONS: ReadonlySet<string> = new Set([
  "难过", "委屈", "生气", "紧张", "疲惫", "吃醋", "赌气", "无奈",
  "忐忑", "失落", "不舍", "愧疚", "自责",
]);

const NEUTRAL_EMOTIONS: ReadonlySet<string> = new Set(["傲娇", "别扭"]);

export function emotionPolarity(
  type: string | undefined,
): "positive" | "negative" | "neutral" | undefined {
  if (!type) return undefined;
  if (POSITIVE_EMOTIONS.has(type)) return "positive";
  if (NEGATIVE_EMOTIONS.has(type)) return "negative";
  if (NEUTRAL_EMOTIONS.has(type)) return "neutral";
  return undefined;
}

const INTENSIFIERS = ["很", "特别", "超级", "非常", "太", "真的", "好"];

/** Single-char lexicon entries that also sit inside common compounds
 *  with no emotion at all: 怕 in 恐怕, 累 in 积累, 醋 in 醋溜土豆,
 *  暖 in 暖气. A single char only counts when it still appears after
 *  those compounds are stripped out — so "别怕，我在" still tags
 *  紧张, but "恐怕要下雨了" does not. */
const SINGLE_CHAR_EXCLUSIONS: Record<string, string[]> = {
  "怕": ["恐怕"],
  "累": ["积累"],
  "醋": ["醋溜"],
  "暖": ["暖气"],
};

/** Guess a line's emotion from keywords. Undefined when nothing
 *  matches — "no emotion detected" is a real answer, not a failure. */
export function tagEmotion(text: string): EmotionTag | undefined {
  if (typeof text !== "string") return undefined;
  for (const [kw, type, intensity] of EMOTION_LEXICON) {
    if (text.includes(kw)) {
      if (kw.length === 1) {
        let stripped = text;
        for (const compound of SINGLE_CHAR_EXCLUSIONS[kw] ?? []) {
          stripped = stripped.split(compound).join("");
        }
        if (!stripped.includes(kw)) continue;
      }
      let level = intensity;
      if (INTENSIFIERS.some((w) => text.includes(w))) {
        level = Math.min(1, level + 0.2);
      }
      return { type, intensity: level };
    }
  }
  return undefined;
}

/** 意义强度: heavy 0.9, light 0.4. No keyword list: what counts as
 *  important is the model's judgment (record-time importance param,
 *  recall-count promotion in review, and the daily model review) —
 *  not a fixed word list. */
export function initialSignificance(entry: {
  importance: Importance;
  text: string;
}): number {
  if (entry.importance === "heavy") return 0.9;
  return 0.4;
}

/** 0.4.0 item 6 (分速率衰减): three decay rates, one per track.
 *  The numbers are TRUE half-lives (unlike the old retrievability
 *  code, whose "halflife" was an e-folding time — see the note on
 *  retrievability below): lambda = ln2 / halfLifeDays, so after
 *  exactly one half-life a track is at 0.5.
 *  - detail: half-life 14 + 30*S days — details fade fast
 *    (S=0.4 -> 26d, S=0.9 -> 41d).
 *  - emotion: half-life 60 + 120*S days — feelings linger
 *    (S=0.4 -> 108d, S=0.9 -> 168d), always slower than detail
 *    at the same significance.
 *  - fact: 0 — stable facts / likes never decay (Layer1State
 *    likes/dislikes/agreements are not decayed at all, by design).
 *  clarityLambda() below is kept as an alias of detailLambda so
 *  existing callers keep working. */
export function detailLambda(significance: number): number {
  return Math.LN2 / (14 + 30 * significance);
}

export function emotionLambda(significance: number): number {
  return Math.LN2 / (60 + 120 * significance);
}

export function factLambda(): number {
  return 0;
}

/** Detail decay rate per day: important memories fade slower.
 *  Kept as an alias of detailLambda (0.4.0 item 6 split the old
 *  step function 0.01/0.03 into the three rates above); the old
 *  name still resolves so existing callers do not break. */
export function clarityLambda(significance: number): number {
  return detailLambda(significance);
}

/** Emotion retention after `ageDays(entry.ts, now)` at the emotion
 *  rate: exp(-emotionLambda * age). Pure function of age (like the
 *  time-decay part of retrievability) — the stored `emotionRetain`
 *  field is review's persisted snapshot of the same quantity, and
 *  this is the fallback when a row has none yet. No floor here;
 *  the 0.3 floor lives in timeFactor, the 0.05 floor in
 *  decayClarity. */
export function emotionRetain(
  attrs: MemoryAttributes,
  entry: MemoryEntry,
  now: number,
): number {
  return Math.exp(-emotionLambda(attrs.significance) * ageDays(entry.ts, now));
}

/** Default clarity for an entry with no stored row: fresh is 1.0,
 *  old fades by age. Floor 0.05 — details fade, never erase. */
export function defaultClarity(
  entry: MemoryEntry,
  now: number,
): number {
  const lambda = entry.importance === "heavy" ? 0.01 : 0.03;
  return Math.max(0.05, Math.exp(-lambda * ageDays(entry.ts, now)));
}

/** Retrievability R = time decay x recall boost x emotion
 *  strength. 0.4.0 item 6: the time decay now runs at the DETAIL
 *  rate (detailLambda) — the old single curve (e-folding time
 *  30 + 60*S days, i.e. a true half-life of (30+60S)*ln2) is
 *  replaced by the detail half-life 14 + 30*S days, so R fades
 *  as fast as the details do; the emotion track lives separately
 *  in emotionRetain() / timeFactor's 0.3 blend. Recall boost is
 *  1 + 0.15 per recall, capped at 10 recalls (max 2.5x). Emotion
 *  holds a memory: strong emotion up to 1.0x, none detected 0.7x. */
export function retrievability(
  attrs: MemoryAttributes,
  entry: MemoryEntry,
  now: number,
): number {
  const timeDecay = Math.exp(
    -detailLambda(attrs.significance) * ageDays(entry.ts, now),
  );
  const recallBoost = 1 + 0.15 * Math.min(attrs.recallCount, 10);
  const emotionFactor = attrs.emotion
    ? 0.4 + 0.6 * attrs.emotion.intensity
    : 0.7;
  return Math.min(2.5, timeDecay * recallBoost * emotionFactor);
}

/** One-line extractive summary for review compression: first
 *  sentence, truncated at 40 chars. The original log entry is
 *  never touched — this is only the faded form recall injects. */
export function compressSummary(text: string): string {
  const first = (text.split(/[。！？；\n]/)[0] ?? "").trim();
  const base = first.length > 0 ? first : text.trim();
  return base.length > 40 ? `${base.slice(0, 40)}…` : base;
}

interface PersistedAttributes {
  version: 1;
  entries: Record<string, MemoryAttributes>;
}

/** Clamp a finite number into [lo, hi]; non-finite input falls back
 *  to lo (hand-edited files must never inject NaN/Infinity). */
function clampFinite(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return Math.min(hi, Math.max(lo, v));
}

export class AttributeStore {
  private map = new Map<string, MemoryAttributes>();
  private readonly file: string;

  constructor(dataDir: string) {
    this.file = join(dataDir, ATTRIBUTES_FILE);
    this.load();
  }

  get size(): number {
    return this.map.size;
  }

  get(id: string): MemoryAttributes | undefined {
    return this.map.get(id);
  }

  all(): Map<string, MemoryAttributes> {
    return this.map;
  }

  private load(): void {
    try {
      if (!existsSync(this.file)) return;
      const data = JSON.parse(
        readFileSync(this.file, "utf8"),
      ) as PersistedAttributes;
      if (data.version !== 1 || typeof data.entries !== "object") return;
      for (const [id, attrs] of Object.entries(data.entries)) {
        // Hand-edited/corrupt rows are sanitised, not trusted: the
        // three required numbers must be finite (else the row is
        // dropped), and every range is clamped into [0, 1] — a
        // significance of 999 must never reach the starmap, and a
        // clarity of -1 must never reach the decay math.
        if (
          !attrs ||
          !Number.isFinite(attrs.clarity) ||
          !Number.isFinite(attrs.recallCount) ||
          !Number.isFinite(attrs.significance)
        ) {
          continue;
        }
        const clean: MemoryAttributes = {
          clarity: clampFinite(attrs.clarity, 0, 1),
          recallCount: Math.max(0, Math.floor(attrs.recallCount)),
          significance: clampFinite(attrs.significance, 0, 1),
        };
        if (
          attrs.emotion &&
          typeof attrs.emotion === "object" &&
          typeof attrs.emotion.type === "string" &&
          Number.isFinite(attrs.emotion.intensity)
        ) {
          clean.emotion = {
            type: attrs.emotion.type,
            intensity: clampFinite(attrs.emotion.intensity, 0, 1),
          };
        }
        if (typeof attrs.compressed === "boolean") {
          clean.compressed = attrs.compressed;
        }
        // 0.3.0 model review: a model-marked memory is never
        // compressed (review skips it). A lost flag only loses the
        // extra guard — significance 0.9 already blocks compression.
        if (typeof attrs.modelMarked === "boolean") {
          clean.modelMarked = attrs.modelMarked;
        }
        if (Number.isFinite(attrs.compressedAt)) {
          clean.compressedAt = attrs.compressedAt;
        }
        if (Number.isFinite(attrs.lastRecalledAt)) {
          clean.lastRecalledAt = attrs.lastRecalledAt;
        }
        if (Number.isFinite(attrs.lastReviewedAt)) {
          clean.lastReviewedAt = attrs.lastReviewedAt;
        }
        // 0.4.0 item 1: validity window. A non-finite value is
        // dropped (never trusted); an explicit null validTo means
        // "still valid" and is kept. Old rows without these fields
        // load unchanged — absent validTo = never invalidated.
        if (Number.isFinite(attrs.validFrom)) {
          clean.validFrom = attrs.validFrom;
        }
        if (attrs.validTo === null) {
          clean.validTo = null;
        } else if (Number.isFinite(attrs.validTo)) {
          clean.validTo = attrs.validTo;
        }
        if (typeof attrs.needsInvalidationCheck === "boolean") {
          clean.needsInvalidationCheck = attrs.needsInvalidationCheck;
        }
        // 0.4.0 item 6: two clarity tracks. Old rows have neither:
        // detail defaults to the stored clarity (the old single
        // clarity IS the detail track), emotion defaults to 1.0
        // (fresh feeling). Corrupt values are dropped to the same
        // defaults, out-of-range numbers are clamped — never a
        // crash, never a NaN reaching the decay math.
        if (
          typeof attrs.detailClarity === "number" &&
          Number.isFinite(attrs.detailClarity)
        ) {
          clean.detailClarity = clampFinite(attrs.detailClarity, 0, 1);
        } else {
          clean.detailClarity = clean.clarity;
        }
        if (
          typeof attrs.emotionRetain === "number" &&
          Number.isFinite(attrs.emotionRetain)
        ) {
          clean.emotionRetain = clampFinite(attrs.emotionRetain, 0, 1);
        } else {
          clean.emotionRetain = 1.0;
        }
        this.map.set(id, clean);
      }
    } catch {
      this.map.clear();
    }
  }

  /** Re-read attributes.json from disk (called under the write
   *  lock when another writer may have moved it). In-memory recall
   *  bumps not yet flushed are lost on reload — counters only,
   *  the log entries they describe are untouched. */
  reload(): void {
    this.map.clear();
    this.load();
  }

  save(): void {
    const entries: Record<string, MemoryAttributes> = {};
    for (const [id, attrs] of this.map) entries[id] = attrs;
    atomicWriteText(
      this.file,
      JSON.stringify({ version: 1, entries } satisfies PersistedAttributes),
    );
  }

  /** Get or create (in-memory only — the caller persists). The
   *  model-supplied emotion wins; otherwise the lexicon guesses. */
  ensure(
    entry: MemoryEntry,
    emotion?: EmotionTag,
    now: number = Date.now(),
  ): MemoryAttributes {
    const existing = this.map.get(entry.id);
    if (existing) {
      if (emotion && !existing.emotion) existing.emotion = emotion;
      return existing;
    }
    const clarity = defaultClarity(entry, now);
    const significance = initialSignificance(entry);
    const attrs: MemoryAttributes = {
      emotion: emotion ?? tagEmotion(entry.text),
      clarity,
      // 0.4.0 item 6: a new row starts with detail = clarity and
      // emotion aged the same way — fresh (age 0) is 1.0, an old
      // entry recorded late starts at the age-computed value,
      // exactly like defaultClarity does for the detail track.
      // ("默认 1.0" is the fresh value, not a free pass for old
      // rows: a 1.0 stamped on a 64-day-old entry would prop its
      // time factor up until the first review runs.)
      detailClarity: clarity,
      emotionRetain: Math.exp(
        -emotionLambda(significance) * ageDays(entry.ts, now),
      ),
      recallCount: 0,
      significance,
      // 0.4.0 item 1: the validity window opens at the entry's own
      // time. (Old rows loaded from disk keep whatever they had —
      // absent validFrom is read as "since the entry's ts".)
      validFrom: entry.ts,
      // defaultClarity already aged this row by entry.ts -> now, so
      // the review clock starts HERE. Without this, decayClarity()
      // sees lastReviewedAt empty and decays again from entry.ts —
      // a 30-day-old light memory would land at exp(-2λ·age)
      // instead of exp(-λ·age) on its first review.
      lastReviewedAt: now,
    };
    this.map.set(entry.id, attrs);
    return attrs;
  }

  /** 0.4.0 item 1: mark entries invalid from `at` — write ONLY
   *  validTo, nothing else (the log text and every other field are
   *  untouched). Unknown ids are reported, never created: without
   *  the entry there is no ts to default validFrom from. In-memory
   *  only — the caller persists (save()). 0.4.4: invalidating also
   *  clears needsInvalidationCheck — the check is resolved by the
   *  invalidation itself, and a dead entry must not stay counted
   *  as "awaiting review" in memory_status. */
  invalidate(
    ids: string[],
    at: number,
  ): { invalidated: string[]; unknown: string[] } {
    const invalidated: string[] = [];
    const unknown: string[] = [];
    for (const id of ids) {
      const attrs = this.map.get(id);
      if (!attrs) {
        unknown.push(id);
        continue;
      }
      attrs.validTo = at;
      attrs.needsInvalidationCheck = false;
      invalidated.push(id);
    }
    return { invalidated, unknown };
  }

  /** A recall surfaced this entry: count it, refresh it, sharpen it.
   *  0.4.0 item 6: the detail track sharpens alongside clarity (the
   *  two are kept in sync); the emotion track is untouched — recalling
   *  the words does not refresh the feeling. */
  bumpOnRecall(id: string, now: number): void {
    const attrs = this.map.get(id);
    if (!attrs) return;
    attrs.recallCount += 1;
    attrs.lastRecalledAt = now;
    const prevDetail = attrs.detailClarity ?? attrs.clarity;
    attrs.clarity = Math.min(1, attrs.clarity + 0.15);
    attrs.detailClarity = Math.min(1, prevDetail + 0.15);
  }

  /** Fade clarity since this entry was last reviewed (or since it
   *  was recorded). 0.4.0 item 6: fades BOTH tracks — detail at
   *  detailLambda, emotion at the slower emotionLambda — and
   *  returns true when either moved. Both floor at 0.05 (details
   *  fade, feelings fade, neither erases). Note for old rows whose
   *  emotionRetain materialised as 1.0 on load: when
   *  lastReviewedAt is absent the decay runs over the full age
   *  since entry.ts, so the first review lands on the age-correct
   *  value in one step instead of starting a fresh 1.0 clock. */
  decayClarity(entry: MemoryEntry, now: number): boolean {
    const attrs = this.map.get(entry.id);
    if (!attrs) return false;
    const since = attrs.lastReviewedAt ?? entry.ts;
    const days = Math.max(0, (now - since) / 86_400_000);
    if (days <= 0) {
      attrs.lastReviewedAt = now;
      return false;
    }
    const detail = attrs.detailClarity ?? attrs.clarity;
    const nextDetail = Math.max(
      0.05,
      detail * Math.exp(-detailLambda(attrs.significance) * days),
    );
    const emotion = attrs.emotionRetain ?? 1.0;
    const nextEmotion = Math.max(
      0.05,
      emotion * Math.exp(-emotionLambda(attrs.significance) * days),
    );
    const changed =
      nextDetail !== detail ||
      nextDetail !== attrs.clarity ||
      nextEmotion !== emotion;
    attrs.clarity = nextDetail;
    attrs.detailClarity = nextDetail;
    attrs.emotionRetain = nextEmotion;
    attrs.lastReviewedAt = now;
    return changed;
  }

  /** Repeatedly recalled memories are important: raise their
   *  significance. Returns true when raised. */
  promote(entry: MemoryEntry): boolean {
    const attrs = this.map.get(entry.id);
    if (!attrs) return false;
    if (attrs.recallCount >= 5 && attrs.significance < 0.9) {
      attrs.significance = 0.9;
      return true;
    }
    if (attrs.recallCount >= 3 && attrs.significance < 0.8) {
      attrs.significance = 0.8;
      return true;
    }
    return false;
  }
}
