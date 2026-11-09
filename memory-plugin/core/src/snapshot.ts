// Periodic snapshots: dated copies of the PLUGIN's own files, so a
// corrupt or wrongly deleted memory can be restored. Snapshots live in
// <dataDir>/.snapshots/<name>/ and are excluded from copies, so a
// snapshot never contains (or recurses into) other snapshots.
// Restore first snapshots the current state, so restore is reversible.
//
// Snapshots cover ONLY plugin-owned files (log.jsonl, index.json, the
// per-month log segments, persona-sessions.json, profile.json —
// 0.4.3 — plus graph/attributes/review/fragments). MEMORY.md, the
// monthly archives and the diary are NEVER snapshotted or restored —
// those belong to the skill / the user, and restoring them would
// silently revert her memory or diary to snapshot time (audit, 0.1.3).
// Still excluded: invalidation-audit.jsonl, beliefs.json, loop.json
// (see isPluginOwned).
//
// Restore is NON-DESTRUCTIVE: it only overwrites/adds the files that
// are present in the snapshot. Files that are not in the snapshot —
// the diary, MEMORY.md, backups the user dropped into the data folder,
// anything else — are left exactly as they are. (v1 deleted the whole
// data folder first, which destroyed the diary when the snapshot
// predated it; fixed 2026-11-05.)
//
// Crash safety: a snapshot is only "complete" once takeSnapshot has
// written the `.complete` marker as its last step. Restore stages the
// snapshot into a `.tmp-restore-*` directory, writes the marker there,
// and only then moves files over — a crash before the move leaves the
// live data folder untouched and only a `.tmp-*` leftover behind.

import { randomBytes } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { atomicWriteText, ensureDir } from "./atomic.ts";

export function snapshotsDir(dataDir: string): string {
  return join(dataDir, ".snapshots");
}

export function snapshotName(now = new Date()): string {
  return now
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace("Z", "");
}

export function takeSnapshot(dataDir: string, keep = 30): string {
  const dir = snapshotsDir(dataDir);
  ensureDir(dir);
  const name = snapshotName();
  const target = join(dir, name);
  copyDataFiles(dataDir, target);
  // Completion marker LAST: a snapshot without it was interrupted
  // mid-copy and must not be trusted for restore.
  atomicWriteText(join(target, ".complete"), `${name}\n`);
  pruneSnapshots(dataDir, keep);
  return name;
}

