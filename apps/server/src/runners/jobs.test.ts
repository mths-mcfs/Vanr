// Read-decide-write on the runners' rows at the same time, on PGlite: a job's end and a late event, two lines at
// once, a fixed-id start twice, a pairing polled twice, a credential rotated twice, an agent moved while another
// change takes it elsewhere, and two writers on the same card's meta. PGlite runs one statement at a time but the
// steps of two requests interleave, so each check here fails when the step reads, decides and writes apart. The
// row and advisory locks themselves are proved on a real Postgres (test/runners-postgres.test.ts, forced).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { schema } from "@vanr/engine/db";
import { newId } from "@vanr/engine/ids";
import { eq } from "drizzle-orm";
import { SERVER_TEST_MS, signedIn, startTestServer } from "../../test/harness";
import { wrapQuery } from "../../test/lock-double";
import { mintSession } from "../../test/protocol-runner";
import { createWorkspace } from "../members";
import type { RunningServer } from "../server";
import { applyJobEvent, finishJob, startJob } from "./jobs";
import { publishNetwork } from "./network";
import { publishSecret } from "./requests";

let server: RunningServer;
let workspaceId: string;
let channelId: string;
let agentId: string;
let ana: Awaited<ReturnType<typeof signedIn>>;
beforeAll(async () => {
  server = await startTestServer();
  ana = await signedIn(server, "Ana", "ana@jobs.test");
  ({ workspaceId, defaultChannelId: channelId } = await createWorkspace(server.deps.db, {
    name: "Jobs",
    context: "",
    user: ana.user,
  }));
  agentId = newId("agt");
  await server.deps.db.insert(schema.agents).values({
    id: agentId,
    workspaceId,
    name: "Lia",
    handle: "lia",
    model: "claude-haiku-5-5",
    ownerUserId: ana.user.id,
    appearance: { color: "blue", eyes: "dot", adornment: "none" },
  });
}, SERVER_TEST_MS);
afterAll(() => server.stop(), SERVER_TEST_MS);

const RUNNER = "rnr_jobs_test";
async function job(status: "queued" | "running" = "queued") {
  const id = newId("job");
  await server.deps.db.insert(schema.runnerJobs).values({
    id,
    workspaceId,
    runnerId: RUNNER,
    agentId,
    title: "Build",
    executor: "shell",
    prompt: "make",
    status,
  });
  return id;
}
const rowOf = async (id: string) =>
  (await server.deps.db.select().from(schema.runnerJobs).where(eq(schema.runnerJobs.id, id)))[0];
const snapshot = (jobId: string) => ({
  jobId,
  status: "done" as const,
  exitCode: 0,
  result: "ok",
  session: null,
  files: [],
  denied: [],
  blocked: [],
  startedAt: null,
  endedAt: null,
});

describe("a job's row", () => {
  test("its end and a late event at once: the end is final, the late line changes nothing", async () => {
    for (const start of ["queued", "running"] as const) {
      for (let round = 0; round < 5; round++) {
        const id = await job(start);
        await Promise.all([
          finishJob(server.deps, RUNNER, snapshot(id)),
          applyJobEvent(server.deps, RUNNER, { jobId: id, kind: "line", line: "late" }),
        ]);
        const row = await rowOf(id);
        expect(row?.status).toBe("done");
        expect(row?.endedAt).not.toBeNull();
        // The line counts only if it came first.
        if (row?.tailLine) expect(row.outputTail).toEqual(["late"]);
        await applyJobEvent(server.deps, RUNNER, { jobId: id, kind: "line", line: "after the end" });
        expect((await rowOf(id))?.outputTail).not.toContain("after the end");
        await finishJob(server.deps, RUNNER, { ...snapshot(id), status: "failed" });
        expect((await rowOf(id))?.status).toBe("done");
      }
    }
  });

  test("lines at once all stay on the tail, which keeps its last 200", async () => {
    const id = await job("running");
    await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        applyJobEvent(server.deps, RUNNER, { jobId: id, kind: "line", line: `l${i}` }),
      ),
    );
    expect(new Set((await rowOf(id))?.outputTail)).toEqual(
      new Set(Array.from({ length: 30 }, (_, i) => `l${i}`)),
    );
    for (let i = 30; i < 210; i++)
      await applyJobEvent(server.deps, RUNNER, { jobId: id, kind: "line", line: `l${i}` });
    const tail = (await rowOf(id))?.outputTail ?? [];
    expect(tail).toHaveLength(200);
    expect(tail.at(-1)).toBe("l209");
  });

  test("a start with a fixed id twice at once makes one job", async () => {
    const id = newId("job");
    const input = {
      workspaceId,
      runnerId: RUNNER,
      agent: { id: agentId, handle: "lia" },
      executor: "shell" as const,
      title: "Once",
      prompt: "make",
      id,
    };
    // The runner is offline: whoever inserted fails the job; the other returns the same row.
    const results = await Promise.allSettled([startJob(server.deps, input), startJob(server.deps, input)]);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(
      await server.deps.db.select().from(schema.runnerJobs).where(eq(schema.runnerJobs.id, id)),
    ).toHaveLength(1);
  });
});

/**
 * Holds the first select the server makes through its deps until `release` (a request that read and must wait
 * before it decides), while the next requests go through. `done` puts the database back.
 */
