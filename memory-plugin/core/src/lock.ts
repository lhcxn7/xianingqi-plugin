// Write lock for multi-process safety (0.1.6; redesigned 0.1.7).
//
// Problem: the core assumed it was the only writer of the data folder
// (one DSH process). Two processes writing the same log.jsonl at once
// could interleave appends and, worse, overwrite each other's
// index.json with a stale in-memory index — entries were lost from
// recall even though the log lines survived.
//
// Design (redesigned after the deep review of package v5, Major M-01;
// hardened again after the deep review of package v6, Major M-01):
// TWO locks, not one. The canonical lock dir is NEVER moved — every
// earlier design moved it (rename to a quarantine to verify a token),
// and every move opened a window in which the canonical path was
// temporarily missing: a third process could take it, and restoring
// the moved lock could then fail, leaving two processes believing
// they held the lock.
//
// The v6 arbiter redesign closed that hole for the canonical lock
// but left the SAME hole in the arbiter itself: the arbiter was
// broken and released by RENAME (to a quarantine, to verify the
// token/staleness). A rename is unconditional — it moves whatever is
// at the path. An old process whose stale judgement predates a new
// holder's acquire can rename the NEW holder's live arbiter away;
// the rename-back can fail, and in the window the arbiter path is
// free, so a third process takes it and two processes hold the
// arbiter at once. With two arbiter holders the canonical
// check-then-delete is no longer serialised, and a stale reclaim
// judged from an old read can land after a new holder's acquire and
// delete its live write lock. Claude's deep review of package v6
// reproduced exactly that.
//
// The fix (this version): NO RENAMES ANYWHERE IN THIS FILE.
// No rename call appears in this file at all. No path is ever
// moved, so no process can ever move another's lock. Instead:
// - Arbiter break: read the owner in place, verify it is stale
//   (old + dead pid, or no owner + very old), then re-read the
//   owner immediately before deleting and delete in place ONLY if
//   the token is still the same stale owner. A new holder that
//   took the path after our judgement carries a different token
//   and is never deleted — except for a known microsecond window
//   when TWO breakers handle the same stale arbiter: B reads the
//   old owner, A deletes it, C mkdirs a live arbiter, and B's
//   rmSync then deletes C's live lock. That needs three-process
//   interleaving and is accepted; the canonical side has a token
//   re-verification backstop, so a wrongly deleted arbiter cannot
//   let a stale reclaim delete a live canonical lock.
// - Arbiter release: read the owner in place, delete in place
//   ONLY on a token match. A mismatch (or a gone dir) means it
//   is not ours — leave it. A live arbiter is never deleted by a
//   breaker (its pid is alive), so a holder's own dir is always
//   still at the path when it releases; the orphan race of the
//   rename design (a breaker moving the dir while its holder
//   releases it) cannot happen, and the 50 ms release retry is
//   gone with it.
// - Canonical reclaim: the same token re-verification. A stale
//   judgement is made from a read; before deleting, re-read the
//   owner and delete ONLY if the token is still the same stale
//   owner. A new holder that took the path after the judgement
//   carries a different token and is never deleted. This is the
//   defence in depth that keeps a live canonical lock safe even
//   if two processes ever overlapped in the arbiter.
// - Canonical release: already an in-place token check (read the
//   owner, rmSync only if the token still matches). Unchanged.
//
// - Canonical lock: <dataDir>/.locks/write.lock (a directory,
//   owner.json inside, {pid, token, time}). Acquired by atomic
//   mkdir (exactly one process wins, the rest get EEXIST — the
//   portable primitive; no flock, no O_EXCL). Released by rmSync,
//   but ONLY after an in-place token check (see below). A stale
//   canonical lock is reclaimed by rmSync, again only after an
//   in-place staleness check plus a token re-verification. No
//   rename touches this path, ever.
// - Arbiter: <dataDir>/.locks/arbiter.lock (a directory, owner.json
//   inside). Acquired by atomic mkdir, released by an in-place
//   token-checked delete (a plain rmdir cannot remove it, the dir
//   holds owner.json). EVERY operation on the canonical lock —
//   claim (mkdir), release (rmSync), reclaim (rmSync of a stale
//   lock) — is done while holding the arbiter, and the arbiter is
//   held only for the few synchronous filesystem calls of one
//   critical section (never across a sleep or a wait), so a waiter
//   can never deadlock a releaser.
//
// - Staleness: a canonical lock is stale ONLY when it is BOTH old
//   (mtime over staleMs, default 30 s) AND ownerless (the pid in
//   owner.json no longer exists). A fresh lock, or one whose owner
//   is alive, is never broken. A lock dir with NO owner record
//   (crashed between mkdir and writing owner.json) is stale only
//   once very old (60 s) — a fresh one is mid-creation, not stale.
// - The arbiter is stale when it is old (mtime over 1 s — a
//   critical section is a few synchronous calls, so 1 s is far
//   beyond any legitimate hold) AND its owner pid is dead (or it
//   never wrote an owner record). A stale arbiter is reclaimed by
//   the in-place delete above (never a rename).
// - Release: acquire the arbiter, read the owner in place, rmSync
//   only if the token still matches, release the arbiter. If the
//   arbiter cannot be acquired (stuck), fall back to the in-place
//   read + rmSync without it — safe, because there are no renames
//   of the canonical path and a live lock can never be broken. Then
//   best-effort remove the empty .locks parent.
// - The lock serialises WRITES only (record, rollover, flush,
//   snapshot, restore, endSession). Reads never take it — a torn log
//   line is skipped on read, and the index fingerprint check rebuilds
//   a stale index. Two MemoryCore instances in the SAME process share
//   the on-disk lock too; within one instance the lock is re-entrant
//   (record() -> rollover() must not deadlock on itself) — that is
//   handled by a depth counter in core.ts, not here.
// - Known limitation, unchanged: instances do NOT share in-memory
//   state. A process only recalls what it has loaded; entries written
//   by another process become visible to it at the next flush (which
//   reloads when the log files changed) or restart. The lock
//   guarantees no lost or corrupt writes on disk; it does not make
//   two processes see each other's unflushed memory.

