// Reliable routines through routes/routines: starts paused, one execution per key, the signed webhook (the
// `webhook-id` as the dedupe key, the secret out of every JSON, the body read with a cap before the signature is
// checked) and the entry that rejects a target the runtime would run (slice S6) before recording anything.
// The routines here open a debate, which needs no runtime; the scenarios that run an agent in a conversation, the
// caps of a run and the retries on a model failure wait for the runtime (the ledger lists them).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { RoutineInput } from "@vanr/contract";
import { schema } from "@vanr/engine/db";
import { eq } from "drizzle-orm";
import { MAX_WEBHOOK_BODY } from "../src/routes/routines";
import { dueRoutines, fireRoutineEvent } from "../src/routines";
import type { RunningServer } from "../src/server";
import { signWebhook } from "../src/webhook-signature";
import { SERVER_TEST_MS, signedIn, startTestServer } from "./harness";
import { call, seedAgent, ws } from "./route-calls";
import { memberOf, seedWorkspace } from "./seed";

let skew = 0;
const MIN = 60_000;
const HOUR = 60 * MIN;
let server: RunningServer;
beforeAll(async () => {
  server = await startTestServer({ now: () => new Date(Date.now() + skew) });
}, SERVER_TEST_MS);
afterAll(() => server.stop(), SERVER_TEST_MS);

let n = 0;
const email = (who: string) => `${who}${++n}@routines-reliability.test`;
const settle = () => server.deps.runtime.settle();

