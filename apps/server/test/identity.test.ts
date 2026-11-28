// Seam 7: the agent's own identity in its actions, through the connector routes and the agent runtime. The agent
// acts with its own account on the service (in place of the workspace's account), never with the account of who
// asked; who asked is only in the audit; the workspace gives the level and the channel only lowers it; revoking
// takes the agent's accounts away at once.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { schema } from "@vanr/engine/db";
import { and, asc, desc, eq } from "drizzle-orm";
import type { RunningServer } from "../src/server";
import { startFakeMcp } from "./fake-mcp";
import { SERVER_TEST_MS, settle, signedIn, startTestServer, waitFor } from "./harness";
import { wrapQuery } from "./lock-double";
import { type Called, call, seedAgent, ws } from "./route-calls";
import { memberOf, type Person, seedChannel, seedDm, seedWorkspace } from "./seed";

const { connections, gateDecisions, runEvents, runs } = schema;

const mcp = startFakeMcp();
/**
 * Linear's address answers from the fake MCP server, which speaks of itself by its own origin: every response is
 * rewritten to Linear's, so the resource and issuer checks see one service (and the browser's trip goes back).
 */
const LINEAR = "https://mcp.linear.app";
const toLinear = (s: string) => s.replaceAll(mcp.origin, LINEAR);
const toFake = (s: string) => s.replaceAll(LINEAR, mcp.origin);
/** Runs once while the token endpoint answers: what lands between the callback's checks and its activation. */
let duringToken: (() => Promise<void>) | null = null;
const external: typeof fetch = Object.assign(
  async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== LINEAR) return fetch(url, init);
    if (url.pathname === "/token" && duringToken) {
      const run = duringToken;
      duringToken = null;
      await run();
    }
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
  mcp.stop();
}, SERVER_TEST_MS);

let n = 0;
const email = (who: string) => `${who}${++n}@identity.test`;

/** The body of a call that must succeed with `status`. */
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
  const finance = await seedChannel(server, workspaceId, { name: "finance", members: [ana, beto] });
  const agent = (name: string, handle: string) =>
    ok(
      call(ana, "POST", `${w}/agents`, {
        name,
        handle,
        role: "support",
        instructions: "",
        channelIds: [general, finance],
      }),
      201,
    );
  const lia = await agent("Lia", `lia${n}`);
  const rui = await agent("Rui", `rui${n}`);
  let seq = 0;
  /** Beto asks the agent for a tool in a channel and waits for the run (with `wait` false, it only posts). */
  const ask = async (handle: string, channelId: string, tool: string, input: unknown, wait = true) => {
    const body = `@${handle} [[tool:${tool} ${JSON.stringify(input)}]]`;
    const sent = await ok(
      call(beto, "POST", `${w}/channels/${channelId}/messages`, { body, clientId: `i${++seq}` }),
      201,
    );
    if (!wait) return null;
    await settle(server);
    const [run] = await server.deps.db.select().from(runs).where(eq(runs.sourceMessageId, sent.id));
    if (!run) return null;
    const results = (
      await server.deps.db
        .select()
        .from(runEvents)
        .where(eq(runEvents.runId, run.id))
        .orderBy(asc(runEvents.seq))
    ).filter((e) => e.kind === "tool_result");
    return { result: results.map((e) => String((e.data as { content: unknown }).content)).join("\n") };
  };
  return { workspaceId, w, general, finance, ana, beto, lia, rui, ask };
}
type Team = Awaited<ReturnType<typeof team>>;

const lastDecision = async (agentId: string) => {
  const [row] = await server.deps.db
    .select()
    .from(gateDecisions)
    .where(eq(gateDecisions.agentId, agentId))
    .orderBy(desc(gateDecisions.createdAt))
    .limit(1);
  return row;
};

/** Follows the OAuth return as the person's browser (with their cookie). */
async function comeBack(who: Person, consentUrl: string) {
  const back = await mcp.authorize(toFake(consentUrl));
  return who.browser.fetch(
    `/api/v1/connectors/oauth/callback?code=${back.code}&state=${back.state}&iss=${encodeURIComponent(toLinear(back.iss ?? ""))}`,
  );
}

/** The workspace connects Linear by OAuth (the workspace's token); returns the connection. */
async function workspaceLinear(t: Team) {
  const { consentUrl } = await ok(
    call(t.ana, "POST", `${t.w}/connectors/linear/oauth/start`, { nextPath: "/" }),
  );
  await comeBack(t.ana, consentUrl);
  const [conn] = (await ok(call(t.ana, "GET", `${t.w}/connectors`))).connections;
  if (!conn) throw new Error("workspace connection missing");
  return conn;
}

