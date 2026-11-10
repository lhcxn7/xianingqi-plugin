// Goals / todos (0.5.1 item 5): model-readable, model-writable,
// with completion status.
//
// A goal is a small durable outcome ("130 斤", "周末去爬山"), not
// a memory and not a skill instruction. The model reads the open
// ones (memory_goal list), creates them when the user states an
// aim, and marks them done / dropped when the user says so. The
// store is a plain JSON list with the same corrupt-backup +
// atomic-write discipline as the other stores.

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteText, backupCorruptFile, type CorruptBackup } from "./atomic.ts";

export const GOALS_FILE = "goals.json";

export type GoalStatus = "open" | "done" | "dropped";

export interface Goal {
  id: string;
  title: string;
  status: GoalStatus;
  createdAt: number;
  updatedAt: number;
  dueAt?: number;
  notes?: string;
  /** Log entry ids this goal came from (optional provenance). */
  sourceIds?: string[];
}

export class GoalStore {
  readonly dataDir: string;
  private readonly file: string;
  private list: Goal[] = [];
  private loadFailed = false;
  private corruptBackup: CorruptBackup | null = null;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.file = join(dataDir, GOALS_FILE);
    this.load();
  }

  get hasLoadFailed(): boolean {
    return this.loadFailed;
  }

  get size(): number {
    return this.list.length;
  }

  all(): Goal[] {
    return [...this.list];
  }

  open(): Goal[] {
    return this.list.filter((g) => g.status === "open");
  }

  get(id: string): Goal | undefined {
    return this.list.find((g) => g.id === id);
  }

  private load(): void {
    try {
      const raw = readFileSync(this.file, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) throw new Error("not an array");
      this.list = parsed as Goal[];
      this.loadFailed = false;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        this.list = [];
        return;
      }
      const backup = backupCorruptFile(this.file, this.corruptBackup);
      if (backup) this.corruptBackup = backup;
      this.loadFailed = true;
      console.warn(
        `[memory-plugin] goals.json 损坏，已备份到 ${this.corruptBackup?.path ?? "（备份失败）"}，拒绝覆盖原文件。`,
      );
      this.list = [];
    }
  }

  reload(): void {
    this.load();
  }

  save(): void {
    if (this.loadFailed) {
      throw new Error(
        `goals.json 已损坏（备份在 ${this.corruptBackup?.path ?? "?"}），拒绝覆盖——请检查后删除损坏文件或从快照恢复。`,
      );
    }
    atomicWriteText(this.file, JSON.stringify(this.list, null, 2));
  }

  create(input: {
    title: string;
    dueAt?: number;
    notes?: string;
    sourceIds?: string[];
    now?: number;
  }): Goal {
    if (typeof input.title !== "string" || input.title.trim().length === 0) {
      throw new TypeError("createGoal needs a non-empty title");
    }
    if (input.title.length > 200) {
      throw new TypeError("createGoal title is at most 200 chars");
    }
    if (
      input.dueAt !== undefined &&
      (typeof input.dueAt !== "number" || !Number.isFinite(input.dueAt))
    ) {
      throw new TypeError("createGoal dueAt must be an epoch-ms number");
    }
    if (
      input.notes !== undefined &&
      (typeof input.notes !== "string" || input.notes.length > 2000)
    ) {
      throw new TypeError("createGoal notes must be a string of at most 2000 chars");
    }
    if (
      input.sourceIds !== undefined &&
      (!Array.isArray(input.sourceIds) ||
        !input.sourceIds.every((id) => typeof id === "string" && id.length > 0))
    ) {
      throw new TypeError("createGoal sourceIds must be an array of non-empty strings");
    }
    const now = input.now ?? Date.now();
    const goal: Goal = {
      id: `goal-${randomUUID().slice(0, 8)}`,
      title: input.title.trim(),
      status: "open",
      createdAt: now,
      updatedAt: now,
      ...(input.dueAt !== undefined ? { dueAt: input.dueAt } : {}),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
      ...(input.sourceIds !== undefined ? { sourceIds: input.sourceIds } : {}),
    };
    this.list.push(goal);
    this.save();
    return { ...goal };
  }

  update(
    id: string,
    patch: { title?: string; dueAt?: number | null; notes?: string | null; sourceIds?: string[] },
    now = Date.now(),
  ): Goal | undefined {
    const g = this.list.find((x) => x.id === id);
    if (!g) return undefined;
    if (patch.title !== undefined) {
      if (typeof patch.title !== "string" || patch.title.trim().length === 0) {
        throw new TypeError("updateGoal title must be a non-empty string");
      }
      g.title = patch.title.trim();
    }
    if (patch.dueAt !== undefined) {
      if (patch.dueAt === null) delete g.dueAt;
      else if (typeof patch.dueAt !== "number" || !Number.isFinite(patch.dueAt)) {
        throw new TypeError("updateGoal dueAt must be a finite epoch-ms number or null");
      } else g.dueAt = patch.dueAt;
    }
    if (patch.notes !== undefined) {
      if (patch.notes === null) delete g.notes;
      else if (typeof patch.notes !== "string" || patch.notes.length > 2000) {
        throw new TypeError("updateGoal notes must be a string of at most 2000 chars or null");
      } else g.notes = patch.notes;
    }
    if (patch.sourceIds !== undefined) {
      if (
        !Array.isArray(patch.sourceIds) ||
        !patch.sourceIds.every((id) => typeof id === "string" && id.length > 0)
      ) {
        throw new TypeError("updateGoal sourceIds must be an array of non-empty strings");
      }
      g.sourceIds = patch.sourceIds;
    }
    g.updatedAt = now;
    this.save();
    return { ...g };
  }

  /** Set the completion status — the point of the store. Any
   *  transition is allowed (done -> open is a reopen, not an
   *  error); updatedAt moves. */
  setStatus(id: string, status: GoalStatus, now = Date.now()): Goal | undefined {
    if (status !== "open" && status !== "done" && status !== "dropped") {
      throw new TypeError('setGoalStatus must be "open", "done" or "dropped"');
    }
    const g = this.list.find((x) => x.id === id);
    if (!g) return undefined;
    g.status = status;
    g.updatedAt = now;
    this.save();
    return { ...g };
  }

  /** 0.5.4: keep only source ids that still name a live persona entry
   *  (called after a snapshot restore / hide / delete). */
  revalidate(liveIds: Set<string>): void {
    let changed = false;
    for (const g of this.list) {
      if (!Array.isArray(g.sourceIds)) continue;
      const kept = g.sourceIds.filter((id) => liveIds.has(id));
      if (kept.length !== g.sourceIds.length) {
        g.sourceIds = kept;
        changed = true;
      }
    }
    if (changed) this.save();
  }

  remove(id: string): boolean {
    const before = this.list.length;
    this.list = this.list.filter((g) => g.id !== id);
    if (this.list.length === before) return false;
    this.save();
    return true;
  }
}
