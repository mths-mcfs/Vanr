// The memory tool (runtime/memory-tool.ts) on a real database: the six commands on the agent's store with the
// texts of the tool's docs, the three stores and what each run may open, the workspace's store read only (it
// changes by proposal), and a write under flag A going to the review queue. What the tool wrote reads back
// through the memory routes.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Memory, MemoryReview, MemoryVersion, Proposal, ProposalList } from "@vanr/contract";
import { schema } from "@vanr/engine/db";
import { RiskTracker } from "@vanr/engine/effects";
import { and, eq } from "drizzle-orm";
import type { RunningServer } from "../src/server";
import { body, SERVER_TEST_MS, signedIn, startTestServer } from "./harness";
import { memberOf, type Person, seedWorkspace } from "./seed";
import { seedAgent, toolRun, undo } from "./tool-run";

let server: RunningServer;
beforeAll(async () => {
  server = await startTestServer();
}, SERVER_TEST_MS);
afterAll(() => server.stop(), SERVER_TEST_MS);

let n = 0;
const email = (who: string) => `${who}${++n}@memory-tool.test`;

async function api<T>(who: Person, workspaceId: string, method: string, path: string, data?: unknown) {
  const res = await who.browser.json(`/api/v1/workspaces/${workspaceId}${path}`, method, data);
  return { status: res.status, json: (await body(res)) as T };
}
async function ok<T>(p: ReturnType<typeof api<T>>): Promise<T> {
  const res = await p;
  if (res.status >= 300) throw new Error(`expected 2xx, got ${res.status} ${JSON.stringify(res.json)}`);
  return res.json;
}

/** Ana (owner, Lia's owner) and Beto (member), Lia in #general. */
async function team() {
  const ana = await signedIn(server, "Ana", email("ana"));
  const { workspaceId, general } = await seedWorkspace(server, ana, "Memory");
  const beto = await memberOf(server, workspaceId, "Beto", email("beto"));
  const lia = await seedAgent(server, workspaceId, ana, { channels: [general] });
  const as = (asker: Person | null) =>
    toolRun(server, { workspaceId, agent: lia, channelId: general, asker });
  const mems = async (who: Person = ana) =>
    (await ok(api<{ memories: Memory[] }>(who, workspaceId, "GET", `/agents/${lia.id}/memories`))).memories;
  return { workspaceId, general, ana, beto, lia, as, mems };
}

/** A run that read an outside email: flag A. */
const untrusted = () => {
  const risk = new RiskTracker();
  risk.raise({ flag: "A", source: "email from attacker@evil.example (support/INBOX)" });
  return risk;
};

