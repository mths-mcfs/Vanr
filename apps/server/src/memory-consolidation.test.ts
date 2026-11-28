// Memory consolidation: the job asks the runtime for the proposal (`complete`). Applying, discarding, listing and
// cleaning the model's proposal, over a consolidation the job saved or one saved the way the job saves it.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { schema } from "@vanr/engine/db";
import { newId } from "@vanr/engine/ids";
import { contentSha256, MEMORY_ITEM_MAX_BYTES } from "@vanr/engine/memory";
import { and, asc, eq } from "drizzle-orm";
import { SERVER_TEST_MS, signedIn, startTestServer } from "../test/harness";
import { seedWorkspace } from "../test/seed";
import { createMemory, type MemoryRow, memoryPrompt } from "./agent-memory";
import type { AgentRow } from "./agents";
import type { WorkspaceMember } from "./context";
import { isUniqueViolation } from "./db-errors";
import { HttpError } from "./http";
import {
  applyConsolidation,
  consolidationsOf,
  discardConsolidation,
  normalizeItems,
  startConsolidation,
  toConsolidation,
} from "./memory-consolidation";
import { approveReview, queueMemoryReview } from "./memory-reviews";
import type { RunningServer } from "./server";

const { memories, memoryConsolidations, memoryVersions } = schema;
type Consolidation = typeof memoryConsolidations.$inferSelect;
type Item = Consolidation["items"][number];

let server: RunningServer;
let me: WorkspaceMember;
let workspaceId: string;

beforeAll(async () => {
  server = await startTestServer();
  const ana = await signedIn(server, "Ana", "ana@consolidation.test");
  ({ workspaceId } = await seedWorkspace(server, ana, "Memory"));
  me = { workspaceId, userId: ana.user.id, role: "owner", handle: "ana" };
}, SERVER_TEST_MS);
afterAll(() => server.stop(), SERVER_TEST_MS);

async function newAgent(handle: string): Promise<AgentRow> {
  const [row] = await server.deps.db
    .insert(schema.agents)
    .values({
      id: newId("agt"),
      workspaceId,
      name: handle,
      handle,
      role: "support",
      instructions: "",
      model: "claude-haiku-5-5",
      ownerUserId: me.userId,
      appearance: { color: "blue", eyes: "dot", adornment: "none" },
    })
    .returning();
  if (!row) throw new Error("no agent");
  return row;
}

const author = () => ({ type: "person" as const, id: me.userId });

function remember(
  agent: AgentRow,
  text: string,
  extra: { path?: string; pinned?: boolean; untrusted?: boolean } = {},
) {
  return createMemory(
    server.deps.db,
    server.deps.now(),
    {
      workspaceId,
      agentId: agent.id,
      scope: "agent",
      path: extra.path ?? null,
      text,
      kind: "fact",
      pinned: extra.pinned ?? false,
      untrustedSource: extra.untrusted ?? false,
      source: "manual",
      origin: { by: author(), name: null, channel: null, at: server.deps.now().toISOString() },
    },
    { author: author() },
  );
}

/** A consolidation as the job leaves it when the model answered: `ready`, with the hashes of what it read. */
async function readyConsolidation(agent: AgentRow, read: MemoryRow[], items: Item[]): Promise<Consolidation> {
  const [row] = await server.deps.db
    .insert(memoryConsolidations)
    .values({
      id: newId("mcn"),
      workspaceId,
      agentId: agent.id,
      status: "ready",
      items,
      bases: Object.fromEntries(read.map((r) => [r.id, contentSha256(r.text)])),
      covered: read.length,
      total: read.length,
      createdBy: me.userId,
    })
    .returning();
  if (!row) throw new Error("no consolidation");
  return row;
}

const item = (action: Item["action"], sources: MemoryRow[], text: string, reason = ""): Item => ({
  action,
  sources: sources.map((s) => s.id),
  path: sources[0]?.path ?? null,
  text,
  reason,
  untrustedSource: sources.some((s) => s.untrustedSource),
});

const memoryOf = async (id: string) => {
  const [row] = await server.deps.db.select().from(memories).where(eq(memories.id, id));
  if (!row) throw new Error(`no memory ${id}`);
  return row;
};

const failure = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (err) {
    if (err instanceof HttpError) return { status: err.status, code: err.code };
    throw err;
  }
  throw new Error("expected an HttpError");
};

