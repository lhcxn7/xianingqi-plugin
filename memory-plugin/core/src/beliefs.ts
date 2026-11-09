// Beliefs (0.4.0 item 2): an evidence-backed belief layer + three
// relationship dimensions (safety / trust / closeness).
//
// The plugin used to have only per-memory attributes — no "what does
// she currently believe about the relationship, and why" layer. A
// belief is one sentence ("他难过时会来找我") in one dimension, held
// with verbatim evidence: every supporting quote must appear word
// for word in its log entry, checked by CODE at write time (the
// memory_fragment verification pattern — see fragments.ts). A quote
// that is not verbatim is rejected and nothing is stored.
//
// De-mechanisation (2026-11-09): the old fixed steps (+0.05 / -0.1)
// are gone. The MODEL decides how much a piece of evidence moves a
// belief, by how strong the evidence is; the code only clamps the
// range — a single move is at most ±0.2, strength stays in 0..1 —
// and enforces the no-double-charge rule: one contradicting entry
// deducts once, however often it is re-submitted (tracked in
// `contradicting`). Decay is pure arithmetic and stays in code:
// strength × 0.99 per silent day, never to 0, never deleting the
// belief. Judgement belongs to the model; arithmetic belongs here.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteText } from "./atomic.ts";
import type {
  Belief,
  BeliefDimension,
  BeliefDimensionSummary,
  MemoryEntry,
} from "./types.ts";

export const BELIEFS_FILE = "beliefs.json";
/** One move is at most ±0.2 — the model supplies the delta, the
 *  code clamps it. */
export const BELIEF_MAX_DELTA = 0.2;
/** Daily decay: strength × 0.99 per day without an update. */
export const BELIEF_DECAY_PER_DAY = 0.99;
/** A fresh belief starts here: half-convinced, highly uncertain. */
export const BELIEF_INITIAL_STRENGTH = 0.5;
export const BELIEF_INITIAL_UNCERTAINTY = 0.8;
/** A verbatim quote must be at least this long to count as evidence
 *  — a 1–2 char match ("他", "了") proves nothing. */
export const BELIEF_MIN_QUOTE_CHARS = 2;

export const BELIEF_DIMENSIONS: readonly BeliefDimension[] = [
  "safety",
  "trust",
  "closeness",
];

/** Chinese labels for the three dimensions, for the recall line. */
export const BELIEF_DIMENSION_CN: Record<BeliefDimension, string> = {
  safety: "安全",
  trust: "信任",
  closeness: "亲近",
};

const DAY_MS = 24 * 60 * 60 * 1000;

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

/** What the model passes to create a belief (memory_belief create).
 *  The first evidence item is optional at the store level — the
 *  tool requires it, so a belief never enters the store quoteless
 *  through the tool — but a bare belief (statement only) is a valid
 *  store state for tests and for later evidence. */
export interface BeliefCreateInput {
  dimension: BeliefDimension;
  statement: string;
  /** Initial strength 0..1, default 0.5. The model supplies it;
   *  the code only clamps it. */
  strength?: number;
  /** Initial uncertainty 0..1, default 0.8. */
  uncertainty?: number;
  entryId?: string;
  quote?: string;
}

export interface BeliefCreateResult {
  ok: boolean;
  belief?: Belief;
  reasons: string[];
}

export interface BeliefAdjustResult {
  ok: boolean;
  belief?: Belief;
  /** True when a contradict was ignored because this entry was
   *  already charged — no deduction, no write. */
  duplicate?: boolean;
  reasons: string[];
}

/** Verbatim check for one evidence item (the fragments.ts
 *  verifyFragment() idea, reduced to the one thing a belief needs):
 *  the entry must exist, and the quote must appear word for word in
 *  its text. A paraphrase, a wrong entry id, or a too-short quote
 *  fails — the caller gets the reason so the model can fix it. */