async function team() {
  const ana = await signedIn(server, "Ana", email("ana"));
  const { workspaceId, general } = await seedWorkspace(server, ana, "Routine P0");
  const lia = await seedAgent(server, workspaceId, ana, "lia", [general]);
  const base = `${ws(workspaceId)}/routines`;
  const create = async (input: Partial<RoutineInput> & Pick<RoutineInput, "trigger">) => {
    const res = await call(ana, "POST", base, {
      agentId: lia.id,
      prompt: "Summary",
      target: { kind: "debate", agentIds: [lia.id], roundLimit: 1 },
      ...input,
    });
    if (res.status !== 201) throw new Error(`create failed: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body;
  };
  return { workspaceId, general, ana, lia, base, create };
}

const runsOf = (routineId: string) =>
  server.deps.db
    .select()
    .from(schema.routineExecutions)
    .where(eq(schema.routineExecutions.routineId, routineId));

const hourly = { kind: "schedule" as const, rule: { freq: "hourly" as const, timezone: "UTC" } };

describe("F4-3.3-P0-08: a new routine starts paused", () => {
  test(
    "without asking, the routine starts paused and the tick doesn't run it; turning it on is explicit",
    async () => {
      const { create } = await team();
      const paused = await create({ trigger: hourly });
      expect(paused).toMatchObject({ active: false, nextFireAt: null });
      skew += 2 * HOUR;
      await dueRoutines(server.deps);
      await settle();
      expect(await runsOf(paused.id)).toHaveLength(0);
      const on = await create({ trigger: hourly, active: true });
      expect(on.active).toBe(true);
      expect(on.nextFireAt).not.toBeNull();
    },
    SERVER_TEST_MS,
  );
});

describe("F4-3.3-P0-01: one execution per key", () => {
  test(
    "an event with the same id and 'Run now' with the same key run once",
    async () => {
      const { workspaceId, ana, base, create } = await team();
      const ev = await create({ trigger: { kind: "event", event: "issue.created" }, active: true });
      const fire = () =>
        fireRoutineEvent(server.deps, {
          workspaceId,
          event: "issue.created",
          eventId: "iss_1",
          context: "Issue #1",
        });
      await Promise.all([fire(), fire()]);
      await settle();
      await fire();
      await settle();
      expect(await runsOf(ev.id)).toHaveLength(1);

      const manual = await create({ trigger: { kind: "webhook" } });
      const runs = await Promise.all([
        call(ana, "POST", `${base}/${manual.id}/run`, { key: "click-1" }),
        call(ana, "POST", `${base}/${manual.id}/run`, { key: "click-1" }),
      ]);
      expect(runs.map((r) => [r.status, r.body.running])).toEqual([
        [200, true],
        [200, true],
      ]);
      await settle();
      await call(ana, "POST", `${base}/${manual.id}/run`, { key: "click-2" });
      await settle();
      const rows = await runsOf(manual.id);
      expect(rows.map((x) => x.dedupeKey).sort()).toEqual(["manual:click-1", "manual:click-2"]);
    },
    SERVER_TEST_MS,
  );

  test(
    "'Run now' of a routine that talks in a channel is rejected before the fire is recorded (no runtime yet)",
    async () => {
      const { ana, base, general, create } = await team();
      const r = await create({
        trigger: { kind: "webhook" },
        target: { kind: "channel", channelId: general },
      });
      const res = await call(ana, "POST", `${base}/${r.id}/run`, { key: "k" });
      expect([res.status, res.body.error.code, res.body.error.params]).toEqual([
        503,
        "not_available",
        { method: "runFor" },
      ]);
      expect(await runsOf(r.id)).toHaveLength(0);
    },
    SERVER_TEST_MS,
  );
});

describe("F4-3.3-P0-06: signed webhook, the webhook-id as the dedupe key, the secret out of the JSON", () => {
  async function hookTeam() {
    const t = await team();
    const r = await t.create({ trigger: { kind: "webhook" }, prompt: "Warn", active: true });
    const path = new URL(r.webhookUrl ?? "").pathname;
    return { ...t, r, path };
  }
  const send = (path: string, body: string, headers: Record<string, string>) =>
    fetch(`${server.url}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
    });
  const codeOf = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;
  const signed = (secret: string, id: string, body: string, at = Date.now() + skew) => {
    const ts = Math.floor(at / 1000);
    return {
      "webhook-id": id,
      "webhook-timestamp": String(ts),
      "webhook-signature": signWebhook(secret, id, ts, body),
    };
  };

  test(
    "no secret, no signature, a wrong signature, outside the window and repeated: nothing runs",
    async () => {
      const { ana, base, r, path } = await hookTeam();
      const body = JSON.stringify({ order: 1 });
      expect((await send(path, body, {})).status).toBe(401); // no secret yet
      const { secret } = (await call(ana, "POST", `${base}/${r.id}/webhook-secret`)).body;
      expect(secret.startsWith("whsec_")).toBe(true);

      const none = await send(path, body, {});
      expect([none.status, await codeOf(none)]).toEqual([401, "webhook.unsigned"]);
      const forged = await send(path, body, signed("whsec_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "m1", body));
      expect([forged.status, await codeOf(forged)]).toEqual([401, "webhook.bad_signature"]);
      // The body changed after it was signed.
      const tampered = await send(path, JSON.stringify({ order: 2 }), signed(secret, "m1", body));
      expect(tampered.status).toBe(401);
      const old = await send(path, body, signed(secret, "m1", body, Date.now() + skew - 10 * MIN));
      expect([old.status, await codeOf(old)]).toEqual([401, "webhook.stale"]);
      await settle();
      expect(await runsOf(r.id)).toHaveLength(0);

      const ok = await send(path, body, signed(secret, "m1", body));
      expect(ok.status).toBe(202);
      const again = await send(path, body, signed(secret, "m1", body));
      expect([again.status, await again.json()]).toEqual([200, { ok: true, duplicate: true }]);
      await settle();
      const rows = await runsOf(r.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: "ok", trigger: "webhook", dedupeKey: "webhook:m1" });

      // A new secret: the old one stops working. Another message (another id) fires again.
      const { secret: next } = (await call(ana, "POST", `${base}/${r.id}/webhook-secret`)).body;
      expect((await send(path, body, signed(secret, "m2", body))).status).toBe(401);
      expect((await send(path, body, signed(next, "m2", body))).status).toBe(202);
      await settle();
      expect((await runsOf(r.id)).map((x) => x.dedupeKey).sort()).toEqual(["webhook:m1", "webhook:m2"]);
    },
    SERVER_TEST_MS,
  );

  test(
    "the signature decides, not the content-type: a text or untyped body fires, an unsigned form is 401",
    async () => {
      const { ana, base, r, path } = await hookTeam();
      const { secret } = (await call(ana, "POST", `${base}/${r.id}/webhook-secret`)).body;
      const raw = (body: string, headers: Record<string, string>) =>
        fetch(`${server.url}${path}`, { method: "POST", headers, body });
      const text = "order=1";
      const plain = await raw(text, { "content-type": "text/plain", ...signed(secret, "t1", text) });
      expect(plain.status).toBe(202);
      // fetch sends a string body as text/plain unless told otherwise; a Blob without a type sends none.
      const untyped = await fetch(`${server.url}${path}`, {
        method: "POST",
        headers: signed(secret, "t2", text),
        body: new Blob([text]),
      });
      expect(untyped.status).toBe(202);
      const form = await raw(text, { "content-type": "application/x-www-form-urlencoded" });
      expect([form.status, await codeOf(form)]).toEqual([401, "webhook.unsigned"]);
      await settle();
      expect((await runsOf(r.id)).map((x) => x.dedupeKey).sort()).toEqual(["webhook:t1", "webhook:t2"]);
    },
    SERVER_TEST_MS,
  );

  test(
    "the secret never shows in the routine's JSON and stays sealed in the database",
    async () => {
      const { workspaceId, ana, base, r } = await hookTeam();
      const { secret } = (await call(ana, "POST", `${base}/${r.id}/webhook-secret`)).body;
      const responses: unknown[] = [
        (await call(ana, "GET", base)).body,
        (await call(ana, "PATCH", `${base}/${r.id}`, { prompt: "Warn again" })).body,
        (await call(ana, "PATCH", `${base}/${r.id}`, { active: true })).body,
        (await call(ana, "POST", `${base}/${r.id}/run`, {})).body,
        (await call(ana, "POST", `${base}/${r.id}/duplicate`, {})).body,
        (await call(ana, "GET", `${base}/${r.id}/runs`)).body,
      ];
      await settle();
      const text = JSON.stringify(responses);
      expect(text).not.toContain(secret);
      expect(text).not.toContain("whsec_");
      const listed = ((await call(ana, "GET", base)).body.routines as { id: string }[]).find(
        (x) => x.id === r.id,
      );
      expect(listed).toMatchObject({ webhookHasSecret: true });
      const [row] = await server.deps.db.select().from(schema.routines).where(eq(schema.routines.id, r.id));
      expect(row?.webhookSecret).not.toContain(secret.slice(6));
      // Whoever doesn't edit the routine doesn't make a secret.
      const beto = await memberOf(server, workspaceId, "Beto", email("beto"));
      expect((await call(beto, "POST", `${base}/${r.id}/webhook-secret`)).status).toBe(403);
    },
    SERVER_TEST_MS,
  );

  test(
    "a paused routine rejects the webhook only after the signature (no state leaks to who doesn't sign)",
    async () => {
      const { ana, base, r, path } = await hookTeam();
      const { secret } = (await call(ana, "POST", `${base}/${r.id}/webhook-secret`)).body;
      await call(ana, "PATCH", `${base}/${r.id}`, { active: false });
      const body = "{}";
      expect((await send(path, body, {})).status).toBe(401);
      const paused = await send(path, body, signed(secret, "p1", body));
      expect([paused.status, await codeOf(paused)]).toEqual([409, "routine.inactive"]);
      expect(await runsOf(r.id)).toHaveLength(0);
    },
    SERVER_TEST_MS,
  );

  test(
    "a body over the cap is rejected before the signature, with and without content-length, and writes nothing",
    async () => {
      const { ana, base, r, path } = await hookTeam();
      const { secret } = (await call(ana, "POST", `${base}/${r.id}/webhook-secret`)).body;
      const big = JSON.stringify({ blob: "a".repeat(MAX_WEBHOOK_BODY) });
      const declared = await send(path, big, signed(secret, "b1", big));
      expect([declared.status, await codeOf(declared)]).toEqual([413, "payload_too_large"]);
      // At the cap exactly it passes (the constant is the limit, not one byte under it).
      const fits = JSON.stringify({ blob: "a".repeat(MAX_WEBHOOK_BODY - 11) });
      expect(new TextEncoder().encode(fits).byteLength).toBe(MAX_WEBHOOK_BODY);
      expect((await send(path, fits, signed(secret, "b2", fits))).status).toBe(202);
      await settle();
      expect((await runsOf(r.id)).map((x) => x.dedupeKey)).toEqual(["webhook:b2"]);

      // A chunked body without content-length: it stops reading at the cap.
      let pulled = 0;
      const chunk = new Uint8Array(1 << 20).fill(97);
      const stream = new ReadableStream({
        pull(c) {
          if (pulled >= 64) return c.close();
          pulled++;
          c.enqueue(chunk);
        },
      });
      const res = await fetch(`${server.url}${path}`, {
        method: "POST",
        body: stream,
        headers: { "content-type": "application/json", ...signed(secret, "b3", "") },
        duplex: "half",
      } as RequestInit);
      expect(res.status).toBe(413);
      expect(pulled).toBeLessThan(8);
      expect(await runsOf(r.id)).toHaveLength(1);
    },
    SERVER_TEST_MS,
  );

  test(
    "a webhook whose routine talks in a channel is rejected at its entry after the signature (no runtime yet)",
    async () => {
      const { ana, base, general, create } = await team();
      const r = await create({
        trigger: { kind: "webhook" },
        target: { kind: "channel", channelId: general },
        active: true,
      });
      const { secret } = (await call(ana, "POST", `${base}/${r.id}/webhook-secret`)).body;
      const path = new URL(r.webhookUrl).pathname;
      const res = await send(path, "{}", signed(secret, "c1", "{}"));
      expect([res.status, await codeOf(res)]).toEqual([503, "not_available"]);
      expect(await runsOf(r.id)).toHaveLength(0);
    },
    SERVER_TEST_MS,
  );
});
