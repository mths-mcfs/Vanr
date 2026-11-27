// Remote MCP client ("streamable" HTTP transport): JSON-RPC over POST, session in the
// Mcp-Session-Id header and the reply in JSON or SSE. Only what the product uses: listing and calling tools.

import { PRODUCT } from "@vanr/product";
import { z } from "zod";
import { HttpError } from "../http";
import { guardedFetch, type NetPolicy } from "./net";

export const MCP_PROTOCOL = "2025-06-18";
const CLIENT_INFO = { name: `${PRODUCT.slug}-server`, version: "1.0.0" };

/**
 * The server asked for authorization (401). `resourceMetadata` and `scope` come from WWW-Authenticate, when
 * present; the challenge's `scope` is the initial scope to request.
 */
export class McpAuthRequired extends Error {
  constructor(
    readonly resourceMetadata: string | null,
    readonly scope: string | null = null,
  ) {
    super("MCP server requires authorization");
  }
}

/**
 * The token is valid but lacks the operation's scope (403 with `error="insufficient_scope"`, RFC 6750
 * §3.1). `scope` is what the server says it needs; the step-up requests the union with what was there before.
 */
export class McpInsufficientScope extends Error {
  constructor(
    readonly scope: string | null,
    readonly resourceMetadata: string | null,
  ) {
    super("MCP server needs more permission for this operation");
  }
}

export class McpError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
  }
}

const toolSchema = z.object({
  name: z.string().min(1),
  title: z.string().optional(),
  description: z.string().optional(),
  inputSchema: z.record(z.string(), z.unknown()).optional(),
  annotations: z
    .object({ title: z.string().optional(), readOnlyHint: z.boolean().optional() })
    .passthrough()
    .optional(),
});
export type McpTool = z.infer<typeof toolSchema>;

const listSchema = z.object({ tools: z.array(toolSchema), nextCursor: z.string().optional() });
const callSchema = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string().optional() }).passthrough()).default([]),
  isError: z.boolean().optional(),
});
export interface McpCallResult {
  text: string;
  isError: boolean;
}

const rpcResponse = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]).nullable().optional(),
  result: z.unknown().optional(),
  error: z.object({ code: z.number(), message: z.string() }).optional(),
});

export interface McpClientOptions {
  url: string;
  fetch: typeof fetch;
  /**
   * Where the requests may go: every request and every redirect passes `guardedFetch` (the address checked
   * after resolving the name, the connection to that IP, https unless plain text is allowed).
   */
  policy: NetPolicy;
  /** E.g. Authorization: Bearer <key or token>. */
  headers?: Record<string, string>;
  /** Time a request may take, its body included (default 20 s). */
  timeoutMs?: number;
  /** Bytes a response body may hold (default `MCP_MAX_RESPONSE_BYTES`). */
  maxResponseBytes?: number;
}

/** A tool list or a tool result above 8 MiB is a server misbehaving: the client stops reading. */
export const MCP_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/** Reads `resource_metadata="…"` from WWW-Authenticate (RFC 9728). */
export function resourceMetadataFrom(header: string | null): string | null {
  return challengeParam(header, "resource_metadata");
}

/** One parameter of the `Bearer` (or `DPoP`) challenge of WWW-Authenticate, quoted or not. */
export function challengeParam(header: string | null, name: string): string | null {
  if (!header) return null;
  const re = new RegExp(`(?:^|[\\s,])${name}\\s*=\\s*(?:"((?:[^"\\\\]|\\\\.)*)"|([^\\s,]+))`, "i");
  const m = re.exec(header);
  if (!m) return null;
  return (m[1] ?? m[2] ?? "").replace(/\\(.)/g, "$1");
}

/** Joins the `data:` lines of each SSE event and returns the ones that are JSON. */
export function parseSse(text: string): unknown[] {
  const out: unknown[] = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data) continue;
    try {
      out.push(JSON.parse(data));
    } catch {
      // an event that is not JSON-RPC (ping, comment): ignore it
    }
  }
  return out;
}

export class McpClient {
  private sessionId: string | null = null;
  private nextId = 1;
  private ready: Promise<void> | null = null;
  private readonly fetch: typeof fetch;

  constructor(private readonly opts: McpClientOptions) {
    const { allowPrivate, allowPlaintext, resolve } = opts.policy;
    this.fetch = guardedFetch(opts.fetch, allowPrivate, resolve, allowPlaintext);
  }