import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";

export const LOCK_DIR_NAME = ".locks";
export const LOCK_NAME = "write.lock";
/** How long acquire() waits for a held lock before giving up. */
export const DEFAULT_LOCK_TIMEOUT_MS = 5000;
/** A lock older than this AND whose owner pid is dead may be broken. */
export const DEFAULT_LOCK_STALE_MS = 30_000;
/** Sleep between acquire retries. */
export const DEFAULT_LOCK_RETRY_MS = 25;
/** Arbiter directory name (serialises all canonical-lock operations). */
export const ARBITER_NAME = "arbiter.lock";
/** An arbiter older than this AND whose owner pid is dead may be broken.
 *  A critical section is a few synchronous calls, so 1 s is far beyond
 *  any legitimate hold. 1 s (not 5 s, as before) is what keeps the
 *  arbiter break from racing the caller's acquire timeout: the old
 *  5 s matched the default canonical acquire timeout exactly, so a
 *  waiter could time out at the same instant the break became
 *  possible. 1 s is well below both the 5 s canonical timeout and
 *  the 500 ms arbiter attempt window's retry loop. */
export const ARBITER_STALE_MS = 1_000;
/** Per-attempt timeout for acquiring the arbiter (the canonical
 *  acquire loop retries until its own deadline). */
export const ARBITER_TIMEOUT_MS = 500;
/** Sleep between arbiter retries. */
export const ARBITER_RETRY_MS = 5;
/** A lock dir with no owner record is stale only once very old — a
 *  fresh one is mid-creation (mkdir done, owner.json not yet written),
 *  not stale. */
