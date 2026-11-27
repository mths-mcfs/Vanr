// Memory: immutable versions and restore, the three stores, the store cap, and the agent's instruction versions
// (through the agent routes). The agent's tools (remember, the memory tool, flag A) wait for the runtime (P16). Where the origin had the agent
// write a memory through a run, the test writes the same row with `createMemory` and the agent as its author.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { InstructionVersion, Memory, MemoryVersion } from "@vanr/contract";
import { schema } from "@vanr/engine/db";
import { newId } from "@vanr/engine/ids";
import { MEMORY_STORE_MAX_ITEMS } from "@vanr/engine/memory";
import { and, eq } from "drizzle-orm";
import { createMemory } from "../src/agent-memory";
import type { RunningServer } from "../src/server";
import { body, SERVER_TEST_MS, signedIn, startTestServer } from "./harness";
import { memberOf, type Person, seedWorkspace } from "./seed";

let server: RunningServer;
beforeAll(async () => {
  server = await startTestServer();
}, SERVER_TEST_MS);
afterAll(() => server.stop(), SERVER_TEST_MS);

let n = 0;
const email = (who: string) => `${who}${++n}@memory.test`;

/** Ana (the workspace's owner, responsible for Lia) and Beto (a member). */
async function team() {
  const ana = await signedIn(server, "Ana", email("ana"));
  const { workspaceId, general } = await seedWorkspace(server, ana, "Memory");
  const beto = await memberOf(server, workspaceId, "Beto", email("beto"));
  const lia = { id: newId("agt") };
  await server.deps.db.insert(schema.agents).values({
    id: lia.id,
    workspaceId,
    name: "Lia",
    handle: "lia",
    model: "claude-haiku-5-5",
    ownerUserId: ana.user.id,
    appearance: { color: "blue", eyes: "dot", adornment: "none" },
  });
  return { workspaceId, general, ana, beto, lia };
}

class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`${status} ${code}`);
  }
}

/** A request of `who` to the workspace's API; non-2xx answers come back as `{ status, code }`. */
async function call<T>(
  who: Person,
  workspaceId: string,
  method: string,
  path: string,
  data?: unknown,
): Promise<T> {
  const res = await who.browser.json(`/api/v1/workspaces/${workspaceId}${path}`, method, data);
  const json = await body(res);
  if (!res.ok) throw new ApiError(res.status, String(json.error?.code));
  return json;
}
const apiError = (p: Promise<unknown>) =>
  p.then(
    () => {
      throw new Error("expected an error");
    },
    (e: unknown) => {
      if (e instanceof ApiError) return e;
      throw e;
    },
  );

const mems = async (who: Person, workspaceId: string, agentId: string) =>
  (await call<{ memories: Memory[] }>(who, workspaceId, "GET", `/agents/${agentId}/memories`)).memories;
const versions = async (who: Person, workspaceId: string, memoryId: string) =>
  (await call<{ versions: MemoryVersion[] }>(who, workspaceId, "GET", `/memories/${memoryId}/versions`))
    .versions;
const update = (who: Person, workspaceId: string, memoryId: string, data: Record<string, unknown>) =>
  call<Memory>(who, workspaceId, "PATCH", `/memories/${memoryId}`, data);
const create = (who: Person, workspaceId: string, data: Record<string, unknown>) =>
  call<Memory>(who, workspaceId, "POST", "/memories", data);

/** What `remember` writes in the agent's store (the run comes with S6). */
async function remembered(t: Awaited<ReturnType<typeof team>>, text: string) {
  const at = new Date();
  return createMemory(
    server.deps.db,
    at,
    {
      workspaceId: t.workspaceId,
      agentId: t.lia.id,
      scope: "agent",
      text,
      origin: {
        by: { type: "person", id: t.beto.user.id },
        name: "Beto",
        channel: "#general",
        at: at.toISOString(),
      },
    },
    { author: { type: "agent", id: t.lia.id, runId: null }, reason: "remember" },
  );
}

