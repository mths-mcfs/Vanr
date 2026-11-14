// Guard of the queries an agent runs on a connected database. It does not interpret SQL: it asks Postgres
// itself for the plan (EXPLAIN VERBOSE, FORMAT JSON) and checks what it will read. Pure functions.
import { z } from "zod";

export type GuardFailure =
  | { reason: "multiple_statements" }
  | { reason: "statement"; keyword: string }
  | { reason: "write" }
  | { reason: "table"; table: string }
  | { reason: "column"; column: string }
  | { reason: "function"; name: string };

/** Identifier characters as Postgres lexes them (`$` too, after the first character). */
const isIdentChar = (c: string | undefined) => c !== undefined && /[A-Za-z0-9_$\u0080-\uffff]/.test(c);
const DOLLAR_TAG = /^\$(?:[A-Za-z_\u0080-\uffff][A-Za-z0-9_\u0080-\uffff]*)?\$/;

interface Scan {
  /** The statement without the trailing `;` and trailing comments; null when there is none or more than one. */
  body: string | null;
  /** More than one statement. */
  multiple: boolean;
  /** The bare words of the code (outside strings, quoted identifiers, dollar quotes and comments), in lowercase. */
  words: string[];
}

/**
 * Splits the text the way Postgres lexes it, for what decides where a statement ends: block comments nest,
 * `E'…'` strings take backslash escapes, a `$` inside an identifier is part of it (`foo$$` is a name, not a
 * dollar quote). Reading it any other way lets a second command hide in what the guard took for a comment or a
 * string.
 */
