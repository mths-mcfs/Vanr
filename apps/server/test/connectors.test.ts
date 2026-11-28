// The catalog connectors (key and OAuth), the own MCP server, the agent's repositories and each agent's access, end
// to end through the connector routes and the agent runtime: the server talks to a real fake MCP server (local
// HTTP). The catalog's addresses answer from the fake, rewritten to the catalog's origin both ways.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { schema } from "@vanr/engine/db";
import { asc, desc, eq } from "drizzle-orm";
import { integrationSealer, mcpFor, secretsSentBy } from "../src/integrations/connectors";
import { argsValidator } from "../src/integrations/tools";
import type { RunningServer } from "../src/server";
import { startFakeMcp } from "./fake-mcp";
import { SERVER_TEST_MS, settle, signedIn, startTestServer, waitFor } from "./harness";
import { type Called, call, ws } from "./route-calls";
import { memberOf, type Person, seedWorkspace } from "./seed";

const { connections, gateDecisions, runEvents, runs } = schema;

const mcp = startFakeMcp();
const keyOnly = startFakeMcp({ keyOnly: true });
/** An MCP server that answers a tool call with an error quoting the Authorization and the query string it got. */
const QUOTED = "quoted-credential-value";
let echoInitFails = false;
const echo = Bun.serve({
  port: 0,
  async fetch(req) {
    const auth = req.headers.get("authorization") ?? "";
    const body = (await req.json()) as { id?: number; method: string };
    if (body.id === undefined) return new Response(null, { status: 202 });
    const reply = (result: unknown) => Response.json({ jsonrpc: "2.0", id: body.id, result });
    if (body.method === "initialize" && echoInitFails)
      return Response.json({
        jsonrpc: "2.0",
        id: body.id,
        error: { code: -32000, message: `no session for ${auth}` },
      });
    if (body.method === "initialize")
      return Response.json(
        {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "echo", version: "1" },
          },
        },
        { headers: { "mcp-session-id": "s1" } },
      );
    if (body.method === "tools/list")
      return reply({
        tools: [{ name: "ping", description: "Ping", inputSchema: { type: "object", properties: {} } }],
      });
    return Response.json({
      jsonrpc: "2.0",
      id: body.id,
      error: { code: -32000, message: `call rejected for ${auth} at ${new URL(req.url).search}` },
    });
  },
});
/**
 * An MCP server whose failure quotes the address it was called at, by `quote`: on `initialize` with `quoteInit`,
 * otherwise on `tools/list`. Without `quote` it answers normally.
 */
let quote: ((url: URL) => string) | null = null;
let quoteInit = false;
const quoting = Bun.serve({
  port: 0,
  async fetch(req) {
    const body = (await req.json()) as { id?: number; method: string };
    if (body.id === undefined) return new Response(null, { status: 202 });
    const fail = (message: string) =>
      Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32000, message } });
    if (body.method === "initialize") {
      if (quote && quoteInit) return fail(quote(new URL(req.url)));
      return Response.json(
        {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "quoting", version: "1" },
          },
        },
        { headers: { "mcp-session-id": "s1" } },
      );
    }
    if (body.method === "tools/list" && quote && !quoteInit) return fail(quote(new URL(req.url)));
    return Response.json({
      jsonrpc: "2.0",
      id: body.id,
      result: {
        tools: [{ name: "ping", description: "Ping", inputSchema: { type: "object", properties: {} } }],
      },
    });
  },
});
/** Runs `work` with the quoting server failing as `how` says. */
async function quoted<T>(how: (url: URL) => string, work: () => Promise<T>, onInit = false): Promise<T> {
  quote = how;
  quoteInit = onInit;
  try {
    return await work();
  } finally {
    quote = null;
    quoteInit = false;
  }
}

const CATALOG_HOSTS = ["mcp.linear.app", "mcp.notion.com", "api.githubcopilot.com"];

/** Each catalog origin answers from the fake MCP server, which speaks of itself by its own origin. */
const external: typeof fetch = Object.assign(
  async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (!CATALOG_HOSTS.includes(url.hostname)) return fetch(url, init);
    const toCatalog = (s: string) => s.replaceAll(mcp.origin, url.origin);
    const target = new URL(`${url.pathname.replace(/\/$/, "")}${url.search}`, mcp.origin);
    const res = await fetch(target, init);
    const headers = new Headers(res.headers);
    const challenge = headers.get("www-authenticate");
    if (challenge) headers.set("www-authenticate", toCatalog(challenge));
    headers.delete("content-length");
    return new Response(toCatalog(await res.text()), { status: res.status, headers });
  },
  { preconnect: () => {} },
);
const toFake = (s: string) => CATALOG_HOSTS.reduce((v, h) => v.replaceAll(`https://${h}`, mcp.origin), s);

let server: RunningServer;
beforeAll(async () => {
  server = await startTestServer({ env: { ALLOW_PRIVATE_NETWORKS: "true" }, fetchExternal: external });
}, SERVER_TEST_MS);
afterAll(async () => {
  await server.stop();
  mcp.stop();
  keyOnly.stop();
  echo.stop(true);
  quoting.stop(true);
}, SERVER_TEST_MS);

