// The client's surface against the route table: every method in the table exists here with the same verb
// and path, nothing exists here that the table doesn't list (or that isn't a listed, reasoned exception),
// and each method really calls that verb and path.
import { describe, expect, test } from "bun:test";
import { endpoints } from "../src/api/index.ts";
import { createClient } from "../src/client.ts";
import { pathParamNames } from "../src/endpoint.ts";
import table from "./route-table.json";

type Row = { name: string; verb: string; path: string };

/**
 * Divergences approved by the orchestrator: route-table.json already carries the corrected row for each of
 * these, while vocab.json (the table it was copied from) still has the old one until it is fixed.
 */
const APPROVED_DIVERGENCES: Record<string, string> = {
  uploadFile: "was listFileFiles with GET; it uploads one file as multipart and the server route is POST",
  uploadFileVersion: "was GET; it uploads a new version as multipart and the server route is POST",
  getIssueBySeq: "was the by-number route; the vocabulary pair renames the issue number to issueSeq",
};

/** Methods the table doesn't have, for routes the server has (approved by the orchestrator). */
const EXTRAS: Record<string, string> = {
  deleteChannelMemberPerson:
    "removes a person from a channel (the table only has the agent half of this route pair)",
};

const rows: Row[] = table.methods;

describe("route table", () => {
  test("every approved divergence is a row of the table", () => {
    const names = new Set(rows.map((r) => r.name));
    expect(Object.keys(APPROVED_DIVERGENCES).filter((n) => !names.has(n))).toEqual([]);
    expect(Object.keys(EXTRAS).filter((n) => names.has(n))).toEqual([]);
  });

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
