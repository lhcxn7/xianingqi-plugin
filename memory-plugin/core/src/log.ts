// Append-only log: one JSON object per line in log.jsonl. This is the
// source of truth for raw messages; MEMORY.md is the human-readable
// three-layer view built on top of it. A torn last line (crash
// mid-append) is skipped on read, never fatal.

import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";
import { atomicWriteText } from "./atomic.ts";
import type { MemoryEntry } from "./types.ts";

const WARNED_CORRUPT = new Set<string>();

export class AppendLog {
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  /** Append one entry and fsync, so a power loss after the call returns
   *  does not lose the tail. (A process crash alone would not lose it;
   *  the fsync is for the power-loss case.) */
  append(entry: MemoryEntry): void {
    // 0.5.2: the raw chat log is created owner-only on POSIX (umask
    // 022 used to make it 0644). Existing files are not chmod-ed here.
    const fd = openSync(this.file, "a", 0o600);
    try {
      // 0.4.6 (0.4.3 audit item 15): a torn last line (crash
      // mid-append) used to swallow the NEXT append too — the new
      // line glued onto the torn half, the whole JSON line failed
      // to parse, and readAll skipped both. If the file does not
      // end with a newline, terminate the torn line first; the
      // torn half stays as its own (skipped) line and the new
      // entry survives intact.
      if (this.needsTerminator()) {
        appendFileSync(fd, "\n", "utf8");
      }
      appendFileSync(fd, JSON.stringify(entry) + "\n", "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  /** True when the file is non-empty and its last byte is not a
   *  newline — i.e. the previous append was torn mid-line. A
   *  missing or empty file needs nothing. Never throws: a stat
   *  failure degrades to "no terminator" (the append still lands,
   *  one line down). */
  private needsTerminator(): boolean {
    try {
      const size = statSync(this.file).size;
      if (size === 0) return false;
      const buf = Buffer.alloc(1);
      const rfd = openSync(this.file, "r");
      try {
        readSync(rfd, buf, 0, 1, size - 1);
      } finally {
        closeSync(rfd);
      }
      return buf[0] !== 0x0a;
    } catch {
      return false;
    }
  }

  readAll(): MemoryEntry[] {
    if (!existsSync(this.file)) return [];
    let raw: string;
    try {
      raw = readFileSync(this.file, "utf8");
    } catch {
      // Unreadable log file (e.g. a directory in its place): treat as
      // empty rather than crashing the constructor. Writes will fail
      // loudly at their own call sites instead.
      return [];
    }
    const out: MemoryEntry[] = [];
    const lines = raw.split("\n");
    let bad = 0;
    let badMiddle = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as MemoryEntry;
        // Defensive (audit B2): a row without a string id/ts/text is
        // poison — drop it instead of letting it crash the index
        // build or recall on the next load.
        if (
          typeof e.id === "string" &&
          typeof e.ts === "number" &&
          typeof e.text === "string"
        ) {
          out.push(e);
        } else {
          bad += 1;
          if (i < lines.length - 1) badMiddle += 1;
        }
      } catch {
        // A torn LAST line is the expected crash artifact. A bad
        // line in the MIDDLE means silent data loss: warn once per
        // file instead of pretending the log is complete.
        bad += 1;
        if (i < lines.length - 1) badMiddle += 1;
      }
    }
    if (badMiddle > 0 && !WARNED_CORRUPT.has(this.file)) {
      WARNED_CORRUPT.add(this.file);
      console.warn(
        `[memory-plugin] ${this.file} 有 ${badMiddle} 行中间损坏（共 ${bad} 行坏行），已跳过；请检查磁盘/备份，不要当作正常空行。`,
      );
    }
    return out;
  }

  count(): number {
    return this.readAll().length;
  }

  /** Rewrite the whole file from an entry list (0.5.1 item 1:
   *  physical forget-delete). Atomic (write temp + rename) so a
   *  crash mid-rewrite never leaves a half file — the old file
   *  stays until the new one is complete. The caller takes a
   *  snapshot first and holds the write lock; this only writes. */
  rewrite(entries: MemoryEntry[]): void {
    atomicWriteText(
      this.file,
      entries.map((e) => JSON.stringify(e)).join("\n") +
        (entries.length > 0 ? "\n" : ""),
    );
  }
}
