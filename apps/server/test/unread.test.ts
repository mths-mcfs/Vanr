import { afterAll, beforeAll, expect, test } from "bun:test";
import type { RunningServer } from "../src/server";
import { SERVER_TEST_MS, signedIn, startTestServer, TestSocket } from "./harness";
import { call, ws } from "./route-calls";
import { memberOf } from "./seed";

// The channels' unread counter: whoever doesn't have the channel open gets `channel.unread` and the channel list
// brings the new number. Before, only the sidebar's 60 s poll moved it.
let server: RunningServer;
beforeAll(async () => {
  server = await startTestServer();
}, SERVER_TEST_MS);
afterAll(() => server.stop(), SERVER_TEST_MS);

test(
  "a new message tells the members who aren't in the channel; a thread reply and the author don't",
  async () => {
    const ana = await signedIn(server, "Ana", "ana@unread.test");
    const created = await call(ana, "POST", "/api/v1/workspaces", { name: "Unread" });
    const workspaceId: string = created.body.workspace.id;
    const general: string = created.body.defaultChannelId;
    const w = ws(workspaceId);
    const beto = await memberOf(server, workspaceId, "Beto", "beto@unread.test");
    const betoWs = await TestSocket.open(beto.browser, workspaceId);
    const anaWs = await TestSocket.open(ana.browser, workspaceId);
    try {
      const root = await call(ana, "POST", `${w}/channels/${general}/messages`, {
        body: "good morning",
        clientId: "u1",
      });
      const frame = await betoWs.event("channel.unread");
      expect(frame.event).toMatchObject({ type: "channel.unread", channelId: general });
      const unread = async () =>
        (await call(beto, "GET", `${w}/channels`)).body.channels.find((c: { id: string }) => c.id === general)
          ?.unreadCount;
      expect(await unread()).toBe(1);

      await call(ana, "POST", `${w}/channels/${general}/messages`, {
        body: "in the thread",
        clientId: "u2",
        threadId: root.body.id,
      });
      await expect(betoWs.event("channel.unread", 300)).rejects.toThrow("timeout");
      await expect(anaWs.event("channel.unread", 300)).rejects.toThrow("timeout");
      expect(await unread()).toBe(1);

      await call(beto, "POST", `${w}/channels/${general}/read`);
      expect(await unread()).toBe(0);
    } finally {
      betoWs.close();
      anaWs.close();
    }
  },
  SERVER_TEST_MS,
);
