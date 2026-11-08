// Multi-process mutual-exclusion test for the arbiter lock design
// (Claude deep review of package v5, Major M-01; hardened again
// after the deep review of package v6, Major M-01 — the arbiter
// break used to rename the arbiter dir, and an old process's stale
// judgement could move a new holder's live arbiter, letting a
// stale reclaim delete a live canonical lock. The fix removes all
// renames: every delete is in place and re-verifies the owner token
// first. The regression test for that must be multi-process, and
// step 2b below forces the exact interleaving with a delay hook.)
//
// Four modes in one file (demo.ts spawns the runner):
//   node lock-mutex.ts <dataDir> [outerRounds] [workers] [workerRounds]  (runner)
//   node lock-mutex.ts <dataDir> worker <id> <rounds> <logFile>           (stress worker)
// Exit 0 on pass, non-zero with a message on any failure.
// Uses erasable TypeScript only (Node runs .ts directly).
//
// What the runner checks, per outer round:
//   1. Release isolation (single process, deterministic): a stale
//      release function (already called once) must not delete a newer
//      lock; the release's token check is what enforces it.
//   2. Stale arbiter reclaim: a planted stale arbiter + stale
//      canonical lock are both broken and the acquire succeeds.
//   2b. Arbiter-break race (v6 Major): a breaker whose stale
//      judgement predates a new holder's acquire must not delete
//      the new holder's live arbiter (forced with the
//      LOCK_TEST_BREAK_DELAY_MS hook).
//   3. Stress (real multi-process): N workers x R rounds of
//      acquire -> START -> sleep -> END -> release, all appending to
//      one shared log. The runner then verifies the log: every
//      (worker, round) has exactly one START and one END, and the
//      START/END pairs NEVER overlap — at every point in the log at
//      most one START is open. Any overlap means two processes held
//      the lock at the same time. Workers also verify mid-hold
//      ownership (the lock dir must still carry their pid).
//   4. No leftovers: no .locks dir remains after each outer round.
//
// Run: node core/test/lock-mutex.ts <tmpdir>  (defaults: 3 outer
// rounds, 4 workers, 15 rounds each — about 10 s total).

import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  acquireWriteLock,
  arbiterDirPath,
  isLockStale,
  lockDirPath,
} from "../src/lock.ts";

