// A notification email followed from the provider's answer to the delivery row: it only becomes `sent` when
// the provider accepted it; a rejection worth retrying goes back to the queue with a growing wait and goes out
// on a later pass, and a final one is recorded as failed with its reason.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { schema } from "@vanr/engine/db";
import { DEFAULT_SETTINGS } from "@vanr/engine/notify-rules";
import { eq } from "drizzle-orm";
import { SERVER_TEST_MS, startTestServer } from "../test/harness";
import { resendMailer } from "./mailer";
import { drainDeliveries, scheduleDeliveries } from "./notify-delivery";
import type { RunningServer } from "./server";

const S = schema;
let clock = new Date("2026-11-14T12:00:00Z");
let server: RunningServer;
/** The provider's next answers, in order (a number is an HTTP status; `silent` never answers). */
let answers: (number | "silent")[] = [];
let requests = 0;
/** The idempotency key each request to the provider carried. */
let keys: (string | null)[] = [];

const provider: typeof fetch = Object.assign(
  (_url: string | URL | Request, init?: RequestInit) => {
    requests++;
    keys.push(new Headers(init?.headers).get("idempotency-key"));
    const next = answers.shift() ?? 200;
    if (next === "silent")
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    return Promise.resolve(new Response("{}", { status: next }));
  },
  { preconnect: () => {} },
);

beforeAll(async () => {
  server = await startTestServer({ now: () => clock });
  server.deps.mailer = resendMailer("k", "n@example.com", { fetch: provider, timeoutMs: 50 });
  await server.deps.db.insert(S.users).values({ id: "u", name: "U", email: "u@example.com" });
  await server.deps.db.insert(S.workspaces).values({ id: "w", name: "W", timezone: "UTC" });
  await server.deps.db
    .insert(S.members)
    .values({ workspaceId: "w", userId: "u", role: "member", handle: "u" });
  const settings = {
    ...DEFAULT_SETTINGS,
    emailDelayMinutes: 0,
    kinds: { mention: { email: true } },
    push: false,
  };
  await server.deps.db.insert(S.notificationSettings).values({ workspaceId: "w", userId: "u", settings });
}, SERVER_TEST_MS);
afterAll(() => server.stop(), SERVER_TEST_MS);

let seq = 0;
let delivery = "";
beforeEach(async () => {
  clock = new Date("2026-11-14T12:00:00Z");
  answers = [];
  requests = 0;
  keys = [];
  const id = `n${++seq}`;
  delivery = `d${seq}`;
  await server.deps.db.insert(S.notifications).values({
    id,
    workspaceId: "w",
    userId: "u",
    kind: "mention",
    groupKey: id,
    tab: "action_needed",
    reason: "mentioned",
    source: { label: "Ana" },
    latest: { text: "hello" },
    createdAt: clock,
    updatedAt: clock,
  });
  await server.deps.db.insert(S.notificationDeliveries).values({
    id: delivery,
    workspaceId: "w",
    userId: "u",
    notificationId: id,
    channel: "email",
    dueAt: clock,
    createdAt: clock,
  });
});

async function row() {
  const [d] = await server.deps.db
    .select()
    .from(S.notificationDeliveries)
    .where(eq(S.notificationDeliveries.id, delivery));
  return { status: d?.status, attempts: d?.attempts, note: d?.note, dueAt: d?.dueAt.toISOString() };
}

const later = (minutes: number) => new Date(clock.getTime() + minutes * 60_000);

