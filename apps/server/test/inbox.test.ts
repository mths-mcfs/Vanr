// Notifications: the inbox routes, Web Push subscriptions and notification delivery from end to end (a notice is created,
// goes out by push and email, and the final state is saved). No network: push goes out through the fake fetch
// and the test decrypts the body the way the browser would (push-receiver.ts). The notices are created with
// `notify`, the function chat, control and the other areas call (those routes come with later slices).
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import type { NotificationSettings } from "@vanr/contract";
import { schema } from "@vanr/engine/db";
import { newId } from "@vanr/engine/ids";
import { DEFAULT_SETTINGS } from "@vanr/engine/notify-rules";
import { and, eq } from "drizzle-orm";
import { createWorkspace, joinWorkspace } from "../src/members";
import { notificationTick, notify } from "../src/notifications";
import type { RealtimeEvent } from "../src/realtime/hub";
import type { RunningServer } from "../src/server";
import { Browser, signedIn, startTestServer } from "./harness";
import { checkVapid, fakeBrowser, type Browser as PushBrowser } from "./push-receiver";

// Many HTTP calls per test against a real server: a loaded host needs more than the default 5 s.
setDefaultTimeout(30_000);

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
let skew = 0;
let server: RunningServer;

/** What reached the push services. `status` per endpoint (201 by default). */
const pushed: { endpoint: string; headers: Record<string, string>; body: Uint8Array }[] = [];
const status = new Map<string, number>();
const fakeFetch = Object.assign(
  async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    pushed.push({
      endpoint: url,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: new Uint8Array(init?.body as Uint8Array),
    });
    return new Response(null, { status: status.get(url) ?? 201 });
  },
  { preconnect: () => {} },
) as typeof fetch;

const events: { target: string; event: RealtimeEvent }[] = [];
beforeAll(async () => {
  server = await startTestServer({ now: () => new Date(Date.now() + skew), fetchExternal: fakeFetch });
  server.deps.hub.onPublish((target, event) => events.push({ target, event }));
});
afterAll(() => server.stop());

let n = 0;
const email = (who: string) => `${who}${++n}@inbox.test`;
const settle = () => server.deps.runtime.settle();
const tick = async () => {
  await notificationTick(server.deps);
  await settle();
};
const endpoint = () => `https://fcm.googleapis.com/fcm/send/inbox-${++n}-${crypto.randomUUID()}`;

async function call(b: Browser, method: string, path: string, payload?: unknown) {
  const res = await b.json(path, method, payload);
  const text = await res.text();
  // biome-ignore lint/suspicious/noExplicitAny: in tests the body is checked by the assertions
  const json: any = text ? JSON.parse(text) : null;
  return { status: res.status, body: json };
}

/** Ana owns a workspace in UTC; Beto is a member. */
async function team() {
  const ana = await signedIn(server, "Ana", email("ana"));
  const { workspaceId, defaultChannelId } = await createWorkspace(server.deps.db, {
    name: "Inbox",
    context: "",
    timezone: "UTC",
    user: ana.user,
  });
  const beto = await signedIn(server, "Beto", email("beto"));
  await joinWorkspace(server.deps.db, { workspaceId, userId: beto.user.id, name: "Beto", role: "member" });
  return { workspaceId, general: defaultChannelId, ana, beto, base: `/api/v1/workspaces/${workspaceId}` };
}
type Team = Awaited<ReturnType<typeof team>>;

async function subscribe(p: { browser: Browser }): Promise<PushBrowser> {
  const b = fakeBrowser(endpoint());
  const res = await call(p.browser, "POST", "/api/v1/push/subscriptions", {
    endpoint: b.endpoint,
    keys: b.keys,
  });
  expect(res.status).toBe(200);
  return b;
}

const pushesTo = (b: PushBrowser) => pushed.filter((x) => x.endpoint === b.endpoint);
const settingsWith = (patch: Partial<NotificationSettings>): NotificationSettings => ({
  ...DEFAULT_SETTINGS,
  locale: "en",
  ...patch,
});
async function setSettings(t: Team, p: { browser: Browser }, patch: Partial<NotificationSettings>) {
  const res = await call(p.browser, "PUT", `${t.base}/notifications/settings`, settingsWith(patch));
  expect(res.status).toBe(200);
}

