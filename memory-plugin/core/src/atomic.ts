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
  renameSync(tmp, path);
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