describe("starting", () => {
  test("starting a consolidation asks the runtime for the proposal, which comes back ready to review", async () => {
    const agent = await newAgent("lia");
    await remember(agent, "The office opens at 9.");
    await remember(agent, "the office opens at 9.");
    const row = await startConsolidation(server.deps, me, agent);
    await server.deps.runtime.settle();
    const [ready] = await consolidationsOf(server.deps.db, agent);
    expect(ready).toMatchObject({ id: row.id, status: "ready" });
    expect(ready?.items.length).toBeGreaterThan(0);
    const [run] = await server.deps.db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.id, ready?.runId ?? ""));
    expect([run?.status, run?.agentId]).toEqual(["done", agent.id]);
  });

  test("a rejected completion fails the job and allows another consolidation to start", async () => {
    const agent = await newAgent("rejected");
    await remember(agent, "Office opens at 9");
    await remember(agent, "office opens at 9");
    const deps = {
      ...server.deps,
      runtime: {
        ...server.deps.runtime,
        complete: async () => {
          throw new Error("provider connection lost");
        },
      },
    };
    const row = await startConsolidation(deps, me, agent);
    await deps.runtime.settle();
    const [failed] = await consolidationsOf(deps.db, agent);
    expect(failed).toMatchObject({ id: row.id, status: "failed", error: "provider connection lost" });
    expect(failed?.decidedAt).toBeInstanceOf(Date);
    const next = await startConsolidation(deps, me, agent);
    await deps.runtime.settle();
    expect(next.id).not.toBe(row.id);
  });

  test("an agent has one open consolidation at most: a second open one is rejected by the database", async () => {
    const agent = await newAgent("one");
    const a = await remember(agent, "A");
    await readyConsolidation(agent, [a], [item("keep", [a], "A")]);
    const err = await server.deps.db
      .insert(memoryConsolidations)
      .values({ id: newId("mcn"), workspaceId, agentId: agent.id, status: "running" })
      .catch((e: unknown) => e);
    expect(isUniqueViolation(err)).toBe(true);
  });
});

describe("cleaning the model's proposal", () => {
  test("only ids it read, each once, the untrusted mark from the sources and every forgotten item kept", async () => {
    const agent = await newAgent("norm");
    const a = await remember(agent, "Alpha", { path: "/a.md" });
    const b = await remember(agent, "Beta", { untrusted: true });
    const c = await remember(agent, "Gamma");
    const d = await remember(agent, "Delta");
    const e = await remember(agent, "Epsilon");
    const read = [a, b, c, d, e];
    const out = normalizeItems(
      [
        // Merging a trusted item with an untrusted one: the result is untrusted, whatever the model says.
        {
          action: "merge",
          sources: [a.id, b.id, "mem_elsewhere"],
          text: "  Alpha and beta ",
          reason: " Same ",
        },
        // `a` was used already; a merge left with one source is a rewrite.
        { action: "merge", sources: [a.id, c.id], text: "Gamma, better" },
        // A rewrite of two is a merge, but both were taken; a keep of two and a merge without text are dropped.
        { action: "rewrite", sources: [a.id, b.id], text: "Again" },
        { action: "keep", sources: [d.id, e.id] },
        { action: "merge", sources: [d.id, e.id], text: "   " },
        { action: "drop", sources: [d.id], reason: "x".repeat(400) },
      ],
      read,
    );
    expect(out).toEqual([
      {
        action: "merge",
        sources: [a.id, b.id],
        path: "/a.md",
        text: "Alpha and beta",
        reason: "Same",
        untrustedSource: true,
      },
      {
        action: "rewrite",
        sources: [c.id],
        path: null,
        text: "Gamma, better",
        reason: "",
        untrustedSource: false,
      },
      {
        action: "drop",
        sources: [d.id],
        path: null,
        text: "Delta",
        reason: "x".repeat(300),
        untrustedSource: false,
      },
      { action: "keep", sources: [e.id], path: null, text: "Epsilon", reason: "", untrustedSource: false },
    ]);
  });

  test("a new text over the item limit is left out, one at the limit goes in", async () => {
    const agent = await newAgent("big");
    const a = await remember(agent, "Short");
    const b = await remember(agent, "Other");
    const atLimit = "y".repeat(MEMORY_ITEM_MAX_BYTES);
    const over = `${atLimit}y`;
    expect(normalizeItems([{ action: "rewrite", sources: [a.id], text: over }], [a])).toEqual([
      { action: "keep", sources: [a.id], path: null, text: "Short", reason: "", untrustedSource: false },
    ]);
    expect(normalizeItems([{ action: "rewrite", sources: [b.id], text: atLimit }], [b])[0]?.text).toBe(
      atLimit,
    );
  });
});

