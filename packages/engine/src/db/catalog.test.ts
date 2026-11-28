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
import confinedLessons from "./fixtures/catalog-confined-lessons-and-free-channel-names.json";
import identityFirstAttempt from "./fixtures/catalog-identity-first-attempt.json";
import messageEffects from "./fixtures/catalog-message-effects.json";
import wikiAnnotations from "./fixtures/catalog-wiki-annotations.json";
import { MIGRATIONS_DIR, openDb } from "./index";

// The fixture is the catalog of the database the product ran on before the port, with every name
// translated to the Vanr vocabulary. The initial migration alone has to rebuild it exactly; each later
// migration adds what its own fixture lists, or redefines an object of the same table and name (an index whose
// condition changed), and changes nothing else, so the whole chain builds the historical catalog plus those.
const fixture: Catalog = expected;
/** What each migration after the initial one adds, in the order of the journal. */
const additions: Partial<Catalog>[] = [
  basesRelations,
  wikiAnnotations,
  identityFirstAttempt,
  messageEffects,
  confinedLessons,
];

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
const named = (x: unknown) => x as { table?: string; name?: string };
const sameObject = (a: unknown, b: unknown) =>
  named(a).name !== undefined && named(a).table === named(b).table && named(a).name === named(b).name;
const sorted = <T>(xs: readonly T[]) =>
  [...xs].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));

/**
 * Compares section by section, so a failure names what differs instead of dumping the whole catalog. With
 * `added`, the expected catalog is the fixture plus those additions.
 */
async function expectFixture(query: CatalogQuery, added: readonly Partial<Catalog>[] = []) {
  const actual = await readCatalog(query);
  for (const section of sections) {
    let want: unknown[] = [...fixture[section]];
    // A later entry with the same table and name replaces the earlier one (the migration redefined it).
    for (const item of added.flatMap((a): unknown[] => a[section] ?? []))
      want = [...want.filter((w) => !sameObject(w, item)), item];
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

  test("0005 confines the old feedback lessons of a private channel or a DM, and only those, and drops people from private debates' search readers, once", async () => {
    const pg = new PGlite({ extensions: { pg_trgm } });
    try {
      const journal = await Bun.file(join(MIGRATIONS_DIR, "meta", "_journal.json")).json();
      const tags: string[] = journal.entries.map((e: { tag: string }) => e.tag);
      const run = async (tag: string) => {
        const text = await Bun.file(join(MIGRATIONS_DIR, `${tag}.sql`)).text();
        for (const statement of text.split("--> statement-breakpoint"))
          if (statement.trim()) await pg.exec(statement);
      };
      const backfill = tags.find((t) => t.startsWith("0005_")) ?? "";
      for (const tag of tags.slice(0, tags.indexOf(backfill))) await run(tag);
      await pg.exec(`
        insert into workspaces (id, name) values ('w', 'W');
        insert into channels (id, workspace_id, name, visibility) values
          ('ch_open', 'w', 'open', 'public'), ('ch_secret', 'w', 'secret', 'private');
        insert into channels (id, workspace_id, name, kind, dm_key) values ('ch_dm', 'w', 'dm', 'dm', 'a|b');
        insert into agents (id, workspace_id, name, handle, model, owner_user_id, appearance)
          values ('ag', 'w', 'Lia', 'lia', 'm', 'u', '{}');
        insert into messages (id, workspace_id, channel_id, author_kind, author_id, body) values
          ('m_open', 'w', 'ch_open', 'person', 'u', 'x'), ('m_secret', 'w', 'ch_secret', 'person', 'u', 'x'),
          ('m_dm', 'w', 'ch_dm', 'person', 'u', 'x');
        insert into memories (id, workspace_id, agent_id, text, source, origin_message_id) values
          ('l_open', 'w', 'ag', 'a', 'feedback', 'm_open'), ('l_secret', 'w', 'ag', 'b', 'feedback', 'm_secret'),
          ('l_dm', 'w', 'ag', 'c', 'feedback', 'm_dm'), ('l_gone', 'w', 'ag', 'd', 'feedback', 'm_deleted'),
          ('n_secret', 'w', 'ag', 'e', 'conversation', 'm_secret');
        insert into search_chunks (workspace_id, source_kind, source_id, ordinal, title, title_fold, text, tsv, url,
          scope_kind, channel_id, principals, created_at, updated_at, text_hash) values
          ('w', 'debate', 'deb', 0, 't', 't', 'x', ''::tsvector, '/d', 'channel', 'ch_secret',
            '{user:u1,agent:ag,user:u2}', now(), now(), 'h'),
          ('w', 'file', 'f', 0, 't', 't', 'x', ''::tsvector, '/f', 'private', null, '{user:u1}', now(), now(), 'h');
      `);
      await run(backfill);
      const confined = async () =>
        (
          await pg.query<{ id: string; channel_id: string | null }>(
            "select id, channel_id from memories order by id",
          )
        ).rows;
      const want = [
        { id: "l_dm", channel_id: "ch_dm" },
        { id: "l_gone", channel_id: null },
        { id: "l_open", channel_id: null },
        { id: "l_secret", channel_id: "ch_secret" },
        { id: "n_secret", channel_id: null },
      ];
      expect(await confined()).toEqual(want);
      // A private channel's debate keeps only its agents as readers from outside; a file's readers stay.
      const readers = async () =>
        (
          await pg.query<{ source_kind: string; principals: string[] }>(
            "select source_kind, principals from search_chunks order by source_kind",
          )
        ).rows;
      const readersWant = [
        { source_kind: "debate", principals: ["agent:ag"] },
        { source_kind: "file", principals: ["user:u1"] },
      ];
      expect(await readers()).toEqual(readersWant);
      // Run again (the updates alone, the column being there): nothing changes.
      const text = await Bun.file(join(MIGRATIONS_DIR, `${backfill}.sql`)).text();
      for (const update of text.split("--> statement-breakpoint").filter((st) => st.includes("UPDATE")))
        await pg.exec(update);
      expect(await confined()).toEqual(want);
      expect(await readers()).toEqual(readersWant);
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
