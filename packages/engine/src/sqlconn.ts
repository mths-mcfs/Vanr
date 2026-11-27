// Connection to a customer's database (the databases integration). Queries run in a READ ONLY
// transaction. Postgres enforces statement_timeout; PGlite in tests stores it but does not enforce it.
import { isIP } from "node:net";
import type { PGlite } from "@electric-sql/pglite";
import postgres from "postgres";

export interface SqlResult {
  fields: string[];
  rows: Record<string, unknown>[];
}

export interface ReadOnlySession {
  /** One SELECT/VALUES/TABLE/WITH query usable as a subquery, without a terminating semicolon. */
  query(text: string): Promise<SqlResult>;
}

export interface SqlConnection {
  readOnly<T>(timeoutMs: number, fn: (s: ReadOnlySession) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export interface SqlTarget {
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  sslmode: "disable" | "require" | "verify-full";
  /** Address already checked for connecting; `host` is still the name used for TLS. */
  address?: string;
}

export type SqlConnector = (target: SqlTarget) => Promise<SqlConnection>;

/** Statement timeout for the current transaction, never below 100 ms. */
const timeoutSql = (ms: number) => `set local statement_timeout = ${Math.max(100, Math.floor(ms))}`;

/**
 * The server parses input as a subquery, excluding transaction/session commands without a SQL parser
 * here. The caller must also use the extended protocol, so input cannot escape into a second command.
 */
const readQuery = (text: string) => `select * from (\n${text}\n) as read_only_query`;

/** Real Postgres. One connection per use; the caller closes it. */
export const postgresConnector: SqlConnector = async (t) => {
  const sql = postgres({
    host: t.address ?? t.host,
    port: t.port,
    database: t.database,
    username: t.username,
    password: t.password,
    ssl:
      t.sslmode === "disable"
        ? false
        : {
            rejectUnauthorized: t.sslmode === "verify-full",
            ...(isIP(t.host) ? {} : { servername: t.host }),
          },
    max: 1,
    connect_timeout: 10,
    idle_timeout: 5,
    prepare: false,
    onnotice: () => {},
  });
  async function readOnly<T>(timeoutMs: number, fn: (s: ReadOnlySession) => Promise<T>): Promise<T> {
    let result!: T;
    await sql.begin("read only", async (tx) => {
      await tx.unsafe(timeoutSql(timeoutMs));
      result = await fn({
        async query(text) {
          // A tagged query uses the extended protocol even with no parameters or prepared statements.
          const rows = await tx`${tx.unsafe(readQuery(text))}`;
          return { fields: rows.columns?.map((c) => c.name) ?? [], rows: [...rows] };
        },
      });
    });
    return result;
  }
  return { readOnly, close: () => sql.end({ timeout: 2 }) };
};

/** An already open PGlite (tests): the "customer database" is an in-memory Postgres. */
export function pgliteConnector(pg: PGlite): SqlConnector {
  return async () => ({
    async readOnly(timeoutMs, fn) {
      return pg.transaction(async (tx) => {
        await tx.exec("set transaction read only");
        await tx.exec(timeoutSql(timeoutMs));
        return fn({
          async query(text) {
            const res = await tx.query<Record<string, unknown>>(readQuery(text));
            return { fields: res.fields.map((f) => f.name), rows: res.rows };
          },
        });
      });
    },
    close: async () => {},
  });
}

/** In-memory Postgres for tests that need a "customer database". */
export async function memoryPostgres(): Promise<PGlite> {
  const { PGlite } = await import("@electric-sql/pglite");
  return new PGlite();
}