describe("memory: origin, versions and restore", () => {
  test(
    "every edit becomes an immutable version; restoring rewrites; an old hash gives 409",
    async () => {
      const t = await team();
      const { workspaceId, ana, beto, lia } = t;
      await remembered(t, "v1");
      const [mem] = await mems(ana, workspaceId, lia.id);
      if (!mem) throw new Error("no memory");
      const e1 = await update(ana, workspaceId, mem.id, { text: "v2" });
      await update(ana, workspaceId, mem.id, { text: "v3", expectedSha256: e1.sha256, reason: "adjustment" });
      // The person opened v2 and someone else already saved v3: it doesn't overwrite.
      expect(
        (await apiError(update(ana, workspaceId, mem.id, { text: "v4", expectedSha256: e1.sha256 }))).code,
      ).toBe("memory.changed");
      await update(ana, workspaceId, mem.id, { pinned: true }); // pinning is not a version
      const before = await versions(ana, workspaceId, mem.id);
      expect(before.map((v) => [v.seq, v.op, v.text, v.reason])).toEqual([
        [1, "create", "v1", "remember"],
        [2, "update", "v2", ""],
        [3, "update", "v3", "adjustment"],
      ]);
      // Beto doesn't edit Lia's memory, so he doesn't restore it.
      const restore = (who: Person, versionId: string, reason?: string) =>
        call<Memory>(who, workspaceId, "POST", `/memories/${mem.id}/versions/${versionId}/restore`, {
          reason,
        });
      expect((await apiError(restore(beto, before[0]?.id ?? ""))).status).toBe(403);
      const back = await restore(ana, before[0]?.id ?? "", "it was right");
      expect(back.text).toBe("v1");
      const after = await versions(ana, workspaceId, mem.id);
      expect(after.slice(0, 3)).toEqual(before);
      expect(after[3]).toMatchObject({
        seq: 4,
        op: "restore",
        text: "v1",
        restoredFromSeq: 1,
        reason: "it was right",
      });
      expect(after[3]?.author).toEqual({ type: "person", id: ana.user.id });
      // Archiving and unarchiving too.
      await update(ana, workspaceId, mem.id, { archived: true });
      expect((await versions(ana, workspaceId, mem.id)).at(-1)?.op).toBe("archive");
    },
    SERVER_TEST_MS,
  );
});

describe("the three stores", () => {
  test(
    "attack: another person's store doesn't pass",
    async () => {
      const t = await team();
      const { workspaceId, ana, beto, lia } = t;
      // Beto keeps a preference in his store (the memory tool's create, with the agent as its writer).
      const at = new Date();
      await createMemory(
        server.deps.db,
        at,
        {
          workspaceId,
          agentId: lia.id,
          scope: "person",
          ownerUserId: beto.user.id,
          path: "pref.md",
          text: "Beto prefers audio",
          origin: {
            by: { type: "person", id: beto.user.id },
            name: "Beto",
            channel: "#general",
            at: at.toISOString(),
          },
        },
        { author: { type: "agent", id: lia.id, runId: null }, reason: "memory create" },
      );
      // In the API, Beto's store is his alone, and it shows neither in the agent's store nor in the conversation.
      const mine = (who: Person) =>
        call<{ memories: Memory[] }>(who, workspaceId, "GET", "/memories/mine").then((r) => r.memories);
      const [pref] = await mine(beto);
      expect(pref).toMatchObject({ scope: "person", path: "pref.md", agentId: lia.id });
      expect(await mine(ana)).toEqual([]);
      expect((await apiError(versions(ana, workspaceId, pref?.id ?? ""))).status).toBe(404);
      expect((await apiError(update(ana, workspaceId, pref?.id ?? "", { text: "hack" }))).status).toBe(404);
      expect(await mems(ana, workspaceId, lia.id)).toEqual([]);
      expect(
        (await apiError(create(ana, workspaceId, { scope: "workspace", path: "../x.md", text: "x" }))).status,
      ).toBe(400);
      const [row] = await server.deps.db
        .select()
        .from(schema.memories)
        .where(and(eq(schema.memories.workspaceId, workspaceId), eq(schema.memories.scope, "person")));
      expect(row?.ownerUserId).toBe(beto.user.id);
    },
    SERVER_TEST_MS,
  );

  test(
    "the workspace's store: every member reads it, only who manages agents writes",
    async () => {
      const t = await team();
      const { workspaceId, ana, beto } = t;
      expect(
        (await apiError(create(beto, workspaceId, { scope: "workspace", path: "x.md", text: "x" }))).status,
      ).toBe(403);
      await create(ana, workspaceId, {
        scope: "workspace",
        path: "policies/refund.md",
        text: "Refund within 7 days",
      });
      const listed = await call<{ memories: Memory[] }>(beto, workspaceId, "GET", "/memories/workspace");
      expect(listed.memories.map((m) => m.path)).toEqual(["policies/refund.md"]);
    },
    SERVER_TEST_MS,
  );

  test(
    "the store cap holds for creating and for unarchiving",
    async () => {
      const t = await team();
      const { workspaceId, ana } = t;
      const first = await create(ana, workspaceId, { scope: "workspace", path: "old.md", text: "v" });
      await update(ana, workspaceId, first.id, { archived: true });
      const at = new Date();
      const origin = { by: null, name: null, channel: null, at: at.toISOString() };
      for (let i = 0; i < MEMORY_STORE_MAX_ITEMS; i += 1000)
        await server.deps.db.insert(schema.memories).values(
          Array.from({ length: Math.min(1000, MEMORY_STORE_MAX_ITEMS - i) }, (_, k) => ({
            id: `mem_cap${n}_${i + k}`,
            workspaceId,
            scope: "workspace" as const,
            path: `full/${i + k}.md`,
            text: "x",
            origin,
            createdAt: at,
            updatedAt: at,
          })),
        );
      const full = await apiError(
        create(ana, workspaceId, { scope: "workspace", path: "more.md", text: "y" }),
      );
      expect(full.status).toBe(409);
      const back = await apiError(update(ana, workspaceId, first.id, { archived: false }));
      expect(back.status).toBe(409);
    },
    SERVER_TEST_MS * 2,
  );
});

