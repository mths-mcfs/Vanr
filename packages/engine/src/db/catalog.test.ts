import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import postgres from "postgres";
import { type Catalog, type CatalogQuery, readCatalog } from "./catalog";
import expected from "./fixtures/catalog.json";
import { MIGRATIONS_DIR, openDb } from "./index";

// The fixture is the catalog of the database the product ran on before the port, with every name
// translated to the Vanr vocabulary. The initial migration alone has to rebuild it exactly. Each later
// migration adds a `catalog-<name>.json` next to it with only what it adds; the whole chain has to build
// the fixture plus every one of them, and nothing else.
const fixture: Catalog = expected;

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

const FIXTURES = join(import.meta.dir, "fixtures");
const additions: Partial<Catalog>[] = readdirSync(FIXTURES)
  .filter((f) => /^catalog-.+\.json$/.test(f))
  .map((f) => JSON.parse(readFileSync(join(FIXTURES, f), "utf8")));

const keyOf = (x: unknown) => (typeof x === "string" ? x : JSON.stringify(x));
const sortKey = (x: unknown) =>
  typeof x === "string"
    ? x
    : typeof x === "object" && x && "table" in x && "name" in x
      ? `${String(x.table)}.${String(x.name)}`
      : typeof x === "object" && x && "name" in x
        ? String(x.name)
        : keyOf(x);

/** The fixture plus every later migration's additions, in the order `readCatalog` sorts. */
function finalCatalog(): Catalog {
  const out = structuredClone(fixture);
  for (const add of additions)
    for (const key of sections) (out[key] as unknown[]).push(...((add[key] ?? []) as unknown[]));
  for (const key of sections)
    (out[key] as unknown[]).sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0));
  return out;
}

/** Compares section by section, so a failure names what differs instead of dumping the whole catalog. */
async function expectCatalog(query: CatalogQuery, want: Catalog) {
  const actual = await readCatalog(query);
  for (const key of sections) {
    expect({ [key]: actual[key] }).toEqual({ [key]: want[key] });
  }
}

/** Applies only the initial migration, statement by statement, as the migrator does. */
async function applyInitial(pg: PGlite) {
  const text = readFileSync(join(MIGRATIONS_DIR, "0000_init.sql"), "utf8");
  for (const statement of text.split("--> statement-breakpoint"))
    if (statement.trim()) await pg.exec(statement);
}

describe("the initial migration", () => {
  test("alone builds the historical catalog on PGlite", async () => {
    const pg = new PGlite({ extensions: { pg_trgm } });
    try {
      await applyInitial(pg);
      await expectCatalog(async (text) => (await pg.query<Record<string, unknown>>(text)).rows, fixture);
    } finally {
      await pg.close();
    }
  });

  test("the whole chain builds the historical catalog plus each migration's additions on PGlite", async () => {
    expect(additions.length).toBeGreaterThan(0);
    // An addition never repeats what the fixture already has: it is new, not a rewrite of the old.
    for (const add of additions)
      for (const key of sections) {
        const old = new Set((fixture[key] as unknown[]).map(keyOf));
        expect(((add[key] ?? []) as unknown[]).filter((x) => old.has(keyOf(x)))).toEqual([]);
      }
    const pg = new PGlite({ extensions: { pg_trgm } });
    try {
      await migrate(drizzle({ client: pg }), { migrationsFolder: MIGRATIONS_DIR });
      await expectCatalog(
        async (text) => (await pg.query<Record<string, unknown>>(text)).rows,
        finalCatalog(),
      );
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
        expect(actual).not.toEqual(finalCatalog());
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
  test.skipIf(!url)("the whole chain builds the expected catalog on Postgres", async () => {
    // openDb applies the migrations; its client is not exposed, so a second one reads the catalog.
    const { close } = await openDb({ kind: "postgres", url: url ?? "" });
    await close();
    const sql = postgres(url ?? "", { max: 1, onnotice: () => {} });
    try {
      await expectCatalog(async (text) => [...(await sql.unsafe(text))], finalCatalog());
    } finally {
      await sql.end({ timeout: 5 });
    }
  });
});
