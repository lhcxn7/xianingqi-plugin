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
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
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
  const fd = openSync(tmp, "w");
  try {
    writeFileSync(fd, text, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameWithRetry(tmp, path);
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
