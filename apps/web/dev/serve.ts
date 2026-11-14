// Runs the fake server over HTTP and WebSocket, for developing the web in a browser:
//
//   bun dev/serve.ts                  the API on 127.0.0.1:4319; `bun run dev` proxies /api to it
//   bun dev/serve.ts --static dist    also serves a build of the web, as one origin
//
// Sign in as ana@birchwood.example with the password in EXAMPLE_PASSWORD. Any state can be forced
// with a POST to /__fake (see Control below), e.g.
//   curl -X POST localhost:4319/__fake -d '{"action":"force","method":"signUp","status":503,"code":"signup_busy","retryAfter":5}'
import { join, normalize, resolve } from "node:path";
import { z } from "zod";
import { API_METHODS } from "../src/api/methods.ts";
import type { SocketHandle } from "../src/realtime/connection.ts";
import { FakeOffline, FakeServer, type SeedName } from "./fake-server.ts";

const COOKIE = "vanr.session_token";
const VERBS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

const args = process.argv.slice(2);
const option = (name: string) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};
const port = Number(option("--port") ?? process.env.VANR_FAKE_PORT ?? 4319);
const staticDir = option("--static");
const seed = z.enum(["team", "closed", "empty"]).catch("team").parse(option("--seed"));

const server = new FakeServer({ seed, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) });

const Method = z.enum(API_METHODS as [string, ...string[]]).transform((name) => {
  const method = API_METHODS.find((candidate) => candidate === name);
  if (method === undefined) throw new Error(`unknown method ${name}`);
  return method;
});

/** What a POST to /__fake may ask for. */
const Control = z.discriminatedUnion("action", [
  z.object({ action: z.literal("reset"), seed: z.enum(["team", "closed", "empty"]) }),
  z.object({
    action: z.literal("force"),
    method: Method,
    status: z.number().int(),
    code: z.string(),
    message: z.string().optional(),
    retryAfter: z.number().int().optional(),
    envelope: z.boolean().optional(),
    times: z.number().int().positive().optional(),
  }),
  z.object({ action: z.literal("offline"), method: Method, times: z.number().int().positive().optional() }),
  z.object({ action: z.literal("slow"), method: Method, ms: z.number().int().min(0) }),
  z.object({ action: z.literal("expire") }),
  z.object({ action: z.literal("connection"), block: z.boolean() }),
  z.object({ action: z.literal("busy"), agentId: z.string(), busy: z.boolean() }),
  z.object({ action: z.literal("signin"), userId: z.string() }),
]);

function sessionOf(request: Request): string | undefined {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === COOKIE) return decodeURIComponent(value.join("="));
  }
  return undefined;
}

const cookie = (value: string | null) =>
  value === null
    ? `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
    : `${COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax`;

async function control(request: Request): Promise<Response> {
  const parsed = Control.safeParse(await request.json().catch(() => undefined));
  if (!parsed.success) return Response.json({ error: z.treeifyError(parsed.error) }, { status: 400 });
  const command = parsed.data;
  const headers = new Headers();
  switch (command.action) {
    case "reset":
      server.reset(command.seed satisfies SeedName);
      break;
    case "force": {
      const { method, times, action: _action, ...forced } = command;
      server.force(method, { kind: "error", ...forced }, times);
      break;
    }
    case "offline":
      server.force(command.method, { kind: "offline" }, command.times);
      break;
    case "slow":
      server.slow(command.method, command.ms);
      break;
    case "expire":
      server.expireSessions();
      break;
    case "connection":
      server.blockConnections(command.block);
      if (command.block) server.dropConnections();
      break;
    case "busy":
      server.setAgentBusy(command.agentId, command.busy);
      break;
    case "signin":
      headers.set("set-cookie", cookie(server.sessionFor(command.userId)));
      break;
    default: {
      const _exhaustive: never = command;
      return _exhaustive;
    }
  }
  return Response.json({ ok: true }, { headers });
}

async function api(request: Request, url: URL): Promise<Response> {
  const verb = VERBS.find((candidate) => candidate === request.method);
  if (verb === undefined) return new Response(null, { status: 405 });
  const text = await request.text();
  let body: unknown;
  try {
    body = text.trim() === "" ? undefined : JSON.parse(text);
  } catch {
    return Response.json(
      { error: { code: "invalid_request", message: "Body is not valid JSON" } },
      { status: 400 },
    );
  }
  try {
    const answer = await server.handle({
      verb,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      body,
      session: sessionOf(request),
    });
    const headers = new Headers();
    if (answer.retryAfter !== undefined) headers.set("retry-after", String(answer.retryAfter));
    if (answer.setSession !== undefined) headers.set("set-cookie", cookie(answer.setSession));
    if (answer.status === 204 || answer.body === null)
      return new Response(null, { status: answer.status, headers });
    return Response.json(answer.body, { status: answer.status, headers });
  } catch (cause) {
    if (cause instanceof FakeOffline)
      return new Response(null, { status: 599, statusText: "forced offline" });
    throw cause;
  }
}

async function file(pathname: string): Promise<Response> {
  if (staticDir === undefined) return new Response("Not found", { status: 404 });
  const root = resolve(staticDir);
  const wanted = normalize(join(root, pathname));
  const asset = Bun.file(wanted.startsWith(root) ? wanted : join(root, "index.html"));
  // Any address that is not a file is a route of the single-page app.
  return new Response(
    (await asset.exists()) && pathname !== "/" ? asset : Bun.file(join(root, "index.html")),
  );
}

type SocketData = { workspaceId: string; session: string | undefined; handle?: SocketHandle };

Bun.serve<SocketData>({
  hostname: "127.0.0.1",
  port,
  fetch(request, bun) {
    const url = new URL(request.url);
    if (url.pathname === "/api/v1/realtime") {
      const data: SocketData = {
        workspaceId: url.searchParams.get("workspaceId") ?? "",
        session: sessionOf(request),
      };
      return bun.upgrade(request, { data }) ? undefined : new Response("Use WebSocket", { status: 426 });
    }
    if (url.pathname === "/__fake" && request.method === "POST") return control(request);
    if (url.pathname.startsWith("/api/")) return api(request, url);
    return file(url.pathname);
  },
  websocket: {
    open(socket) {
      socket.data.handle = server.connect(socket.data.workspaceId, socket.data.session, {
        open: () => {},
        message: (data) => {
          if (typeof data === "string") socket.send(data);
        },
        close: (code) => socket.close(code === 1006 ? 1011 : code, "closed by the fake server"),
      });
    },
    message(socket, message) {
      if (typeof message === "string") socket.data.handle?.send(message);
    },
    close(socket) {
      socket.data.handle?.close();
    },
  },
});

console.log(
  `fake Vanr server on http://127.0.0.1:${port} (seed: ${seed}${staticDir ? `, serving ${staticDir}` : ""})`,
);