/** A mention in #general, as chat notifies it. */
async function mention(t: Team, to: { id: string }, from: { id: string }, text: string) {
  const messageId = newId("msg");
  await notify(server.deps, {
    workspaceId: t.workspaceId,
    userId: to.id,
    kind: "mention",
    groupKey: `mention:${messageId}`,
    actor: { type: "person", id: from.id },
    source: { channelId: t.general, messageId, label: "#general" },
    latest: { text },
  });
  return messageId;
}

/** A pending approval of the agent Lia, notified to whoever decides, as control does. */
async function approval(t: Team, to: { id: string }, title: string) {
  const agentId = newId("ag");
  await server.deps.db.insert(schema.agents).values({
    id: agentId,
    workspaceId: t.workspaceId,
    name: "Lia",
    handle: `lia${++n}`,
    model: "claude-haiku-5-5",
    ownerUserId: t.ana.user.id,
    appearance: { color: "blue", eyes: "dot", adornment: "none" },
  });
  const [row] = await server.deps.db
    .insert(schema.approvals)
    .values({
      id: newId("apr"),
      workspaceId: t.workspaceId,
      agentId,
      tool: "post_message",
      scope: "chat",
      title,
      expiresAt: new Date(Date.now() + skew + DAY),
    })
    .returning();
  if (!row) throw new Error("approval insert failed");
  await notify(server.deps, {
    workspaceId: t.workspaceId,
    userId: to.id,
    kind: "approval",
    groupKey: `approval:${row.id}`,
    actor: { type: "agent", id: agentId },
    waiting: true,
    source: { approvalId: row.id },
    latest: { title },
  });
  return row;
}

async function deliveriesOf(notificationId: string) {
  const rows = await server.deps.db
    .select()
    .from(schema.notificationDeliveries)
    .where(eq(schema.notificationDeliveries.notificationId, notificationId));
  return rows
    .map((r) => ({ channel: r.channel, status: r.status, note: r.note }))
    .sort((a, b) => a.channel.localeCompare(b.channel));
}

async function inbox(t: Team, p: { browser: Browser }, filter = "all") {
  const res = await call(p.browser, "GET", `${t.base}/notifications?filter=${filter}`);
  expect(res.status).toBe(200);
  return res.body as {
    items: { id: string; kind: string; tab: string; readAt: string | null }[];
    counts: unknown;
  };
}

