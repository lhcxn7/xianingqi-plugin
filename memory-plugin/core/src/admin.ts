// Management centre (0.5.1 item 3) — first pass: command line +
// local interface (a programmatic API + a localhost HTTP server).
// The web UI comes later; this file is the layer it will call.
//
// The admin is a NON-MODEL channel: it runs in the user's shell
// or on localhost, never inside a chat. That is what makes it
// allowed to do what the model may not — edit or delete a memory,
// approve a forgetting, correct a fact. Nothing here is reachable
// from a model tool: the plugin exposes no admin tool, and the
// server binds 127.0.0.1 only.
//
// Two operations change a memory's words:
//   edit    — in-place rewrite (core.editEntry), audited, with
//             before/after in admin-audit.jsonl.
//   correct — non-destructive: appends a new entry that
//             supersedes the old one (same factKey, supersedes=id),
//             so the history stays and the fact chain answers
//             "now" with the correction. Prefer correct for
//             factual fixes; edit is for typos and cleanup.

import { appendFileSync } from "node:fs";
import { join } from "node:path";
import type { MemoryCore } from "./core.ts";
import { factChains } from "./facts.ts";
import type { ForgetMode, ForgetPreview, ForgetRequest } from "./forget.ts";
import type { Experience } from "./experiences.ts";
import type { Goal, GoalStatus } from "./goals.ts";
import type { Importance, MemoryEntry } from "./types.ts";

export interface AdminStats {
  totalEntries: number;
  personaEntries: number;
  taskEntries: number;
  fragments: number;
  beliefs: number;
  openGoals: number;
  doneGoals: number;
  experiences: number;
  pendingForgets: number;
  forgotten: number;
  semantic: {
    enabled: boolean;
    modelPresent: boolean;
    indexSize: number;
  };
}

export class MemoryAdmin {
  readonly core: MemoryCore;
  /** Who the audit lines blame ("cli", "admin-api", ...). */
  readonly by: string;

  constructor(core: MemoryCore, by = "cli") {
    this.core = core;
    this.by = by;
  }

  // ---- entries ---------------------------------------------------

  listEntries(opts: {
    window?: "persona" | "task" | "all";
    query?: string;
    limit?: number;
    offset?: number;
  } = {}): { total: number; entries: MemoryEntry[] } {
    const window = opts.window ?? "all";
    const q = (opts.query ?? "").toLowerCase();
    const all = this.core.allEntries().filter((e) => {
      if (window !== "all" && e.window !== window) return false;
      if (q.length > 0 && !e.text.toLowerCase().includes(q)) return false;
      return true;
    });
    const offset = Math.max(0, opts.offset ?? 0);
    const limit = Math.min(Math.max(1, opts.limit ?? 50), 500);
    return { total: all.length, entries: all.slice(offset, offset + limit) };
  }

  getEntry(id: string): MemoryEntry | undefined {
    return this.core.allEntries().find((e) => e.id === id);
  }

  /** In-place edit (typos, cleanup). Audited. */
  editEntry(
    id: string,
    patch: { text?: string; importance?: Importance },
  ): MemoryEntry {
    const updated = this.core.editEntry(id, patch, this.by);
    // 0.5.2: the keyword index/log now hold the new text; the vector
    // must not keep representing the old one. Admin is the only
    // caller that forgot this; correctEntry already refreshes.
    if (patch.text !== undefined) {
      void this.core.semanticUpsertEntry(updated);
    }
    return updated;
  }

  /** Non-destructive correction: append a new entry that
   *  supersedes the old one. The old text stays in the log; the
   *  fact chain answers "now" with the correction. */
  correctEntry(
    id: string,
    input: { text: string; factKey?: string; importance?: Importance },
  ): MemoryEntry {
    const old = this.getEntry(id);
    if (!old) throw new Error(`no entry ${id}`);
    if (typeof input.text !== "string" || input.text.trim().length === 0) {
      throw new TypeError("correctEntry needs a non-empty text");
    }
    const factKey = input.factKey ?? old.factKey;
    const entry = this.core.record({
      role: old.role,
      text: input.text,
      window: old.window,
      importance: input.importance ?? old.importance,
      sessionId: old.sessionId,
      ...(factKey !== undefined ? { factKey } : {}),
      ...(factKey !== undefined ? { supersedes: id } : {}),
    });
    try {
      appendFileSync(
        join(this.core.dataDir, "admin-audit.jsonl"),
        JSON.stringify({
          ts: Date.now(),
          event: "admin.correct",
          id,
          newId: entry.id,
          by: this.by,
          before: old.text,
          after: input.text,
        }) + "\n",
        { encoding: "utf8", mode: 0o600 },
      );
    } catch {
      // Best-effort, like editEntry.
    }
    void this.core.semanticUpsertEntry(entry);
    return entry;
  }

