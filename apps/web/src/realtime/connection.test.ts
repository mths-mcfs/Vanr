import { describe, expect, test } from "bun:test";
import { FakeServer } from "../../dev/fake-server.ts";
import { fakeSocketOpener, newJar } from "../../dev/fake-wire.ts";
import { manualClock } from "../../test/clock.ts";
import {
  ACCESS_ENDED_CODE,
  openRealtime,
  PING_INTERVAL_MS,
  parseServerFrame,
  RECONNECT_DELAYS_MS,
  type RealtimeEvent,
  type SocketHandlers,
} from "./connection.ts";

/** Lets the fake server's queued socket callbacks run. */
const settle = () => new Promise<void>((resolve) => queueMicrotask(resolve));

function setup() {
  const server = new FakeServer();
  const jar = newJar();
  jar.session = server.sessionFor("usr_ana");
  const clock = manualClock();
  const log: string[] = [];
  const connection = openRealtime({
    workspaceId: "workspace_birchwood",
    open: fakeSocketOpener(server, jar),
    clock,
    onReconnected: () => log.push("reconnected"),
    onAccessEnded: () => log.push("access ended"),
  });
  return { server, clock, log, connection };
}

/** A socket opener whose sockets the test drives by hand. */
function handSockets() {
  const opened: { handlers: SocketHandlers; sent: string[]; closed: boolean }[] = [];
  return {
    opened,
    open: (_workspaceId: string, handlers: SocketHandlers) => {
      const socket = { handlers, sent: [] as string[], closed: false };
      opened.push(socket);
      return {
        send: (text: string) => void socket.sent.push(text),
        close: () => {
          socket.closed = true;
        },
      };
    },
  };
}

describe("one connection per workspace", () => {
  test("opens once and reports its status", async () => {
    const { server, connection } = setup();
    const seen: string[] = [];
    connection.onStatus(() => seen.push(connection.status()));
    expect(connection.status()).toBe("connecting");
    await settle();
    expect(connection.status()).toBe("open");
    expect(seen).toEqual(["open"]);
    expect(server.openSockets()).toEqual([
      { workspaceId: "workspace_birchwood", userId: "usr_ana", channels: [] },
    ]);
  });

  test("events reach the handlers of their name, and only those", async () => {
    const { server, connection } = setup();
    await settle();
    const got: RealtimeEvent[] = [];
    const off = connection.on("run.status_changed", (event) => got.push(event));
    connection.on("message.posted", () => {
      throw new Error("not for this handler");
    });
    server.emit("workspace_birchwood", {
      type: "run.status_changed",
      agentId: "agt_scout",
      status: "running",
    });
    expect(got).toEqual([
      {
        type: "run.status_changed",
        scope: "workspace",
        channelId: undefined,
        data: { agentId: "agt_scout", status: "running" },
      },
    ]);
    off();
    server.emit("workspace_birchwood", { type: "run.status_changed", agentId: "agt_scout", status: "idle" });
    expect(got).toHaveLength(1);
  });

  test("following a channel is counted: two followers, one subscription, released by the last", async () => {
    const { server, connection } = setup();
    await settle();
    const first = connection.followChannel("ch_general");
    const second = connection.followChannel("ch_general");
    expect(server.openSockets()[0]?.channels).toEqual(["ch_general"]);
    first();
    first();
    expect(server.openSockets()[0]?.channels).toEqual(["ch_general"]);
    second();
    expect(server.openSockets()[0]?.channels).toEqual([]);
  });

  test("channel events only reach a connection that follows the channel", async () => {
    const { server, connection } = setup();
    await settle();
    const got: RealtimeEvent[] = [];
    connection.on("message.posted", (event) => got.push(event));
    server.emit("workspace_birchwood", { type: "message.posted", id: "msg_1" }, "ch_general");
    expect(got).toEqual([]);
    connection.followChannel("ch_general");
    server.emit("workspace_birchwood", { type: "message.posted", id: "msg_2" }, "ch_general");
    expect(got.map((event) => [event.scope, event.channelId, event.data.id])).toEqual([
      ["channel", "ch_general", "msg_2"],
    ]);
  });
});

