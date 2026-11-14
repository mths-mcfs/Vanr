// The realtime client against a fake socket and a manual clock: reconnection with a growing, capped wait,
// subscriptions sent again after a reconnect, the close codes that end it, and typed, validated events.
import { describe, expect, test } from "bun:test";
import { ManualClock } from "../src/clock.ts";
import { BROWSER_EVENTS, NOT_BROWSER_EVENTS } from "../src/realtime/events.ts";
import {
  type AnyRealtimeEvent,
  PING_EVERY_MS,
  RECONNECT_BASE_MS,
  RECONNECT_CAP_MS,
  RealtimeClient,
  type RealtimeStatus,
  reconnectDelay,
  SILENCE_LIMIT_MS,
  STABLE_AFTER_MS,
} from "../src/realtime/socket.ts";
import { fakeSockets } from "../src/testing/fake-socket.ts";
import table from "./event-table.json";

function setup(extra: Partial<ConstructorParameters<typeof RealtimeClient>[0]> = {}) {
  const clock = new ManualClock();
  const sockets = fakeSockets();
  const statuses: RealtimeStatus[] = [];
  const rt = new RealtimeClient({
    baseUrl: "https://vanr.test",
    workspaceId: "ws_1",
    clock,
    random: () => 1,
    createSocket: sockets.create,
    ...extra,
  });
  rt.onStatus((s) => statuses.push(s));
  return { clock, sockets, rt, statuses };
}

const message = {
  id: "msg_1",
  actions: [],
  agentMentionIds: [],
  author: { id: "user_1", type: "person" },
};

describe("event table", () => {
  test("every event name in the server's table is either delivered or listed as not for browsers", () => {
    const covered = [...Object.keys(BROWSER_EVENTS), ...Object.keys(NOT_BROWSER_EVENTS)].sort();
    expect(covered).toEqual([...table.events].sort());
    expect(table.events).toHaveLength(129);
  });

  test("no name is in both lists", () => {
    const both = Object.keys(BROWSER_EVENTS).filter((n) => Object.hasOwn(NOT_BROWSER_EVENTS, n));
    expect(both).toEqual([]);
  });
});

