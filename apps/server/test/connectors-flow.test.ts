// The connectors' OAuth round trip and their credential, called as the connector routes will call them (the
// routes come with a later slice): the state is spent on first use and only counts for the same person, in the
// same session, before it expires and while that person can still configure the workspace; a refresh that two
// runs need at once is one exchange; and two servers whose paths differ only in case keep separate credentials.
// The OAuth server is the local fake MCP; nothing goes out to the network.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { schema } from "@vanr/engine/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import {
  connectCustom,
  connectWithKey,
  disconnect,
  finishOAuth,
  integrationSealer,
  MAX_SCOPE_ATTEMPTS,
  mcpFor,
  refreshCustom,
  requestScope,
  type Starter,
  saveCustomTools,
  startCatalogOAuth,
  startScopeStepUp,
} from "../src/integrations/connectors";
import { McpAuthRequired } from "../src/integrations/mcp";
import { REFRESH_MARGIN_MS } from "../src/integrations/oauth";
import type { RunningServer } from "../src/server";
import { type FakeMcp, startFakeMcp } from "./fake-mcp";
import { SERVER_TEST_MS, signedIn, startTestServer } from "./harness";
import { gate } from "./lock-double";
import { type Person, seedWorkspace } from "./seed";

const { connections, oauthStates, members } = schema;
const STATE_TTL_MS = 10 * 60_000;

let clock = new Date("2026-11-14T12:00:00Z");
const advance = (ms: number) => {
  clock = new Date(clock.getTime() + ms);
};
let server: RunningServer;
let mcp: FakeMcp;
let ana: Person;
let workspaceId: string;
let channelId: string;
let me: Starter;

beforeAll(async () => {
  mcp = startFakeMcp({ expiresIn: 90, rotateRefresh: true, mcpPaths: ["/mcp", "/MCP"] });
  server = await startTestServer({
    env: { ALLOW_PRIVATE_NETWORKS: "true" },
    fetchExternal: fetch,
    now: () => clock,
  });
  ana = await signedIn(server, "Ana", "ana@connectors.test");
  ({ workspaceId, general: channelId } = await seedWorkspace(server, ana, "Connectors"));
  me = { workspaceId, userId: ana.user.id, role: "owner", handle: "ana", sessionId: "session-ana" };
}, SERVER_TEST_MS);
afterAll(async () => {
  await server.stop();
  mcp.stop();
}, SERVER_TEST_MS);

/** Starts the OAuth of an own MCP server and follows the browser to the authorization server. */
async function begin(url = mcp.url, starter: Starter = me) {
  const start = await connectCustom(server.deps, starter, { serverUrl: url, nextPath: "/back" });
  if (start.status !== "oauth") throw new Error(`expected an OAuth start, got ${start.status}`);
  const back = await mcp.authorize(start.consentUrl);
  return { serverId: start.serverId, ...back };
}

const finish = (
  back: { code: string; state: string; iss: string | null },
  viewer = { userId: ana.user.id, sessionId: "session-ana" },
) => finishOAuth(server.deps, viewer, { code: back.code, state: back.state, iss: back.iss ?? undefined });

const connection = async (id: string) => {
  const [row] = await server.deps.db.select().from(connections).where(eq(connections.id, id));
  if (!row) throw new Error("no connection");
  return row;
};
const codeExchanges = () => mcp.tokenRequests.filter((f) => f.get("grant_type") === "authorization_code");
const refreshes = () => mcp.tokenRequests.filter((f) => f.get("grant_type") === "refresh_token");

