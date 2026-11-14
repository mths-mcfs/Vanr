import { describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import postgres from "postgres";
import { type Catalog, type CatalogQuery, readCatalog } from "./catalog";
import expected from "./fixtures/catalog.json";
import { MIGRATIONS_DIR, openDb } from "./index";

// The fixture is the catalog of the database the product ran on before the port, with every name
// translated to the Vanr vocabulary. The single initial migration has to rebuild it exactly.
const fixture: Catalog = expected;

/** Compares section by section, so a failure names what differs instead of dumping the whole catalog. */
async function expectFixture(query: CatalogQuery) {
  const actual = await readCatalog(query);
  const sections = [
    "extensions",
    "tables",
    "columns",
    "constraints",
    "indexes",
    "sequences",
    "triggers",
    "functions",
  ] as const;
  for (const key of sections) {
    expect({ [key]: actual[key] }).toEqual({ [key]: fixture[key] });
  }
}

describe("the initial migration", () => {
  test("builds the expected catalog on PGlite", async () => {
    const pg = new PGlite({ extensions: { pg_trgm } });
    try {
      await migrate(drizzle({ client: pg }), { migrationsFolder: MIGRATIONS_DIR });
      await expectFixture(async (text) => (await pg.query<Record<string, unknown>>(text)).rows);
    } finally {
      await pg.close();
    }
  });

  // The comparison has to see these drifts; each one leaves every other part of the catalog alone.
  const drifts = [
    ["a disabled trigger", "alter table browser_log_entries disable trigger user"],
    ["a column collation", 'alter table browser_log_entries alter column url type text collate "C"'],
  ] as const;
  for (const [what, statement] of drifts) {
    test(`notices ${what}`, async () => {
      const pg = new PGlite({ extensions: { pg_trgm } });
      try {
        await migrate(drizzle({ client: pg }), { migrationsFolder: MIGRATIONS_DIR });
        await pg.exec(statement);
        const actual = await readCatalog(
          async (text) => (await pg.query<Record<string, unknown>>(text)).rows,
        );
        expect(actual).not.toEqual(fixture);
      } finally {
        await pg.close();
      }
    });
  }

  test("tells apart collations of the same name in different schemas", async () => {
    const pg = new PGlite();
    try {
      await pg.exec(`create schema a; create schema b;
        create collation a.same from "C"; create collation b.same from "C";
        create table t (v text collate a.same)`);
      const query = async (text: string) => (await pg.query<Record<string, unknown>>(text)).rows;
      const before = await readCatalog(query);
      await pg.exec("alter table t alter column v type text collate b.same");
      expect(await readCatalog(query)).not.toEqual(before);
    } finally {
      await pg.close();
    }
  });

  // Runs only where a disposable Postgres is available (the CI job starts one); never point it at a
  // database you care about: it applies the migrations there.
  const url = process.env.VANR_TEST_POSTGRES_URL;
  test.skipIf(!url)("builds the expected catalog on Postgres", async () => {
    // openDb applies the migrations; its client is not exposed, so a second one reads the catalog.
    const { close } = await openDb({ kind: "postgres", url: url ?? "" });
    await close();
    const sql = postgres(url ?? "", { max: 1, onnotice: () => {} });
    try {
      await expectFixture(async (text) => [...(await sql.unsafe(text))]);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });
});
