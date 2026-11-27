// The connectors' OAuth (MCP spec 2026-07-28), through the connector routes and the agent runtime: the issuer is
// checked and recorded with the credential, `iss` is validated before the code is exchanged (RFC 9207), the
// first scope comes from the challenge, and an `insufficient_scope` gets an extra step with a card and a limit
// of attempts. The attacks (a return from another issuer, a swapped issuer, the internal network in the new
// addresses) show the block.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { schema } from "@vanr/engine/db";
import { eq } from "drizzle-orm";
import { integrationSealer, MAX_SCOPE_ATTEMPTS, requestScope } from "../src/integrations/connectors";
import { guardedFetch } from "../src/integrations/net";
import { discoverAuthServer } from "../src/integrations/oauth";
import type { RunningServer } from "../src/server";
import { type FakeMcp, startFakeMcp } from "./fake-mcp";
import { SERVER_TEST_MS, settle, signedIn, startTestServer, TestSocket } from "./harness";
import { type Called, call, ws } from "./route-calls";
import { memberOf, type Person, seedWorkspace } from "./seed";

const { connections, runEvents, runs } = schema;
const CLOUD = { allowPrivate: false, allowPlaintext: false };

const fakes: FakeMcp[] = [];
const fake = (opts: Parameters<typeof startFakeMcp>[0]) => {
  const f = startFakeMcp(opts);
  fakes.push(f);
  return f;
};
const scoped = fake({ toolScopes: { create_item: "items:write" }, scopesSupported: ["items:read"] });

/** The catalog's Linear answers from the fake with scopes, which speaks of itself by its own origin. */
const LINEAR = "https://mcp.linear.app";
const toLinear = (s: string) => s.replaceAll(scoped.origin, LINEAR);
const toFake = (s: string) => s.replaceAll(LINEAR, scoped.origin);
const external: typeof fetch = Object.assign(
  async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== LINEAR) return fetch(url, init);
    const res = await fetch(toFake(url.toString()), init);
    const headers = new Headers(res.headers);
    const challenge = headers.get("www-authenticate");
    if (challenge) headers.set("www-authenticate", toLinear(challenge));
    headers.delete("content-length");
    return new Response(toLinear(await res.text()), { status: res.status, headers });
  },
  { preconnect: () => {} },
);

let server: RunningServer;
beforeAll(async () => {
  server = await startTestServer({ env: { ALLOW_PRIVATE_NETWORKS: "true" }, fetchExternal: external });
}, SERVER_TEST_MS);
afterAll(async () => {
  await server.stop();
  for (const f of fakes) f.stop();
}, SERVER_TEST_MS);

let n = 0;
const email = (who: string) => `${who}${++n}@oauth.test`;

async function ok(res: Promise<Called>, status = 200) {
  const r = await res;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body;
}

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
  const ask = async (tool: string, input: unknown) => {
    const body = `@${lia.handle} [[tool:${tool} ${JSON.stringify(input)}]]`;
    const sent = await ok(
      call(beto, "POST", `${w}/channels/${general}/messages`, { body, clientId: `o${++seq}` }),
      201,
    );
    await settle(server);
    const [run] = await server.deps.db.select().from(runs).where(eq(runs.sourceMessageId, sent.id));
    if (!run) return null;
    const results = (await server.deps.db.select().from(runEvents).where(eq(runEvents.runId, run.id))).filter(
      (e) => e.kind === "tool_result",
    );
    return { result: results.map((e) => String((e.data as { content: unknown }).content)).join("\n") };
  };
  return { workspaceId, w, general, ana, beto, lia, ask };
}
type Team = Awaited<ReturnType<typeof team>>;