/** Hold a real network reply while another workspace operation completes. */
async function during(
  method: string,
  run: (deps: typeof server.deps) => Promise<unknown>,
  concurrent: () => Promise<unknown>,
  fail = false,
): Promise<unknown> {
  const entered = gate(),
    release = gate();
  const fetchExternal = Object.assign(
    async (url: string | URL | Request, init?: RequestInit) => {
      const response = await fetch(url, init);
      const body = String(init?.body).startsWith("{") ? JSON.parse(String(init?.body)) : {};
      if (String(url).endsWith(method) || body.method === method) {
        entered.open();
        await release.opened;
        if (fail)
          return Response.json({
            jsonrpc: "2.0",
            id: body.id,
            error: {
              code: -1,
              message: `backend failure ${new Headers(init?.headers).get("authorization")}`,
            },
          });
      }
      return response;
    },
    { preconnect() {} },
  );
  const running = run({ ...server.deps, fetchExternal });
  try {
    await Promise.race([
      entered.opened,
      running.then(() => {
        throw new Error("operation ended before the held reply");
      }),
    ]);
    await concurrent();
  } finally {
    release.open();
    await running.catch(() => undefined);
  }
  return running;
}

const decide = (row: Awaited<ReturnType<typeof connection>>, access: "off" | "write") =>
  saveCustomTools(server.deps, row, {
    label: row.label,
    tools: row.tools.map((t) => ({ name: t.name, access, label: "kept label", confirmed: true })),
  });
const stepUp = async (id: string) =>
  mcp.authorize(await startScopeStepUp(server.deps, me, await connection(id), "/back"));

describe("the OAuth state", () => {
  test(
    "a callback connects once; the same callback again is rejected and exchanges no code",
    async () => {
      const back = await begin();
      const exchanged = codeExchanges().length;
      const to = await finish(back);
      expect(to).toBe(`/back?connected=${encodeURIComponent(`custom:${back.serverId}`)}`);
      const row = await connection(back.serverId);
      expect(row.status).toBe("active");
      expect(row.tools.map((t) => t.name)).toEqual(["list_items", "create_item"]);
      expect(codeExchanges().length).toBe(exchanged + 1);
      // Neither the code, the state nor the token goes back in the redirect; the token rests sealed.
      expect(to).not.toContain(back.code);
      expect(to).not.toContain(back.state);
      expect(row.secret).not.toContain("token-");
      expect(JSON.parse(integrationSealer(server.deps).open(row.secret ?? "")).kind).toBe("oauth");

      expect(await finish(back)).toBe("/?connector_error=state");
      expect(codeExchanges().length).toBe(exchanged + 1);
    },
    SERVER_TEST_MS,
  );

  test(
    "another session, or another person, spends the state without exchanging the code",
    async () => {
      for (const viewer of [
        { userId: ana.user.id, sessionId: "session-other" },
        { userId: "someone-else", sessionId: "session-ana" },
      ]) {
        const back = await begin();
        const exchanged = codeExchanges().length;
        expect(await finish(back, viewer)).toBe("/back?connector_error=state");
        // Spent: the right session can't use it afterwards either.
        expect(await finish(back)).toBe("/?connector_error=state");
        expect(codeExchanges().length).toBe(exchanged);
        expect((await connection(back.serverId)).secret).toBeNull();
      }
    },
    SERVER_TEST_MS,
  );

  test(
    "the state lasts ten minutes: a millisecond before it counts, at ten minutes it doesn't",
    async () => {
      const early = await begin();
      advance(STATE_TTL_MS - 1);
      expect(await finish(early)).toContain("connected=");
      const late = await begin();
      advance(STATE_TTL_MS);
      expect(await finish(late)).toBe("/back?connector_error=state");
      expect((await connection(late.serverId)).status).toBe("pending");
    },
    SERVER_TEST_MS,
  );

  test(
    "a person who can no longer configure the workspace, or left it, can't finish what they started",
    async () => {
      const bob = await signedIn(server, "Bob", "bob@connectors.test");
      const other = await seedWorkspace(server, bob, "Bob's");
      const bobMe: Starter = {
        workspaceId: other.workspaceId,
        userId: bob.user.id,
        role: "owner",
        handle: "bob",
        sessionId: "session-bob",
      };
      const viewer = { userId: bob.user.id, sessionId: "session-bob" };
      const where = and(eq(members.workspaceId, other.workspaceId), eq(members.userId, bob.user.id));

      const lowered = await begin(mcp.url, bobMe);
      await server.deps.db.update(members).set({ role: "member" }).where(where);
      expect(await finish(lowered, viewer)).toBe("/back?connector_error=state");

      await server.deps.db.update(members).set({ role: "admin" }).where(where);
      const removed = await begin(mcp.url, { ...bobMe, role: "admin" });
      await server.deps.db.delete(members).where(where);
      expect(await finish(removed, viewer)).toBe("/back?connector_error=state");

      // The connection of Bob's workspace never became active and Ana's workspace got nothing from it.
      expect((await connection(removed.serverId)).workspaceId).toBe(other.workspaceId);
      expect((await connection(removed.serverId)).status).toBe("pending");
    },
    SERVER_TEST_MS,
  );

  test(
    "the state is kept sealed with its session: the verifier never rests in plain text",
    async () => {
      const start = await connectCustom(server.deps, me, { serverUrl: mcp.url, nextPath: "/back" });
      if (start.status !== "oauth") throw new Error("expected an OAuth start");
      const state = new URL(start.consentUrl).searchParams.get("state") ?? "";
      const [row] = await server.deps.db.select().from(oauthStates).where(eq(oauthStates.state, state));
      expect(row?.workspaceId).toBe(workspaceId);
      const opened = JSON.parse(integrationSealer(server.deps).open(row?.secret ?? ""));
      expect(opened.sessionId).toBe("session-ana");
      expect(row?.secret).not.toContain(opened.verifier);
    },
    SERVER_TEST_MS,
  );
});