describe("losing the connection", () => {
  test("it retries with a growing wait, and the wait is the documented one", async () => {
    const { server, clock, connection } = setup();
    await settle();
    server.blockConnections(true);
    server.dropConnections();
    expect(connection.status()).toBe("lost");
    for (const delay of [...RECONNECT_DELAYS_MS, RECONNECT_DELAYS_MS.at(-1) ?? 0]) {
      clock.advance(delay - 1);
      expect(clock.pending(), `nothing fires before ${delay} ms`).toBe(1);
      clock.advance(1);
      await settle();
      expect(connection.status()).toBe("lost");
    }
    expect(RECONNECT_DELAYS_MS).toEqual([500, 1000, 2000, 5000, 10_000]);
  });

  test("coming back refetches, follows the same channels again and resets the wait", async () => {
    const { server, clock, log, connection } = setup();
    await settle();
    connection.followChannel("ch_general");
    server.blockConnections(true);
    server.dropConnections();
    clock.advance(500);
    await settle();
    server.blockConnections(false);
    clock.advance(1000);
    await settle();
    expect(connection.status()).toBe("open");
    expect(log).toEqual(["reconnected"]);
    expect(server.openSockets()[0]?.channels).toEqual(["ch_general"]);
    server.dropConnections();
    clock.advance(500);
    await settle();
    expect(connection.status()).toBe("open");
  });

  test("the first connection is not a reconnection", async () => {
    const { log } = setup();
    await settle();
    expect(log).toEqual([]);
  });

  test("retryNow skips the wait", async () => {
    const { server, clock, connection } = setup();
    await settle();
    server.dropConnections();
    expect(connection.status()).toBe("lost");
    connection.retryNow();
    await settle();
    expect(connection.status()).toBe("open");
    expect(clock.pending()).toBe(1); // only the ping
  });

  test("access ended (4401) stops for good and tells the session", async () => {
    const { server, clock, log, connection } = setup();
    await settle();
    server.expireSessions();
    expect(connection.status()).toBe("ended");
    expect(log).toEqual(["access ended"]);
    clock.advance(60_000);
    await settle();
    expect(server.openSockets()).toEqual([]);
    expect(ACCESS_ENDED_CODE).toBe(4401);
  });

  test("closing cancels the retry and the ping", async () => {
    const { server, clock, connection } = setup();
    await settle();
    server.dropConnections();
    connection.close();
    expect(clock.pending()).toBe(0);
    clock.advance(60_000);
    await settle();
    expect(server.openSockets()).toEqual([]);
    expect(connection.status()).toBe("ended");
  });
});

describe("the wire", () => {
  test("an open connection pings on the documented interval", () => {
    const sockets = handSockets();
    const clock = manualClock();
    openRealtime({ workspaceId: "w", open: sockets.open, clock, onReconnected() {}, onAccessEnded() {} });
    sockets.opened[0]?.handlers.open();
    clock.advance(PING_INTERVAL_MS - 1);
    expect(sockets.opened[0]?.sent).toEqual([]);
    clock.advance(1);
    clock.advance(PING_INTERVAL_MS);
    expect(sockets.opened[0]?.sent).toEqual(['{"type":"ping"}', '{"type":"ping"}']);
    expect(PING_INTERVAL_MS).toBe(30_000);
  });

  test("frames are not sent while the connection is not open", () => {
    const sockets = handSockets();
    const connection = openRealtime({
      workspaceId: "w",
      open: sockets.open,
      clock: manualClock(),
      onReconnected() {},
      onAccessEnded() {},
    });
    connection.send({ type: "typing", channelId: "ch_1" });
    connection.followChannel("ch_1");
    expect(sockets.opened[0]?.sent).toEqual([]);
    sockets.opened[0]?.handlers.open();
    expect(sockets.opened[0]?.sent).toEqual(['{"type":"subscribe","channelId":"ch_1"}']);
  });

  test("a late callback from a replaced socket changes nothing", () => {
    const sockets = handSockets();
    const clock = manualClock();
    const connection = openRealtime({
      workspaceId: "w",
      open: sockets.open,
      clock,
      onReconnected() {},
      onAccessEnded() {},
    });
    sockets.opened[0]?.handlers.open();
    sockets.opened[0]?.handlers.close(1006);
    clock.advance(500);
    sockets.opened[1]?.handlers.open();
    sockets.opened[0]?.handlers.close(1006);
    sockets.opened[0]?.handlers.message('{"type":"event","scope":"workspace","event":{"type":"x.y"}}');
    expect(connection.status()).toBe("open");
    expect(sockets.opened).toHaveLength(2);
  });

  test.each([
    ["not text", 42],
    ["not JSON", "{"],
    ["an unknown frame", '{"type":"surprise"}'],
    ["an event without a name", '{"type":"event","event":{}}'],
    ["an event that is not an object", '{"type":"event","event":"message.posted"}'],
    ["an unknown scope", '{"type":"event","scope":"galaxy","event":{"type":"a.b"}}'],
  ])("%s is dropped", (_name, data) => {
    expect(parseServerFrame(data)).toBeUndefined();
  });

  test("a malformed frame does not reach a handler or break the connection", () => {
    const sockets = handSockets();
    const connection = openRealtime({
      workspaceId: "w",
      open: sockets.open,
      clock: manualClock(),
      onReconnected() {},
      onAccessEnded() {},
    });
    let calls = 0;
    connection.on("message.posted", () => calls++);
    sockets.opened[0]?.handlers.open();
    sockets.opened[0]?.handlers.message('{"type":"event","event":{"type":42}}');
    sockets.opened[0]?.handlers.message("garbage");
    sockets.opened[0]?.handlers.message('{"type":"event","channelId":"c","event":{"type":"message.posted"}}');
    expect(calls).toBe(1);
    expect(connection.status()).toBe("open");
  });
});
