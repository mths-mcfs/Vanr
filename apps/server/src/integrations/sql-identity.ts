// The guarded run of an agent's query on a connected database: one read-only transaction where the search_path
// is fixed, the customer's code the query could reach is looked up by identity in the catalog, and only then the
// query is planned (EXPLAIN, checked by `checkPlan`) and executed.
//
// Why before planning: the plan prints a function by the name it resolved to, so `lower(id)` reads the same
// whether it is pg_catalog's or a customer's `public.lower(integer)`; and the planner itself runs an IMMUTABLE
// function with constant arguments, so a customer function can read a masked column before any check sees it.
// The catalog says which functions exist: a customer routine that shares a name with a call in the query, or
// that an allowed relation depends on, makes the query rejected before it is planned.
import { isIP } from "node:net";
import type { SqlTarget } from "@vanr/engine/sqlconn";
import postgres from "postgres";
import {
  checkPlan,
  type GuardFailure,
  guardStatement,
  lexWords,
  parseRelation,
  type Relation,
} from "./sql-guard";

/** What the guarded run needs from ONE read-only transaction on the customer's database. */
export interface GuardedSession {
  /** A catalog read the guard writes itself, with bound parameters (extended protocol). */
  rows(text: string, params: unknown[]): Promise<Record<string, unknown>[]>;
  /** `EXPLAIN (VERBOSE, FORMAT JSON)` of the checked statement: the plan's JSON. */
  explain(statement: string): Promise<unknown>;
  /** Runs the checked statement as is (extended protocol, no parameters). */
  run(statement: string): Promise<{ fields: string[]; rows: Record<string, unknown>[] }>;
}

export interface QueryPolicy {
  tables: readonly string[];
  maskedColumns: readonly string[];
}

/** Schemas whose routines are the database's own. */
const NATIVE_SCHEMAS = ["pg_catalog", "information_schema"];

/**
 * Functions a keyword calls without their name in the text (`trim(x)` is `btrim`, `x AT TIME ZONE z` is
 * `timezone`, `SIMILAR TO` is `similar_to_escape`…): when the keyword is there, a customer function with one of
 * these names counts too.
 */
const IMPLIED_FUNCTIONS: Record<string, readonly string[]> = {
  trim: ["btrim", "ltrim", "rtrim"],
  extract: ["extract", "date_part"],
  at: ["timezone"],
  similar: ["similar_to_escape", "similar_escape"],
  escape: ["like_escape"],
  normalized: ["is_normalized"],
  normalize: ["normalize"],
  overlay: ["overlay"],
  position: ["position"],
  substring: ["substring"],
  collation: ["pg_collation_for"],
};

/** Operators a query uses without writing them: comparisons (IN, BETWEEN, ORDER BY, joins) and LIKE. */
const IMPLIED_OPERATORS = ["=", "<>", "<", ">", "<=", ">=", "~~", "~~*", "!~~", "!~~*", "~", "!~", "||"];

/** The policy's relations by exact catalog identity; an entry that doesn't parse names nothing. */
const allowedRelations = (policy: Pick<QueryPolicy, "tables">): Relation[] =>
  policy.tables.map(parseRelation).filter((r) => r !== null);

/**
 * The search_path of the check and of the execution: pg_catalog first, then the schemas of the allowed tables,
 * pg_temp last. The database's own search_path (or the role's) never decides what a name resolves to.
 */
export function fixedSearchPath(policy: Pick<QueryPolicy, "tables">): string {
  const schemas = [...new Set(allowedRelations(policy).map((r) => r.schema))];
  const quote = (s: string) => `"${s.replace(/"/g, '""')}"`;
  return [
    "pg_catalog",
    ...schemas.filter((s) => s !== "pg_catalog" && s !== "pg_temp").map(quote),
    "pg_temp",
  ].join(", ");
}

