// Management-centre CLI (0.5.1 item 3).
//
//   node core/src/admin-cli.ts --dataDir <dir> <command> [args]
//
// The admin is a NON-MODEL channel: it runs in the user's shell,
// never inside a chat. That is what authorises it to edit/delete
// a memory or approve a forgetting — the model has no tool for
// any of this, and a chat "我同意" can never reach here.
// Output is JSON on stdout (one object per command); errors go to
// stderr with a non-zero exit.
//
// Commands:
//   stats
//   entries list [--window persona|task|all] [--query ...] [--limit N] [--offset N]
//   entries show <id>
//   entries edit <id> --text "..." [--importance heavy|light]
//   entries correct <id> --text "..." [--factKey ...] [--importance heavy|light]
//   entries delete <id> --yes
//   forget request --mode hide|delete --ids a,b [--reason ...]
//   forget dry-run --ids a,b
//   forget list
//   forget approve <request-id>
//   forget execute <request-id>
//   forget unhide --ids a,b
//   purge --pattern-file <path> [--yes] [--no-snapshots]
//   purge --pattern "..." [--yes] [--no-snapshots]
//   goals add --title "..." [--due YYYY-MM-DD|epoch-ms] [--notes ...]
//   goals list [--status open|done|dropped]
//   goals done|reopen|drop|remove <id>
//   exp add --rule "..." --trigger a,b --source "..." --source-ids a,b
//   exp list | exp confirm <id> [--expires-days N] | exp revoke <id> | exp remove <id>
//   semantic status | semantic install [--yes] [--timeout ms] | semantic rebuild
//   serve [--port N] [--token T]   (localhost HTTP API, see admin-server.ts)

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { MemoryCore } from "./core.ts";
import { installTransformersRuntime } from "./install-runtime.ts";
import { MemoryAdmin } from "./admin.ts";
import { startAdminServer } from "./admin-server.ts";

function fail(message: string): never {
  console.error(`admin: ${message}`);
  process.exit(1);
}

