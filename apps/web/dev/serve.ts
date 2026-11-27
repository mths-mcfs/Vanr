// Runs the fake server over HTTP and WebSocket, for developing the web in a browser:
//
//   bun dev/serve.ts                  the API on 127.0.0.1:4319; `bun run dev` proxies /api to it
//   bun dev/serve.ts --static dist    also serves a build of the web, as one origin
//
// Sign in as ana@birchwood.example with the password in EXAMPLE_PASSWORD. Any state can be forced
// with a POST to /__fake (see Control below), e.g.
//   curl -X POST localhost:4319/__fake -d '{"action":"force","method":"signUp","status":503,"code":"signup_busy","retryAfter":5}'
import { join, normalize, resolve } from "node:path";
import type { SocketLike } from "@vanr/client";
import { z } from "zod";
import { FAKE_METHODS, FakeServer, type SeedName } from "./fake-server.ts";

const COOKIE = "vanr.session_token";

const args = process.argv.slice(2);
const option = (name: string) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};
const port = Number(option("--port") ?? process.env.VANR_FAKE_PORT ?? 4319);
const staticDir = option("--static");
const seed = z.enum(["team", "closed", "empty"]).catch("team").parse(option("--seed"));

const server = new FakeServer({ seed, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) });

const Method = z.string().transform((name, context) => {
  const method = FAKE_METHODS.find((candidate) => candidate === name);
  if (method !== undefined) return method;
  context.addIssue({ code: "custom", message: `unknown method ${name}` });
  return z.NEVER;
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
    retryAfter: z.union([z.number().int(), z.string()]).optional(),
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
  // One jar per request, filled from the browser's cookie; what the server sets goes back as one.
  const before = sessionOf(request);
  const jar = { session: before };
  const text = await request.text();
  try {
    const answer = await server.fetch(jar)(`${url.pathname}${url.search}`, {
      method: request.method,
      headers: request.headers,
      ...(text !== "" && { body: text }),
    });
    if (jar.session === before) return answer;
    const headers = new Headers(answer.headers);
    headers.set("set-cookie", cookie(jar.session ?? null));
    return new Response(answer.body, { status: answer.status, headers });
  } catch (cause) {
    // A forced "offline": the nearest a server can get to not answering.
    if (cause instanceof TypeError) return new Response(null, { status: 599, statusText: "forced offline" });
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

type SocketData = { url: string; session: string | undefined; served?: SocketLike };

Bun.serve<SocketData>({
  hostname: "127.0.0.1",
  port,
  fetch(request, bun) {
    const url = new URL(request.url);
    if (url.pathname === "/api/v1/realtime") {
      const data: SocketData = { url: request.url, session: sessionOf(request) };
      return bun.upgrade(request, { data }) ? undefined : new Response("Use WebSocket", { status: 426 });
    }
    if (url.pathname === "/__fake" && request.method === "POST") return control(request);
    if (url.pathname.startsWith("/api/")) return api(request, url);
    return file(url.pathname);
  },
  websocket: {
    open(socket) {
      // The fake server's side of the socket, wired to the real one.
      const served = server.socketFactory({ session: socket.data.session })(socket.data.url);
      served.onmessage = ({ data }) => {
        if (typeof data === "string") socket.send(data);
      };
      served.onclose = ({ code }) => socket.close(code === 1006 ? 1011 : code, "closed by the fake server");
      socket.data.served = served;
    },
    message(socket, message) {
      if (typeof message === "string") socket.data.served?.send(message);
    },
    close(socket, code) {
      socket.data.served?.close(code);
    },
  },
});

console.log(
  `fake Vanr server on http://127.0.0.1:${port} (seed: ${seed}${staticDir ? `, serving ${staticDir}` : ""})`,
);
