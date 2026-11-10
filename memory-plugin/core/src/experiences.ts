// Experience learning (0.5.1 item 4): rules learned from
// mistakes, written as reusable entries — not a score tweak.
//
// An experience is a RULE with a trigger, not a number: when the
// model (or the code) does something wrong, the lesson is written
// down in one or two sentences, with the trigger words that summon
// it and the source — what went wrong, where. Recall matches
// experiences by trigger against the query and injects at most
// two, so the rule is in front of the model exactly when it is
// about to repeat the mistake.
//
// 0.5.2: the store starts EMPTY. It used to seed itself with three
// lessons from this project's own debugging (q15 conflict order, the
// weak-token drop regression, the review early-exit kinds bug); on a
// new user's machine those rules were injected whenever common words
// (现在/喝/喜欢/颜色/住) appeared. Project debug rules belong in the
// test fixtures, not in a user's long-term prompt.

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteText, backupCorruptFile, type CorruptBackup } from "./atomic.ts";
import { tokenize } from "./tokenize.ts";

export const EXPERIENCES_FILE = "experiences.json";

export interface Experience {
  id: string;
  /** The reusable rule, one or two sentences. */
  rule: string;
  /** Trigger words / phrases — a query matching one summons it. */
  trigger: string[];
  /** What went wrong, where — the mistake this came from. */
  source: string;
  /** 0.5.3: log entry ids that back this rule. Required on record. */
  sourceIds: string[];
  /** 0.5.3: only a confirmed rule may be injected into a prompt.
   *  A freshly recorded rule is a candidate until confirm(). */
  verified: boolean;
  /** 0.5.4: who confirmed it and when (CLI/API only; never the model). */
  confirmedBy?: string;
  confirmedAt?: number;
  /** 0.5.5: optional expiry (epoch ms). An expired rule is a
   *  candidate again and is never injected. */
  expiresAt?: number;
  /** 0.5.5: last revoke (CLI/API only). */
  revokedBy?: string;
  revokedAt?: number;
  createdAt: number;
  useCount: number;
  lastUsedAt?: number;
}

export interface MatchedExperience {
  experience: Experience;
  /** How many trigger phrases matched the query. */
  score: number;
}