const setAccess = (t: Team, agentId: string, input: unknown) =>
  ok(call(t.ana, "PUT", `${t.w}/agents/${agentId}/access`, input));
const identity = (t: Team, who: Person, agentId: string) =>
  ok(call(who, "GET", `${t.w}/agents/${agentId}/identity`));
const connectOwn = (t: Team, who: Person, agentId: string, input: unknown) =>
  call(who, "POST", `${t.w}/agents/${agentId}/identity/connections`, input);
const setChannels = (t: Team, who: Person, agentId: string, channels: unknown) =>
  call(who, "PUT", `${t.w}/agents/${agentId}/identity/channels`, { channels });

describe("the agent's own account", () => {
  test(
    "the agent acts with its account; the workspace's counts for the others; who asked is in the audit",
    async () => {
      const t = await team();
      const shared = await workspaceLinear(t);
      await setAccess(t, t.lia.id, { connectors: { [shared.id]: true } });
      await setAccess(t, t.rui.id, { connectors: { [shared.id]: true } });

      const own = await ok(
        connectOwn(t, t.ana, t.lia.id, { connector: "linear", apiKey: mcp.apiKey, nextPath: "/" }),
      );
      if (own.status !== "connected") throw new Error("expected connected");
      // The agent's account is not among the workspace's and can't be given to another agent.
      expect(
        (await ok(call(t.ana, "GET", `${t.w}/connectors`))).connections.map((c: { id: string }) => c.id),
      ).toEqual([shared.id]);
      expect((await identity(t, t.ana, t.lia.id)).connections.map((c: { id: string }) => c.id)).toEqual([
        own.connection.id,
      ]);
      expect(
        await code(
          call(t.ana, "PUT", `${t.w}/agents/${t.rui.id}/scopes`, {
            scopes: [{ connectionId: own.connection.id, scope: "connector:*" }],
          }),
        ),
      ).toBe("access.unknown_connection");
      // One account per service.
      expect(
        await status(
          connectOwn(t, t.ana, t.lia.id, { connector: "linear", apiKey: mcp.apiKey, nextPath: "/" }),
        ),
      ).toBe(409);

      const before = mcp.calls.length;
      expect((await t.ask(t.lia.handle, t.general, "linear__list_items", {}))?.result).toContain("bolt");
      const liaCall = mcp.calls.slice(before).find((c) => c.method === "tools/call");
      expect(liaCall?.auth).toBe(`Bearer ${mcp.apiKey}`);
      const liaDecision = await lastDecision(t.lia.id);
      expect(liaDecision?.credential).toEqual({
        kind: "connection",
        id: own.connection.id,
        owner: "agent",
        label: "Linear (Lia)",
      });
      expect(liaDecision?.initiatedBy).toBe(t.beto.user.id);

      const mid = mcp.calls.length;
      expect((await t.ask(t.rui.handle, t.general, "linear__list_items", {}))?.result).toContain("bolt");
      const ruiCall = mcp.calls.slice(mid).find((c) => c.method === "tools/call");
      expect(ruiCall?.auth).toMatch(/^Bearer token-/);
      expect((await lastDecision(t.rui.id))?.credential).toMatchObject({ id: shared.id, owner: "workspace" });

      // Who doesn't edit the agent doesn't touch its identity.
      expect(await status(connectOwn(t, t.beto, t.lia.id, { connector: "notion", nextPath: "/" }))).toBe(403);
      expect(await status(call(t.beto, "POST", `${t.w}/agents/${t.lia.id}/identity/revoke`))).toBe(403);

      // Revoking takes the own accounts away; Lia goes back to the workspace's (which she has by grant).
      expect(await ok(call(t.ana, "POST", `${t.w}/agents/${t.lia.id}/identity/revoke`))).toEqual({
        revoked: 1,
      });
      expect((await identity(t, t.ana, t.lia.id)).connections).toEqual([]);
      const after = mcp.calls.length;
      await t.ask(t.lia.handle, t.general, "linear__list_items", {});
      expect(mcp.calls.slice(after).find((c) => c.method === "tools/call")?.auth).toMatch(/^Bearer token-/);
      expect((await lastDecision(t.lia.id))?.credential).toMatchObject({ id: shared.id, owner: "workspace" });
    },
    SERVER_TEST_MS,
  );

  test(
    "an own account by OAuth: the return binds the connection to the agent",
    async () => {
      const t = await team();
      const started = await ok(connectOwn(t, t.ana, t.lia.id, { connector: "linear", nextPath: "/" }));
      if (started.status !== "oauth") throw new Error("expected oauth");
      // While the OAuth doesn't come back, nothing shows.
      expect((await identity(t, t.ana, t.lia.id)).connections).toEqual([]);
      await comeBack(t.ana, started.consentUrl);
      const [own] = (await identity(t, t.ana, t.lia.id)).connections;
      expect(own?.connector).toBe("linear");
      const [row] = await server.deps.db
        .select()
        .from(connections)
        .where(and(eq(connections.id, own?.id ?? "")));
      expect(row?.agentId).toBe(t.lia.id);
      // Without a workspace grant: the own account is enough for its agent, and only for it.
      expect((await t.ask(t.lia.handle, t.general, "linear__list_items", {}))?.result).toContain("bolt");
      expect((await t.ask(t.rui.handle, t.general, "linear__list_items", {}))?.result).toContain(
        "Unknown tool",
      );
    },
    SERVER_TEST_MS,
  );

  test(
    "an OAuth started before the agent is archived doesn't turn the account on when it comes back",
    async () => {
      const t = await team();
      const started = await ok(connectOwn(t, t.ana, t.lia.id, { connector: "linear", nextPath: "/" }));
      if (started.status !== "oauth") throw new Error("expected oauth");
      expect(await status(call(t.ana, "DELETE", `${t.w}/agents/${t.lia.id}`))).toBe(204);
      const res = await comeBack(t.ana, started.consentUrl);
      expect(res.headers.get("location")).toContain("connector_error=gone");
      const own = await server.deps.db.select().from(connections).where(eq(connections.agentId, t.lia.id));
      expect(own).toEqual([]);
    },
    SERVER_TEST_MS,
  );

  test(
    "an archive that lands while the code is exchanged doesn't let the account come alive",
    async () => {
      const t = await team();
      const started = await ok(connectOwn(t, t.ana, t.lia.id, { connector: "linear", nextPath: "/" }));
      if (started.status !== "oauth") throw new Error("expected oauth");
      duringToken = async () => {
        expect(await status(call(t.ana, "DELETE", `${t.w}/agents/${t.lia.id}`))).toBe(204);
      };
      await comeBack(t.ana, started.consentUrl);
      expect(duringToken === null).toBe(true);
      const own = await server.deps.db.select().from(connections).where(eq(connections.agentId, t.lia.id));
      expect(own.filter((c) => c.status === "active")).toEqual([]);
    },
    SERVER_TEST_MS,
  );

  test(
    "two connects of the same service at once leave one own account",
    async () => {
      const t = await team();
      const input = { connector: "linear", apiKey: mcp.apiKey, nextPath: "/" };
      const tries = await Promise.all(Array.from({ length: 4 }, () => connectOwn(t, t.ana, t.lia.id, input)));
      expect(tries.map((r) => r.status).sort()).toEqual([200, 409, 409, 409]);
      expect((await identity(t, t.ana, t.lia.id)).connections).toHaveLength(1);
    },
    SERVER_TEST_MS,
  );
});

