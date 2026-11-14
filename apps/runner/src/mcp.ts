// The agent's tools inside Claude Code and Codex. The CLI starts `<runner> mcp` as an MCP server
// (stdio); that process talks to the runner over a Unix socket (0600, in the runner folder) and
// identifies itself with the turn token, which only exists while the turn runs. The runner relays each call
// to the server (`harness.tool`), which runs the tool with the usual permissions and approvals.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, rmSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { PRODUCT } from "@vanr/product";
import { ensureDir } from "./config";
import { parseRecord, record } from "./json";

export const MCP_SERVER_NAME = "agent";
const ENV_PREFIX = PRODUCT.slug.toUpperCase();
export const MCP_TOKEN_ENV = `${ENV_PREFIX}_MCP_TOKEN`;
export const MCP_SOCKET_ENV = `${ENV_PREFIX}_MCP_SOCKET`;
/** Claude Code sees `mcp__agent__<name>` and the API accepts up to 64 characters in the tool name. */
const EXPOSED_MAX = 50;

export interface BridgeTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolOutcome {
  content: string;
  isError: boolean;
}

interface Turn {
  digest: Buffer;
  tools: Map<string, BridgeTool & { real: string }>;
  call: (name: string, input: unknown) => Promise<ToolOutcome>;
  /** Connections of this turn's MCP server; they close with the turn. */
  sockets: Set<Socket>;
}

const digestOf = (token: string) => createHash("sha256").update(token).digest();

/** A short, stable name for the CLI; the runner maps it back before calling the server. */
export function exposedName(name: string): string {
  if (name.length <= EXPOSED_MAX) return name;
  const hash = createHash("sha256").update(name).digest("hex").slice(0, 8);
  return `${name.slice(0, EXPOSED_MAX - 9)}_${hash}`;
}

/** Socket path: in the runner folder, or in tmp when it would go past the system limit (104). */
function socketPath(home: string): string {
  const inHome = join(home, "mcp.sock");
  if (Buffer.byteLength(inHome) < 100) return inHome;
  const hash = createHash("sha256").update(home).digest("hex").slice(0, 16);
  return join(tmpdir(), `${PRODUCT.slug}-${hash}.sock`);
}

export class McpBridge {
  private server: Server | null = null;
  private listening: Promise<void> | null = null;
  private readonly turns = new Map<string, Turn>();
  readonly path: string;

  constructor(home: string) {
    ensureDir(home);
    this.path = socketPath(home);
  }

  private start(): Promise<void> {
    if (this.listening) return this.listening;
    if (existsSync(this.path)) rmSync(this.path, { force: true });
    const server = createServer((socket) => this.serve(socket));
    this.server = server;
    this.listening = new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.path, () => {
        chmodSync(this.path, 0o600);
        resolve();
      });
    });
    return this.listening;
  }

  /** Opens the turn on the bridge and returns the token (it goes to the MCP server's environment, never to argv). */
  async open(tools: BridgeTool[], call: Turn["call"]): Promise<{ token: string; close: () => void }> {
    await this.start();
    const token = randomBytes(24).toString("base64url");
    const key = randomBytes(8).toString("hex");
    const map = new Map<string, BridgeTool & { real: string }>();
    for (const t of tools) map.set(exposedName(t.name), { ...t, name: exposedName(t.name), real: t.name });
    const turn: Turn = { digest: digestOf(token), tools: map, call, sockets: new Set() };
    this.turns.set(key, turn);
    return {
      token,
      close: () => {
        this.turns.delete(key);
        for (const s of turn.sockets) s.destroy();
      },
    };
  }

  private find(token: string): Turn | null {
    const d = digestOf(token);
    for (const t of this.turns.values()) if (timingSafeEqual(t.digest, d)) return t;
    return null;
  }

  private serve(socket: Socket) {
    let turn: Turn | null = null;
    const reply = (obj: unknown) => {
      if (!socket.destroyed) socket.write(`${JSON.stringify(obj)}\n`);
    };
    const lines = createInterface({ input: socket });
    lines.on("line", (line) => {
      const msg = parseRecord(line);
      if (!msg) {
        socket.destroy();
        return;
      }
      if (!turn) {
        turn = typeof msg.token === "string" ? this.find(msg.token) : null;
        if (!turn) socket.destroy();
        else {
          turn.sockets.add(socket);
          reply({ ok: true });
        }
        return;
      }
      const current = turn;
      const id = msg.id;
      if (msg.op === "list") {
        reply({
          id,
          tools: [...current.tools.values()].map(({ name, description, inputSchema }) => ({
            name,
            description,
            inputSchema,
          })),
        });
        return;
      }
      if (msg.op === "call" && typeof msg.name === "string") {
        const tool = current.tools.get(msg.name);
        if (!tool) {
          reply({ id, content: `Unknown tool ${msg.name}`, isError: true });
          return;
        }
        current.call(tool.real, msg.input ?? {}).then(
          (out) => reply({ id, ...out }),
          (err) => reply({ id, content: err instanceof Error ? err.message : String(err), isError: true }),
        );
        return;
      }
      reply({ id, content: "Bad request", isError: true });
    });
    socket.on("error", () => {});
    socket.on("close", () => turn?.sockets.delete(socket));
  }

  close() {
    for (const t of this.turns.values()) for (const s of t.sockets) s.destroy();
    this.turns.clear();
    this.server?.close();
    this.server = null;
    this.listening = null;
    rmSync(this.path, { force: true });
  }
}

