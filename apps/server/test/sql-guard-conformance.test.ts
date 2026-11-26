// The guard's lexer against Postgres itself (PGlite) as the oracle, on texts drawn from templates over the tricky
// parts of the lexical structure: comments and their line ends, string constants with every prefix and their
// continuation across a newline, dollar quotes, quoted identifiers, odd whitespace, each one trying to hide a
// second command. Property: a text the guard accepts runs as at most one command and changes nothing, under both
// standard_conforming_strings settings. The seed is fixed, so a failure always reproduces; a wider run of the same
// grammar lives outside the repo.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { memoryPostgres } from "@vanr/engine/sqlconn";
import { guardStatement } from "../src/integrations/sql-guard";

let pg: Awaited<ReturnType<typeof memoryPostgres>>;
beforeAll(async () => {
  pg = await memoryPostgres();
  await pg.exec("create table control(n int); insert into control values (1)");
});
afterAll(() => pg.close());

const SMUGGLED = ";delete from control;";
const ENDINGS = ["\n", "\r", "\r\n", "\n\r", "\f", "\v", "\t", "\u2028", "\ufeff"];
const COMMENTS = ["", "/**/", "/* /* nested */ ok */", "/* ' \" $$ -- */", "--hello\n", "--hello\r"];
const PREFIXES = ["", "E", "e", "U&", "B", "X", "N", "xE"];
const BODIES = [
  "abc",
  "a''b",
  "a\\",
  "a\\'b",
  SMUGGLED,
  `\\'';delete from control;--`,
  "/* /* */ ;x; */",
  "\\\\",
  "C:\\path\\",
];
const GAPS = [
  "",
  " ",
  "\n",
  "\r",
  "\r\n",
  "\f\n",
  "\v\n",
  " --x\n",
  " --x\r",
  " /*x*/\n",
  "\n--c\n",
  "\t\n ",
];
const TAGS = ["", "a", "a1", "é", "_", "1", "a$"];
const AROUND = ["", "x", "0", "1e", "1.", "a", "$"];
const IDENTIFIERS = ['"a;b"', '"a""b"', 'U&"d\\0061t"', '"--"'];

type Pick = <T>(list: readonly T[]) => T;
/** Families of texts, each a template over one tricky part of the lexical structure. */
const FAMILIES: ((p: Pick) => string)[] = [
  (p) => `select 1 ${p(COMMENTS)}--x${p(ENDINGS)}${SMUGGLED}select\n2`,
  (p) =>
    `select 1 ${p(COMMENTS)}--x${p(ENDINGS)}${SMUGGLED}${p(["", "\nselect 2", "\n+2", "\nunion select 2"])}`,
  (p) => `select ${p(PREFIXES)}'${p(BODIES)}'${p(GAPS)}'\\'${SMUGGLED}--'`,
  (p) => `select ${p(PREFIXES)}'${p(BODIES)}'${p(GAPS)}'x'${SMUGGLED}`,
  (p) => `select ${p(PREFIXES)}'${p(BODIES)}'${p(GAPS)}'ok'`,
  (p) => {
    const tag = `$${p(TAGS)}$`;
    return `select 1 as ${p(AROUND)}${tag}${SMUGGLED}select ${tag}`;
  },
  (p) => {
    const depth = p([1, 2, 5]);
    return `${"/*".repeat(depth)} ' $$ -- ${"*/".repeat(depth - p([0, 1]))} select 1${SMUGGLED}`;
  },
  (p) => `select 1 as ${p(IDENTIFIERS)}${SMUGGLED}`,
];

function* texts(seed: number, count: number) {
  let s = seed;
  const next = (n: number) => {
    s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
    return Math.floor((s / 0x80000000) * n);
  };
  const pick: Pick = (list) => list[next(list.length)] as (typeof list)[number];
  for (let k = 0; k < count; k++) {
    const family = next(FAMILIES.length);
    yield { family, sql: FAMILIES[family]?.(pick) ?? "" };
  }
}

test("an accepted text is one command that changes nothing, whatever standard_conforming_strings says", async () => {
  let accepted = 0;
  const families = new Set<number>();
  const contradicted: { sql: string; mode: string; commands: number; rows: unknown }[] = [];
  for (const { family, sql } of texts(20261114, 700)) {
    families.add(family);
    const outcome = guardStatement(sql);
    if (!("statement" in outcome)) continue;
    accepted++;
    for (const mode of ["on", "off"]) {
      await pg.exec(
        `set standard_conforming_strings = ${mode}; truncate control; insert into control values (1)`,
      );
      let commands = 0;
      try {
        commands = (await pg.exec(outcome.statement)).length;
      } catch {
        continue; // Postgres rejects the text: nothing of it ran.
      }
      const rows = (await pg.query<{ n: number }>("select count(*)::int as n from control")).rows[0]?.n;
      if (commands > 1 || rows !== 1) contradicted.push({ sql, mode, commands, rows });
    }
  }
  await pg.exec("set standard_conforming_strings = on");
  expect(families.size).toBe(FAMILIES.length);
  expect(contradicted).toEqual([]);
  expect(accepted).toBeGreaterThan(100);
});
