import { expect, test } from "bun:test";
import { memoryPostgres, pgliteConnector } from "./sqlconn";

test("a PGlite connection only reads: queries return fields and rows, writes are rejected", async () => {
  const pg = await memoryPostgres();
  try {
    await pg.exec(
      "create table items (id int primary key, name text); insert into items values (1, 'a'), (2, 'b')",
    );
    const conn = await pgliteConnector(pg)({
      host: "localhost",
      port: 5432,
      database: "db",
      username: "u",
      password: "p",
      sslmode: "disable",
    });
    const res = await conn.readOnly(1000, (s) => s.query("select id, name from items order by id"));
    expect(res).toEqual({
      fields: ["id", "name"],
      rows: [
        { id: 1, name: "a" },
        { id: 2, name: "b" },
      ],
    });
    const write = conn.readOnly(1000, (s) => s.query("insert into items values (3, 'c')"));
    await expect(write).rejects.toThrow(/read-only transaction/);
    await conn.close();
  } finally {
    await pg.close();
  }
});
