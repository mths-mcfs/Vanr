// Ported from the origin's routine tests, through routes/routines. A routine that writes a document or talks in a
// conversation reaches the runtime (`complete`, `runFor`, slice S6): "run now" and the webhook reject it at their
// entry with `not_available`, before the fire is recorded, and that is tested here. A routine whose target is a
// debate only opens one, so it runs end to end. The scheduled tick is the runtime's (S6): its scenarios and the
// document's stay in the ledger.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { schema } from "@vanr/engine/db";
import { eq } from "drizzle-orm";
import { fireRoutineEvent } from "../src/routines";
import type { RunningServer } from "../src/server";
import { signWebhook } from "../src/webhook-signature";
import { Browser, body, SERVER_TEST_MS, signedIn, startTestServer } from "./harness";
import { call, seedAgent, ws } from "./route-calls";
import { memberOf, type Person, seedChannel, seedWorkspace } from "./seed";

const skew = 0;
const HOUR = 60 * 60_000;
let server: RunningServer;
beforeAll(async () => {
  server = await startTestServer({ now: () => new Date(Date.now() + skew) });
}, SERVER_TEST_MS);
afterAll(() => server.stop(), SERVER_TEST_MS);

let n = 0;
const email = (who: string) => `${who}${++n}@routines.test`;
const settle = () => server.deps.runtime.settle();

async function team() {
  const ana = await signedIn(server, "Ana", email("ana"));
  const { workspaceId, general } = await seedWorkspace(server, ana, "Routine");
  const beto = await memberOf(server, workspaceId, "Beto", email("beto"));
  const lia = await seedAgent(server, workspaceId, ana, "lia", [general]);
  return { workspaceId, general, ana, beto, lia };
}