let n = 0;
const email = (who: string) => `${who}${++n}@connectors.test`;

async function ok(res: Promise<Called>, status = 200) {
  const r = await res;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body;
}
const code = async (res: Promise<Called>) => (await res).body?.error?.code;
const status = async (res: Promise<Called>) => (await res).status;

async function team() {
  const ana = await signedIn(server, "Ana", email("ana"));
  const { workspaceId, general } = await seedWorkspace(server, ana, "Workshop");
  const w = ws(workspaceId);
  const beto = await memberOf(server, workspaceId, "Beto", email("beto"));
  const lia = await ok(
    call(ana, "POST", `${w}/agents`, {
      name: "Lia",
      handle: `lia${n}`,
      role: "support",
      instructions: "",
      channelIds: [general],
    }),
    201,
  );
  let seq = 0;
  /** Someone (Beto by default) asks Lia for a tool and waits for the run: what the tool gave back. */
  const ask = async (tool: string, input: unknown, opts: { wait?: boolean; who?: Person } = {}) => {
    const body = `@${lia.handle} [[tool:${tool} ${JSON.stringify(input)}]]`;
    const who = opts.who ?? beto;
    const sent = await ok(
      call(who, "POST", `${w}/channels/${general}/messages`, { body, clientId: `c${++seq}` }),
      201,
    );
    if (opts.wait === false) return null;
    await settle(server);
    const [run] = await server.deps.db.select().from(runs).where(eq(runs.sourceMessageId, sent.id));
    if (!run) return null;
    const results = (
      await server.deps.db
        .select()
        .from(runEvents)
        .where(eq(runEvents.runId, run.id))
        .orderBy(asc(runEvents.seq))
    )
      .filter((e) => e.kind === "tool_result")
      .map((e) => e.data as { content: unknown; isError: boolean });
    return {
      result: results.map((r) => String(r.content)).join("\n"),
      failed: results.some((r) => r.isError),
    };
  };
  return { workspaceId, w, general, ana, beto, lia, ask };
}
type Team = Awaited<ReturnType<typeof team>>;

/** Follows the OAuth return as the person's browser (with their cookie), with the `iss` the server sent. */
async function completeOAuth(who: Person, consentUrl: string, fake = mcp) {
  const local = toFake(consentUrl);
  const { code: authCode, state, redirectUri, iss } = await fake.authorize(local);
  expect(redirectUri).toBe(`${server.url}/api/v1/connectors/oauth/callback`);
  const issuer =
    iss === null ? null : consentUrl === local ? iss : iss.replace(mcp.origin, new URL(consentUrl).origin);
  const issParam = issuer === null ? "" : `&iss=${encodeURIComponent(issuer)}`;
  const res = await who.browser.fetch(
    `/api/v1/connectors/oauth/callback?code=${authCode}&state=${state}${issParam}`,
  );
  expect(res.status).toBe(302);
  return { location: res.headers.get("location") ?? "", state };
}

const list = async (t: Team, who: Person = t.ana) =>
  (await ok(call(who, "GET", `${t.w}/connectors`))).connections as {
    id: string;
    connector: string;
    status: string;
  }[];
const servers = async (t: Team, who: Person = t.ana) =>
  (await ok(call(who, "GET", `${t.w}/connectors/custom`))).servers as {
    id: string;
    label: string;
    serverUrl: string;
    queryHidden: boolean;
    tools: { name: string }[];
  }[];
const connectKey = (t: Team, who: Person, input: unknown) => call(who, "POST", `${t.w}/connectors`, input);
const connectCustom = (t: Team, who: Person, input: unknown) =>
  call(who, "POST", `${t.w}/connectors/custom`, input);
const saveTools = (t: Team, id: string, input: unknown) =>
  call(t.ana, "PUT", `${t.w}/connectors/custom/${id}/tools`, input);
const setAccess = (t: Team, input: unknown, who: Person = t.ana) =>
  call(who, "PUT", `${t.w}/agents/${t.lia.id}/access`, input);
const setScopes = (t: Team, scopes: unknown) =>
  call(t.ana, "PUT", `${t.w}/agents/${t.lia.id}/scopes`, { scopes });
const openApprovals = async (t: Team) =>
  (await ok(call(t.ana, "GET", `${t.w}/approvals?status=pending`))).approvals as {
    id: string;
    tool: string;
    title: string;
    payloadHash: string;
  }[];

/** An own MCP server on the fake with the key, its two tools decided as given. */
async function stock(t: Team, label: string, createAccess: "approval" | "write" = "approval") {
  const started = await ok(
    connectCustom(t, t.ana, { serverUrl: mcp.url, apiKey: mcp.apiKey, label, nextPath: "/" }),
  );
  if (started.status !== "server") throw new Error(`expected server, got ${started.status}`);
  const id: string = started.server.id;
  await ok(
    saveTools(t, id, {
      label,
      tools: [
        { name: "list_items", access: "read", label: "" },
        { name: "create_item", access: createAccess, label: "" },
      ],
    }),
  );
  return id;
}

