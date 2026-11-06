// Keyword index: token -> entry ids, updated on every write and
// persisted to index.json. The log is the source of truth; the index
// is rebuilt from it whenever the persisted copy is missing or stale.
//
// Staleness check (v2): the persisted index records, for every log
// file, its size AND mtime. v1 only recorded the total byte count, so
// a hand edit that kept the byte count identical would silently reuse
// a stale index. A v1 index (no per-file fingerprint) is treated as
// stale and rebuilt once.

import { existsSync, readFileSync, statSync } from "node:fs";
import { atomicWriteText } from "./atomic.ts";
import { tokenize } from "./tokenize.ts";
import type { MemoryEntry } from "./types.ts";

interface FileFingerprint {
  size: number;
  mtimeMs: number;
}

interface PersistedIndex {
  version: 2;
  logBytes: number;
  /** log file path -> size + mtime at save time. */
  files: Record<string, FileFingerprint>;
  entries: Record<string, string[]>;
}

/** Fingerprint of the current log files: path -> size + mtime. */
export function fingerprintLogFiles(files: string[]): Record<string, FileFingerprint> {
  const out: Record<string, FileFingerprint> = {};
  for (const file of files) {
    try {
      const s = statSync(file);
      out[file] = { size: s.size, mtimeMs: s.mtimeMs };
    } catch {
      // File vanished mid-read; leave it out (rebuild will follow).
    }
  }
  return out;
}

export function fingerprintsEqual(
  a: Record<string, FileFingerprint>,
  b: Record<string, FileFingerprint>,
): boolean {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  if (ka.length !== kb.length) return false;
  for (let i = 0; i < ka.length; i++) {
    if (ka[i] !== kb[i]) return false;
    const fa = a[ka[i]];
    const fb = b[ka[i]];
    if (fa.size !== fb.size || fa.mtimeMs !== fb.mtimeMs) return false;
  }
  return true;
}

export class KeywordIndex {
  private map = new Map<string, Set<string>>();
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  get size(): number {
    return this.map.size;
  }

  build(entries: MemoryEntry[]): void {
    this.map.clear();
    for (const e of entries) this.add(e);
  }

  add(entry: MemoryEntry): void {
    for (const token of tokenize(entry.text)) {
      let set = this.map.get(token);
      if (!set) {
        set = new Set<string>();
        this.map.set(token, set);
      }
      set.add(entry.id);
    }
  }

  /** token -> entry ids that contain it. */
  lookup(tokens: string[]): Map<string, string[]> {
    const out = new Map<string, string[]>();
    for (const token of tokens) {
      const ids = this.map.get(token);
      if (ids && ids.size > 0) out.set(token, [...ids]);
    }
    return out;
  }

  save(logFiles: string[]): void {
    const entries: Record<string, string[]> = {};
    for (const [token, ids] of this.map) entries[token] = [...ids];
    const files = fingerprintLogFiles(logFiles);
    const logBytes = Object.values(files).reduce(
      (n, f) => n + f.size,
      0,
    );
    atomicWriteText(
      this.file,
      JSON.stringify({
        version: 2,
        logBytes,
        files,
        entries,
      } satisfies PersistedIndex),
    );
  }

  /** Load the persisted index if it matches the current log files.
   *  Returns false when the index is missing, stale (any log file
   *  changed size or mtime, or a file was added/removed), or an old
   *  v1 index (caller rebuilds). */
  load(logFiles: string[]): boolean {
    try {
      if (!existsSync(this.file)) return false;
      const data = JSON.parse(
        readFileSync(this.file, "utf8"),
      ) as PersistedIndex;
      if (data.version !== 2) return false;
      if (!fingerprintsEqual(data.files ?? {}, fingerprintLogFiles(logFiles))) {
        return false;
      }
      this.map.clear();
      for (const [token, ids] of Object.entries(data.entries)) {
        this.map.set(token, new Set(ids));
      }
      return true;
    } catch {
      return false;
    }
  }
}
