// Provenance (0.5.0 step 3): every derived memory carries
// "where it came from, and how much it can be trusted".
//
// - sourceIds: the log entry ids the item derives from. The code
//   checks they EXIST (validateSourceIds) at write time — a
//   fragment or belief pointing at a missing entry is rejected,
//   never stored.
// - sourceType: the model's JUDGEMENT only (which of the three
//   kinds this is). The model proposes it; the code never lets
//   the model write a number.
// - confidence: computed by CODE from the source type and the
//   verification count (confidenceFor) — the model can never set
//   it directly. null = unknown (legacy rows written before this
//   step, which carry no source information at all).
// - verifyCount / lastVerifiedAt: bumped by code on every
//   successful re-verification (creation counts as the first).
//
// Legacy rows (fragments / beliefs written before 0.5.0, with no
// provenance field) read as sourceType "legacy", confidence null,
// verifyCount 0 — the missing source is labelled, never forged.
// Plain log entries need no stored provenance: the log line IS
// the verbatim source (user_quote for a user line, model_quote
// for an assistant line — both recorded word for word).

import type { MemoryEntry } from "./types.ts";

/** Where a derived memory came from. */
export type SourceType =
  /** Verbatim words of the user (a log line, or a fragment that
   *  only quotes the user). */
  | "user_quote"
  /** Verbatim words of the model, recorded word for word. */
  | "model_quote"
  /** A model-written summary of the sources. */
  | "model_summary"
  /** A model inference drawn from the sources (beliefs, reflections). */
  | "model_inference"
  /** Old data with no source information — labelled, never forged. */
  | "legacy";

export const SOURCE_TYPE_CN: Record<SourceType, string> = {
  user_quote: "用户原话",
  model_quote: "模型原话",
  model_summary: "模型总结",
  model_inference: "模型推断",
  legacy: "未知（旧数据）",
};

/** The source types the model may propose for a new item. "legacy"
 *  is code-only: the model can never claim an item is legacy, and
 *  "user_quote" is only accepted when the item really is verbatim
 *  user words (the fragment verifier checks the quotes). */
export const MODEL_SOURCE_TYPES: SourceType[] = [
  "user_quote",
  "model_quote",
  "model_summary",
  "model_inference",
];

export function isSourceType(v: unknown): v is SourceType {
  return (
    typeof v === "string" &&
    (v === "user_quote" ||
      v === "model_quote" ||
      v === "model_summary" ||
      v === "model_inference" ||
      v === "legacy")
  );
}

/** Provenance carried by a fragment / structured fact. */
export interface Provenance {
  sourceIds: string[];
  sourceType: SourceType;
  /** 0..1, computed by code (confidenceFor). null = unknown
   *  (legacy rows). The model never writes this number. */
  confidence: number | null;
  verifyCount: number;
  lastVerifiedAt: number | null;
}

/** Base confidence per source type (code-assigned, never
 *  model-written): verbatim quotes outrank summaries, summaries
 *  outrank inferences. */
export const PROVENANCE_BASE_CONFIDENCE: Record<
  Exclude<SourceType, "legacy">,
  number
> = {
  user_quote: 0.9,
  model_quote: 0.85,
  model_summary: 0.7,
  model_inference: 0.5,
};

/** Code-computed confidence: base by source type, +0.02 per
 *  successful verification (max 5 bumps), capped at 0.95.
 *  Legacy rows have no base — null, unknown. */
export function confidenceFor(
  sourceType: SourceType,
  verifyCount: number,
): number | null {
  if (sourceType === "legacy") return null;
  const base = PROVENANCE_BASE_CONFIDENCE[sourceType];
  const bumps = Math.min(Math.max(0, verifyCount), 5) * 0.02;
  return Math.round(Math.min(0.95, base + bumps) * 100) / 100;
}

/** Build the provenance for a freshly verified item. Creation
 *  counts as the first verification (verifyCount 1, stamped now). */
