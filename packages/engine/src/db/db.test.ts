import { expect, expectTypeOf, test } from "bun:test";
import type { AssignmentLimitKind } from "@vanr/contract";
import { sql } from "drizzle-orm";
import { openDb, schema } from "./index";

test("an in-memory PGlite opens and applies the migrations", async () => {
  const { db, close, kind } = await openDb({ kind: "pglite", dataDir: null });
  try {
    expect(kind).toBe("pglite");
    await db.insert(schema.users).values({ id: "u1", name: "Ada", email: "ada@example.com" });
    const rows = await db.select().from(schema.users);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.createdAt).toBeInstanceOf(Date);
    expect(await db.execute(sql`select 1 as one`)).toBeDefined();
  } finally {
    await close();
  }
});

test("assignment ceilings accept the contract's limit kinds for reads and writes", () => {
  expectTypeOf<typeof schema.assignments.$inferSelect.ceiling>().toEqualTypeOf<AssignmentLimitKind | null>();
  expectTypeOf<typeof schema.assignments.$inferInsert.ceiling>().toEqualTypeOf<
    AssignmentLimitKind | null | undefined
  >();
});

test("queue one includes a null trigger and excludes retries", async () => {
  const { db, close } = await openDb({ kind: "pglite", dataDir: null });
  try {
    await db.insert(schema.workspaces).values({ id: "w", name: "Workspace" });
    await db.insert(schema.agents).values({
      id: "a",
      workspaceId: "w",
      name: "Agent",
      handle: "agent",
      model: "test",
      ownerUserId: "u",
      appearance: { color: "blue", eyes: "round", adornment: "none" },
    });
    await db.insert(schema.routines).values({
      id: "r",
      workspaceId: "w",
      name: "Routine",
      prompt: "test",
      agentId: "a",
      target: {},
      trigger: {},
      createdBy: "u",
    });
    const queued = { routineId: "r", status: "queued", at: new Date() } satisfies Partial<
      typeof schema.routineExecutions.$inferInsert
    >;
    await db.insert(schema.routineExecutions).values({ ...queued, id: "null-1", trigger: null });
    await expect(
      db
        .insert(schema.routineExecutions)
        .values({ ...queued, id: "null-2", trigger: null })
        .execute(),
    ).rejects.toThrow();
    await expect(
      db
        .insert(schema.routineExecutions)
        .values({ ...queued, id: "manual", trigger: "manual" })
        .execute(),
    ).rejects.toThrow();
    await db.insert(schema.routineExecutions).values([
      { ...queued, id: "retry-1", trigger: "retry" },
      { ...queued, id: "retry-2", trigger: "retry" },
    ]);
    expect((await db.select().from(schema.routineExecutions)).map((row) => row.id).sort()).toEqual([
      "null-1",
      "retry-1",
      "retry-2",
    ]);
  } finally {
    await close();
  }
});