describe("applying", () => {
  test.each(["rewrite", "merge"] as const)(
    "%s preserves a source marked untrusted by an identical-text review after the read",
    async (action) => {
      const agent = await newAgent(`trust_${action}`);
      const a = await remember(agent, "Office opens at 9");
      const b = await remember(agent, "office opens at 9");
      const text = "The office opens at 9.";
      const row = await readyConsolidation(
        agent,
        [a, b],
        normalizeItems([{ action, sources: action === "merge" ? [a.id, b.id] : [a.id], text }], [a, b]),
      );
      const source = action === "merge" ? b : a;
      const review = await queueMemoryReview(server.deps, {
        workspaceId,
        agentId: agent.id,
        scope: "agent",
        op: "update",
        memoryId: source.id,
        text: source.text,
        baseSha256: contentSha256(source.text),
        reasons: [{ flag: "A", source: "mail_read inbox/1" }],
        origin: { by: author(), name: null, channel: null, at: server.deps.now().toISOString() },
        tool: "memory",
      });
      expect((await approveReview(server.deps, me, review.id)).status).toBe("approved");
      expect(await memoryOf(source.id)).toMatchObject({ text: source.text, untrustedSource: true });
      expect((await applyConsolidation(server.deps, me, agent, row.id)).status).toBe("applied");
      const [result] = await server.deps.db
        .select()
        .from(memories)
        .where(and(eq(memories.agentId, agent.id), eq(memories.text, text), eq(memories.archived, false)));
      if (!result) throw new Error("no consolidated memory");
      expect(result.untrustedSource).toBe(true);
      const prompt = await memoryPrompt(server.deps.db, server.deps.now(), {
        workspaceId,
        agentId: agent.id,
        personId: null,
        channelId: null,
      });
      expect(prompt.split("\n").find((line) => line.includes(`[${result.id}]`))).toContain(
        "from an untrusted source",
      );
    },
  );

  test("rewrites, merges and drops through the versioned writer, and marks what it read as vetted", async () => {
    const agent = await newAgent("apply");
    const a = await remember(agent, "Office opens at 9", { path: "/office.md", pinned: true });
    const b = await remember(agent, "office opens at 9");
    const c = await remember(agent, "Lunch is at noon-ish");
    const d = await remember(agent, "Old promo code");
    const e = await remember(agent, "Kept as is");
    const read = [a, b, c, d, e];
    const row = await readyConsolidation(agent, read, [
      item("merge", [a, b], "The office opens at 9.", "duplicates"),
      item("rewrite", [c], "Lunch is at noon."),
      item("drop", [d], "Old promo code", "expired"),
      item("keep", [e], "Kept as is"),
    ]);
    const applied = await applyConsolidation(server.deps, me, agent, row.id);
    expect(applied).toMatchObject({ status: "applied", deciderUserId: me.userId });
    expect(toConsolidation(applied)).toMatchObject({ id: row.id, agentId: agent.id, status: "applied" });

    for (const gone of [a, b, d]) expect((await memoryOf(gone.id)).archived).toBe(true);
    expect((await memoryOf(c.id)).text).toBe("Lunch is at noon.");
    const kept = await memoryOf(e.id);
    expect(kept.archived).toBe(false);
    expect(kept.vettedAt).not.toBeNull();
    const merged = await server.deps.db
      .select()
      .from(memories)
      .where(and(eq(memories.agentId, agent.id), eq(memories.source, "consolidation")));
    expect(merged.map((m) => [m.text, m.path, m.pinned, m.archived])).toEqual([
      ["The office opens at 9.", "/office.md", true, false],
    ]);
    const versions = await server.deps.db
      .select()
      .from(memoryVersions)
      .where(eq(memoryVersions.memoryId, c.id))
      .orderBy(asc(memoryVersions.seq));
    expect(versions.map((v) => [v.op, v.text])).toEqual([
      ["create", "Lunch is at noon-ish"],
      ["update", "Lunch is at noon."],
    ]);
    expect(await failure(applyConsolidation(server.deps, me, agent, row.id))).toEqual({
      status: 409,
      code: "memory_consolidation.closed",
    });
  });

  test("an item that changed after the read changes nothing and fails the consolidation", async () => {
    const agent = await newAgent("stale");
    const a = await remember(agent, "One");
    const b = await remember(agent, "one");
    const row = await readyConsolidation(agent, [a, b], [item("merge", [a, b], "One.")]);
    await server.deps.db.update(memories).set({ text: "One, edited" }).where(eq(memories.id, b.id));
    expect(await failure(applyConsolidation(server.deps, me, agent, row.id))).toEqual({
      status: 409,
      code: "memory_consolidation.changed",
    });
    expect((await memoryOf(a.id)).archived).toBe(false);
    const [after] = await server.deps.db
      .select()
      .from(memoryConsolidations)
      .where(eq(memoryConsolidations.id, row.id));
    expect(after).toMatchObject({ status: "failed", error: "changed", deciderUserId: me.userId });
  });

  test("two applies at once: one applies and the other finds it closed, with one merged item", async () => {
    const agent = await newAgent("twice");
    const a = await remember(agent, "Twice");
    const b = await remember(agent, "twice");
    const row = await readyConsolidation(agent, [a, b], [item("merge", [a, b], "Twice.")]);
    const results = await Promise.all(
      [1, 2].map(() =>
        applyConsolidation(server.deps, me, agent, row.id).then(
          (r) => r.status,
          (e: unknown) => (e instanceof HttpError ? e.code : "other"),
        ),
      ),
    );
    expect(results.sort()).toEqual(["applied", "memory_consolidation.closed"]);
    const merged = await server.deps.db
      .select()
      .from(memories)
      .where(and(eq(memories.agentId, agent.id), eq(memories.source, "consolidation")));
    expect(merged.length).toBe(1);
  });

  test("another agent's consolidation is not found", async () => {
    const agent = await newAgent("owner");
    const other = await newAgent("other");
    const a = await remember(agent, "Mine");
    const row = await readyConsolidation(agent, [a], [item("keep", [a], "Mine")]);
    expect(await failure(applyConsolidation(server.deps, me, other, row.id))).toEqual({
      status: 404,
      code: "not_found",
    });
    expect(await failure(discardConsolidation(server.deps, me, other, row.id))).toEqual({
      status: 404,
      code: "not_found",
    });
  });
});

