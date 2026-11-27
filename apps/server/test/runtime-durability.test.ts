// The runtime's admission and the durable effects around a run, with the interleavings forced by barriers (no
// sleeps): two messages for one conversation at once open one run; messages steered while the run ends wait for one
// next run; no next run starts while the server stops; a message steered on the last allowed turn gets its own
// run; a reminder survives a fall before or after its post; a post's resend runs what the first request left undone
// (its search and events, a person's routing); a runner's refusal before it starts counts as not reached.
//
// The forced tests ("forced: ...") run again in CI with the admission taken out of the runtime
// (drop-admission.ts) and must fail there on their outcome (LOCK_OUTCOME_MISMATCH).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { schema } from "@vanr/engine/db";
import { newId } from "@vanr/engine/ids";
import { fakeProvider } from "@vanr/engine/models/fake";
import type { ModelProvider, ModelRequest } from "@vanr/engine/models/types";
import { and, eq, inArray } from "drizzle-orm";
import { channelInWorkspace } from "../src/channels";
import { postMessage } from "../src/messages";
import { RunnerCallError } from "../src/runners/hub";
import type { RunningServer } from "../src/server";
import { pairFake } from "./fake-runner";
import { SERVER_TEST_MS, settle, signedIn, startTestServer } from "./harness";
import { gate, outcome, wrapQuery } from "./lock-double";
import type { ProtocolRunner } from "./protocol-runner";
import { call, seedAgent, ws } from "./route-calls";
import { type Person, seedWorkspace } from "./seed";

const { runs, messages, messageDispatches, reminders } = schema;

const textOf = (req: ModelRequest) =>
  req.messages.flatMap((m) => m.content.flatMap((c) => (c.type === "text" ? [c.text] : []))).join("\n");

/** The fake model, with every request's text kept and a call held on a marker until the test opens it. */
function heldModel() {
  const fake = fakeProvider();
  const seen: string[] = [];
  const holds = new Map<string, { entered: () => void; opened: Promise<void> }>();
  const provider: ModelProvider = {
    kind: "fake",
    stream(req) {
      const text = textOf(req);
      seen.push(text);
      const marker = [...holds.keys()].find((m) => text.includes(m));
      const hold = marker ? holds.get(marker) : undefined;
      if (marker) holds.delete(marker);
      return (async function* () {
        if (hold) {
          hold.entered();
          await hold.opened;
        }
        yield* fake.stream(req);
      })();
    },
  };
  /** Holds the next call whose text has `marker`: `entered` resolves once it is held. */
  const hold = (marker: string) => {
    const entered = gate();
    const release = gate();
    holds.set(marker, { entered: entered.open, opened: release.opened });
    return { entered: entered.opened, open: release.open };
  };
  return { provider, seen, hold };
}

/** Watches the server's channel events: `on` sees each one before it goes out. */
function watchHub(server: RunningServer) {
  const hub = server.deps.hub;
  const real = hub.toChannel.bind(hub);
  const listeners = new Set<(event: Record<string, unknown>) => void>();
  hub.toChannel = ((channelId: string, event: Record<string, unknown>, opts?: unknown) => {
    for (const l of listeners) l(event);
    return (real as (c: string, e: unknown, o?: unknown) => void)(channelId, event, opts);
  }) as typeof hub.toChannel;
  const on = (listener: (event: Record<string, unknown>) => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  /** Resolves on the first event that matches. */
  const next = (match: (event: Record<string, unknown>) => boolean) =>
    new Promise<Record<string, unknown>>((resolve) => {
      const off = on((e) => {
        if (match(e)) {
          off();
          resolve(e);
        }
      });
    });
  return { on, next, restore: () => (hub.toChannel = real as typeof hub.toChannel) };
}

// biome-ignore lint/suspicious/noExplicitAny: the doubles wrap drizzle's builders, whatever their type
type Any = any;

/** The server's database with `insert(table)` (or `update(table)`) through `wrap` until `restore`. */
function onWrite(
  server: RunningServer,
  kind: "insert" | "update",
  table: unknown,
  wrap: (q: Any, row: Any) => Any,
) {
  const real = server.deps.db;
  server.deps.db = new Proxy(real, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (prop !== kind) return typeof value === "function" ? value.bind(target) : value;
      return (t: Any) => {
        const builder = (target as Any)[kind](t);
        if (t !== table) return builder;
        const step = kind === "insert" ? "values" : "set";
        return new Proxy(builder, {
          get(b, p) {
            const v = Reflect.get(b, p, b);
            if (p !== step) return typeof v === "function" ? v.bind(b) : v;
            return (row: Any) => wrap(v.call(b, row), row);
          },
        });
      };
    },
  });
  return () => {
    server.deps.db = real;
  };
}