export const NULL_OWNER_STALE_MS = 60_000;

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
  // 0.5.1 (0.4.3 §四): liveness used to be pid-only, which is only
  // meaningful on the machine that wrote the lock — a pid from
  // another host (shared/network data dir) can never be verified
  // here, so a cross-host lock is never broken (see isOwnerForeign).
  // `host` is the writer's hostname; `startedAt` is when the
  // writer's process started (epoch ms, for diagnosis — a lock
  // whose owner started long before the lock file is suspicious).
  // Both are optional: owner.json rows written before 0.5.1 have
  // neither, and keep the old pid-only behaviour.
  host?: string;
  startedAt?: number;
}

/** This machine's hostname, captured once (see LockOwner). */
const HOSTNAME = hostname();
/** This process's start time (epoch ms), captured once — Date.now()
 *  minus process uptime, approximate to ~1 s. */
const PROCESS_STARTED_AT =
  Date.now() - Math.floor(process.uptime() * 1000);

function ownerRecord(token: string): LockOwner {
  return {
    pid: process.pid,
    token,
    time: Date.now(),
    host: HOSTNAME,
    startedAt: PROCESS_STARTED_AT,
  };
}

/** True when the owner record names a different host — a pid from
 *  there cannot be verified from here, so the lock is never stale
 *  on that evidence alone. An owner with no host field predates
 *  0.5.1 and keeps the old pid-only behaviour. */
function isOwnerForeign(owner: LockOwner): boolean {
  return (
    typeof owner.host === "string" &&
    owner.host.length > 0 &&
    owner.host !== HOSTNAME
  );
}

export function lockDirPath(dataDir: string): string {
  return join(dataDir, LOCK_DIR_NAME, LOCK_NAME);
}

export function arbiterDirPath(dataDir: string): string {
  return join(dataDir, LOCK_DIR_NAME, ARBITER_NAME);
}

/** Synchronous sleep. Atomics.wait is the only sync sleep in Node;
 *  unlike browsers, Node allows it on the main thread, and it works
 *  on Windows. */