describe("discarding and listing", () => {
  test("a ready consolidation is discarded once; then neither discard nor apply reach it", async () => {
    const agent = await newAgent("discard");
    const a = await remember(agent, "Keep me");
    const b = await remember(agent, "keep me");
    const row = await readyConsolidation(agent, [a, b], [item("merge", [a, b], "Keep me.")]);
    const discarded = await discardConsolidation(server.deps, me, agent, row.id);
    expect(discarded).toMatchObject({ status: "discarded", deciderUserId: me.userId });
    expect(discarded.decidedAt).not.toBeNull();
    for (const again of [discardConsolidation, applyConsolidation])
      expect(await failure(again(server.deps, me, agent, row.id))).toEqual({
        status: 409,
        code: "memory_consolidation.closed",
      });
    expect((await memoryOf(a.id)).archived).toBe(false);
  });

  test("the list shows the agent's 20 newest", async () => {
    const agent = await newAgent("list");
    const base = Date.parse("2026-11-01T00:00:00.000Z");
    await server.deps.db.insert(memoryConsolidations).values(
      Array.from({ length: 21 }, (_, i) => ({
        id: newId("mcn"),
        workspaceId,
        agentId: agent.id,
        status: "discarded" as const,
        createdAt: new Date(base + i * 60_000),
      })),
    );
    const list = await consolidationsOf(server.deps.db, agent);
    expect(list.length).toBe(20);
    expect(list[0]?.createdAt.toISOString()).toBe(new Date(base + 20 * 60_000).toISOString());
    expect(list.at(-1)?.createdAt.toISOString()).toBe(new Date(base + 60_000).toISOString());
  });
});