describe("the OAuth credential", () => {
  test(
    "two runs that need the same refresh at once make one exchange and both use its token",
    async () => {
      const back = await begin();
      await finish(back);
      const before = refreshes().length;
      // 90 s tokens: 40 s later, 50 s are left, inside the one-minute margin.
      advance(90_000 - REFRESH_MARGIN_MS + 10_000);
      const row = await connection(back.serverId);
      const clients = await Promise.all(Array.from({ length: 5 }, () => mcpFor(server.deps, row)));
      expect(refreshes().length).toBe(before + 1);
      for (const client of clients) expect((await client.callTool("list_items", {})).text).toBe("bolt, nut");
      const auths = new Set(mcp.calls.slice(-5).map((c) => c.auth));
      expect(auths.size).toBe(1);
    },
    SERVER_TEST_MS,
  );

  test(
    "the refresh happens within the margin and not before it",
    async () => {
      const back = await begin();
      await finish(back);
      const before = refreshes().length;
      // 90 s tokens: one millisecond before the margin nothing is exchanged; at the margin it is.
      advance(90_000 - REFRESH_MARGIN_MS - 1);
      await mcpFor(server.deps, await connection(back.serverId));
      expect(refreshes().length).toBe(before);
      advance(1);
      await mcpFor(server.deps, await connection(back.serverId));
      expect(refreshes().length).toBe(before + 1);
    },
    SERVER_TEST_MS,
  );

  test(
    "servers whose paths differ only in case keep separate credentials",
    async () => {
      const lower = await begin(`${mcp.origin}/mcp`);
      const upper = await begin(`${mcp.origin}/MCP`);
      expect(mcp.authorizeRequests.slice(-2).map((r) => r.get("resource"))).toEqual([
        `${mcp.origin}/mcp`,
        `${mcp.origin}/MCP`,
      ]);
      await finish(lower);
      await finish(upper);
      const a = await connection(lower.serverId);
      const b = await connection(upper.serverId);
      expect([a.serverUrl, b.serverUrl]).toEqual([`${mcp.origin}/mcp`, `${mcp.origin}/MCP`]);
      const open = (sealed: string | null) => JSON.parse(integrationSealer(server.deps).open(sealed ?? ""));
      expect(open(a.secret).tokens.accessToken).not.toBe(open(b.secret).tokens.accessToken);

      // Both near expiry at once: one exchange each, each with its own refresh token.
      const before = refreshes().length;
      advance(90_000 - REFRESH_MARGIN_MS + 10_000);
      await Promise.all([mcpFor(server.deps, a), mcpFor(server.deps, b)]);
      const used = refreshes()
        .slice(before)
        .map((f) => f.get("refresh_token"));
      expect(used.sort()).toEqual(
        [open(a.secret).tokens.refreshToken, open(b.secret).tokens.refreshToken].sort(),
      );
      const [a2, b2] = [await connection(a.id), await connection(b.id)];
      expect(open(a2.secret).tokens.accessToken).not.toBe(open(b2.secret).tokens.accessToken);
    },
    SERVER_TEST_MS,
  );

  test(
    "the same set of scopes is asked for at most MAX_SCOPE_ATTEMPTS times",
    async () => {
      const back = await begin();
      await finish(back);
      const row = await connection(back.serverId);
      const kinds: string[] = [];
      for (let i = 0; i <= MAX_SCOPE_ATTEMPTS; i++)
        kinds.push((await requestScope(server.deps, row, "create_item", "items:write")).kind);
      expect(kinds).toEqual([...Array.from({ length: MAX_SCOPE_ATTEMPTS }, () => "ask"), "exhausted"]);
      expect((await connection(row.id)).scopeRequest?.attempts).toBe(MAX_SCOPE_ATTEMPTS);
    },
    SERVER_TEST_MS,
  );
});