/** A customer routine the query could reach, as `schema.name(args)`, or null. Runs before any planning. */
async function customCode(
  session: GuardedSession,
  statement: string,
  policy: QueryPolicy,
): Promise<string | null> {
  const { words, operators } = lexWords(statement);
  const names = [
    ...new Set([
      ...words,
      ...words.flatMap((w) => (Object.hasOwn(IMPLIED_FUNCTIONS, w) ? (IMPLIED_FUNCTIONS[w] ?? []) : [])),
    ]),
  ];
  const ops = [...new Set([...operators, ...IMPLIED_OPERATORS])];

  // 1. A customer function (any schema, any argument types) with the name of something the query calls.
  const [fn] = await session.rows(
    `select n.nspname as schema, p.proname as name, pg_catalog.pg_get_function_identity_arguments(p.oid) as args
       from pg_catalog.pg_proc p
       join pg_catalog.pg_namespace n on n.oid operator(pg_catalog.=) p.pronamespace
      where p.proname operator(pg_catalog.=) any ($1::pg_catalog.text[])
        and n.nspname operator(pg_catalog.<>) all ($2::pg_catalog.text[])
      order by 1, 2, 3
      limit 1`,
    [names, NATIVE_SCHEMAS],
  );
  if (fn) return `${fn.schema}.${fn.name}(${fn.args})`;

  // 2. A customer operator with a name the query uses, written in a language other than C (an extension's).
  const [op] = await session.rows(
    `select n.nspname as schema, o.oprname as name
       from pg_catalog.pg_operator o
       join pg_catalog.pg_namespace n on n.oid operator(pg_catalog.=) o.oprnamespace
       join pg_catalog.pg_proc f on f.oid operator(pg_catalog.=) o.oprcode::pg_catalog.oid
       join pg_catalog.pg_language l on l.oid operator(pg_catalog.=) f.prolang
      where o.oprname operator(pg_catalog.=) any ($1::pg_catalog.text[])
        and n.nspname operator(pg_catalog.<>) all ($2::pg_catalog.text[])
        and l.lanname operator(pg_catalog.<>) all (array['c', 'internal'])
      order by 1, 2
      limit 1`,
    [ops, NATIVE_SCHEMAS],
  );
  if (op) return `${op.schema}.operator(${op.name})`;

  // 3. A cast that runs a customer function outside C: a cast can apply without being written.
  const [cast] = await session.rows(
    `select n.nspname as schema, f.proname as name
       from pg_catalog.pg_cast c
       join pg_catalog.pg_proc f on f.oid operator(pg_catalog.=) c.castfunc
       join pg_catalog.pg_namespace n on n.oid operator(pg_catalog.=) f.pronamespace
       join pg_catalog.pg_language l on l.oid operator(pg_catalog.=) f.prolang
      where n.nspname operator(pg_catalog.<>) all ($1::pg_catalog.text[])
        and l.lanname operator(pg_catalog.<>) all (array['c', 'internal'])
      order by 1, 2
      limit 1`,
    [NATIVE_SCHEMAS],
  );
  if (cast) return `${cast.schema}.${cast.name} (cast)`;

  // 4. A customer function or operator an allowed relation depends on: the rules of a view (and of the views
  //    under it) and the row security policies. The plan shows a view's calls only after inlining or folding.
  //    Each relation is found by its exact schema and name, compared byte for byte as the plan check compares
  //    them: no folding, so "Sales View" never stands for "sales view" and `Étage` is not looked up as `étage`.
  const relations = allowedRelations(policy);
  const [dep] = await session.rows(
    `with recursive rel(oid) as (
         select c.oid
           from rows from (pg_catalog.unnest($1::pg_catalog.text[]), pg_catalog.unnest($2::pg_catalog.text[]))
                  as allowed(schema, name)
           join pg_catalog.pg_namespace n
             on n.nspname::pg_catalog.text operator(pg_catalog.=) allowed.schema collate pg_catalog."C"
           join pg_catalog.pg_class c
             on c.relnamespace operator(pg_catalog.=) n.oid
            and c.relname::pg_catalog.text operator(pg_catalog.=) allowed.name collate pg_catalog."C"
         union
         select d.refobjid
           from rel
           join pg_catalog.pg_rewrite r on r.ev_class operator(pg_catalog.=) rel.oid
           join pg_catalog.pg_depend d
             on d.classid operator(pg_catalog.=) 'pg_catalog.pg_rewrite'::pg_catalog.regclass::pg_catalog.oid
            and d.objid operator(pg_catalog.=) r.oid
            and d.refclassid operator(pg_catalog.=) 'pg_catalog.pg_class'::pg_catalog.regclass::pg_catalog.oid
          where d.refobjid operator(pg_catalog.<>) rel.oid
       ),
       objs(classid, objid) as (
         select 'pg_catalog.pg_rewrite'::pg_catalog.regclass::pg_catalog.oid, r.oid
           from pg_catalog.pg_rewrite r join rel on r.ev_class operator(pg_catalog.=) rel.oid
         union all
         select 'pg_catalog.pg_policy'::pg_catalog.regclass::pg_catalog.oid, p.oid
           from pg_catalog.pg_policy p join rel on p.polrelid operator(pg_catalog.=) rel.oid
       )
     select n.nspname as schema, f.proname as name
       from pg_catalog.pg_depend d
       join objs o on d.classid operator(pg_catalog.=) o.classid and d.objid operator(pg_catalog.=) o.objid
       join pg_catalog.pg_proc f
         on f.oid operator(pg_catalog.=) (case
              when d.refclassid operator(pg_catalog.=) 'pg_catalog.pg_proc'::pg_catalog.regclass::pg_catalog.oid then d.refobjid
              when d.refclassid operator(pg_catalog.=) 'pg_catalog.pg_operator'::pg_catalog.regclass::pg_catalog.oid then
                (select op.oprcode::pg_catalog.oid from pg_catalog.pg_operator op
                  where op.oid operator(pg_catalog.=) d.refobjid)
            end)
       join pg_catalog.pg_namespace n on n.oid operator(pg_catalog.=) f.pronamespace
      where n.nspname operator(pg_catalog.<>) all ($3::pg_catalog.text[])
      order by 1, 2
      limit 1`,
    [relations.map((r) => r.schema), relations.map((r) => r.name), NATIVE_SCHEMAS],
  );
  if (dep) return `${dep.schema}.${dep.name} (used by an allowed relation)`;
  return null;
}

