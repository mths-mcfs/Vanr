// Postgres databases a workspace connects for its agents to query. Read only: every agent query is the guarded
// run of integrations/sql-identity (one statement that only reads, the catalog's customer code, the plan check),
// in a READ ONLY transaction with a time limit. The connection goes through the integrations' network rule,
// and no error, tool result or log carries the database's password.
import type {
  AgentDatabase,
  DatabaseConnectInput,
  DatabaseConnection,
  DatabaseTable,
  DatabaseUpdateInput,
  SetAgentDatabaseInput,
} from "@vanr/contract";
import { effectiveLevel } from "@vanr/engine/action-credential";
import { type Db, schema } from "@vanr/engine/db";
import { newId } from "@vanr/engine/ids";
import { createSealer, type Sealer } from "@vanr/engine/seal";
import type { SqlTarget } from "@vanr/engine/sqlconn";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { AppDeps, WorkspaceMember } from "../context";
import { HttpError, notFound } from "../http";
import { define, type ToolContext, type ToolDef, ToolInputError } from "../runtime/tools";
import { channelRulesOf } from "./access";
import { netPolicy, socketAddress } from "./net";
import { outsideText } from "./outside-text";
import {
  columnKey,
  type GuardFailure,
  guardStatement,
  parseRelation,
  quoteName,
  relationKey,
  relationText,
} from "./sql-guard";
import { type GuardedConnection, type GuardedSession, guardedQuery } from "./sql-identity";
import { recordUsage, reserveUsage } from "./usage";

const { dataSources, agentDatabases } = schema;
export type DatabaseRow = typeof dataSources.$inferSelect;
type AgentDatabaseRow = typeof agentDatabases.$inferSelect;

export const DB_ACTIONS = ["tables", "describe", "query"] as const;
export const ROW_CAP = 500;
const CELL_MAX = 300;
const SYSTEM_SCHEMAS = ["pg_catalog", "information_schema", "pg_toast"];
const SENSITIVE_COLUMN =
  /(^|_)(password|passwd|pwd|secret|token|api_?key|ssn|cpf|cnpj|card_?number|cvv|iban|salt|hash)(_|$)/i;

export const databaseSealer = (deps: AppDeps): Sealer => createSealer(deps.config.authSecret, "databases");

export function toDatabaseConnection(
  row: DatabaseRow,
  links: readonly AgentDatabaseRow[],
): DatabaseConnection {
  return {
    id: row.id,
    label: row.label,
    provider: provider.parse(row.provider),
    host: row.host,
    database: row.database,
    username: row.username,
    status: row.status,
    canWrite: row.canWrite,
    disabledActions: row.disabledActions,
    agents: links
      .filter((l) => l.connectionId === row.id)
      .map((l) => ({ agentId: l.agentId, level: l.level })),
    hiddenSuggestion: row.hiddenSuggestion,
  };
}

export const toAgentDatabase = (row: AgentDatabaseRow): AgentDatabase => ({
  connectionId: row.connectionId,
  level: row.level,
  policy: row.policy,
});

export const provider = z.enum(["supabase", "neon", "railway", "rds", "render", "other"]);

export async function databasesOf(db: Db, workspaceId: string): Promise<DatabaseConnection[]> {
  const rows = await db
    .select()
    .from(dataSources)
    .where(eq(dataSources.workspaceId, workspaceId))
    .orderBy(dataSources.createdAt);
  const links = rows.length
    ? await db
        .select()
        .from(agentDatabases)
        .where(
          inArray(
            agentDatabases.connectionId,
            rows.map((r) => r.id),
          ),
        )
    : [];
  return rows.map((r) => toDatabaseConnection(r, links));
}

export async function databaseById(db: Db, workspaceId: string, id: string): Promise<DatabaseRow> {
  const [row] = await db
    .select()
    .from(dataSources)
    .where(and(eq(dataSources.workspaceId, workspaceId), eq(dataSources.id, id)));
  if (!row) throw notFound("Database not found");
  return row;
}