// ---- the MCP server (stdio) the CLI starts: `<runner> mcp` ----

/**
 * Speaks MCP (line-delimited JSON-RPC) on stdin/stdout and relays to the runner over the socket. It ends when
 * the CLI closes stdin or the runner closes the socket (end of the turn).
 */
export async function runMcpStdio(env: Record<string, string | undefined> = process.env): Promise<number> {
  const token = env[MCP_TOKEN_ENV];
  const path = env[MCP_SOCKET_ENV];
  if (!token || !path) {
    process.stderr.write("mcp: missing runner bridge\n");
    return 2;
  }
  const socket = createConnection(path);
  const pending = new Map<number, (msg: Record<string, unknown>) => void>();
  let seq = 0;
  const closed = new Promise<number>((resolve) => {
    socket.on("close", () => resolve(0));
    socket.on("error", () => resolve(1));
  });
  const ready = new Promise<boolean>((resolve) => {
    socket.once("connect", () => socket.write(`${JSON.stringify({ token })}\n`));
    void closed.then(() => resolve(false));
    let first = true;
    createInterface({ input: socket }).on("line", (line) => {
      const msg = parseRecord(line);
      if (!msg) return;
      if (first) {
        first = false;
        resolve(true);
        return;
      }
      const done = pending.get(Number(msg.id));
      pending.delete(Number(msg.id));
      done?.(msg);
    });
  });
  if (!(await ready)) {
    process.stderr.write("mcp: the runner rejected this bridge\n");
    return 1;
  }
  const ask = (msg: Record<string, unknown>) =>
    new Promise<Record<string, unknown>>((resolve) => {
      const id = ++seq;
      pending.set(id, resolve);
      socket.write(`${JSON.stringify({ ...msg, id })}\n`);
    });
  const out = (obj: unknown) => process.stdout.write(`${JSON.stringify(obj)}\n`);
  const rl = createInterface({ input: process.stdin });
  rl.on("line", async (line) => {
    const req = parseRecord(line);
    if (!req) return;
    // A notification (e.g. notifications/initialized) has no id; JSON-RPC ids are strings or numbers.
    const id = req.id;
    if (typeof id !== "string" && typeof id !== "number") return;
    const params = record(req.params);
    const ok = (result: unknown) => out({ jsonrpc: "2.0", id, result });
    switch (req.method) {
      case "initialize":
        ok({
          protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: `${PRODUCT.slug}-agent`, version: "1" },
        });
        return;
      case "ping":
        ok({});
        return;
      case "tools/list":
        ok({ tools: (await ask({ op: "list" })).tools ?? [] });
        return;
      case "tools/call": {
        const r = await ask({ op: "call", name: params.name, input: params.arguments ?? {} });
        ok({ content: [{ type: "text", text: String(r.content ?? "") }], isError: r.isError === true });
        return;
      }
      default:
        out({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
    }
  });
  rl.on("close", () => socket.end());
  return closed;
}
