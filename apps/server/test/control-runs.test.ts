// Ported from the origin's control tests: approvals and questions asked by a live run of the agent (the engine's
// fake model calling the tool), over raw HTTP and the real-time socket. The request and its card, who decides, the
// hash of the effect the person saw, the effect carried out with its trail and receipt; a rejection becomes the
// tool's error and the agent goes on; no decision in 24 h expires; stopping the run cancels; the boot closes what a
// dead run left waiting; a question answered from its card wakes the run.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { schema } from "@vanr/engine/db";
import { eq } from "drizzle-orm";
import type { RunningServer } from "../src/server";
import {
  type RealtimeFrame,
  SERVER_TEST_MS,
  settle,
  signedIn,
  startTestServer,
  TestSocket,
  waitFor,
} from "./harness";
import { call, seedAgent, ws } from "./route-calls";
import { memberOf, type Person, seedChannel, seedWorkspace } from "./seed";

let skew = 0;
const HOUR = 3600_000;
let server: RunningServer;
beforeAll(async () => {
  server = await startTestServer({ now: () => new Date(Date.now() + skew) });
}, SERVER_TEST_MS);
afterAll(() => server.stop(), SERVER_TEST_MS);

let n = 0;
const email = (who: string) => `${who}${++n}@control-runs.test`;
const ev = (f: RealtimeFrame) => f.event as RealtimeFrame;

/** Ana owns the workspace and Lia; Beto and Caio are members; #sales is public. */
async function team() {
  const ana = await signedIn(server, "Ana", email("ana"));
  const { workspaceId, general } = await seedWorkspace(server, ana, "Workshop");
  const beto = await memberOf(server, workspaceId, "Beto", email("beto"));
  const caio = await memberOf(server, workspaceId, "Caio", email("caio"));
  const lia = await seedAgent(server, workspaceId, ana, `lia${n}`, [general]);
  const sales = await seedChannel(server, workspaceId, { name: "sales", members: [ana] });
  const w = ws(workspaceId);
  const post = (who: Person, channelId: string, body: string, clientId: string) =>
    call(who, "POST", `${w}/channels/${channelId}/messages`, { body, clientId });
  const messagesIn = async (who: Person, channelId: string) =>
    (await call(who, "GET", `${w}/channels/${channelId}/messages`)).body.messages as {
      id: string;
      body: string;
      author: { type: string; id: string };
      meta: { approvalId?: string; question?: { id: string; text: string } };
      actions: { kind: string }[];
    }[];
  return { workspaceId, w, general, sales, ana, beto, caio, lia, post, messagesIn };
}
const postToSales = (handle: string) =>
  `@${handle} tell sales [[tool:post_message {"channel":"#sales","text":"The part arrived"}]]`;

