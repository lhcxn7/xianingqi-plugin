// Local admin API (0.5.1 item 3): the same MemoryAdmin surface
// over HTTP on localhost, for the future web UI to call. No auth
// by design — it binds 127.0.0.1 ONLY and refuses non-loopback
// sockets even if the bind is ever widened. Never expose this
// port, never put it behind a tunnel: anyone who can reach it can
// read, edit and delete memories.
//
//   GET  /api/stats
//   GET  /api/entries?window=&q=&limit=&offset=
//   GET  /api/entries/:id
//   PATCH /api/entries/:id            {text?, importance?}
//   DELETE /api/entries/:id
//   POST /api/entries/:id/correct     {text, factKey?, importance?}
//   GET  /api/forget/requests
//   POST /api/forget/request          {mode, entryIds, reason?}
//   POST /api/forget/dry-run          {entryIds}
//   POST /api/forget/requests/:id/approve
//   POST /api/forget/requests/:id/execute
//   POST /api/forget/unhide           {entryIds}
//   GET  /api/goals?status=
//   POST /api/goals                   {title, dueAt?, notes?, sourceIds?}
//   PATCH /api/goals/:id              {title?, status?, dueAt?, notes?}
//   DELETE /api/goals/:id
//   GET  /api/experiences
//   POST /api/experiences             {rule, trigger, source, sourceIds}
//   POST /api/experiences/:id/confirm {expiresAt?}
//   POST /api/experiences/:id/revoke
//   DELETE /api/experiences/:id
//   GET  /api/semantic/status
//   POST /api/semantic/rebuild
//
// Every response is JSON: {ok:true, ...} or {ok:false, error}.

import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { MemoryCore } from "./core.ts";
import { MemoryAdmin } from "./admin.ts";

export interface AdminServerOptions {
  port?: number;
  host?: string;
  /** 0.5.3: bearer token. Generated when omitted; every request
   *  (read or write) must present `Authorization: Bearer <token>`.
   *  Loopback binding alone is not an access-control boundary. */
  token?: string;
}

export interface AdminServerHandle {
  server: Server;
  port: number;
  url: string;
  /** 0.5.3: the bearer token clients must send. */
  token: string;
  close: () => Promise<void>;
}

function send(res: ServerResponse, status: number, obj: unknown): void {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > 1_000_000) throw new Error("body too large (1MB cap)");
    chunks.push(buf);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new Error("body is not valid JSON");
  }
}

function bodyOf(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new Error("body must be a JSON object");
  }
  return body as Record<string, unknown>;
}

function str(v: unknown, name: string): string {
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return v;
}

function strArr(v: unknown, name: string): string[] {
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
    throw new Error(`${name} must be an array of strings`);
  }
  return v as string[];
}