let n = 0;
const email = (who: string) => `${who}${++n}@durability.test`;

async function dmTeam(server: RunningServer) {
  const ana = await signedIn(server, "Ana", email("ana"));
  const { workspaceId, general } = await seedWorkspace(server, ana, "Durable");
  const lia = await seedAgent(server, workspaceId, ana, `lia${n}`, [general]);
  const dm = (await call(ana, "POST", `${ws(workspaceId)}/dms`, { agentId: lia.id })).body
    .channelId as string;
  const path = `${ws(workspaceId)}/channels/${dm}/messages`;
  const say = (body: string, clientId = newId("c")) => call(ana, "POST", path, { body, clientId });
  return { ana, workspaceId, general, lia, dm, path, say };
}

const dispatchesOf = (server: RunningServer, ids: string[]) =>
  server.deps.db.select().from(messageDispatches).where(inArray(messageDispatches.messageId, ids));

describe("one conversation, one admission", () => {
  const model = heldModel();
  let server: RunningServer;
  beforeAll(async () => {
    server = await startTestServer({ modelProvider: model.provider });
  }, SERVER_TEST_MS);
  afterAll(() => server.stop(), SERVER_TEST_MS);

  test(
    "forced: two messages at once for one conversation open one run",
    async () => {
      const { lia, dm, say } = await dmTeam(server);
      const hub = watchHub(server);
      // A holds right after its run row is written, before its run is on the air; B is let go up to its
      // admission (its `message.routed` goes out right before it), and only then A goes on.
      const held = gate();
      const release = gate();
      let routed = 0;
      const offRouted = hub.on((e) => {
        if (e.type === "message.routed" && ++routed === 2) release.open();
      });
      let first = true;
      const restore = onWrite(server, "insert", runs, (q) => {
        if (!first) return q;
        first = false;
        return wrapQuery(q, async () => {
          held.open();
          await release.opened;
        });
      });
      try {
        const a = say("first, about the order");
        await held.opened;
        const b = say("second, about the order");
        expect([(await a).status, (await b).status]).toEqual([201, 201]);
        await settle(server);
      } finally {
        restore();
        offRouted();
        hub.restore();
        release.open();
      }
      const opened = await server.deps.db
        .select({ id: runs.id })
        .from(runs)
        .where(and(eq(runs.agentId, lia.id), eq(runs.channelId, dm)));
      outcome("admission", { runs: opened.length }, { runs: 1 });
    },
    SERVER_TEST_MS,
  );

  test(
    "forced: two messages steered in while the run ends both go to one next run",
    async () => {
      const { dm, say } = await dmTeam(server);
      const hub = watchHub(server);
      const thinking = model.hold("first-of-three");
      const r = await say("first-of-three, please");
      await thinking.entered;
      const [run] = await server.deps.db.select().from(runs).where(eq(runs.sourceMessageId, r.body.id));
      if (!run) throw new Error("no run");
      // M1's steer holds right after it wrote its claim on the run; the run ends meanwhile (its answer posted,
      // `run.idle`), and only then M1 goes on. M2 comes while M1 holds.
      const held = gate();
      const release = gate();
      const restore = onWrite(server, "insert", messageDispatches, (q, row) =>
        row.state === "claimed" && row.runId === run.id
          ? wrapQuery(q, async () => {
              held.open();
              await release.opened;
            })
          : q,
      );
      // The run's end, called once its last write is done: M1 goes on only after the end began (it takes the run
      // out and starts the next one), whether the end waits for M1 or not.
      const runtime = server.runtime;
      const end = runtime["ended"].bind(runtime);
      const endBegan = gate();
      runtime["ended"] = (live) => {
        const out = end(live);
        if (live.runId === run.id) endBegan.open();
        return out;
      };
      let m1: ReturnType<typeof say> | null = null;
      let m2: ReturnType<typeof say> | null = null;
      try {
        m1 = say("second-of-three");
        await held.opened;
        // M2's routing goes out right before its admission: the run ends only once M2 is there.
        const m2Routed = hub.next((e) => e.type === "message.routed");
        m2 = say("third-of-three");
        await m2Routed;
        thinking.open();
        await endBegan.opened;
        release.open();
        expect([(await m1).status, (await m2).status]).toEqual([201, 201]);
        await settle(server);
      } finally {
        restore();
        hub.restore();
        runtime["ended"] = end;
        release.open();
        thinking.open();
      }
      const ids = [(await m1).body.id as string, (await m2).body.id as string];
      const rows = await dispatchesOf(server, ids);
      const next = [...new Set(rows.map((d) => d.runId).filter((id) => id !== run.id))];
      outcome(
        "readmit",
        {
          nextRuns: next.length,
          answered: ids.map((id) => rows.find((d) => d.messageId === id)?.state ?? null),
        },
        { nextRuns: 1, answered: ["handled", "handled"] },
      );
      expect((await server.deps.db.select().from(runs).where(eq(runs.channelId, dm))).length).toBe(2);
    },
    SERVER_TEST_MS,
  );

  test(
    "a message steered on the last allowed turn isn't marked handled with it: the next run answers it",
    async () => {
      const { ana, workspaceId, lia, dm, say } = await dmTeam(server);
      const channel = await channelInWorkspace(server.deps.db, workspaceId, dm);
      if (!channel) throw new Error("no dm");
      const { message } = await postMessage(server.deps, {
        workspaceId,
        channel,
        author: { type: "person", id: ana.user.id },
        body: 'last-turn check [[tool:react {"emoji":"👍"}]]',
        clientId: newId("c"),
      });
      const [trigger] = await server.deps.db.select().from(messages).where(eq(messages.id, message.id));
      if (!trigger) throw new Error("no trigger");
      // One turn, spent on a tool: the message that comes during it is never heard by this run.
      const thinking = model.hold("last-turn check");
      const started = await server.deps.runtime.runFor({
        agent: lia,
        channel,
        trigger,
        limits: { scopes: [], maxTurns: 1, timeoutMs: 60_000 },
      });
      if (!started.ok) throw new Error(`not started: ${started.code}`);
      await thinking.entered;
      const late = await say("and one more thing");
      thinking.open();
      await started.done;
      await settle(server);
      const [first] = await server.deps.db.select().from(runs).where(eq(runs.id, started.runId));
      expect(first?.errorCode).toBe("step_limit");
      const [d] = await dispatchesOf(server, [late.body.id]);
      expect([d?.state, d?.status, d?.runId === started.runId]).toEqual(["handled", "answered", false]);
    },
    SERVER_TEST_MS,
  );
});