describe("email delivery of a notification", () => {
  test("accepted: sent", async () => {
    expect(await drainDeliveries(server.deps)).toBe(1);
    expect(await row()).toMatchObject({ status: "sent", attempts: 1 });
  });

  for (const answer of [429, 500, "silent"] as const) {
    test(`rejected with ${answer}: back to the queue, and out on a later pass once the provider accepts`, async () => {
      answers = [answer];
      expect(await drainDeliveries(server.deps)).toBe(0);
      const reason = answer === "silent" ? "timeout" : `http_${answer}`;
      expect(await row()).toEqual({
        status: "pending",
        attempts: 1,
        note: `email_${reason}`,
        dueAt: later(2).toISOString(),
      });
      // Not due yet: the same pass time sends nothing.
      expect(await drainDeliveries(server.deps)).toBe(0);
      clock = later(2);
      expect(await drainDeliveries(server.deps)).toBe(1);
      expect(await row()).toMatchObject({ status: "sent", attempts: 2 });
      expect(requests).toBe(2);
      // Both attempts are the same delivery to the provider: an accepted first one isn't sent again.
      expect(keys).toEqual([`notification-delivery/${delivery}`, `notification-delivery/${delivery}`]);
    });
  }

  test("rejected for good (400): failed with the reason, never sent again", async () => {
    answers = [400];
    expect(await drainDeliveries(server.deps)).toBe(0);
    expect(await row()).toMatchObject({ status: "failed", attempts: 1, note: "email_http_400" });
    clock = later(60);
    expect(await drainDeliveries(server.deps)).toBe(0);
    expect(requests).toBe(1);
  });

  test("rejected on every attempt: failed after the last one, with growing waits", async () => {
    answers = [429, 429, 429];
    const start = clock;
    expect(await drainDeliveries(server.deps)).toBe(0);
    expect((await row()).dueAt).toBe(new Date(start.getTime() + 2 * 60_000).toISOString());
    clock = new Date(start.getTime() + 2 * 60_000);
    expect(await drainDeliveries(server.deps)).toBe(0);
    expect((await row()).dueAt).toBe(new Date(clock.getTime() + 4 * 60_000).toISOString());
    clock = new Date(clock.getTime() + 4 * 60_000);
    expect(await drainDeliveries(server.deps)).toBe(0);
    expect(await row()).toMatchObject({ status: "failed", attempts: 3, note: "email_http_429" });
    expect(requests).toBe(3);
  });
});

/**
 * A double of Resend's idempotency contract: an accepted key is kept with its body; the same key and body
 * answer the first response without sending again, the same key with another body answers 409
 * `invalid_idempotent_request`. The first accepted request loses its response on the way back.
 */
function resendWithKeys() {
  const kept = new Map<string, string>();
  const sentBodies: string[] = [];
  let lose = true;
  const fetchFn: typeof fetch = Object.assign(
    async (_url: string | URL | Request, init?: RequestInit) => {
      const key = new Headers(init?.headers).get("idempotency-key") ?? "";
      const body = String(init?.body);
      const old = kept.get(key);
      if (old !== undefined)
        return old === body
          ? Response.json({ id: "first" })
          : Response.json({ name: "invalid_idempotent_request" }, { status: 409 });
      kept.set(key, body);
      sentBodies.push(body);
      if (lose) {
        lose = false;
        throw new DOMException("accepted, but the response was lost", "TimeoutError");
      }
      return Response.json({ id: String(sentBodies.length) });
    },
    { preconnect: () => {} },
  );
  return { fetchFn, sentBodies };
}

describe("email delivery against the provider's idempotency keys", () => {
  test("the notice changed after an accepted attempt whose answer was lost: sent once, and rescheduling sends nothing more", async () => {
    const provider = resendWithKeys();
    const mailer = server.deps.mailer;
    server.deps.mailer = resendMailer("k", "n@example.com", { fetch: provider.fetchFn });
    try {
      expect(await drainDeliveries(server.deps)).toBe(0);
      expect(await row()).toMatchObject({ status: "pending", note: "email_timeout" });
      // The author and the text of the notice change before the retry: the email would be another body.
      const [d] = await server.deps.db
        .select()
        .from(S.notificationDeliveries)
        .where(eq(S.notificationDeliveries.id, delivery));
      await server.deps.db
        .update(S.notifications)
        .set({ source: { label: "Bia" }, latest: { text: "updated" } })
        .where(eq(S.notifications.id, d?.notificationId ?? ""));
      clock = later(2);
      await drainDeliveries(server.deps);
      expect(await row()).toMatchObject({ status: "sent", attempts: 2, note: "email_already_accepted" });
      const [notice] = await server.deps.db
        .select()
        .from(S.notifications)
        .where(eq(S.notifications.id, d?.notificationId ?? ""));
      if (!notice) throw new Error("no notification");
      await scheduleDeliveries(server.deps, notice);
      await server.deps.runtime.settle();
      clock = later(5);
      await drainDeliveries(server.deps);
      expect(provider.sentBodies.length).toBe(1);
    } finally {
      server.deps.mailer = mailer;
    }
  });
});