describe("instruction versions", () => {
  /** Lia made through the agents route, so her first version is the one the route writes. */
  async function withLia() {
    const ana = await signedIn(server, "Ana", email("ana"));
    const { workspaceId, general } = await seedWorkspace(server, ana, "Memory");
    const beto = await memberOf(server, workspaceId, "Beto", email("beto"));
    const lia = await call<{ id: string }>(ana, workspaceId, "POST", "/agents", {
      name: "Lia",
      handle: "lia",
      role: "support",
      instructions: "Serves customers.",
      channelIds: [general],
    });
    return { workspaceId, ana, beto, lia };
  }
  const instructionVersions = async (who: Person, workspaceId: string, agentId: string) =>
    (
      await call<{ versions: InstructionVersion[] }>(
        who,
        workspaceId,
        "GET",
        `/agents/${agentId}/instruction-versions`,
      )
    ).versions;

  test(
    "create, edit with a reason, proposal, undo and restore: every change is a version",
    async () => {
      const { workspaceId, ana, beto, lia } = await withLia();
      let list = await instructionVersions(ana, workspaceId, lia.id);
      expect(list.map((v) => [v.seq, v.source, v.text])).toEqual([[1, "create", "Serves customers."]]);
      expect(list[0]?.author).toEqual({ type: "person", id: ana.user.id });

      await call(ana, workspaceId, "PATCH", `/agents/${lia.id}`, {
        instructions: "Serves customers. Briefly.",
        instructionsReason: "long answers",
      });
      // The same text is no version.
      await call(ana, workspaceId, "PATCH", `/agents/${lia.id}`, {
        instructions: "Serves customers. Briefly.",
      });
      list = await instructionVersions(ana, workspaceId, lia.id);
      expect(list[0]).toMatchObject({
        seq: 2,
        source: "edit",
        reason: "long answers",
        text: "Serves customers. Briefly.",
      });

      // An accepted proposal writes a version with the proposal; undoing it writes another. The proposal is the
      // row the agent's propose tool writes (the run comes with the runtime, P16).
      const proposalId = newId("prp");
      await server.deps.db.insert(schema.proposals).values({
        id: proposalId,
        workspaceId,
        agentId: lia.id,
        targetKind: "agent_prompt",
        recipientAgentId: lia.id,
        title: "Language",
        before: "Serves customers. Briefly.",
        after: "Serves customers. Briefly. In English.",
        why: "customers abroad",
      });
      const accepted = await call<{ actionId: string | null }>(
        ana,
        workspaceId,
        "POST",
        `/proposals/${proposalId}/accept`,
      );
      list = await instructionVersions(ana, workspaceId, lia.id);
      expect(list[0]).toMatchObject({ seq: 3, source: "proposal", proposalId, reason: "Language" });
      await call(ana, workspaceId, "POST", `/actions/${accepted.actionId ?? ""}/undo`);
      list = await instructionVersions(ana, workspaceId, lia.id);
      expect(list[0]).toMatchObject({ seq: 4, source: "undo", text: "Serves customers. Briefly." });

      // Going back to the first = writing its text again (nothing old changes).
      const before = JSON.stringify(await instructionVersions(ana, workspaceId, lia.id));
      const first = list.find((v) => v.seq === 1);
      const restore = (who: Person, reason?: string) =>
        call<InstructionVersion>(
          who,
          workspaceId,
          "POST",
          `/agents/${lia.id}/instruction-versions/${first?.id ?? ""}/restore`,
          reason === undefined ? {} : { reason },
        );
      expect((await apiError(restore(beto, "x"))).status).toBe(403);
      expect(await restore(ana, "back to the original")).toMatchObject({
        seq: 5,
        source: "restore",
        restoredFromSeq: 1,
        text: "Serves customers.",
        reason: "back to the original",
      });
      expect((await instructionVersions(ana, workspaceId, lia.id)).slice(1)).toEqual(JSON.parse(before));
      expect((await apiError(restore(ana))).code).toBe("instructions.same");
      expect(
        (await call<{ instructions: string }>(ana, workspaceId, "GET", `/agents/${lia.id}`)).instructions,
      ).toBe("Serves customers.");
    },
    SERVER_TEST_MS,
  );

  test(
    "an agent from before the history: the first edit keeps the text that was there",
    async () => {
      const { workspaceId, ana, lia } = await withLia();
      await server.deps.db
        .delete(schema.instructionVersions)
        .where(eq(schema.instructionVersions.agentId, lia.id));
      await call(ana, workspaceId, "PATCH", `/agents/${lia.id}`, { instructions: "New." });
      const list = await instructionVersions(ana, workspaceId, lia.id);
      expect(list.map((v) => [v.seq, v.source, v.author.type, v.text])).toEqual([
        [2, "edit", "person", "New."],
        [1, "initial", "system", "Serves customers."],
      ]);
    },
    SERVER_TEST_MS,
  );
});