export function verifyBeliefEvidence(
  entryId: string,
  quote: string,
  entriesById: Map<string, MemoryEntry>,
): { ok: boolean; reason?: string } {
  if (typeof entryId !== "string" || entryId.length === 0) {
    return { ok: false, reason: "证据没有注明它是从哪条原文来的（entryId 为空）。" };
  }
  const entry = entriesById.get(entryId);
  if (!entry) {
    return { ok: false, reason: `证据的来源条目不存在：${entryId}。` };
  }
  if (typeof quote !== "string" || quote.trim().length < BELIEF_MIN_QUOTE_CHARS) {
    return { ok: false, reason: "引用太短：证据必须是一句从来源原文逐字抄来的话。" };
  }
  if (!entry.text.includes(quote)) {
    return {
      ok: false,
      reason: `引用不在来源原文里：${JSON.stringify(quote)}——引用必须是逐字抄的，不能改写。`,
    };
  }
  return { ok: true };
}

/** The three dimensions' current values, from the stored beliefs.
 *  A dimension's strength is the proofCount-weighted mean of its
 *  beliefs (a belief with no evidence yet counts weight 1, so it
 *  still pulls the mean); uncertainty is the plain mean; proofCount
 *  is the sum. A dimension with no beliefs reads strength 0,
 *  uncertainty 1 (unknown), proofCount 0 — never null. */
export function summarizeBeliefs(
  beliefs: Belief[],
): Record<BeliefDimension, BeliefDimensionSummary> {
  const out = {} as Record<BeliefDimension, BeliefDimensionSummary>;
  for (const dim of BELIEF_DIMENSIONS) {
    const rows = beliefs.filter((b) => b.dimension === dim);
    if (rows.length === 0) {
      out[dim] = { strength: 0, uncertainty: 1, proofCount: 0, beliefs: 0 };
      continue;
    }
    let weightSum = 0;
    let strengthSum = 0;
    let uncertaintySum = 0;
    let proof = 0;
    for (const b of rows) {
      const w = Math.max(b.proofCount, 1);
      weightSum += w;
      strengthSum += b.strength * w;
      uncertaintySum += b.uncertainty;
      proof += b.proofCount;
    }
    out[dim] = {
      strength: strengthSum / weightSum,
      uncertainty: uncertaintySum / rows.length,
      proofCount: proof,
      beliefs: rows.length,
    };
  }
  return out;
}

/** The compact recall line (at most one line, appended to the end
 *  of formatRecallBlock): `关系：信任 0.7（证据 6 条）· 亲近 0.4`.
 *  Only dimensions that actually have beliefs are shown; a
 *  dimension with no evidence yet shows no count. Empty beliefs
 *  return "" — no line is injected, so an empty belief layer never
 *  pollutes recall. */
export function formatBeliefLine(beliefs: Belief[]): string {
  if (beliefs.length === 0) return "";
  const summary = summarizeBeliefs(beliefs);
  const parts: string[] = [];
  for (const dim of BELIEF_DIMENSIONS) {
    const s = summary[dim];
    if (s.beliefs === 0) continue;
    parts.push(
      `${BELIEF_DIMENSION_CN[dim]} ${s.strength.toFixed(1)}` +
        (s.proofCount > 0 ? `（证据 ${s.proofCount} 条）` : ""),
    );
  }
  if (parts.length === 0) return "";
  return `关系：${parts.join(" · ")}`;
}

interface PersistedBeliefs {
  version: 1;
  beliefs: Belief[];
}

/** beliefs.json store: load + sanitise + atomic save. Hand-edited
 *  rows are sanitised, not trusted: a belief with no id, an unknown
 *  dimension, an empty statement or a non-numeric strength is
 *  dropped; every range is clamped and proofCount is recomputed
 *  from the evidence (proofCount = evidence.length, always), so a
 *  corrupt file must never crash recall or the status tool. */
export class BeliefStore {
  private list: Belief[] = [];
  private readonly file: string;

  constructor(dataDir: string) {
    this.file = join(dataDir, BELIEFS_FILE);
    this.load();
  }

  get size(): number {
    return this.list.length;
  }

  all(): Belief[] {
    return [...this.list];
  }

  get(id: string): Belief | undefined {
    return this.list.find((b) => b.id === id);
  }