function scan(sql: string): Scan {
  const n = sql.length;
  const words: string[] = [];
  let i = 0;
  let lastCode = -1;
  let sawSemicolon = false;
  const code = (end: number) => {
    if (sawSemicolon) return false;
    lastCode = end;
    return true;
  };
  while (i < n) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (ch === "-" && next === "-") {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? n : end + 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (sql[j] === "/" && sql[j + 1] === "*") {
          depth++;
          j += 2;
        } else if (sql[j] === "*" && sql[j + 1] === "/") {
          depth--;
          j += 2;
        } else j++;
      }
      i = j;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const escapes = ch === "'" && /[eE]/.test(sql[i - 1] ?? "") && !isIdentChar(sql[i - 2]);
      let j = i + 1;
      while (j < n) {
        if (escapes && sql[j] === "\\") {
          j += 2;
          continue;
        }
        if (sql[j] === ch) {
          if (sql[j + 1] === ch) {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      if (!code(j)) return { body: null, multiple: true, words };
      i = j + 1;
      continue;
    }
    if (ch === "$" && !isIdentChar(sql[i - 1])) {
      const tag = DOLLAR_TAG.exec(sql.slice(i))?.[0];
      if (tag) {
        const end = sql.indexOf(tag, i + tag.length);
        const stop = end === -1 ? n : end + tag.length;
        if (!code(stop - 1)) return { body: null, multiple: true, words };
        i = stop;
        continue;
      }
    }
    if (ch === ";") {
      sawSemicolon = true;
      i++;
      continue;
    }
    if (ch !== undefined && /[A-Za-z_\u0080-\uffff]/.test(ch)) {
      let j = i + 1;
      while (isIdentChar(sql[j])) j++;
      if (!code(j - 1)) return { body: null, multiple: true, words };
      words.push(sql.slice(i, j).toLowerCase());
      i = j;
      continue;
    }
    if (ch !== undefined && !/\s/.test(ch) && !code(i)) return { body: null, multiple: true, words };
    i++;
  }
  const body = sql.slice(0, lastCode + 1).trim();
  return { body: body || null, multiple: false, words };
}

/**
 * Strips the trailing `;` and rejects when another one is left outside a string, quoted identifier,
 * dollar quote or comment: only one statement at a time.
 */
export function singleStatement(sql: string): string | null {
  return scan(sql).body;
}

/** What a statement may start with: a query that only reads. */
const READ_KEYWORDS = new Set(["select", "with", "values", "table"]);

/**
 * The statement an agent may send, before anything reaches the database: one statement, a query (not `SET`,
 * `BEGIN`, `COMMIT`, `COPY`, `EXPLAIN` or any other command, which could undo the read-only transaction or its
 * timeout) and no `SELECT … INTO`, which creates a table.
 */
export function guardStatement(sql: string): { statement: string } | { failure: GuardFailure } {
  const { body, multiple, words } = scan(sql);
  if (multiple) return { failure: { reason: "multiple_statements" } };
  const keyword = words[0] ?? "";
  if (!body || !READ_KEYWORDS.has(keyword)) return { failure: { reason: "statement", keyword } };
  if (words.includes("into")) return { failure: { reason: "write" } };
  return { statement: body };
}

interface PlanNode {
  "Node Type"?: string;
  "Relation Name"?: string;
  Schema?: string;
  Alias?: string;
  "Parent Relationship"?: string;
  "Function Name"?: string;
  Plans?: PlanNode[];
  [key: string]: unknown;
}

/** EXPLAIN's JSON, checked before it is read: anything off this shape fails closed. */
const planNode: z.ZodType<PlanNode> = z.lazy(() =>
  z
    .object({
      "Node Type": z.string().optional(),
      "Relation Name": z.string().optional(),
      Schema: z.string().optional(),
      Alias: z.string().optional(),
      "Parent Relationship": z.string().optional(),
      "Function Name": z.string().optional(),
      Plans: z.array(planNode).optional(),
    })
    .catchall(z.unknown()),
);
const explainRoot = z.object({ Plan: planNode }).catchall(z.unknown());
const explainOutput = z.union([z.array(explainRoot).min(1), explainRoot]);

/** Normalizes `table` and `schema.table` to `schema.table` (public when missing). */
export const qualified = (name: string) => (name.includes(".") ? name : `public.${name}`).toLowerCase();

/**
 * Functions that read outside the allowed tables, by family: the system ones (`pg_*`: files, other
 * sessions, configuration), the ones that run SQL passed as text (`ts_stat`, `ts_rewrite`,
 * `*_to_xml`), large objects, other databases and the session configuration. The text passed to them
 * becomes a literal and drops out of the column check, so they cannot run.
 */
const BLOCKED_FUNCTION =
  /\b(pg_\w+|lo_\w+|dblink\w*|set_config|current_setting|ts_stat|ts_rewrite|inet_(?:server|client)_\w+|(?:query|cursor|table|schema|database)_to_xml\w*)\s*\(/i;

/** In FROM (Function Scan), only set-returning functions that work on what they receive. */
const SAFE_SET_FUNCTION =
  /^(generate_series|generate_subscripts|unnest|string_to_table|regexp_matches|regexp_split_to_table|jsonb_path_query|jsonb?_(?:array_elements(?:_text)?|each(?:_text)?|object_keys|to_record(?:set)?|populate_record(?:set)?))$/i;

/** Node fields that are metadata, not expressions: index names and aliases do not count as reads. */
const META_KEYS = new Set([
  "Node Type",
  "Relation Name",
  "Schema",
  "Alias",
  "Index Name",
  "Parent Relationship",
  "Subplan Name",
  "Scan Direction",
  "Strategy",
  "Partial Mode",
  "Join Type",
  "CTE Name",
  "Function Name",
]);

function expressions(node: PlanNode): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (key === "Plans" || META_KEYS.has(key)) continue;
    if (typeof value === "string") out.push(value);
    else if (Array.isArray(value)) for (const v of value) if (typeof v === "string") out.push(v);
  }
  // Literals read nothing: 'ssn' inside a string is not the ssn column.
  return out.map((t) => t.replace(/'(?:[^']|'')*'/g, "''"));
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Checks the plan against the policy: no writes, only allowed tables, no hidden column
 * read (not even the whole row of a table that has a hidden column) and no function
 * that reads outside the database. `maskedColumns` comes as `table.column` or `schema.table.column`.
 *
 * How the plan shows the columns: with a single table, EXPLAIN does not qualify them (`ssn`); with more
 * than one, it qualifies by alias (`c.ssn`). Under a join, the scan may return every column of
 * the table even when unused ("physical tlist"); that is why the `Output` of an Outer/Inner child
 * does not count as a read: what the node above uses shows in its own expressions.
 */
export function checkPlan(
  explain: unknown,
  policy: { tables: readonly string[]; maskedColumns: readonly string[] },
): GuardFailure | null {
  const parsed = explainOutput.safeParse(explain);
  if (!parsed.success) return { reason: "write" };
  const root = Array.isArray(parsed.data) ? parsed.data[0] : parsed.data;
  if (!root) return { reason: "write" };
  const allowed = new Set(policy.tables.map(qualified));
  const hiddenByTable = new Map<string, string[]>();
  for (const col of policy.maskedColumns) {
    const parts = col.toLowerCase().split(".");
    const column = parts.pop();
    if (!column || parts.length === 0) continue;
    const table = qualified(parts.join("."));
    hiddenByTable.set(table, [...(hiddenByTable.get(table) ?? []), column]);
  }

  const nodes: PlanNode[] = [];
  const collect = (node: PlanNode) => {
    nodes.push(node);
    for (const child of node.Plans ?? []) collect(child);
  };
  collect(root.Plan);

  // 1st pass: writes, functions and tables; builds alias → hidden columns.
  const byAlias = new Map<string, { table: string; column: string }[]>();
  const bare = new Map<string, string>(); // hidden column → table, for the case without an alias
  for (const node of nodes) {
    const type = node["Node Type"] ?? "";
    if (type === "ModifyTable" || type === "LockRows") return { reason: "write" };
    if (type === "Function Scan") {
      const name = node["Function Name"];
      if (typeof name !== "string" || !SAFE_SET_FUNCTION.test(name))
        return { reason: "function", name: typeof name === "string" ? name.toLowerCase() : "rows from" };
    }
    for (const text of expressions(node)) {
      const fn = BLOCKED_FUNCTION.exec(text);
      if (fn?.[1]) return { reason: "function", name: fn[1].toLowerCase() };
    }
    const rel = node["Relation Name"];
    if (!rel) continue;
    const table = qualified(`${node.Schema ?? "public"}.${rel}`);
    if (!allowed.has(table)) return { reason: "table", table };
    const alias = (node.Alias ?? rel).toLowerCase();
    for (const column of hiddenByTable.get(table) ?? []) {
      byAlias.set(alias, [...(byAlias.get(alias) ?? []), { table, column }]);
      bare.set(column, table);
    }
  }
  if (bare.size === 0) return null;

  // 2nd pass: does any expression read a hidden column?
  const checks: { re: RegExp; column: string }[] = [];
  for (const [alias, cols] of byAlias) {
    const a = escapeRe(alias);
    checks.push({ re: new RegExp(`(^|[^\\w.])"?${a}"?\\.\\*`, "i"), column: `${cols[0]?.table}.*` });
    for (const { table, column } of cols) {
      checks.push({
        re: new RegExp(`(^|[^\\w.])"?${a}"?\\.("?)${escapeRe(column)}\\2(?![\\w(])`, "i"),
        column: `${table}.${column}`,
      });
    }
  }
  for (const [column, table] of bare) {
    checks.push({
      re: new RegExp(`(^|[^\\w."])("?)${escapeRe(column)}\\2(?![\\w(.])`, "i"),
      column: `${table}.${column}`,
    });
  }
  for (const node of nodes) {
    const rel = node["Parent Relationship"];
    const skipOutput = rel === "Outer" || rel === "Inner";
    const texts = expressions(skipOutput ? { ...node, Output: undefined } : node);
    for (const text of texts) {
      for (const { re, column } of checks) if (re.test(text)) return { reason: "column", column };
    }
  }
  return null;
}
