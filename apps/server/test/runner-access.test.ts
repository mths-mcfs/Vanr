// The access boundary of the runners, over raw HTTP and the two WebSockets: pairing codes (deadline, single use,
// who may pair or deny), the credential kept as a hash, revocation that drops the live connection, a runner seen or
// lent across people and workspaces, frames a runner gets wrong, the requests to a person and their notices, two
// decisions at once, the live view of the agent's browser and the browser's real-time socket. The workspace is
// created with members.createWorkspace and agents are rows in the database (their routes come with S4 and S5).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { schema } from "@vanr/engine/db";
import { newId } from "@vanr/engine/ids";
import { and, eq, inArray } from "drizzle-orm";
import { createWorkspace, joinWorkspace } from "../src/members";
import { publishIntervention, publishSecret } from "../src/runners/requests";
import type { RunningServer } from "../src/server";
import { type Browser, body, SERVER_TEST_MS, signedIn, startTestServer, TestSocket } from "./harness";
import { connectProtocolRunner, mintSession, type ProtocolRunner } from "./protocol-runner";

let server: RunningServer;
/** The server's clock runs ahead of the wall clock by this much (the pairing deadline is read from it). */
let ahead = 0;
const open: ProtocolRunner[] = [];
beforeAll(async () => {
  server = await startTestServer({ now: () => new Date(Date.now() + ahead) });
}, SERVER_TEST_MS);
afterAll(async () => {
  for (const r of open) await r.close();
  await server.stop();
}, SERVER_TEST_MS);

let n = 0;
const email = (who: string) => `${who}${++n}@access.test`;

async function api(b: Browser, method: string, path: string, payload?: unknown) {
  const res = await b.json(path, method, payload);
  const text = await res.text();
  // biome-ignore lint/suspicious/noExplicitAny: in tests the body is checked by the assertions
  const body: any = text ? JSON.parse(text) : null;
  return { status: res.status, body };
}