/** The form's fields or the URL `postgres://user:password@host:port/database?sslmode=`. */
function targetOf(input: DatabaseConnectInput): SqlTarget {
  let t: Partial<SqlTarget> = {
    host: input.host?.trim(),
    port: input.port ?? 5432,
    database: input.database?.trim(),
    username: input.username?.trim(),
    password: input.password,
    sslmode: input.sslmode ?? "require",
  };
  if (input.url) {
    let url: URL;
    try {
      url = new URL(input.url.trim());
    } catch {
      throw new HttpError(400, "database.invalid_url", "That is not a valid connection URL");
    }
    if (url.protocol !== "postgres:" && url.protocol !== "postgresql:")
      throw new HttpError(400, "database.invalid_url", "Use a postgres:// URL");
    const ssl = url.searchParams.get("sslmode");
    t = {
      host: url.hostname,
      port: url.port ? Number(url.port) : 5432,
      database: decodeURIComponent(url.pathname.replace(/^\//, "")),
      username: decodeURIComponent(url.username),
      password: input.password ?? decodeURIComponent(url.password),
      sslmode: ssl === "disable" || ssl === "verify-full" ? ssl : (input.sslmode ?? "require"),
    };
  }
  const { host, port, database, username, password, sslmode } = t;
  if (!host || !database || !username || password === undefined || !port || !sslmode)
    throw new HttpError(400, "database.fields_required", "Enter host, database, user and password");
  return { host, port, database, username, password, sslmode };
}

/** The driver's message without the password, for an error the person sees (it comes from the outside server). */
const driverText = (err: unknown, target: SqlTarget) =>
  outsideText(err, [target.password]) || "Database unreachable";

async function open(deps: AppDeps, target: SqlTarget): Promise<GuardedConnection> {
  // The network rule (TLS unless the installation allows plain text, no internal host unless it allows the local
  // network), then the connection goes to the checked IP: resolving again in the driver would let the name switch.
  const address = await socketAddress(
    target.host,
    target.sslmode !== "disable",
    netPolicy(deps.config.integrations),
  );
  try {
    return await deps.sql({ ...target, address });
  } catch (err) {
    throw new HttpError(400, "database.unreachable", driverText(err, target));
  }
}

function targetFor(deps: AppDeps, row: DatabaseRow): SqlTarget {
  return {
    host: row.host,
    port: row.port,
    database: row.database,
    username: row.username,
    password: databaseSealer(deps).open(row.secret),
    sslmode: row.sslmode,
  };
}

/** One read-only session on the connection's database. */
async function withDatabase<T>(
  deps: AppDeps,
  target: SqlTarget,
  timeoutMs: number,
  fn: (s: GuardedSession) => Promise<T>,
): Promise<T> {
  const conn = await open(deps, target);
  try {
    return await conn.readOnly(timeoutMs, fn);
  } finally {
    await conn.close();
  }
}

const authFailed = (err: unknown) =>
  err instanceof Error && /password authentication|no pg_hba|role .* does not exist/i.test(err.message);

/** Tests the connection, finds out whether the user can write and suggests columns to hide. */
async function inspect(deps: AppDeps, target: SqlTarget) {
  try {
    return await withDatabase(deps, target, 15_000, async (s) => {
      await s.rows("select 1", []);
      const [write] = await s.rows(
        `select exists (select 1 from information_schema.table_privileges where grantee = current_user and privilege_type in ('INSERT','UPDATE','DELETE','TRUNCATE') and table_schema <> all ($1::text[])) or coalesce((select rolsuper from pg_catalog.pg_roles where rolname = current_user), false) as can_write`,
        [SYSTEM_SCHEMAS],
      );
      const cols = await s.rows(
        "select table_schema, table_name, column_name from information_schema.columns where table_schema <> all ($1::text[]) order by 1, 2, ordinal_position limit 5000",
        [SYSTEM_SCHEMAS],
      );
      const hidden = cols
        .filter((r) => SENSITIVE_COLUMN.test(String(r.column_name)))
        .map(
          (r) =>
            `${relationText({ schema: String(r.table_schema), name: String(r.table_name) })}.${quoteName(String(r.column_name))}`,
        );
      return { canWrite: write?.can_write === true, hiddenSuggestion: hidden.slice(0, 200) };
    });
  } catch (err) {
    if (err instanceof HttpError) throw err;
    if (authFailed(err))
      throw new HttpError(400, "database.auth", "The database rejected the user or password");
    throw new HttpError(400, "database.unreachable", driverText(err, target));
  }
}

export async function connectDatabase(
  deps: AppDeps,
  me: WorkspaceMember,
  input: DatabaseConnectInput,
): Promise<DatabaseRow> {
  const target = targetOf(input);
  const found = await inspect(deps, target);
  const at = deps.now();
  const [row] = await deps.db
    .insert(dataSources)
    .values({
      id: newId("dbc"),
      workspaceId: me.workspaceId,
      label: input.label?.trim() || `${target.database} @ ${target.host}`,
      provider: input.provider,
      host: target.host,
      port: target.port,
      database: target.database,
      username: target.username,
      sslmode: target.sslmode,
      secret: databaseSealer(deps).seal(target.password),
      status: "active",
      canWrite: found.canWrite,
      hiddenSuggestion: found.hiddenSuggestion,
      createdBy: me.userId,
      createdAt: at,
      updatedAt: at,
    })
    .returning();
  if (!row) throw new Error("database insert failed");
  return row;
}

export async function updateDatabase(
  deps: AppDeps,
  row: DatabaseRow,
  input: DatabaseUpdateInput,
): Promise<DatabaseRow> {
  const set: Partial<typeof dataSources.$inferInsert> = { updatedAt: deps.now() };
  if (input.label !== undefined) set.label = input.label;
  if (input.disabledActions) set.disabledActions = [...new Set(input.disabledActions)];
  if (input.password !== undefined) {
    const found = await inspect(deps, { ...targetFor(deps, row), password: input.password });
    set.secret = databaseSealer(deps).seal(input.password);
    set.status = "active";
    set.canWrite = found.canWrite;
    set.hiddenSuggestion = found.hiddenSuggestion;
  }
  const [updated] = await deps.db
    .update(dataSources)
    .set(set)
    .where(and(eq(dataSources.id, row.id), eq(dataSources.workspaceId, row.workspaceId)))
    .returning();
  return updated ?? row;
}

/** A session on a saved connection: a rejected password marks it for reconnecting. */
async function guarded<T>(
  deps: AppDeps,
  row: DatabaseRow,
  timeoutMs: number,
  fn: (s: GuardedSession) => Promise<T>,
): Promise<T> {
  try {
    return await withDatabase(deps, targetFor(deps, row), timeoutMs, fn);
  } catch (err) {
    if (err instanceof HttpError) throw err;
    if (authFailed(err)) {
      await deps.db.update(dataSources).set({ status: "reauth_required" }).where(eq(dataSources.id, row.id));
      throw new HttpError(400, "database.auth", "The database rejected the user or password");
    }
    throw new HttpError(400, "database.unreachable", driverText(err, targetFor(deps, row)));
  }
}

export async function tablesOf(deps: AppDeps, row: DatabaseRow): Promise<DatabaseTable[]> {
  return guarded(deps, row, 15_000, async (s) => {
    const rows = await s.rows(
      "select table_schema, table_name from information_schema.tables where table_schema <> all ($1::text[]) and table_type in ('BASE TABLE', 'VIEW') order by 1, 2 limit 1000",
      [SYSTEM_SCHEMAS],
    );
    return rows.map((r) => ({ schema: String(r.table_schema), name: String(r.table_name) }));
  });
}

/**
 * A name typed in the policy form, read as SQL reads it (`customers` is `public.customers`, `"Customers"` keeps its
 * capital) and kept in the one text the guard compares exactly.
 */
const sqlName = (key: (text: string) => string | null, what: string) =>
  z
    .string()
    .max(300)
    .transform((text, ctx) => {
      const k = key(text);
      if (k === null) ctx.addIssue({ code: "custom", message: `Not a ${what} name: ${text}` });
      return k ?? "";
    });
const tableName = sqlName(relationKey, "table");
export const databasePolicyInput = z
  .object({
    tables: z.array(tableName).max(500),
    maskedColumns: z.array(sqlName(columnKey, "column")).max(1000),
    queriesPerDay: z.number().int().min(1).max(100_000).nullable(),
    timeoutSeconds: z.union([z.literal(15), z.literal(30), z.literal(60)]),
  })
  .partial()
  .strict();

/** The first time: every table there is now, the suggested columns hidden, 200 queries a day. */
async function defaultPolicy(deps: AppDeps, row: DatabaseRow): Promise<schema.DatabasePolicyRow> {
  // A catalog read that fails fails the request: a policy saved empty would never read the catalog again.
  const tables = await tablesOf(deps, row);
  return {
    tables: tables.map(relationText),
    maskedColumns: row.hiddenSuggestion,
    queriesPerDay: 200,
    timeoutSeconds: 30,
  };
}

export async function setAgentDatabase(
  deps: AppDeps,
  workspaceId: string,
  agentId: string,
  row: DatabaseRow,
  input: SetAgentDatabaseInput,
): Promise<AgentDatabaseRow> {
  const [current] = await deps.db
    .select()
    .from(agentDatabases)
    .where(and(eq(agentDatabases.agentId, agentId), eq(agentDatabases.connectionId, row.id)));
  const parsed = input.policy ? databasePolicyInput.parse(input.policy) : {};
  const base = current?.policy ?? (input.level === "read" ? await defaultPolicy(deps, row) : null);
  const policy: schema.DatabasePolicyRow = {
    tables: [],
    maskedColumns: [],
    queriesPerDay: 200,
    timeoutSeconds: 30,
    ...base,
    ...parsed,
  };
  policy.tables = [...new Set(policy.tables)];
  policy.maskedColumns = [...new Set(policy.maskedColumns)];
  const values = { level: input.level, policy };
  const [saved] = await deps.db
    .insert(agentDatabases)
    .values({ agentId, connectionId: row.id, workspaceId, ...values })
    .onConflictDoUpdate({ target: [agentDatabases.agentId, agentDatabases.connectionId], set: values })
    .returning();
  if (!saved) throw new Error("agent database upsert failed");
  return saved;
}

// ---- The agent's tools ----

function explainFailure(f: GuardFailure): string {
  switch (f.reason) {
    case "multiple_statements":
      return "Send one statement at a time.";
    case "statement":
      return "Only reading is allowed: send a query (SELECT, WITH, VALUES or TABLE).";
    case "malformed":
      return "The query is not valid SQL.";
    case "ambiguous":
      return "The query reads differently depending on the server's settings; write the strings without backslashes.";
    case "write":
      return "Only reading is allowed: the query would change or lock data.";
    case "table":
      return `The table or view ${f.table} is not in this agent's policy.`;
    case "column":
      return `The column ${f.column} is hidden. Select the columns you need by name, without it.`;
    case "function":
      return `The function ${f.name} is not allowed.`;
    default: {
      const _exhaustive: never = f;
      return _exhaustive;
    }
  }
}

const cell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
  const flat = s.replace(/[\t\r\n]+/g, " ");
  return flat.length > CELL_MAX ? `${flat.slice(0, CELL_MAX)}…` : flat;
};

interface AgentDb {
  row: DatabaseRow;
  link: AgentDatabaseRow;
}

type DbRun = Pick<ToolContext, "deps" | "agent" | "workspaceId" | "channel">;

/** The databases the agent reads, only of the run's workspace and not turned off in the run's channel. */
async function agentDbs(ctx: DbRun): Promise<AgentDb[]> {
  const links = await ctx.deps.db
    .select()
    .from(agentDatabases)
    .where(
      and(
        eq(agentDatabases.agentId, ctx.agent.id),
        eq(agentDatabases.workspaceId, ctx.workspaceId),
        eq(agentDatabases.level, "read"),
      ),
    );
  if (links.length === 0) return [];
  const rows = await ctx.deps.db
    .select()
    .from(dataSources)
    .where(
      and(
        eq(dataSources.workspaceId, ctx.workspaceId),
        inArray(
          dataSources.id,
          links.map((l) => l.connectionId),
        ),
      ),
    );
  const rules = await channelRulesOf(ctx.deps.db, ctx.workspaceId, ctx.agent.id);
  return links.flatMap((link) => {
    const row = rows.find((r) => r.id === link.connectionId);
    return row && effectiveLevel("read", rules, ctx.channel.id, [row.id]) ? [{ row, link }] : [];
  });
}

async function pick(
  ctx: ToolContext,
  database: string,
  action: (typeof DB_ACTIONS)[number],
): Promise<AgentDb> {
  const all = await agentDbs(ctx);
  const key = database.trim().toLowerCase();
  const found = all.find((d) => d.row.id === database || d.row.label.toLowerCase() === key);
  if (!found)
    throw new ToolInputError(
      `Unknown database. Available: ${all.map((d) => `${d.row.label} (${d.row.id})`).join(", ") || "none"}`,
    );
  if (found.row.disabledActions.includes(action))
    throw new ToolInputError(`This action is turned off for ${found.row.label}.`);
  return found;
}

/** An HTTP error of a database call, as the tool's answer (its message never carries the password). */
async function asToolError<T>(work: () => Promise<T>): Promise<T | { content: string; isError: true }> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof HttpError) return { content: err.message, isError: true };
    throw err;
  }
}