function sleepSync(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Jittered retry sleep for the arbiter spin loop. A fixed sleep lets
 *  several waiters synchronise and starve each other (one worker
 *  re-acquiring the arbiter on every cycle while another never wins
 *  a 500 ms attempt window); a random 5–15 ms sleep desynchronises
 *  them and gives every waiter a fair chance to catch the arbiter
 *  free. Capped by the remaining deadline by the caller. */
function arbiterRetrySleep(deadline: number): void {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return;
  const ms = ARBITER_RETRY_MS + Math.floor(Math.random() * 11);
  sleepSync(Math.min(ms, remaining));
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
        ...(typeof parsed.host === "string" ? { host: parsed.host } : {}),
        ...(typeof parsed.startedAt === "number"
          ? { startedAt: parsed.startedAt }
          : {}),
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

/** Debug trace (env LOCK_TRACE=1): appends one JSON line per arbiter
 *  acquire/release/break to <dataDir>/arbiter-trace.log. Off by
 *  default; used to diagnose a stuck-arbiter flake in testing. */
function traceArbiter(dataDir: string, action: string, token: string): void {
  if (process.env.LOCK_TRACE !== "1") return;
  try {
    appendFileSync(
      join(dataDir, "arbiter-trace.log"),
      `${JSON.stringify({ t: Date.now(), pid: process.pid, action, token: token.slice(0, 24) })}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
  } catch {
    // Tracing must never break the lock.
  }
}
/** Return the owner of a lock dir ONLY when the lock is stale
 *  (old + dead owner), or the string "no-owner" when the dir has
 *  no owner record and is very old (mid-creation is not stale).
 *  Returns null when the lock is live or fresh. The caller uses
 *  the returned token to re-verify the dir immediately before
 *  deleting it: a new holder that took the path after this
 *  judgement carries a different token and must never be deleted. */
function staleOwnerIfStale(
  dir: string,
  staleMs: number,
): LockOwner | "no-owner" | null {
  if (lockAgeMs(dir) <= staleMs) return null;
  const owner = readOwner(dir);
  if (!owner) return lockAgeMs(dir) > NULL_OWNER_STALE_MS ? "no-owner" : null;
  // 0.5.1 (§四): a foreign host's pid cannot be verified here —
  // the lock is never stale on pid evidence alone.
  if (isOwnerForeign(owner)) return null;
  return isPidAlive(owner.pid) ? null : owner;
}

export function isLockStale(dir: string, staleMs: number): boolean {
  return staleOwnerIfStale(dir, staleMs) !== null;
}

/** Delete a lock dir, but ONLY if it still carries the expected
 *  owner token. Reads the owner in place immediately before
 *  deleting; a different token (a new holder took the path after
 *  the stale judgement) or a gone dir means: do not delete.
 *  Used for BOTH the arbiter break and the canonical reclaim.
 *  No rename is involved anywhere: a rename moves whatever is
 *  at the path, and an old process's stale judgement can move a
 *  new holder's live lock (the v6 deep review, Major M-01). */
function deleteDirIfOwnerMatches(
  dir: string,
  expected: LockOwner | "no-owner",
): boolean {
  const current = readOwner(dir);
  if (expected === "no-owner") {
    if (current) return false; // an owner appeared — do not delete
  } else if (!current || current.token !== expected.token) {
    return false; // changed hands — do not delete
  }
  // TEST HOOK (env LOCK_TEST_RECLAIM_FAIL): pretend the delete
  // failed (e.g. the lock dir held open by another process on
  // Windows), so a test can prove acquireWriteLock still yields
  // and times out instead of tight-looping. Off by default;
  // never set in production. (Follows the LOCK_TEST_BREAK_DELAY_MS
  // precedent in breakArbiter below.)
  if (process.env.LOCK_TEST_RECLAIM_FAIL === "1") return false;
  try {
    rmSync(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false; // already gone, or held open (Windows)
  }
}

/** Release the arbiter: delete our own arbiter dir in place, but
 *  ONLY on a token match. No rename: a rename moves whatever is at
 *  the path, and an old process's stale judgement can move a new
 *  holder's live arbiter (the v6 deep review, Major M-01). Here the
 *  holder reads the owner in place and deletes only its own dir;
 *  a mismatch (or a gone dir) means it is not ours — leave it.
 *  A live arbiter is never deleted by a breaker (its pid is alive),
 *  so a holder's own dir is always still at the path when it
 *  releases; the orphan race of the rename design (a breaker moving
 *  the dir while its holder releases it) cannot happen. (A plain
 *  rmdir cannot be used here: the arbiter dir is non-empty — it
 *  holds owner.json — so rmdir would fail with ENOTEMPTY and the
 *  arbiter would be stuck forever.) */
function releaseArbiterDir(dir: string, token: string): void {
  // dataDir is the grandparent of the lock dir (<dataDir>/.locks/<name>).
  const dataDir = dirname(dirname(dir));
  const owner = readOwner(dir);
  if (!owner || owner.token !== token) {
    traceArbiter(dataDir, "release-mismatch-or-gone", token);
    return; // not ours (or already gone) — leave it alone.
  }
  try {
    rmSync(dir, { recursive: true, force: true });
    traceArbiter(dataDir, "release-deleted", token);
  } catch {
    traceArbiter(dataDir, "release-rm-failed", token);
    // Already out of the way.
  }
}

function isArbiterStale(dir: string): boolean {
  if (lockAgeMs(dir) <= ARBITER_STALE_MS) return false;
  const owner = readOwner(dir);
  if (!owner) return true;
  // 0.5.1 (§四): a foreign host's pid cannot be verified here.
  if (isOwnerForeign(owner)) return false;
  return !isPidAlive(owner.pid);
}

/** Reclaim a stale arbiter by deleting it in place. No rename:
 *  the old design renamed the arbiter to a quarantine before
 *  verifying it was stale, and a stale judgement from an old read
 *  could move a NEW holder's live arbiter (Claude's v6 deep
 *  review, Major M-01). Here the owner is captured first, then
 *  deleteDirIfOwnerMatches re-reads the token immediately before
 *  deleting and deletes ONLY if it is still the same stale owner.
 *  A new holder that took the path after the judgement carries a
 *  different token and is never deleted. A no-owner arbiter is
 *  stale once older than the arbiter threshold (a critical section
 *  is a few sync calls, so a no-owner arbiter older than 1 s is
 *  not mid-creation) — matching isArbiterStale. */
function breakArbiter(dir: string): void {
  const dataDir = dirname(dirname(dir));
  const owner = readOwner(dir);
  const age = lockAgeMs(dir);
  let expected: LockOwner | "no-owner";
  if (!owner) {
    if (age <= ARBITER_STALE_MS) return; // fresh, possibly mid-creation
    expected = "no-owner";
  } else {
    // 0.5.1 (§四): a foreign host's pid cannot be verified here.
    if (isOwnerForeign(owner)) return;
    if (isPidAlive(owner.pid)) return; // live — do not touch
    if (age <= ARBITER_STALE_MS) return; // fresh — do not touch
    expected = owner;
  }
  // TEST HOOK (env LOCK_TEST_BREAK_DELAY_MS): sleep here, after
  // capturing the stale owner but before deleting. Lets a test
  // deterministically reproduce the v6 deep-review interleaving
  // (a breaker whose stale judgement predates a new holder's
  // acquire): while this breaker sleeps, another process takes the
  // arbiter with a fresh token, and the delete below must then
  // refuse to delete it. Off by default; never set in production.
  const delayMs = Number(process.env.LOCK_TEST_BREAK_DELAY_MS ?? 0);
  if (delayMs > 0) sleepSync(delayMs);
  const deleted = deleteDirIfOwnerMatches(dir, expected);
  traceArbiter(
    dataDir,
    deleted ? "break-deleted" : "break-skipped-changed",
    expected === "no-owner" ? "no-owner" : expected.token,
  );
}

/** Acquire the arbiter (serialises one critical section on the
 *  canonical lock). Returns a release function; the caller MUST call
 *  it (use try/finally) and MUST NOT sleep or wait while holding it.
 *  Throws when the arbiter cannot be acquired within timeoutMs. */
function acquireArbiter(dataDir: string, timeoutMs: number): () => void {
  const dir = arbiterDirPath(dataDir);
  const token = `${process.pid}-${Date.now()}-${randomBytes(4).toString("hex")}`;
  const deadline = Date.now() + timeoutMs;
  mkdirSync(join(dataDir, LOCK_DIR_NAME), { recursive: true });
  for (;;) {
    try {
      mkdirSync(dir);
      writeFileSync(
        join(dir, "owner.json"),
        `${JSON.stringify(ownerRecord(token))}\n`,
        "utf8",
      );
      // Holder re-validation: a breaker can only delete a STALE
      // arbiter (dead pid), and ours is fresh with a live pid, so
      // it cannot be removed between mkdir and here. The check is
      // a safety net (e.g. a crashed write left no owner record).
      // Only proceed when our dir is present with our token;
      // otherwise retry. Never rmdir here — the dir may already
      // be someone else's.
      const owner = readOwner(dir);
      if (owner && owner.token === token) {
        traceArbiter(dataDir, "acquire", token);
        let released = false;
        return () => {
          if (released) return;
          released = true;
          // In-place token-checked delete (see releaseArbiterDir):
          // never a plain rmdir (the dir holds owner.json, so
          // rmdir would fail ENOTEMPTY and strand the arbiter)
          // and never a blind rmSync (it could delete a new
          // holder's arbiter).
          traceArbiter(dataDir, "release", token);
          releaseArbiterDir(dir, token);
        };
      }
      // Our arbiter was removed or replaced before we validated
      // it; do not enter the critical section. Retry after a
      // short sleep.
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code === "ENOENT") {
        // The .locks parent was removed by another process's release
        // while we waited. Recreate it and retry.
        mkdirSync(join(dataDir, LOCK_DIR_NAME), { recursive: true });
        continue;
      }
      if (code !== "EEXIST") throw err;
      // Someone holds it — or it is our own arbiter from a
      // previous attempt in this same acquire (mkdir succeeded
      // but the owner write was interrupted, and we are retrying).
      const owner = readOwner(dir);
      if (owner && owner.token === token) {
        traceArbiter(dataDir, "acquire-restored", token);
        let released = false;
        return () => {
          if (released) return;
          released = true;
          traceArbiter(dataDir, "release", token);
          releaseArbiterDir(dir, token);
        };
      }
      if (isArbiterStale(dir)) {
        traceArbiter(dataDir, "break-stale", token);
        try {
          breakArbiter(dir);
        } catch {
          // Lost the race to another breaker; retry the mkdir.
        }
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `could not acquire arbiter lock ${dir} within ${timeoutMs}ms (another process holds it)`,
        );
      }
      arbiterRetrySleep(deadline);
      continue;
    }
    // Validation failed after a successful mkdir: sleep briefly, then
    // retry the whole acquire (our arbiter was moved; it will be
    // restored or deleted, and the next attempt resolves it).
    if (Date.now() >= deadline) {
      throw new Error(
        `could not acquire arbiter lock ${dir} within ${timeoutMs}ms (validation failed)`,
      );
    }
    arbiterRetrySleep(deadline);
  }
}

/**
 * Acquire the write lock for a data directory. Returns a release
 * function; the caller MUST call it (use try/finally). Throws when
 * the lock cannot be acquired within timeoutMs — the caller reports
 * the failure, it never silently drops the write.
 *
 * Every critical section on the canonical lock runs under the
 * arbiter (see the header). The arbiter is never held across a
 * sleep or a wait, so a waiter can never deadlock a releaser.
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
  mkdirSync(join(dataDir, LOCK_DIR_NAME), { recursive: true });
  let lastArbiterError: string | null = null;
  let firstArbiterError: string | null = null;
  let arbiterAttempts = 0;
  // 0.4.6 (0.4.3 audit item 16): stale-lock reclaim attempts
  // that failed (delete refused or rm threw) — counted so the
  // timeout error can say what happened.
  let reclaimFailures = 0;
  for (;;) {
    // One critical section: try to take the lock, or break a stale
    // one, while holding the arbiter. If the arbiter itself cannot
    // be acquired in this attempt, treat it as a wait and retry
    // until the outer deadline.
    let releaseArbiter: (() => void) | null = null;
    try {
      arbiterAttempts++;
      releaseArbiter = acquireArbiter(
        dataDir,
        Math.min(ARBITER_TIMEOUT_MS, Math.max(0, deadline - Date.now())),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!firstArbiterError) firstArbiterError = msg;
      lastArbiterError = msg;
      if (Date.now() >= deadline) {
        // Diagnostic: who holds the arbiter right now, and how old is it?
        let arbiterState = "(arbiter dir gone)";
        try {
          const arbOwner = readOwner(arbiterDirPath(dataDir));
          const age = Math.round(lockAgeMs(arbiterDirPath(dataDir)));
          arbiterState = arbOwner
            ? `pid=${arbOwner.pid} alive=${isPidAlive(arbOwner.pid)} ageMs=${age}`
            : `no owner, ageMs=${age}`;
        } catch (e) {
          arbiterState = `(read failed: ${e instanceof Error ? e.message : String(e)})`;
        }
        throw new Error(
          `could not acquire write lock ${dir} within ${timeoutMs}ms (arbiter unavailable; ${arbiterAttempts} attempts, first: ${firstArbiterError}, last: ${lastArbiterError}; arbiter now: ${arbiterState})`,
        );
      }
      sleepSync(Math.min(retryMs, Math.max(0, deadline - Date.now())));
      continue;
    }
    try {
      try {
        mkdirSync(dir);
        writeFileSync(
          join(dir, "owner.json"),
          `${JSON.stringify(ownerRecord(token))}\n`,
          "utf8",
        );
        // We own it: hand back the releaser (which re-acquires the
        // arbiter to release — the arbiter is freed here, before we
        // return, so the lock is held by the canonical dir alone
        // from this point on).
        let released = false;
        return () => {
          if (released) return;
          released = true;
          // Normal path: delete our lock under the arbiter.
          let deleted = false;
          try {
            const relArb = acquireArbiter(dataDir, ARBITER_TIMEOUT_MS);
            try {
              const owner = readOwner(dir);
              if (owner && owner.token === token) {
                rmSync(dir, { recursive: true, force: true });
                deleted = true;
              }
            } finally {
              relArb();
            }
          } catch {
            // Arbiter unavailable: fall back to the in-place check
            // + delete without it. Safe: there are no renames of
            // the canonical path, and a live lock can never be
            // broken, so this delete can only remove our own lock
            // (or nothing, if it is already gone).
            try {
              const owner = readOwner(dir);
              if (owner && owner.token === token) {
                rmSync(dir, { recursive: true, force: true });
                deleted = true;
              }
            } catch {
              // Already gone.
            }
          }
          void deleted;
          try {
            // Best-effort: drop the empty .locks parent so a clean
            // data folder shows no trace of the lock.
            rmdirSync(join(dataDir, LOCK_DIR_NAME));
          } catch {
            // Not empty (another lock landed) or already gone.
          }
        };
      } catch (err) {
        const code = (err as NodeJS.ErrnoException | undefined)?.code;
        if (code === "ENOENT") {
          // The .locks parent was removed by another process's
          // release while we waited. Recreate it and retry.
          mkdirSync(join(dataDir, LOCK_DIR_NAME), { recursive: true });
          continue;
        }
        if (code !== "EEXIST") throw err;
        // Someone holds it. The staleness judgement and the reclaim
        // below run under the arbiter, so normally no other process
        // can change the canonical dir in between — but the arbiter
        // itself can be broken while stale, so do NOT rely on that
        // alone: capture the stale owner and re-verify its token
        // immediately before deleting (deleteDirIfOwnerMatches).
        // A new holder that took the path after the judgement
        // carries a different token and is never deleted — this is
        // what keeps a live canonical lock safe even if two
        // processes ever overlapped in the arbiter (the v6 deep
        // review, Major M-01).
        const stale = staleOwnerIfStale(dir, staleMs);
        if (stale !== null) {
          if (deleteDirIfOwnerMatches(dir, stale)) {
            // The stale lock is gone; take the now-free dir.
            continue;
          }
          // 0.4.6 (0.4.3 audit item 16): the reclaim failed — the
          // dir changed hands, or the rm threw (on Windows a lock
          // dir held open by another process cannot be removed).
          // Do NOT `continue` here: the old code continued on
          // both branches, skipping the deadline check and the
          // sleep below, so a permanently failing reclaim spun
          // forever without yielding or ever timing out. Fall
          // through to the deadline/sleep like a live lock, and
          // count the failure for the timeout error.
          reclaimFailures += 1;
        }
        // Live lock, or a stale lock whose reclaim failed: wait
        // for it (arbiter freed below, before we sleep).
      }
    } finally {
      releaseArbiter();
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `could not acquire write lock ${dir} within ${timeoutMs}ms (another process holds it)` +
          (reclaimFailures > 0
            ? `; ${reclaimFailures} stale-lock reclaim attempt(s) failed`
            : ""),
      );
    }
    sleepSync(Math.min(retryMs, Math.max(0, deadline - Date.now())));
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