describe("connection", () => {
  test("connects to the workspace's socket URL", () => {
    const { rt, sockets } = setup();
    rt.start();
    expect(sockets.last.url).toBe("wss://vanr.test/api/v1/realtime?workspaceId=ws_1");
  });

  test("the wait doubles from the base and stops at the cap", () => {
    const full = (n: number) => reconnectDelay(n, () => 1);
    expect([0, 1, 2, 3].map(full)).toEqual([500, 1000, 2000, 4000]);
    expect(full(20)).toBe(RECONNECT_CAP_MS);
    // With jitter it stays between half and all of the ceiling.
    expect(reconnectDelay(0, () => 0)).toBe(RECONNECT_BASE_MS / 2);
  });

  test("reconnects after a drop, waiting longer each time", () => {
    const { rt, sockets, clock } = setup();
    rt.start();
    sockets.last.open();
    sockets.last.drop();
    expect(sockets.sockets).toHaveLength(1);
    expect(clock.pending()).toEqual([500]);
    clock.advance(500);
    expect(sockets.sockets).toHaveLength(2);
    sockets.last.drop();
    expect(clock.pending()).toEqual([1000]);
  });

  test("connections that are accepted and cut right away keep the wait growing up to the cap", () => {
    const { rt, sockets, clock } = setup();
    rt.start();
    const delays: number[] = [];
    for (let i = 0; i < 8; i++) {
      sockets.last.open();
      sockets.last.drop();
      const delay = clock.pending()[0] ?? -1;
      delays.push(delay);
      clock.advance(delay);
    }
    expect(delays).toEqual([500, 1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  });

  test("only a connection that stayed open long enough brings the wait back to the base", () => {
    const { rt, sockets, clock } = setup();
    rt.start();
    for (const wait of [500, 1000, 2000]) {
      sockets.last.open();
      sockets.last.drop();
      clock.advance(wait);
    }
    sockets.last.open();
    clock.advance(STABLE_AFTER_MS - 1);
    sockets.last.drop();
    expect(clock.pending()).toEqual([4000]);
    clock.advance(4000);
    sockets.last.open();
    clock.advance(STABLE_AFTER_MS);
    sockets.last.drop();
    expect(clock.pending()).toEqual([500]);
  });

  test("subscribes again to every channel and live view after reconnecting", () => {
    const { rt, sockets, clock } = setup();
    rt.start();
    sockets.last.open();
    rt.subscribe("ch_1");
    rt.subscribe("ch_2");
    rt.unsubscribe("ch_2");
    rt.watchLiveView("agt_1");
    sockets.last.drop();
    clock.advance(500);
    sockets.last.open();
    expect(sockets.last.sent).toEqual([
      { type: "subscribe", channelId: "ch_1" },
      { type: "live_view.subscribe", agentId: "agt_1" },
    ]);
  });

  test("asks the app to refetch after a reconnect, not after the first connection", () => {
    let refetches = 0;
    const { rt, sockets, clock } = setup({ onReconnect: () => refetches++ });
    rt.start();
    sockets.last.open();
    expect(refetches).toBe(0);
    sockets.last.drop();
    clock.advance(500);
    sockets.last.open();
    expect(refetches).toBe(1);
  });

  test("4401 ends it: no reconnect, and the app is told the session ended", () => {
    const ended: string[] = [];
    const { rt, sockets, clock, statuses } = setup({ onEnded: (s) => ended.push(s) });
    rt.start();
    sockets.last.open();
    sockets.last.drop(4401, "session ended");
    clock.advance(RECONNECT_CAP_MS * 2);
    expect(sockets.sockets).toHaveLength(1);
    expect(ended).toEqual(["signed_out"]);
    expect(statuses.at(-1)).toBe("signed_out");
  });

  test("4003 (removed from the workspace) also ends it", () => {
    const ended: string[] = [];
    const { rt, sockets, clock } = setup({ onEnded: (s) => ended.push(s) });
    rt.start();
    sockets.last.open();
    sockets.last.drop(4003, "removed");
    clock.advance(RECONNECT_CAP_MS);
    expect(sockets.sockets).toHaveLength(1);
    expect(ended).toEqual(["removed"]);
  });

  test("stop closes the socket and cancels a pending reconnect", () => {
    const { rt, sockets, clock } = setup();
    rt.start();
    sockets.last.open();
    sockets.last.drop();
    rt.stop();
    clock.advance(RECONNECT_CAP_MS);
    expect(sockets.sockets).toHaveLength(1);
    expect(rt.status).toBe("stopped");
  });

  test("pings while open and replaces a connection that went silent", () => {
    const { rt, sockets, clock } = setup();
    rt.start();
    sockets.last.open();
    clock.advance(PING_EVERY_MS);
    expect(sockets.last.sent).toContainEqual({ type: "ping" });
    clock.advance(SILENCE_LIMIT_MS);
    expect(sockets.sockets[0]?.closedWith?.code).toBe(4000);
    clock.advance(RECONNECT_BASE_MS);
    expect(sockets.sockets).toHaveLength(2);
  });

  test("a channel the server stops sending is dropped and reported", () => {
    const lost: string[] = [];
    const { rt, sockets, clock } = setup({ onUnsubscribed: (c) => lost.push(c) });
    rt.start();
    sockets.last.open();
    rt.subscribe("ch_1");
    sockets.last.push({ type: "unsubscribed", channelId: "ch_1" });
    expect(lost).toEqual(["ch_1"]);
    sockets.last.drop();
    clock.advance(500);
    sockets.last.open();
    expect(sockets.last.sent).toEqual([]);
  });
});

describe("events", () => {
  test("delivers a validated, typed event with its scope", () => {
    const { rt, sockets } = setup();
    const got: AnyRealtimeEvent[] = [];
    rt.on("runner.presence_changed", (e) => {
      const online: boolean = e.payload.online;
      expect(typeof online).toBe("boolean");
    });
    rt.onAny((e) => got.push(e));
    rt.start();
    sockets.last.open();
    sockets.last.push({
      type: "event",
      scope: "workspace",
      event: { type: "runner.presence_changed", runnerId: "rnr_1", online: true, extra: 1 },
    });
    sockets.last.push({
      type: "event",
      channelId: "ch_1",
      event: { type: "message.claimed", messageId: "msg_1", agentId: "agt_1" },
    });
    expect(got).toEqual([
      {
        type: "runner.presence_changed",
        payload: { runnerId: "rnr_1", online: true },
        scope: { kind: "workspace" },
      },
      {
        type: "message.claimed",
        payload: { messageId: "msg_1", agentId: "agt_1" },
        scope: { kind: "channel", channelId: "ch_1" },
      },
    ]);
  });

  test("drops an event whose payload breaks its schema, and says why", () => {
    const ignored: string[] = [];
    const { rt, sockets } = setup({ onIgnoredFrame: (i) => ignored.push(i.reason) });
    const got: unknown[] = [];
    rt.onAny((e) => got.push(e));
    rt.start();
    sockets.last.open();
    sockets.last.push({ type: "event", event: { type: "message.posted", message: message } });
    sockets.last.push({ type: "event", event: { type: "made.up" } });
    sockets.last.push("not json");
    expect(got).toEqual([]);
    expect(ignored).toHaveLength(3);
    expect(ignored[0]).toContain("message.posted");
    expect(ignored[1]).toBe("unknown event made.up");
  });

  test("a listener for one event doesn't hear the others", () => {
    const { rt, sockets } = setup();
    const heard: string[] = [];
    const off = rt.on("runner.deleted", (e) => heard.push(e.payload.runnerId));
    rt.start();
    sockets.last.open();
    sockets.last.push({ type: "event", event: { type: "runner.paired", runnerId: "rnr_1" } });
    sockets.last.push({ type: "event", event: { type: "runner.deleted", runnerId: "rnr_2" } });
    off();
    sockets.last.push({ type: "event", event: { type: "runner.deleted", runnerId: "rnr_3" } });
    expect(heard).toEqual(["rnr_2"]);
  });
});
