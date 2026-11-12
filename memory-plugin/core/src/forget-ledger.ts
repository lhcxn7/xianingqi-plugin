// 终版 WP2 — the delete ledger.
//
// `forget-audit.jsonl` records what happened, but it is an audit, not
// a state machine. A restore copies `log.jsonl` and the stores back to
// snapshot time; a snapshot taken before a delete still contains the
// deleted words. The ledger is the durable answer: every physical
// delete appends its ids here, every rollback appends a cancellation,
// and a restore replays the net set after the snapshot is copied.
//
// Deliberately NOT in the snapshot whitelist (see snapshot.ts): a
// restore must never rewind the record of a deletion.
//
// Append-only, one JSON line per event:
//   {"ts":..., "event":"delete",   "ids":[...], "requestId":..., "by":...}
//   {"ts":..., "event":"rollback", "ids":[...], "requestId":...}

import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const FORGET_LEDGER_FILE = "forget-ledger.jsonl";

export type ForgetLedgerEventType = "delete" | "rollback";

export interface ForgetLedgerEvent {
  ts: number;
  event: ForgetLedgerEventType;
  ids: string[];
  requestId?: string;
  by?: string;
}

export function appendForgetLedger(
  dataDir: string,
  event: Omit<ForgetLedgerEvent, "ts"> & { ts?: number },
): void {
  const row: ForgetLedgerEvent = {
    ts: event.ts ?? Date.now(),
    event: event.event,
    ids: event.ids.filter((id) => typeof id === "string" && id.length > 0),
    ...(event.requestId !== undefined ? { requestId: event.requestId } : {}),
    ...(event.by !== undefined ? { by: event.by } : {}),
  };
  appendFileSync(join(dataDir, FORGET_LEDGER_FILE), `${JSON.stringify(row)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

/** Read the ledger. Corrupt lines are skipped (the rest still apply);
 *  a missing file is an empty ledger. Never throws. */
export function loadForgetLedger(dataDir: string): ForgetLedgerEvent[] {
  let raw: string;
  try {
    raw = readFileSync(join(dataDir, FORGET_LEDGER_FILE), "utf8");
  } catch {
    return [];
  }
  const out: ForgetLedgerEvent[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as Partial<ForgetLedgerEvent>;
      if (
        (row.event === "delete" || row.event === "rollback") &&
        Array.isArray(row.ids)
      ) {
        out.push({
          ts: typeof row.ts === "number" ? row.ts : 0,
          event: row.event,
          ids: row.ids.filter(
            (id): id is string => typeof id === "string" && id.length > 0,
          ),
          ...(typeof row.requestId === "string"
            ? { requestId: row.requestId }
            : {}),
          ...(typeof row.by === "string" ? { by: row.by } : {}),
        });
      }
    } catch {
      // Skip a torn/unknown line; it cannot be proven to be a delete.
    }
  }
  return out;
}

/** Net set of ids whose physical delete stands after all rollbacks. */
export function deletedIdsFromLedger(dataDir: string): Set<string> {
  const out = new Set<string>();
  for (const event of loadForgetLedger(dataDir)) {
    if (event.event === "delete") {
      for (const id of event.ids) out.add(id);
    } else {
      for (const id of event.ids) out.delete(id);
    }
  }
  return out;
}