/**
 * Runs an agent's query under the policy, all in the session's one read-only transaction:
 *   1. `guardStatement`: one statement that only reads (no database round trip);
 *   2. the search_path is fixed (`fixedSearchPath`) for the rest of the transaction;
 *   3. the customer's code the query could reach is looked up by identity: rejected before planning;
 *   4. EXPLAIN, and `checkPlan` on it (tables, masked columns, the allowlist of functions);
 *   5. the statement runs, with the same search_path.
 */
export async function guardedQuery(
  session: GuardedSession,
  sql: string,
  policy: QueryPolicy,
): Promise<{ result: { fields: string[]; rows: Record<string, unknown>[] } } | { failure: GuardFailure }> {
  const guarded = guardStatement(sql);
  if ("failure" in guarded) return guarded;
  const { statement } = guarded;
  await session.rows("select pg_catalog.set_config('search_path', $1, true)", [fixedSearchPath(policy)]);
  const custom = await customCode(session, statement, policy);
  if (custom) return { failure: { reason: "function", name: custom } };
  const failure = checkPlan(await session.explain(statement), policy);
  if (failure) return { failure };
  return { result: await session.run(statement) };
}

const explainSql = (statement: string) => `explain (verbose, format json) ${statement}`;

/** What the PGlite session uses of a PGlite transaction (its `query` binds parameters). */
interface PgliteQueryable {
  query<T>(text: string, params?: unknown[]): Promise<{ rows: T[]; fields: { name: string }[] }>;
}

/** The session on a PGlite transaction already in read-only mode (tests, and the in-memory "customer"). */
export function pgliteGuardedSession(tx: PgliteQueryable): GuardedSession {
  return {
    rows: async (text, params) => (await tx.query<Record<string, unknown>>(text, params)).rows,
    explain: async (statement) =>
      (await tx.query<{ "QUERY PLAN": unknown }>(explainSql(statement), [])).rows[0]?.["QUERY PLAN"],
    run: async (statement) => {
      const res = await tx.query<Record<string, unknown>>(statement, []);
      return { fields: res.fields.map((f) => f.name), rows: res.rows };
    },
  };
}