describe("who edits the agent, without configuring the workspace", () => {
  test(
    "the agent's owner finishes the OAuth of its own account; revoking takes the rules on it away",
    async () => {
      const t = await team();
      // Beto is a plain member and owns Bia: he edits her identity but configures nothing of the workspace.
      const bia = await seedAgent(server, t.workspaceId, t.beto, `bia${n}`, [t.general]);
      const started = await ok(connectOwn(t, t.beto, bia.id, { connector: "linear", nextPath: "/" }));
      if (started.status !== "oauth") throw new Error("expected oauth");
      const res = await comeBack(t.beto, started.consentUrl);
      expect(res.headers.get("location")).toContain("connected=linear");
      const [own] = (await identity(t, t.beto, bia.id)).connections;
      expect(own?.connector).toBe("linear");
      // Ana's own connector round trip doesn't become Beto's.
      expect(
        await status(call(t.beto, "POST", `${t.w}/connectors/linear/oauth/start`, { nextPath: "/" })),
      ).toBe(403);

      await ok(
        setChannels(t, t.beto, bia.id, [{ channelId: t.general, connectionId: own?.id, level: "read" }]),
      );
      expect(await ok(call(t.beto, "POST", `${t.w}/agents/${bia.id}/identity/revoke`))).toEqual({
        revoked: 1,
      });
      expect(await identity(t, t.beto, bia.id)).toEqual({ connections: [], channels: [] });
      await ok(setChannels(t, t.beto, bia.id, [{ channelId: t.general, connectionId: "*", level: "read" }]));
    },
    SERVER_TEST_MS,
  );
});

