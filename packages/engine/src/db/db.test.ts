import { expect, test } from "bun:test";
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