/** The OAuth return as the browser would make it, passing on the `iss` the authorization server put. */
async function callback(
  who: Person,
  f: FakeMcp,
  consentUrl: string,
  tamper: { iss?: string | null; error?: string } = {},
) {
  const catalog = f === scoped && consentUrl.startsWith(LINEAR);
  const back = await f.authorize(catalog ? toFake(consentUrl) : consentUrl);
  const returned = back.iss !== null && catalog ? toLinear(back.iss) : back.iss;
  const iss = tamper.iss === undefined ? returned : tamper.iss;
  const q = new URLSearchParams({ state: back.state });
  if (tamper.error) q.set("error", tamper.error);
  else q.set("code", back.code);
  if (iss !== null) q.set("iss", iss);
  const res = await who.browser.fetch(`/api/v1/connectors/oauth/callback?${q}`);
  expect(res.status).toBe(302);
  return res.headers.get("location") ?? "";
}

async function customOAuth(t: Team, f: FakeMcp) {
  const started = await ok(
    call(t.ana, "POST", `${t.w}/connectors/custom`, { serverUrl: f.url, label: "Store", nextPath: "/" }),
  );
  if (started.status !== "oauth") throw new Error(`expected oauth, got ${started.status}`);
  return started as { consentUrl: string; serverId: string };
}

const servers = async (t: Team) => (await ok(call(t.ana, "GET", `${t.w}/connectors/custom`))).servers;
const list = async (t: Team) =>
  (await ok(call(t.ana, "GET", `${t.w}/connectors`))).connections as {
    id: string;
    scopeRequest?: { scope: string; tool: string } | null;
  }[];
const storedSecret = async (connectionId: string) => {
  const [row] = await server.deps.db.select().from(connections).where(eq(connections.id, connectionId));
  return row?.secret ? JSON.parse(integrationSealer(server.deps).open(row.secret)) : null;
};
const startLinear = (t: Team) =>
  ok(call(t.ana, "POST", `${t.w}/connectors/linear/oauth/start`, { nextPath: "/" }));
const stepUp = (t: Team, who: Person, id: string) =>
  call(who, "POST", `${t.w}/connectors/${id}/scope`, { nextPath: "/" });
/** The workspace's Linear over OAuth on the scoped fake, granted to Lia. */
async function linear(t: Team) {
  const { consentUrl } = await startLinear(t);
  await callback(t.ana, scoped, consentUrl);
  const [conn] = await list(t);
  if (!conn) throw new Error("no connection");
  await ok(call(t.ana, "PUT", `${t.w}/agents/${t.lia.id}/access`, { connectors: { [conn.id]: true } }));
  return conn;
}
const cards = async (t: Team) =>
  (
    (await ok(call(t.beto, "GET", `${t.w}/channels/${t.general}/messages`))).messages as {
      meta: { connectorScope?: { state?: string } & Record<string, unknown> };
    }[]
  ).filter((m) => m.meta.connectorScope);

describe("iss on the authorization's return (RFC 9207)", () => {
  test(
    "attack: a return with another issuer's iss exchanges no code and connects nothing",
    async () => {
      const t = await team();
      const f = fake({ iss: "wrong" });
      const started = await customOAuth(t, f);
      expect(await callback(t.ana, f, started.consentUrl)).toContain("connector_error=issuer");
      // The code never reached the token endpoint.
      expect(f.tokenRequests).toEqual([]);
      expect(await servers(t)).toEqual([]);
    },
    SERVER_TEST_MS,
  );

  test(
    "attack: an error coming from another issuer doesn't show on the screen",
    async () => {
      const t = await team();
      const f = fake({});
      const started = await customOAuth(t, f);
      const location = await callback(t.ana, f, started.consentUrl, {
        iss: "https://evil.example",
        error: "phish_me",
      });
      expect(location).toContain("connector_error=issuer");
      expect(location).not.toContain("phish_me");
    },
    SERVER_TEST_MS,
  );

  test(
    "attack: a server that promises iss and comes back without it is rejected",
    async () => {
      const t = await team();
      const f = fake({ iss: "omit_promised" });
      const started = await customOAuth(t, f);
      expect(await callback(t.ana, f, started.consentUrl)).toContain("connector_error=issuer");
      expect(f.tokenRequests).toEqual([]);
    },
    SERVER_TEST_MS,
  );

  test(
    "the right iss connects and the issuer is recorded with the credential",
    async () => {
      const t = await team();
      const f = fake({});
      const started = await customOAuth(t, f);
      expect(await callback(t.ana, f, started.consentUrl)).toContain("connected=custom%3A");
      const secret = await storedSecret(started.serverId);
      expect(secret.tokens).toMatchObject({ issuer: f.issuer, resource: f.url });
      // The 2026-07-28 dynamic registration: `application_type` is required.
      expect(f.registrations.at(-1)).toMatchObject({ application_type: "web" });
    },
    SERVER_TEST_MS,
  );

  test(
    "an old server that doesn't promise iss connects without it",
    async () => {
      const t = await team();
      const f = fake({ iss: "omit" });
      const started = await customOAuth(t, f);
      expect(await callback(t.ana, f, started.consentUrl)).toContain("connected=custom%3A");
    },
    SERVER_TEST_MS,
  );
});

