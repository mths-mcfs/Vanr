// The access boundary of the runners, over raw HTTP and the two WebSockets: pairing codes (deadline, single use,
// who may pair or deny), the credential kept as a hash, revocation that drops the live connection, a runner seen or
// lent across people and workspaces, frames a runner gets wrong, the requests to a person and their notices, two
// decisions at once, the live view of the agent's browser and the browser's real-time socket. The workspace is
// created with members.createWorkspace and agents are rows in the database (their routes come with S4 and S5).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { schema } from "@vanr/engine/db";
import { newId } from "@vanr/engine/ids";
import { and, eq, inArray } from "drizzle-orm";
import { log } from "../src/logger";
import { createWorkspace, joinWorkspace } from "../src/members";
import { revalidateBrowsers } from "../src/realtime/browser-socket";
import { publishIntervention, publishSecret } from "../src/runners/requests";
import type { RunningServer } from "../src/server";
import { Browser, body, SERVER_TEST_MS, signedIn, startTestServer, TestSocket } from "./harness";
import { wrapQuery } from "./lock-double";
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

describe("a frame naming another runner's id", () => {
  test(
    "a result, output, harness frame, job event, job end or live view frame from another runner changes nothing",
    async () => {
      const t = await team();
      const cris = await signedIn(server, "Cris", email("cris"));
      const other = await createWorkspace(server.deps.db, {
        name: "Elsewhere",
        context: "",
        user: cris.user,
      });
      // A answers `exec` and `harness.turn` only when the test sends the result; B is in the same workspace, C
      // in another.
      const a = await online(await pairOverHttp(t, t.ana), {
        browser: true,
        answer: (req) =>
          req.op === "exec" || req.op === "harness.turn" ? new Promise(() => {}) : { ok: true, data: {} },
      });
      const b = await online(await pairOverHttp(t, t.beto));
      const c = await online(await pairOverHttp({ ws: `/api/v1/workspaces/${other.workspaceId}` }, cris));
      for (const intruder of [b, c]) {
        // A request to A: output and result from the intruder don't count; A's answer does.
        const chunks: string[] = [];
        const call = server.deps.runners.call(
          a.runnerId,
          "exec",
          { command: "ls" },
          {
            onOutput: (_s, chunk) => chunks.push(chunk),
            timeoutMs: 10_000,
          },
        );
        const req = await a.request("exec");
        intruder.send({ type: "output", id: req.id, stream: "stdout", chunk: "forged" });
        intruder.send({ type: "result", id: req.id, ok: true, data: { forged: true } });
        intruder.send({
          type: "result",
          id: req.id,
          ok: false,
          error: { code: "internal", message: "forged" },
        });
        a.send({ type: "output", id: req.id, stream: "stdout", chunk: "real" });
        a.send({ type: "result", id: req.id, ok: true, data: { mine: true } });
        expect(await call).toEqual({ mine: true });
        expect(chunks).toEqual(["real"]);

        // A harness turn on A: the intruder's tool call gets "this turn is over", its event is dropped.
        const events: unknown[] = [];
        const tools: string[] = [];
        const turn = server.deps.runners.call(
          a.runnerId,
          "harness.turn",
          { runId: "run_12345678", executor: "claude_code", system: "", prompt: "hi", tools: [] },
          {
            onHarnessEvent: (e) => events.push(e),
            onHarnessTool: async (name) => {
              tools.push(name);
              return { content: "ok", isError: false };
            },
            timeoutMs: 10_000,
          },
        );
        const turnReq = await a.request("harness.turn");
        intruder.send({ type: "harness.event", id: turnReq.id, event: { kind: "text", text: "forged" } });
        intruder.send({ type: "harness.tool", id: turnReq.id, callId: "x", name: "read", input: {} });
        expect(await intruder.next((f) => f.type === "harness.tool_result")).toMatchObject({
          content: "This turn is over",
          isError: true,
        });
        a.send({ type: "harness.event", id: turnReq.id, event: { kind: "text", text: "real" } });
        a.send({ type: "result", id: turnReq.id, ok: true, data: { text: "done" } });
        await turn;
        expect(events).toEqual([{ kind: "text", text: "real" }]);
        expect(tools).toEqual([]);
      }

      // A job of A: the intruders' events and end don't touch it.
      const jobId = newId("job");
      await server.deps.db.insert(schema.runnerJobs).values({
        id: jobId,
        workspaceId: t.workspaceId,
        runnerId: a.runnerId,
        agentId: t.lia.id,
        title: "Build",
        executor: "shell",
        prompt: "make",
        status: "running",
      });
      const snapshot = {
        jobId,
        status: "done",
        exitCode: 0,
        result: "forged",
        session: null,
        files: [],
        denied: [],
        blocked: [],
        startedAt: null,
        endedAt: null,
      };
      for (const intruder of [b, c]) {
        intruder.send({ type: "job.event", jobId, kind: "line", line: "forged" });
        intruder.send({ type: "job.done", job: snapshot });
        await intruder.next((f) => f.type === "job.ack");
      }
      const [job] = await server.deps.db
        .select()
        .from(schema.runnerJobs)
        .where(eq(schema.runnerJobs.id, jobId));
      expect(job).toMatchObject({ status: "running", tailLine: null, result: null, outputTail: [] });

      // A's live view of Lia: frames and the end from the intruders don't reach the watcher.
      await lend(t.lia.id, a.runnerId);
      const ana = await TestSocket.open(t.ana.browser, t.workspaceId);
      ana.send({ type: "live_view.subscribe", agentId: t.lia.id });
      await a.request("live_view.start");
      for (const intruder of [b, c]) {
        intruder.send({ type: "live_view.frame", agentId: t.lia.id, data: "EVIL", width: 1, height: 1 });
        intruder.send({ type: "live_view.stream_ended", agentId: t.lia.id, reason: "closed" });
      }
      a.send({ type: "live_view.frame", agentId: t.lia.id, data: "REAL", width: 2, height: 2 });
      expect(await ana.next((f) => f.type === "live_view.frame")).toMatchObject({ seq: 1, data: "REAL" });
      expect(ana.frames.some((f) => f.type === "live_view.ended")).toBe(false);
      ana.close();
      for (const r of [a, b, c]) expect(r.invalid).toEqual([]);
    },
    SERVER_TEST_MS,
  );
});