async function post(path: string, payload: unknown) {
  const res = await fetch(`${server.url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  // biome-ignore lint/suspicious/noExplicitAny: in tests the body is checked by the assertions
  const body: any = await res.json();
  return { status: res.status, body };
}

/** Ana owns the workspace; Beto is a member; Lia is Ana's agent, which only Ana may talk to. */
async function team() {
  const ana = await signedIn(server, "Ana", email("ana"));
  const { workspaceId, defaultChannelId } = await createWorkspace(server.deps.db, {
    name: "Access",
    context: "",
    user: ana.user,
  });
  const beto = await signedIn(server, "Beto", email("beto"));
  await joinWorkspace(server.deps.db, { workspaceId, userId: beto.user.id, name: "Beto", role: "member" });
  const t = { workspaceId, general: defaultChannelId, ana, beto, ws: `/api/v1/workspaces/${workspaceId}` };
  const lia = await agent(t, ana.user.id, "lia", "owner");
  return { ...t, lia };
}
type Team = Awaited<ReturnType<typeof team>>;

async function agent(
  t: { workspaceId: string },
  ownerUserId: string,
  handle: string,
  visibilityMode: "everyone" | "owner" = "everyone",
) {
  const id = newId("agt");
  await server.deps.db.insert(schema.agents).values({
    id,
    workspaceId: t.workspaceId,
    name: handle,
    handle,
    model: "claude-haiku-5-5",
    ownerUserId,
    visibilityMode,
    appearance: { color: "blue", eyes: "dot", adornment: "none" },
  });
  return { id, handle };
}

const startPairing = () =>
  post("/api/v1/runner-pairings", {
    name: "Box",
    os: "linux",
    arch: "x64",
    hostname: "box",
    version: "0.2.0",
  });

/** Pairs a runner over HTTP, confirmed by `who`; returns its credential. */
async function pairOverHttp(t: Pick<Team, "ws">, who: { browser: Browser }) {
  const start = await startPairing();
  expect(
    (await api(who.browser, "POST", `${t.ws}/runner-pairings/${start.body.userCode}/confirm`, {})).status,
  ).toBe(200);
  const token = await post("/api/v1/runner-pairings/token", { deviceCode: start.body.deviceCode });
  expect(token.status).toBe(200);
  return { runnerId: token.body.runnerId as string, credential: token.body.token as string };
}

/** Connects a protocol runner with a fresh session; keeps the rotated credential. */
async function online(
  paired: { credential: string },
  opts: Parameters<typeof connectProtocolRunner>[2] = {},
) {
  const minted = await mintSession(server.url, paired.credential);
  expect(minted.status).toBe(200);
  paired.credential = minted.body.credential;
  const runner = await connectProtocolRunner(server.url, minted.body.session, opts);
  open.push(runner);
  return runner;
}

const lend = async (agentId: string, runnerId: string) =>
  server.deps.db.update(schema.agents).set({ environmentId: runnerId }).where(eq(schema.agents.id, agentId));

describe("pairing", () => {
  test(
    "a code expires at its deadline, a hasty poll slows down and the token is handed over once",
    async () => {
      const t = await team();
      const late = await startPairing();
      expect(late.body.userCode).toMatch(/^[A-Z2-9]{6}$/);
      expect(late.body.expiresIn).toBe(600);
      // A hasty poll: the interval grows (RFC 8628 slow_down).
      expect(
        (await post("/api/v1/runner-pairings/token", { deviceCode: late.body.deviceCode })).body.error,
      ).toBe("authorization_pending");
      expect(
        (await post("/api/v1/runner-pairings/token", { deviceCode: late.body.deviceCode })).body.error,
      ).toBe("slow_down");
      ahead += 601_000;
      try {
        const seen = await api(t.ana.browser, "GET", `/api/v1/runner-pairings/${late.body.userCode}`);
        expect(seen).toMatchObject({ status: 404, body: { error: { code: "runner.pairing_invalid" } } });
        const confirm = await api(
          t.ana.browser,
          "POST",
          `${t.ws}/runner-pairings/${late.body.userCode}/confirm`,
          {},
        );
        expect(confirm.body.error.code).toBe("runner.pairing_invalid");
        expect(
          (await post("/api/v1/runner-pairings/token", { deviceCode: late.body.deviceCode })).body.error,
        ).toBe("expired_token");
      } finally {
        ahead -= 601_000;
      }

      // Lowercase and with separators, the code still reads; confirmed once, it doesn't confirm again.
      const start = await startPairing();
      const typed = `${start.body.userCode.slice(0, 3).toLowerCase()}-${start.body.userCode.slice(3)}`;
      expect((await api(t.ana.browser, "GET", `/api/v1/runner-pairings/${typed}`)).body).toMatchObject({
        userCode: start.body.userCode,
        hostname: "box",
        reconnect: null,
      });
      expect((await api(t.ana.browser, "POST", `${t.ws}/runner-pairings/${typed}/confirm`, {})).status).toBe(
        200,
      );
      expect(
        (await api(t.ana.browser, "POST", `${t.ws}/runner-pairings/${start.body.userCode}/confirm`, {})).body
          .error.code,
      ).toBe("runner.pairing_invalid");
      const first = await post("/api/v1/runner-pairings/token", { deviceCode: start.body.deviceCode });
      expect(first.status).toBe(200);
      expect(first.body.token).toStartWith("rrt_");
      expect(first.body.runnerId).toStartWith("rnr_");
      expect(first.body.workspace).toEqual({ id: t.workspaceId, name: "Access" });
      expect(
        (await post("/api/v1/runner-pairings/token", { deviceCode: start.body.deviceCode })).body.error,
      ).toBe("expired_token");

      // The credential is kept as a hash: neither the pairing nor the runner row nor the list carries it.
      const [pairingRow] = await server.deps.db
        .select()
        .from(schema.runnerPairings)
        .where(eq(schema.runnerPairings.userCode, start.body.userCode));
      expect(pairingRow?.tokenSealed).toBeNull();
      const [runnerRow] = await server.deps.db
        .select()
        .from(schema.runners)
        .where(eq(schema.runners.id, first.body.runnerId));
      expect(JSON.stringify(runnerRow)).not.toContain(first.body.token);
      const list = JSON.stringify((await api(t.ana.browser, "GET", `${t.ws}/runners`)).body);
      expect(list).not.toContain(first.body.token);
      expect(list).not.toContain(runnerRow?.tokenHash ?? "none");
      expect(list).not.toContain("storeKey");
    },
    SERVER_TEST_MS,
  );

  test(
    "one code confirmed many times at once makes one runner",
    async () => {
      const t = await team();
      const start = await startPairing();
      const tries = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          api(
            i % 2 ? t.beto.browser : t.ana.browser,
            "POST",
            `${t.ws}/runner-pairings/${start.body.userCode}/confirm`,
            {},
          ),
        ),
      );
      expect(tries.filter((r) => r.status === 200)).toHaveLength(1);
      expect(
        tries.filter((r) => r.status === 404).every((r) => r.body.error.code === "runner.pairing_invalid"),
      ).toBe(true);
      expect((await api(t.ana.browser, "GET", `${t.ws}/runners`)).body.runners).toHaveLength(1);
      const claims = await Promise.all(
        Array.from({ length: 4 }, () =>
          post("/api/v1/runner-pairings/token", { deviceCode: start.body.deviceCode }),
        ),
      );
      expect(claims.filter((r) => r.status === 200)).toHaveLength(1);
    },
    SERVER_TEST_MS,
  );

  test(
    "only a member pairs in a workspace, and denying needs membership in some workspace",
    async () => {
      const t = await team();
      const outsider = await signedIn(server, "Olga", email("olga"));
      const start = await startPairing();
      const code = start.body.userCode;
      expect((await fetch(`${server.url}/api/v1/runner-pairings/${code}`)).status).toBe(401);
      expect(
        (await api(outsider.browser, "POST", `${t.ws}/runner-pairings/${code}/confirm`, {})).status,
      ).toBe(404);
      const denied = await api(outsider.browser, "POST", `/api/v1/runner-pairings/${code}/deny`);
      expect(denied.status).toBe(403);
      // The code is still good after both attempts.
      expect((await api(t.beto.browser, "GET", `/api/v1/runner-pairings/${code}`)).status).toBe(200);
      expect((await api(t.beto.browser, "POST", `/api/v1/runner-pairings/${code}/deny`)).status).toBe(204);
      expect(
        (await post("/api/v1/runner-pairings/token", { deviceCode: start.body.deviceCode })).body.error,
      ).toBe("access_denied");
    },
    SERVER_TEST_MS,
  );
});

describe("credentials and connections", () => {
  test(
    "revoking: only who manages it, the live connection drops and the credential stops working",
    async () => {
      const t = await team();
      const paired = await pairOverHttp(t, t.ana);
      const runner = await online(paired);
      const watch = await TestSocket.open(t.ana.browser, t.workspaceId);
      const revoke = `${t.ws}/runners/${paired.runnerId}/revoke`;
      expect((await api(t.beto.browser, "POST", revoke)).status).toBe(403);
      const revoked = await api(t.ana.browser, "POST", revoke);
      expect(revoked.status).toBe(200);
      expect(revoked.body.revokedAt).not.toBeNull();
      expect(revoked.body.revokedReason).toBe("manual");
      expect(await runner.next((f) => f.type === "rejected")).toMatchObject({ reason: "revoked" });
      expect((await runner.closed).code).toBe(1000);
      expect(server.deps.runners.isOnline(paired.runnerId)).toBe(false);
      expect((await watch.event("runner.revoked")).event).toMatchObject({
        runnerId: paired.runnerId,
        reason: "manual",
      });
      const again = await mintSession(server.url, paired.credential);
      expect(again).toMatchObject({ status: 403, body: { error: { code: "runner.revoked" } } });
      expect(runner.invalid).toEqual([]);
      watch.close();
    },
    SERVER_TEST_MS,
  );

  test(
    "a session opens one connection only, and a new connection of the same runner replaces the old",
    async () => {
      const t = await team();
      const paired = await pairOverHttp(t, t.ana);
      const minted = await mintSession(server.url, paired.credential);
      paired.credential = minted.body.credential;
      const first = await connectProtocolRunner(server.url, minted.body.session);
      open.push(first);
      await expect(connectProtocolRunner(server.url, minted.body.session)).rejects.toThrow(/invalid_token/);
      const second = await online(paired);
      expect(await first.next((f) => f.type === "rejected")).toMatchObject({ reason: "replaced" });
      expect(server.deps.runners.isOnline(second.runnerId)).toBe(true);
    },
    SERVER_TEST_MS,
  );

  test(
    "a malformed frame is rejected without dropping that runner or the others",
    async () => {
      const t = await team();
      const a = await online(await pairOverHttp(t, t.ana));
      const b = await online(await pairOverHttp(t, t.ana));
      a.send("not json");
      a.send({ type: "job.done", job: { jobId: "x" } });
      a.send({ type: "teleport", to: "mars" });
      a.send({ type: "live_view.frame", agentId: "agt_x", data: "x".repeat(3_000_001), width: 1, height: 1 });
      // Still connected and still served: a valid frame after the bad ones takes effect.
      a.send({ type: "runner.state", paused: true });
      const paused = async () =>
        (
          await server.deps.db
            .select({ p: schema.runners.paused })
            .from(schema.runners)
            .where(eq(schema.runners.id, a.runnerId))
        )[0]?.p;
      for (let i = 0; i < 200 && !(await paused()); i++) await new Promise((r) => setTimeout(r, 10));
      expect(await paused()).toBe(true);
      expect(server.deps.runners.isOnline(a.runnerId)).toBe(true);
      expect(server.deps.runners.isOnline(b.runnerId)).toBe(true);

      // Before the hello, a bad frame ends that socket only; a frame over 4 MB ends it too.
      const raw = new WebSocket(`${server.url.replace(/^http/, "ws")}/api/v1/runners/connect`);
      const rawClosed = new Promise<number>((r) => raw.addEventListener("close", (ev) => r(ev.code)));
      await new Promise((r) => raw.addEventListener("open", r, { once: true }));
      raw.send(JSON.stringify({ type: "pong", at: 1 }));
      expect(await rawClosed).toBe(4003);
      a.send(JSON.stringify({ type: "runner.state", paused: false, pad: "x".repeat(4 * 1024 * 1024) }));
      expect((await a.closed).code).toBe(1009);
      expect(server.deps.runners.isOnline(b.runnerId)).toBe(true);
      expect(b.invalid).toEqual([]);
    },
    SERVER_TEST_MS,
  );

  test(
    "a runner of one workspace is invisible from another, and a member lends only a runner they paired",
    async () => {
      const t = await team();
      const cris = await signedIn(server, "Cris", email("cris"));
      const other = await createWorkspace(server.deps.db, { name: "Other", context: "", user: cris.user });
      const otherWs = `/api/v1/workspaces/${other.workspaceId}`;
      const anas = await pairOverHttp(t, t.ana);
      const betos = await pairOverHttp(t, t.beto);
      const max = await agent(t, t.beto.user.id, "max");
      const crisAgent = await agent({ workspaceId: other.workspaceId }, cris.user.id, "zed");

      expect(
        (await api(cris.browser, "PATCH", `${otherWs}/runners/${anas.runnerId}`, { name: "x" })).body.error
          .code,
      ).toBe("runner.not_found");
      expect((await api(cris.browser, "GET", `${otherWs}/runners`)).body.runners).toEqual([]);
      expect((await api(cris.browser, "GET", `${t.ws}/runners`)).status).toBe(404);
      expect(
        (
          await api(cris.browser, "PUT", `${otherWs}/agents/${crisAgent.id}/environment/target`, {
            runnerId: anas.runnerId,
          })
        ).body.error.code,
      ).toBe("runner.not_found");

      // Beto lends his own runner to his agent, not Ana's; Ana (who manages agents) lends either.
      const target = (a: { id: string }) => `${t.ws}/agents/${a.id}/environment/target`;
      expect((await api(t.beto.browser, "PUT", target(max), { runnerId: anas.runnerId })).status).toBe(403);
      expect(
        (await api(t.beto.browser, "PUT", target(max), { runnerId: betos.runnerId })).body,
      ).toMatchObject({
        kind: "runner",
        runnerId: betos.runnerId,
      });
      expect((await api(t.beto.browser, "PUT", target(t.lia), { runnerId: betos.runnerId })).status).toBe(
        403,
      );
      expect((await api(t.ana.browser, "PUT", target(t.lia), { runnerId: betos.runnerId })).status).toBe(200);
      // Beto manages his runner (he paired it); Ana does too (she configures the workspace).
      const runners = (await api(t.beto.browser, "GET", `${t.ws}/runners`)).body.runners;
      expect(
        Object.fromEntries(runners.map((r: { id: string; manageable: boolean }) => [r.id, r.manageable])),
      ).toEqual({
        [anas.runnerId]: false,
        [betos.runnerId]: true,
      });
      expect(
        (await api(t.ana.browser, "PATCH", `${t.ws}/runners/${betos.runnerId}`, { name: "Beto's" })).status,
      ).toBe(200);
    },
    SERVER_TEST_MS,
  );
});

describe("requests to a person", () => {
  test(
    "a secret request notifies the person it is for, only they deliver it, and two deliveries at once count once",
    async () => {
      const t = await team();
      const shared = await agent(t, t.ana.user.id, "sam");
      const paired = await pairOverHttp(t, t.ana);
      const runner = await online(paired);
      await lend(shared.id, paired.runnerId);
      const id = newId("sr");
      const now = server.deps.now();
      const [row] = await server.deps.db
        .insert(schema.secretPrompts)
        .values({
          id,
          workspaceId: t.workspaceId,
          agentId: shared.id,
          runnerId: paired.runnerId,
          name: "API_TOKEN",
          purpose: "deploy",
          target: "env",
          targetUserId: t.beto.user.id,
          publicKey: "pk",
          expiresAt: new Date(now.getTime() + 30 * 60_000),
        })
        .returning();
      if (!row) throw new Error("no row");
      await publishSecret(server.deps, row, "secret_request.created");
      const notice = async () =>
        (
          await server.deps.db
            .select()
            .from(schema.notifications)
            .where(
              and(
                eq(schema.notifications.groupKey, `secret:${id}`),
                eq(schema.notifications.userId, t.beto.user.id),
              ),
            )
        )[0];
      expect(await notice()).toMatchObject({
        kind: "question_for_you",
        reason: "secret_prompt",
        waiting: true,
      });

      const box = { v: 1, epk: "e", iv: "i", ct: "c" };
      const deliver = `${t.ws}/secret-requests/${id}/deliver`;
      expect((await api(t.ana.browser, "POST", deliver, { box })).body.error.message).toBe(
        "This request is for someone else",
      );
      expect((await api(t.beto.browser, "POST", deliver, { box: { v: 2 } })).status).toBe(400);
      const both = await Promise.all([
        api(t.beto.browser, "POST", deliver, { box }),
        api(t.beto.browser, "POST", deliver, { box }),
      ]);
      expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(both.find((r) => r.status === 409)?.body.error.code).toBe("secret.closed");
      expect(both.find((r) => r.status === 200)?.body).toMatchObject({
        status: "delivered",
        deciderUserId: t.beto.user.id,
      });
      expect((await runner.request("secret.store")).args).toMatchObject({
        requestId: id,
        workspaceId: t.workspaceId,
        name: "API_TOKEN",
        target: "env",
      });
      expect(await notice()).toMatchObject({ waiting: false });
      expect(
        (await api(t.beto.browser, "GET", `${t.ws}/agents/${shared.id}/secrets`)).body.secrets,
      ).toMatchObject([{ name: "API_TOKEN", runnerId: paired.runnerId, fulfilledByUserId: t.beto.user.id }]);
      expect(
        (await api(t.beto.browser, "POST", `${t.ws}/secret-requests/${id}/decline`)).body.error.code,
      ).toBe("secret.closed");
      expect(runner.invalid).toEqual([]);
    },
    SERVER_TEST_MS,
  );

  test(
    "a browser intervention notifies its person, only they take it, and taking over at once leaves one person in control",
    async () => {
      const t = await team();
      const shared = await agent(t, t.ana.user.id, "ivy");
      const paired = await pairOverHttp(t, t.ana);
      const runner = await online(paired, { browser: true });
      await lend(shared.id, paired.runnerId);
      const id = newId("bi");
      const now = server.deps.now();
      const [row] = await server.deps.db
        .insert(schema.browserInterventions)
        .values({
          id,
          workspaceId: t.workspaceId,
          agentId: shared.id,
          runnerId: paired.runnerId,
          kind: "login",
          instructions: "Sign in to the bank",
          targetUserId: t.beto.user.id,
          expiresAt: new Date(now.getTime() + 15 * 60_000),
        })
        .returning();
      if (!row) throw new Error("no row");
      await publishIntervention(server.deps, row);
      const notice = async () =>
        (
          await server.deps.db
            .select()
            .from(schema.notifications)
            .where(eq(schema.notifications.groupKey, `intervention:${id}`))
        )[0];
      expect(await notice()).toMatchObject({
        kind: "browser_intervention",
        waiting: true,
        userId: t.beto.user.id,
      });

      const base = `${t.ws}/browser-interventions/${id}`;
      expect((await api(t.ana.browser, "POST", `${base}/control`)).status).toBe(403);
      expect((await api(t.ana.browser, "POST", `${base}/complete`)).status).toBe(403);
      expect((await api(t.beto.browser, "POST", `${base}/control`)).body).toMatchObject({
        status: "active",
        controllingUserId: t.beto.user.id,
      });
      expect(await notice()).toMatchObject({ waiting: false });
      const driven = await runner.next(
        (f) =>
          f.type === "request" &&
          f.op === "browser.policy" &&
          JSON.stringify(f.args).includes('"driver":"person"'),
      );
      expect(driven).toMatchObject({ args: { policy: { driver: "person" } } });
      expect((await api(t.beto.browser, "POST", `${base}/complete`)).body).toMatchObject({ status: "done" });
      expect((await api(t.beto.browser, "POST", `${base}/fail`, {})).body.error.code).toBe(
        "browser.intervention_closed",
      );

      // Nobody holds the browser now: two people taking over several times at once open one intervention.
      const takeOver = `${t.ws}/agents/${shared.id}/browser/interventions/takeover`;
      const tries = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          api(i % 2 ? t.beto.browser : t.ana.browser, "POST", takeOver, {}),
        ),
      );
      const won = tries.filter((r) => r.status === 200);
      expect(new Set(won.map((r) => r.body.id)).size).toBe(1);
      const holder = won[0]?.body.controllingUserId;
      for (const [i, r] of tries.entries()) {
        const who = i % 2 ? t.beto.user.id : t.ana.user.id;
        if (who === holder) expect(r.status).toBe(200);
        else expect(r.body.error.code).toBe("browser.in_control");
      }
      const openRows = await server.deps.db
        .select()
        .from(schema.browserInterventions)
        .where(
          and(
            eq(schema.browserInterventions.agentId, shared.id),
            inArray(schema.browserInterventions.status, ["pending", "active"]),
          ),
        );
      expect(openRows).toHaveLength(1);
      expect(runner.invalid).toEqual([]);
    },
    SERVER_TEST_MS,
  );
});

describe("live view", () => {
  test(
    "only who can talk to the agent watches, frames reach the watchers only, and the last to leave stops the stream",
    async () => {
      const t = await team();
      const paired = await pairOverHttp(t, t.ana);
      const runner = await online(paired, { browser: true });
      await lend(t.lia.id, paired.runnerId);
      const ana = await TestSocket.open(t.ana.browser, t.workspaceId);
      const beto = await TestSocket.open(t.beto.browser, t.workspaceId);

      // Lia talks only to Ana (her owner): Beto's watch is rejected and starts nothing.
      beto.send({ type: "live_view.subscribe", agentId: t.lia.id });
      expect(await beto.next((f) => f.type === "live_view.unavailable")).toMatchObject({
        reason: "forbidden",
      });

      ana.send({ type: "live_view.subscribe", agentId: t.lia.id });
      expect(await ana.next((f) => f.type === "live_view.status")).toMatchObject({
        mode: "watch",
        intervention: null,
      });
      expect((await runner.request("live_view.start")).args).toMatchObject({
        fps: 1,
        policy: { driver: "agent" },
      });

      runner.send({ type: "live_view.frame", agentId: t.lia.id, data: "AAAA", width: 800, height: 600 });
      expect(await ana.next((f) => f.type === "live_view.frame")).toMatchObject({
        seq: 1,
        data: "AAAA",
        metadata: { deviceWidth: 800, deviceHeight: 600, url: null },
      });
      // A frame for Lia from another runner doesn't reach the stream.
      const intruder = await online(await pairOverHttp(t, t.ana), { browser: true });
      intruder.send({ type: "live_view.frame", agentId: t.lia.id, data: "EVIL", width: 1, height: 1 });
      runner.send({ type: "live_view.frame", agentId: t.lia.id, data: "BBBB", width: 800, height: 600 });
      expect(await ana.next((f) => f.type === "live_view.frame")).toMatchObject({ seq: 2, data: "BBBB" });
      expect(beto.frames.some((f) => f.type === "live_view.frame")).toBe(false);

      // Input only from who has the control, at most 100 events, frames up to 64 KB.
      ana.send({ type: "live_view.input", agentId: t.lia.id, events: [{ type: "click", x: 1, y: 1 }] });
      expect(await ana.next((f) => f.type === "error")).toMatchObject({ code: "not_in_control" });
      ana.send({
        type: "live_view.input",
        agentId: t.lia.id,
        events: Array.from({ length: 101 }, () => ({})),
      });
      expect(await ana.next((f) => f.type === "error")).toMatchObject({ code: "invalid_frame" });
      ana.send({ type: "ping", pad: "x".repeat(64 * 1024) });
      expect(await ana.next((f) => f.type === "error")).toMatchObject({ code: "frame_too_large" });
      const took = await api(
        t.ana.browser,
        "POST",
        `${t.ws}/agents/${t.lia.id}/browser/interventions/takeover`,
        {},
      );
      expect(took.body).toMatchObject({
        status: "active",
        kind: "intervention",
        controllingUserId: t.ana.user.id,
      });
      expect(await ana.next((f) => f.type === "live_view.status" && f.mode === "control")).toBeTruthy();
      expect((await runner.request("live_view.start")).args).toMatchObject({
        fps: 15,
        policy: { driver: "person" },
      });
      ana.send({ type: "live_view.input", agentId: t.lia.id, events: [{ type: "click", x: 2, y: 3 }] });
      expect((await runner.request("live_view.input")).args).toEqual({
        events: [{ type: "click", x: 2, y: 3 }],
      });

      // The last watcher leaves: after a short grace the runner is told to stop streaming.
      ana.send({ type: "live_view.unsubscribe", agentId: t.lia.id });
      expect(await runner.request("live_view.stop")).toMatchObject({ op: "live_view.stop" });
      expect(runner.invalid).toEqual([]);
      expect(intruder.invalid).toEqual([]);
      ana.close();
      beto.close();
    },
    SERVER_TEST_MS,
  );
});

describe("the browser's real-time socket", () => {
  test(
    "the upgrade checks the origin, the session and the membership; a private channel needs its members",
    async () => {
      const t = await team();
      const url = `${server.url}/api/v1/realtime?workspaceId=${t.workspaceId}`;
      const cookie = [...t.ana.browser.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
      expect((await fetch(url, { headers: { cookie, origin: "https://evil.example" } })).status).toBe(403);
      expect((await fetch(url, { headers: { origin: server.url } })).status).toBe(401);
      expect(
        (await fetch(`${server.url}/api/v1/realtime`, { headers: { cookie, origin: server.url } })).status,
      ).toBe(400);
      const outsider = await signedIn(server, "Olga", email("olga"));
      const theirs = [...outsider.browser.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
      expect((await fetch(url, { headers: { cookie: theirs, origin: server.url } })).status).toBe(404);
      expect((await fetch(url, { headers: { cookie, origin: server.url } })).status).toBe(426);

      const secretId = newId("ch");
      await server.deps.db.insert(schema.channels).values({
        id: secretId,
        workspaceId: t.workspaceId,
        name: "board",
        topic: "",
        visibility: "private",
        createdBy: t.ana.user.id,
      });
      await server.deps.db
        .insert(schema.channelMemberships)
        .values({ channelId: secretId, memberType: "person", memberId: t.ana.user.id });
      const ana = await TestSocket.open(t.ana.browser, t.workspaceId);
      const beto = await TestSocket.open(t.beto.browser, t.workspaceId);
      expect(await beto.subscribe(secretId)).toMatchObject({ type: "error", code: "forbidden" });
      expect(await ana.subscribe(secretId)).toMatchObject({ type: "subscribed" });
      expect(await beto.subscribe(t.general)).toMatchObject({ type: "subscribed" });
      server.deps.hub.toChannel(secretId, { type: "message.posted", text: "board only" });
      expect((await ana.event("message.posted")).event).toMatchObject({ text: "board only" });
      // Typing is shown to the others in the channel, at most once every 2 s per person.
      ana.send({ type: "typing", channelId: secretId });
      beto.send({ type: "typing", channelId: t.general });
      beto.send({ type: "typing", channelId: t.general });
      ana.send({ type: "subscribe", channelId: t.general });
      expect((await ana.event("person.typing")).event).toMatchObject({ userId: t.beto.user.id, ttlMs: 6000 });
      ana.send({ type: "ping" });
      await ana.next((f) => f.type === "pong");
      expect(ana.frames.filter((f) => f.type === "event")).toEqual([]);
      expect(beto.frames.some((f) => f.type === "event")).toBe(false);
      ana.send({ type: "nope" });
      expect(await ana.next((f) => f.type === "error")).toMatchObject({ code: "invalid_frame" });
      ana.close();
      beto.close();
    },
    SERVER_TEST_MS,
  );
});

describe("stopping the server", () => {
  test(
    "closes the runners' and the browsers' connections",
    async () => {
      const local = await startTestServer();
      let stopped = false;
      try {
        const ana = await signedIn(local, "Ana", email("ana"));
        const { workspaceId } = await createWorkspace(local.deps.db, {
          name: "Stop",
          context: "",
          user: ana.user,
        });
        const start = await fetch(`${local.url}/api/v1/runner-pairings`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ os: "linux", arch: "x64", hostname: "box", version: "0.2.0" }),
        }).then(body);
        await ana.browser.json(
          `/api/v1/workspaces/${workspaceId}/runner-pairings/${start.userCode}/confirm`,
          "POST",
          {},
        );
        const token = await fetch(`${local.url}/api/v1/runner-pairings/token`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ deviceCode: start.deviceCode }),
        }).then(body);
        const minted = await mintSession(local.url, token.token);
        const runner = await connectProtocolRunner(local.url, minted.body.session, { browser: true });
        const socket = await TestSocket.open(ana.browser, workspaceId);
        await local.stop();
        stopped = true;
        expect((await runner.closed).code).toBe(1001);
        await socket.closed;
        expect(local.deps.runners.isOnline(runner.runnerId)).toBe(false);
      } finally {
        if (!stopped) await local.stop();
      }
    },
    // It boots and stops a server of its own besides the file's one.
    2 * SERVER_TEST_MS,
  );
});