export class ExperienceStore {
  readonly dataDir: string;
  private readonly file: string;
  private list: Experience[] = [];
  private loadFailed = false;
  private corruptBackup: CorruptBackup | null = null;
  /** 0.5.3: markUsed is in-memory until flush. A reload triggered by
   *  another store write must not throw that use away. */
  private dirty = false;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.file = join(dataDir, EXPERIENCES_FILE);
    // 0.5.2: a new user starts with an EMPTY experience list. The
    // three developer lessons below used to be written on first
    // creation and then injected whenever common words (现在/喝/
    // 喜欢/颜色/住) appeared — project debug rules leaking into a
    // user's long-term prompt. They stay only as test fixtures.
    if (!existsSync(this.file)) {
      this.list = [];
      return;
    }
    this.load();
  }

  get hasLoadFailed(): boolean {
    return this.loadFailed;
  }

  get size(): number {
    return this.list.length;
  }

  all(): Experience[] {
    return [...this.list];
  }

  get(id: string): Experience | undefined {
    return this.list.find((e) => e.id === id);
  }

  private load(): void {
    // 0.5.2: a missing file is an EMPTY store, not a corrupt one.
    // reload() on a fresh data dir used to set loadFailed and make
    // every later flush throw.
    if (!existsSync(this.file)) {
      this.list = [];
      this.loadFailed = false;
      return;
    }
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as unknown;
      if (!Array.isArray(parsed)) throw new Error("not an array");
      this.list = (parsed as Experience[]).map((e) => ({
        ...e,
        sourceIds: Array.isArray(e.sourceIds)
          ? e.sourceIds.filter((id): id is string => typeof id === "string")
          : [],
        // Old rows have no confirmation bit; treat them as candidates,
        // not as trusted prompt rules.
        verified: e.verified === true,
      }));
      this.loadFailed = false;
    } catch {
      const backup = backupCorruptFile(this.file, this.corruptBackup);
      if (backup) this.corruptBackup = backup;
      this.loadFailed = true;
      console.warn(
        `[memory-plugin] experiences.json 损坏，已备份到 ${this.corruptBackup?.path ?? "（备份失败）"}，拒绝覆盖原文件。`,
      );
      this.list = [];
    }
  }

  reload(): void {
    if (this.dirty) return;
    this.load();
  }

  save(): void {
    if (this.loadFailed) {
      throw new Error(
        `experiences.json 已损坏（备份在 ${this.corruptBackup?.path ?? "?" }），拒绝覆盖——请检查后删除损坏文件或从快照恢复。`,
      );
    }
    atomicWriteText(this.file, JSON.stringify(this.list, null, 2));
    this.dirty = false;
  }

  /** Record a lesson from a mistake. The rule is the point: a
   *  score tweak is not an experience. */
  record(input: {
    rule: string;
    trigger: string[];
    source: string;
    sourceIds?: string[];
    now?: number;
  }): Experience {
    if (typeof input.rule !== "string" || input.rule.trim().length === 0) {
      throw new TypeError("recordExperience needs a non-empty rule");
    }
    if (input.rule.length > 500) {
      throw new TypeError("recordExperience rule is at most 500 chars");
    }
    const triggers = [...new Set(
      (input.trigger ?? []).filter((t) => typeof t === "string" && t.trim().length > 0),
    )].slice(0, 10);
    if (triggers.length === 0) {
      throw new TypeError("recordExperience needs at least one trigger");
    }
    if (typeof input.source !== "string" || input.source.trim().length === 0) {
      throw new TypeError("recordExperience needs a source (what went wrong, where)");
    }
    const sourceIds = [...new Set(
      (input.sourceIds ?? []).filter(
        (id): id is string => typeof id === "string" && id.length > 0,
      ),
    )];
    if (sourceIds.length === 0) {
      throw new TypeError(
        "recordExperience needs at least one sourceIds entry (the log line the rule came from)",
      );
    }
    const exp: Experience = {
      id: `exp-${randomUUID().slice(0, 8)}`,
      rule: input.rule.trim(),
      trigger: triggers,
      source: input.source.trim(),
      sourceIds,
      verified: false,
      createdAt: input.now ?? Date.now(),
      useCount: 0,
    };
    this.list.push(exp);
    this.save();
    return { ...exp };
  }

  /** 0.5.3: user/admin confirmation. Only confirmed rules are
   *  injected; unconfirmed ones stay visible in list/match but never
   *  enter a prompt. 0.5.4: `by` is required so the audit trail says
   *  who confirmed it; the model-facing tool no longer exposes this. */
  confirm(id: string, by = "cli", now = Date.now(), expiresAt?: number): boolean {
    const e = this.list.find((x) => x.id === id);
    if (!e) return false;
    e.verified = true;
    e.confirmedBy = by;
    e.confirmedAt = now;
    if (expiresAt !== undefined) {
      if (!Number.isFinite(expiresAt) || expiresAt <= now) {
        throw new TypeError("confirm expiresAt must be a finite future epoch-ms");
      }
      e.expiresAt = expiresAt;
    }
    delete e.revokedBy;
    delete e.revokedAt;
    this.save();
    return true;
  }

  /** 0.5.5: withdraw a confirmation. The rule becomes a candidate
   *  again and is not injected until confirmed anew. */
  revoke(id: string, by = "cli", now = Date.now()): boolean {
    const e = this.list.find((x) => x.id === id);
    if (!e) return false;
    e.verified = false;
    delete e.confirmedBy;
    delete e.confirmedAt;
    e.revokedBy = by;
    e.revokedAt = now;
    this.save();
    return true;
  }

  /** Match experiences against a query: at least one trigger
   *  phrase must appear (substring) or share a token with the
   *  query. Best first, at most `limit`. Pure — no writes. */
  match(query: string, limit = 2, includeUnverified = false, now = Date.now()): MatchedExperience[] {
    if (typeof query !== "string" || query.length === 0) return [];
    const queryTokens = new Set(tokenize(query));
    const scored: Array<MatchedExperience & { idx: number }> = [];
    for (let i = 0; i < this.list.length; i++) {
      const e = this.list[i];
      if (!includeUnverified && e.verified !== true) continue;
      if (typeof e.expiresAt === "number" && e.expiresAt <= now) continue;
      let score = 0;
      for (const t of e.trigger) {
        // 0.5.5: a one-character trigger is too broad to inject.
        if (t.length < 2) continue;
        if (query.includes(t)) {
          score += 1;
          continue;
        }
        for (const tok of tokenize(t)) {
          // Shared tokens must be at least 2 chars too; a single
          // character match used to fire across unrelated topics.
          if (tok.length >= 2 && queryTokens.has(tok)) {
            score += 0.5;
            break;
          }
        }
      }
      if (score > 0) scored.push({ experience: e, score, idx: i });
    }
    // Score first, then newer first. The index tiebreak matters:
    // two rules recorded in the same millisecond share createdAt,
    // and without it the older seed wins by insertion order and a
    // just-recorded rule can be cut off from the top 2 — the demo
    // caught exactly that (same-ms seed + record).
    scored.sort(
      (a, b) =>
        b.score - a.score ||
        b.experience.createdAt - a.experience.createdAt ||
        b.idx - a.idx,
    );
    return scored
      .slice(0, Math.max(0, limit))
      .map(({ experience, score }) => ({ experience, score }));
  }

  /** Count one use (in-memory; the caller persists at flush).
   *  A use is a recall that actually injected the rule. */
  /** 0.5.4: keep only source ids that still name a live persona entry.
   *  A rule with no valid source becomes an unconfirmed candidate and
   *  is no longer injected. */
  revalidate(liveIds: Set<string>): void {
    let changed = false;
    for (const e of this.list) {
      const sourceIds = Array.isArray(e.sourceIds) ? e.sourceIds : [];
      const kept = sourceIds.filter((id) => liveIds.has(id));
      if (kept.length !== sourceIds.length) {
        e.sourceIds = kept;
        changed = true;
      }
      if (kept.length === 0 && e.verified) {
        e.verified = false;
        delete e.confirmedBy;
        delete e.confirmedAt;
        changed = true;
      }
    }
    if (changed) this.save();
  }

  markUsed(id: string, now = Date.now()): boolean {
    const e = this.list.find((x) => x.id === id);
    if (!e) return false;
    e.useCount += 1;
    e.lastUsedAt = now;
    this.dirty = true;
    return true;
  }

  remove(id: string): boolean {
    const before = this.list.length;
    this.list = this.list.filter((e) => e.id !== id);
    if (this.list.length === before) return false;
    this.save();
    return true;
  }
}
