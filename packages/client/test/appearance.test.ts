// An agent's appearance read from the server: an optional part (body, mouth, extra) holding a value this
// client doesn't know reads as absent, so a newer server or an old row never breaks a whole agent list.
import { expect, test } from "bun:test";
import { createClient } from "../src/client.ts";

const agent = (id: string, appearance: Record<string, unknown>) => ({
  id,
  advisor: null,
  appearance,
  archivedAt: null,
  audience: { mode: "everyone", userIds: [] },
  busy: false,
  createdAt: "2026-11-01T00:00:00.000Z",
  handle: id,
  harness: { environment: null, kind: "model", model: "m" },
  instructions: "",
  model: "m",
  name: id,
  ownerUserId: "u_1",
  reachable: true,
  role: "assistant",
  testModel: false,
});

const look = { adornment: "none", color: "blue", eyes: "dot" };

test("an unknown body, mouth or extra drops that part only, and the list still loads", async () => {
  const agents = [
    agent("ok", { ...look, body: "cloud", mouth: "grin", extra: "tie" }),
    agent("newer", { ...look, body: "blob", mouth: "grin", extra: 7 }),
    agent("old", look),
  ];
  const client = createClient({
    baseUrl: "http://vanr.test/",
    fetch: async () =>
      new Response(JSON.stringify({ agents }), { headers: { "content-type": "application/json" } }),
  });
  const list = await client.api.listAgents({ workspaceId: "ws_1" });
  expect(list.map((a) => a.appearance)).toEqual([
    { ...look, body: "cloud", mouth: "grin", extra: "tie" },
    { ...look, mouth: "grin" },
    look,
  ]);
});
