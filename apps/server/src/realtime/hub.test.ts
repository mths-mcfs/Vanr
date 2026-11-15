// The hub on real browser sockets: a Bun server upgrades each client with its workspace and user, and the
// tests read what each client receives.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type BrowserSocket, type BrowserSocketData, Hub, type RealtimeEvent } from "./hub";

const hub = new Hub();
const opened = new Map<string, BrowserSocket>();
let server: ReturnType<typeof Bun.serve<BrowserSocketData>>;

beforeAll(() => {
  server = Bun.serve<BrowserSocketData>({
    port: 0,
    fetch(req, srv) {
      const url = new URL(req.url);
      const data: BrowserSocketData = {
        kind: "browser",
        workspaceId: url.searchParams.get("w") ?? "",
        userId: url.searchParams.get("u") ?? "",
        sessionId: "s",
        channels: new Set(),
        lastTypingAt: new Map(),
      };
      if (srv.upgrade(req, { data })) return undefined;
      return new Response("upgrade", { status: 426 });
    },
    websocket: {
      open(ws) {
        hub.add(ws);
        opened.set(`${ws.data.workspaceId}:${ws.data.userId}:${opened.size}`, ws);
      },
      message() {},
      close(ws) {
        hub.remove(ws);
      },
    },
  });
});
afterAll(() => server.stop(true));

interface Client {
  frames: unknown[];
  closed: Promise<number>;
  ws: WebSocket;
  socket: BrowserSocket;
}

async function connect(workspaceId: string, userId: string): Promise<Client> {
  const before = opened.size;
  const ws = new WebSocket(`ws://localhost:${server.port}/?w=${workspaceId}&u=${userId}`);
  const frames: unknown[] = [];
  ws.addEventListener("message", (ev) => frames.push(JSON.parse(String(ev.data))));
  const closed = new Promise<number>((resolve) => ws.addEventListener("close", (ev) => resolve(ev.code)));
  await new Promise((resolve) => ws.addEventListener("open", resolve));
  while (opened.size === before) await Bun.sleep(1);
  const socket = [...opened.values()].at(-1);
  if (!socket) throw new Error("no server socket");
  return { frames, closed, ws, socket };
}

/** Lets the frames already sent arrive. */
const settle = () => Bun.sleep(30);

const event = (type: string): RealtimeEvent => ({ type, n: 1 });

describe("realtime hub", () => {
  test("a channel event reaches only the channel's subscribers, except the user asked to skip", async () => {
    const ana = await connect("w1", "ana");
    const bia = await connect("w1", "bia");
    const caio = await connect("w1", "caio");
    hub.subscribe(ana.socket, "c1");
    hub.subscribe(bia.socket, "c1");
    hub.toChannel("c1", event("message.posted"), { exceptUserId: "bia" });
    await settle();
    expect(ana.frames).toEqual([{ type: "event", channelId: "c1", event: event("message.posted") }]);
    expect(bia.frames).toEqual([]);
    expect(caio.frames).toEqual([]);
    hub.unsubscribe(ana.socket, "c1");
    hub.toChannel("c1", event("message.updated"));
    await settle();
    expect(ana.frames).toHaveLength(1);
    expect(bia.frames).toEqual([{ type: "event", channelId: "c1", event: event("message.updated") }]);
    for (const c of [ana, bia, caio]) c.ws.close();
  });

  test("user and workspace events stay inside their workspace", async () => {
    const mine = await connect("w2", "dani");
    const myOtherTab = await connect("w2", "dani");
    const colleague = await connect("w2", "edu");
    const elsewhere = await connect("w3", "dani");
    hub.toUser("w2", "dani", event("notification.created"));
    hub.toWorkspace("w2", event("agent.updated"));
    await settle();
    const user = { type: "event", scope: "user", event: event("notification.created") };
    const workspace = { type: "event", scope: "workspace", event: event("agent.updated") };
    expect(mine.frames).toEqual([user, workspace]);
    expect(myOtherTab.frames).toEqual([user, workspace]);
    expect(colleague.frames).toEqual([workspace]);
    expect(elsewhere.frames).toEqual([]);
    for (const c of [mine, myOtherTab, colleague, elsewhere]) c.ws.close();
  });

  test("online while a socket is open; a closed socket gets nothing more", async () => {
    const fabi = await connect("w4", "fabi");
    hub.subscribe(fabi.socket, "c4");
    expect(hub.isOnline("w4", "fabi")).toBe(true);
    expect(hub.isOnline("w4", "nobody")).toBe(false);
    fabi.ws.close();
    await fabi.closed;
    while (hub.isOnline("w4", "fabi")) await Bun.sleep(1);
    hub.toChannel("c4", event("message.posted"));
    hub.toWorkspace("w4", event("agent.updated"));
    await settle();
    expect(fabi.frames).toEqual([]);
  });

  test("losing access: from one channel stops its events; from the workspace closes the sockets with 4003", async () => {
    const gabi = await connect("w5", "gabi");
    hub.subscribe(gabi.socket, "c5");
    hub.subscribe(gabi.socket, "c6");
    hub.dropUser("w5", "gabi", "c5");
    hub.toChannel("c5", event("message.posted"));
    hub.toChannel("c6", event("message.posted"));
    await settle();
    expect(gabi.frames).toEqual([{ type: "event", channelId: "c6", event: event("message.posted") }]);
    hub.dropUser("w5", "gabi");
    expect(await gabi.closed).toBe(4003);
  });

  test("a listener sees every publication with its target until it unsubscribes", async () => {
    const seen: [string, string][] = [];
    const stop = hub.onPublish((target, e) => seen.push([target, e.type]));
    hub.toChannel("c7", event("a"));
    hub.toUser("w7", "hugo", event("b"));
    hub.toWorkspace("w7", event("c"));
    stop();
    hub.toWorkspace("w7", event("d"));
    expect(seen).toEqual([
      ["channel:c7", "a"],
      ["user:w7:hugo", "b"],
      ["workspace:w7", "c"],
    ]);
  });
});