describe("approvals asked by a run", () => {
  test(
    "the request and its card, who decides, the effect's hash, approving carries it out with its trail and receipt",
    async () => {
      const { workspaceId, w, general, sales, ana, beto, lia, post, messagesIn } = await team();
      const anaWs = await TestSocket.open(ana.browser, workspaceId);
      const betoWs = await TestSocket.open(beto.browser, workspaceId);
      await betoWs.subscribe(general);
      expect((await post(beto, general, postToSales(lia.handle), "a1")).status).toBe(201);

      // The channel gets the card (not decidable); Ana, the owner, gets her own version through the user scope.
      const inChannel = ev(await betoWs.event("approval.requested")).approval as Record<string, unknown>;
      expect(inChannel).toMatchObject({ tool: "post_message", status: "pending", decidable: false });
      const forAna = ev(await anaWs.event("approval.requested")).approval as Record<string, unknown>;
      expect(forAna).toMatchObject({ decidable: true, ownerUserId: ana.user.id, title: "Post in #sales" });
      const id = String(forAna.id);
      expect(betoWs.frames.some((f) => f.scope === "user" && ev(f).type === "approval.requested")).toBe(
        false,
      );

      // The run waits for the approval; the card is in the conversation.
      await waitFor(async () => {
        const { runs } = (await call(ana, "GET", `${w}/channels/${general}/active-runs`)).body;
        return runs[0]?.status === "paused_for_approval";
      });
      const card = (await messagesIn(beto, general)).find((m) => m.meta.approvalId === id);
      expect(card?.author).toEqual({ type: "agent", id: lia.id });

      // The card shows the exact effect: the whole text, the class and why it asks.
      const payloadHash = String(forAna.payloadHash);
      expect(forAna).toMatchObject({
        effect: "K2",
        gateReason: "policy",
        preview: { title: "Post in #sales", body: "The part arrived" },
        detail: "The part arrived",
        input: { channel: "#sales", text: "The part arrived" },
        editable: ["text"],
      });
      expect(payloadHash).toMatch(/^[0-9a-f]{64}$/);

      // Beto sees it but doesn't decide; approving needs the hash of the version seen.
      expect((await call(beto, "POST", `${w}/approvals/${id}/approve`, { payloadHash })).status).toBe(403);
      expect((await call(ana, "POST", `${w}/approvals/${id}/approve`, {})).body.error.code).toBe(
        "approval.changed",
      );
      expect(
        (await call(ana, "POST", `${w}/approvals/${id}/approve`, { payloadHash: "0".repeat(64) })).body.error
          .code,
      ).toBe("approval.changed");
      const approved = (await call(ana, "POST", `${w}/approvals/${id}/approve`, { payloadHash })).body;
      expect(approved).toMatchObject({ status: "approved", deciderUserId: ana.user.id });
      await settle(server);
      expect((await call(ana, "POST", `${w}/approvals/${id}/reject`, {})).body.error.code).toBe(
        "approval.already_resolved",
      );

      // The message went out in #sales as Lia, and the final answer carries the action's receipt.
      const posted = (await messagesIn(ana, sales)).find((m) => m.body === "The part arrived");
      expect(posted?.author).toEqual({ type: "agent", id: lia.id });
      const done = (await call(ana, "GET", `${w}/approvals/${id}`)).body;
      expect(done.result).toMatchObject({ ok: true });
      expect(done.appliedAt).not.toBeNull();
      expect(done.trail.map((t: { code: string }) => t.code)).toEqual(["requested", "approved", "executed"]);
      const reply = (await messagesIn(ana, general)).find((m) => m.body.startsWith("Posted in the channel"));
      expect(reply?.actions.map((a) => a.kind)).toEqual(["message_posted"]);
      anaWs.close();
      betoWs.close();
    },
    SERVER_TEST_MS,
  );

  test(
    "a rejection with a reason becomes the tool's error; the agent goes on and answers",
    async () => {
      const { workspaceId, w, general, sales, ana, beto, lia, post, messagesIn } = await team();
      const anaWs = await TestSocket.open(ana.browser, workspaceId);
      await post(beto, general, postToSales(lia.handle), "r1");
      const id = String((ev(await anaWs.event("approval.requested")).approval as { id: string }).id);
      const rejected = (await call(ana, "POST", `${w}/approvals/${id}/reject`, { reason: "not now" })).body;
      expect(rejected).toMatchObject({ status: "rejected", reason: "not now" });
      await settle(server);
      expect((await messagesIn(ana, general)).at(-1)?.body).toContain("rejected it (not now)");
      expect(await messagesIn(ana, sales)).toEqual([]);
      const trail = (await call(ana, "GET", `${w}/approvals/${id}`)).body.trail;
      expect(trail.map((t: { code: string }) => t.code)).toEqual(["requested", "rejected"]);
      anaWs.close();
    },
    SERVER_TEST_MS,
  );

  test(
    "no decision in 24 h expires it; stopping the run cancels it; the list filters by state",
    async () => {
      const { workspaceId, w, general, ana, beto, lia, post, messagesIn } = await team();
      const anaWs = await TestSocket.open(ana.browser, workspaceId);
      await post(beto, general, postToSales(lia.handle), "e1");
      const first = String((ev(await anaWs.event("approval.requested")).approval as { id: string }).id);
      skew += 25 * HOUR;
      try {
        await server.runtime.tick();
      } finally {
        skew -= 25 * HOUR;
      }
      await settle(server);
      expect((await call(ana, "GET", `${w}/approvals/${first}`)).body.status).toBe("expired");
      expect((await messagesIn(ana, general)).at(-1)?.body).toContain("nobody decided within 24 hours");

      await post(beto, general, postToSales(lia.handle), "e2");
      const second = ev(await anaWs.event("approval.requested")).approval as { id: string; runId: string };
      expect((await call(ana, "POST", `${w}/runs/${second.runId}/cancel`)).status).toBe(204);
      await settle(server);
      const canceled = (await call(ana, "GET", `${w}/approvals/${second.id}`)).body;
      expect(canceled.status).toBe("canceled");
      expect(canceled.trail.at(-1)?.code).toBe("canceled");
      const list = async (status: string) =>
        (await call(ana, "GET", `${w}/approvals?status=${status}`)).body.approvals as { status: string }[];
      expect(await list("pending")).toEqual([]);
      expect((await list("decided")).map((a) => a.status).sort()).toEqual(["canceled", "expired"]);
      anaWs.close();
    },
    SERVER_TEST_MS,
  );

  test(
    "at boot, an approval and a question of a run that no longer exists are closed",
    async () => {
      const { workspaceId, general, lia } = await team();
      const { db } = server.deps;
      await db.insert(schema.approvals).values({
        id: `apv_orphan${n}`,
        workspaceId,
        agentId: lia.id,
        channelId: general,
        runId: "run_dead",
        tool: "post_message",
        scope: "chat:post_message",
        title: "Post in #sales",
        expiresAt: new Date(Date.now() + HOUR),
      });
      await db.insert(schema.questions).values({
        id: `q_orphan${n}`,
        workspaceId,
        agentId: lia.id,
        channelId: general,
        runId: "run_dead",
        text: "Which color?",
      });
      await server.runtime.start();
      const [a] = await db
        .select()
        .from(schema.approvals)
        .where(eq(schema.approvals.id, `apv_orphan${n}`));
      const [q] = await db
        .select()
        .from(schema.questions)
        .where(eq(schema.questions.id, `q_orphan${n}`));
      expect([a?.status, q?.status]).toEqual(["canceled", "expired"]);
    },
    SERVER_TEST_MS,
  );
});

