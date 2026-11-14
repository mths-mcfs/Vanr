// The invalidation table: it covers every event of the server's table (or says why the event changes
// nothing cached), its keys name real methods inside the event's workspace, and an event refetches only
// the queries under its keys.
import { describe, expect, test } from "bun:test";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { endpoints } from "../src/api/index.ts";
import { createClient, type ResultOf } from "../src/client.ts";
import { INVALIDATION, invalidateForEvent, keysForEvent } from "../src/react/invalidation.ts";
import { queryKey } from "../src/react/keys.ts";
import { BROWSER_EVENTS, type BrowserEventName, NOT_BROWSER_EVENTS } from "../src/realtime/events.ts";
import type { AnyRealtimeEvent } from "../src/realtime/socket.ts";
import { parse } from "../src/schema.ts";
import table from "./event-table.json";

/** A payload that answers any field with another such value, so every rule can run without real data. */
function anyPayload(): unknown {
  const handler: ProxyHandler<object> = {
    get: (_t, key) => (key === Symbol.toPrimitive ? () => "x" : anyPayload()),
  };
  return new Proxy({}, handler);
}

describe("invalidation table", () => {
  test("every event in the server's table is handled or explained", () => {
    const missing = table.events.filter(
      (name) => !Object.hasOwn(INVALIDATION, name) && !Object.hasOwn(NOT_BROWSER_EVENTS, name),
    );
    expect(missing).toEqual([]);
    expect(Object.keys(INVALIDATION).sort()).toEqual(Object.keys(BROWSER_EVENTS).sort());
  });

  test("an event that invalidates nothing says why", () => {
    for (const [name, rule] of Object.entries(INVALIDATION)) {
      if ("none" in rule) expect(rule.none.length, name).toBeGreaterThan(10);
    }
    for (const [name, why] of Object.entries(NOT_BROWSER_EVENTS)) expect(why.length, name).toBeGreaterThan(5);
  });

  test("every key names a real method and stays inside the event's workspace", () => {
    for (const name of Object.keys(INVALIDATION) as BrowserEventName[]) {
      const event = { type: name, payload: anyPayload(), scope: { kind: "channel", channelId: "ch_1" } };
      for (const prefix of keysForEvent(event as AnyRealtimeEvent, "workspace_1")) {
        expect(Object.hasOwn(endpoints, prefix.method), `${name} -> ${prefix.method}`).toBe(true);
        expect(prefix.args?.workspaceId, name).toBe("workspace_1");
        expect(endpoints[prefix.method].path, `${name} -> ${prefix.method}`).toContain(":workspaceId");
      }
    }
  });

  test("an event refetches the queries under its keys and leaves the rest alone", async () => {
    const qc = new QueryClient();
    const client = createClient();
    const seed = (key: readonly unknown[]) => qc.setQueryData(key, []);
    const ch1 = queryKey(client, "listChannelMessages", {
      workspaceId: "w",
      channelId: "ch_1",
      query: { limit: 50 },
    });
    const ch1Thread = queryKey(client, "listChannelMessages", {
      workspaceId: "w",
      channelId: "ch_1",
      query: { threadId: "t" },
    });
    const ch2 = queryKey(client, "listChannelMessages", { workspaceId: "w", channelId: "ch_2" });
    const otherWs = queryKey(client, "listChannelMessages", { workspaceId: "w2", channelId: "ch_1" });
    const channels = queryKey(client, "listChannels", { workspaceId: "w" });
    const otherClient = queryKey(createClient(), "listChannelMessages", {
      workspaceId: "w",
      channelId: "ch_1",
    });
    for (const k of [ch1, ch1Thread, ch2, otherWs, channels, otherClient]) seed(k);

    await invalidateForEvent(
      qc,
      {
        type: "message.claimed",
        payload: { messageId: "msg_1", agentId: "agt_1" },
        scope: { kind: "channel", channelId: "ch_1" },
      },
      "w",
      client,
    );
    const stale = (k: readonly unknown[]) => qc.getQueryState(k)?.isInvalidated;
    expect([ch1, ch1Thread].map(stale)).toEqual([true, true]);
    expect([ch2, otherWs, channels, otherClient].some(stale)).toBe(false);
  });

  test("row changes and recalc progress refresh base queries only in their workspace", async () => {
    const qc = new QueryClient();
    const client = createClient();
    const baseId = "linked";
    const keys = ["w", "other"].flatMap((workspaceId) => [
      queryKey(client, "createBaseTableQuery", { workspaceId, baseId, tableId: "t", body: {} }),
      queryKey(client, "getBaseRow", { workspaceId, baseId, rowId: "r" }),
      queryKey(client, "getBase", { workspaceId, baseId }),
      queryKey(client, "listBases", { workspaceId }),
    ]);
    for (const key of keys) qc.setQueryData(key, []);
    await invalidateForEvent(
      qc,
      { type: "base.rows", payload: { baseId: "owner", tableId: "t" }, scope: { kind: "workspace" } },
      "w",
      client,
    );
    expect(keys.filter((key) => qc.getQueryState(key)?.isInvalidated)).toEqual(keys.slice(0, 4));
    for (const done of [false, true]) {
      const key = queryKey(client, "getBase", { workspaceId: "w", baseId });
      qc.setQueryData(key, {});
      const payload = parse(BROWSER_EVENTS["base.recalc"], { baseId, tableId: "t", processed: 3, done });
      const event = { type: "base.recalc", payload, scope: { kind: "workspace" } } as const;
      await invalidateForEvent(qc, event, "w", client);
      expect(qc.getQueryState(key)?.isInvalidated).toBe(true);
    }
    qc.clear();
  });

  test("file updates refresh active text after extraction and version changes", async () => {
    const qc = new QueryClient();
    let text: ResultOf<"getFileText"> = { version: 1, status: "pending", pages: [] };
    const client = createClient({ fetch: async () => Response.json(text) });
    const args = { workspaceId: "w", fileId: "f" };
    const query = new QueryObserver(qc, {
      queryKey: queryKey(client, "getFileText", args),
      queryFn: () => client.api.getFileText(args),
    });
    const off = query.subscribe(() => {});
    await query.refetch();
    text = { version: 2, status: "ready", pages: [{ page: 1, markdown: "extracted" }] };
    const event = { type: "file.updated", payload: { fileId: "f" }, scope: { kind: "workspace" } } as const;
    await invalidateForEvent(qc, event, "w", client);
    expect(query.getCurrentResult().data).toEqual(text);
    off();
    qc.clear();
  });

  test("a posted message refreshes its channel, the channel list and its thread", () => {
    const keys = keysForEvent(
      {
        type: "message.posted",
        payload: { message: { channelId: "ch_9", threadId: "th_1" } } as never,
        scope: { kind: "channel", channelId: "ch_9" },
      },
      "w",
    ).map((k) => [k.method, k.args]);
    expect(keys).toEqual([
      ["listChannelMessages", { workspaceId: "w", channelId: "ch_9" }],
      ["listChannels", { workspaceId: "w" }],
      ["getDms", { workspaceId: "w" }],
      ["getThread", { workspaceId: "w", threadId: "th_1" }],
      ["listThreads", { workspaceId: "w" }],
    ]);
  });

  test("streamed run output invalidates nothing", () => {
    const event = {
      type: "run.text_delta",
      payload: { agentId: "agt_1" },
      scope: { kind: "workspace" },
    } as const;
    expect(keysForEvent(event, "w")).toEqual([]);
  });
});