const dbTables = define({
  name: "db_list_tables",
  description: "List the tables you can query in a connected database.",
  effect: "K0",
  input: z.object({ database: z.string().min(1).max(120).describe("Database label or id") }),
  async run(ctx, input) {
    const { row, link } = await pick(ctx, input.database, "tables");
    if (link.policy.tables.length === 0) return `No tables are available to you in ${row.label}.`;
    return `Tables in ${row.label}:\n${link.policy.tables.join("\n")}`;
  },
});

const dbDescribe = define({
  name: "db_describe_table",
  description: "Show the columns of a table you can query (hidden columns are left out).",
  effect: "K0",
  input: z.object({
    database: z.string().min(1).max(120),
    table: tableName.describe("schema.table or table, quoted as in SQL when it has capitals"),
  }),
  async run(ctx, input) {
    const { row, link } = await pick(ctx, input.database, "describe");
    const { table } = input;
    const relation = parseRelation(table);
    if (!relation || !link.policy.tables.includes(table))
      throw new ToolInputError(`The table or view ${table} is not in this agent's policy.`);
    // Each mask read the way checkPlan reads it, so a `table.column` mask hides here too.
    const hidden = new Set(link.policy.maskedColumns.map((c) => columnKey(c) ?? c));
    const cols = await asToolError(() =>
      guarded(ctx.deps, row, 15_000, (s) =>
        s.rows(
          "select column_name, data_type, is_nullable from information_schema.columns where table_schema = $1 and table_name = $2 order by ordinal_position",
          [relation.schema, relation.name],
        ),
      ),
    );
    if ("isError" in cols) return cols;
    const visible = cols.filter((r) => !hidden.has(`${table}.${quoteName(String(r.column_name))}`));
    if (visible.length === 0) return `No visible columns in ${table}.`;
    return visible
      .map((r) => `${r.column_name}\t${r.data_type}${r.is_nullable === "NO" ? " not null" : ""}`)
      .join("\n");
  },
});