describe("Web Push with VAPID", () => {
  test("attack: a subscription whose endpoint isn't a push service is rejected (SSRF)", async () => {
    const ana = await signedIn(server, "Ana", email("ana"));
    const keys = fakeBrowser("https://x").keys;
    for (const target of [
      "http://fcm.googleapis.com/fcm/send/x",
      "https://127.0.0.1/push",
      "https://169.254.169.254/latest/meta-data",
      "https://localhost:4400/api/v1/push/key",
      "https://fcm.googleapis.com:8443/fcm/send/x",
      "https://user:pass@fcm.googleapis.com/fcm/send/x",
      "https://fcm.googleapis.com.evil.example/x",
      "https://evil.example/?u=https://fcm.googleapis.com/",
      "file:///etc/passwd",
    ]) {
      const err = await call(ana.browser, "POST", "/api/v1/push/subscriptions", { endpoint: target, keys });
      expect([target, err.body.error.code]).toEqual([target, "push.endpoint"]);
    }
    const ok = fakeBrowser(endpoint());
    expect(
      (
        await call(ana.browser, "POST", "/api/v1/push/subscriptions", {
          endpoint: ok.endpoint,
          keys: { p256dh: "abc", auth: ok.keys.auth },
        })
      ).body.error.code,
    ).toBe("push.keys");
    expect(
      (
        await call(ana.browser, "POST", "/api/v1/push/subscriptions", {
          endpoint: ok.endpoint,
          keys: { p256dh: ok.keys.p256dh, auth: "c2hvcnQ" },
        })
      ).body.error.code,
    ).toBe("push.keys");
    expect(
      pushed.filter((p) => !p.endpoint.startsWith("https://fcm.googleapis.com/fcm/send/inbox-")),
    ).toEqual([]);
  });

  test("the subscription routes need a session; the body outside the schema is 400; past 20 devices the oldest goes", async () => {
    const anon = new Browser(server.url);
    const phone = fakeBrowser(endpoint());
    expect((await call(anon, "GET", "/api/v1/push/key")).status).toBe(401);
    expect(
      (await call(anon, "POST", "/api/v1/push/subscriptions", { endpoint: phone.endpoint, keys: phone.keys }))
        .status,
    ).toBe(401);
    expect(
      (
        await call(
          anon,
          "DELETE",
          `/api/v1/push/subscriptions?endpoint=${encodeURIComponent(phone.endpoint)}`,
        )
      ).status,
    ).toBe(401);

    const zoe = await signedIn(server, "Zoe", email("zoe"));
    const key = await call(zoe.browser, "GET", "/api/v1/push/key");
    expect(Buffer.from(key.body.publicKey, "base64url").length).toBe(65);
    for (const payload of [
      { endpoint: phone.endpoint },
      { endpoint: phone.endpoint, keys: { ...phone.keys, extra: "x" } },
      { endpoint: phone.endpoint, keys: phone.keys, surprise: true },
      { endpoint: `https://fcm.googleapis.com/fcm/send/${"x".repeat(2100)}`, keys: phone.keys },
    ]) {
      expect((await call(zoe.browser, "POST", "/api/v1/push/subscriptions", payload)).status).toBe(400);
    }
    expect((await call(zoe.browser, "DELETE", "/api/v1/push/subscriptions")).status).toBe(400);

    const devices: PushBrowser[] = [];
    for (let i = 0; i < 21; i++) {
      skew += 1000;
      devices.push(await subscribe(zoe));
    }
    const subs = await server.deps.db
      .select({ endpoint: schema.pushSubscriptions.endpoint })
      .from(schema.pushSubscriptions)
      .where(eq(schema.pushSubscriptions.userId, zoe.user.id));
    expect(subs.length).toBe(20);
    expect(subs.map((s) => s.endpoint)).not.toContain(devices[0]?.endpoint);
    // Subscribing the same device again updates it instead of adding a row.
    const again = await call(zoe.browser, "POST", "/api/v1/push/subscriptions", {
      endpoint: devices[20]?.endpoint,
      keys: devices[20]?.keys,
    });
    expect(again.status).toBe(200);
    const after = await server.deps.db
      .select({ id: schema.pushSubscriptions.id })
      .from(schema.pushSubscriptions)
      .where(eq(schema.pushSubscriptions.userId, zoe.user.id));
    expect(after.length).toBe(20);
  });

  test("a mention goes out encrypted to the device, with a valid VAPID and the direct link; a reaction doesn't", async () => {
    const t = await team();
    const publicKey: string = (await call(t.beto.browser, "GET", "/api/v1/push/key")).body.publicKey;
    await setSettings(t, t.beto, {});
    const phone = await subscribe(t.beto);
    await mention(t, t.beto.user, t.ana.user, "@beto I need you");
    await settle();
    const [sent] = pushesTo(phone);
    if (!sent) throw new Error("no push");
    const [item] = (await inbox(t, t.beto, "action_needed")).items;
    expect(sent.headers["content-encoding"]).toBe("aes128gcm");
    expect(Number(sent.headers.ttl)).toBe(86_400);
    expect(sent.headers.urgency).toBe("normal");
    checkVapid(sent.headers.authorization ?? "", phone.endpoint, publicKey, Date.now() + skew);
    expect(phone.decrypt(sent.body)).toEqual({
      title: "Ana mentioned you",
      body: "@beto I need you",
      url: `/workspace/${t.workspaceId}/notifications?open=${item?.id}`,
      tag: item?.id,
      notificationId: item?.id,
      workspaceId: t.workspaceId,
      critical: false,
    });
    // The final state: the push row sent, no email (a mention doesn't go by email by default).
    expect(await deliveriesOf(item?.id ?? "")).toEqual([{ channel: "push", status: "sent", note: "1/1" }]);

    const before = pushesTo(phone).length;
    await notify(server.deps, {
      workspaceId: t.workspaceId,
      userId: t.beto.user.id,
      kind: "reaction",
      groupKey: `reaction:${newId("msg")}`,
      actor: { type: "person", id: t.ana.user.id },
      source: { channelId: t.general },
      latest: { quote: "mine", emojis: ["🎉"] },
    });
    await settle();
    expect(pushesTo(phone).length).toBe(before);
  });

  test("read before it goes out isn't sent; a dead subscription (410) goes away; only its owner deletes a subscription", async () => {
    const t = await team();
    await setSettings(t, t.beto, { dndUntil: new Date(Date.now() + skew + HOUR).toISOString() });
    const phone = await subscribe(t.beto);
    await mention(t, t.beto.user, t.ana.user, "later");
    await settle();
    expect(pushesTo(phone)).toEqual([]);
    const [item] = (await inbox(t, t.beto)).items;
    expect(
      (await call(t.beto.browser, "POST", `${t.base}/notifications/${item?.id}/read`, { read: true })).status,
    ).toBe(200);
    skew += 2 * HOUR;
    await tick();
    expect(pushesTo(phone)).toEqual([]);
    expect(await deliveriesOf(item?.id ?? "")).toEqual([
      { channel: "push", status: "skipped", note: "read" },
    ]);

    status.set(phone.endpoint, 410);
    await mention(t, t.beto.user, t.ana.user, "again");
    await settle();
    expect(pushesTo(phone).length).toBe(1);
    const subs = await server.deps.db
      .select()
      .from(schema.pushSubscriptions)
      .where(eq(schema.pushSubscriptions.userId, t.beto.user.id));
    expect(subs).toEqual([]);

    const laptop = await subscribe(t.beto);
    const path = `/api/v1/push/subscriptions?endpoint=${encodeURIComponent(laptop.endpoint)}`;
    expect((await call(t.ana.browser, "DELETE", path)).body).toEqual({ removed: 0 });
    expect((await call(t.beto.browser, "DELETE", path)).body).toEqual({ removed: 1 });
  });
});