describe("catalog connectors", () => {
  test(
    "catalog, connect with a key, list, a wrong key, permission and disconnect",
    async () => {
      const t = await team();
      const catalog = await ok(call(t.ana, "GET", "/api/v1/connectors/catalog"));
      expect(catalog.connectors.find((c: { id: string }) => c.id === "linear")).toMatchObject({
        authMethods: ["oauth", "api_key"],
        available: true,
        kind: "hosted_mcp",
      });
      expect(catalog.nativeScopes.map((s: { id: string }) => s.id)).toContain("drive:write");

      const conn = await ok(connectKey(t, t.ana, { connector: "linear", apiKey: mcp.apiKey }), 201);
      expect(conn).toMatchObject({ connector: "linear", label: "Linear", status: "active", revokedAt: null });
      expect((await list(t)).map((c) => c.connector)).toEqual(["linear"]);

      // The service revokes the key later: the agent's next call gets a 401 and the list says so, so the screen
      // doesn't say "Connected".
      await ok(setAccess(t, { connectors: { [conn.id]: true } }));
      expect((await t.ask("linear__list_items", {}))?.result).toContain("bolt, nut");
      await server.deps.db
        .update(connections)
        .set({
          secret: integrationSealer(server.deps).seal(JSON.stringify({ kind: "api_key", apiKey: "revoked" })),
        })
        .where(eq(connections.id, conn.id));
      expect((await t.ask("linear__list_items", {}))?.result).toContain("requires authorization");
      expect((await list(t)).map((c) => c.status)).toEqual(["reauth_required"]);

      expect(await code(connectKey(t, t.ana, { connector: "linear", apiKey: "wrong-key" }))).toBe(
        "connector.invalid_key",
      );
      expect(await code(connectKey(t, t.ana, { connector: "notion", apiKey: "anything-at-all" }))).toBe(
        "connector.key_unsupported",
      );
      expect(await code(connectKey(t, t.ana, { connector: "none", apiKey: "anything-at-all" }))).toBe(
        "connector.unknown",
      );
      expect(await status(connectKey(t, t.beto, { connector: "linear", apiKey: mcp.apiKey }))).toBe(403);

      expect(await status(call(t.ana, "DELETE", `${t.w}/connectors/${conn.id}`))).toBe(204);
      expect(await list(t)).toEqual([]);
    },
    SERVER_TEST_MS,
  );

  test(
    "OAuth: out, back with the state of who started, and the connection only shows after",
    async () => {
      const t = await team();
      const start = (nextPath: string) =>
        ok(call(t.ana, "POST", `${t.w}/connectors/notion/oauth/start`, { nextPath }));
      const { consentUrl } = await start("https://outside.example/steal");
      expect(consentUrl.startsWith("https://mcp.notion.com/authorize?")).toBe(true);
      expect(new URL(consentUrl).searchParams.get("code_challenge_method")).toBe("S256");
      expect(await list(t)).toEqual([]);

      // Another person with the same state (and the issuer's own iss) completes nobody's connection.
      expect((await completeOAuth(t.beto, consentUrl)).location).toContain("connector_error=state");
      expect(await list(t)).toEqual([]);

      // A nextPath from outside becomes the connectors screen; one from inside is kept.
      const outside = await start("https://outside.example/steal");
      expect((await completeOAuth(t.ana, outside.consentUrl)).location).toBe(
        `/workspace/${t.workspaceId}/settings/connectors?connected=notion`,
      );
      const inside = await start(`/workspace/${t.workspaceId}/agents`);
      expect((await completeOAuth(t.ana, inside.consentUrl)).location).toBe(
        `/workspace/${t.workspaceId}/agents?connected=notion`,
      );
      expect((await list(t)).map((c) => c.connector)).toEqual(["notion", "notion"]);
    },
    SERVER_TEST_MS,
  );
});