describe("who may call each runner route", () => {
  test(
    "a member who neither paired the runner nor edits the agent is turned away on every managing route",
    async () => {
      const t = await team();
      const paired = await pairOverHttp(t, t.ana);
      const runner = await online(paired, { browser: true });
      await lend(t.lia.id, paired.runnerId);
      const lia = `${t.ws}/agents/${t.lia.id}`;
      const net = newId("nr");
      await server.deps.db
        .insert(schema.networkRequests)
        .values({ id: net, workspaceId: t.workspaceId, agentId: t.lia.id, domain: "example.com" });
      const entry = newId("bs");
      await server.deps.db.insert(schema.browserLogEntries).values({
        id: entry,
        workspaceId: t.workspaceId,
        agentId: t.lia.id,
        runnerId: paired.runnerId,
        tool: "browser_navigate",
        action: {},
        outcome: "ok",
        at: server.deps.now(),
      });
      await server.deps.db.insert(schema.runnerSecrets).values({
        agentId: t.lia.id,
        runnerId: paired.runnerId,
        name: "API_TOKEN",
        workspaceId: t.workspaceId,
        target: "env",
      });
      const intervention = newId("bi");
      await server.deps.db.insert(schema.browserInterventions).values({
        id: intervention,
        workspaceId: t.workspaceId,
        agentId: t.lia.id,
        runnerId: paired.runnerId,
        kind: "login",
        targetUserId: t.ana.user.id,
        expiresAt: new Date(server.deps.now().getTime() + 60_000),
      });
      const runnerPath = `${t.ws}/runners/${paired.runnerId}`;
      // Each route with who may call it in the origin: the runner's manager (who paired it or configures the
      // workspace), who manages agents, who configures, the agent's editor (owner or agent manager), who may
      // talk to the agent.
      const forbiddenCalls: [string, string, unknown?][] = [
        ["DELETE", runnerPath],
        ["POST", `${runnerPath}/access/reduce`, { disableTool: "commands" }],
        ["POST", `${runnerPath}/move-agents`, { toRunnerId: paired.runnerId }],
        ["POST", `${lia}/environment/start`],
        ["POST", `${lia}/environment/stop`],
        ["DELETE", `${lia}/environment`],
        ["POST", `${t.ws}/network-requests/${net}/allow`],
        ["POST", `${t.ws}/network-requests/${net}/deny`],
        ["DELETE", `${t.ws}/network-requests/${net}`],
        ["PUT", `${t.ws}/sandbox-settings`, { minutesPerDay: 10 }],
        ["DELETE", `${lia}/secrets/API_TOKEN?runnerId=${paired.runnerId}`],
        ["PUT", `${lia}/browser`, { permittedDomains: ["example.com"] }],
        ["PUT", `${lia}/browser/policy`, { level: "balanced", sites: [] }],
        ["GET", `${lia}/browser/log`],
        ["GET", `${lia}/browser/log/${entry}/shot`],
        ["POST", `${lia}/browser/stop`],
        ["POST", `${lia}/browser/interventions/start`, {}],
      ];
      for (const [method, path, payload] of forbiddenCalls) {
        const res = await api(t.beto.browser, method, path, payload);
        expect({ method, path, status: res.status }).toEqual({ method, path, status: 403 });
      }
      // On an agent everyone talks to, Beto still can't cancel an intervention meant for Ana and not his.
      const open = await agent(t, t.ana.user.id, "opal");
      const meant = newId("bi");
      await server.deps.db.insert(schema.browserInterventions).values({
        id: meant,
        workspaceId: t.workspaceId,
        agentId: open.id,
        runnerId: paired.runnerId,
        kind: "login",
        targetUserId: t.ana.user.id,
        expiresAt: new Date(server.deps.now().getTime() + 60_000),
      });
      expect(
        (await api(t.beto.browser, "POST", `${t.ws}/browser-interventions/${meant}/cancel`)).status,
      ).toBe(403);
      expect(
        (await api(t.beto.browser, "POST", `${t.ws}/browser-interventions/${meant}/fail`, {})).status,
      ).toBe(403);
      expect(
        (await api(t.beto.browser, "POST", `${t.ws}/browser-interventions/${meant}/complete`)).status,
      ).toBe(403);
      // Someone outside the workspace gets 404 on every workspace route, reads included.
      const outsider = await signedIn(server, "Olga", email("olga"));
      const workspaceRoutes: [string, string, unknown?][] = [
        ["GET", `${t.ws}/runners`],
        ["GET", `${t.ws}/runners/outages`],
        ["PATCH", runnerPath, { name: "x" }],
        ["POST", `${runnerPath}/revoke`],
        ["POST", `${t.ws}/runner-pairings/ABCDEF/confirm`, {}],
        ["GET", `${lia}/environment`],
        ["PUT", `${lia}/environment/target`, { runnerId: null }],
        ["GET", `${lia}/environment/domains`],
        ["GET", `${t.ws}/sandbox-settings`],
        ["POST", `${t.ws}/secret-requests/sr_x/deliver`, { box: { v: 1, epk: "e", iv: "i", ct: "c" } }],
        ["POST", `${t.ws}/secret-requests/sr_x/decline`],
        ["GET", `${lia}/secrets`],
        ["GET", `${lia}/browser`],
        ["GET", `${lia}/browser/interventions`],
        ["GET", `${t.ws}/browser-interventions/${meant}`],
        ["POST", `${t.ws}/browser-interventions/${meant}/control`],
        ["POST", `${t.ws}/browser-interventions/${meant}/cancel`],
        ["POST", `${lia}/browser/interventions/start`, {}],
        ...forbiddenCalls,
      ];
      for (const [method, path, payload] of workspaceRoutes) {
        const res = await api(outsider.browser, method, path, payload);
        expect({ method, path, status: res.status }).toEqual({ method, path, status: 404 });
      }
      // The intervention is Ana's and Lia talks only to Ana: for Beto it doesn't exist.
      expect(
        (await api(t.beto.browser, "POST", `${t.ws}/browser-interventions/${intervention}/cancel`)).status,
      ).toBe(404);
      expect(
        (await api(t.beto.browser, "POST", `${t.ws}/browser-interventions/${intervention}/control`)).status,
      ).toBe(404);
      // Nothing changed for the forbidden calls.
      expect((await api(t.ana.browser, "GET", `${t.ws}/runners`)).body.runners).toHaveLength(1);
      expect((await api(t.ana.browser, "GET", `${lia}/secrets`)).body.secrets).toHaveLength(1);
      expect((await api(t.ana.browser, "GET", `${t.ws}/sandbox-settings`)).body.minutesPerDay).toBe(120);
      expect(
        (
          await server.deps.db.select().from(schema.networkRequests).where(eq(schema.networkRequests.id, net))
        )[0]?.status,
      ).toBe("pending");
      // And the ones who may: Ana (owner) cancels, reads the log, sets the sandbox.
      expect((await api(t.ana.browser, "GET", `${lia}/browser/log`)).body.steps).toHaveLength(1);
      expect(
        (await api(t.ana.browser, "PUT", `${t.ws}/sandbox-settings`, { minutesPerDay: 10 })).status,
      ).toBe(200);
      expect(
        (await api(t.ana.browser, "POST", `${t.ws}/browser-interventions/${intervention}/cancel`)).body
          .status,
      ).toBe("canceled");
      expect(runner.invalid).toEqual([]);
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
      const takeOver = `${t.ws}/agents/${shared.id}/browser/interventions/start`;
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

describe("a secret delivered against a decline", () => {
  /** A runner whose `secret.store` answers wait for the test (or answer at once, with `auto`). */
  async function holdingRunner(t: Team, auto?: { ok: false; code: string }) {
    const held: {
      ct: string;
      answer: (
        a: { ok: true; data: unknown } | { ok: false; error: { code: string; message: string } },
      ) => void;
    }[] = [];
    const paired = await pairOverHttp(t, t.ana);
    const runner = await online(paired, {
      answer: (req) => {
        if (req.op !== "secret.store") return { ok: true, data: {} };
        const ct = String((req.args.box as { ct?: unknown } | undefined)?.ct);
        if (auto) {
          held.push({ ct, answer: () => {} });
          return { ok: false, error: { code: auto.code, message: "no" } };
        }
        return new Promise((resolve) => held.push({ ct, answer: resolve }));
      },
    });
    return { paired, runner, held };
  }
  async function request(t: Team, agentId: string, runnerId: string, targetUserId: string | null = null) {
    const id = newId("sr");
    await server.deps.db.insert(schema.secretPrompts).values({
      id,
      workspaceId: t.workspaceId,
      agentId,
      runnerId,
      name: "API_TOKEN",
      target: "env",
      targetUserId,
      publicKey: "pk",
      expiresAt: new Date(server.deps.now().getTime() + 30 * 60_000),
    });
    return id;
  }
  const state = async (id: string, agentId: string) => ({
    status: (
      await server.deps.db.select().from(schema.secretPrompts).where(eq(schema.secretPrompts.id, id))
    )[0]?.status,
    rows: (
      await server.deps.db
        .select()
        .from(schema.runnerSecrets)
        .where(eq(schema.runnerSecrets.agentId, agentId))
    ).length,
  });
  const box = (ct: string) => ({ box: { v: 1, epk: "e", iv: "i", ct } });

  test(
    "many attempts to deliver and decline at once: one answer wins, only a delivered secret reaches the runner",
    async () => {
      const t = await team();
      const shared = await agent(t, t.ana.user.id, "sid");
      const { paired, held } = await holdingRunner(t);
      for (let round = 0; round < 3; round++) {
        held.length = 0;
        await server.deps.db.delete(schema.runnerSecrets).where(eq(schema.runnerSecrets.agentId, shared.id));
        const id = await request(t, shared.id, paired.runnerId);
        const path = `${t.ws}/secret-requests/${id}`;
        const answers = Promise.all(
          Array.from({ length: 8 }, (_, i) =>
            i % 2
              ? api(t.ana.browser, "POST", `${path}/decline`)
              : api(t.ana.browser, "POST", `${path}/deliver`, box(`v${i}`)),
          ),
        );
        // A store that reaches the runner is answered as stored; every other answer is already known.
        const settle = (async () => {
          for (;;) {
            for (const h of held) h.answer({ ok: true, data: { stored: true } });
            const s = await state(id, shared.id);
            if (s.status !== "pending" && (s.status !== "delivered" || held.length > 0)) return;
            await new Promise((r) => setTimeout(r, 5));
          }
        })();
        const results = await answers;
        await settle;
        for (const h of held) h.answer({ ok: true, data: { stored: true } });
        expect(results.filter((r) => r.status === 200)).toHaveLength(1);
        expect(
          results.filter((r) => r.status === 409).every((r) => r.body.error.code === "secret.closed"),
        ).toBe(true);
        const s = await state(id, shared.id);
        expect(held.length).toBe(s.status === "delivered" ? 1 : 0);
        expect(s.rows).toBe(held.length);
      }
    },
    SERVER_TEST_MS,
  );

  test(
    "a decline that wins sends nothing; delivering again while the first is on its way never reaches the runner",
    async () => {
      const t = await team();
      const shared = await agent(t, t.ana.user.id, "sol");
      const { paired, held } = await holdingRunner(t);
      const first = await request(t, shared.id, paired.runnerId);
      expect((await api(t.ana.browser, "POST", `${t.ws}/secret-requests/${first}/decline`)).status).toBe(200);
      const late = await api(t.ana.browser, "POST", `${t.ws}/secret-requests/${first}/deliver`, box("late"));
      expect(late.body.error.code).toBe("secret.closed");
      expect(held).toEqual([]);
      expect(await state(first, shared.id)).toEqual({ status: "declined", rows: 0 });

      const second = await request(t, shared.id, paired.runnerId);
      const path = `${t.ws}/secret-requests/${second}/deliver`;
      const d1 = api(t.ana.browser, "POST", path, box("first"));
      for (let i = 0; i < 400 && held.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
      const d2 = await api(t.ana.browser, "POST", path, box("second"));
      const decline = await api(t.ana.browser, "POST", `${t.ws}/secret-requests/${second}/decline`);
      held[0]?.answer({ ok: true, data: { stored: true } });
      expect((await d1).status).toBe(200);
      expect([d2.status, decline.status]).toEqual([409, 409]);
      expect(held.map((h) => h.ct)).toEqual(["first"]);
      expect(await state(second, shared.id)).toEqual({ status: "delivered", rows: 1 });
    },
    SERVER_TEST_MS,
  );

  test(
    "when the runner answers with an error, the request opens again and no row is left; when no answer comes, the row stays",
    async () => {
      const t = await team();
      const shared = await agent(t, t.ana.user.id, "rae");
      const refusing = await holdingRunner(t, { ok: false, code: "bad_request" });
      await lend(shared.id, refusing.paired.runnerId);
      const id = await request(t, shared.id, refusing.paired.runnerId);
      const failed = await api(t.ana.browser, "POST", `${t.ws}/secret-requests/${id}/deliver`, box("x"));
      expect(failed.body.error.code).toBe("runner.bad_request");
      expect(await state(id, shared.id)).toEqual({ status: "pending", rows: 0 });
      expect((await api(t.ana.browser, "POST", `${t.ws}/secret-requests/${id}/decline`)).status).toBe(200);

      // The connection drops with the store on its way: the value may be on the disk, so its row stays.
      const other = await agent(t, t.ana.user.id, "ody");
      const dropping = await holdingRunner(t);
      const id2 = await request(t, other.id, dropping.paired.runnerId);
      const pending = api(t.ana.browser, "POST", `${t.ws}/secret-requests/${id2}/deliver`, box("y"));
      for (let i = 0; i < 400 && dropping.held.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
      await dropping.runner.close();
      expect((await pending).body.error.code).toBe("runner.offline");
      expect(await state(id2, other.id)).toEqual({ status: "pending", rows: 1 });
      // Offline from the start: nothing is decided, nothing is written.
      const id3 = await request(t, other.id, dropping.paired.runnerId);
      expect(
        (await api(t.ana.browser, "POST", `${t.ws}/secret-requests/${id3}/deliver`, box("z"))).body.error
          .code,
      ).toBe("runner.offline");
      expect((await state(id3, other.id)).status).toBe("pending");
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
        `${t.ws}/agents/${t.lia.id}/browser/interventions/start`,
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

describe("a connection doesn't outlive the right that opened it", () => {
  /** Ana's socket subscribed to #general, and a way to see whether an event still reaches it. */
  async function watching(t: Team, who: { browser: Browser } = t.ana) {
    const socket = await TestSocket.open(who.browser, t.workspaceId);
    expect(await socket.subscribe(t.general)).toMatchObject({ type: "subscribed" });
    return socket;
  }
  const reaches = async (socket: TestSocket, channelId: string) => {
    server.deps.hub.toChannel(channelId, { type: "message.posted", text: "probe" });
    return socket
      .next((f) => f.type === "event", 300)
      .then(
        () => true,
        () => false,
      );
  };

  test(
    "signing out closes the session's sockets at once; another session of the same person stays",
    async () => {
      const t = await team();
      const other = new Browser(server.url);
      expect((await other.signIn(t.ana.user.email)).status).toBe(200);
      const kept = await watching(t, { browser: other });
      const socket = await watching(t);
      const sessionOf = (userId: string) =>
        server.deps.hub
          .sockets()
          .filter((ws) => ws.data.userId === userId)
          .map((ws) => ws.data.sessionId);
      const before = new Set(sessionOf(t.ana.user.id));
      expect(before.size).toBe(2);
      expect((await t.ana.browser.json("/api/auth/sign-out", "POST", {})).status).toBe(200);
      // Cut by the sign-out itself (the session hook), not by a later sweep: it is gone when the answer arrives.
      expect(new Set(sessionOf(t.ana.user.id)).size).toBe(1);
      expect(await socket.closed).toBe(4401);
      expect(server.deps.hub.sockets().some((ws) => ws.data.userId === t.ana.user.id)).toBe(true);
      expect(await reaches(kept, t.general)).toBe(true);
      kept.close();
    },
    SERVER_TEST_MS,
  );

  test(
    "revoking every session of the person closes all their sockets in the same request",
    async () => {
      const t = await team();
      const socket = await watching(t, t.beto);
      expect((await t.beto.browser.json("/api/auth/revoke-sessions", "POST", {})).status).toBe(200);
      expect(server.deps.hub.sockets().some((ws) => ws.data.userId === t.beto.user.id)).toBe(false);
      expect(await socket.closed).toBe(4401);
    },
    SERVER_TEST_MS,
  );

  test(
    "an expired or deleted session, or a removed member: the next frame with an effect is not taken and the sweep cuts the rest",
    async () => {
      const t = await team();
      // Expired by the server's clock: a subscribe is not taken, the socket closes.
      const early = await watching(t);
      ahead += 8 * 24 * 3600_000;
      try {
        early.send({ type: "subscribe", channelId: t.general });
        expect(await early.closed).toBe(4401);
        expect(early.frames.some((f) => f.type === "subscribed")).toBe(false);
      } finally {
        ahead -= 8 * 24 * 3600_000;
      }
      // A session deleted where no hook runs (straight in the database): the sweep cuts it.
      const beto = await watching(t, t.beto);
      await server.deps.db.delete(schema.sessions).where(eq(schema.sessions.userId, t.beto.user.id));
      await revalidateBrowsers(server.deps);
      expect(await beto.closed).toBe(4401);
      // Removed from the workspace: the path that removes the member cuts the sockets at once (hub.dropUser);
      // without it the sweep does.
      const ana2 = await signedIn(server, "Ana2", email("ana2"));
      await joinWorkspace(server.deps.db, {
        workspaceId: t.workspaceId,
        userId: ana2.user.id,
        name: "Ana2",
        role: "admin",
      });
      const removed = await watching(t, ana2);
      await server.deps.db
        .delete(schema.members)
        .where(and(eq(schema.members.workspaceId, t.workspaceId), eq(schema.members.userId, ana2.user.id)));
      server.deps.hub.dropUser(t.workspaceId, ana2.user.id);
      expect(await removed.closed).toBe(4003);
      const swept = await signedIn(server, "Ana3", email("ana3"));
      await joinWorkspace(server.deps.db, {
        workspaceId: t.workspaceId,
        userId: swept.user.id,
        name: "Ana3",
        role: "member",
      });
      const left = await watching(t, swept);
      await server.deps.db
        .delete(schema.members)
        .where(and(eq(schema.members.workspaceId, t.workspaceId), eq(schema.members.userId, swept.user.id)));
      left.send({ type: "typing", channelId: t.general });
      expect(await left.closed).toBe(4401);
    },
    SERVER_TEST_MS,
  );

  test(
    "leaving a private channel or an agent's audience stops its events, its live view and its control",
    async () => {
      const t = await team();
      const board = newId("ch");
      await server.deps.db.insert(schema.channels).values({
        id: board,
        workspaceId: t.workspaceId,
        name: "board",
        topic: "",
        visibility: "private",
        createdBy: t.ana.user.id,
      });
      await server.deps.db.insert(schema.channelMemberships).values([
        { channelId: board, memberType: "person", memberId: t.ana.user.id },
        { channelId: board, memberType: "person", memberId: t.beto.user.id },
      ]);
      const beto = await TestSocket.open(t.beto.browser, t.workspaceId);
      expect(await beto.subscribe(board)).toMatchObject({ type: "subscribed" });
      await server.deps.db
        .delete(schema.channelMemberships)
        .where(eq(schema.channelMemberships.memberId, t.beto.user.id));
      await revalidateBrowsers(server.deps);
      expect(await beto.next((f) => f.type === "unsubscribed")).toMatchObject({ channelId: board });
      expect(await reaches(beto, board)).toBe(false);

      // Beto watches and controls an agent everyone talks to; then it becomes Ana's only.
      const ivy = await agent(t, t.ana.user.id, "ivy2");
      const paired = await pairOverHttp(t, t.ana);
      const runner = await online(paired, { browser: true });
      await lend(ivy.id, paired.runnerId);
      beto.send({ type: "live_view.subscribe", agentId: ivy.id });
      await runner.request("live_view.start");
      expect(
        (await api(t.beto.browser, "POST", `${t.ws}/agents/${ivy.id}/browser/interventions/start`, {}))
          .status,
      ).toBe(200);
      await server.deps.db
        .update(schema.agents)
        .set({ visibilityMode: "owner" })
        .where(eq(schema.agents.id, ivy.id));
      beto.send({ type: "live_view.input", agentId: ivy.id, events: [{ type: "click" }] });
      expect(await beto.next((f) => f.type === "live_view.unavailable")).toMatchObject({
        reason: "forbidden",
      });
      expect(await beto.next((f) => f.type === "error")).toMatchObject({ code: "not_watching" });
      runner.send({ type: "live_view.frame", agentId: ivy.id, data: "AFTER", width: 1, height: 1 });
      await runner.request("live_view.stop");
      expect(beto.frames.some((f) => f.type === "live_view.frame" && f.data === "AFTER")).toBe(false);
      expect(runner.frames.some((f) => f.type === "request" && f.op === "live_view.input")).toBe(false);
      beto.close();
    },
    SERVER_TEST_MS,
  );

  test(
    "a runner moved, reduced, removed or replaced mid-request: what was pending stops and its late frames count for nothing",
    async () => {
      const t = await team();
      const hold = (req: { op: string }) =>
        req.op === "exec"
          ? new Promise<never>(() => {})
          : ({
              ok: true,
              data:
                req.op === "access.reduce"
                  ? {
                      access: {
                        folders: [],
                        tools: { browser: true, claude: false, codex: false, commands: false },
                      },
                    }
                  : {},
            } as const);
      const pa = await pairOverHttp(t, t.ana);
      const pb = await pairOverHttp(t, t.ana);
      const a = await online(pa, { browser: true, answer: hold });
      const b = await online(pb, { browser: true, answer: hold });
      const ivy = await agent(t, t.ana.user.id, "ivy3");
      await lend(ivy.id, pa.runnerId);
      const ana = await TestSocket.open(t.ana.browser, t.workspaceId);
      ana.send({ type: "live_view.subscribe", agentId: ivy.id });
      await a.request("live_view.start");
      const exec = (runnerId: string) =>
        server.deps.runners
          .call(runnerId, "exec", { command: "ls" }, { agent: ivy, timeoutMs: 20_000 })
          .catch((e: { code?: string }) => e.code);

      // Moved to B: the call on A is canceled (A is told), the live view from A ends, A's late answer is nothing.
      const moving = exec(pa.runnerId);
      const req = await a.request("exec");
      const moved = await api(t.ana.browser, "POST", `${t.ws}/runners/${pa.runnerId}/move-agents`, {
        toRunnerId: pb.runnerId,
      });
      expect(moved.body.moved).toEqual([ivy.id]);
      expect(await moving).toBe("canceled");
      expect(await a.next((f) => f.type === "cancel" && f.id === req.id)).toBeTruthy();
      expect(await ana.next((f) => f.type === "live_view.ended")).toMatchObject({ agentId: ivy.id });
      a.send({ type: "live_view.frame", agentId: ivy.id, data: "LATE", width: 1, height: 1 });
      a.send({ type: "result", id: req.id, ok: true, data: { late: true } });

      // Access reduced on B: what was running there stops.
      const running = exec(pb.runnerId);
      await b.request("exec");
      expect(
        (
          await api(t.ana.browser, "POST", `${t.ws}/runners/${pb.runnerId}/access/reduce`, {
            disableTool: "commands",
          })
        ).status,
      ).toBe(200);
      expect(await running).toBe("canceled");

      // Removed: the pending call fails at once and the runner's late frames don't count.
      const removing = exec(pb.runnerId);
      const last = await b.request("exec");
      expect((await api(t.ana.browser, "DELETE", `${t.ws}/runners/${pb.runnerId}`)).status).toBe(204);
      expect(await removing).toBe("offline");
      b.send({ type: "result", id: last.id, ok: true, data: {} });
      b.send({ type: "runner.state", paused: true });
      expect(await b.closed).toMatchObject({ code: 1000 });
      const [rowB] = await server.deps.db
        .select()
        .from(schema.runners)
        .where(eq(schema.runners.id, pb.runnerId));
      expect(rowB?.paused).toBe(false);

      // A rotates its credential and connects again: the old socket is replaced and what it still sends is nothing;
      // the old credential, used again, revokes the runner and drops the new connection.
      const oldCredential = pa.credential;
      const again = await online(pa);
      expect(await a.next((f) => f.type === "rejected")).toMatchObject({ reason: "replaced" });
      a.send({ type: "runner.state", paused: true });
      const [rowA] = await server.deps.db
        .select()
        .from(schema.runners)
        .where(eq(schema.runners.id, pa.runnerId));
      expect(rowA?.paused).toBe(false);
      expect((await mintSession(server.url, oldCredential)).status).toBe(403);
      expect(await again.next((f) => f.type === "rejected")).toMatchObject({ reason: "revoked" });
      expect(ana.frames.some((f) => f.type === "live_view.frame")).toBe(false);
      for (const r of [a, b, again]) expect(r.invalid).toEqual([]);
      ana.close();
    },
    SERVER_TEST_MS,
  );
});

/** One character of each UTF-8 width: 1, 2, 3 and 4 bytes. */
const WIDTHS = ["x", "é", "€", "😀"] as const;

/** `frame` as JSON with a `pad` field that brings it to exactly `bytes` bytes in UTF-8, mostly of `char`. */
function sizedFrame(frame: Record<string, unknown>, bytes: number, char: string): string {
  const head = JSON.stringify({ ...frame, pad: "" }).slice(0, -2);
  const room = bytes - Buffer.byteLength(head) - 2;
  const width = Buffer.byteLength(char);
  const out = `${head}${char.repeat(Math.floor(room / width))}${"x".repeat(room % width)}"}`;
  if (Buffer.byteLength(out) !== bytes) throw new Error("sizedFrame: wrong size");
  return out;
}

describe("frames, limits and the hello's waits", () => {
  test(
    "a frame of each type that the protocol doesn't accept changes and forwards nothing, and the runner stays",
    async () => {
      const t = await team();
      const paired = await pairOverHttp(t, t.ana);
      const a = await online(paired, {
        browser: true,
        answer: (req) =>
          req.op === "exec" || req.op === "harness.turn" ? new Promise(() => {}) : { ok: true, data: {} },
      });
      await lend(t.lia.id, paired.runnerId);
      const [before] = await server.deps.db
        .select()
        .from(schema.runners)
        .where(eq(schema.runners.id, a.runnerId));
      const jobId = newId("job");
      await server.deps.db.insert(schema.runnerJobs).values({
        id: jobId,
        workspaceId: t.workspaceId,
        runnerId: a.runnerId,
        agentId: t.lia.id,
        title: "Build",
        executor: "shell",
        prompt: "make",
        status: "running",
      });
      const ana = await TestSocket.open(t.ana.browser, t.workspaceId);
      ana.send({ type: "live_view.subscribe", agentId: t.lia.id });
      await a.request("live_view.start");
      const chunks: string[] = [];
      const call = server.deps.runners.call(
        a.runnerId,
        "exec",
        { command: "ls" },
        {
          onOutput: (_s, chunk) => chunks.push(chunk),
          timeoutMs: 15_000,
        },
      );
      const req = await a.request("exec");
      const events: unknown[] = [];
      const tools: string[] = [];
      const turn = server.deps.runners.call(
        a.runnerId,
        "harness.turn",
        { runId: "run_12345678", executor: "claude_code", system: "", prompt: "hi", tools: [] },
        {
          onHarnessEvent: (e) => events.push(e),
          onHarnessTool: async (name) => {
            tools.push(name);
            return { content: "ok", isError: false };
          },
          timeoutMs: 15_000,
        },
      );
      const turnReq = await a.request("harness.turn");
      const bad: unknown[] = [
        "{not json",
        { type: "teleport" },
        { type: "result", id: req.id, ok: "yes", data: { forged: true } },
        { type: "result", id: req.id, ok: false, error: { code: "no_such_code", message: "x" } },
        { type: "output", id: req.id, stream: "stdin", chunk: "forged" },
        { type: "output", id: req.id, stream: "stdout" },
        { type: "job.event", jobId, kind: "line", line: "forged" },
        { type: "job.event", jobId, kind: "shout", line: "forged", at: "now" },
        {
          type: "job.done",
          job: {
            jobId,
            status: "exploded",
            exitCode: 0,
            result: "x",
            session: null,
            files: [],
            denied: [],
            blocked: [],
            startedAt: null,
            endedAt: null,
          },
        },
        { type: "runner.state", paused: "yes" },
        { type: "cli.changed", cli: "everything" },
        { type: "access.changed", access: { tools: "all" } },
        { type: "sandbox.changed", sandbox: { state: "weird" } },
        { type: "harness.event", id: turnReq.id, event: { kind: "image", text: "forged" } },
        { type: "harness.tool", id: turnReq.id, callId: "x", name: 5, input: {} },
        { type: "live_view.frame", agentId: t.lia.id, data: 5, width: "wide", height: 1 },
        { type: "live_view.stream_ended", agentId: t.lia.id, reason: "boom" },
        { type: "pong", at: "noon" },
      ];
      for (const frame of bad) a.send(frame);
      // The connection stays, and a valid frame after the bad ones still takes effect.
      a.send({ type: "output", id: req.id, stream: "stdout", chunk: "real" });
      a.send({ type: "result", id: req.id, ok: true, data: { real: true } });
      expect(await call).toEqual({ real: true });
      expect(chunks).toEqual(["real"]);
      a.send({ type: "result", id: turnReq.id, ok: true, data: {} });
      await turn;
      expect(events).toEqual([]);
      expect(tools).toEqual([]);
      const [after] = await server.deps.db
        .select()
        .from(schema.runners)
        .where(eq(schema.runners.id, a.runnerId));
      expect({
        paused: after?.paused,
        cli: after?.cli,
        access: after?.access,
        sandbox: after?.sandbox,
      }).toEqual({
        paused: before?.paused,
        cli: before?.cli,
        access: before?.access,
        sandbox: before?.sandbox,
      });
      const [job] = await server.deps.db
        .select()
        .from(schema.runnerJobs)
        .where(eq(schema.runnerJobs.id, jobId));
      expect(job).toMatchObject({ status: "running", outputTail: [], tailLine: null });
      expect(ana.frames.some((f) => f.type === "live_view.frame" || f.type === "live_view.ended")).toBe(
        false,
      );
      expect(server.deps.runners.isOnline(a.runnerId)).toBe(true);
      expect(a.invalid).toEqual([]);
      ana.close();
    },
    SERVER_TEST_MS,
  );

  test(
    "the runner frame limit is 4 MB in bytes: with 1 to 4 bytes a character, exactly 4 MB is taken and one byte more closes (1009)",
    async () => {
      const t = await team();
      for (const char of WIDTHS) {
        const a = await online(await pairOverHttp(t, t.ana));
        const paused = async () =>
          (
            await server.deps.db
              .select({ p: schema.runners.paused })
              .from(schema.runners)
              .where(eq(schema.runners.id, a.runnerId))
          )[0]?.p;
        const atLimit = sizedFrame({ type: "runner.state", paused: true }, 4 * 1024 * 1024, char);
        expect(Buffer.byteLength(atLimit)).toBe(4 * 1024 * 1024);
        a.send(atLimit);
        for (let i = 0; i < 400 && !(await paused()); i++) await new Promise((r) => setTimeout(r, 10));
        expect({ char, paused: await paused() }).toEqual({ char, paused: true });
        a.send(sizedFrame({ type: "runner.state", paused: false }, 4 * 1024 * 1024 + 1, char));
        expect({ char, code: (await a.closed).code }).toEqual({ char, code: 1009 });
        expect(await paused()).toBe(true);
      }
    },
    SERVER_TEST_MS,
  );

  test(
    "the browser frame limit is 64 KB and a live view input carries at most 100 events",
    async () => {
      const t = await team();
      const paired = await pairOverHttp(t, t.ana);
      const runner = await online(paired, { browser: true });
      await lend(t.lia.id, paired.runnerId);
      const ana = await TestSocket.open(t.ana.browser, t.workspaceId);
      // The limit is in bytes on the wire: with 1 to 4 bytes a character, exactly 64 KB is taken, one more isn't.
      for (const char of WIDTHS) {
        ana.ws.send(sizedFrame({ type: "ping" }, 64 * 1024, char));
        expect({
          char,
          reply: (await ana.next((f) => f.type === "pong" || f.type === "error")).type,
        }).toEqual({
          char,
          reply: "pong",
        });
        ana.ws.send(sizedFrame({ type: "ping" }, 64 * 1024 + 1, char));
        expect({ char, reply: await ana.next((f) => f.type === "pong" || f.type === "error") }).toMatchObject(
          {
            char,
            reply: { code: "frame_too_large" },
          },
        );
      }
      ana.send({ type: "live_view.subscribe", agentId: t.lia.id });
      await runner.request("live_view.start");
      expect(
        (await api(t.ana.browser, "POST", `${t.ws}/agents/${t.lia.id}/browser/interventions/start`, {}))
          .status,
      ).toBe(200);
      await ana.next((f) => f.type === "live_view.status" && f.mode === "control");
      const events = (n: number) => Array.from({ length: n }, (_, i) => ({ type: "move", x: i }));
      ana.send({ type: "live_view.input", agentId: t.lia.id, events: events(100) });
      expect((await runner.request("live_view.input")).args).toEqual({ events: events(100) });
      ana.send({ type: "live_view.input", agentId: t.lia.id, events: events(101) });
      expect(await ana.next((f) => f.type === "error")).toMatchObject({ code: "invalid_frame" });
      ana.send({ type: "ping" });
      await ana.next((f) => f.type === "pong");
      expect(runner.frames.some((f) => f.type === "request" && f.op === "live_view.input")).toBe(false);
      ana.close();
    },
    SERVER_TEST_MS,
  );

  test(
    "typing in a private channel the person left is turned away at once, before any sweep",
    async () => {
      const t = await team();
      const board = newId("ch");
      await server.deps.db.insert(schema.channels).values({
        id: board,
        workspaceId: t.workspaceId,
        name: "board2",
        topic: "",
        visibility: "private",
        createdBy: t.ana.user.id,
      });
      await server.deps.db.insert(schema.channelMemberships).values([
        { channelId: board, memberType: "person", memberId: t.ana.user.id },
        { channelId: board, memberType: "person", memberId: t.beto.user.id },
      ]);
      const ana = await TestSocket.open(t.ana.browser, t.workspaceId);
      const beto = await TestSocket.open(t.beto.browser, t.workspaceId);
      await ana.subscribe(board);
      await beto.subscribe(board);
      await server.deps.db
        .delete(schema.channelMemberships)
        .where(
          and(
            eq(schema.channelMemberships.channelId, board),
            eq(schema.channelMemberships.memberId, t.beto.user.id),
          ),
        );
      beto.send({ type: "typing", channelId: board });
      expect(await beto.next((f) => f.type === "error")).toMatchObject({
        code: "forbidden",
        channelId: board,
      });
      ana.send({ type: "ping" });
      await ana.next((f) => f.type === "pong");
      expect(ana.frames.some((f) => f.type === "event")).toBe(false);
      ana.close();
      beto.close();
    },
    SERVER_TEST_MS,
  );

  test(
    "a runner that closes at any wait of its hello is left neither online nor with a timer",
    async () => {
      const t = await team();
      const paired = await pairOverHttp(t, t.ana);
      const db = server.deps.db;
      const info = log.info;
      try {
        for (let k = 0; ; k++) {
          const minted = await mintSession(server.url, paired.credential);
          paired.credential = minted.body.credential;
          // The k-th database step of the hello holds until the socket is closed and its close handler ran.
          let steps = 0;
          let held = false;
          let release!: () => void;
          const released = new Promise<void>((r) => {
            release = r;
          });
          let hold!: () => void;
          const holding = new Promise<void>((r) => {
            hold = r;
          });
          let armed = false;
          server.deps.db = new Proxy(db, {
            get(target, prop) {
              const value = Reflect.get(target, prop, target);
              if (!["select", "update", "insert", "delete"].includes(String(prop)))
                return typeof value === "function" ? value.bind(target) : value;
              return (...args: unknown[]) =>
                wrapQuery(value.apply(target, args), async () => {
                  if (!armed || steps++ !== k) return;
                  held = true;
                  hold();
                  await released;
                });
            },
          });
          let ended!: (how: string) => void;
          const end = new Promise<string>((r) => {
            ended = r;
          });
          log.info = (msg: string, fields?: Record<string, unknown>) => {
            if (msg === "runner.connected" || msg === "runner.hello_abandoned") ended(msg);
            info(msg, fields);
          };
          const unregister = server.deps.runners.unregister.bind(server.deps.runners);
          let closedHandler!: () => void;
          const handlerRan = new Promise<void>((r) => {
            closedHandler = r;
          });
          let registered: { data: { pingTimer: unknown } } | null = null;
          const register = server.deps.runners.register.bind(server.deps.runners);
          server.deps.runners.register = (id, ws) => {
            registered = ws;
            return register(id, ws);
          };
          server.deps.runners.unregister = (ws) => {
            const out = unregister(ws);
            closedHandler();
            return out;
          };
          const ws = new WebSocket(`${server.url.replace(/^http/, "ws")}/api/v1/runners/connect`);
          const closed = new Promise((r) => ws.addEventListener("close", r));
          await new Promise((r) => ws.addEventListener("open", r, { once: true }));
          armed = true;
          ws.send(
            JSON.stringify({
              type: "hello",
              session: minted.body.session,
              version: "0.2.0",
              protocol: 2,
              os: "linux",
              arch: "x64",
              hostname: "h",
              workDir: null,
              paused: false,
              access: { folders: [], tools: { browser: false, claude: false, codex: false, commands: true } },
              browser: false,
              executors: [],
              cli: {},
              jobs: [],
              features: [],
            }),
          );
          const first = await Promise.race([holding.then(() => "held"), end]);
          server.deps.runners.register = register;
          if (first !== "held") {
            // No step k: every wait of the hello was covered.
            expect(k).toBeGreaterThan(3);
            ws.close();
            await closed;
            server.deps.db = db;
            server.deps.runners.unregister = unregister;
            break;
          }
          ws.close();
          await closed;
          await handlerRan;
          release();
          expect(await end).toBe("runner.hello_abandoned");
          expect(held).toBe(true);
          expect(server.deps.runners.isOnline(paired.runnerId)).toBe(false);
          expect((registered as { data: { pingTimer: unknown } } | null)?.data.pingTimer ?? null).toBeNull();
          server.deps.db = db;
          server.deps.runners.unregister = unregister;
        }
      } finally {
        server.deps.db = db;
        log.info = info;
      }
    },
    SERVER_TEST_MS,
  );
});

describe("a replaced connection's close", () => {
  test(
    "the old socket's close finishing at any wait of the new hello, or after its welcome, leaves the runner online",
    async () => {
      const t = await team();
      const paired = await pairOverHttp(t, t.ana);
      const db = server.deps.db;
      const toWorkspace = server.deps.hub.toWorkspace.bind(server.deps.hub);
      try {
        // k: the new hello's database step at which the old close is let go; -1: after the new welcome.
        for (let k = 0; ; k++) {
          const old = await online(paired);
          const presence: boolean[] = [];
          server.deps.hub.toWorkspace = (id, event) => {
            if (event.type === "runner.presence_changed" && event.runnerId === old.runnerId)
              presence.push(event.online === true);
            return toWorkspace(id, event);
          };
          // The old close's write of the disconnection waits until it is let go.
          let closeHeld!: () => void;
          const closeHolding = new Promise<void>((r) => {
            closeHeld = r;
          });
          let letClose!: () => void;
          const closeLetGo = new Promise<void>((r) => {
            letClose = r;
          });
          let closeDone!: () => void;
          const closeFinished = new Promise<void>((r) => {
            closeDone = r;
          });
          // The new hello's k-th step holds until the old close finished.
          let helloSteps = 0;
          let helloArmed = false;
          let helloReached = false;
          server.deps.db = new Proxy(db, {
            get(target, prop) {
              const value = Reflect.get(target, prop, target);
              if (!["select", "update", "insert", "delete"].includes(String(prop)))
                return typeof value === "function" ? value.bind(target) : value;
              return (...args: unknown[]) => {
                const query = value.apply(target, args);
                if (prop === "update" && args[0] === schema.runners) {
                  const set = query.set.bind(query);
                  query.set = (values: Record<string, unknown>) => {
                    const built = set(values);
                    if (!("disconnectedAt" in values) || values.disconnectedAt === null) return built;
                    const where = built.where.bind(built);
                    // The close writes with `.returning()`: that is where it waits to be let go.
                    built.where = (...w: unknown[]) => {
                      const q = where(...w);
                      return Object.assign(Object.create(q), {
                        returning: (...r: unknown[]) =>
                          (async () => {
                            closeHeld();
                            await closeLetGo;
                            try {
                              return await q.returning(...r);
                            } finally {
                              closeDone();
                            }
                          })(),
                      });
                    };
                    return built;
                  };
                  return query;
                }
                return wrapQuery(query, async () => {
                  if (!helloArmed || helloSteps++ !== k) return;
                  helloReached = true;
                  letClose();
                  await closeFinished;
                });
              };
            },
          });
          await old.close();
          await closeHolding;
          const minted = await mintSession(server.url, paired.credential);
          paired.credential = minted.body.credential;
          helloArmed = true;
          const fresh = await connectProtocolRunner(server.url, minted.body.session);
          open.push(fresh);
          helloArmed = false;
          const afterWelcome = !helloReached;
          if (afterWelcome) {
            letClose();
            await closeFinished;
          }
          server.deps.db = db;
          const [row] = await db.select().from(schema.runners).where(eq(schema.runners.id, fresh.runnerId));
          expect({
            k,
            online: server.deps.runners.isOnline(fresh.runnerId),
            gone: row?.disconnectedAt ?? null,
          }).toEqual({
            k,
            online: true,
            gone: null,
          });
          expect({ k, last: presence.at(-1) }).toEqual({ k, last: true });
          await fresh.close();
          if (afterWelcome) {
            expect(k).toBeGreaterThan(3);
            break;
          }
        }
      } finally {
        server.deps.db = db;
        server.deps.hub.toWorkspace = toWorkspace;
      }
    },
    2 * SERVER_TEST_MS,
  );
});

describe("partial changes at once", () => {
  test(
    "two partial sandbox changes at once keep both; two site lists at once leave no site on the read list",
    async () => {
      const t = await team();
      await Promise.all([
        api(t.ana.browser, "PUT", `${t.ws}/sandbox-settings`, { minutesPerDay: 10 }),
        api(t.ana.browser, "PUT", `${t.ws}/sandbox-settings`, { commandTimeoutSec: 30 }),
        api(t.ana.browser, "PUT", `${t.ws}/sandbox-settings`, { requireApproval: true }),
      ]);
      expect((await api(t.ana.browser, "GET", `${t.ws}/sandbox-settings`)).body).toMatchObject({
        minutesPerDay: 10,
        commandTimeoutSec: 30,
        requireApproval: true,
      });
      await server.deps.db.insert(schema.browserPolicies).values({
        agentId: t.lia.id,
        workspaceId: t.workspaceId,
        permittedDomains: [],
        readDomains: ["a.example.com", "b.example.com"],
      });
      const browser = `${t.ws}/agents/${t.lia.id}/browser`;
      await Promise.all([
        api(t.ana.browser, "PUT", browser, { permittedDomains: ["a.example.com"] }),
        api(t.ana.browser, "PUT", browser, { permittedDomains: ["b.example.com"] }),
      ]);
      const [row] = await server.deps.db
        .select()
        .from(schema.browserPolicies)
        .where(eq(schema.browserPolicies.agentId, t.lia.id));
      expect(row?.readDomains).toEqual([]);
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