describe("notification delivery from end to end", () => {
  test("quiet hours hold a mention until they end; an open approval breaks through by push and is emailed once after the delay", async () => {
    const t = await team();
    const hhmm = (d: Date) => d.toISOString().slice(11, 16);
    const now = new Date(Date.now() + skew);
    await setSettings(t, t.ana, {
      quietHours: {
        enabled: true,
        start: hhmm(new Date(now.getTime() - HOUR)),
        end: hhmm(new Date(now.getTime() + 2 * HOUR)),
      },
    });
    const phone = await subscribe(t.ana);
    const mails = () =>
      server.mailer.sent().filter((m) => m.kind === "notification" && m.to === t.ana.user.email);

    await mention(t, t.ana.user, t.beto.user, "at night");
    const apr = await approval(t, t.ana.user, "Deploy");
    await settle();
    const items = (await inbox(t, t.ana, "action_needed")).items;
    const approvalItem = items.find((i) => i.kind === "approval");
    const mentionItem = items.find((i) => i.kind === "mention");
    const [crit] = pushesTo(phone);
    expect(pushesTo(phone).length).toBe(1);
    expect(phone.decrypt(crit?.body ?? new Uint8Array())).toMatchObject({
      critical: true,
      title: "Lia asked for your approval",
      notificationId: approvalItem?.id,
    });
    expect(crit?.headers.urgency).toBe("high");
    expect(mails()).toEqual([]);

    skew += 16 * MIN;
    await tick();
    const [mail] = mails();
    if (!mail) throw new Error("no email");
    expect(mail.link).toBe(`${server.url}/workspace/${t.workspaceId}/notifications?open=${approvalItem?.id}`);
    expect(mail.subject).not.toContain("\n");
    expect(pushesTo(phone).length).toBe(1);

    skew += 2 * HOUR;
    await tick();
    expect(pushesTo(phone).length).toBe(2);
    expect(phone.decrypt(pushesTo(phone)[1]?.body ?? new Uint8Array())).toMatchObject({
      notificationId: mentionItem?.id,
      critical: false,
    });
    await tick();
    expect(mails().length).toBe(1);
    expect(await deliveriesOf(approvalItem?.id ?? "")).toEqual([
      { channel: "email", status: "sent", note: null },
      { channel: "push", status: "sent", note: "1/1" },
    ]);
    expect(await deliveriesOf(mentionItem?.id ?? "")).toEqual([
      { channel: "push", status: "sent", note: "1/1" },
    ]);

    // The approval was decided: the next tick closes the notice, which no longer waits.
    await server.deps.db
      .update(schema.approvals)
      .set({ status: "approved" })
      .where(eq(schema.approvals.id, apr.id));
    await tick();
    const [closed] = await server.deps.db
      .select()
      .from(schema.notifications)
      .where(eq(schema.notifications.id, approvalItem?.id ?? ""));
    expect(closed).toMatchObject({ waiting: false, critical: false });
    expect(closed?.doneAt).not.toBeNull();
  });

  test("a saved notice outlives the 3-month retention; an unsaved one is deleted; an open request stays", async () => {
    const t = await team();
    await mention(t, t.beto.user, t.ana.user, "keep me");
    await mention(t, t.beto.user, t.ana.user, "forget me");
    await approval(t, t.beto.user, "Still open");
    const items = (await inbox(t, t.beto)).items;
    const keep = items.find((i) => i.kind === "mention" && i.id) ?? items[0];
    const saved = await call(t.beto.browser, "POST", `${t.base}/notifications/${keep?.id}/save`, {
      saved: true,
    });
    expect(saved.status).toBe(200);
    expect(saved.body.savedAt).not.toBeNull();
    skew += 91 * DAY;
    await tick();
    const left = await server.deps.db
      .select({ id: schema.notifications.id, kind: schema.notifications.kind })
      .from(schema.notifications)
      .where(
        and(
          eq(schema.notifications.workspaceId, t.workspaceId),
          eq(schema.notifications.userId, t.beto.user.id),
        ),
      );
    expect(left.map((r) => r.kind).sort()).toEqual(["approval", "mention"]);
    expect(left.find((r) => r.kind === "mention")?.id).toBe(keep?.id);
  });
});