describe("own MCP server", () => {
  test(
    "with a key: tools to review, decisions saved, refresh and disconnect",
    async () => {
      const t = await team();
      const started = await ok(
        connectCustom(t, t.ana, { serverUrl: mcp.url, apiKey: mcp.apiKey, label: "Stock", nextPath: "/" }),
      );
      if (started.status !== "server") throw new Error(`expected server, got ${started.status}`);
      expect(
        started.server.tools.map((x: { name: string; proposedAccess: string; confirmed: boolean }) => [
          x.name,
          x.proposedAccess,
          x.confirmed,
        ]),
      ).toEqual([
        ["list_items", "read", false],
        ["create_item", "approval", false],
      ]);
      const id = started.server.id;
      expect((await servers(t, t.beto)).map((s) => s.label)).toEqual(["Stock"]);

      const saved = await ok(
        saveTools(t, id, {
          label: "Workshop stock",
          tools: [
            { name: "list_items", access: "read", label: "See the stock" },
            { name: "create_item", access: "write", label: "" },
          ],
        }),
      );
      expect(saved.label).toBe("Workshop stock");
      expect(saved.vettedAt).not.toBeNull();
      expect(
        saved.tools.map((x: { name: string; access: string; confirmed: boolean; label: string }) => [
          x.name,
          x.access,
          x.confirmed,
          x.label,
        ]),
      ).toEqual([
        ["list_items", "read", true, "See the stock"],
        ["create_item", "write", true, ""],
      ]);
      expect(
        await code(
          saveTools(t, id, { label: "x", tools: [{ name: "does_not_exist", access: "read", label: "" }] }),
        ),
      ).toBe("connector.unknown_tool");
      expect(await status(call(t.beto, "POST", `${t.w}/connectors/custom/${id}/refresh`))).toBe(403);

      // Refreshing lists again and keeps what the workspace decided.
      const refreshed = await ok(call(t.ana, "POST", `${t.w}/connectors/custom/${id}/refresh`));
      expect(
        refreshed.tools.map((x: { name: string; access: string; confirmed: boolean }) => [
          x.name,
          x.access,
          x.confirmed,
        ]),
      ).toEqual([
        ["list_items", "read", true],
        ["create_item", "write", true],
      ]);

      expect(await status(call(t.ana, "DELETE", `${t.w}/connectors/custom/${id}`))).toBe(204);
      expect(await servers(t)).toEqual([]);
    },
    SERVER_TEST_MS,
  );

  test(
    "without a key: OAuth when the server offers it; asks for a key when it doesn't",
    async () => {
      const t = await team();
      const started = await ok(
        connectCustom(t, t.ana, { serverUrl: mcp.url, label: "Stock", nextPath: "/" }),
      );
      if (started.status !== "oauth") throw new Error(`expected oauth, got ${started.status}`);
      expect(await servers(t)).toEqual([]);
      const { location } = await completeOAuth(t.ana, started.consentUrl);
      expect(location).toBe(`/?connected=${encodeURIComponent(`custom:${started.serverId}`)}`);
      const [first] = await servers(t);
      expect(first?.tools.map((x) => x.name)).toEqual(["list_items", "create_item"]);

      expect(await ok(connectCustom(t, t.ana, { serverUrl: keyOnly.url, nextPath: "/" }))).toEqual({
        status: "key_missing",
        serverId: null,
      });
      expect(await code(connectCustom(t, t.ana, { serverUrl: "ftp://x", nextPath: "/" }))).toBe(
        "invalid_url",
      );
    },
    SERVER_TEST_MS,
  );

  test(
    "live: the call carries the credential of who connected; another member can't act as that person",
    async () => {
      const t = await team();
      // Ana connects the fake MCP server with her key and lists its tools.
      const id = await stock(t, "Stock", "write");
      const [listed] = await servers(t);
      expect(listed?.tools.map((x) => x.name)).toEqual(["list_items", "create_item"]);
      await ok(setAccess(t, { connectors: { [id]: true } }));

      // Ana asks Lia: the server sees the key Ana connected with, and the audit names Ana.
      const before = mcp.calls.length;
      expect((await t.ask("mcp_stock__create_item", { name: "gasket" }, { who: t.ana }))?.result).toContain(
        "created: gasket",
      );
      const first = mcp.calls.slice(before).filter((c) => c.method === "tools/call");
      expect(first.map((c) => c.auth)).toEqual([`Bearer ${mcp.apiKey}`]);
      const decision = async () =>
        (
          await server.deps.db
            .select()
            .from(gateDecisions)
            .where(eq(gateDecisions.agentId, t.lia.id))
            .orderBy(desc(gateDecisions.createdAt))
            .limit(1)
        )[0];
      expect(await decision()).toMatchObject({
        initiatedBy: t.ana.user.id,
        credential: { kind: "connection", id, owner: "workspace", label: "Stock" },
      });

      // Beto asks Lia: the call still carries the connection's credential (never one of Beto's), and the audit
      // names Beto as who asked: he doesn't act as Ana.
      const mid = mcp.calls.length;
      expect((await t.ask("mcp_stock__list_items", {}))?.result).toContain("bolt, nut");
      expect(
        mcp.calls
          .slice(mid)
          .filter((c) => c.method === "tools/call")
          .map((c) => c.auth),
      ).toEqual([`Bearer ${mcp.apiKey}`]);
      expect(await decision()).toMatchObject({ initiatedBy: t.beto.user.id, credential: { id } });

      // Nor can Beto take Ana's connection over: not its tools, not its credential, not its round trip.
      expect(await status(call(t.beto, "POST", `${t.w}/connectors/custom/${id}/refresh`))).toBe(403);
      expect(await status(saveToolsAs(t, t.beto, id))).toBe(403);
      expect(await status(call(t.beto, "DELETE", `${t.w}/connectors/custom/${id}`))).toBe(403);
      expect(await status(connectCustom(t, t.beto, { serverUrl: mcp.url, nextPath: "/" }))).toBe(403);
      expect(await status(setAccess(t, { all: true }, t.beto))).toBe(403);
      const started = await ok(connectCustom(t, t.ana, { serverUrl: mcp.url, label: "Mine", nextPath: "/" }));
      expect((await completeOAuth(t.beto, started.consentUrl)).location).toContain("connector_error=state");
      expect((await servers(t)).map((s) => s.label)).toEqual(["Stock"]);
    },
    SERVER_TEST_MS,
  );
});

const saveToolsAs = (t: Team, who: Person, id: string) =>
  call(who, "PUT", `${t.w}/connectors/custom/${id}/tools`, { label: "x", tools: [] });

