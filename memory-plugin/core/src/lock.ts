// Write lock for multi-process safety (0.1.6).
//
// Problem: the core assumed it was the only writer of the data folder
// (one DSH process). Two processes writing the same log.jsonl at once
// could interleave appends and, worse, overwrite each other's
// index.json with a stale in-memory index — entries were lost from
// recall even though the log lines survived.
//
// Design: an atomic-mkdir lock directory, <dataDir>/.locks/write.lock.
// mkdir is atomic on both POSIX and Windows: exactly one process wins
// the creation, the rest get EEXIST. No flock (POSIX-only), no lock
// file with O_EXCL (advisory only on some platforms) — mkdir is the
// portable primitive.
//
// - Acquire: mkdir the lock dir; on EEXIST, check staleness, else
//   retry until the timeout (default 5 s) and then throw — the caller
//   (record/flush/...) reports the failure, it never silently drops
//   a record. A lock is stale ONLY when it is both old (mtime over
//   30 s) and ownerless (the pid recorded in owner.json no longer
//   exists). A fresh lock, or one whose owner is alive, is never
//   broken — a slow rollover must not lose its lock to an impatient
//   waiter.
// - Owner record: owner.json inside the lock dir ({pid, token,
//   time}). The token lets release() verify it still owns the lock:
//   if another process broke our lock and took it, our release must
//   not delete theirs.
// - Release: remove the lock dir (only if the token still matches),
//   then best-effort remove the empty .locks parent. A crash while
//   holding the lock leaves the dir behind; the next acquirer breaks
//   it once it is stale (30 s + dead pid).
// - The lock serialises WRITES only (record, rollover, flush,
//   snapshot, restore, endSession). Reads never take it — a torn log
//   line is skipped on read, and the index fingerprint check rebuilds
//   a stale index. Two MemoryCore instances in the SAME process share
//   the on-disk lock too; within one instance the lock is re-entrant
//   (record() -> rollover() must not deadlock on itself).
// - Known limitation, unchanged: instances do NOT share in-memory
//   state. A process only recalls what it has loaded; entries written
//   by another process become visible to it at the next flush (which
//   reloads when the log files changed) or restart. The lock
//   guarantees no lost or corrupt writes on disk; it does not make
//   two processes see each other's unflushed memory.

import { randomBytes } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export const LOCK_DIR_NAME = ".locks";
export const LOCK_NAME = "write.lock";
/** How long acquire() waits for a held lock before giving up. */
export const DEFAULT_LOCK_TIMEOUT_MS = 5000;
/** A lock older than this AND whose owner pid is dead may be broken. */
export const DEFAULT_LOCK_STALE_MS = 30_000;
/** Sleep between acquire retries. */
export const DEFAULT_LOCK_RETRY_MS = 25;

export interface LockOptions {
  /** Max wait for the lock. Default 5000 ms. */
  timeoutMs?: number;
  /** Age past which a lock with a dead owner is stale. Default 30000 ms. */
  staleMs?: number;
  /** Sleep between retries. Default 25 ms. */
  retryMs?: number;
}

export interface LockOwner {
  pid: number;
  token: string;
  time: number;
}

export function lockDirPath(dataDir: string): string {
  return join(dataDir, LOCK_DIR_NAME, LOCK_NAME);
}

/** Synchronous sleep. Atomics.wait is the only sync sleep in Node;
 *  unlike browsers, Node allows it on the main thread, and it works
 *  on Windows. */
function sleepSync(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** True when the pid exists. process.kill(pid, 0) tests existence on
 *  POSIX and on Windows; ESRCH means dead, EPERM means alive but
 *  un-signallable, anything else is treated as alive (conservative —
 *  never break a lock whose owner might be alive). */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ESRCH") return false;
    return true;
  }
}

function readOwner(dir: string): LockOwner | null {
  try {
    const parsed = JSON.parse(
      readFileSync(join(dir, "owner.json"), "utf8"),
    ) as Partial<LockOwner>;
    if (typeof parsed.pid === "number" && typeof parsed.token === "string") {
      return {
        pid: parsed.pid,
        token: parsed.token,
        time: typeof parsed.time === "number" ? parsed.time : 0,
      };
    }
  } catch {
    // Missing or corrupt: no owner record.
  }
  return null;
}

function lockAgeMs(dir: string): number {
  try {
    return Date.now() - statSync(dir).mtimeMs;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/** A lock is stale only when it is BOTH old and ownerless: mtime over
 *  staleMs AND the recorded pid no longer exists. A lock dir with no
 *  owner record at all (crashed between mkdir and writing owner.json)
 *  counts as ownerless once it is old. */
export function isLockStale(dir: string, staleMs: number): boolean {
  if (lockAgeMs(dir) <= staleMs) return false;
  const owner = readOwner(dir);
  if (!owner) return true;
  return !isPidAlive(owner.pid);
}

function breakLock(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/**
 * Acquire the write lock for a data directory. Returns a release
 * function; the caller MUST call it (use try/finally). Throws when
 * the lock cannot be acquired within timeoutMs — the caller reports
 * the failure, it never silently drops the write.
 */
export function acquireWriteLock(
  dataDir: string,
  opts: LockOptions = {},
): () => void {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const staleMs = opts.staleMs ?? DEFAULT_LOCK_STALE_MS;
  const retryMs = opts.retryMs ?? DEFAULT_LOCK_RETRY_MS;
  const dir = lockDirPath(dataDir);
  const token = `${process.pid}-${Date.now()}-${randomBytes(4).toString("hex")}`;
  const deadline = Date.now() + timeoutMs;
  // The parent .locks dir is idempotent to create; the lock dir
  // itself is the atomic unit below.
  mkdirSync(join(dataDir, LOCK_DIR_NAME), { recursive: true });
  for (;;) {
    try {
      mkdirSync(dir);
      // We own it: record who we are, then hand back the releaser.
      writeFileSync(
        join(dir, "owner.json"),
        `${JSON.stringify({ pid: process.pid, token, time: Date.now() })}\n`,
        "utf8",
      );
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try {
          // Only remove a lock we still own: if someone broke our
          // lock and took it, their token differs and we must not
          // delete theirs.
          const owner = readOwner(dir);
          if (owner && owner.token !== token) return;
          rmSync(dir, { recursive: true, force: true });
        } catch {
          // Already gone (broken as stale, or removed).
        }
        try {
          // Best-effort: drop the empty .locks parent so a clean
          // data folder shows no trace of the lock.
          rmSync(join(dataDir, LOCK_DIR_NAME), { recursive: false });
        } catch {
          // Not empty (another lock landed) or already gone.
        }
      };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code !== "EEXIST") throw err;
      // Someone holds it. Break it only if stale, else wait for it.
      if (isLockStale(dir, staleMs)) {
        try {
          breakLock(dir);
        } catch {
          // Lost the race to another breaker; retry the mkdir.
        }
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `could not acquire write lock ${dir} within ${timeoutMs}ms (another process holds it)`,
        );
      }
      sleepSync(Math.min(retryMs, Math.max(0, deadline - Date.now())));
    }
  }
}

/** Run fn holding the write lock; the lock is always released. */
export function withWriteLock<T>(
  dataDir: string,
  fn: () => T,
  opts?: LockOptions,
): T {
  const release = acquireWriteLock(dataDir, opts);
  try {
    return fn();
  } finally {
    release();
  }
}
