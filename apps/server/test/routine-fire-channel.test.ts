// The channel a routine's run records on every path that writes one (a scheduled fire, its missed row, a retry), what
// opening the fire's DM does with an archived agent, and the `running` flag only for a run the person sees.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { schema } from "@vanr/engine/db";
import { newId } from "@vanr/engine/ids";
import { and, eq } from "drizzle-orm";
import { dueRoutines, registerFire, startRoutineRun } from "../src/routines";
import type { RunningServer } from "../src/server";
import { SERVER_TEST_MS, signedIn, startTestServer } from "./harness";
import { call, ws } from "./route-calls";
import { memberOf, type Person, seedChannel, seedWorkspace } from "./seed";

const { routines, routineExecutions, agents, channels } = schema;

let server: RunningServer;
let workspaceId: string;
let ana: Person;
let bob: Person;
let agentId: string;
let priv: string;

const newAgent = async (name: string, archivedAt: Date | null = null) => {
  const [row] = await server.deps.db
    .insert(agents)
    .values({
      id: newId("agt"),
      workspaceId,
      name,
      handle: `${name.toLowerCase()}${newId("h").slice(-6)}`,
      role: "support",
      instructions: "",
      model: "claude-haiku-5-5",
      ownerUserId: ana.user.id,
      appearance: { color: "blue", eyes: "dot", adornment: "none" },
      archivedAt,
    })
    .returning();
  if (!row) throw new Error("no agent");
  return row.id;
};

beforeAll(async () => {
  server = await startTestServer();
  ana = await signedIn(server, "Ana", "ana@routine-fire-channel.test");
  ({ workspaceId } = await seedWorkspace(server, ana, "Fires"));
  bob = await memberOf(server, workspaceId, "Bob", "bob@routine-fire-channel.test");
  priv = await seedChannel(server, workspaceId, { name: "secret", visibility: "private", members: [ana] });
  agentId = await newAgent("Rita");
}, SERVER_TEST_MS);
afterAll(() => server.stop(), SERVER_TEST_MS);

const newRoutine = async (values: Partial<typeof routines.$inferInsert>) => {
  const [row] = await server.deps.db
    .insert(routines)
    .values({
      id: newId("rtn"),
      workspaceId,
      name: "Digest",
      prompt: "Sum up the day",
      agentId,
      target: { kind: "channel", channelId: priv },
      trigger: { kind: "webhook" },
      createdBy: ana.user.id,
      ...values,
    })
    .returning();
  if (!row) throw new Error("no routine");
  return row;
};
const rowsOf = (id: string) =>
  server.deps.db
    .select()
    .from(routineExecutions)
    .where(eq(routineExecutions.routineId, id))
    .orderBy(routineExecutions.at, routineExecutions.attempt);