describe("the agent's access", () => {
  test(
    "arguments outside the inputSchema are rejected before asking for approval or calling the server",
    async () => {
      const t = await team();
      const conn = await stock(t, "Store");
      await ok(setAccess(t, { connectors: { [conn]: true } }));
      const before = mcp.toolCalls.length;
      // create_item requires a text `name`: missing, of another type, or SQL in place of the object.
      for (const args of [{}, { name: 42 }, { name: ["a"] }, { nome: "washer" }]) {
        const res = await t.ask("mcp_store__create_item", args);
        expect(res?.failed).toBe(true);
        expect(res?.result).toContain("Invalid input");
      }
      expect(mcp.toolCalls.slice(before)).toEqual([]);
      expect(await openApprovals(t)).toEqual([]);
    },
    SERVER_TEST_MS,
  );

  test("argsValidator: a strict schema, and plan B when the schema doesn't convert", () => {
    const strict = argsValidator({
      type: "object",
      properties: { owner: { type: "string" }, n: { type: "integer", minimum: 1 } },
      required: ["owner"],
      additionalProperties: false,
    });
    expect(strict.safeParse({ owner: "a", n: 2 }).success).toBe(true);
    expect(strict.safeParse({ owner: "a", n: 0 }).success).toBe(false);
    expect(strict.safeParse({ owner: "a", extra: 1 }).success).toBe(false);
    // Without `type`, the schema counts as an object (it's what the model sees).
    expect(argsValidator({ properties: { a: { type: "string" } } }).safeParse({ a: 1 }).success).toBe(false);
    // An external $ref doesn't convert: plan B still requires the required keys and rejects extras.
    const fallback = argsValidator({
      properties: { a: { $ref: "https://x/y" } },
      required: ["a"],
      additionalProperties: false,
    });
    expect(fallback.safeParse({ a: 1 }).success).toBe(true);
    expect(fallback.safeParse({}).success).toBe(false);
    expect(fallback.safeParse({ a: 1, b: 2 }).success).toBe(false);
    expect(argsValidator(undefined).safeParse("text").success).toBe(false);
  });

  test("argsValidator: a schema in another draft's form checks without refusing a valid call", () => {
    // Findings of the adversarial review.
    const draft7 = argsValidator({
      properties: { a: { $ref: "#/definitions/A" }, format: { type: "string" } },
      definitions: { A: { type: "string" } },
    });
    expect(draft7.safeParse({ a: 5 }).success).toBe(false);
    expect(draft7.safeParse({ a: "x", format: "md" }).success).toBe(true);
    expect(draft7.safeParse({ a: "x", format: 3 }).success).toBe(false);
    const uri = argsValidator({ properties: { u: { type: "string", format: "uri-reference" } } });
    expect(uri.safeParse({ u: "/a/b" }).success).toBe(true);
    const letters = argsValidator({ properties: { n: { type: "string", pattern: "^\\p{L}+$" } } });
    expect(letters.safeParse({ n: "ação" }).success).toBe(true);
    const digits = argsValidator({ properties: { n: { type: "string", pattern: "^[0-9]+$" } } });
    expect(digits.safeParse({ n: "12a" }).success).toBe(false);
    expect(argsValidator({ required: ["a"] }).safeParse({}).success).toBe(false);
    // A data value is not a schema: an enum with "format" stays whole.
    const kinds = argsValidator({ properties: { k: { enum: ["format", "pattern"] } } });
    expect(kinds.safeParse({ k: "format" }).success).toBe(true);
    expect(kinds.safeParse({ k: "other" }).success).toBe(false);
  });

  test(
    "built-in scopes, a granted connection, a tool with approval and one denied by name",
    async () => {
      const t = await team();
      const access = await ok(call(t.beto, "GET", `${t.w}/agents/${t.lia.id}/access`));
      expect(access.all).toBe(true);
      expect(access.builtins.every((b: { enabled: boolean }) => b.enabled)).toBe(true);
      expect((await ok(call(t.ana, "GET", `${t.w}/agents/${t.lia.id}/scopes`))).scopes).toEqual([
        { connectionId: "", scope: "*" },
      ]);

      // With nothing granted, the memory tool goes; with context:write, it comes back.
      const none = await ok(setAccess(t, { all: false }));
      expect(none.builtins.some((b: { enabled: boolean }) => b.enabled)).toBe(false);
      expect((await t.ask("remember", { text: "Part X" }))?.result).toContain("Unknown tool remember");
      expect(await status(setAccess(t, { all: true }, t.beto))).toBe(403);
      expect((await ok(setScopes(t, [{ connectionId: "", scope: "context:write" }]))).scopes).toEqual([
        { connectionId: "", scope: "context:write" },
      ]);
      expect((await t.ask("remember", { text: "Part X" }))?.result).toContain("Saved memory");
      // Writing in an area includes reading in it.
      const found = await t.ask("search", { query: "Part" });
      expect(found?.failed).toBe(false);
      expect(found?.result).toContain("Part X");
      expect(await code(setScopes(t, [{ connectionId: "", scope: "drive:everything" }]))).toBe(
        "access.unknown_scope",
      );

      // An own MCP server granted read only: create_item stays out.
      const conn = await stock(t, "Stock");
      await ok(
        setScopes(t, [
          { connectionId: "", scope: "context:write" },
          { connectionId: conn, scope: `custom:${conn}:read` },
        ]),
      );
      expect((await ok(call(t.ana, "GET", `${t.w}/agents/${t.lia.id}/access`))).connectors).toEqual([
        expect.objectContaining({ connectionId: conn, custom: true, state: "read" }),
      ]);
      expect((await t.ask("mcp_stock__list_items", {}))?.result).toContain("bolt, nut");
      expect((await t.ask("mcp_stock__create_item", { name: "washer" }))?.result).toContain("Unknown tool");

      // The whole connection: create_item asks for approval; approved, it reaches the server.
      const full = await ok(setAccess(t, { connectors: { [conn]: true } }));
      expect(full.connectors[0]?.state).toBe("write");
      await t.ask("mcp_stock__create_item", { name: "washer" }, { wait: false });
      let pending: Awaited<ReturnType<typeof openApprovals>>[number] | undefined;
      await waitFor(async () => {
        [pending] = await openApprovals(t);
        return pending !== undefined;
      });
      expect(pending).toMatchObject({ tool: "mcp_stock__create_item", title: "Stock: create_item" });
      const reached = () =>
        mcp.toolCalls.some((c) => c.name === "create_item" && JSON.stringify(c.args).includes("washer"));
      expect(reached()).toBe(false);
      await ok(
        call(t.ana, "POST", `${t.w}/approvals/${pending?.id}/approve`, { payloadHash: pending?.payloadHash }),
      );
      await settle(server);
      expect(reached()).toBe(true);

      // Denying by name takes the tool away even with the connection granted.
      const denied = await ok(setAccess(t, { tools: { allow: [], deny: ["mcp_stock__list_items"] } }));
      expect(denied.tools.deny).toEqual(["mcp_stock__list_items"]);
      expect((await t.ask("mcp_stock__list_items", {}))?.result).toContain("Unknown tool");

      // Disconnecting takes the connection out of the access.
      expect(await status(call(t.ana, "DELETE", `${t.w}/connectors/custom/${conn}`))).toBe(204);
      expect((await ok(call(t.ana, "GET", `${t.w}/agents/${t.lia.id}/access`))).connectors).toEqual([]);
      expect(
        (await ok(call(t.ana, "GET", `${t.w}/agents/${t.lia.id}/scopes`))).scopes.some(
          (g: { connectionId: string }) => g.connectionId === conn,
        ),
      ).toBe(false);
    },
    SERVER_TEST_MS,
  );

  test(
    "two partial access saves at once both land: neither loses the other's change",
    async () => {
      const t = await team();
      const conn = await stock(t, "Stock");
      await ok(setAccess(t, { all: false }));
      const saved = await Promise.all([
        setAccess(t, { connectors: { [conn]: true } }),
        setAccess(t, { tools: { allow: [], deny: ["mcp_stock__list_items"] } }),
      ]);
      expect(saved.map((r) => r.status)).toEqual([200, 200]);
      const after = await ok(call(t.ana, "GET", `${t.w}/agents/${t.lia.id}/access`));
      expect(after.connectors).toEqual([expect.objectContaining({ connectionId: conn, state: "write" })]);
      expect(after.tools.deny).toEqual(["mcp_stock__list_items"]);
    },
    SERVER_TEST_MS,
  );
});