export function newProvenance(
  sourceIds: string[],
  sourceType: SourceType,
  now: number = Date.now(),
): Provenance {
  return {
    sourceIds: [...sourceIds],
    sourceType,
    confidence: confidenceFor(sourceType, 1),
    verifyCount: 1,
    lastVerifiedAt: now,
  };
}

/** The provenance for a legacy row: no source information, labelled
 *  as such — the sourceIds it already has are kept (they are real
 *  ids), but the type is unknown and the confidence is null. */
export function legacyProvenance(sourceIds: string[]): Provenance {
  return {
    sourceIds: [...sourceIds],
    sourceType: "legacy",
    confidence: null,
    verifyCount: 0,
    lastVerifiedAt: null,
  };
}

/** Read a stored provenance value (or its absence) into a clean
 *  Provenance. Anything malformed falls back to legacy — a corrupt
 *  row must never crash recall or the starmap, and a missing source
 *  must never be silently upgraded to a real one. */
export function normalizeProvenance(
  input: unknown,
  fallbackSourceIds: string[],
): Provenance {
  if (!input || typeof input !== "object") {
    return legacyProvenance(fallbackSourceIds);
  }
  const p = input as Partial<Provenance>;
  const sourceIds =
    Array.isArray(p.sourceIds) &&
    p.sourceIds.length > 0 &&
    p.sourceIds.every((id) => typeof id === "string")
      ? [...(p.sourceIds as string[])]
      : [...fallbackSourceIds];
  const sourceType = isSourceType(p.sourceType) ? p.sourceType : "legacy";
  const verifyCount =
    Number.isFinite(p.verifyCount) && (p.verifyCount as number) >= 0
      ? Math.floor(p.verifyCount as number)
      : 0;
  const lastVerifiedAt =
    Number.isFinite(p.lastVerifiedAt) && (p.lastVerifiedAt as number) > 0
      ? (p.lastVerifiedAt as number)
      : null;
  // The confidence is ALWAYS recomputed by code from the type +
  // count — a stored number is never trusted (the model must not
  // be able to smuggle a confidence in through a hand-edited file).
  return {
    sourceIds,
    sourceType,
    confidence: confidenceFor(sourceType, verifyCount),
    verifyCount,
    lastVerifiedAt,
  };
}

/** The provenance of a plain log entry: the line itself is the
 *  verbatim source (user_quote for a user line, model_quote for
 *  an assistant line), recorded word for word. No re-verification
 *  has ever run on it, so verifyCount is 0. */
export function entryProvenance(entry: MemoryEntry): Provenance {
  const sourceType: SourceType =
    entry.role === "user" ? "user_quote" : "model_quote";
  return {
    sourceIds: [entry.id],
    sourceType,
    confidence: PROVENANCE_BASE_CONFIDENCE[sourceType],
    verifyCount: 0,
    lastVerifiedAt: null,
  };
}

/** Source-existence check (core rule): every id must resolve to a
 *  real log entry. Returns the missing ids (empty = all exist).
 *  Callers reject the write when this is non-empty. */
export function validateSourceIds(
  ids: unknown,
  entriesById: Map<string, MemoryEntry>,
): { ok: boolean; missing: string[] } {
  if (!Array.isArray(ids) || ids.length === 0) {
    return { ok: false, missing: [] };
  }
  const missing = (ids as unknown[]).filter(
    (id) => typeof id !== "string" || !entriesById.has(id),
  ) as string[];
  return { ok: missing.length === 0, missing };
}

/** Ranking factor from a provenance: low-confidence items are
 *  demoted in recall sorting (never deleted, never hidden from
 *  explicit search). Unknown (legacy, null) sits at 0.85 — below
 *  a verified verbatim quote, above a bare inference. */
export function confidenceFactor(provenance: Provenance | undefined): number {
  if (!provenance) return 1;
  if (provenance.confidence === null) return 0.85;
  return 0.5 + 0.5 * provenance.confidence;
}
