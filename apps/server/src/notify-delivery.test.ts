// A notification email followed from the provider's answer to the delivery row: it only becomes `sent` when
// the provider accepted it; a rejection worth retrying goes back to the queue with a growing wait and goes out
// on a later pass, and a final one is recorded as failed with its reason.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { schema } from "@vanr/engine/db";
import { DEFAULT_SETTINGS } from "@vanr/engine/notify-rules";
import { eq } from "drizzle-orm";
import { SERVER_TEST_MS, startTestServer } from "../test/harness";
import { resendMailer } from "./mailer";
import { drainDeliveries } from "./notify-delivery";
import type { RunningServer } from "./server";

const S = schema;
let clock = new Date("2026-11-14T12:00:00Z");
let server: RunningServer;
/** The provider's next answers, in order (a number is an HTTP status; `silent` never answers). */
let answers: (number | "silent")[] = [];
let requests = 0;

const provider: typeof fetch = Object.assign(
  (_url: string | URL | Request, init?: RequestInit) => {
    requests++;
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