describe("the issuer's discovery (RFC 8414 §3.3)", () => {
  test(
    "an issuer with a path: the metadata at the .well-known with the path",
    async () => {
      const t = await team();
      const f = fake({ issuerPath: "/tenant1" });
      const started = await customOAuth(t, f);
      expect(await callback(t.ana, f, started.consentUrl)).toContain("connected=custom%3A");
      expect((await storedSecret(started.serverId)).tokens.issuer).toBe(`${f.origin}/tenant1`);
    },
    SERVER_TEST_MS,
  );

  test(
    "attack: metadata with another issuer brings the OAuth down before a client is registered",
    async () => {
      const t = await team();
      const f = fake({ issuerMismatch: true });
      const started = await ok(
        call(t.ana, "POST", `${t.w}/connectors/custom`, { serverUrl: f.url, label: "Store", nextPath: "/" }),
      );
      expect(started.status).toBe("key_missing");
      expect(f.registrations).toEqual([]);
      expect(f.authorizeRequests).toEqual([]);
    },
    SERVER_TEST_MS,
  );

  test(
    "the first scope: the 401 challenge's wins; without it, the resource's scopes_supported",
    async () => {
      const t = await team();
      const a = await customOAuth(t, fake({ challengeScope: "items:read", scopesSupported: ["a", "b"] }));
      expect(new URL(a.consentUrl).searchParams.get("scope")).toBe("items:read");
      const b = await customOAuth(t, fake({ scopesSupported: ["a", "b"] }));
      expect(new URL(b.consentUrl).searchParams.get("scope")).toBe("a b");
      const c = await customOAuth(t, fake({}));
      expect(new URL(c.consentUrl).searchParams.has("scope")).toBe(false);
    },
    SERVER_TEST_MS,
  );
});