  private load(): void {
    try {
      if (!existsSync(this.file)) return;
      const data = JSON.parse(readFileSync(this.file, "utf8")) as PersistedBeliefs;
      if (data.version !== 1 || !Array.isArray(data.beliefs)) return;
      const clean: Belief[] = [];
      for (const b of data.beliefs) {
        if (
          !b ||
          typeof b.id !== "string" ||
          b.id.length === 0 ||
          !BELIEF_DIMENSIONS.includes(b.dimension) ||
          typeof b.statement !== "string" ||
          b.statement.trim().length === 0 ||
          !Number.isFinite(b.strength) ||
          !Number.isFinite(b.uncertainty) ||
          !Array.isArray(b.evidence) ||
          !b.evidence.every(
            (e) =>
              e &&
              typeof e.entryId === "string" &&
              typeof e.quote === "string",
          )
        ) {
          continue;
        }
        clean.push({
          id: b.id,
          dimension: b.dimension,
          statement: b.statement,
          strength: clamp01(b.strength),
          evidence: b.evidence.map((e) => ({ entryId: e.entryId, quote: e.quote })),
          proofCount: b.evidence.length,
          uncertainty: clamp01(b.uncertainty),
          updatedAt: Number.isFinite(b.updatedAt) ? b.updatedAt : 0,
          contradicting: Array.isArray(b.contradicting)
            ? b.contradicting.filter((x): x is string => typeof x === "string")
            : [],
        });
      }
      this.list = clean;
    } catch {
      this.list = [];
    }
  }

  reload(): void {
    this.list = [];
    this.load();
  }

  save(): void {
    atomicWriteText(
      this.file,
      JSON.stringify({ version: 1, beliefs: this.list } satisfies PersistedBeliefs),
    );
  }

  /** Create a belief. The id is assigned here (BEL_TRUST_001 style,
   *  per-dimension sequence) — the model never invents one. When a
   *  first evidence item is given, its quote is verified verbatim
   *  against the log before anything is stored; a failed check
   *  rejects the whole belief. */
  create(
    input: BeliefCreateInput,
    entriesById: Map<string, MemoryEntry>,
    now = Date.now(),
  ): BeliefCreateResult {
    if (!input || typeof input !== "object") {
      return { ok: false, reasons: ["需要一个信念对象。"] };
    }
    if (!BELIEF_DIMENSIONS.includes(input.dimension)) {
      return {
        ok: false,
        reasons: ["dimension 只能是 safety / trust / closeness 之一。"],
      };
    }
    if (typeof input.statement !== "string" || input.statement.trim().length === 0) {
      return { ok: false, reasons: ["信念需要一句话 statement，不能为空。"] };
    }
    const hasEvidence =
      typeof input.entryId === "string" && input.entryId.length > 0;
    if (hasEvidence) {
      const check = verifyBeliefEvidence(
        input.entryId as string,
        input.quote ?? "",
        entriesById,
      );
      if (!check.ok) return { ok: false, reasons: [check.reason as string] };
    }
    const seq = this.list.filter((b) => b.dimension === input.dimension).length + 1;
    const belief: Belief = {
      id: `BEL_${input.dimension.toUpperCase()}_${String(seq).padStart(3, "0")}`,
      dimension: input.dimension,
      statement: input.statement.trim(),
      strength: clamp01(
        Number.isFinite(input.strength) ? (input.strength as number) : BELIEF_INITIAL_STRENGTH,
      ),
      evidence: hasEvidence
        ? [{ entryId: input.entryId as string, quote: input.quote as string }]
        : [],
      proofCount: hasEvidence ? 1 : 0,
      uncertainty: clamp01(
        Number.isFinite(input.uncertainty)
          ? (input.uncertainty as number)
          : BELIEF_INITIAL_UNCERTAINTY,
      ),
      updatedAt: now,
      contradicting: [],
    };
    this.list.push(belief);
    this.save();
    return { ok: true, belief, reasons: [] };
  }