describe("the server stopping", () => {
  test(
    "no next run starts while the server stops: the waiting message's run doesn't go on the air",
    async () => {
      const model = heldModel();
      const server = await startTestServer({ modelProvider: model.provider });
      const hub = watchHub(server);
      try {
        const { say } = await dmTeam(server);
        const thinking = model.hold("before-the-stop");
        await say("before-the-stop, please");
        await thinking.entered;
        // The run holds in its end (it is ending: its last turn is past), and a message comes for the next run.
        const ending = gate();
        const release = gate();
        const restore = onWrite(server, "update", runs, (q, row) =>
          row.status === "done"
            ? wrapQuery(q, async () => {
                ending.open();
                await release.opened;
              })
            : q,
        );
        thinking.open();
        await ending.opened;
        restore();
        const waiting = await say("waits-for-the-next-run");
        expect(waiting.status).toBe(201);
        // The stop begins right when the next run's row and claim are written, before it is on the air.
        let stopping: Promise<void> | null = null;
        const began = gate();
        hub.on((e) => {
          if (e.type !== "message.claimed" || e.messageId !== waiting.body.id) return;
          stopping ??= server.runtime.stop();
          began.open();
        });
        release.open();
        await began.opened;
        await stopping;
        expect(model.seen.some((t) => t.includes("waits-for-the-next-run"))).toBe(false);
        const [next] = await server.deps.db
          .select()
          .from(runs)
          .where(eq(runs.sourceMessageId, waiting.body.id));
        expect(next?.status ?? "none").not.toBe("running");
        expect(next?.status ?? "none").not.toBe("done");
      } finally {
        hub.restore();
        await server.stop();
      }
    },
    SERVER_TEST_MS,
  );
});