describe("GitHub", () => {
  test(
    "repositories per agent: the GitHub connector rejects a repository outside the list before calling the server",
    async () => {
      const t = await team();
      const conn = await ok(connectKey(t, t.ana, { connector: "github", apiKey: mcp.apiKey }), 201);
      await ok(setAccess(t, { connectors: { [conn.id]: true } }));
      const create = (args: Record<string, unknown>) =>
        t.ask("github__create_item", { name: "issue", ...args });
      const reached = (owner: string) =>
        mcp.toolCalls.some((c) => c.name === "create_item" && JSON.stringify(c.args).includes(owner));
      const setRepos = (who: Person, repositories: unknown) =>
        call(who, "PUT", `${t.w}/agents/${t.lia.id}/repositories`, { repositories });

      // Without a list, everything goes (as the screen says).
      expect((await create({ owner: "free", repo: "x" }))?.failed).toBe(false);
      expect(reached("free")).toBe(true);

      await ok(setRepos(t.ana, ["acme/site", "docs/*"]));
      // With a list, a tool that isn't one of GitHub's known repository tools can't name a repository the list
      // checks, so it is rejected even on an allowed one (the allowed calls of the known tools are in
      // github-app.test.ts, against the real tool names).
      for (const args of [
        { owner: "acme", repo: "site" },
        { owner: "docs", repo: "manual" },
      ]) {
        const res = await create(args);
        expect(res?.failed).toBe(true);
        expect(res?.result).toContain("This agent can only use these GitHub repositories");
      }
      // Attacks: another repository of the same owner, the full name, a loose search, a whole GitHub account, no repository.
      for (const [args, mark] of [
        [{ owner: "acme", repo: "vault" }, "vault"],
        [{ repository: "evil/secrets" }, "secrets"],
        [{ q: "password repo:acme/vault" }, "repo:acme/vault"],
        [{ query: "password org:acme" }, "org:acme"],
        [{ owner: "acme" }, '"owner":"acme"}'],
        [{}, '"name":"issue"}'],
        [{ owner: "acme", repo: "site", repository: "acme/vault" }, "acme/vault"],
        // Adversarial review: a negated search (looks in all the others) and an owner with a slash in the path.
        [{ q: "password -repo:acme/site" }, "-repo:acme/site"],
        [{ query: "password NOT repo:acme/site" }, "NOT repo:acme/site"],
        [{ q: "password repo:acme/site OR is:public" }, "OR is:public"],
        [{ q: "(repo:acme/site)" }, "(repo:acme/site)"],
        [{ owner: "acme/vault/contents/README.md?", repo: "acme/site" }, "README.md"],
      ] as const) {
        const res = await create(args);
        expect(res?.failed).toBe(true);
        expect(res?.result).toContain("GitHub");
        expect(mcp.toolCalls.some((c) => JSON.stringify(c.args).includes(mark))).toBe(false);
      }
      expect(reached("acme")).toBe(false);
    },
    SERVER_TEST_MS,
  );

  test(
    "the agent's repositories and the GitHub App screens: who reads, who changes",
    async () => {
      const t = await team();
      expect(await ok(call(t.beto, "GET", `${t.w}/github-app`))).toEqual({
        installable: false,
        installations: [],
      });
      expect(await ok(call(t.beto, "GET", `${t.w}/github/repositories`))).toEqual({
        connected: false,
        accounts: [],
      });
      expect(await status(call(t.beto, "POST", `${t.w}/github-app/install`, { nextPath: "/" }))).toBe(403);
      expect(await status(call(t.beto, "DELETE", `${t.w}/github-app/installations/42`))).toBe(403);

      const repos = `${t.w}/agents/${t.lia.id}/repositories`;
      expect((await ok(call(t.ana, "GET", repos))).repositories).toEqual([]);
      expect(
        (await ok(call(t.ana, "PUT", repos, { repositories: ["acme/site", "acme/*", "acme/site"] })))
          .repositories,
      ).toEqual(["acme/site", "acme/*"]);
      expect((await ok(call(t.beto, "GET", repos))).repositories).toEqual(["acme/site", "acme/*"]);
      expect(await status(call(t.ana, "PUT", repos, { repositories: ["no-slash"] }))).toBe(400);
      expect(await status(call(t.beto, "PUT", repos, { repositories: [] }))).toBe(403);
    },
    SERVER_TEST_MS,
  );
});