describe("SSRF attacks on the OAuth's new paths (cloud edition)", () => {
  type Hit = { url: string };
  const recording = (routes: Record<string, () => Response>) => {
    const hits: Hit[] = [];
    const fn = async (input: string | URL | Request) => {
      const url = String(input);
      hits.push({ url });
      const route = Object.entries(routes).find(([prefix]) => url.startsWith(prefix));
      return route ? route[1]() : new Response("no", { status: 404 });
    };
    return { fetch: Object.assign(fn, { preconnect: () => {} }) as typeof fetch, hits };
  };
  const internal = (hits: Hit[]) =>
    hits.filter((h) => /\/\/(10\.|127\.|169\.254\.|\[::1\]|localhost)/.test(h.url));
  const RESOURCE = "https://93.184.216.34/mcp";

  test("a resource that points the authorization server at the cloud's metadata", async () => {
    const { fetch: raw, hits } = recording({
      "https://93.184.216.34/.well-known/oauth-protected-resource": () =>
        Response.json({ resource: RESOURCE, authorization_servers: ["http://169.254.169.254/latest"] }),
    });
    await expect(discoverAuthServer(guardedFetch(raw, false), RESOURCE, null, CLOUD)).rejects.toThrow(
      "unsafe OAuth address",
    );
    expect(internal(hits)).toEqual([]);
  });

  test("the challenge's resource_metadata pointing at the internal network is not fetched", async () => {
    const { fetch: raw, hits } = recording({});
    await expect(
      discoverAuthServer(
        guardedFetch(raw, false),
        RESOURCE,
        "https://10.0.0.5/.well-known/oauth-protected-resource",
        CLOUD,
      ),
    ).rejects.toThrow();
    expect(internal(hits)).toEqual([]);
  });

  test("a redirect of the metadata with a path to the internal network is barred", async () => {
    const { fetch: raw, hits } = recording({
      "https://93.184.216.34/.well-known/oauth-protected-resource/mcp": () =>
        new Response(null, { status: 302, headers: { location: "https://127.0.0.1:5432/" } }),
      "https://93.184.216.34/.well-known/oauth-protected-resource": () =>
        Response.json({
          resource: "https://93.184.216.34",
          authorization_servers: ["https://93.184.216.34"],
        }),
      "https://93.184.216.34/.well-known/oauth-authorization-server": () =>
        Response.json({
          issuer: "https://93.184.216.34",
          authorization_endpoint: "https://93.184.216.34/authorize",
          token_endpoint: "https://93.184.216.34/token",
        }),
    });
    const found = await discoverAuthServer(guardedFetch(raw, false), RESOURCE, null, CLOUD);
    expect(found.issuer).toBe("https://93.184.216.34");
    expect(internal(hits)).toEqual([]);
  });

  test("an issuer with a path that tries to leave through the .well-known for the internal network", async () => {
    const { fetch: raw, hits } = recording({
      "https://93.184.216.34/.well-known/oauth-protected-resource": () =>
        Response.json({ resource: RESOURCE, authorization_servers: ["https://[::1]/tenant"] }),
    });
    await expect(discoverAuthServer(guardedFetch(raw, false), RESOURCE, null, CLOUD)).rejects.toThrow();
    expect(internal(hits)).toEqual([]);
  });
});

