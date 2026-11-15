// The memory review queue: who decides (the agent's editors in the agent's store, only the person in theirs), an
// approval applies the write once even with two decisions at once, and a memory that changed since the agent asked
// fails the review without applying anything.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { schema } from "@vanr/engine/db";
import { newId } from "@vanr/engine/ids";
import { contentSha256 } from "@vanr/engine/memory";
import { eq } from "drizzle-orm";
import { SERVER_TEST_MS, signedIn, startTestServer } from "../test/harness";
import { createMemory } from "./agent-memory";
import type { WorkspaceMember } from "./context";
import { HttpError } from "./http";
import { createWorkspace, joinWorkspace } from "./members";
import {
  approveReview,
  type NewMemoryReview,
  queueMemoryReview,
  rejectReview,
  reviewsFor,
  toMemoryReview,
} from "./memory-reviews";
import type { RunningServer } from "./server";

let server: RunningServer;
let workspaceId: string;
let agentId: string;
let ana: WorkspaceMember;
let beto: WorkspaceMember;
beforeAll(async () => {
  server = await startTestServer();
  const a = await signedIn(server, "Ana", "ana@reviews.test");
  const b = await signedIn(server, "Beto", "beto@reviews.test");
  ({ workspaceId } = await createWorkspace(server.deps.db, { name: "Reviews", context: "", user: a.user }));
  await joinWorkspace(server.deps.db, { workspaceId, userId: b.user.id, name: "Beto", role: "member" });
  ana = { workspaceId, userId: a.user.id, role: "owner", handle: "ana" };
  beto = { workspaceId, userId: b.user.id, role: "member", handle: "beto" };
  agentId = newId("agt");
  await server.deps.db.insert(schema.agents).values({
    id: agentId,
    workspaceId,
    name: "Lia",
    handle: "lia",
    model: "claude-haiku-5-5",
    // Beto owns the agent: he edits it without managing agents.
    ownerUserId: b.user.id,
    appearance: { color: "blue", eyes: "dot", adornment: "none" },
  });
}, SERVER_TEST_MS);
afterAll(() => server.stop(), SERVER_TEST_MS);

const origin = {
  at: new Date().toISOString(),
  by: null,
  channel: null,
  name: null,
  untrusted: ["mail_read inbox/1"],
};
const review = (over: Partial<NewMemoryReview> = {}) =>
  queueMemoryReview(server.deps, {
    workspaceId,
    agentId,
    runId: null,
    scope: "agent",
    ownerUserId: null,
    op: "create",
    memoryId: null,
    path: `notes/${newId("p")}.md`,
    newPath: null,
    text: "The client prefers email.",
    kind: "preference",
    about: null,
    replaces: null,
    reasons: [{ flag: "A", source: "mail_read inbox/1" }],
    origin,
    tool: "memory",
    baseSha256: null,
    ...over,
  });

const code = (p: Promise<unknown>) =>
  p.then(
    () => "ok",
    (e: unknown) => (e instanceof HttpError ? e.code : String(e)),
  );

describe("memory reviews", () => {
  test("in the agent's store its editors decide; in a person's store only that person, and it hides from others", async () => {
    const agentStore = await review();
    const personal = await review({ scope: "person", ownerUserId: ana.userId });
    const outsider: WorkspaceMember = { workspaceId, userId: newId("usr"), role: "member", handle: "x" };
    expect((await reviewsFor(server.deps.db, beto, agentId)).map((r) => r.id)).toEqual([agentStore.id]);
    expect((await reviewsFor(server.deps.db, ana, agentId)).map((r) => r.id).sort()).toEqual(
      [agentStore.id, personal.id].sort(),
    );
    expect(await code(approveReview(server.deps, outsider, agentStore.id))).toBe("forbidden");
    expect(await code(rejectReview(server.deps, beto, personal.id, null))).toBe("not_found");
    expect(
      await code(approveReview(server.deps, { ...ana, workspaceId: "workspace_other" }, agentStore.id)),
    ).toBe("not_found");
    const done = await approveReview(server.deps, beto, agentStore.id);
    expect(toMemoryReview(done)).toMatchObject({
      status: "approved",
      deciderUserId: beto.userId,
      reasons: ["mail_read inbox/1"],
    });
    const [memory] = await server.deps.db
      .select()
      .from(schema.memories)
      .where(eq(schema.memories.id, done.resultMemoryId ?? ""));
    expect(memory).toMatchObject({
      text: "The client prefers email.",
      untrustedSource: true,
      verified: true,
      agentId,
    });
    expect(await code(rejectReview(server.deps, ana, personal.id, "no"))).toBe("ok");
  });

  test("two decisions at once apply the write at most once", async () => {
    const row = await review();
    const results = await Promise.all([
      code(approveReview(server.deps, beto, row.id)),
      code(approveReview(server.deps, ana, row.id)),
      code(rejectReview(server.deps, ana, row.id, "late")),
    ]);
    expect(results.filter((r) => r === "ok")).toHaveLength(1);
    expect(results.filter((r) => r !== "ok").every((r) => r === "memory_review.decided")).toBe(true);
    const memories = await server.deps.db
      .select()
      .from(schema.memories)
      .where(eq(schema.memories.path, row.path ?? ""));
    const [after] = await server.deps.db
      .select()
      .from(schema.memoryReviews)
      .where(eq(schema.memoryReviews.id, row.id));
    expect(memories).toHaveLength(after?.status === "approved" ? 1 : 0);
  });

  test("a memory that changed since the agent asked fails the review and nothing is applied", async () => {
    const memory = await createMemory(
      server.deps.db,
      server.deps.now(),
      {
        workspaceId,
        agentId,
        scope: "agent",
        path: `notes/${newId("m")}.md`,
        text: "Now",
        kind: "fact",
        source: "manual",
        origin,
      },
      { author: { type: "person", id: ana.userId } },
    );
    const row = await review({
      op: "update",
      memoryId: memory.id,
      path: memory.path,
      text: "Agent's version",
      baseSha256: contentSha256("What the agent read"),
    });
    expect(await code(approveReview(server.deps, ana, row.id))).toBe("memory_review.changed");
    const [after] = await server.deps.db
      .select()
      .from(schema.memoryReviews)
      .where(eq(schema.memoryReviews.id, row.id));
    expect(after).toMatchObject({ status: "failed", note: "changed_since", deciderUserId: ana.userId });
    const [kept] = await server.deps.db
      .select()
      .from(schema.memories)
      .where(eq(schema.memories.id, memory.id));
    expect(kept?.text).toBe("Now");
  });
});