export async function startAdminServer(
  core: MemoryCore,
  opts: AdminServerOptions = {},
): Promise<AdminServerHandle> {
  const admin = new MemoryAdmin(core, "admin-api");
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? 18081;
  const token = opts.token ?? randomBytes(16).toString("hex");
  const server = createServer(async (req, res) => {
    // Defense in depth: even if the bind is widened one day, a
    // non-loopback socket is refused outright.
    const remote = req.socket.remoteAddress ?? "";
    if (remote !== "127.0.0.1" && remote !== "::1" && remote !== "::ffff:127.0.0.1") {
      send(res, 403, { ok: false, error: "admin API is localhost-only" });
      return;
    }
    // 0.5.3: loopback is not authentication. Every request needs the
    // bearer token printed by startAdminServer().
    if ((req.headers.authorization ?? "") !== `Bearer ${token}`) {
      send(res, 401, { ok: false, error: "missing or invalid bearer token" });
      return;
    }
    try {
      const url = new URL(req.url ?? "/", `http://${host}:${port}`);
      const parts = url.pathname.split("/").filter((p) => p.length > 0);
      const method = req.method ?? "GET";
      const body = method === "GET" || method === "DELETE" ? {} : await readBody(req);

      // ---- stats ----
      if (method === "GET" && parts.join("/") === "api/stats") {
        send(res, 200, { ok: true, ...admin.stats() });
        return;
      }
      // ---- entries ----
      if (parts[0] === "api" && parts[1] === "entries") {
        if (method === "GET" && parts.length === 2) {
          const window = url.searchParams.get("window") ?? "all";
          if (window !== "persona" && window !== "task" && window !== "all") {
            throw new Error("window must be persona|task|all");
          }
          send(res, 200, {
            ok: true,
            ...admin.listEntries({
              window,
              query: url.searchParams.get("q") ?? undefined,
              limit: url.searchParams.has("limit")
                ? Number(url.searchParams.get("limit"))
                : undefined,
              offset: url.searchParams.has("offset")
                ? Number(url.searchParams.get("offset"))
                : undefined,
            }),
          });
          return;
        }
        if (parts.length === 3) {
          const id = decodeURIComponent(parts[2]);
          if (method === "GET") {
            const e = admin.getEntry(id);
            if (!e) {
              send(res, 404, { ok: false, error: `no entry ${id}` });
              return;
            }
            send(res, 200, { ok: true, entry: e });
            return;
          }
          if (method === "PATCH") {
            const b = bodyOf(body);
            send(res, 200, {
              ok: true,
              entry: admin.editEntry(id, {
                ...(b.text !== undefined ? { text: str(b.text, "text") } : {}),
                ...(b.importance !== undefined
                  ? { importance: b.importance as "heavy" | "light" }
                  : {}),
              }),
            });
            return;
          }
          if (method === "DELETE") {
            send(res, 200, { ok: true, ...admin.deleteEntry(id) });
            return;
          }
        }
        if (parts.length === 4 && parts[3] === "correct" && method === "POST") {
          const id = decodeURIComponent(parts[2]);
          const b = bodyOf(body);
          send(res, 200, {
            ok: true,
            entry: admin.correctEntry(id, {
              text: str(b.text, "text"),
              ...(b.factKey !== undefined ? { factKey: str(b.factKey, "factKey") } : {}),
              ...(b.importance !== undefined
                ? { importance: b.importance as "heavy" | "light" }
                : {}),
            }),
          });
          return;
        }
      }
      // ---- forgetting ----
      if (parts[0] === "api" && parts[1] === "forget") {
        if (method === "GET" && parts.join("/") === "api/forget/requests") {
          send(res, 200, { ok: true, requests: admin.listForgetRequests() });
          return;
        }
        if (method === "POST" && parts.join("/") === "api/forget/request") {
          const b = bodyOf(body);
          if (b.mode !== "hide" && b.mode !== "delete") {
            throw new Error('mode must be "hide" or "delete"');
          }
          send(res, 200, {
            ok: true,
            request: admin.requestForget({
              mode: b.mode,
              entryIds: strArr(b.entryIds, "entryIds"),
              ...(b.reason !== undefined ? { reason: str(b.reason, "reason") } : {}),
            }),
          });
          return;
        }
        if (method === "POST" && parts.join("/") === "api/forget/dry-run") {
          const b = bodyOf(body);
          send(res, 200, { ok: true, ...admin.dryRunForget(strArr(b.entryIds, "entryIds")) });
          return;
        }
        if (method === "POST" && parts.join("/") === "api/forget/unhide") {
          const b = bodyOf(body);
          send(res, 200, { ok: true, cleared: admin.unforget(strArr(b.entryIds, "entryIds")) });
          return;
        }
        if (parts.length === 5 && parts[2] === "requests" && method === "POST") {
          const id = decodeURIComponent(parts[3]);
          const action = parts[4];
          if (action === "approve") {
            send(res, 200, { ok: true, request: admin.approveForget(id) });
            return;
          }
          if (action === "execute") {
            send(res, 200, { ok: true, ...admin.executeForget(id) });
            return;
          }
        }
      }
      // ---- goals ----
      if (parts[0] === "api" && parts[1] === "goals") {
        if (method === "GET" && parts.length === 2) {
          const status = url.searchParams.get("status");
          if (status !== null && status !== "open" && status !== "done" && status !== "dropped") {
            throw new Error("status must be open|done|dropped");
          }
          send(res, 200, {
            ok: true,
            goals: admin.listGoals(status as "open" | "done" | "dropped" | undefined),
          });
          return;
        }
        if (method === "POST" && parts.length === 2) {
          const b = bodyOf(body);
          send(res, 200, {
            ok: true,
            goal: admin.createGoal({
              title: str(b.title, "title"),
              ...(b.dueAt !== undefined ? { dueAt: Number(b.dueAt) } : {}),
              ...(b.notes !== undefined ? { notes: str(b.notes, "notes") } : {}),
              ...(b.sourceIds !== undefined ? { sourceIds: strArr(b.sourceIds, "sourceIds") } : {}),
            }),
          });
          return;
        }
        if (parts.length === 3) {
          const id = decodeURIComponent(parts[2]);
          if (method === "PATCH") {
            const b = bodyOf(body);
            const g = admin.updateGoal(id, {
              ...(b.title !== undefined ? { title: str(b.title, "title") } : {}),
              ...(b.dueAt !== undefined
                ? { dueAt: b.dueAt === null ? null : Number(b.dueAt) }
                : {}),
              ...(b.notes !== undefined
                ? { notes: b.notes === null ? null : str(b.notes, "notes") }
                : {}),
            });
            if (b.status !== undefined) {
              const s = admin.setGoalStatus(
                id,
                b.status as "open" | "done" | "dropped",
              );
              send(res, 200, { ok: true, goal: s ?? g });
              return;
            }
            if (!g) {
              send(res, 404, { ok: false, error: `no goal ${id}` });
              return;
            }
            send(res, 200, { ok: true, goal: g });
            return;
          }
          if (method === "DELETE") {
            send(res, 200, { ok: true, removed: admin.removeGoal(id) });
            return;
          }
        }
      }
      // ---- experiences ----
      if (parts[0] === "api" && parts[1] === "experiences") {
        if (method === "GET" && parts.length === 2) {
          send(res, 200, { ok: true, experiences: admin.listExperiences() });
          return;
        }
        if (method === "POST" && parts.length === 2) {
          const b = bodyOf(body);
          send(res, 200, {
            ok: true,
            experience: admin.recordExperience({
              rule: str(b.rule, "rule"),
              trigger: strArr(b.trigger, "trigger"),
              source: str(b.source, "source"),
              sourceIds: strArr(b.sourceIds, "sourceIds"),
            }),
          });
          return;
        }
        if (method === "POST" && parts.length === 4 && parts[3] === "confirm") {
          const b = bodyOf(body);
          const expiresAt =
            typeof b.expiresAt === "number" ? b.expiresAt : undefined;
          send(res, 200, {
            ok: true,
            confirmed: admin.confirmExperience(
              decodeURIComponent(parts[2]),
              expiresAt,
            ),
          });
          return;
        }
        if (method === "POST" && parts.length === 4 && parts[3] === "revoke") {
          send(res, 200, {
            ok: true,
            revoked: admin.revokeExperience(decodeURIComponent(parts[2])),
          });
          return;
        }
        if (method === "DELETE" && parts.length === 3) {
          send(res, 200, { ok: true, removed: admin.removeExperience(decodeURIComponent(parts[2])) });
          return;
        }
      }
      // ---- semantic ----
      if (parts[0] === "api" && parts[1] === "semantic") {
        if (method === "GET" && parts.join("/") === "api/semantic/status") {
          send(res, 200, { ok: true, ...admin.semanticStatus() });
          return;
        }
        if (method === "POST" && parts.join("/") === "api/semantic/rebuild") {
          send(res, 200, { ok: true, ...(await admin.rebuildSemanticIndex()) });
          return;
        }
      }
      send(res, 404, { ok: false, error: `no route ${method} ${url.pathname}` });
    } catch (err) {
      send(res, 400, {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
  const address = server.address();
  const actualPort = typeof address === "object" && address !== null ? address.port : port;
  return {
    server,
    port: actualPort,
    url: `http://${host}:${actualPort}`,
    token,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