describe("inbox routes", () => {
  test("list, counts and the realtime events: shown, hidden and counts_updated with every counter", async () => {
    const t = await team();
    await mention(t, t.beto.user, t.ana.user, "hello");
    await notify(server.deps, {
      workspaceId: t.workspaceId,
      userId: t.beto.user.id,
      kind: "reaction",
      groupKey: `reaction:${newId("msg")}`,
      actor: { type: "person", id: t.ana.user.id },
      source: { channelId: t.general },
      latest: { quote: "mine", emojis: ["👍"] },
    });
    const counts = {
      all: 2,
      actionNeeded: 1,
      fyi: 1,
      mentions: 1,
      reactions: 1,
      unread: 2,
      waiting: 0,
      badge: 1,
    };
    const list = await inbox(t, t.beto);
    expect(list.counts).toEqual(counts);
    expect((await call(t.beto.browser, "GET", `${t.base}/notifications/counts`)).body).toEqual(counts);
    expect((await inbox(t, t.beto, "fyi")).items.map((i) => i.kind)).toEqual(["reaction"]);
    expect((await inbox(t, t.beto, "mentions")).items.map((i) => i.kind)).toEqual(["mention"]);

    const target = `user:${t.workspaceId}:${t.beto.user.id}`;
    const mine = () => events.filter((e) => e.target === target).map((e) => e.event);
    const item = list.items.find((i) => i.kind === "mention");
    const from = mine().length;
    const read = await call(t.beto.browser, "POST", `${t.base}/notifications/${item?.id}/read`, {
      read: true,
    });
    expect(read.body.readAt).not.toBeNull();
    const done = await call(t.beto.browser, "POST", `${t.base}/notifications/${item?.id}/complete`, {
      done: true,
    });
    expect(done.body.doneAt).not.toBeNull();
    const sent = mine().slice(from);
    expect(sent.map((e) => e.type)).toEqual([
      "notification.shown",
      "notification.counts_updated",
      "notification.hidden",
      "notification.counts_updated",
    ]);
    expect(sent[3]).toMatchObject({
      counts: { ...counts, all: 1, actionNeeded: 0, mentions: 0, unread: 1, badge: 0 },
    });
    expect((await inbox(t, t.beto)).items.map((i) => i.kind)).toEqual(["reaction"]);
    await call(t.beto.browser, "POST", `${t.base}/notifications/${item?.id}/complete`, { done: false });
    expect((await inbox(t, t.beto)).items.length).toBe(2);

    const all = await call(t.beto.browser, "POST", `${t.base}/notifications/read-all`, { filter: "fyi" });
    expect(all.body.ids.length).toBe(1);
    expect((await call(t.beto.browser, "GET", `${t.base}/notifications/counts`)).body.unread).toBe(0);
  });

  test("approvals and an assignment's requests count in Action needed but not in the sidebar badge", async () => {
    const t = await team();
    await approval(t, t.beto.user, "Own badge");
    await notify(server.deps, {
      workspaceId: t.workspaceId,
      userId: t.beto.user.id,
      kind: "question_for_you",
      priority: "action_needed",
      groupKey: `assignment:${newId("asg")}:question:${newId("q")}`,
      source: {},
      latest: { text: "Which branch?" },
    });
    await mention(t, t.beto.user, t.ana.user, "badge me");
    const counts = (await call(t.beto.browser, "GET", `${t.base}/notifications/counts`)).body;
    expect(counts).toMatchObject({ actionNeeded: 3, waiting: 1, badge: 1 });
  });

  test("an open request can't be marked done; snooze and reminder reject the past; a done notice takes no reminder", async () => {
    const t = await team();
    await approval(t, t.beto.user, "Needs Beto");
    await mention(t, t.beto.user, t.ana.user, "snooze me");
    const items = (await inbox(t, t.beto)).items;
    const waiting = items.find((i) => i.kind === "approval");
    const plain = items.find((i) => i.kind === "mention");
    const rejected = await call(t.beto.browser, "POST", `${t.base}/notifications/${waiting?.id}/complete`, {
      done: true,
    });
    expect([rejected.status, rejected.body.error.code]).toEqual([409, "notification.waiting"]);

    const past = new Date(Date.now() + skew - MIN).toISOString();
    const snoozePast = await call(t.beto.browser, "POST", `${t.base}/notifications/${plain?.id}/snooze`, {
      until: past,
    });
    expect([snoozePast.status, snoozePast.body.error.code]).toEqual([400, "notification.snooze_past"]);
    const remindPast = await call(t.beto.browser, "POST", `${t.base}/notifications/${plain?.id}/remind`, {
      at: past,
    });
    expect([remindPast.status, remindPast.body.error.code]).toEqual([400, "notification.remind_past"]);

    const until = new Date(Date.now() + skew + HOUR).toISOString();
    const snoozed = await call(t.beto.browser, "POST", `${t.base}/notifications/${plain?.id}/snooze`, {
      until,
    });
    expect(snoozed.body.mutedUntil).toBe(until);
    expect((await inbox(t, t.beto)).items.map((i) => i.kind)).toEqual(["approval"]);
    skew += 2 * HOUR;
    await tick();
    const back = (await inbox(t, t.beto)).items.find((i) => i.id === plain?.id);
    expect(back?.readAt).toBeNull();

    await call(t.beto.browser, "POST", `${t.base}/notifications/${plain?.id}/complete`, { done: true });
    const later = new Date(Date.now() + skew + HOUR).toISOString();
    const remindDone = await call(t.beto.browser, "POST", `${t.base}/notifications/${plain?.id}/remind`, {
      at: later,
    });
    expect([remindDone.status, remindDone.body.error.code]).toEqual([409, "notification.done"]);
  });

  test("only the recipient touches a notice; a non-member gets 404 and no session 401", async () => {
    const t = await team();
    await mention(t, t.beto.user, t.ana.user, "for Beto");
    const [item] = (await inbox(t, t.beto)).items;
    const stranger = await signedIn(server, "Sam", email("sam"));
    const anon = new Browser(server.url);
    const routes: [string, string, unknown?][] = [
      ["GET", `${t.base}/notifications`],
      ["GET", `${t.base}/notifications/counts`],
      ["GET", `${t.base}/notifications/settings`],
      ["PUT", `${t.base}/notifications/settings`, settingsWith({})],
      ["POST", `${t.base}/notifications/read-all`, {}],
      ["POST", `${t.base}/notifications/${item?.id}/read`, { read: true }],
      ["POST", `${t.base}/notifications/${item?.id}/complete`, { done: true }],
      ["POST", `${t.base}/notifications/${item?.id}/save`, { saved: true }],
      ["POST", `${t.base}/notifications/${item?.id}/snooze`, { until: null }],
      ["POST", `${t.base}/notifications/${item?.id}/remind`, { at: null }],
    ];
    for (const [method, path, payload] of routes) {
      expect([method, path, (await call(anon, method, path, payload)).status]).toEqual([method, path, 401]);
      expect([method, path, (await call(stranger.browser, method, path, payload)).status]).toEqual([
        method,
        path,
        404,
      ]);
    }
    // Ana is a member (and the owner), but the notice is Beto's.
    for (const [method, path, payload] of routes.slice(5)) {
      expect([method, path, (await call(t.ana.browser, method, path, payload)).status]).toEqual([
        method,
        path,
        404,
      ]);
    }
    const [row] = await server.deps.db
      .select()
      .from(schema.notifications)
      .where(eq(schema.notifications.id, item?.id ?? ""));
    expect(row).toMatchObject({ readAt: null, doneAt: null, savedAt: null });
  });

  test("settings: unknown channel or agent and repeated rule ids are rejected; a rule moves the notices already in the inbox", async () => {
    const t = await team();
    const other = await team();
    await mention(t, t.beto.user, t.ana.user, "in general");
    const put = (s: NotificationSettings) =>
      call(t.beto.browser, "PUT", `${t.base}/notifications/settings`, s);
    const rule = { id: "r1", channelId: t.general, tab: "fyi" as const };
    for (const [s, code] of [
      [settingsWith({ rules: [{ ...rule, channelId: other.general }] }), "notification.unknown_channel"],
      [settingsWith({ channels: { [other.general]: { push: false } } }), "notification.unknown_channel"],
      [
        settingsWith({ rules: [{ id: "r2", agentId: "ag_nobody", tab: "fyi" }] }),
        "notification.unknown_agent",
      ],
      [settingsWith({ rules: [rule, { ...rule }] }), "notification.duplicate_rule"],
    ] as const) {
      const res = await put(s);
      expect([res.status, res.body.error.code]).toEqual([400, code]);
    }
    expect((await call(t.beto.browser, "GET", `${t.base}/notifications/settings`)).body.rules).toEqual([]);
    expect((await put(settingsWith({ rules: [rule] }))).status).toBe(200);
    const [moved] = (await inbox(t, t.beto)).items;
    expect(moved).toMatchObject({ tab: "fyi", ruleId: "r1" });
    expect((await call(t.beto.browser, "GET", `${t.base}/notifications/settings`)).body.rules).toEqual([
      rule,
    ]);
  });
});