describe("the callback and the kept credential", () => {
  test(
    "a connection revoked while the code is being exchanged stays revoked: the token received is dropped",
    async () => {
      const back = await begin();
      const pending = await connection(back.serverId);
      const result = await during(
        "/token",
        (deps) =>
          finishOAuth(deps, me, {
            code: back.code,
            state: back.state,
            iss: back.iss ?? undefined,
          }),
        () => disconnect(server.deps, pending),
      );
      expect(result).toBe("/back?connector_error=gone");
      const after = await connection(back.serverId);
      expect(after.revokedAt).not.toBeNull();
      expect(after.secret).toBeNull();
      expect(after.status).toBe("pending");
    },
    SERVER_TEST_MS,
  );

  test(
    "a kept credential in an old or broken shape is never sent: the connection asks to reconnect",
    async () => {
      const back = await begin();
      await finish(back);
      for (const kept of [
        { apiKey: mcp.apiKey },
        { kind: "api_key" },
        { kind: "oauth", tokens: { accessToken: 1 } },
      ]) {
        await server.deps.db
          .update(connections)
          .set({ secret: integrationSealer(server.deps).seal(JSON.stringify(kept)), status: "active" })
          .where(eq(connections.id, back.serverId));
        const row = await connection(back.serverId);
        const calls = mcp.calls.length;
        expect(await mcpFor(server.deps, row).catch((e: unknown) => e)).toBeInstanceOf(McpAuthRequired);
        await expect(refreshCustom(server.deps, row)).rejects.toMatchObject({ code: "connector.auth" });
        expect(mcp.calls.length).toBe(calls);
        expect((await connection(back.serverId)).status).toBe("reauth_required");
      }
    },
    SERVER_TEST_MS,
  );

  test(
    "a server that echoes the key in its error doesn't get it into ours",
    async () => {
      const key = "echoed-key+/value=42";
      const echo = Bun.serve({
        port: 0,
        async fetch(req) {
          const auth = req.headers.get("authorization") ?? "";
          const { id } = z.object({ id: z.number() }).parse(await req.json());
          const words = `rejected ${auth} b64=${Buffer.from(key).toString("base64")} pct=${encodeURIComponent(key)}\u0007\r\n`;
          return Response.json({
            jsonrpc: "2.0",
            id,
            error: { code: -1, message: words.repeat(20) },
          });
        },
      });
      try {
        const err = await connectCustom(server.deps, me, {
          serverUrl: `http://localhost:${echo.port}/mcp`,
          apiKey: key,
          nextPath: "/",
        }).catch((e: unknown) => e);
        expect(err).toMatchObject({ code: "connector.unreachable" });
        const message = err instanceof Error ? err.message : "";
        for (const form of [key, Buffer.from(key).toString("base64"), encodeURIComponent(key)])
          expect([form, message.includes(form)]).toEqual([form, false]);
        expect(message).toContain("rejected Bearer [redacted]");
        expect(message.length).toBeLessThanOrEqual(300);
        // biome-ignore lint/suspicious/noControlCharactersInRegex: the assertion is about control characters
        expect(/[\u0000-\u001f]/.test(message)).toBe(false);
      } finally {
        echo.stop(true);
      }
    },
    SERVER_TEST_MS,
  );
});

