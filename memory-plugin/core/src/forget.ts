// Forgetting governance (0.5.1 item 1).
//
// A deletion or hiding is NEVER authorised by a chat message.
// "我同意" in a conversation is not an authorisation — the model
// can be talked into anything, and a chat line is not an audit
// trail. Forgetting runs on a non-model channel only:
//
//   1. request — anyone (model tool, admin CLI, local API) may
//      FILE a request: which entries, hide or delete, why. The
//      request is pending and changes nothing. A dry-run preview
//      is attached: entries, fragments, beliefs, graph edges and
//      index vectors that would be affected.
//   2. approve — the admin CLI (`memory-admin forget approve`) or
//      the local admin API ONLY. The model has no tool that calls
//      this, and core refuses an approval whose channel is not
//      "cli" or "admin". Approval is recorded with who/when.
//   3. execute — only an approved, unexpired request, again only
//      from the CLI / local API. The model tool exposes request,
//      dry-run and status only.
//
// Every step appends to `forget-audit.jsonl` (append-only, never
// snapshotted, never rolled back — like the invalidation audit).
// Pending requests expire after 7 days.
//
// What forgetting does:
//   hide — the entries stay on disk but are tombstoned in
//     `forgotten.json`: recall, search, yesterday's review and
//     entriesByIds never surface them again. Reversible (an admin
//     unhide clears the tombstone). Fragments whose sources are
//     all forgotten fail their retrieval-time re-check on their
//     own and are marked suspect by the existing path.
//   delete — physical removal: the log is rewritten without the
//     entries (a snapshot is taken first, so a delete is
//     recoverable), the index is rebuilt, graph edges / attribute
//     rows / fragments / belief evidence touching the ids are
//     removed, and semantic vectors for the ids are dropped.
//     Irreversible except through the snapshot.

import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { atomicWriteText, backupCorruptFile } from "./atomic.ts";
import type { MemoryEntry } from "./types.ts";

export const FORGET_REQUESTS_FILE = "forget-requests.json";
export const FORGET_AUDIT_FILE = "forget-audit.jsonl";
export const FORGOTTEN_FILE = "forgotten.json";

/** A pending request lives 7 days; after that it is expired and
 *  can never be approved or executed. */
export const FORGET_REQUEST_TTL_MS = 7 * 86_400_000;

export type ForgetMode = "hide" | "delete";
export type ForgetStatus =
  | "pending"
  | "approved"
  | "executed"
  | "rejected"
  | "expired";
/** Channels allowed to approve / execute. "model" is deliberately
 *  absent: no model-facing tool can approve a forgetting. */
export type ForgetChannel = "cli" | "admin";

export interface ForgetRequest {
  id: string;
  createdAt: number;
  /** Who filed it: "model" (memory_forget tool), "cli", "admin". */
  createdBy: "model" | "cli" | "admin";
  mode: ForgetMode;
  entryIds: string[];
  reason?: string;
  status: ForgetStatus;
  approvedAt?: number;
  approvedBy?: string;
  approvedChannel?: ForgetChannel;
  executedAt?: number;
  executedBy?: string;
}

export interface ForgetPreviewEntry {
  id: string;
  date: string;
  text: string;
}

export interface ForgetPreview {
  entries: ForgetPreviewEntry[];
  /** Ids of fragments that cite only these entries (they would
   *  lose all their sources). */
  fragments: string[];
  /** Ids of beliefs that cite only these entries as evidence. */
  beliefs: string[];
  /** Graph edges touching these entries. */
  graphEdges: number;
  /** Semantic index vectors for these entries (0 when no index). */
  indexVectors: number;
  /** Ids that were asked for but are not in the log. */
  unknown: string[];
  /** 0.5.3: skill-owned files that still contain an exact copy of
   *  one of these memories (MEMORY.md / MEMORY-YYYY-MM.md). These are
   *  deliberately NOT deleted by the plugin; the list makes the
   *  boundary visible instead of implying a full purge. */
  skillCopies?: string[];
}

export interface ForgetDryRunInput {
  entriesById: (id: string) => MemoryEntry | undefined;
  /** Fragment ids whose sources are all inside `ids`. */
  fragmentsFor: (ids: string[]) => string[];
  /** Belief ids whose evidence is all inside `ids`. */
  beliefsFor: (ids: string[]) => string[];
  /** Number of graph edges touching any of `ids`. */
  graphEdgeCount: (ids: string[]) => number;
  /** Number of semantic vectors held for `ids` (0 when disabled). */
  semanticVectorCount: (ids: string[]) => number;
}