export function listSnapshots(dataDir: string): string[] {
  const dir = snapshotsDir(dataDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => {
      try {
        return statSync(join(dir, f)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort();
}

/** True when a snapshot finished copying. Snapshots taken before the
 *  marker existed (v1) have no marker but are treated as complete when
 *  they contain at least one managed file; a directory with neither a
 *  marker nor any managed file is an interrupted copy. */
export function snapshotComplete(dataDir: string, name: string): boolean {
  const dir = join(snapshotsDir(dataDir), name);
  if (!existsSync(dir)) return false;
  if (existsSync(join(dir, ".complete"))) return true;
  try {
    return readdirSync(dir).some(
      (f) =>
        [
          "log.jsonl",
          "index.json",
          "persona-sessions.json",
          "graph.json",
          "attributes.json",
          "review.json",
          "fragments.json",
          // 0.4.3: profile.json is plugin-owned and snapshotted
          // (memory_profile writes it) — a pre-marker snapshot
          // counts as complete when it holds it, like any other
          // managed file.
          "profile.json",
        ].includes(f) ||
        /^log-\d{4}-\d{2}\.jsonl$/.test(f) ||
        /^summary-\d{4}-\d{2}\.jsonl$/.test(f),
    );
  } catch {
    return false;
  }
}

export function pruneSnapshots(dataDir: string, keep = 30): void {
  const snaps = listSnapshots(dataDir);
  if (snaps.length <= keep) return;
  for (const old of snaps.slice(0, snaps.length - keep)) {
    rmSync(join(snapshotsDir(dataDir), old), { recursive: true, force: true });
  }
}

/** Plugin-owned files only (audit, 0.1.3): MEMORY.md, monthly
 *  archives and the diary are never copied into a snapshot and never
 *  restored from one. `appended-ids.json` (0.1.4 minor 1) is
 *  plugin-owned too: it records which recall hits a session's turn-1
 *  append already committed, so a restore must revert it together
 *  with the log or the dedupe state would disagree with the log.
 *  0.4.3: `profile.json` joins the list — it is tool-writable
 *  plugin state (memory_profile writes it), so a restore must
 *  revert it together with the log or the profile would disagree
 *  with the restored memory. Still EXCLUDED, deliberately:
 *  `invalidation-audit.jsonl` (append-only audit trail, never
 *  rewound), `beliefs.json` (belief layer, its own store) and
 *  `loop.json` (behaviour-loop state) — restoring them would
 *  silently rewind audit history / beliefs / pending actions to
 *  snapshot time. */
function isPluginOwned(name: string): boolean {
  return (
    name === "log.jsonl" ||
    name === "index.json" ||
    name === "persona-sessions.json" ||
    name === "appended-ids.json" ||
    // 0.4.3: profile.json is plugin-owned (memory_profile writes
    // it) and snapshotted together with the log.
    name === "profile.json" ||
    // 0.2.0: graph, attributes, review state and compressed
    // summaries are plugin-owned and snapshotted together with the
    // log. starmap.html is deliberately EXCLUDED — derived
    // artifact, regenerable from the other files.
    // 0.3.0: fragments.json is plugin-owned too (derived layer on
    // top of the log — a restore must revert it together with the
    // log, or fragments would point at pre-restore sources).
    name === "graph.json" ||
    name === "attributes.json" ||
    name === "review.json" ||
    name === "fragments.json" ||
    /^summary-\d{4}-\d{2}\.jsonl$/.test(name) ||
    /^log-\d{4}-\d{2}\.jsonl$/.test(name)
  );
}

/** Snapshot names are plain directory names (ISO timestamps).
 *  Reject anything that could walk out of the snapshots folder
 *  (0.1.4 minor 3): a crafted name like `../../x` would otherwise
 *  make restore copy files from outside the snapshot tree. */
export function validateSnapshotName(name: unknown): asserts name is string {
  if (
    typeof name !== "string" ||
    name.trim().length === 0 ||
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("..")
  ) {
    throw new Error(`invalid snapshot name: ${String(name)}`);
  }
}

/** Copy the plugin's own data files, except .snapshots, temp
 *  leftovers and the snapshot completion marker (the marker lives
 *  inside snapshot dirs only and must never be copied into the live
 *  data folder). */
function copyDataFiles(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  if (!existsSync(src)) return;
  for (const name of readdirSync(src)) {
    if (
      name === ".snapshots" ||
      name === ".complete" ||
      name.startsWith(".tmp-")
    ) {
      continue;
    }
    if (!isPluginOwned(name)) continue;
    const from = join(src, name);
    const to = join(dest, name);
    cpSync(from, to, { recursive: true });
  }
}

/**
 * Restore a snapshot over the data folder. First takes a safety snapshot
 * of the current state ("pre-restore-<ts>"), then stages the target
 * snapshot into a temp directory and moves its files over — files NOT
 * in the snapshot (diary, user backups, ...) are left untouched.
 * Throws if the named snapshot does not exist or looks incomplete.
 */
export function restoreSnapshot(dataDir: string, name: string): string {
  // 0.1.4 minor 3: validate before touching the filesystem.
  validateSnapshotName(name);
  const src = join(snapshotsDir(dataDir), name);
  if (!existsSync(src)) {
    throw new Error(`snapshot not found: ${name}`);
  }
  if (!snapshotComplete(dataDir, name)) {
    throw new Error(
      `snapshot looks incomplete (no .complete marker, no managed files): ${name}`,
    );
  }
  const safety = `pre-restore-${snapshotName()}`;
  copyDataFiles(dataDir, join(snapshotsDir(dataDir), safety));
  atomicWriteText(
    join(snapshotsDir(dataDir), safety, ".complete"),
    `${safety}\n`,
  );

  // Stage, then move over file by file. A crash before the move leaves
  // the live folder untouched; each file move is an atomic rename.
  const staging = join(
    dataDir,
    `.tmp-restore-${name}-${process.pid}-${randomBytes(4).toString("hex")}`,
  );
  try {
    copyDataFiles(src, staging);
    atomicWriteText(join(staging, ".complete"), `${name}\n`);
    for (const f of readdirSync(staging)) {
      if (f === ".complete") continue;
      const from = join(staging, f);
      const to = join(dataDir, f);
      if (statSync(from).isDirectory()) {
        cpSync(from, to, { recursive: true });
      } else {
        renameSync(from, to);
      }
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  return safety;
}