test(
  "revoked snapshots cannot start new MCP calls, with either OAuth or a key",
  async () => {
    const back = await begin();
    await finish(back);
    const keyed = await connectCustom(server.deps, me, {
      serverUrl: mcp.url,
      apiKey: mcp.apiKey,
      nextPath: "/",
    });
    if (keyed.status !== "server") throw new Error("expected key connection");
    for (const id of [back.serverId, keyed.server.id]) {
      const stale = await connection(id);
      await disconnect(server.deps, stale);
      const calls = mcp.calls.length;
      await expect(mcpFor(server.deps, stale)).rejects.toThrow();
      expect(mcp.calls.length).toBe(calls);
    }
  },
  SERVER_TEST_MS,
);

test(
  "errors redact the refreshed token even after disconnect erases it",
  async () => {
    const back = await begin();
    await finish(back);
    const row = await connection(back.serverId);
    advance(40_000);
    const error = await during(
      "tools/list",
      (deps) => refreshCustom(deps, row),
      () => disconnect(server.deps, row),
      true,
    ).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "connector.unreachable" });
    expect(error instanceof Error ? error.message : "").toContain("Bearer [redacted]");
  },
  SERVER_TEST_MS,
);

test(
  "a pending tool list preserves the latest off decision, including in OAuth callbacks",
  async () => {
    const back = await begin();
    await finish(back);
    for (const callback of [false, true]) {
      const row = await decide(await connection(back.serverId), "write");
      await during(
        "tools/list",
        async (deps) => {
          if (!callback) return refreshCustom(deps, row);
          await requestScope(server.deps, row, "create_item", "items:write");
          const next = await stepUp(row.id);
          return finishOAuth(deps, me, { ...next, iss: next.iss ?? undefined });
        },
        () => decide(row, "off"),
      );
      expect(
        (await connection(row.id)).tools.every(
          (t) => t.access === "off" && t.confirmed && t.label === "kept label",
        ),
      ).toBe(true);
    }
  },
  SERVER_TEST_MS,
);

test(
  "a failed callback tool list preserves the saved tools and labels",
  async () => {
    const back = await begin();
    await finish(back);
    const row = await decide(await connection(back.serverId), "write");
    await requestScope(server.deps, row, "create_item", "items:write");
    const next = await stepUp(row.id);
    expect(
      await during(
        "tools/list",
        (deps) => finishOAuth(deps, me, { ...next, iss: next.iss ?? undefined }),
        async () => {},
        true,
      ),
    ).toContain("connector_error=tools");
    expect((await connection(row.id)).tools).toEqual(row.tools);
  },
  SERVER_TEST_MS,
);

test(
  "callback settlement checks the current request and each card's own scopes",
  async () => {
    const back = await begin();
    await finish(back);
    const row = await connection(back.serverId);
    await requestScope(server.deps, row, "create_item", "items:write");
    const next = await stepUp(row.id);
    const ids = ["scope-write", "scope-admin"];
    await server.deps.db.insert(schema.messages).values(
      ids.map((id, i) => ({
        id,
        workspaceId,
        channelId,
        authorKind: "person" as const,
        authorId: me.userId,
        body: "Permission",
        meta: {
          connectorScope: {
            connectionId: row.id,
            connector: "custom",
            label: "Stock",
            owner: "workspace",
            scopes: [i ? "items:admin" : "items:write"],
            state: "pending",
            tool: "create_item",
          },
        },
      })),
    );
    await during(
      "/token",
      (deps) => finishOAuth(deps, me, { ...next, iss: next.iss ?? undefined }),
      () => requestScope(server.deps, row, "create_item", "items:admin"),
    );
    expect((await connection(row.id)).scopeRequest?.scope).toContain("items:admin");
    for (const [i, id] of ids.entries()) {
      const [card] = await server.deps.db.select().from(schema.messages).where(eq(schema.messages.id, id));
      expect(card?.meta.connectorScope).toMatchObject({ state: i ? "pending" : "granted" });
    }
  },
  SERVER_TEST_MS,
);

