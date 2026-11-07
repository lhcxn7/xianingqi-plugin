// Two-process stale-lock race test (0.1.7). Black-box stress test
// for the lock TOCTOU fix (M2): two INDEPENDENT OS processes try to
// break the SAME stale lock and write records at the same time.
// The old breakLock (bare rmSync after a stale check) let the loser
// delete the winner's LIVE lock; the fix claims the stale lock by
// atomic rename, so only one breaker wins and the loser retries.
//
// Two modes in one file (demo.ts spawns the runner; the runner
// spawns the workers):
//   node lock-race.ts <dataDir> <rounds>                          (runner)
//   node lock-race.ts <dataDir> worker <id> <holdMs> <raceDir> <markerFile>
// Exit 0 on pass, non-zero with a message on any failure.
// Uses erasable TypeScript only (Node runs .ts directly).

import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireWriteLock, isLockStale, lockDirPath } from "../src/lock.ts";

function sleepSync(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function fail(message: string): never {
  console.error(`[lock-race] FAIL: ${message}`);
  process.exit(1);
}

// True when the lock dir still exists and its owner pid is ours.
// Retries a briefly unreadable owner.json (slow filesystem): a real
// deletion stays absent and fails after the retries. A different
// owner pid means genuinely retaken -- no retry helps. (The canonical
// lock dir is never moved in the arbiter design, so a mid-hold
// disappearance is a real failure, not a quarantine in transit.)
function stillOwned(lockDir: string, pid: number): boolean {
  for (let i = 0; i < 6; i++) {
    try {
      const owner = JSON.parse(
        readFileSync(join(lockDir, "owner.json"), "utf8"),
      ) as { pid?: unknown };
      return owner.pid === pid;
    } catch {
      sleepSync(10);
    }
  }
  return false;
}

// ---- worker -------------------------------------------------------
// Acquire the lock, hold it for holdMs, prove it was never deleted
// or retaken while held (owner pid must stay ours), append one
// marker line while holding it, release, exit 0.
function runWorker(
  dataDir: string,
  id: string,
  holdMs: number,
  raceDir: string,
  markerFile: string,
): void {
  const lockDir = lockDirPath(dataDir);
  const other = id === "a" ? "b" : "a";
  // Barrier (best-effort): if we see the stale lock, wait briefly
  // for the other worker to see it too, so both break attempts land
  // at the same time and the race actually happens. If the other
  // side never shows up (it already broke the lock, or is slow),
  // the timeout just lets us proceed alone.
  if (isLockStale(lockDir, 100)) {
    writeFileSync(join(raceDir, `saw-${id}`), `${process.pid}\n`, "utf8");
    const deadline = Date.now() + 1000;
    while (
      !existsSync(join(raceDir, `saw-${other}`)) &&
      Date.now() < deadline
    ) {
      sleepSync(10);
    }
  }
  // Desync jitter (0-4 ms, pid-based): without it the two workers
  // run in such tight lockstep that the loser always breaks before
  // the winner mkdirs, and the TOCTOU never fires even on the old
  // code. The jitter makes the loser's stale judgement straddle
  // the winner's acquire, which is the interleaving that bites.
  sleepSync(process.pid % 5);
  let release: () => void;
  try {
    release = acquireWriteLock(dataDir, { staleMs: 100, timeoutMs: 20000 });
  } catch (err) {
    fail(
      `worker ${id}: acquire threw: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  let problem: string | null = null;
  try {
    sleepSync(Math.floor(holdMs / 2));
    // Mid-hold ownership check: the lock dir must still exist and
    // its owner pid must be ours. If the other breaker deleted our
    // live lock (the 0.1.6 TOCTOU), this fails.
    if (!stillOwned(lockDir, process.pid)) {
      problem = "lock deleted or retaken while held (owner pid changed or dir gone)";
    }
    if (!problem) {
      appendFileSync(markerFile, `${id}\n`, "utf8");
      sleepSync(Math.ceil(holdMs / 2));
      // Check again at the end of the hold, before releasing.
      if (!stillOwned(lockDir, process.pid)) {
        problem = "lock deleted or retaken before release";
      }
    }
  } finally {
    release();
  }
  if (problem) fail(`worker ${id}: ${problem}`);
}

// ---- runner -------------------------------------------------------
// Plants one stale lock per round, spawns two workers at once,
// asserts both exit 0, both marker lines land, and no lock or
// quarantine leftovers remain.
async function runRunner(dataDir: string, rounds: number): Promise<void> {
  const raceDir = join(dataDir, "race");
  mkdirSync(raceDir, { recursive: true });
  const script = fileURLToPath(import.meta.url);
  for (let r = 0; r < rounds; r++) {
    // Plant a stale lock: old mtime + dead pid (a process that has
    // already exited, same pattern as the demo.ts lock tests).
    // The owner.json carries a 2 MB padding field: parsing it makes
    // isLockStale() take ~10 ms, which widens the window in which
    // the loser's stale judgement can straddle the winner's
    // acquire — without it the two workers run in lockstep and the
    // TOCTOU never fires even on the old code.
    const deadPid = spawnSync(process.execPath, ["--version"])
      .pid as number;
    const lockDir = lockDirPath(dataDir);
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(
      join(lockDir, "owner.json"),
      JSON.stringify({
        pid: deadPid,
        token: "stale-owner",
        time: Date.now() - 60000,
        pad: "x".repeat(2_000_000),
      }),
      "utf8",
    );
    const old = new Date(Date.now() - 60000);
    utimesSync(lockDir, old, old);
    if (!isLockStale(lockDir, 100)) {
      throw new Error(`round ${r}: planted lock is not stale`);
    }
    const markerFile = join(raceDir, `markers-${r}.txt`);
    const workers = ["a", "b"].map((id) =>
      spawn(
        process.execPath,
        [script, dataDir, "worker", id, "200", raceDir, markerFile],
        { stdio: "inherit" },
      ),
    );
    const codes = await Promise.all(
      workers.map(
        (w) =>
          new Promise<number | null>((resolve) =>
            w.on("exit", (code) => resolve(code)),
          ),
      ),
    );
    if (codes[0] !== 0 || codes[1] !== 0) {
      throw new Error(
        `round ${r}: worker exit codes ${codes[0]}/${codes[1]} (expected 0/0)`,
      );
    }
    const lines = readFileSync(markerFile, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean);
    if (lines.length !== 2 || new Set(lines).size !== 2) {
      throw new Error(
        `round ${r}: expected 2 marker lines (a+b), got ${JSON.stringify(lines)}`,
      );
    }
    // No lock or quarantine leftovers after a clean round.
    const locksDir = join(dataDir, ".locks");
    if (existsSync(locksDir)) {
      throw new Error(
        `round ${r}: .locks leftovers after clean run: ${JSON.stringify(readdirSync(locksDir))}`,
      );
    }
  }
  rmSync(raceDir, { recursive: true, force: true });
  console.log(
    `RACE PASS (${rounds} rounds, 2 processes each, no live lock deleted)`,
  );
}

const [, , dataDir, mode, ...rest] = process.argv;
if (!dataDir) {
  console.error(
    "usage: node lock-race.ts <dataDir> <rounds> | <dataDir> worker <id> <holdMs> <raceDir> <markerFile>",
  );
  process.exit(2);
}
if (mode === "worker") {
  const [id, holdMs, raceDir, markerFile] = rest;
  runWorker(dataDir, id, Number(holdMs), raceDir, markerFile);
} else {
  const rounds = Number(mode);
  if (!Number.isInteger(rounds) || rounds < 1) {
    console.error("rounds must be a positive integer");
    process.exit(2);
  }
  await runRunner(dataDir, rounds);
}