describe("the channel a routine's run records", () => {
  test(
    "a scheduled fire and the missed row before it record the target channel",
    async () => {
      const at = new Date("2026-11-14T12:30:00Z");
      const r = await newRoutine({
        trigger: { kind: "schedule", rule: { freq: "hourly", timezone: "UTC" } },
        nextFireAt: new Date("2026-11-14T08:00:00Z"),
        createdAt: new Date("2026-11-14T06:00:00Z"),
      });
      await dueRoutines({ ...server.deps, now: () => at });
      await server.deps.runtime.settle();
      const rows = await rowsOf(r.id);
      expect(rows.map((x) => x.reason)).toEqual(["missed", "agent_not_in_channel", null]);
      for (const x of rows) expect(x.channelId).toBe(priv);
    },
    SERVER_TEST_MS,
  );

  test(
    "a retry row keeps the channel the failed run fired in",
    async () => {
      const r = await newRoutine({});
      const reg = await registerFire(server.deps, r.id, { trigger: "webhook", key: newId("k") });
      if (reg.duplicate) throw new Error("duplicate fire");
      const done = await startRoutineRun(server.deps, reg.run);
      expect(done).toMatchObject({ status: "failed", reason: "agent_not_in_channel", channelId: priv });
      const retry = (await rowsOf(r.id)).find((x) => x.trigger === "retry");
      expect(retry?.channelId).toBe(priv);
    },
    SERVER_TEST_MS,
  );

  test(
    "a DM routine of an archived agent opens no DM with it, and fails as agent_gone",
    async () => {
      const zed = await newAgent("Zed", new Date());
      const dmKey = [`person:${ana.user.id}`, `agent:${zed}`].sort().join("|");
      const r = await newRoutine({ agentId: zed, target: { kind: "dm" } });
      const reg = await registerFire(server.deps, r.id, { trigger: "webhook", key: newId("k") });
      if (reg.duplicate) throw new Error("duplicate fire");
      const done = await startRoutineRun(server.deps, reg.run);
      expect(done).toMatchObject({ status: "failed", reason: "agent_gone" });
      const dms = await server.deps.db
        .select()
        .from(channels)
        .where(and(eq(channels.workspaceId, workspaceId), eq(channels.dmKey, dmKey)));
      expect(dms).toEqual([]);
    },
    SERVER_TEST_MS,
  );
});

describe("a run in progress", () => {
  test(
    "records the channel it posts in once it resolves it, not the one it fired for",
    async () => {
      const general = (
        await server.deps.db
          .select({ id: channels.id })
          .from(channels)
          .where(and(eq(channels.workspaceId, workspaceId), eq(channels.name, "general")))
      )[0]?.id;
      if (!general) throw new Error("no #general");
      const kai = await newAgent("Kai");
      await server.deps.db
        .insert(schema.channelMemberships)
        .values({ channelId: priv, memberType: "agent", memberId: kai });
      const r = await newRoutine({ agentId: kai, target: { kind: "channel", channelId: general } });
      const reg = await registerFire(server.deps, r.id, { trigger: "webhook", key: newId("k") });
      if (reg.duplicate) throw new Error("duplicate fire");
      expect(reg.run.channelId).toBe(general);
      // The target moved to #secret before the run started.
      await server.deps.db
        .update(routines)
        .set({ target: { kind: "channel", channelId: priv } })
        .where(eq(routines.id, r.id));
      const rt = server.deps.runtime;
      const runFor = rt.runFor;
      let during: string | null | undefined;
      rt.runFor = async (input) => {
        during = (await rowsOf(r.id)).find((x) => x.id === reg.run.id)?.channelId;
        return runFor.call(rt, input);
      };
      try {
        await startRoutineRun(server.deps, reg.run);
      } finally {
        rt.runFor = runFor;
      }
      expect(during).toBe(priv);
    },
    SERVER_TEST_MS,
  );
});

describe("a routine's running flag", () => {
  test(
    "doesn't show a run in progress in a channel the person can't read",
    async () => {
      const general = (
        await server.deps.db
          .select({ id: channels.id })
          .from(channels)
          .where(and(eq(channels.workspaceId, workspaceId), eq(channels.name, "general")))
      )[0]?.id;
      if (!general) throw new Error("no #general");
      // The routine now posts in #general, but the run in progress is from when it pointed at #secret.
      const r = await newRoutine({
        target: { kind: "channel", channelId: general },
        runningSince: new Date(),
      });
      await server.deps.db.insert(routineExecutions).values({
        id: newId("rrun"),
        routineId: r.id,
        at: new Date(),
        status: "running",
        trigger: "webhook",
        channelId: priv,
      });
      const running = async (who: Person) =>
        (await call(who, "GET", `${ws(workspaceId)}/routines`)).body.routines.find(
          (x: { id: string }) => x.id === r.id,
        )?.running;
      expect(await running(bob)).toBe(false);
      expect(await running(ana)).toBe(true);
    },
    SERVER_TEST_MS,
  );
});
