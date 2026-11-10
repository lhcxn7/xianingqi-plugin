// Atomic file writes: temp file in the same directory -> fsync ->
// rename over the target -> fsync the directory. A crash mid-write
// leaves either the complete old file or the complete new file, never
// a half-written one.

import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

export function ensureDir(dir: string): void {
  // 0.5.2: the data dir holds raw chat logs; create it owner-only on
  // POSIX (mode is ignored on Windows, where ACL inheritance applies).
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/** Windows: renameSync can throw EPERM/EACCES when the target is
 *  briefly held by antivirus/indexer (MoveFileEx behaviour,
 *  review-9 tip, unreproduced). Retry those two codes a few times
 *  with a tiny pause; anything else — or a fourth failure — throws
 *  as before. The happy path is unchanged: one rename, no delay. */
const RENAME_RETRY_CODES = new Set(["EPERM", "EACCES"]);
const RENAME_RETRIES = 3;
const RENAME_RETRY_MS = 15;

function renameWithRetry(tmp: string, path: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(tmp, path);
      return;
    } catch (err) {
      const code = (err as { code?: unknown } | null)?.code;
      if (
        typeof code !== "string" ||
        !RENAME_RETRY_CODES.has(code) ||
        attempt >= RENAME_RETRIES
      ) {
        throw err;
      }
      // Synchronous pause: atomicWriteText is a sync API, and
      // Atomics.wait is the stdlib way to sleep in place.
      Atomics.wait(
        new Int32Array(new SharedArrayBuffer(4)),
        0,
        0,
        RENAME_RETRY_MS,
      );
    }
  }
}

export function atomicWriteText(path: string, text: string): void {
  const dir = dirname(path);
  ensureDir(dir);
  const tmp = join(
    dir,
    `.tmp-${basename(path)}-${process.pid}-${randomBytes(4).toString("hex")}`,
  );
  // 0.5.1 (0.4.3 §四): the temp file is a memory-store copy, so it
  // is created 0o600, not world-readable; and a failed write now
  // removes its temp instead of leaving it behind.
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeFileSync(fd, text, "utf8");
    fsyncSync(fd);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // Best effort only — the original error is the one to report.
    }
    throw err;
  } finally {
    closeSync(fd);
  }
  try {
    renameWithRetry(tmp, path);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // Best effort only.
    }
    throw err;
  }
  // Best-effort directory fsync so the rename itself survives a crash.
  try {
    const dfd = openSync(dir, "r");
    try {
      fsyncSync(dfd);
    } finally {
      closeSync(dfd);
    }
  } catch {
    // Directory fsync is not supported on every platform; the rename
    // already happened, so this is only durability polish.
  }
}

/** Leftover temp files from interrupted writes (normally none). */
export function listTempLeftovers(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.startsWith(".tmp-"));
}

// 0.5.1 (0.4.3 §四): clear temp leftovers older than
// `olderThanMs` (default 60 s) from a directory — the age floor is
// what makes it safe against a concurrent writer: another process
// still holding its temp file has a fresh mtime, so it is never
// removed. Returns the removed names. Never throws: a failed
// cleanup must not take the caller down with it.
export function cleanTempLeftovers(
  dir: string,
  olderThanMs = 60_000,
): string[] {
  if (!existsSync(dir)) return [];
  const removed: string[] = [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const cutoff = Date.now() - olderThanMs;
  for (const name of names) {
    if (!name.startsWith(".tmp-")) continue;
    const full = join(dir, name);
    try {
      const st = statSync(full);
      if (st.mtimeMs > cutoff) continue;
      rmSync(full, { force: true });
      removed.push(name);
    } catch {
      // One leftover that will not go away is not a fatal error.
    }
  }
  return removed;
}

export interface CorruptBackup {
  /** Full path of the backup copy. */
  path: string;
  /** Size + mtime of the corrupt source file at backup time. */
  size: number;
  mtimeMs: number;
}

/** 0.5.1 (0.4.3 item 10): copy a store file that failed to parse
 *  to `<file>.corrupt-<ms>-<rand>` before anything overwrites it.
 *  `last` is the fingerprint of the file already backed up once:
 *  a second load failure of the same unchanged bytes backs up
 *  nothing (one backup per distinct corrupt content). Returns null
 *  when the file is missing/unreadable or already backed up. */
export function backupCorruptFile(
  file: string,
  last: { size: number; mtimeMs: number } | null,
): CorruptBackup | null {
  let st: { size: number; mtimeMs: number };
  try {
    st = statSync(file);
  } catch {
    return null;
  }
  if (
    last !== null &&
    last.size === st.size &&
    last.mtimeMs === st.mtimeMs
  ) {
    return null;
  }
  const backup = `${file}.corrupt-${Date.now()}-${randomBytes(4).toString("hex")}`;
  try {
    const data = readFileSync(file);
    writeFileSync(backup, data, { mode: 0o600 });
  } catch {
    return null;
  }
  return { path: backup, size: st.size, mtimeMs: st.mtimeMs };
}