describe("memory tool: three stores in Postgres", () => {
  test(
    "the six commands on the agent's store, with the docs' texts",
    async () => {
      const t = await team();
      const { call } = await t.as(t.ana);
      const run = async (input: Record<string, unknown>) => {
        const r = await call("memory", input);
        return { text: r.content, error: r.isError };
      };
      expect(
        await run({
          command: "create",
          path: "/memories/agent/clients/acme.md",
          file_text: "Pays on the 10th\nLikes email",
        }),
      ).toEqual({ text: "File created successfully at: /memories/agent/clients/acme.md", error: false });
      expect(
        (await run({ command: "create", path: "/memories/agent/clients/acme.md", file_text: "x" })).text,
      ).toBe("Error: File /memories/agent/clients/acme.md already exists");
      expect((await run({ command: "view", path: "/memories/agent/clients/acme.md" })).text).toBe(
        "Here's the content of /memories/agent/clients/acme.md with line numbers:\n     1\tPays on the 10th\n     2\tLikes email",
      );
      expect(
        (
          await run({
            command: "str_replace",
            path: "/memories/agent/clients/acme.md",
            old_str: "the 10th",
            new_str: "the 15th",
          })
        ).text,
      ).toBe("The memory file has been edited.");
      expect(
        await run({
          command: "str_replace",
          path: "/memories/agent/clients/acme.md",
          old_str: "nothing",
          new_str: "x",
        }),
      ).toEqual({
        text: "No replacement was performed, old_str `nothing` did not appear verbatim in /memories/agent/clients/acme.md.",
        error: true,
      });
      expect(
        (
          await run({
            command: "insert",
            path: "/memories/agent/clients/acme.md",
            insert_line: 0,
            insert_text: "# Acme",
          })
        ).text,
      ).toBe("The file /memories/agent/clients/acme.md has been edited.");
      expect(
        (
          await run({
            command: "rename",
            old_path: "/memories/agent/clients/acme.md",
            new_path: "/memories/agent/clients/acme-inc.md",
          })
        ).text,
      ).toBe("Successfully renamed /memories/agent/clients/acme.md to /memories/agent/clients/acme-inc.md");
      const view = (await run({ command: "view", path: "/memories" })).text;
      expect(view).toContain("Here're the files and directories up to 2 levels deep in /memories");
      expect(view).toContain("/memories/agent/clients/");
      expect(view).toContain("/memories/workspace/");
      const [file] = await t.mems();
      expect(file).toMatchObject({
        path: "clients/acme-inc.md",
        text: "# Acme\nPays on the 15th\nLikes email",
      });
      const versions = await ok(
        api<{ versions: MemoryVersion[] }>(t.ana, t.workspaceId, "GET", `/memories/${file?.id}/versions`),
      );
      expect(versions.versions.map((v) => v.op)).toEqual(["create", "update", "update", "rename"]);
      expect((await run({ command: "delete", path: "/memories/agent/clients" })).text).toBe(
        "Successfully deleted /memories/agent/clients",
      );
      expect((await t.mems())[0]?.archived).toBe(true);
      expect((await run({ command: "view", path: "/memories/agent/clients/acme-inc.md" })).text).toBe(
        "The path /memories/agent/clients/acme-inc.md does not exist. Please provide a valid path.",
      );
    },
    SERVER_TEST_MS,
  );

  test(
    "a created file is an undoable receipt on the agent's store; the person's store writes none",
    async () => {
      const t = await team();
      const forAna = await t.as(t.ana);
      await forAna.call("memory", { command: "create", path: "/memories/agent/note.md", file_text: "Kept" });
      const act = await forAna.action("memory_recorded");
      expect((await undo(t.ana, t.workspaceId, act)).status).toBe(200);
      expect((await t.mems()).map((m) => [m.path, m.archived])).toEqual([["note.md", true]]);
      expect((await undo(t.ana, t.workspaceId, act, "redo")).status).toBe(200);
      expect((await t.mems()).map((m) => [m.path, m.archived])).toEqual([["note.md", false]]);

      const forBeto = await t.as(t.beto);
      await forBeto.call("memory", {
        command: "create",
        path: "/memories/you/health/exam.md",
        file_text: "private",
      });
      expect(forBeto.actions).toEqual([]);
      const mine = await ok(api<{ memories: Memory[] }>(t.beto, t.workspaceId, "GET", "/memories/mine"));
      expect(mine.memories.map((m) => [m.path, m.archived])).toEqual([["health/exam.md", false]]);
    },
    SERVER_TEST_MS,
  );

  test(
    "attack: path traversal and another person's store don't pass",
    async () => {
      const t = await team();
      // Beto keeps a preference in his store
      await (await t.as(t.beto)).call("memory", {
        command: "create",
        path: "/memories/you/pref.md",
        file_text: "Beto prefers audio",
      });
      const forAna = await t.as(t.ana);
      for (const path of [
        "/memories/agent/../you/pref.md",
        "/memories/agent/%2e%2e/you/pref.md",
        "/memories/../memories/you/pref.md",
        "/etc/passwd",
        "/memories/agent\\..\\you\\pref.md",
      ]) {
        const r = await forAna.call("memory", { command: "view", path });
        expect(r.isError).toBe(true);
        expect(r.content).not.toContain("audio");
      }
      // Ana sees her own store (empty), not Beto's
      const mine = await forAna.call("memory", { command: "view", path: "/memories/you/pref.md" });
      expect({ text: mine.content, error: mine.isError }).toEqual({
        text: "The path /memories/you/pref.md does not exist. Please provide a valid path.",
        error: true,
      });
      expect((await forAna.call("memory", { command: "view", path: "/memories" })).content).not.toContain(
        "pref.md",
      );
      // in the API, Beto's store is his alone, and it doesn't show in the agent's
      const [pref] = (await ok(api<{ memories: Memory[] }>(t.beto, t.workspaceId, "GET", "/memories/mine")))
        .memories;
      expect(pref).toMatchObject({ scope: "person", path: "pref.md", agentId: t.lia.id });
      expect(
        (await ok(api<{ memories: Memory[] }>(t.ana, t.workspaceId, "GET", "/memories/mine"))).memories,
      ).toEqual([]);
      expect((await api(t.ana, t.workspaceId, "GET", `/memories/${pref?.id}/versions`)).status).toBe(404);
      expect(await t.mems()).toEqual([]);
      // a run without a person (a routine) has no person's store
      const routine = await t.as(null);
      const none = await routine.call("memory", {
        command: "create",
        path: "/memories/you/x.md",
        file_text: "x",
      });
      expect(none.isError).toBe(true);
      expect(none.content).toContain("No person started this run");
      expect((await routine.call("memory", { command: "view", path: "/memories" })).content).not.toContain(
        "/you",
      );
      // a file doesn't move between stores, and remembered/ is the notes of `remember`
      await forAna.call("memory", { command: "create", path: "/memories/agent/a.md", file_text: "a" });
      for (const [input, text] of [
        [
          { command: "rename", old_path: "/memories/agent/a.md", new_path: "/memories/you/a.md" },
          "can't move between",
        ],
        [
          { command: "create", path: "/memories/agent/remembered/x.md", file_text: "x" },
          "remembered/ holds the notes",
        ],
        [{ command: "delete", path: "/memories/agent" }, "can't be deleted"],
        [{ command: "create", path: "/memories/agent", file_text: "x" }, "is a directory"],
      ] as const) {
        const r = await forAna.call("memory", input);
        expect(r.isError).toBe(true);
        expect(r.content).toContain(text);
      }
      const [row] = await server.deps.db
        .select()
        .from(schema.memories)
        .where(and(eq(schema.memories.workspaceId, t.workspaceId), eq(schema.memories.scope, "person")));
      expect(row?.ownerUserId).toBe(t.beto.user.id);
    },
    SERVER_TEST_MS,
  );

  test(
    "the workspace's store is read only for the agent; it changes by proposal, with a version and undo",
    async () => {
      const t = await team();
      const politics = await ok(
        api<Memory>(t.ana, t.workspaceId, "POST", "/memories", {
          scope: "workspace",
          path: "policies/refund.md",
          text: "Refund in 7 days",
        }),
      );
      const forBeto = await t.as(t.beto);
      const denied = await forBeto.call("memory", {
        command: "str_replace",
        path: "/memories/workspace/policies/refund.md",
        old_str: "7",
        new_str: "90",
      });
      expect(denied.isError).toBe(true);
      expect(denied.content).toContain("read only");
      expect(
        (await forBeto.call("memory", { command: "view", path: "/memories/workspace/policies/refund.md" }))
          .content,
      ).toContain("Refund in 7 days");

      const proposed = await forBeto.call("propose_workspace_memory_change", {
        path: "/memories/workspace/policies/refund.md",
        text: "Refund in 30 days",
        title: "Deadline",
        why: "the law",
      });
      expect(proposed.content).toContain("A person will review it");
      const list = async (who: Person) =>
        (await ok(api<ProposalList>(who, t.workspaceId, "GET", "/proposals"))).proposals;
      const [prop] = await list(t.ana);
      expect(prop).toMatchObject({
        target: { kind: "workspace_memory", path: "policies/refund.md" },
        before: "Refund in 7 days",
        decidable: true,
      });
      expect((await list(t.beto))[0]?.decidable).toBe(false);
      const accepted = await ok(
        api<Proposal>(t.ana, t.workspaceId, "POST", `/proposals/${prop?.id}/accept`, {}),
      );
      const workspace = async () =>
        (await ok(api<{ memories: Memory[] }>(t.ana, t.workspaceId, "GET", "/memories/workspace"))).memories;
      expect((await workspace())[0]?.text).toBe("Refund in 30 days");
      expect((await undo(t.ana, t.workspaceId, accepted.actionId ?? "")).status).toBe(200);
      expect((await workspace())[0]?.text).toBe("Refund in 7 days");
      expect(politics.path).toBe("policies/refund.md");

      // only files of /memories/workspace, and something new
      for (const path of [
        "/memories/agent/x.md",
        "/memories/workspace",
        "/memories/workspace/remembered/x.md",
      ]) {
        const r = await forBeto.call("propose_workspace_memory_change", {
          path,
          text: "x",
          title: "x",
          why: "x",
        });
        expect(r.isError).toBe(true);
      }
      const same = await forBeto.call("propose_workspace_memory_change", {
        path: "/memories/workspace/policies/refund.md",
        text: "Refund in 7 days",
        title: "Same",
        why: "x",
      });
      expect(same.content).toContain("the same as the current one");
    },
    SERVER_TEST_MS,
  );

  test(
    "a memory write under flag A goes to review: nothing is in the memory until a person approves",
    async () => {
      const t = await team();
      const { call } = await t.as(t.ana);
      const out = await call(
        "memory",
        { command: "create", path: "/memories/agent/accounts.md", file_text: "account 666" },
        { risk: untrusted() },
      );
      expect(out.content).toContain("Not saved yet");
      expect(await t.mems()).toEqual([]);
      const { reviews } = await ok(
        api<{ reviews: MemoryReview[] }>(t.ana, t.workspaceId, "GET", `/memory-reviews?agentId=${t.lia.id}`),
      );
      expect(reviews[0]).toMatchObject({
        tool: "memory",
        op: "create",
        path: "accounts.md",
        text: "account 666",
      });
      await ok(api(t.ana, t.workspaceId, "POST", `/memory-reviews/${reviews[0]?.id}/approve`, {}));
      expect((await t.mems()).map((m) => [m.path, m.untrustedSource])).toEqual([["accounts.md", true]]);
    },
    SERVER_TEST_MS,
  );
});