  /** Support a belief with one more verbatim evidence item. The
   *  delta is the model's call (how strong this evidence is); the
   *  code only takes its positive magnitude and clamps a single
   *  move to BELIEF_MAX_DELTA (0.2), and strength stays in 0..1.
   *  Every support appends its evidence and proofCount + 1. The
   *  quote is verified verbatim first — a non-verbatim quote is
   *  rejected and nothing moves. */
  support(
    id: string,
    entryId: string,
    quote: string,
    delta: number,
    entriesById: Map<string, MemoryEntry>,
    now = Date.now(),
  ): BeliefAdjustResult {
    const belief = this.get(id);
    if (!belief) {
      return { ok: false, reasons: [`信念不存在：${id}。`] };
    }
    if (!Number.isFinite(delta)) {
      return { ok: false, reasons: ["support 需要一个数字 delta（这次证据有多强）。"] };
    }
    const check = verifyBeliefEvidence(entryId, quote, entriesById);
    if (!check.ok) return { ok: false, reasons: [check.reason as string] };
    const step = Math.min(BELIEF_MAX_DELTA, Math.abs(delta));
    belief.strength = clamp01(belief.strength + step);
    belief.evidence.push({ entryId, quote });
    belief.proofCount = belief.evidence.length;
    belief.updatedAt = now;
    this.save();
    return { ok: true, belief, reasons: [] };
  }

  /** Contradict a belief with one conflicting evidence item. Same
   *  clamping as support, mirrored negative (a single move is at
   *  most -0.2, strength stays in 0..1). The conflicting entry's
   *  quote is verified verbatim too. The entry id is recorded in
   *  `contradicting` — a second contradict for the SAME entry is
   *  ignored outright (duplicate: true, no deduction, no write),
   *  however often it is re-submitted. Contradicting never appends
   *  to `evidence` and never moves proofCount: the evidence list
   *  stays the supporting case. */
  contradict(
    id: string,
    entryId: string,
    quote: string,
    delta: number,
    entriesById: Map<string, MemoryEntry>,
    now = Date.now(),
  ): BeliefAdjustResult {
    const belief = this.get(id);
    if (!belief) {
      return { ok: false, reasons: [`信念不存在：${id}。`] };
    }
    if (!Number.isFinite(delta)) {
      return { ok: false, reasons: ["contradict 需要一个数字 delta（这次冲突有多重）。"] };
    }
    const contradicting = belief.contradicting ?? [];
    if (contradicting.includes(entryId)) {
      return { ok: true, belief, duplicate: true, reasons: [] };
    }
    const check = verifyBeliefEvidence(entryId, quote, entriesById);
    if (!check.ok) return { ok: false, reasons: [check.reason as string] };
    const step = Math.min(BELIEF_MAX_DELTA, Math.abs(delta));
    belief.strength = clamp01(belief.strength - step);
    belief.contradicting = [...contradicting, entryId];
    belief.updatedAt = now;
    this.save();
    return { ok: true, belief, reasons: [] };
  }

  /** Daily decay (called from the daily review): every whole silent
   *  day since the belief's last update multiplies strength by
   *  0.99. Never reaches 0, never deletes the belief — a faded
   *  belief is still a belief, just a weaker one. updatedAt moves
   *  to now so the same silence is never charged twice. Returns how
   *  many beliefs decayed. */
  decayBeliefs(now: number): number {
    let decayed = 0;
    for (const belief of this.list) {
      const days = Math.floor((now - belief.updatedAt) / DAY_MS);
      if (days < 1) continue;
      belief.strength = clamp01(
        belief.strength * Math.pow(BELIEF_DECAY_PER_DAY, days),
      );
      belief.updatedAt = now;
      decayed += 1;
    }
    if (decayed > 0) this.save();
    return decayed;
  }

  /** The three dimensions' current values, for memory_belief get
   *  and memory_status. */
  summarize(): Record<BeliefDimension, BeliefDimensionSummary> {
    return summarizeBeliefs(this.list);
  }

  /** The compact recall line ("" when there are no beliefs). */
  line(): string {
    return formatBeliefLine(this.list);
  }
}