/**
 * The session on a postgres.js transaction opened with `sql.begin("read only", …)`. Every call is a tagged
 * query, so it goes through the extended protocol: the text can never hold a second command.
 */
export function postgresGuardedSession(tx: postgres.TransactionSql): GuardedSession {
  return {
    rows: async (text, params) => [...(await tx.unsafe(text, params as postgres.ParameterOrJSON<never>[]))],
    explain: async (statement) => {
      const [row] = await tx`${tx.unsafe(explainSql(statement))}`;
      return row?.["QUERY PLAN"];
    },
    run: async (statement) => {
      const rows = await tx`${tx.unsafe(statement)}`;
      return { fields: rows.columns?.map((c) => c.name) ?? [], rows: [...rows] };
    },
  };
}

/**
 * One connection to a customer's database. Every use is ONE read-only transaction with a statement timeout, and
 * the session is the guarded one: catalog reads with bound parameters, the plan, and the checked statement.
 */
export interface GuardedConnection {
  readOnly<T>(timeoutMs: number, fn: (s: GuardedSession) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** Opens a connection to `target` (its `address` already checked by the network rule). */
export type GuardedConnector = (target: SqlTarget) => Promise<GuardedConnection>;

/** Statement timeout for the current transaction, never below 100 ms. */
const timeoutSql = (ms: number) => `set local statement_timeout = ${Math.max(100, Math.floor(ms))}`;

/**
 * Run right after the transaction opens: once a query ran, `SET TRANSACTION READ WRITE` is refused, so the
 * transaction stays read only whatever the session sends next (the text guard is a second layer, not the lock).
 */
const SEAL_READ_ONLY = "select 1";

/** The postgres.js options of a connection to `t`: the checked address and port, the name for TLS. */
export function postgresOptions(t: SqlTarget) {
  // postgres.js splits a host string on `:` for a port, which cuts an IPv6 address: a one-element list goes to
  // the address as is (its types only declare the string form).
  const to = { host: [t.address ?? t.host], port: [t.port] } as unknown as { host: string; port: number };
  return {
    ...to,
    database: t.database,
    username: t.username,
    // A function, so an empty password stays empty: a string "" falls back to the installation's PGPASSWORD.
    password: () => t.password,
    ssl:
      t.sslmode === "disable"
        ? (false as const)
        : {
            rejectUnauthorized: t.sslmode === "verify-full",
            ...(isIP(t.host) ? {} : { servername: t.host }),
          },
    max: 1,
    connect_timeout: 10,
    idle_timeout: 5,
    prepare: false,
    onnotice: () => {},
  };
}

/** A real Postgres, one connection per use (the caller closes it), to the checked address with the name for TLS. */
export const postgresGuardedConnector: GuardedConnector = async (t) => {
  const sql = postgres(postgresOptions(t));
  return {
    async readOnly<T>(timeoutMs: number, fn: (s: GuardedSession) => Promise<T>): Promise<T> {
      let result!: T;
      await sql.begin("read only", async (tx) => {
        await tx.unsafe(timeoutSql(timeoutMs));
        await tx.unsafe(SEAL_READ_ONLY);
        result = await fn(postgresGuardedSession(tx));
      });
      return result;
    },
    close: () => sql.end({ timeout: 2 }),
  };
};

/** What the PGlite connector uses of a PGlite instance. */
interface PgliteLike {
  transaction<T>(
    fn: (tx: PgliteQueryable & { exec(sql: string): Promise<unknown> }) => Promise<T>,
  ): Promise<T>;
}

/** An already open PGlite as the customer's database (tests): the target is ignored. */
export function pgliteGuardedConnector(pg: PgliteLike): GuardedConnector {
  return async () => ({
    readOnly: (timeoutMs, fn) =>
      pg.transaction(async (tx) => {
        await tx.exec("set transaction read only");
        await tx.exec(timeoutSql(timeoutMs));
        await tx.exec(SEAL_READ_ONLY);
        return fn(pgliteGuardedSession(tx));
      }),
    close: async () => {},
  });
}
