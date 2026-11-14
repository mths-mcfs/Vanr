import { expect, test } from "bun:test";
import postgres from "postgres";
import {
  memoryPostgres,
  pgliteConnector,
  postgresConnector,
  type SqlConnection,
  type SqlTarget,
} from "./sqlconn";

const localTarget: SqlTarget = {
  host: "localhost",
  port: 5432,
  database: "db",
  username: "u",
  password: "p",
  sslmode: "disable",
};
const url = process.env.VANR_TEST_POSTGRES_URL;

type TestDatabase = {
  conn: SqlConnection;
  rows(text: string): Promise<Record<string, unknown>[]>;
};

/** Postgres tests use only the explicitly configured disposable database, as catalog.test.ts does. */
async function withDatabase(kind: "PGlite" | "Postgres", fn: (db: TestDatabase) => Promise<void>) {
  if (kind === "PGlite") {
    const pg = await memoryPostgres();
    try {
      await pg.exec(
        "create table sqlconn_items (id int primary key, name text); insert into sqlconn_items values (1, 'a'), (2, 'b')",
      );
      const conn = await pgliteConnector(pg)(localTarget);
      try {
        await fn({ conn, rows: async (text) => (await pg.query<Record<string, unknown>>(text)).rows });
      } finally {
        await conn.close();
      }
    } finally {
      await pg.close();
    }
    return;
  }
  if (!url) throw new Error("VANR_TEST_POSTGRES_URL is required");
  const target = new URL(url);
  const admin = postgres(url, { max: 1, onnotice: () => {} });
  const conn = await postgresConnector({
    host: target.hostname,
    port: Number(target.port || 5432),
    database: target.pathname.slice(1),
    username: decodeURIComponent(target.username),
    password: decodeURIComponent(target.password),
    sslmode: "disable",
  });
  try {
    await admin.unsafe(
      "create table sqlconn_items (id int primary key, name text); insert into sqlconn_items values (1, 'a'), (2, 'b')",
    );
    await fn({ conn, rows: async (text) => [...(await admin.unsafe(text))] });
  } finally {
    await conn.close();
    try {
      await admin.unsafe("drop table sqlconn_items");
    } finally {
      await admin.end({ timeout: 2 });
    }
  }
}

for (const kind of ["PGlite", "Postgres"] as const) {
  const run = test.skipIf(kind === "Postgres" && !url);
  run(`${kind}: queries return fields and rows, writes are rejected`, async () => {
    await withDatabase(kind, async ({ conn }) => {
      const res = await conn.readOnly(1000, (s) => s.query("select id, name from sqlconn_items order by id"));
      expect(res).toEqual({
        fields: ["id", "name"],
        rows: [
          { id: 1, name: "a" },
          { id: 2, name: "b" },
        ],
      });
      await expect(
        conn.readOnly(1000, (s) => s.query("insert into sqlconn_items values (3, 'c')")),
      ).rejects.toThrow();
      const reads = [
        "with items as (select * from sqlconn_items) select * from items order by id",
        "values (1, 'a'), (2, 'b')",
        "table sqlconn_items",
        "select id, name from sqlconn_items where ';COMMIT;--' <> '' order by id -- trailing comment",
      ];
      for (const text of reads) {
        expect((await conn.readOnly(1000, (s) => s.query(text))).rows).toHaveLength(2);
      }
    });
  });

  run(`${kind}: SQL cannot change or end the read-only transaction`, async () => {
    await withDatabase(kind, async ({ conn, rows }) => {
      const insert = "insert into sqlconn_items values (42, 'escaped')";
      const attempts = [
        "set transaction read write",
        "commit",
        "rollback",
        `commit; ${insert}`,
        `rollback; ${insert}`,
        `select 1; commit; ${insert}`,
        `select 1) as escaped; commit; ${insert}; --`,
      ];
      for (const text of attempts) {
        await expect(
          conn.readOnly(1000, async (s) => {
            await s.query(text);
            await s.query(insert);
          }),
        ).rejects.toThrow();
        expect(await rows("select id from sqlconn_items order by id")).toEqual([{ id: 1 }, { id: 2 }]);
      }
      await expect(
        conn.readOnly(1000, (s) => s.query("select set_config('transaction_read_only', 'off', true)")),
      ).rejects.toThrow();
    });
  });
}
