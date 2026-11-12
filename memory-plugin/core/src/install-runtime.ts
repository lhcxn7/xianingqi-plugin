// 终版 WP9 — install the optional transformers runtime.
//
// This is the ONE place the memory plugin may use the network, and it
// never runs by itself: the caller must pass `yes: true` (CLI --yes)
// after the user has seen the command. A dry-run only prints the
// command. A failed install changes nothing; semantic recall falls
// back to keyword-only.
//
// The model files are bundled with the plugin and are NOT downloaded
// here. Only the JS runtime package is installed.

import { spawnSync } from "node:child_process";

export const TRANSFORMERS_PACKAGE = "@huggingface/transformers@3.8.1";

export interface InstallRuntimeResult {
  ok: boolean;
  dryRun: boolean;
  needsConfirmation: boolean;
  command: string;
  output?: string;
  error?: string;
}

export function transformersInstallCommand(dataDir: string): string {
  const safe = dataDir.replace(/"/g, "");
  return `npm install --prefix "${safe}" --no-save --no-audit --no-fund ${TRANSFORMERS_PACKAGE}`;
}

export function installTransformersRuntime(
  dataDir: string,
  opts: { yes?: boolean; dryRun?: boolean; timeoutMs?: number } = {},
): InstallRuntimeResult {
  const command = transformersInstallCommand(dataDir);
  if (opts.dryRun === true) {
    return {
      ok: true,
      dryRun: true,
      needsConfirmation: false,
      command,
    };
  }
  if (opts.yes !== true) {
    return {
      ok: false,
      dryRun: false,
      needsConfirmation: true,
      command,
    };
  }
  const result = spawnSync(command, {
    cwd: dataDir,
    encoding: "utf8",
    timeout: opts.timeoutMs ?? 300_000,
    env: { ...process.env },
    shell: true,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  if (result.error || result.status !== 0) {
    return {
      ok: false,
      dryRun: false,
      needsConfirmation: false,
      command,
      ...(output ? { output } : {}),
      error:
        output ||
        result.error?.message ||
        `npm exited with status ${String(result.status)}`,
    };
  }
  return {
    ok: true,
    dryRun: false,
    needsConfirmation: false,
    command,
    ...(output ? { output } : {}),
  };
}
