// The client's surface against the route table: every method in the table exists here with the same verb
// and path, nothing exists here that the table doesn't list (or that isn't a listed, reasoned exception),
// and each method really calls that verb and path.
import { describe, expect, test } from "bun:test";
import { endpoints } from "../src/api/index.ts";
import { createClient } from "../src/client.ts";
import { pathParamNames } from "../src/endpoint.ts";
import table from "./route-table.json";

type Row = { name: string; verb: string; path: string };

/** Where the table is wrong about a method and the client follows the server instead. */
const OVERRIDES: Record<string, Row & { reason: string }> = {
  listFileFiles: {
    name: "uploadFile",
    verb: "POST",
    path: "/api/v1/workspaces/:workspaceId/files/files",
    reason:
      "uploads one file as multipart; the server route is POST and the table's GET came from the extractor",
  },
  uploadFileVersion: {
    name: "uploadFileVersion",
    verb: "POST",
    path: "/api/v1/workspaces/:workspaceId/files/:fileId/files",
    reason: "uploads a new version as multipart; the server route is POST",
  },
};

/** Methods the table doesn't have, for routes the server has. */
const EXTRAS: Record<string, string> = {
  deleteChannelMemberPerson:
    "removes a person from a channel (the table only has the agent half of this route pair)",
};

const rows: Row[] = table.methods.map((r) => OVERRIDES[r.name] ?? r);

describe("route table", () => {
  test("every method in the table exists with its verb and path", () => {
    const byName = new Map(Object.entries(endpoints));
    const wrong: string[] = [];
    for (const row of rows) {
      const ep = byName.get(row.name);
      if (!ep) wrong.push(`missing ${row.name}`);
      else if (ep.verb !== row.verb || ep.path !== row.path)
        wrong.push(`${row.name}: ${ep.verb} ${ep.path} != ${row.verb} ${row.path}`);
    }
    expect(wrong).toEqual([]);
    expect(rows.length).toBe(407);
  });

  test("the client has nothing the table (or the exceptions) doesn't list", () => {
    const listed = new Set([...rows.map((r) => r.name), ...Object.keys(EXTRAS)]);
    expect(Object.keys(endpoints).filter((name) => !listed.has(name))).toEqual([]);
    expect(Object.keys(endpoints).length).toBe(rows.length + Object.keys(EXTRAS).length);
  });

  test("each method sends its verb to its path", async () => {
    const seen: { method: string; url: string }[] = [];
    const client = createClient({
      baseUrl: "http://vanr.test",
      fetch: async (url, init) => {
        seen.push({ method: init.method ?? "GET", url });
        return new Response(null, { status: 599 });
      },
    });
    for (const [name, ep] of Object.entries(endpoints)) {
      const args: Record<string, unknown> = {};
      for (const p of pathParamNames(ep.path)) args[p] = `${p}-1`;
      if (ep.send === "bytes") args.body = new Blob(["x"]);
      seen.length = 0;
      await client.call(name as keyof typeof endpoints, args as never).catch(() => {});
      const expected = ep.path.split("?")[0]?.replace(/:(\w+)/g, (_, p: string) => `${p}-1`);
      expect(seen).toHaveLength(1);
      expect(seen[0]?.method).toBe(ep.verb);
      expect(new URL(seen[0]?.url ?? "").pathname).toBe(expected ?? "");
    }
  });
});