/** Runs the checked statement as a subquery with a row cap: the agent never pulls a whole table into memory. */
const capped = (s: GuardedSession): GuardedSession => ({
  ...s,
  run: (statement) => s.run(`select * from (${statement}\n) as agent_query limit ${ROW_CAP + 1}`),
});

const dbQuery = define({
  name: "db_query",
  description: `Run one read-only SQL query (Postgres) on a connected database. At most ${ROW_CAP} rows come back; select only the columns you need.`,
  effect: "K0",
  input: z.object({
    database: z.string().min(1).max(120),
    sql: z.string().min(1).max(20_000),
  }),
  async run(ctx, input) {
    const { row, link } = await pick(ctx, input.database, "query");
    // What the text alone rejects never reaches the database, and doesn't count against the day's quota.
    const checked = guardStatement(input.sql);
    if ("failure" in checked) return { content: explainFailure(checked.failure), isError: true };
    const { deps } = ctx;
    // The quota is reserved before running: a query that the plan rejects or that fails also counts.
    const usage = {
      workspaceId: ctx.workspaceId,
      agentId: ctx.agent.id,
      resourceId: row.id,
      kind: "db_query" as const,
    };
    if (link.policy.queriesPerDay === null) await recordUsage(deps, usage);
    else if (!(await reserveUsage(deps, { ...usage, cap: link.policy.queriesPerDay })))
      throw new ToolInputError(
        `Daily limit of ${link.policy.queriesPerDay} queries reached for ${row.label}.`,
      );
    const password = databaseSealer(deps).open(row.secret);
    const outcome = await asToolError(() =>
      guarded(deps, row, link.policy.timeoutSeconds * 1000, async (s) => {
        try {
          return await guardedQuery(capped(s), input.sql, link.policy);
        } catch (err) {
          // The planner's or the executor's error (a missing column, the timeout): the model can correct it.
          return { error: outsideText(err, [password]) || "The query failed" };
        }
      }),
    );
    if ("isError" in outcome) return outcome;
    if ("error" in outcome) return { content: outcome.error, isError: true };
    if ("failure" in outcome) return { content: explainFailure(outcome.failure), isError: true };
    const { fields, rows } = outcome.result;
    // Rows come as objects by column name: two columns with one name would show the last value twice.
    if (new Set(fields).size !== fields.length)
      return {
        content: "Two result columns have the same name; give each one its own alias.",
        isError: true,
      };
    const shown = rows.slice(0, ROW_CAP);
    const lines = [fields.join("\t"), ...shown.map((r) => fields.map((f) => cell(r[f])).join("\t"))];
    const more = rows.length > ROW_CAP ? `\n[only the first ${ROW_CAP} rows]` : "";
    return `${shown.length} row(s)\n${lines.join("\n")}${more}`;
  },
});

export const DATABASE_TOOLS: readonly ToolDef<unknown>[] = [dbTables, dbDescribe, dbQuery];

/** Does the agent read any database in this run (its workspace, and not turned off in its channel)? */
export async function hasDatabases(run: DbRun): Promise<boolean> {
  return (await agentDbs(run)).length > 0;
}