describe("a connector's error text", () => {
  test(
    "a server that quotes the key in its error doesn't get it into the run, its events or its error",
    async () => {
      const t = await team();
      const started = await ok(
        connectCustom(t, t.ana, {
          serverUrl: `http://localhost:${echo.port}/mcp`,
          apiKey: QUOTED,
          label: "Echo",
          nextPath: "/",
        }),
      );
      const id: string = started.server.id;
      await ok(saveTools(t, id, { label: "Echo", tools: [{ name: "ping", access: "read", label: "" }] }));
      await ok(setAccess(t, { connectors: { [id]: true } }));
      // The failure may have reached the service, so the run fails with the service's words, redacted.
      await t.ask("mcp_echo__ping", {});
      const [run] = await server.deps.db.select().from(runs).orderBy(desc(runs.createdAt)).limit(1);
      expect(run?.error).toContain("Echo failed: call rejected for Bearer [redacted]");
      const events = await server.deps.db
        .select()
        .from(runEvents)
        .where(eq(runEvents.runId, run?.id ?? ""));
      expect(JSON.stringify({ run, events })).not.toContain(QUOTED);
    },
    SERVER_TEST_MS,
  );
});

test(
  "an own server's address keeps its query string to itself: members read it without, and errors redact it",
  async () => {
    const t = await team();
    const KEY = "address-key-12345";
    const address = `http://localhost:${echo.port}/mcp`;
    const started = await ok(
      connectCustom(t, t.ana, {
        serverUrl: `${address}?key=${KEY}`,
        apiKey: QUOTED,
        label: "Echo",
        nextPath: "/",
      }),
    );
    expect([started.server.serverUrl, started.server.queryHidden]).toEqual([address, true]);
    const id: string = started.server.id;
    const listed = await servers(t, t.beto);
    expect(listed.map((each) => [each.serverUrl, each.queryHidden])).toEqual([[address, true]]);
    const saved = await ok(
      saveTools(t, id, { label: "Echo", tools: [{ name: "ping", access: "read", label: "" }] }),
    );
    const refreshed = await ok(call(t.ana, "POST", `${t.w}/connectors/custom/${id}/refresh`));
    expect(JSON.stringify({ started, listed, saved, refreshed })).not.toContain(KEY);
    await ok(setAccess(t, { connectors: { [id]: true } }));
    // The service quotes the address it was called at: the run's error keeps its words, without the key.
    await t.ask("mcp_echo__ping", {});
    const [run] = await server.deps.db.select().from(runs).orderBy(desc(runs.createdAt)).limit(1);
    expect(run?.error).toContain("Echo failed: call rejected for Bearer [redacted] at ?[redacted]");
    const events = await server.deps.db
      .select()
      .from(runEvents)
      .where(eq(runEvents.runId, run?.id ?? ""));
    expect(JSON.stringify({ run, events })).not.toContain(KEY);
  },
  SERVER_TEST_MS,
);

