// A fake remote MCP server, but a real one: local HTTP with JSON-RPC, a session, the reply in SSE, a 401 with
// resource metadata, OAuth with dynamic registration and PKCE. The tests point at it.
//
// Options: `iss` on the authorization response (RFC 9207: right, absent or from another issuer), an issuer with
// a path (RFC 8414 §3.1), a different published issuer (mix-up attack), scopes per token with a 403
// `insufficient_scope`, the 2026-07-28 mode (`server/discover`, `_meta`, `resultType`), short-lived tokens and
// refresh tokens that only work once (rotation).
import { createHash } from "node:crypto";

export interface FakeMcp {
  url: string;
  origin: string;
  /** Issuer of the authorization server (with the path, if any). */
  issuer: string;
  /** Key accepted as Bearer besides the token issued by OAuth. */
  apiKey: string;
  calls: { method: string; auth: string | null; session: string | null; meta?: unknown }[];
  toolCalls: { name: string; args: unknown }[];
  /** Requests to the token endpoint (to prove a code didn't leave). */
  tokenRequests: URLSearchParams[];
  /** Authorization requests (scope, resource). */
  authorizeRequests: URLSearchParams[];
  registrations: Record<string, unknown>[];
  /** Plays the browser: follows the authorize and returns the code, the state and the `iss` of the redirect. */
  authorize(
    consentUrl: string,
  ): Promise<{ code: string; state: string; redirectUri: string; iss: string | null }>;
  stop(): void;
}

export interface FakeMcpOptions {
  /** No key nor OAuth: anyone calls. */
  open?: boolean;
  /** No OAuth metadata: key only. */
  keyOnly?: boolean;
  /** `iss` on the response: `send` (default, and announces it), `omit` (neither sends nor announces), `omit_promised` (announces and doesn't send), `wrong` (sends another). */
  iss?: "send" | "omit" | "omit_promised" | "wrong";
  /** The issuer's path (`/tenant1`): the metadata is at `.well-known/oauth-authorization-server/tenant1`. */
  issuerPath?: string;
  /** Metadata with another `issuer` (an authorization server passing for another). */
  issuerMismatch?: boolean;
  /** Tool → the scope it requires; a token without it gets a 403 `insufficient_scope`. */
  toolScopes?: Record<string, string>;
  /** `scopes_supported` of the resource metadata. */
  scopesSupported?: string[];
  /** Scope of the 401 challenge. */
  challengeScope?: string;
  /** Address of the resource metadata in the 401 (to point at the internal network). */
  resourceMetadataUrl?: string;
  /** Speaks 2026-07-28: answers `server/discover` and puts `resultType` in the results. */
  modern?: boolean;
  /** Lifetime of the issued tokens, in seconds (default 3600). */
  expiresIn?: number;
  /** A refresh token works once and the refresh returns a new one (rotation, RFC 9700 §4.14.2). */
  rotateRefresh?: boolean;
  /** Paths of the MCP endpoint (default `/mcp`; `url` is the first), compared exactly, case included. */
  mcpPaths?: string[];
}