describe("an own account that doesn't count yet", () => {
  test(
    "an agent's OAuth that didn't come back doesn't take the workspace's connection from it",
    async () => {
      const t = await team();
      const shared = await workspaceLinear(t);
      await setAccess(t, t.lia.id, { connectors: { [shared.id]: true } });
      expect((await t.ask(t.lia.handle, t.general, "linear__list_items", {}))?.result).toContain("bolt");
      // Who edits Lia starts connecting her account and closes the tab before coming back.
      const started = await ok(connectOwn(t, t.ana, t.lia.id, { connector: "linear", nextPath: "/" }));
      expect(started.status).toBe("oauth");
      expect((await t.ask(t.lia.handle, t.general, "linear__list_items", {}))?.result).toContain("bolt");
      expect((await lastDecision(t.lia.id))?.credential).toMatchObject({ id: shared.id, owner: "workspace" });
    },
    SERVER_TEST_MS,
  );
});

describe("permission by workspace and channel", () => {
  test(
    "the channel turns off, leaves read only or asks for approval; it never widens",
    async () => {
      const t = await team();
      const shared = await workspaceLinear(t);
      await setAccess(t, t.lia.id, { connectors: { [shared.id]: true } });

      // Finance: everything read only; Linear asks for approval (the strictest counts: read).
      // General: Linear off.
      const rules = await ok(
        setChannels(t, t.ana, t.lia.id, [
          { channelId: t.finance, connectionId: "*", level: "read" },
          { channelId: t.general, connectionId: shared.id, level: "off" },
        ]),
      );
      expect(rules.channels).toHaveLength(2);
      expect((await t.ask(t.lia.handle, t.general, "linear__list_items", {}))?.result).toContain(
        "Unknown tool",
      );
      expect((await t.ask(t.lia.handle, t.finance, "linear__list_items", {}))?.result).toContain("bolt");
      expect((await t.ask(t.lia.handle, t.finance, "linear__create_item", { name: "x" }))?.result).toContain(
        "Unknown tool",
      );

      // Approval in the channel: the write asks a person, even with write access in the workspace.
      await ok(
        setChannels(t, t.ana, t.lia.id, [
          { channelId: t.finance, connectionId: shared.id, level: "approval" },
        ]),
      );
      await t.ask(t.lia.handle, t.finance, "linear__create_item", { name: "x" }, false);
      let waiting: { id: string; tool: string; params: unknown } | undefined;
      await waitFor(async () => {
        const list = (await ok(call(t.ana, "GET", `${t.w}/approvals?status=pending`))).approvals as {
          id: string;
          tool: string;
          params: unknown;
        }[];
        waiting = list.find((a) => a.tool === "linear__create_item");
        return waiting !== undefined;
      });
      expect(waiting?.params).toMatchObject({ credentialOwner: "workspace" });
      expect(mcp.toolCalls.filter((c) => c.name === "create_item")).toEqual([]);
      await ok(call(t.ana, "POST", `${t.w}/approvals/${waiting?.id}/reject`, {}));
      await settle(server);

      // The channel rule doesn't give Rui what the workspace didn't (a new agent is born with `*`: take it away).
      await setAccess(t, t.rui.id, { all: false });
      await ok(
        setChannels(t, t.ana, t.rui.id, [
          { channelId: t.finance, connectionId: shared.id, level: "approval" },
        ]),
      );
      expect((await t.ask(t.rui.handle, t.finance, "linear__list_items", {}))?.result).toContain(
        "Unknown tool",
      );
    },
    SERVER_TEST_MS,
  );

  test(
    "the channel rule still counts when the agent gets its own account on the service",
    async () => {
      const t = await team();
      const shared = await workspaceLinear(t);
      await setAccess(t, t.lia.id, { connectors: { [shared.id]: true } });
      await ok(
        setChannels(t, t.ana, t.lia.id, [{ channelId: t.general, connectionId: shared.id, level: "off" }]),
      );
      expect((await t.ask(t.lia.handle, t.general, "linear__list_items", {}))?.result).toContain(
        "Unknown tool",
      );
      await ok(connectOwn(t, t.ana, t.lia.id, { connector: "linear", apiKey: mcp.apiKey, nextPath: "/" }));
      expect((await t.ask(t.lia.handle, t.general, "linear__list_items", {}))?.result).toContain(
        "Unknown tool",
      );
      expect((await t.ask(t.lia.handle, t.finance, "linear__list_items", {}))?.result).toContain("bolt");
      expect((await lastDecision(t.lia.id))?.credential).toMatchObject({ owner: "agent" });
    },
    SERVER_TEST_MS,
  );

  test(
    "rules are checked: another workspace's channel, an unknown connection and who may change them",
    async () => {
      const t = await team();
      const other = await seedWorkspace(server, t.ana, "Other");
      expect(
        await code(
          setChannels(t, t.ana, t.lia.id, [{ channelId: other.general, connectionId: "*", level: "off" }]),
        ),
      ).toBe("identity.unknown_channel");
      expect(
        await code(
          setChannels(t, t.ana, t.lia.id, [{ channelId: t.general, connectionId: "con_none", level: "off" }]),
        ),
      ).toBe("identity.unknown_connection");
      expect(
        await status(
          setChannels(t, t.beto, t.lia.id, [{ channelId: t.general, connectionId: "*", level: "off" }]),
        ),
      ).toBe(403);
      expect((await identity(t, t.beto, t.lia.id)).channels).toEqual([]);
    },
    SERVER_TEST_MS,
  );

  test(
    "rules saved at once by two editors: the last one wins whole, never a mix",
    async () => {
      const t = await team();
      const a = [{ channelId: t.general, connectionId: "*", level: "off" }];
      const b = [
        { channelId: t.finance, connectionId: "*", level: "read" },
        { channelId: t.general, connectionId: "*", level: "approval" },
      ];
      const saved = await Promise.all([
        setChannels(t, t.ana, t.lia.id, a),
        setChannels(t, t.ana, t.lia.id, b),
      ]);
      expect(saved.map((r) => r.status)).toEqual([200, 200]);
      const { channels } = await identity(t, t.ana, t.lia.id);
      const sorted = (list: typeof b) => [...list].sort((x, y) => x.channelId.localeCompare(y.channelId));
      expect([JSON.stringify(sorted(a)), JSON.stringify(sorted(b))]).toContain(
        JSON.stringify(sorted(channels)),
      );
    },
    SERVER_TEST_MS,
  );
});