describe("durable effects", () => {
  let server: RunningServer;
  let ana: Person;
  let workspaceId = "";
  let general = "";
  beforeAll(async () => {
    server = await startTestServer();
    ana = await signedIn(server, "Ana", email("ana"));
    ({ workspaceId, general } = await seedWorkspace(server, ana, "Effects"));
  }, SERVER_TEST_MS);
  afterAll(() => server.stop(), SERVER_TEST_MS);

  const reminder = async (text: string) => {
    const id = newId("rem");
    await server.deps.db.insert(reminders).values({
      id,
      workspaceId,
      agentId: null,
      channelId: general,
      text,
      at: new Date(Date.now() - 60_000),
      createdByType: "person",
      createdById: ana.user.id,
    });
    return id;
  };
  const posted = (id: string) =>
    server.deps.db
      .select()
      .from(messages)
      .where(eq(messages.clientId, `reminder:${id}`));
  const statusOf = async (id: string) =>
    (await server.deps.db.select().from(reminders).where(eq(reminders.id, id)))[0]?.status;

  test(
    "a reminder whose post fails is posted by the next sweep; one whose mark fails isn't posted twice",
    async () => {
      const lost = await reminder("call the bakery");
      let restore = onWrite(server, "insert", messages, (q, row) => {
        if (String(row.clientId).startsWith("reminder:")) throw new Error("post failed");
        return q;
      });
      try {
        await expect(server.runtime.tick()).rejects.toThrow("post failed");
      } finally {
        restore();
      }
      expect(await statusOf(lost)).toBe("scheduled");
      await server.runtime.tick();
      expect([(await posted(lost)).length, await statusOf(lost)]).toEqual([1, "sent"]);

      const twice = await reminder("order flour");
      restore = onWrite(server, "update", reminders, () => {
        throw new Error("mark failed");
      });
      try {
        await expect(server.runtime.tick()).rejects.toThrow("mark failed");
      } finally {
        restore();
      }
      expect((await posted(twice)).length).toBe(1);
      await server.runtime.tick();
      expect([(await posted(twice)).length, await statusOf(twice)]).toEqual([1, "sent"]);
    },
    SERVER_TEST_MS,
  );

  test(
    "a post sent again with its clientId runs the effects its first send left undone",
    async () => {
      const channel = await channelInWorkspace(server.deps.db, workspaceId, general);
      if (!channel) throw new Error("no channel");
      const index = server.deps.search;
      const withDb = index.withDb.bind(index);
      let writes = 0;
      index.withDb = (db) => {
        const inner = withDb(db);
        const upsert = inner.upsert.bind(inner);
        inner.upsert = async (source, chunks) => {
          writes++;
          return upsert(source, chunks);
        };
        return inner;
      };
      // The first send falls right after its search write, at its `message.posted`.
      const hub = watchHub(server);
      const events: string[] = [];
      let failed = false;
      hub.on((e) => {
        if (e.type !== "message.posted") return;
        if (!failed) {
          failed = true;
          throw new Error("events down");
        }
        events.push((e.message as { id: string }).id);
      });
      const input = {
        workspaceId,
        channel,
        author: { type: "agent" as const, id: newId("agt") },
        body: "Assignment card: the plan is ready",
        clientId: "card:replay",
      };
      try {
        await expect(postMessage(server.deps, input)).rejects.toThrow("events down");
        const [row] = await server.deps.db
          .select()
          .from(messages)
          .where(eq(messages.clientId, "card:replay"));
        if (!row) throw new Error("the first send didn't write the post");
        expect([row.effectsPending, writes]).toEqual([true, 1]);
        const again = await postMessage(server.deps, input);
        expect([again.created, again.message.id]).toEqual([false, row.id]);
        expect([writes, events.filter((id) => id === row.id).length]).toEqual([2, 1]);
        const replayed = writes;
        const [settled] = await server.deps.db.select().from(messages).where(eq(messages.id, row.id));
        expect(settled?.effectsPending).toBe(false);
        // Settled: a third send runs nothing more.
        await postMessage(server.deps, input);
        expect([writes, events.filter((id) => id === row.id).length]).toEqual([replayed, 1]);
      } finally {
        index.withDb = withDb;
        hub.restore();
      }
    },
    SERVER_TEST_MS,
  );

  test(
    "a person's post whose first send failed before its routing is routed by the resend",
    async () => {
      const { lia, say } = await dmTeam(server);
      const hub = watchHub(server);
      let failed = false;
      hub.on((e) => {
        if (e.type === "message.posted" && !failed) {
          failed = true;
          throw new Error("events down");
        }
      });
      try {
        const first = await say("are the croissants ready?", "resend-route");
        expect(first.status).toBe(500);
      } finally {
        hub.restore();
      }
      const again = await say("are the croissants ready?", "resend-route");
      expect(again.status).toBe(200);
      await settle(server);
      const [d] = await dispatchesOf(server, [again.body.id]);
      expect([d?.agentId, d?.state, d?.status]).toEqual([lia.id, "handled", "answered"]);
    },
    SERVER_TEST_MS,
  );

  test(
    "a runner's refusal before it starts (no slot) didn't reach it; a failure after the start did",
    async () => {
      const open: ProtocolRunner[] = [];
      try {
        const paired = await pairFake(server, ana, workspaceId, {
          open,
          answer: (req) =>
            String(req.args.command).includes("busy")
              ? { ok: false, error: { code: "no_slot", message: "full" } }
              : { ok: false, error: { code: "internal", message: "broke" } },
        });
        const reachedBy = async (command: string) => {
          try {
            await server.deps.runners.call(paired.runnerId, "exec", { command, cwd: null } as never, {});
          } catch (err) {
            if (err instanceof RunnerCallError) return [err.code, err.reached];
            throw err;
          }
          return null;
        };
        expect(await reachedBy("busy")).toEqual(["no_slot", false]);
        expect(await reachedBy("broken")).toEqual(["internal", true]);
      } finally {
        for (const r of open) r.close();
      }
    },
    SERVER_TEST_MS,
  );
});