describe("one person in two workspaces", () => {
  test("the path of workspace A doesn't reach the person's notice of workspace B", async () => {
    const a = await team();
    const { workspaceId: otherId } = await createWorkspace(server.deps.db, {
      name: "Other",
      context: "",
      timezone: "UTC",
      user: a.ana.user,
    });
    await joinWorkspace(server.deps.db, {
      workspaceId: otherId,
      userId: a.beto.user.id,
      name: "Beto",
      role: "member",
    });
    const b: Team = { ...a, workspaceId: otherId, base: `/api/v1/workspaces/${otherId}` };
    await mention(b, a.beto.user, a.ana.user, "in B");
    const [inB] = (await inbox(b, a.beto)).items;
    if (!inB) throw new Error("no notice in B");
    const future = new Date(Date.now() + skew + HOUR).toISOString();
    for (const [action, payload] of [
      ["read", { read: true }],
      ["complete", { done: true }],
      ["save", { saved: true }],
      ["snooze", { until: future }],
      ["remind", { at: future }],
    ] as const) {
      const res = await call(a.beto.browser, "POST", `${a.base}/notifications/${inB.id}/${action}`, payload);
      expect([action, res.status]).toEqual([action, 404]);
    }
    expect((await call(a.beto.browser, "POST", `${a.base}/notifications/read-all`, {})).body.ids).toEqual([]);
    expect((await inbox(a, a.beto)).items).toEqual([]);
    const [row] = await server.deps.db
      .select()
      .from(schema.notifications)
      .where(eq(schema.notifications.id, inB.id));
    expect(row).toMatchObject({
      readAt: null,
      doneAt: null,
      savedAt: null,
      mutedUntil: null,
      remindAt: null,
    });
  });
});

