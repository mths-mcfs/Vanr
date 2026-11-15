import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import postgres from "postgres";
import { type Catalog, type CatalogQuery, readCatalog } from "./catalog";
import expected from "./fixtures/catalog.json";
import basesRelations from "./fixtures/catalog-bases-relations.json";
import { MIGRATIONS_DIR, openDb } from "./index";

// The fixture is the catalog of the database the product ran on before the port, with every name
// translated to the Vanr vocabulary. The initial migration alone has to rebuild it exactly; each later
// migration adds what its own fixture lists (and changes nothing else), so the whole chain builds the
// historical catalog plus those additions.
const fixture: Catalog = expected;
/** What each migration after the initial one adds, in the order of the journal. */
const additions: Partial<Catalog>[] = [basesRelations];

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

const key = (x: unknown) => JSON.stringify(x);
const sorted = <T>(xs: readonly T[]) =>
  [...xs].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));

/**
 * Compares section by section, so a failure names what differs instead of dumping the whole catalog. With
 * `added`, the expected catalog is the fixture plus those additions.
 */
async function expectFixture(query: CatalogQuery, added: readonly Partial<Catalog>[] = []) {
  const actual = await readCatalog(query);
  for (const section of sections) {
    const want: unknown[] = [...fixture[section], ...added.flatMap((a): unknown[] => a[section] ?? [])];
    const got: unknown[] = actual[section];
    expect({ [section]: added.length ? sorted(got) : got }).toEqual({
      [section]: added.length ? sorted(want) : want,
    });
  }
}

/** Applies only the initial migration's statements, as the migrator would. */
async function initialOnly(pg: PGlite) {
  const text = await Bun.file(join(MIGRATIONS_DIR, "0000_init.sql")).text();
  for (const statement of text.split("--> statement-breakpoint"))
    if (statement.trim()) await pg.exec(statement);
}

describe("the migrations", () => {
  test("the initial one alone builds the historical catalog on PGlite", async () => {
    const pg = new PGlite({ extensions: { pg_trgm } });
    try {
      await initialOnly(pg);
      await expectFixture(async (text) => (await pg.query<Record<string, unknown>>(text)).rows);
    } finally {
      await pg.close();
    }
  });

  test("the whole chain builds the historical catalog plus each migration's additions on PGlite", async () => {
    const pg = new PGlite({ extensions: { pg_trgm } });
    try {
      await migrate(drizzle({ client: pg }), { migrationsFolder: MIGRATIONS_DIR });
      await expectFixture(async (text) => (await pg.query<Record<string, unknown>>(text)).rows, additions);
    } finally {
      await pg.close();
    }
  });

  test("every migration in the journal has its additions listed", async () => {
    const journal = await Bun.file(join(MIGRATIONS_DIR, "meta", "_journal.json")).json();
    expect(journal.entries.length).toBe(1 + additions.length);
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
        const query = async (text: string) => (await pg.query<Record<string, unknown>>(text)).rows;
        // the chain's catalog is the fixture plus the additions: the drift must show against that
        const before = await readCatalog(query);
        await pg.exec(statement);
        expect(await readCatalog(query)).not.toEqual(before);
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
      await expectFixture(async (text) => [...(await sql.unsafe(text))], additions);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });
});