function holdFirstSelect() {
  const db = server.deps.db;
  let release!: () => void;
  const released = new Promise<void>((r) => {
    release = r;
  });
  let held!: () => void;
  const holding = new Promise<void>((r) => {
    held = r;
  });
  let selects = 0;
  server.deps.db = new Proxy(db, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (prop !== "select") return typeof value === "function" ? value.bind(target) : value;
      return (...args: unknown[]) =>
        wrapQuery(value.apply(target, args), async () => {
          if (++selects !== 1) return;
          held();
          await released;
        });
    },
  });
  return {
    holding,
    release,
    done: () => {
      release();
      server.deps.db = db;
    },
  };
}

describe("pairing and credentials", () => {
  const post = async (path: string, payload: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(`${server.url}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(payload),
    });
    // biome-ignore lint/suspicious/noExplicitAny: in tests the body is checked by the assertions
    return { status: res.status, body: (await res.json()) as any };
  };

  test("two polls that read the pending code before either writes: one answers pending, the other slows down", async () => {
    const start = await post("/api/v1/runner-pairings", {
      os: "linux",
      arch: "x64",
      hostname: "h",
      version: "0.2.0",
    });
    const hold = holdFirstSelect();
    try {
      const a = post("/api/v1/runner-pairings/token", { deviceCode: start.body.deviceCode });
      await hold.holding;
      const b = await post("/api/v1/runner-pairings/token", { deviceCode: start.body.deviceCode });
      hold.release();
      expect([b.body.error, (await a).body.error]).toEqual(["authorization_pending", "slow_down"]);
    } finally {
      hold.done();
    }
  });

  test("two sessions with the current credential read before either rotates: one rotates, the other gets busy", async () => {
    const start = await post("/api/v1/runner-pairings", {
      os: "linux",
      arch: "x64",
      hostname: "h",
      version: "0.2.0",
    });
    await ana.browser.json(
      `/api/v1/workspaces/${workspaceId}/runner-pairings/${start.body.userCode}/confirm`,
      "POST",
      {},
    );
    const token = await post("/api/v1/runner-pairings/token", { deviceCode: start.body.deviceCode });
    // A reads the runner and holds; B mints and rotates; then A goes on with what it read.
    const hold = holdFirstSelect();
    try {
      const a = mintSession(server.url, token.body.token);
      await hold.holding;
      const b = await mintSession(server.url, token.body.token);
      hold.release();
      expect(b.status).toBe(200);
      expect(await a).toMatchObject({ status: 409, body: { error: { code: "runner.busy" } } });
      // B's credential is the one that holds.
      hold.done();
      expect((await mintSession(server.url, b.body.credential)).status).toBe(200);
    } finally {
      hold.done();
    }
  });
});

describe("an agent and a card changed by two writers", () => {
  test("moving agents doesn't take one that another change put elsewhere meanwhile", async () => {
    const runnerA = newId("rnr");
    const runnerB = newId("rnr");
    const runnerC = newId("rnr");
    for (const id of [runnerA, runnerB, runnerC])
      await server.deps.db.insert(schema.runners).values({
        id,
        workspaceId,
        name: id,
        os: "linux",
        arch: "x64",
        hostname: "h",
        runnerRelease: "0.2.0",
        tokenHash: newId("h"),
        storeKey: "k",
        pairedByUserId: ana.user.id,
      });
    await server.deps.db
      .update(schema.agents)
      .set({ environmentId: runnerA })
      .where(eq(schema.agents.id, agentId));
    // Right after the move reads the agents on A (its 4th select: the member, the two runners, the agents),
    // another change takes Lia to C.
    const db = server.deps.db;
    let selects = 0;
    server.deps.db = new Proxy(db, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target);
        if (prop !== "select") return typeof value === "function" ? value.bind(target) : value;
        return (...args: unknown[]) =>
          wrapQuery(value.apply(target, args), async () => {
            if (++selects !== 4) return;
            await db
              .update(schema.agents)
              .set({ environmentId: runnerC })
              .where(eq(schema.agents.id, agentId));
          });
      },
    });
    let res: Response;
    try {
      res = await ana.browser.json(
        `/api/v1/workspaces/${workspaceId}/runners/${runnerA}/move-agents`,
        "POST",
        {
          toRunnerId: runnerB,
        },
      );
    } finally {
      server.deps.db = db;
    }
    expect(selects).toBeGreaterThanOrEqual(4);
    const moved = (await res.json()) as { moved: string[] };
    const [after] = await db.select().from(schema.agents).where(eq(schema.agents.id, agentId));
    expect(after?.environmentId).not.toBe(runnerB);
    expect(moved.moved).not.toContain(agentId);
  });

  test("two writers merging into one card's meta keep both", async () => {
    const messageId = newId("msg");
    await server.deps.db.insert(schema.messages).values({
      id: messageId,
      workspaceId,
      channelId,
      authorKind: "agent",
      authorId: agentId,
      body: "card",
      meta: { kept: true },
    });
    const secretId = newId("sr");
    const [secret] = await server.deps.db
      .insert(schema.secretPrompts)
      .values({
        id: secretId,
        workspaceId,
        agentId,
        runnerId: RUNNER,
        name: "API_TOKEN",
        target: "env",
        publicKey: "pk",
        messageId,
        expiresAt: new Date(Date.now() + 60_000),
      })
      .returning();
    const [network] = await server.deps.db
      .insert(schema.networkRequests)
      .values({ id: newId("nr"), workspaceId, agentId, domain: "example.com", messageId })
      .returning();
    if (!secret || !network) throw new Error("no rows");
    await Promise.all([
      publishSecret(server.deps, secret, "secret_request.created"),
      publishNetwork(server.deps, network, "network.requested"),
    ]);
    const [msg] = await server.deps.db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.id, messageId));
    expect(Object.keys(msg?.meta ?? {}).sort()).toEqual(["kept", "networkRequest", "secretRequest"]);
  });
});
