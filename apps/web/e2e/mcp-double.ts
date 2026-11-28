// An MCP server on a local port for the journeys: it answers `initialize`, `tools/list` and `tools/call`
// over the streamable HTTP transport with plain JSON, lists the tools it was started with and notes each
// call. Nothing leaves the
// machine. The real Vanr server reaches it because a self-hosted server allows the local network.
import { createServer, type IncomingMessage } from "node:http";

export type McpDoubleTool = { name: string; description: string; readOnly?: boolean };

export interface McpDouble {
  /** The MCP endpoint, e.g. `http://127.0.0.1:41234/mcp`. */
  readonly url: string;
  /** The `Authorization` header of every request it got. */
  readonly authorizations: (string | undefined)[];
  /** The name of every tool an agent called, in order. */
  readonly calls: string[];
  stop(): Promise<void>;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export async function startMcpDouble(tools: readonly McpDoubleTool[]): Promise<McpDouble> {
  const authorizations: (string | undefined)[] = [];
  const calls: string[] = [];
  const server = createServer(async (request, response) => {
    authorizations.push(request.headers.authorization);
    if (request.method !== "POST" || request.url !== "/mcp") {
      response.writeHead(404).end();
      return;
    }
    type Message = { id?: number; method?: string; params?: { name?: unknown } };
    let message: Message;
    try {
      message = JSON.parse(await readBody(request)) as Message;
    } catch {
      response.writeHead(400).end();
      return;
    }
    if (message.id === undefined) {
      response.writeHead(202).end();
      return;
    }
    const result =
      message.method === "initialize"
        ? {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "double", version: "1" },
          }
        : message.method === "tools/list"
          ? {
              tools: tools.map((tool) => ({
                name: tool.name,
                description: tool.description,
                inputSchema: { type: "object", properties: {} },
                annotations: { readOnlyHint: tool.readOnly === true },
              })),
            }
          : message.method === "tools/call" && tools.some((tool) => tool.name === message.params?.name)
            ? (() => {
                calls.push(String(message.params?.name));
                return { content: [{ type: "text", text: "done" }] };
              })()
            : null;
    const body =
      result === null
        ? { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } }
        : { jsonrpc: "2.0", id: message.id, result };
    response.writeHead(200, { "content-type": "application/json", "mcp-session-id": "double-session" });
    response.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address !== "object") throw new Error("the MCP double has no port");
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    authorizations,
    calls,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