// Notices for one group at the same time add up in one row, without losing any.
describe("notices at the same time", () => {
  const N = 20;
  const rowsOf = (t: Team, userId: string, groupKey: string) =>
    server.deps.db
      .select()
      .from(schema.notifications)
      .where(
        and(
          eq(schema.notifications.workspaceId, t.workspaceId),
          eq(schema.notifications.userId, userId),
          eq(schema.notifications.groupKey, groupKey),
        ),
      );
  const dm = (t: Team, groupKey: string, i: number, actorId: string) =>
    notify(server.deps, {
      workspaceId: t.workspaceId,
      userId: t.beto.user.id,
      kind: "dm",
      groupKey,
      actor: { type: "person", id: actorId },
      source: { channelId: t.general, dmId: t.general },
      latest: { text: `message ${i}` },
    });

  test("N first notices of a new group: one row with count N", async () => {
    const t = await team();
    await Promise.all(Array.from({ length: N }, (_, i) => dm(t, "dm:fresh", i, t.ana.user.id)));
    await settle();
    const rows = await rowsOf(t, t.beto.user.id, "dm:fresh");
    expect(rows.length).toBe(1);
    expect(rows[0]?.count).toBe(N);
  });

  test("an existing notice and N more at once: count N + 1, the latest text is one of them", async () => {
    const t = await team();
    await dm(t, "dm:open", 0, t.ana.user.id);
    await Promise.all(Array.from({ length: N }, (_, i) => dm(t, "dm:open", i + 1, t.ana.user.id)));
    await settle();
    const [row, ...rest] = await rowsOf(t, t.beto.user.id, "dm:open");
    expect(rest).toEqual([]);
    expect(row?.count).toBe(N + 1);
    expect(Array.from({ length: N }, (_, i) => `message ${i + 1}`)).toContain(String(row?.latest.text));
  });

  test("N reactions at once by different people: every emoji kept, the latest actors first and once each", async () => {
    const t = await team();
    const people = await Promise.all(
      Array.from({ length: N }, async (_, i) => {
        const p = await server.deps.db
          .insert(schema.users)
          .values({ id: newId("u"), name: `R${i}`, email: email(`r${i}`) })
          .returning();
        return p[0]?.id ?? "";
      }),
    );
    const groupKey = `reaction:${newId("msg")}`;
    await Promise.all(
      people.map((id, i) =>
        notify(server.deps, {
          workspaceId: t.workspaceId,
          userId: t.beto.user.id,
          kind: "reaction",
          groupKey,
          actor: { type: "person", id },
          source: { channelId: t.general },
          latest: { quote: "mine", emojis: [`e${i}`] },
        }),
      ),
    );
    await settle();
    const [row, ...rest] = await rowsOf(t, t.beto.user.id, groupKey);
    expect(rest).toEqual([]);
    expect(row?.count).toBe(N);
    expect([...((row?.latest.emojis as string[] | undefined) ?? [])].sort()).toEqual(
      Array.from({ length: N }, (_, i) => `e${i}`).sort(),
    );
    const ids = row?.actors.map((x) => x.id) ?? [];
    expect(ids.length).toBe(5);
    expect(new Set(ids).size).toBe(5);
  });

  test("a done notice and N new ones at once: it reopens once, with count N", async () => {
    const t = await team();
    await dm(t, "dm:done", 0, t.ana.user.id);
    const [first] = await rowsOf(t, t.beto.user.id, "dm:done");
    await call(t.beto.browser, "POST", `${t.base}/notifications/${first?.id}/complete`, { done: true });
    await Promise.all(Array.from({ length: N }, (_, i) => dm(t, "dm:done", i + 1, t.ana.user.id)));
    await settle();
    const [row, ...rest] = await rowsOf(t, t.beto.user.id, "dm:done");
    expect(rest).toEqual([]);
    expect(row).toMatchObject({ count: N, doneAt: null, id: first?.id });
  });
});