describe("a card that can't be posted", () => {
  /** Runs `body` with the database refusing to insert a run's card (its client id has `:card:`). */
  async function cardsFail<T>(body: () => Promise<T>): Promise<T> {
    const { deps } = server;
    const real = deps.db;
    deps.db = new Proxy(real, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target);
        if (prop !== "insert") return typeof value === "function" ? value.bind(target) : value;
        return (table: typeof schema.messages) => {
          const builder = target.insert(table);
          if (table !== schema.messages) return builder;
          return new Proxy(builder, {
            get(b, p) {
              const v = Reflect.get(b, p, b);
              if (p !== "values") return typeof v === "function" ? v.bind(b) : v;
              return (row: { clientId?: string | null }) => {
                if (row.clientId?.includes(":card:")) throw new Error("card insert failed");
                return v.call(b, row);
              };
            },
          });
        };
      },
    });
    try {
      return await body();
    } finally {
      deps.db = real;
    }
  }
  // The runtime's waits, read for the leak (private, so by name).
  const waits = () => ({
    approvals: server.runtime["approvalWaiters"].size,
    revisers: server.runtime["approvalRevisers"].size,
    questions: server.runtime["questionWaiters"].size,
  });

  test(
    "an approval or a question whose card fails leaves no wait behind; the run fails",
    async () => {
      const { general, beto, lia, post } = await team();
      const before = waits();
      await cardsFail(async () => {
        await post(beto, general, postToSales(lia.handle), "cf1");
        await post(
          beto,
          general,
          `@${lia.handle} [[tool:ask_user {"question":"Which color?","choices":["Blue","Green"]}]]`,
          "cf2",
        );
        await settle(server);
      });
      expect(waits()).toEqual(before);
      const failed = await server.deps.db
        .select({ status: schema.runs.status })
        .from(schema.runs)
        .where(eq(schema.runs.agentId, lia.id));
      expect(failed.map((r) => r.status)).toEqual(["failed", "failed"]);
    },
    SERVER_TEST_MS,
  );
});

describe("questions asked by a run", () => {
  test(
    "a card with choices, the answer from the card, a wrong choice, a repeated answer",
    async () => {
      const { workspaceId, w, general, beto, caio, lia, post, messagesIn } = await team();
      const socket = await TestSocket.open(beto.browser, workspaceId);
      await socket.subscribe(general);
      await post(
        beto,
        general,
        `@${lia.handle} [[tool:ask_user {"question":"Which color?","choices":["Blue","Green"]}]]`,
        "q1",
      );
      const question = ev(await socket.event("question.raised")).question as {
        id: string;
        status: string;
        askedUserId: string;
      };
      expect(question).toMatchObject({ status: "open", askedUserId: beto.user.id });
      const card = (await messagesIn(beto, general)).find((m) => m.meta.question?.id === question.id);
      expect(card?.meta.question?.text).toBe("Which color?");

      // Only whoever was asked answers: Caio reads the channel, but the question is Beto's.
      const answer = (who: Person, input: unknown) =>
        call(who, "POST", `${w}/questions/${question.id}/answer`, input);
      expect((await answer(caio, { choice: "Blue" })).status).toBe(403);
      expect((await answer(beto, { choice: "Purple" })).status).toBe(400);
      const answered = (await answer(beto, { choice: "Blue" })).body;
      expect(answered).toMatchObject({ status: "answered", answer: "Blue", responderUserId: beto.user.id });
      await settle(server);
      // The run woke with the answer and ended its turn with it.
      const last = (await messagesIn(beto, general)).at(-1);
      expect([last?.author.id, last?.body]).toEqual([lia.id, "Asked, and the answer was: Blue."]);
      // The card's meta was written again with the answer (whoever reloads sees it answered).
      const after = (await messagesIn(beto, general)).find((m) => m.id === card?.id);
      expect(after?.meta.question).toMatchObject({ status: "answered", answer: "Blue" });
      expect((await answer(beto, { text: "Green" })).body.error.code).toBe("question.closed");
      socket.close();
    },
    SERVER_TEST_MS,
  );
});