/** Posts a signed webhook message to a webhook path. */
async function deliver(path: string, secret: string, id: string, body: string, at = Date.now() + skew) {
  const ts = Math.floor(at / 1000);
  return fetch(`${server.url}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "webhook-id": id,
      "webhook-timestamp": String(ts),
      "webhook-signature": signWebhook(secret, id, ts, body),
    },
    body,
  });
}

describe("routines", () => {
  test(
    "schedule phrases become a rule, a description and the next runs",
    async () => {
      const { workspaceId, ana } = await team();
      const base = `${ws(workspaceId)}/routines`;
      const rule = await call(ana, "POST", `${base}/parse-rule`, {
        phrase: "dias úteis às 9h",
        timezone: "America/Sao_Paulo",
      });
      expect(rule.body).toMatchObject({
        ok: true,
        rule: {
          freq: "daily",
          weekdays: ["MO", "TU", "WE", "TH", "FR"],
          times: ["09:00"],
          timezone: "America/Sao_Paulo",
        },
        description: "Weekdays at 09:00",
      });
      expect(rule.body.upcomingFireTimes.length).toBe(4);
      expect(
        (await call(ana, "POST", `${base}/parse-rule`, { phrase: "quando der", timezone: "UTC" })).body,
      ).toMatchObject({ ok: false, code: "rule.not_understood" });
      expect(
        (await call(ana, "POST", `${base}/parse-rule`, { phrase: "todo dia", timezone: "Lua/Base" })).body
          .code,
      ).toBe("rule.timezone");
      const described = await call(ana, "POST", `${base}/describe-rule`, {
        rule: { freq: "minutely", interval: 1, timezone: "UTC" },
      });
      expect(described.body).toMatchObject({ ok: false, code: "rule.too_often" });

      const once = await call(ana, "POST", `${base}/parse-schedule`, {
        phrase: "em 2 horas",
        timezone: "UTC",
      });
      expect(once.body).toMatchObject({ ok: true, trigger: { kind: "once", timezone: "UTC" } });
      const weekly = await call(ana, "POST", `${base}/parse-schedule`, {
        phrase: "toda segunda às 10h",
        timezone: "UTC",
      });
      expect(weekly.body).toMatchObject({
        ok: true,
        trigger: { kind: "schedule", rule: { freq: "weekly", weekdays: ["MO"] } },
      });
      expect(
        (await call(ana, "POST", `${base}/parse-schedule`, { phrase: "???", timezone: "UTC" })).body.ok,
      ).toBe(false);
    },
    SERVER_TEST_MS,
  );

  test(
    "once, webhook, duplicate, delete and the validations",
    async () => {
      const { workspaceId, ana, lia } = await team();
      const base = `${ws(workspaceId)}/routines`;
      const sales = await seedChannel(server, workspaceId, { name: "sales", members: [ana] });
      // Lia isn't in #sales.
      const notIn = await call(ana, "POST", base, {
        agentId: lia.id,
        prompt: "x",
        target: { kind: "channel", channelId: sales },
        trigger: { kind: "webhook" },
      });
      expect(notIn.body.error.code).toBe("routine.agent_not_in_channel");
      const past = await call(ana, "POST", base, {
        agentId: lia.id,
        prompt: "x",
        target: { kind: "dm" },
        trigger: { kind: "once", at: new Date(Date.now() + skew - HOUR).toISOString(), timezone: "UTC" },
      });
      expect(past.body.error.code).toBe("rule.past");

      // A webhook routine that talks in the DM reaches the runtime (`runFor`): rejected before it records the fire.
      const hook = (
        await call(ana, "POST", base, {
          active: true,
          agentId: lia.id,
          prompt: "Tell me about the order",
          target: { kind: "dm" },
          trigger: { kind: "webhook" },
        })
      ).body;
      expect(hook.webhookUrl).toContain("/api/v1/hooks/routines/hook_");
      const { secret } = (await call(ana, "POST", `${base}/${hook.id}/webhook-secret`)).body;
      const path = new URL(hook.webhookUrl).pathname;
      const barred = await deliver(path, secret, "msg_1", JSON.stringify({ order: 42 }));
      expect(barred.status).toBe(503);
      expect((await body(barred)).error.code).toBe("not_available");
      expect(
        await server.deps.db
          .select()
          .from(schema.routineExecutions)
          .where(eq(schema.routineExecutions.routineId, hook.id)),
      ).toEqual([]);

      // A webhook routine that opens a debate needs no runtime: the payload goes into the debate's goal.
      const debateHook = (
        await call(ana, "POST", base, {
          active: true,
          agentId: lia.id,
          prompt: "Debate the order",
          target: { kind: "debate", agentIds: [lia.id], roundLimit: 1 },
          trigger: { kind: "webhook" },
        })
      ).body;
      const hookSecret = (await call(ana, "POST", `${base}/${debateHook.id}/webhook-secret`)).body.secret;
      const res = await deliver(new URL(debateHook.webhookUrl).pathname, hookSecret, "msg_2", '{"order":42}');
      expect(res.status).toBe(202);
      await settle();
      const [debate] = await server.deps.db
        .select()
        .from(schema.debates)
        .where(eq(schema.debates.workspaceId, workspaceId));
      expect(debate?.goal).toBe('Debate the order\n\n---\nWebhook payload:\n{"order":42}');
      const unknown = await fetch(`${server.url}/api/v1/hooks/routines/nope`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(unknown.status).toBe(404);

      const copy = (await call(ana, "POST", `${base}/${hook.id}/duplicate`, { name: "Copy" })).body;
      expect(copy).toMatchObject({ name: "Copy", active: false });
      expect(copy.webhookUrl).not.toBe(hook.webhookUrl);
      expect((await call(ana, "DELETE", `${base}/${copy.id}`)).status).toBe(204);
      const listed = (await call(ana, "GET", base)).body.routines as { id: string }[];
      expect(listed.some((r) => r.id === copy.id)).toBe(false);
      expect(listed.map((r) => r.id)).toContain(hook.id);
    },
    SERVER_TEST_MS,
  );

  test(
    "event: an issue created fires the routine; a debate as the target",
    async () => {
      const { workspaceId, ana, lia } = await team();
      const r = (
        await call(ana, "POST", `${ws(workspaceId)}/routines`, {
          active: true,
          agentId: lia.id,
          prompt: "Debate the new issue",
          target: { kind: "debate", agentIds: [lia.id], roundLimit: 1 },
          trigger: { kind: "event", event: "issue.created" },
        })
      ).body;
      expect(r.nextFireAt).toBeNull();
      // routes/issues (slice S4, track S) fires the event when a person creates an issue; here, the same call.
      await fireRoutineEvent(server.deps, {
        workspaceId,
        event: "issue.created",
        eventId: "iss_1",
        context: "Issue #1: Change the floor",
      });
      await settle();
      const [debate] = (await call(ana, "GET", `${ws(workspaceId)}/debates`)).body.debates;
      expect(debate).toMatchObject({ title: r.name, origin: { kind: "routine", agentId: lia.id } });
      expect(debate.goal).toContain("Issue #1: Change the floor");
    },
    SERVER_TEST_MS,
  );
});

describe("routines: who may call each route", () => {
  test(
    "another workspace, a non-member, a signed-out caller and the wrong role are rejected",
    async () => {
      const { workspaceId, general, ana, beto, lia } = await team();
      const base = `${ws(workspaceId)}/routines`;
      const mine = (
        await call(ana, "POST", base, {
          agentId: lia.id,
          prompt: "Daily summary",
          target: { kind: "channel", channelId: general },
          trigger: { kind: "webhook" },
        })
      ).body;
      const outsider = await signedIn(server, "Out", email("out"));
      const other = await seedWorkspace(server, outsider, "Other");
      const routes: [string, string, unknown?][] = [
        ["GET", base],
        [
          "POST",
          base,
          { agentId: lia.id, prompt: "x", target: { kind: "dm" }, trigger: { kind: "webhook" } },
        ],
        ["PATCH", `${base}/${mine.id}`, { name: "y" }],
        ["DELETE", `${base}/${mine.id}`],
        ["POST", `${base}/${mine.id}/run`, {}],
        ["POST", `${base}/${mine.id}/webhook-secret`],
        ["GET", `${base}/${mine.id}/estimate`],
        ["GET", `${base}/${mine.id}/runs`],
        ["POST", `${base}/${mine.id}/duplicate`, {}],
        ["POST", `${base}/parse-schedule`, { phrase: "todo dia às 9h", timezone: "UTC" }],
        ["POST", `${base}/parse-rule`, { phrase: "todo dia", timezone: "UTC" }],
        ["POST", `${base}/describe-rule`, { rule: { freq: "daily", timezone: "UTC" } }],
      ];
      const anonymous: Person = { browser: new Browser(server.url), user: { id: "", name: "", email: "" } };
      for (const [method, path, payload] of routes) {
        // Not a member of this workspace: 404, the same as a workspace that doesn't exist.
        expect([method, path, (await call(outsider, method, path, payload)).status]).toEqual([
          method,
          path,
          404,
        ]);
        expect([method, path, (await call(anonymous, method, path, payload)).status]).toEqual([
          method,
          path,
          401,
        ]);
      }
      // The same routine through the outsider's own workspace: it isn't there.
      expect((await call(outsider, "GET", `${ws(other.workspaceId)}/routines/${mine.id}/runs`)).status).toBe(
        404,
      );
      // A member who didn't create it changes nothing; reading is allowed (they read the target channel).
      for (const [method, path, payload] of routes.filter(
        ([m, p]) => ["PATCH", "DELETE"].includes(m) || /\/(run|webhook-secret)$/.test(p),
      ))
        expect([method, path, (await call(beto, method, path, payload)).status]).toEqual([method, path, 403]);
      expect((await call(beto, "GET", `${base}/${mine.id}/runs`)).status).toBe(200);
      // A routine whose channel the member doesn't read doesn't exist for them.
      const board = await seedChannel(server, workspaceId, {
        name: "board",
        visibility: "private",
        members: [ana],
      });
      await server.deps.db
        .insert(schema.channelMemberships)
        .values({ channelId: board, memberType: "agent", memberId: lia.id });
      const hidden = (
        await call(ana, "POST", base, {
          agentId: lia.id,
          prompt: "Secret",
          target: { kind: "channel", channelId: board },
          trigger: { kind: "webhook" },
        })
      ).body;
      expect((await call(beto, "GET", `${base}/${hidden.id}/runs`)).status).toBe(404);
      expect(
        ((await call(beto, "GET", base)).body.routines as { id: string }[]).map((r) => r.id),
      ).not.toContain(hidden.id);
      // An admin changes anyone's routine.
      const admin = await memberOf(server, workspaceId, "Adm", email("adm"), "admin");
      expect((await call(admin, "PATCH", `${base}/${mine.id}`, { name: "By admin" })).body.name).toBe(
        "By admin",
      );
    },
    SERVER_TEST_MS,
  );
});