describe("channel rules on channels hidden from the caller", () => {
  test(
    "a member sees and replaces only the rules on channels they may see; hidden ones, DMs and unknown ids answer alike",
    async () => {
      const t = await team();
      const carlos = await memberOf(server, t.workspaceId, "Carlos", email("carlos"));
      const board = await seedChannel(server, t.workspaceId, {
        name: "board",
        visibility: "private",
        members: [t.ana],
      });
      const dm = await seedDm(server, t.workspaceId, t.ana, carlos);
      // Beto, a plain member, owns Bia; Ana placed her in #board, which Beto isn't in, and turned it off there.
      const bia = await seedAgent(server, t.workspaceId, t.beto, `bia${n}`, [t.general, board]);
      const general = { channelId: t.general, connectionId: "*", level: "read" };
      const boardOff = { channelId: board, connectionId: "*", level: "off" };
      await ok(setChannels(t, t.ana, bia.id, [general, boardOff]));

      // Reading: Beto doesn't see the rule on #board; Ana does.
      expect((await identity(t, t.beto, bia.id)).channels).toEqual([general]);
      expect((await identity(t, t.ana, bia.id)).channels).toHaveLength(2);

      // Writing: Beto's save replaces what he sees and leaves Ana's rule on #board as it was.
      const approval = { ...general, level: "approval" };
      expect((await ok(setChannels(t, t.beto, bia.id, [approval]))).channels).toEqual([approval]);
      const kept = (await identity(t, t.ana, bia.id)).channels as (typeof general)[];
      expect(kept.sort((x, y) => x.channelId.localeCompare(y.channelId))).toEqual(
        [approval, boardOff].sort((x, y) => x.channelId.localeCompare(y.channelId)),
      );
      expect((await ok(setChannels(t, t.beto, bia.id, []))).channels).toEqual([]);
      expect((await identity(t, t.ana, bia.id)).channels).toEqual([boardOff]);

      // A channel hidden from Beto, a DM and an id that doesn't exist answer the same.
      const answer = async (who: Person, channelId: string) => {
        const r = await setChannels(t, who, bia.id, [{ channelId, connectionId: "*", level: "read" }]);
        return [r.status, r.body?.error?.code];
      };
      const unknown = await answer(t.beto, "ch_none");
      expect(unknown).toEqual([400, "identity.unknown_channel"]);
      expect(await answer(t.beto, board)).toEqual(unknown);
      expect(await answer(t.beto, dm)).toEqual(unknown);
      // Whoever manages agents sees every channel, but a DM is never a channel rule.
      expect(await answer(t.ana, dm)).toEqual(unknown);
      expect((await ok(setChannels(t, t.ana, bia.id, [boardOff]))).channels).toEqual([boardOff]);
      expect((await identity(t, t.ana, bia.id)).channels).toEqual([boardOff]);
    },
    SERVER_TEST_MS,
  );
});