  /**
   * The body as text within the byte cap and the request's deadline; past either, the read stops (a server
   * that trickles or never ends the stream holds nothing).
   */
  private async text(res: Response, deadline: number): Promise<string> {
    const max = this.opts.maxResponseBytes ?? MCP_MAX_RESPONSE_BYTES;
    if (Number(res.headers.get("content-length") ?? 0) > max)
      throw new McpError("MCP server sent a response that is too large");
    if (!res.body) return "";
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<"late">((resolve) => {
      timer = setTimeout(() => resolve("late"), Math.max(0, deadline - Date.now()));
    });
    try {
      for (;;) {
        const next = await Promise.race([reader.read(), late]);
        if (next === "late") throw new McpError("MCP server did not answer in time");
        if (next.done) break;
        size += next.value.byteLength;
        if (size > max) throw new McpError("MCP server sent a response that is too large");
        chunks.push(next.value);
      }
    } catch (err) {
      if (err instanceof McpError) throw err;
      throw new McpError(
        `Could not read the MCP server's answer: ${err instanceof Error ? err.message : err}`,
      );
    } finally {
      clearTimeout(timer);
      reader.cancel().catch(() => {});
    }
    return Buffer.concat(chunks, size).toString("utf8");
  }

  private async post(body: unknown): Promise<{ res: Response; deadline: number }> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": MCP_PROTOCOL,
      ...this.opts.headers,
    };
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
    let res: Response;
    const timeoutMs = this.opts.timeoutMs ?? 20_000;
    const deadline = Date.now() + timeoutMs;
    try {
      res = await this.fetch(this.opts.url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      // The address the guard rejected keeps its code (`blocked_host`, `invalid_url`, `unreachable`).
      if (err instanceof HttpError) throw err;
      throw new McpError(
        `Could not reach the MCP server: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const challenge = res.headers.get("www-authenticate");
    if (res.status === 401)
      throw new McpAuthRequired(resourceMetadataFrom(challenge), challengeParam(challenge, "scope"));
    if (res.status === 403 && challengeParam(challenge, "error") === "insufficient_scope")
      throw new McpInsufficientScope(challengeParam(challenge, "scope"), resourceMetadataFrom(challenge));
    if (!res.ok && res.status !== 202) throw new McpError(`MCP server answered ${res.status}`, res.status);
    return { res, deadline };
  }

  private async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    const { res, deadline } = await this.post({ jsonrpc: "2.0", id, method, params });
    const session = res.headers.get("mcp-session-id");
    if (session) this.sessionId = session;
    const type = res.headers.get("content-type") ?? "";
    const text = await this.text(res, deadline);
    let messages: unknown[];
    if (type.includes("text/event-stream")) messages = parseSse(text);
    else {
      try {
        messages = [JSON.parse(text)];
      } catch {
        throw new McpError("MCP server sent a response that is not JSON");
      }
    }
    for (const raw of messages.flat()) {
      const parsed = rpcResponse.safeParse(raw);
      if (!parsed.success || parsed.data.id !== id) continue;
      if (parsed.data.error) throw new McpError(parsed.data.error.message);
      return parsed.data.result;
    }
    throw new McpError(`MCP server did not answer ${method}`);
  }

  /** Opens the session once (`initialize`); a caller can await it to tell a failure before any tool call. */
  init(): Promise<void> {
    this.ready ??= (async () => {
      await this.request("initialize", {
        protocolVersion: MCP_PROTOCOL,
        capabilities: {},
        clientInfo: CLIENT_INFO,
      });
      const { res } = await this.post({ jsonrpc: "2.0", method: "notifications/initialized" });
      await res.body?.cancel().catch(() => {});
    })().catch((err) => {
      this.ready = null;
      throw err;
    });
    return this.ready;
  }

  async listTools(): Promise<McpTool[]> {
    await this.init();
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const raw = await this.request("tools/list", cursor ? { cursor } : {});
      const parsed = listSchema.safeParse(raw);
      if (!parsed.success) throw new McpError("MCP server sent an invalid tool list");
      tools.push(...parsed.data.tools);
      cursor = parsed.data.nextCursor;
      if (!cursor) break;
    }
    return tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    await this.init();
    const parsed = callSchema.safeParse(await this.request("tools/call", { name, arguments: args }));
    if (!parsed.success) throw new McpError("MCP server sent an invalid tool result");
    const text = parsed.data.content
      .map((c) => (c.type === "text" && c.text ? c.text : `[${c.type}]`))
      .join("\n");
    return { text, isError: parsed.data.isError === true };
  }
}