export function buildForgetPreview(
  ids: string[],
  input: ForgetDryRunInput,
): ForgetPreview {
  const entries: ForgetPreviewEntry[] = [];
  const unknown: string[] = [];
  for (const id of ids) {
    const e = input.entriesById(id);
    if (!e) {
      unknown.push(id);
      continue;
    }
    entries.push({ id: e.id, date: e.date, text: e.text });
  }
  return {
    entries,
    fragments: input.fragmentsFor(ids),
    beliefs: input.beliefsFor(ids),
    graphEdges: input.graphEdgeCount(ids),
    indexVectors: input.semanticVectorCount(ids),
    unknown,
  };
}

function auditLine(event: string, data: Record<string, unknown>): string {
  return JSON.stringify({ ts: Date.now(), event, ...data });
}

export class ForgetStore {
  readonly dataDir: string;
  private requests: ForgetRequest[] = [];
  private forgotten: Record<
    string,
    { mode: ForgetMode; at: number; requestId: string }
  > = {};
  private loadFailed = false;
  /** 0.5.2: a corrupt forgotten.json must fail CLOSED — every id is
   *  treated as hidden until the file is repaired/restored. A broken
   *  request list (forget-requests.json) does NOT hide memories; it
   *  only loses pending requests. */
  private forgottenLoadFailed = false;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.load();
  }

  private audit(event: string, data: Record<string, unknown>): void {
    try {
      appendFileSync(
        join(this.dataDir, FORGET_AUDIT_FILE),
        auditLine(event, data) + "\n",
        { encoding: "utf8", mode: 0o600 },
      );
    } catch {
      // The audit is best-effort: a failed audit write must never
      // block a refusal, and an execution that cannot audit still
      // refuses (see execute() — it checks the audit write).
    }
  }

  private load(): void {
    this.loadFailed = false;
    this.forgottenLoadFailed = false;
    const file = join(this.dataDir, FORGET_REQUESTS_FILE);
    if (existsSync(file)) {
      try {
        const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
        if (!Array.isArray(parsed)) throw new Error("not an array");
        this.requests = parsed as ForgetRequest[];
      } catch {
        this.loadFailed = true;
        const backup = backupCorruptFile(file, null);
        console.warn(
          `[memory-plugin] ${FORGET_REQUESTS_FILE} 损坏，已备份到 ${backup?.path ?? "?" }，从空列表开始（旧请求丢失，审计文件不受影响）。`,
        );
        this.requests = [];
      }
    } else {
      this.requests = [];
    }
    const forgottenFile = join(this.dataDir, FORGOTTEN_FILE);
    if (!existsSync(forgottenFile)) {
      this.forgotten = {};
      return;
    }
    try {
      const parsed = JSON.parse(readFileSync(forgottenFile, "utf8")) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("not an object");
      }
      this.forgotten = parsed as typeof this.forgotten;
    } catch {
      // 0.5.2: fail CLOSED. A corrupt tombstone table must never make
      // hidden memories visible again; isForgotten() returns true for
      // every id while forgottenLoadFailed is set.
      this.forgottenLoadFailed = true;
      this.loadFailed = true;
      const backup = backupCorruptFile(forgottenFile, null);
      console.warn(
        `[memory-plugin] ${FORGOTTEN_FILE} 损坏，已备份到 ${backup?.path ?? "?"}；无法确认哪些记忆已隐藏，按 fail-closed 处理（全部隐藏），请从备份恢复。`,
      );
      this.forgotten = {};
    }
  }

  private saveRequests(): void {
    atomicWriteText(
      join(this.dataDir, FORGET_REQUESTS_FILE),
      JSON.stringify(this.requests, null, 2),
    );
  }

  private saveForgotten(): void {
    atomicWriteText(
      join(this.dataDir, FORGOTTEN_FILE),
      JSON.stringify(this.forgotten, null, 2),
    );
  }

  get hasLoadFailed(): boolean {
    return this.loadFailed || this.forgottenLoadFailed;
  }

  /** Re-read the request list + tombstones from disk (called by
   *  core refreshIfStale under the write lock, when another
   *  writer may have moved them). */
  reload(): void {
    this.load();
  }

  all(): ForgetRequest[] {
    return [...this.requests];
  }

  get(id: string): ForgetRequest | undefined {
    return this.requests.find((r) => r.id === id);
  }

  isForgotten(id: string): boolean {
    // Fail closed: a corrupt/unreadable tombstone table hides every id
    // until the operator restores it, rather than exposing them again.
    if (this.forgottenLoadFailed) return true;
    return id in this.forgotten;
  }

  forgottenIds(): string[] {
    return Object.keys(this.forgotten);
  }

  /** File a request. Changes nothing — the entries stay exactly
   *  where they are until an approved execution. */
  request(input: {
    mode: ForgetMode;
    entryIds: string[];
    reason?: string;
    createdBy: "model" | "cli" | "admin";
    now?: number;
  }): ForgetRequest {
    const ids = [...new Set(input.entryIds.filter((s) => typeof s === "string" && s.length > 0))];
    if (ids.length === 0) {
      throw new TypeError("requestForget needs at least one entry id");
    }
    if (input.mode !== "hide" && input.mode !== "delete") {
      throw new TypeError('requestForget mode must be "hide" or "delete"');
    }
    const req: ForgetRequest = {
      id: `fr-${randomUUID().slice(0, 8)}`,
      createdAt: input.now ?? Date.now(),
      createdBy: input.createdBy,
      mode: input.mode,
      entryIds: ids,
      reason: input.reason,
      status: "pending",
    };
    this.requests.push(req);
    this.saveRequests();
    this.audit("forget.requested", {
      requestId: req.id,
      createdBy: req.createdBy,
      mode: req.mode,
      entryIds: req.entryIds,
      reason: req.reason ?? "",
    });
    return { ...req };
  }

  /** Mark a request rejected (admin/CLI only in practice — the
   *  model tool has no reject call either; a rejection is a
   *  human decision). */
  reject(id: string, by: string): ForgetRequest {
    const req = this.requests.find((r) => r.id === id);
    if (!req) throw new Error(`no forget request ${id}`);
    if (req.status !== "pending" && req.status !== "approved") {
      throw new Error(`forget request ${id} is ${req.status}, cannot reject`);
    }
    req.status = "rejected";
    this.saveRequests();
    this.audit("forget.rejected", { requestId: id, by });
    return { ...req };
  }

  /** Approve a pending request. The channel is the enforcement:
   *  only "cli" (memory-admin) and "admin" (local admin API) may
   *  approve. There is no "model" channel — a chat "我同意" can
   *  never reach this function, because the model-facing tool
   *  does not expose it. */
  approve(
    id: string,
    input: { channel: ForgetChannel; by: string; now?: number },
  ): ForgetRequest {
    if (input.channel !== "cli" && input.channel !== "admin") {
      throw new Error(
        `forget approve needs a non-model channel ("cli" or "admin"), got ${String(input.channel)} — a chat agreement can never authorise forgetting`,
      );
    }
    const req = this.requests.find((r) => r.id === id);
    if (!req) throw new Error(`no forget request ${id}`);
    if (req.status === "expired" || this.isExpired(req, input.now)) {
      req.status = "expired";
      this.saveRequests();
      throw new Error(`forget request ${id} has expired (7-day TTL)`);
    }
    if (req.status !== "pending") {
      throw new Error(`forget request ${id} is ${req.status}, cannot approve`);
    }
    req.status = "approved";
    req.approvedAt = input.now ?? Date.now();
    req.approvedBy = input.by;
    req.approvedChannel = input.channel;
    this.saveRequests();
    this.audit("forget.approved", {
      requestId: id,
      channel: input.channel,
      by: input.by,
    });
    return { ...req };
  }

  /** True when a pending request is past its 7-day TTL. Expired
   *  requests are marked on read (list/get/approve). */
  isExpired(req: ForgetRequest, now = Date.now()): boolean {
    return (
      req.status === "pending" &&
      now - req.createdAt > FORGET_REQUEST_TTL_MS
    );
  }

  /** Refresh expiry flags (called by list/get). */
  refreshExpiry(now = Date.now()): void {
    let changed = false;
    for (const r of this.requests) {
      if (r.status === "pending" && now - r.createdAt > FORGET_REQUEST_TTL_MS) {
        r.status = "expired";
        changed = true;
      }
    }
    if (changed) this.saveRequests();
  }

  /** Tombstone ids (hide). Called by core execution only, after
   *  the approval check. */
  tombstone(ids: string[], mode: ForgetMode, requestId: string, now = Date.now()): void {
    for (const id of ids) {
      this.forgotten[id] = { mode, at: now, requestId };
    }
    this.saveForgotten();
  }

  /** Clear tombstones (unhide). Admin/CLI only. */
  untombstone(ids: string[]): string[] {
    const cleared: string[] = [];
    for (const id of ids) {
      if (id in this.forgotten) {
        delete this.forgotten[id];
        cleared.push(id);
      }
    }
    if (cleared.length > 0) this.saveForgotten();
    this.audit("forget.unhidden", { entryIds: cleared });
    return cleared;
  }

  /** Mark executed + audit. The caller (core) performs the
   *  mutation; this only records the outcome. The audit write is
   *  checked: if it fails, the caller must treat the execution
   *  as unrecorded (core throws before mutating when the audit
   *  file is unwritable — see MemoryCore.executeForget). */
  markExecuted(id: string, by: string, now = Date.now()): ForgetRequest {
    const req = this.requests.find((r) => r.id === id);
    if (!req) throw new Error(`no forget request ${id}`);
    req.status = "executed";
    req.executedAt = now;
    req.executedBy = by;
    this.saveRequests();
    this.audit("forget.executed", {
      requestId: id,
      mode: req.mode,
      entryIds: req.entryIds,
      by,
    });
    return { ...req };
  }

  auditRaw(event: string, data: Record<string, unknown>): void {
    this.audit(event, data);
  }
}