describe("a channel the caller stops seeing while they save", () => {
  test(
    "the check runs under the agent's lock: leaving the channel just before the write turns the save away",
    async () => {
      const t = await team();
      const crew = await seedChannel(server, t.workspaceId, {
        name: "crew",
        visibility: "private",
        members: [t.beto],
      });
      const bia = await seedAgent(server, t.workspaceId, t.beto, `bia${n}`, [t.general, crew]);
      const { deps } = server;
      const real = deps.db;
      let leave = true;
      // Beto leaves #crew right as his save opens its transaction.
      deps.db = new Proxy(real, {
        get(target, prop) {
          if (prop === "transaction")
            return async (...args: Parameters<typeof real.transaction>) => {
              if (leave) {
                leave = false;
                await real
                  .delete(schema.channelMemberships)
                  .where(
                    and(
                      eq(schema.channelMemberships.channelId, crew),
                      eq(schema.channelMemberships.memberId, t.beto.user.id),
                    ),
                  );
              }
              return target.transaction(...args);
            };
          const value = Reflect.get(target, prop, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      try {
        const res = setChannels(t, t.beto, bia.id, [{ channelId: crew, connectionId: "*", level: "read" }]);
        expect([(await res).status, (await res).body?.error?.code]).toEqual([
          400,
          "identity.unknown_channel",
        ]);
      } finally {
        deps.db = real;
      }
      expect((await identity(t, t.ana, bia.id)).channels).toEqual([]);
    },
    SERVER_TEST_MS,
  );
});

test(
  "leaving the channel between the check and the read of what to replace answers like a hidden channel, not a 500",
  async () => {
    const t = await team();
    const crew = await seedChannel(server, t.workspaceId, {
      name: "crew2",
      visibility: "private",
      members: [t.beto],
    });
    const bia = await seedAgent(server, t.workspaceId, t.beto, `bia${n}`, [t.general, crew]);
    const rule = { channelId: crew, connectionId: "*", level: "read" };
    await ok(setChannels(t, t.beto, bia.id, [rule]));
    const { deps } = server;
    const real = deps.db;
    let leave = true;
    // Inside Beto's save, right after the check of the channels passed, he leaves #crew2.
    deps.db = new Proxy(real, {
      get(target, prop) {
        if (prop !== "transaction") {
          const value = Reflect.get(target, prop, target);
          return typeof value === "function" ? value.bind(target) : value;
        }
        return (fn: (tx: typeof real) => Promise<unknown>) =>
          target.transaction((tx) =>
            fn(
              new Proxy(tx, {
                get(txTarget, txProp) {
                  const value = Reflect.get(txTarget, txProp, txTarget);
                  if (txProp !== "select") return typeof value === "function" ? value.bind(txTarget) : value;
                  return (...args: unknown[]) =>
                    wrapQuery(value.apply(txTarget, args), async (query: { toSQL(): { sql: string } }) => {
                      const sql = query.toSQL().sql;
                      if (!leave || !sql.includes('from "channels"')) return;
                      leave = false;
                      await txTarget
                        .delete(schema.channelMemberships)
                        .where(
                          and(
                            eq(schema.channelMemberships.channelId, crew),
                            eq(schema.channelMemberships.memberId, t.beto.user.id),
                          ),
                        );
                    });
                },
              }) as typeof real,
            ),
          );
      },
    });
    let res: Called;
    try {
      res = await setChannels(t, t.beto, bia.id, [{ ...rule, level: "approval" }]);
    } finally {
      deps.db = real;
    }
    expect(leave).toBe(false);
    expect([res.status, res.body?.error?.code]).toEqual([400, "identity.unknown_channel"]);
    expect((await identity(t, t.ana, bia.id)).channels).toEqual([rule]);
  },
  SERVER_TEST_MS,
);