function sleepSync(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function fail(message: string): never {
  console.error(`[lock-mutex] FAIL: ${message}`);
  process.exit(1);
}

// Node < 24 needs --experimental-strip-types to run .ts files;
// Node 24+ strips types by default.
function tsFlags(): string[] {
  const major = Number(process.version.slice(1).split(".")[0]);
  return major >= 24 ? [] : ["--experimental-strip-types"];
}

// True when the lock dir still exists and its owner pid is ours.
function stillOwned(lockDir: string, pid: number): boolean {
  try {
    const owner = JSON.parse(
      readFileSync(join(lockDir, "owner.json"), "utf8"),
    ) as { pid?: unknown };
    return owner.pid === pid;
  } catch {
    return false;
  }
}

// ---- worker -------------------------------------------------------
// Acquire, hold briefly, prove ownership mid-hold, append START/END
// markers to the shared log, release. Any ownership failure or
// acquire throw fails the worker (exit 1).
function runWorker(
  dataDir: string,
  id: string,
  rounds: number,
  logFile: string,
): void {
  const lockDir = lockDirPath(dataDir);
  for (let r = 0; r < rounds; r++) {
    let release: () => void;
    try {
      release = acquireWriteLock(dataDir, { timeoutMs: 20000 });
    } catch (err) {
      fail(
        `worker ${id} round ${r}: acquire threw: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    try {
      appendFileSync(logFile, `START ${id} ${r}\n`, "utf8");
      // Hold the lock for a random 0-8 ms so the workers' holds
      // actually overlap in time and the race is real.
      sleepSync(Math.floor(Math.random() * 9));
      if (!stillOwned(lockDir, process.pid)) {
        fail(`worker ${id} round ${r}: lock deleted or retaken while held`);
      }
      appendFileSync(logFile, `END ${id} ${r}\n`, "utf8");
    } finally {
      release!();
    }
  }
}

// ---- break-once -----------------------------------------------------
// Acquire the write lock exactly once, hold it briefly, release.
// Used by the arbiter-break race test (step 2b): the process is
// spawned with LOCK_TEST_BREAK_DELAY_MS set, so it captures a stale
// arbiter owner, sleeps inside breakArbiter, and only then attempts
// the delete — while it sleeps, the runner replaces the arbiter
// with a fresh live one, and the delete must refuse (token changed).
function runBreakOnce(dataDir: string): void {
  const lockDir = lockDirPath(dataDir);
  let release: () => void;
  try {
    release = acquireWriteLock(dataDir, { timeoutMs: 20000 });
  } catch (err) {
    fail(`break-once: acquire threw: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    if (!stillOwned(lockDir, process.pid)) {
      fail("break-once: lock not owned after acquire");
    }
    sleepSync(10);
  } finally {
    release!();
  }
}

// ---- log verification ---------------------------------------------
// The log must contain exactly one START and one END per (id, round),
// and the pairs must never overlap: at most one START open at any point.
function verifyLog(logFile: string, workers: number, rounds: number): void {
  const lines = readFileSync(logFile, "utf8")
    .split("\n")
    .filter((l) => l.length > 0);
  const starts = new Map<string, number>();
  const ends = new Map<string, number>();
  let open: { id: string; round: string } | null = null;
  for (const line of lines) {
    const [kind, id, round] = line.split(" ");
    const key = `${id}:${round}`;
    if (kind === "START") {
      if (open) {
        fail(
          `mutual exclusion broken: START ${id} ${round} while ${open.id} ${open.round} still holds the lock (log line: ${line})`,
        );
      }
      starts.set(key, (starts.get(key) ?? 0) + 1);
      open = { id, round };
    } else if (kind === "END") {
      if (!open || open.id !== id || open.round !== round) {
        fail(`log mismatch: END ${id} ${round} without a matching open START`);
      }
      ends.set(key, (ends.get(key) ?? 0) + 1);
      open = null;
    } else {
      fail(`log mismatch: unknown line: ${line}`);
    }
  }
  if (open) fail(`log mismatch: ${open.id} ${open.round} never ended`);
  for (let w = 0; w < workers; w++) {
    for (let r = 0; r < rounds; r++) {
      const key = `w${w}:${r}`;
      if (starts.get(key) !== 1 || ends.get(key) !== 1) {
        fail(`log mismatch: ${key} has ${starts.get(key) ?? 0} STARTs / ${ends.get(key) ?? 0} ENDs (expected 1 each)`);
      }
    }
  }
  console.log(
    `PASS lock-mutex: ${lines.length} log lines, ${workers * rounds} START/END pairs, never overlapping (max 1 holder)`,
  );
}

// ---- runner -------------------------------------------------------
async function runRunner(
  dataDir: string,
  outerRounds: number,
  workers: number,
  workerRounds: number,
): Promise<void> {
  const script = fileURLToPath(import.meta.url);
  const lockDir = lockDirPath(dataDir);
  const arbDir = arbiterDirPath(dataDir);

  // 1. Release isolation: a stale (already-called) release function
  // must not delete a newer lock. The release's in-place token check
  // is what enforces it.
  {
    const releaseA = acquireWriteLock(dataDir, { timeoutMs: 2000 });
    releaseA(); // A released; the dir is gone.
    const releaseB = acquireWriteLock(dataDir, { timeoutMs: 2000 });
    releaseA(); // duplicate release of A: idempotent no-op.
    const owner = JSON.parse(
      readFileSync(join(lockDir, "owner.json"), "utf8"),
    ) as { pid?: unknown };
    if (owner.pid !== process.pid) {
      fail("release isolation: duplicate release of A deleted B's lock");
    }
    releaseB();
    if (existsSync(lockDir)) fail("release isolation: lock dir left after release");
    console.log("PASS lock-mutex: duplicate release cannot delete a newer lock");
  }

  // 2. Stale arbiter reclaim: a planted stale arbiter + stale
  // canonical lock are both broken and the acquire succeeds.
  {
    const deadPid = spawnSync(process.execPath, ["--version"]).pid as number;
    for (const d of [arbDir, lockDir]) {
      mkdirSync(d, { recursive: true });
      writeFileSync(
        join(d, "owner.json"),
        JSON.stringify({ pid: deadPid, token: "stale-owner", time: Date.now() - 60000 }),
        "utf8",
      );
      const old = new Date(Date.now() - 60000);
      utimesSync(d, old, old);
    }
    if (!isLockStale(lockDir, 100)) fail("stale canonical lock not recognised as stale");
    const release = acquireWriteLock(dataDir, { timeoutMs: 5000 });
    if (!stillOwned(lockDir, process.pid)) fail("stale reclaim: did not own the lock after acquire");
    release();
    if (existsSync(join(dataDir, ".locks"))) fail("stale reclaim: .locks left after release");
    console.log("PASS lock-mutex: stale arbiter + stale canonical lock reclaimed");
  }

  // 2b. Arbiter-break race (Claude deep review of package v6, Major
  // M-01): a breaker whose stale judgement predates a new holder's
  // acquire must NOT delete the new holder's live arbiter. The old
  // (rename-based) break moved whatever was at the path; the new
  // break re-verifies the token before deleting. Forced with the
  // LOCK_TEST_BREAK_DELAY_MS hook: the breaker captures the stale
  // owner, then sleeps 300 ms; while it sleeps the runner replaces
  // the arbiter with a fresh live one (its own pid + token); the
  // breaker wakes and must refuse to delete it (token changed).
  // The runner then releases its fresh arbiter so the breaker can
  // proceed and exit 0 — proving the breaker did not delete a live
  // arbiter and did not deadlock.
  {
    const deadPid = spawnSync(process.execPath, ["--version"]).pid as number;
    mkdirSync(arbDir, { recursive: true });
    writeFileSync(
      join(arbDir, "owner.json"),
      JSON.stringify({ pid: deadPid, token: "stale-owner", time: Date.now() - 60000 }),
      "utf8",
    );
    const old = new Date(Date.now() - 60000);
    utimesSync(arbDir, old, old);
    const breaker = spawn(
      process.execPath,
      [...tsFlags(), script, dataDir, "break-once"],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, LOCK_TEST_BREAK_DELAY_MS: "500" },
      },
    );
    let breakerOut = "";
    breaker.stdout?.on("data", (d: Buffer) => (breakerOut += d.toString()));
    breaker.stderr?.on("data", (d: Buffer) => (breakerOut += d.toString()));
    const breakerDone = new Promise<void>((resolve, reject) => {
      breaker.on("error", reject);
      breaker.on("close", (code) => {
        if (breakerOut) process.stdout.write(breakerOut);
        if (code !== 0) reject(new Error(`breaker exited ${code}`));
        else resolve();
      });
    });
    // Give the breaker time to reach the hook (judge stale, capture
    // owner, start sleeping — Node startup alone is ~50-100 ms),
    // then replace the arbiter with a fresh live one (our own pid +
    // token) — simulating a new holder taking the arbiter while the
    // breaker sleeps. Also start a third process (the taker) that
    // contends for the arbiter: on the OLD (rename-based) break, the
    // breaker renames our live arbiter away, the taker takes the
    // freed path, and the breaker's rename-back then fails, stranding
    // our live arbiter in quarantine — the check below fails. On the
    // new code the breaker's delete is refused (token changed) and
    // our arbiter stays put, so the check passes.
    await new Promise((r) => setTimeout(r, 250));
    rmSync(arbDir, { recursive: true, force: true });
    const freshToken = `runner-${process.pid}-${Date.now()}`;
    mkdirSync(arbDir, { recursive: true });
    writeFileSync(
      join(arbDir, "owner.json"),
      JSON.stringify({ pid: process.pid, token: freshToken, time: Date.now() }),
      "utf8",
    );
    const taker = spawn(
      process.execPath,
      [...tsFlags(), script, dataDir, "break-once"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let takerOut = "";
    taker.stdout?.on("data", (d: Buffer) => (takerOut += d.toString()));
    taker.stderr?.on("data", (d: Buffer) => (takerOut += d.toString()));
    const takerDone = new Promise<void>((resolve, reject) => {
      taker.on("error", reject);
      taker.on("close", (code) => {
        if (takerOut) process.stdout.write(takerOut);
        if (code !== 0) reject(new Error(`taker exited ${code}`));
        else resolve();
      });
    });
    // Wait for the breaker to wake (its 500 ms hook started before
    // our replacement, so it wakes ~250 ms after the replacement)
    // and attempt the delete, plus time for the taker to contend.
    // Then verify our fresh arbiter is intact.
    await new Promise((r) => setTimeout(r, 600));
    let ownerNow: { pid?: unknown; token?: unknown } | null = null;
    try {
      ownerNow = JSON.parse(
        readFileSync(join(arbDir, "owner.json"), "utf8"),
      ) as { pid?: unknown; token?: unknown };
    } catch {
      // No owner record at the path: our live arbiter was moved or
      // deleted (the v6 bug) — fail with a clear message, not a
      // raw ENOENT.
      ownerNow = null;
    }
    if (!ownerNow || ownerNow.token !== freshToken || ownerNow.pid !== process.pid) {
      fail("arbiter-break race: breaker deleted a live arbiter (token changed)");
    }
    // Release our fresh arbiter so the breaker and taker can proceed.
    rmSync(arbDir, { recursive: true, force: true });
    await Promise.all([breakerDone, takerDone]);
    if (existsSync(join(dataDir, ".locks"))) fail("arbiter-break race: .locks left after test");
    console.log("PASS lock-mutex: stale arbiter break never deletes a live arbiter (v6 Major)");
  }

  // 3. Stress: real multi-process rounds.
  for (let outer = 0; outer < outerRounds; outer++) {
    const logFile = join(dataDir, `mutex-log-${outer}.txt`);
    writeFileSync(logFile, "", "utf8");
    const children = [];
    for (let w = 0; w < workers; w++) {
      children.push(
        new Promise<void>((resolve, reject) => {
          const child = spawn(
            process.execPath,
            [...tsFlags(), script, dataDir, "worker", `w${w}`, String(workerRounds), logFile],
            { stdio: ["ignore", "pipe", "pipe"] },
          );
          let out = "";
          child.stdout?.on("data", (d: Buffer) => (out += d.toString()));
          child.stderr?.on("data", (d: Buffer) => (out += d.toString()));
          child.on("error", reject);
          child.on("close", (code) => {
            if (out) process.stdout.write(out);
            if (code !== 0) reject(new Error(`worker w${w} exited ${code}`));
            else resolve();
          });
        }),
      );
    }
    await Promise.all(children);
    verifyLog(logFile, workers, workerRounds);
    if (existsSync(join(dataDir, ".locks"))) {
      fail(`outer round ${outer}: .locks left after stress`);
    }
    console.log(`PASS lock-mutex: outer round ${outer + 1}/${outerRounds} clean`);
  }
}

// ---- main ---------------------------------------------------------
const [dataDir, mode, ...rest] = process.argv.slice(2);
if (!dataDir) {
  console.error(
    "usage: lock-mutex.ts <dataDir> [outerRounds] [workers] [workerRounds] | lock-mutex.ts <dataDir> worker <id> <rounds> <logFile>",
  );
  process.exit(2);
}
if (mode === "worker") {
  const [id, rounds, logFile] = rest;
  runWorker(dataDir, id, Number(rounds), logFile);
} else if (mode === "break-once") {
  runBreakOnce(dataDir);
} else {
  const outerRounds = Number(mode ?? "3");
  const workers = Number(rest[0] ?? "4");
  const workerRounds = Number(rest[1] ?? "15");
  const dir = dataDir === "-" ? mkdtempSync(join(tmpdir(), "lock-mutex-")) : dataDir;
  runRunner(dir, outerRounds, workers, workerRounds).catch((err: unknown) => {
    console.error(`[lock-mutex] FAIL: ${err instanceof Error ? err.message : String(err)}`);
    // Dump the leftover .locks state for diagnosis (which entries
    // exist, whether they carry owner.json, their mtimes).
    try {
      const locksDir = join(dir, ".locks");
      for (const entry of readdirSync(locksDir)) {
        const p = join(locksDir, entry);
        const st = statSync(p);
        let owner = "(no owner.json)";
        try { owner = readFileSync(join(p, "owner.json"), "utf8").trim(); } catch { /* none */ }
        console.error(`[lock-mutex] leftover: ${entry} mtime=${new Date(st.mtimeMs).toISOString()} owner=${owner}`);
      }
    } catch (e) {
      console.error(`[lock-mutex] leftover dump failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    process.exit(1);
  });
}