function parseFlags(args: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = args[i + 1];
    if (next === undefined || next.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

function splitIds(s: string | boolean | undefined): string[] {
  if (typeof s !== "string" || s.length === 0) return [];
  return s.split(",").map((x) => x.trim()).filter((x) => x.length > 0);
}

function parseDue(s: string | undefined): number | undefined {
  if (s === undefined) return undefined;
  if (/^\d+$/.test(s)) return Number(s);
  const t = Date.parse(s);
  if (Number.isNaN(t)) fail(`--due 不是日期也不是毫秒时间戳: ${s}`);
  return t;
}

function print(obj: unknown): void {
  console.log(JSON.stringify(obj, null, 2));
}

async function main(argv: string[]): Promise<void> {
  const flags = parseFlags(argv);
  const dataDir =
    typeof flags.dataDir === "string"
      ? flags.dataDir
      : process.env.MEMORY_PLUGIN_DATA_DIR ??
        join(homedir(), ".dsh", "xia-ningqi-data");
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      rest.push(a);
      continue;
    }
    // A flag: skip its value (when it has one) so flag values
    // never leak into the positional list.
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) i += 1;
  }
  const [group, cmd, ...positionals] = rest;
  const core = new MemoryCore({ dataDir });
  const admin = new MemoryAdmin(core, "cli");

  if (group === "serve") {
    const port =
      typeof flags.port === "string" ? Number(flags.port) : 18081;
    const token = typeof flags.token === "string" ? flags.token : undefined;
    const handle = await startAdminServer(core, { port, token });
    // 0.5.4: the API requires a bearer token; the operator must be
    // able to see it. Printed to stdout only, never to a log file.
    console.log(`admin server on ${handle.url} (localhost only)`);
    console.log(`token: ${handle.token}`);
    console.log(
      `curl -H "Authorization: Bearer ${handle.token}" ${handle.url}/api/stats`,
    );
    return; // keep running until killed
  }

  switch (`${group ?? ""} ${cmd ?? ""}`.trim()) {
    case "stats": {
      print(admin.stats());
      return;
    }
    case "entries list": {
      const window = flags.window;
      if (
        window !== undefined &&
        window !== "persona" &&
        window !== "task" &&
        window !== "all"
      ) {
        fail("--window 必须是 persona|task|all");
      }
      print(
        admin.listEntries({
          window: (window as "persona" | "task" | "all" | undefined) ?? "all",
          query: typeof flags.query === "string" ? flags.query : undefined,
          limit: typeof flags.limit === "string" ? Number(flags.limit) : undefined,
          offset: typeof flags.offset === "string" ? Number(flags.offset) : undefined,
        }),
      );
      return;
    }
    case "entries show": {
      const id = positionals[0];
      if (!id) fail("entries show <id>");
      const e = admin.getEntry(id);
      if (!e) fail(`no entry ${id}`);
      print(e);
      return;
    }
    case "entries edit": {
      const id = positionals[0];
      if (!id) fail("entries edit <id> --text ...");
      if (typeof flags.text !== "string") fail("entries edit 需要 --text");
      const importance = flags.importance;
      if (
        importance !== undefined &&
        importance !== "heavy" &&
        importance !== "light"
      ) {
        fail("--importance 必须是 heavy|light");
      }
      print({
        ok: true,
        entry: admin.editEntry(id, {
          text: flags.text,
          ...(importance ? { importance: importance as "heavy" | "light" } : {}),
        }),
      });
      return;
    }
    case "entries correct": {
      const id = positionals[0];
      if (!id) fail("entries correct <id> --text ...");
      if (typeof flags.text !== "string") fail("entries correct 需要 --text");
      print({
        ok: true,
        entry: admin.correctEntry(id, {
          text: flags.text,
          ...(typeof flags.factKey === "string" ? { factKey: flags.factKey } : {}),
        }),
      });
      return;
    }
    case "entries delete": {
      const id = positionals[0];
      if (!id) fail("entries delete <id> --yes");
      if (flags.yes !== true) {
        fail("entries delete 需要 --yes（删是物理删除，先快照再删，不可逆）");
      }
      print({ ok: true, ...admin.deleteEntry(id) });
      return;
    }
    case "forget request": {
      const mode = flags.mode;
      if (mode !== "hide" && mode !== "delete") {
        fail("forget request 需要 --mode hide|delete");
      }
      const ids = splitIds(flags.ids);
      if (ids.length === 0) fail("forget request 需要 --ids a,b");
      print({
        ok: true,
        request: admin.requestForget({
          mode,
          entryIds: ids,
          ...(typeof flags.reason === "string" ? { reason: flags.reason } : {}),
        }),
      });
      return;
    }
    case "forget dry-run": {
      const ids = splitIds(flags.ids);
      if (ids.length === 0) fail("forget dry-run 需要 --ids a,b");
      print(admin.dryRunForget(ids));
      return;
    }
    case "forget list": {
      print(admin.listForgetRequests());
      return;
    }
    case "forget approve": {
      const id = positionals[0];
      if (!id) fail("forget approve <request-id>");
      print({ ok: true, request: admin.approveForget(id) });
      return;
    }
    case "forget execute": {
      const id = positionals[0];
      if (!id) fail("forget execute <request-id>");
      print({ ok: true, ...admin.executeForget(id) });
      return;
    }
    case "forget unhide": {
      const ids = splitIds(flags.ids);
      if (ids.length === 0) fail("forget unhide 需要 --ids a,b");
      print({ ok: true, cleared: admin.unforget(ids) });
      return;
    }
    case "purge": {
      // 终版 WP2: default dry-run; --yes is required to write.
      // The pattern is never echoed to stdout/audit; prefer
      // --pattern-file so it does not land in shell history.
      let pattern = typeof flags.pattern === "string" ? flags.pattern : "";
      if (pattern.length === 0 && typeof flags["pattern-file"] === "string") {
        try {
          pattern = readFileSync(flags["pattern-file"], "utf8").trim();
        } catch (err) {
          fail(
            `读不了 --pattern-file：${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      if (pattern.trim().length < 4) {
        fail("purge 需要 --pattern 或 --pattern-file（至少 4 个字符）");
      }
      const dryRun = flags.yes !== true;
      const includeSnapshots = flags["no-snapshots"] !== true;
      print(
        core.purgeByPattern(pattern, {
          dryRun,
          by: "cli",
          includeSnapshots,
        }),
      );
      return;
    }
    case "goals add": {
      if (typeof flags.title !== "string") fail("goals add 需要 --title");
      print({
        ok: true,
        goal: admin.createGoal({
          title: flags.title,
          dueAt: parseDue(
            typeof flags.due === "string" ? flags.due : undefined,
          ),
          ...(typeof flags.notes === "string" ? { notes: flags.notes } : {}),
        }),
      });
      return;
    }
    case "goals list": {
      const status = flags.status;
      if (
        status !== undefined &&
        status !== "open" &&
        status !== "done" &&
        status !== "dropped"
      ) {
        fail("--status 必须是 open|done|dropped");
      }
      print(admin.listGoals(status as "open" | "done" | "dropped" | undefined));
      return;
    }
    case "goals done":
    case "goals reopen":
    case "goals drop": {
      const id = positionals[0];
      if (!id) fail(`goals ${cmd} <id>`);
      const status =
        cmd === "done" ? "done" : cmd === "reopen" ? "open" : "dropped";
      const g = admin.setGoalStatus(id, status);
      if (!g) fail(`no goal ${id}`);
      print({ ok: true, goal: g });
      return;
    }
    case "goals remove": {
      const id = positionals[0];
      if (!id) fail("goals remove <id>");
      print({ ok: true, removed: admin.removeGoal(id) });
      return;
    }
    case "exp add": {
      if (typeof flags.rule !== "string") fail("exp add 需要 --rule");
      if (typeof flags.source !== "string") fail("exp add 需要 --source");
      const trigger = splitIds(flags.trigger);
      if (trigger.length === 0) fail("exp add 需要 --trigger a,b");
      const sourceIds = splitIds(flags["source-ids"]);
      if (sourceIds.length === 0) fail("exp add 需要 --source-ids a,b（真实记忆 id）");
      print({
        ok: true,
        experience: admin.recordExperience({
          rule: flags.rule,
          trigger,
          source: flags.source,
          sourceIds,
        }),
      });
      return;
    }
    case "exp confirm": {
      const id = positionals[0];
      if (!id) fail("exp confirm <id> [--expires-days N]");
      const days = typeof flags["expires-days"] === "string"
        ? Number(flags["expires-days"])
        : undefined;
      const expiresAt =
        days !== undefined && Number.isFinite(days) && days > 0
          ? Date.now() + Math.floor(days) * 86_400_000
          : undefined;
      print({ ok: true, confirmed: admin.confirmExperience(id, expiresAt) });
      return;
    }
    case "exp revoke": {
      const id = positionals[0];
      if (!id) fail("exp revoke <id>");
      print({ ok: true, revoked: admin.revokeExperience(id) });
      return;
    }
    case "exp list": {
      print(admin.listExperiences());
      return;
    }
    case "exp remove": {
      const id = positionals[0];
      if (!id) fail("exp remove <id>");
      print({ ok: true, removed: admin.removeExperience(id) });
      return;
    }
    case "semantic status": {
      print(admin.semanticStatus());
      return;
    }
    case "semantic install": {
      // 终版 WP9: the only network command. Default is a dry-run:
      // it prints the npm command and exits; --yes actually installs.
      const out = installTransformersRuntime(dataDir, {
        yes: flags.yes === true,
        dryRun: flags.yes !== true,
        ...(typeof flags.timeout === "string"
          ? { timeoutMs: Number(flags.timeout) }
          : {}),
      });
      print(out);
      if (!out.ok && !out.needsConfirmation) {
        process.exit(1);
      }
      return;
    }
    case "semantic rebuild": {
      print({ ok: true, ...(await admin.rebuildSemanticIndex()) });
      return;
    }
    default: {
      console.error(
        "用法: node core/src/admin-cli.ts --dataDir <dir> <command>\n" +
          "  stats | entries list|show|edit|correct|delete | forget request|dry-run|list|approve|execute|unhide\n" +
          "  goals add|list|done|reopen|drop|remove | exp add|list|confirm|revoke|remove\n" +
          "  semantic status|install|rebuild | serve [--port N] [--token T]",
      );
      process.exit(1);
    }
  }
}

if (process.argv[1]?.endsWith("admin-cli.ts")) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(
      `admin: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  });
}

export { main as runAdminCli };