  /** Delete one entry through the forget pipeline (request +
   *  approve + execute, all in one admin call — the admin IS the
   *  authorised channel, so no separate approval step is needed
   *  here; the audit still records all three steps). */
  deleteEntry(id: string): { removed: string[] } {
    const req = this.core.requestForget({
      mode: "delete",
      entryIds: [id],
      reason: `admin delete (${this.by})`,
      createdBy: "cli",
    });
    this.core.approveForget(req.id, { channel: "cli", by: this.by });
    const done = this.core.executeForget(req.id, { by: this.by });
    return { removed: done.removed };
  }

  /** Fact chain view for one entry (for the future UI). */
  factChainOf(id: string): { factKey: string; versions: MemoryEntry[]; current: MemoryEntry } | null {
    const entry = this.getEntry(id);
    if (!entry || !entry.factKey) return null;
    const chain = factChains(this.core.allEntries()).get(entry.factKey);
    if (!chain) return null;
    return { factKey: chain.factKey, versions: chain.versions, current: chain.current };
  }

  // ---- forgetting (delegates; the admin channel approves) --------

  requestForget(input: {
    mode: ForgetMode;
    entryIds: string[];
    reason?: string;
  }): ForgetRequest {
    return this.core.requestForget({ ...input, createdBy: "cli" });
  }

  dryRunForget(ids: string[]): ForgetPreview {
    return this.core.dryRunForget(ids);
  }

  approveForget(id: string): ForgetRequest {
    return this.core.approveForget(id, { channel: "cli", by: this.by });
  }

  executeForget(id: string): { request: ForgetRequest; removed: string[]; hidden: string[] } {
    return this.core.executeForget(id, { by: this.by });
  }

  listForgetRequests(): ForgetRequest[] {
    return this.core.listForgetRequests();
  }

  unforget(ids: string[]): string[] {
    return this.core.unforget(ids);
  }

  // ---- goals / experiences ---------------------------------------

  createGoal(input: {
    title: string;
    dueAt?: number;
    notes?: string;
    sourceIds?: string[];
  }): Goal {
    return this.core.createGoal(input);
  }

  listGoals(status?: GoalStatus): Goal[] {
    const all = this.core.goals.all();
    return status ? all.filter((g) => g.status === status) : all;
  }

  setGoalStatus(id: string, status: GoalStatus): Goal | undefined {
    return this.core.setGoalStatus(id, status);
  }

  updateGoal(
    id: string,
    patch: { title?: string; dueAt?: number | null; notes?: string | null },
  ): Goal | undefined {
    return this.core.updateGoal(id, patch);
  }

  removeGoal(id: string): boolean {
    return this.core.removeGoal(id);
  }

  recordExperience(input: {
    rule: string;
    trigger: string[];
    source: string;
    sourceIds: string[];
  }): Experience {
    // 0.5.3: an admin-created rule still needs live persona sources.
    const found = this.core.entriesByIds(input.sourceIds);
    if (found.length !== input.sourceIds.length) {
      throw new Error("experience sourceIds must name existing log entries");
    }
    if (
      found.some(
        (e) => e.window !== "persona" || this.core.forget.isForgotten(e.id),
      )
    ) {
      throw new Error("experience sourceIds must be live persona entries");
    }
    return this.core.recordExperience(input);
  }

  listExperiences(): Experience[] {
    return this.core.experiences.all();
  }

  removeExperience(id: string): boolean {
    return this.core.removeExperience(id);
  }

  confirmExperience(id: string, expiresAt?: number): boolean {
    return this.core.confirmExperience(id, this.by, expiresAt);
  }

  revokeExperience(id: string): boolean {
    return this.core.revokeExperience(id, this.by);
  }

  // ---- semantic ----------------------------------------------------

  semanticStatus(): ReturnType<MemoryCore["semanticStatus"]> {
    return this.core.semanticStatus();
  }

  async rebuildSemanticIndex(): Promise<{ status: string; built: number }> {
    return this.core.ensureSemanticIndex({ rebuild: true });
  }

  // ---- stats -------------------------------------------------------

  stats(): AdminStats {
    const all = this.core.allEntries();
    const goals = this.core.goals.all();
    const sem = this.core.semanticStatus();
    return {
      totalEntries: all.length,
      personaEntries: all.filter((e) => e.window === "persona").length,
      taskEntries: all.filter((e) => e.window === "task").length,
      fragments: this.core.fragmentCount(),
      beliefs: this.core.beliefCount(),
      openGoals: goals.filter((g) => g.status === "open").length,
      doneGoals: goals.filter((g) => g.status === "done").length,
      experiences: this.core.experiences.size,
      pendingForgets: this.core
        .listForgetRequests()
        .filter((r) => r.status === "pending" || r.status === "approved").length,
      forgotten: this.core.forget.forgottenIds().length,
      semantic: {
        enabled: sem.enabled,
        modelPresent: sem.modelPresent,
        indexSize: sem.indexSize,
      },
    };
  }
}