describe("the extra step on insufficient_scope", () => {
  test(
    "an amber card, a limit of attempts, the union's authorization and the run goes on",
    async () => {
      const t = await team();
      const { consentUrl } = await startLinear(t);
      expect(new URL(consentUrl).searchParams.get("scope")).toBe("items:read");
      expect(await callback(t.ana, scoped, consentUrl)).toContain("connected=linear");
      const [conn] = await list(t);
      if (!conn) throw new Error("no connection");
      await ok(call(t.ana, "PUT", `${t.w}/agents/${t.lia.id}/access`, { connectors: { [conn.id]: true } }));
      const registered = scoped.registrations.length;

      const first = await t.ask("linear__create_item", { name: "washer" });
      expect(first?.result).toContain("needs more permission");
      expect(first?.result).toContain("items:write");
      expect((await cards(t)).map((m) => m.meta.connectorScope)).toEqual([
        {
          connectionId: conn.id,
          connector: "linear",
          label: "Linear",
          tool: "create_item",
          scopes: ["items:write"],
          owner: "workspace",
          state: "pending",
        },
      ]);
      expect((await list(t))[0]?.scopeRequest).toEqual({
        scope: "items:read items:write",
        tool: "create_item",
      });

      // Repeating posts no other card; past the limit it stops asking (no authorization loop).
      expect((await t.ask("linear__create_item", { name: "washer" }))?.result).toContain(
        "already in the conversation",
      );
      expect((await t.ask("linear__create_item", { name: "washer" }))?.result).toContain("Do not retry");
      expect(await cards(t)).toHaveLength(1);
      expect(scoped.toolCalls.filter((c) => c.name === "create_item")).toEqual([]);

      // Who doesn't configure the workspace doesn't authorize.
      expect((await stepUp(t, t.beto, conn.id)).status).toBe(403);

      const socket = await TestSocket.open(t.ana.browser, t.workspaceId);
      await socket.subscribe(t.general);
      const { consentUrl: more } = await ok(stepUp(t, t.ana, conn.id));
      // The union of what was asked and the challenge, and the same client of the same issuer (no new
      // registration).
      expect(new URL(more).searchParams.get("scope")).toBe("items:read items:write");
      expect(scoped.registrations.length).toBe(registered);
      expect(await callback(t.ana, scoped, more)).toContain("connected=linear");
      const granted = await socket.event("connector.scope");
      expect((granted.event.connectorScope as { state: string }).state).toBe("granted");
      socket.close();
      expect((await cards(t))[0]?.meta.connectorScope?.state).toBe("granted");
      expect((await list(t))[0]?.scopeRequest).toBeNull();

      expect((await t.ask("linear__create_item", { name: "washer" }))?.result).toContain("created: washer");
    },
    SERVER_TEST_MS,
  );

  test(
    "a partial consent doesn't settle the request: one card, waiting, and the limit holds",
    async () => {
      const t = await team();
      const conn = await linear(t);
      const states = async () => (await cards(t)).map((m) => m.meta.connectorScope?.state);
      const created = () => scoped.toolCalls.filter((c) => c.name === "create_item").length;
      const before = created();
      const results: string[] = [];
      for (let round = 0; round < 3; round++) {
        results.push((await t.ask("linear__create_item", { name: "x" }))?.result ?? "");
        // On the consent screen the person unticks items:write: the service gives only items:read.
        const { consentUrl: more } = await ok(stepUp(t, t.ana, conn.id));
        const partial = new URL(more);
        partial.searchParams.set("scope", "items:read");
        expect(await callback(t.ana, scoped, partial.toString())).toContain("connected=linear");
        expect(await states()).toEqual(["pending"]);
      }
      expect(results[0]).toContain("needs more permission");
      expect(results[1]).toContain("already in the conversation");
      expect(results[2]).toContain("Do not retry");
      expect((await list(t))[0]?.scopeRequest?.scope).toBe("items:read items:write");
      expect(created()).toBe(before);
    },
    SERVER_TEST_MS,
  );

  test(
    "two runs hitting the 403 at once: one card and both attempts counted",
    async () => {
      const t = await team();
      const { consentUrl } = await startLinear(t);
      await callback(t.ana, scoped, consentUrl);
      const [conn] = await list(t);
      const [row] = await server.deps.db
        .select()
        .from(connections)
        .where(eq(connections.id, conn?.id ?? ""));
      if (!row) throw new Error("no connection");
      const out = await Promise.all(
        Array.from({ length: MAX_SCOPE_ATTEMPTS + 1 }, () =>
          requestScope(server.deps, row, "create_item", "items:write"),
        ),
      );
      expect(out.filter((o) => o.kind === "ask" && o.first)).toHaveLength(1);
      expect(out.filter((o) => o.kind === "exhausted")).toHaveLength(1);
      const [after] = await server.deps.db.select().from(connections).where(eq(connections.id, row.id));
      expect(after?.scopeRequest?.attempts).toBe(MAX_SCOPE_ATTEMPTS);
    },
    SERVER_TEST_MS,
  );

  test(
    "a key connection without permission: asks for another key, with no card",
    async () => {
      const t = await team();
      // The fake's key has no scope; with a scope required, the fake rejects only OAuth tokens. So: connect by
      // OAuth and turn the kept credential into a key without permission.
      const conn = await linear(t);
      await server.deps.db
        .update(connections)
        .set({ authKind: "api_key" })
        .where(eq(connections.id, conn.id));
      const res = await t.ask("linear__create_item", { name: "x" });
      expect(res?.result).toContain("key it was connected with lacks permission");
      expect(await cards(t)).toEqual([]);
      expect((await stepUp(t, t.ana, conn.id)).body.error.code).toBe("connector.no_scope_request");
    },
    SERVER_TEST_MS,
  );
});