describe("an own server's address quoted back by the server", () => {
  const at = () => `http://localhost:${quoting.port}/mcp`;
  const errorOf = (res: Called) => String(res.body?.error?.message ?? "");

  test(
    "another admin's refresh gets the server's words without the key in the address",
    async () => {
      const t = await team();
      const KEY = "refresh-key-987654";
      const started = await ok(
        connectCustom(t, t.ana, { serverUrl: `${at()}?key=${KEY}`, label: "Quoting", nextPath: "/" }),
      );
      const carla = await memberOf(server, t.workspaceId, "Carla", email("carla"), "admin");
      const res = await quoted(
        (url) => `no tools at ${url.href}`,
        () => call(carla, "POST", `${t.w}/connectors/custom/${started.server.id}/refresh`),
      );
      expect([res.status, errorOf(res)]).toEqual([400, `no tools at ${at()}?[redacted]`]);
      expect(JSON.stringify(res.body)).not.toContain(KEY);
    },
    SERVER_TEST_MS,
  );

  test(
    "a connect that fails quoting the address answers without its key",
    async () => {
      const t = await team();
      const KEY = "connect-key-24680";
      const res = await quoted(
        (url) => `no session at ${url.href}`,
        () => connectCustom(t, t.ana, { serverUrl: `${at()}?key=${KEY}`, label: "Quoting", nextPath: "/" }),
        true,
      );
      expect([res.status, errorOf(res)]).toEqual([400, `no session at ${at()}?[redacted]`]);
    },
    SERVER_TEST_MS,
  );

  test(
    "a short query blanks nothing else, and a key with a + is redacted raw and decoded",
    async () => {
      const t = await team();
      const short = await ok(
        connectCustom(t, t.ana, { serverUrl: `${at()}?x`, label: "Short", nextPath: "/" }),
      );
      const words = await quoted(
        (url) => `next index exhausted at ${url.href}`,
        () => call(t.ana, "POST", `${t.w}/connectors/custom/${short.server.id}/refresh`),
      );
      expect(errorOf(words)).toBe(`next index exhausted at ${at()}?x`);

      const RAW = "abc+def/ghi==";
      const plus = await ok(
        connectCustom(t, t.ana, { serverUrl: `${at()}?key=${RAW}`, label: "Plus", nextPath: "/" }),
      );
      const refresh = () => call(t.ana, "POST", `${t.w}/connectors/custom/${plus.server.id}/refresh`);
      const raw = await quoted((url) => `bad key ${url.search.slice("?key=".length)}`, refresh);
      const form = await quoted((url) => `bad key ${url.searchParams.get("key")}`, refresh);
      expect([errorOf(raw), errorOf(form)]).toEqual(["bad key [redacted]", "bad key [redacted]"]);
    },
    SERVER_TEST_MS,
  );
});

test(
  "redaction knows the credential a client sends, even when the kept one changed after it was read",
  async () => {
    const t = await team();
    const id = await stock(t, "Kept");
    const [stale] = await server.deps.db.select().from(connections).where(eq(connections.id, id));
    if (!stale) throw new Error("no connection");
    // Another credential lands after the row was read (a refresh, a new key): the client sends that one.
    await server.deps.db
      .update(connections)
      .set({
        secret: integrationSealer(server.deps).seal(
          JSON.stringify({ kind: "api_key", apiKey: "sent-later" }),
        ),
      })
      .where(eq(connections.id, id));
    expect(secretsSentBy(await mcpFor(server.deps, stale))).toEqual(["sent-later"]);
  },
  SERVER_TEST_MS,
);

test(
  "a session that fails to open while the kept credential can't be read: the tool fails plainly, without the service's text",
  async () => {
    const t = await team();
    const started = await ok(
      connectCustom(t, t.ana, {
        serverUrl: `http://localhost:${echo.port}/mcp`,
        apiKey: QUOTED,
        label: "Echo",
        nextPath: "/",
      }),
    );
    const id: string = started.server.id;
    await ok(saveTools(t, id, { label: "Echo", tools: [{ name: "ping", access: "read", label: "" }] }));
    await ok(setAccess(t, { connectors: { [id]: true } }));
    const { deps } = server;
    const real = deps.db;
    let armed = false;
    // The read of the kept credential (a select of `secret` alone) fails once, after the session failed to open.
    deps.db = new Proxy(real, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target);
        if (prop !== "select") return typeof value === "function" ? value.bind(target) : value;
        return (fields?: Record<string, unknown>) => {
          if (armed && fields && Object.keys(fields).join() === "secret") {
            armed = false;
            throw new Error("the database is down");
          }
          return value.call(target, fields);
        };
      },
    });
    echoInitFails = true;
    try {
      armed = true;
      const res = await t.ask("mcp_echo__ping", {});
      expect(armed).toBe(false);
      // An input error (the call never left): the run goes on with the plain message, no database text.
      expect(res?.failed).toBe(true);
      expect(res?.result).toContain("Echo failed: the server did not answer");
      expect(res?.result).not.toContain("database");
    } finally {
      echoInitFails = false;
      deps.db = real;
    }
  },
  SERVER_TEST_MS,
);
