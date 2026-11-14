// The React layer end to end, in a DOM: a query reads through the provider, a realtime event refetches
// what it made stale, a mutation refetches what it declares, a reconnect refetches everything, and the
// provider owns the socket's lifetime.
import { expect, test } from "bun:test";

// The DOM globals must not leak into the other test files, so this file runs itself in a child process.
if (process.env.VANR_CLIENT_DOM_TEST !== "1") {
  test("react hooks in an isolated DOM", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, VANR_CLIENT_DOM_TEST: "1" },
      stdout: "ignore",
      stderr: "pipe",
    });
    const output = await new Response(child.stderr).text();
    expect(await child.exited, output).toBe(0);
  }, 20_000);
} else {
  const { GlobalRegistrator } = await import("@happy-dom/global-registrator");
  GlobalRegistrator.register({ url: "http://localhost" });
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { QueryClient } = await import("@tanstack/react-query");
  const { createClient } = await import("../src/client.ts");
  const { RealtimeClient } = await import("../src/realtime/socket.ts");
  const { createFakeServer, fakeSockets, ManualClock } = await import("../src/testing/index.ts");
  const { VanrProvider, useApiMutation, useApiQuery, useRealtimeEvent } = await import(
    "../src/react/index.ts"
  );

  function setup() {
    const server = createFakeServer({ now: () => new Date("2026-11-03T10:00:00.000Z") });
    const client = createClient({ fetch: server.fetch });
    const sockets = fakeSockets();
    const clock = new ManualClock();
    const realtime = new RealtimeClient({
      workspaceId: server.sample.workspaceId,
      baseUrl: "http://localhost",
      createSocket: sockets.create,
      clock,
      random: () => 1,
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    return { server, client, sockets, clock, realtime, queryClient, host, root };
  }

  /** Lets fetches, React Query and React settle. */
  const settle = async () => {
    for (let i = 0; i < 5; i++) await act(() => new Promise((r) => setTimeout(r, 0)));
  };

  test("a query renders, an event refetches it, and unmounting stops the socket", async () => {
    const t = setup();
    const workspaceId = t.server.sample.workspaceId;
    const channelId = t.server.sample.defaultChannelId;
    let renders = 0;
    function Messages() {
      renders++;
      const q = useApiQuery("listChannelMessages", { workspaceId, channelId });
      return (
        <ul>
          {q.data?.map((m) => (
            <li key={m.id}>{m.body}</li>
          ))}
        </ul>
      );
    }
    await act(() =>
      t.root.render(
        <VanrProvider client={t.client} realtime={t.realtime} queryClient={t.queryClient}>
          <Messages />
        </VanrProvider>,
      ),
    );
    await settle();
    expect(t.host.textContent).toBe("Morning! Pier test at 2pm.I'll bring the spare buoy.");
    expect(t.realtime.status).toBe("connecting");
    t.sockets.last.open();
    expect(t.realtime.status).toBe("open");

    // Someone else posts: the server stores it and tells the channel.
    const posted = await createClient({ fetch: t.server.fetch }).api.createChannelMessage({
      workspaceId,
      channelId,
      body: { body: "Tide is turning.", clientId: "p_9" },
    });
    await act(() =>
      t.sockets.last.push({ type: "event", channelId, event: { type: "message.posted", message: posted } }),
    );
    await settle();
    expect(t.host.textContent).toContain("Tide is turning.");
    expect(renders).toBeGreaterThan(1);

    await act(() => t.root.unmount());
    expect(t.realtime.status).toBe("stopped");
    expect(t.sockets.last.closedWith?.code).toBe(1000);
  });

  test("a mutation refetches what it declares, and a reconnect refetches everything", async () => {
    const t = setup();
    const workspaceId = t.server.sample.workspaceId;
    let create: ((name: string) => void) | null = null;
    const heard: string[] = [];
    function Channels() {
      const list = useApiQuery("listChannels", { workspaceId });
      const add = useApiMutation("createChannel", {
        invalidates: () => [{ method: "listChannels", args: { workspaceId } }],
      });
      useRealtimeEvent("runner.paired", (e) => heard.push(e.payload.runnerId));
      create = (name) => add.mutate({ workspaceId, body: { name, visibility: "public" } });
      return <p>{list.data?.map((c) => c.name).join(",")}</p>;
    }
    await act(() =>
      t.root.render(
        <VanrProvider client={t.client} realtime={t.realtime} queryClient={t.queryClient}>
          <Channels />
        </VanrProvider>,
      ),
    );
    await settle();
    expect(t.host.textContent).toBe("general,firmware,field-tests");

    await act(() => create?.("tides"));
    await settle();
    expect(t.host.textContent).toBe("general,firmware,field-tests,tides");

    // A channel made while the socket was down shows up after the reconnect, with no event for it.
    t.sockets.last.open();
    t.sockets.last.drop();
    const firmware = t.server.state.channels[1];
    if (firmware) t.server.state.channels.push({ ...firmware, id: "ch_late", name: "late" });
    t.clock.advance(500);
    await act(() => t.sockets.last.open());
    await settle();
    expect(t.host.textContent).toContain("late");

    await act(() =>
      t.sockets.last.push({ type: "event", event: { type: "runner.paired", runnerId: "rnr_1" } }),
    );
    expect(heard).toEqual(["rnr_1"]);
    await act(() => t.root.unmount());
  });
}