export function startFakeMcp(opts: FakeMcpOptions = {}): FakeMcp {
  const calls: FakeMcp["calls"] = [];
  const toolCalls: FakeMcp["toolCalls"] = [];
  const tokenRequests: URLSearchParams[] = [];
  const authorizeRequests: URLSearchParams[] = [];
  const registrations: Record<string, unknown>[] = [];
  const apiKey = "mcp-key-123";
  /** Token → granted scope. */
  const issued = new Map<string, string>();
  const codes = new Map<
    string,
    { challenge: string; clientId: string; redirectUri: string; scope: string; resource: string | null }
  >();
  const refreshes = new Map<string, string>();
  let clients = 0;
  const issMode = opts.iss ?? "send";
  const expiresIn = opts.expiresIn ?? 3600;
  const mcpPaths = opts.mcpPaths ?? ["/mcp"];
  const mcpPath = mcpPaths[0] ?? "/mcp";
  const path = opts.issuerPath ?? "";

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const origin = url.origin;
      const issuer = `${origin}${path}`;
      if (url.pathname.startsWith("/.well-known/oauth-protected-resource") && !opts.keyOnly) {
        return Response.json({
          resource: `${origin}${url.pathname.replace("/.well-known/oauth-protected-resource", "")}`,
          authorization_servers: [issuer],
          ...(opts.scopesSupported ? { scopes_supported: opts.scopesSupported } : {}),
        });
      }
      if (url.pathname === `/.well-known/oauth-authorization-server${path}` && !opts.keyOnly) {
        return Response.json({
          issuer: opts.issuerMismatch ? "https://evil.example" : issuer,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          registration_endpoint: `${origin}/register`,
          response_types_supported: ["code"],
          code_challenge_methods_supported: ["S256"],
          ...(issMode === "send" || issMode === "omit_promised" || issMode === "wrong"
            ? { authorization_response_iss_parameter_supported: true }
            : {}),
        });
      }
      if (url.pathname === "/register" && req.method === "POST") {
        const body = (await req.json()) as { redirect_uris: string[] } & Record<string, unknown>;
        registrations.push(body);
        clients++;
        return Response.json(
          { client_id: `client-${clients}`, redirect_uris: body.redirect_uris },
          { status: 201 },
        );
      }
      if (url.pathname === "/authorize") {
        authorizeRequests.push(url.searchParams);
        const code = `code-${codes.size + 1}-${Math.random().toString(36).slice(2, 8)}`;
        const redirectUri = url.searchParams.get("redirect_uri") ?? "";
        codes.set(code, {
          challenge: url.searchParams.get("code_challenge") ?? "",
          clientId: url.searchParams.get("client_id") ?? "",
          redirectUri,
          scope: url.searchParams.get("scope") ?? "",
          resource: url.searchParams.get("resource"),
        });
        const back = new URL(redirectUri);
        back.searchParams.set("code", code);
        back.searchParams.set("state", url.searchParams.get("state") ?? "");
        if (issMode === "send") back.searchParams.set("iss", issuer);
        if (issMode === "wrong") back.searchParams.set("iss", "https://evil.example");
        return new Response(null, { status: 302, headers: { location: back.toString() } });
      }
      if (url.pathname === "/token" && req.method === "POST") {
        const form = new URLSearchParams(await req.text());
        tokenRequests.push(form);
        if (form.get("grant_type") === "refresh_token") {
          const used = form.get("refresh_token") ?? "";
          const scope = refreshes.get(used);
          if (scope === undefined) return Response.json({ error: "invalid_grant" }, { status: 400 });
          const token = `token-${issued.size + 1}`;
          issued.set(token, scope);
          if (!opts.rotateRefresh)
            return Response.json({ access_token: token, token_type: "Bearer", expires_in: expiresIn, scope });
          refreshes.delete(used);
          const next = `r-${token}`;
          refreshes.set(next, scope);
          return Response.json({
            access_token: token,
            token_type: "Bearer",
            expires_in: expiresIn,
            refresh_token: next,
            scope,
          });
        }
        const grant = codes.get(form.get("code") ?? "");
        const verifier = form.get("code_verifier") ?? "";
        const challenge = createHash("sha256").update(verifier).digest("base64url");
        if (!grant || grant.challenge !== challenge || grant.clientId !== form.get("client_id")) {
          return Response.json({ error: "invalid_grant" }, { status: 400 });
        }
        codes.delete(form.get("code") ?? "");
        const token = `token-${issued.size + 1}`;
        issued.set(token, grant.scope);
        const refresh = `r-${token}`;
        refreshes.set(refresh, grant.scope);
        return Response.json({
          access_token: token,
          token_type: "Bearer",
          expires_in: expiresIn,
          refresh_token: refresh,
          ...(grant.scope ? { scope: grant.scope } : {}),
        });
      }
      if (!mcpPaths.includes(url.pathname) || req.method !== "POST")
        return new Response("not found", { status: 404 });

      const auth = req.headers.get("authorization");
      const bearer = auth?.replace(/^Bearer /, "") ?? "";
      const body = (await req.json()) as { id?: number; method: string; params?: Record<string, unknown> };
      calls.push({
        method: body.method,
        auth,
        session: req.headers.get("mcp-session-id"),
        meta: body.params?._meta,
      });
      if (!opts.open && bearer !== apiKey && !issued.has(bearer)) {
        const metadata =
          opts.resourceMetadataUrl ?? `${origin}/.well-known/oauth-protected-resource${url.pathname}`;
        const scope = opts.challengeScope ? `, scope="${opts.challengeScope}"` : "";
        const header = opts.keyOnly ? 'Bearer realm="mcp"' : `Bearer resource_metadata="${metadata}"${scope}`;
        return new Response("unauthorized", { status: 401, headers: { "www-authenticate": header } });
      }
      if (body.id === undefined) return new Response(null, { status: 202 });
      const result = (r: Record<string, unknown>) => (opts.modern ? { resultType: "complete", ...r } : r);
      const reply = (r: Record<string, unknown>, headers: Record<string, string> = {}) =>
        Response.json({ jsonrpc: "2.0", id: body.id, result: result(r) }, { headers });
      if (body.method === "server/discover") {
        if (!opts.modern)
          return Response.json(
            { jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "Method not found" } },
            { status: 404 },
          );
        return reply({
          supportedVersions: ["2026-07-28"],
          capabilities: { tools: {} },
          _meta: { "io.modelcontextprotocol/serverInfo": { name: "fake", version: "1" } },
          ttlMs: 0,
          cacheScope: "private",
        });
      }
      if (body.method === "initialize") {
        return reply(
          {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "fake", version: "1" },
          },
          { "mcp-session-id": "sess-1" },
        );
      }
      if (body.method === "tools/list") {
        // In SSE, as real servers usually answer.
        const list = result({
          tools: [
            {
              name: "list_items",
              description: "Lists the stock items",
              inputSchema: { type: "object", properties: {} },
              annotations: { readOnlyHint: true },
            },
            {
              name: "create_item",
              description: "Creates an item in the stock",
              inputSchema: {
                type: "object",
                properties: { name: { type: "string" } },
                required: ["name"],
              },
            },
          ],
          ...(opts.modern ? { ttlMs: 0, cacheScope: "private" } : {}),
        });
        const event = `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result: list })}\n\n`;
        return new Response(`: ping\n\n${event}`, { headers: { "content-type": "text/event-stream" } });
      }
      if (body.method === "tools/call") {
        const name = String(body.params?.name ?? "");
        const needs = opts.toolScopes?.[name];
        const granted = (issued.get(bearer) ?? "").split(" ");
        if (needs && bearer !== apiKey && !granted.includes(needs)) {
          const header = `Bearer error="insufficient_scope", scope="${needs}", resource_metadata="${origin}/.well-known/oauth-protected-resource${url.pathname}", error_description="needs ${needs}"`;
          return new Response("forbidden", { status: 403, headers: { "www-authenticate": header } });
        }
        toolCalls.push({ name, args: body.params?.arguments });
        if (name === "list_items") return reply({ content: [{ type: "text", text: "bolt, nut" }] });
        if (name === "create_item") {
          const args = body.params?.arguments as { name?: string } | undefined;
          return reply({ content: [{ type: "text", text: `created: ${args?.name ?? "?"}` }] });
        }
        return reply({ content: [{ type: "text", text: "unknown tool" }], isError: true });
      }
      return Response.json({
        jsonrpc: "2.0",
        id: body.id,
        error: { code: -32601, message: "Method not found" },
      });
    },
  });
  const origin = `http://localhost:${server.port}`;
  return {
    url: `${origin}${mcpPath}`,
    origin,
    issuer: `${origin}${path}`,
    apiKey,
    calls,
    toolCalls,
    tokenRequests,
    authorizeRequests,
    registrations,
    async authorize(consentUrl) {
      const res = await fetch(consentUrl, { redirect: "manual" });
      const location = new URL(res.headers.get("location") ?? "");
      return {
        code: location.searchParams.get("code") ?? "",
        state: location.searchParams.get("state") ?? "",
        redirectUri: `${location.origin}${location.pathname}`,
        iss: location.searchParams.get("iss"),
      };
    },
    stop: () => server.stop(true),
  };
}