test(
  "an older callback cannot replace a newer broader authorization",
  async () => {
    const back = await begin();
    await finish(back);
    const row = await connection(back.serverId);
    await requestScope(server.deps, row, "create_item", "items:write");
    const first = await stepUp(row.id);
    let newer: string | null = null;
    await during(
      "/token",
      (deps) => finishOAuth(deps, me, { ...first, iss: first.iss ?? undefined }),
      async () => {
        await requestScope(server.deps, row, "create_item", "items:admin");
        expect(await finish(await stepUp(row.id))).toContain("connected=");
        newer = (await connection(row.id)).secret;
      },
    );
    expect((await connection(row.id)).secret).toBe(newer);
  },
  SERVER_TEST_MS,
);

test(
  "automatic token refresh during consent preserves a valid step-up",
  async () => {
    const back = await begin();
    await finish(back);
    const row = await connection(back.serverId);
    advance(40_000);
    await requestScope(server.deps, row, "create_item", "items:write");
    const next = await stepUp(row.id);
    const before = refreshes().length;
    await (await mcpFor(server.deps, row)).listTools();
    expect(refreshes().length).toBe(before + 1);
    expect(await finish(next)).toContain("connected=");
    expect((await connection(row.id)).scopeRequest).toBeNull();
  },
  SERVER_TEST_MS,
);

test(
  "step-up and catalog OAuth use header-only resource discovery",
  async () => {
    const remote = startFakeMcp({ issuerPath: "/tenant" });
    let resource = remote.url;
    const fetchExternal = Object.assign(
      async (url: string | URL | Request, init?: RequestInit) => {
        if (String(url).includes("/.well-known/oauth-protected-resource"))
          return new Response(null, { status: 404 });
        if (String(url).endsWith("/metadata"))
          return Response.json({ resource, authorization_servers: [remote.issuer] });
        const response = await fetch(String(url) === "https://mcp.linear.app/mcp" ? remote.url : url, init);
        if ([401, 403].includes(response.status))
          response.headers.set("www-authenticate", `Bearer resource_metadata="${remote.origin}/metadata"`);
        return response;
      },
      { preconnect() {} },
    );
    const deps = { ...server.deps, fetchExternal };
    try {
      const started = await connectCustom(deps, me, { serverUrl: remote.url, nextPath: "/back" });
      if (started.status !== "oauth") throw new Error("expected OAuth");
      await finish(await remote.authorize(started.consentUrl));
      const row = await connection(started.serverId);
      await requestScope(deps, row, "create_item", "items:write");
      const url = await startScopeStepUp(deps, me, await connection(row.id), "/back");
      expect(new URL(url).searchParams.get("scope")).toContain("items:write");
      resource = "https://mcp.linear.app/mcp";
      expect(await startCatalogOAuth(deps, me, "linear", "/back")).toContain(`${remote.origin}/authorize`);
    } finally {
      remote.stop();
    }
  },
  SERVER_TEST_MS,
);

test(
  "sensitive catalog tools require approval despite readOnlyHint",
  async () => {
    const fetchExternal = Object.assign(
      async (_url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        return Response.json({
          jsonrpc: "2.0",
          id: body.id,
          result:
            body.method === "tools/list"
              ? { tools: [{ name: "delete_file", annotations: { readOnlyHint: true } }] }
              : {
                  protocolVersion: "2025-06-18",
                  capabilities: {},
                  serverInfo: { name: "fake", version: "1" },
                },
        });
      },
      { preconnect() {} },
    );
    const deps = { ...server.deps, fetchExternal };
    const row = await connectWithKey(deps, me, { connector: "github", apiKey: "key" });
    expect(row.tools[0]).toMatchObject({ access: "approval", confirmed: true });
  },
  SERVER_TEST_MS,
);
