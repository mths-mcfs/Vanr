// A double of the database for the lock tests on Postgres (concurrency-postgres.test.ts): it instruments each
// transaction (records its pg_backend_pid(), runs a hook before or after its first select or update, so a test
// can hold one transaction at the point where the lock matters) and, with VANR_TEST_DROP_LOCKS=1, leaves the
// locks out (no pg_advisory_xact_lock, no FOR UPDATE), so CI can see the tests fail without them.
import type { Db } from "@vanr/engine/db";
import { sql } from "drizzle-orm";
import type postgres from "postgres";

/** The mutant mode of the forced tests: the double leaves the locks out. */
export const DROP_LOCKS = process.env.VANR_TEST_DROP_LOCKS === "1";

export interface Hooks {
  /** Runs once after a query of `kind` resolves, optionally matching its SQL (the hold point). */
  after?: { kind: "select" | "update"; match?: string; run: () => Promise<void> };
  /** Runs before the first query of `kind` is sent (the second transaction says it is about to read). */
  before?: { kind: "select"; run: () => void };
  pids: Set<number>;
}

// biome-ignore lint/suspicious/noExplicitAny: the double wraps drizzle's builders, whatever their type
type Any = any;

/** A query builder whose await runs the hooks; in DROP_LOCKS mode `.for("update")` is left out. */
export function wrapQuery(q: Any, done: (query: Any) => Promise<void>): Any {
  return new Proxy(q, {
    get(target, prop) {
      if (prop === "for" && DROP_LOCKS) return () => wrapQuery(target, done);
      if (prop === "then") {
        return (ok: (v: unknown) => unknown, fail: (e: unknown) => unknown) =>
          target
            .then(async (v: unknown) => {
              await done(target);
              return v;
            })
            .then(ok, fail);
      }
      const value = Reflect.get(target, prop, target);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const out = value.apply(target, args);
        return out && typeof out === "object" ? wrapQuery(out, done) : out;
      };
    },
  });
}

/** The literal text of a drizzle `sql` template (its string chunks), without the parameters. */
export const sqlText = (q: Any): string =>
  (q?.queryChunks ?? []).map((c: Any) => (Array.isArray(c?.value) ? c.value.join("") : "")).join("");

/** The database as one notify or one request sees it, with its transaction instrumented. */
export function instrumented(db: Db, hooks: Hooks): Db {
  return new Proxy(db, {
    get(target, prop) {
      if (prop !== "transaction") return Reflect.get(target, prop, target);
      return (fn: (tx: Any) => Promise<unknown>) =>
        target.transaction(async (tx) => {
          // postgres-js returns the rows; PGlite returns { rows }.
          const res: Any = await tx.execute(sql`select pg_backend_pid() as pid`);
          const me = (Array.isArray(res) ? res : (res?.rows ?? []))[0];
          if (typeof me?.pid === "number") hooks.pids.add(me.pid);
          const fired = new Set<string>();
          const tap = (kind: "select" | "update") => (q: Any) => {
            if (hooks.before?.kind === kind && !fired.has(`before:${kind}`)) {
              fired.add(`before:${kind}`);
              hooks.before.run();
            }
            return wrapQuery(q, async (query) => {
              if (
                hooks.after?.kind === kind &&
                !fired.has(`after:${kind}`) &&
                (!hooks.after.match || query.toSQL().sql.includes(hooks.after.match))
              ) {
                fired.add(`after:${kind}`);
                await hooks.after.run();
              }
            });
          };
          const proxied = new Proxy(tx, {
            get(t, p) {
              const value = Reflect.get(t, p, t);
              if (p === "execute" && DROP_LOCKS)
                return (q: Any) =>
                  // The invitee's advisory lock is the only execute of the invitation routes.
                  sqlText(q).includes("pg_advisory_xact_lock") ? Promise.resolve([]) : value.call(t, q);
              if (p === "select" || p === "update")
                return (...args: unknown[]) => tap(p)(value.apply(t, args));
              return typeof value === "function" ? value.bind(t) : value;
            },
          });
          return fn(proxied);
        });
    },
  });
}

/** A gate the first transaction waits on. */
export function gate() {
  let open!: () => void;
  const opened = new Promise<void>((r) => {
    open = r;
  });
  return { open, opened };
}

/**
 * The state of the two backends when B didn't get to wait: pg_stat_activity (state, wait_event_type,
 * wait_event, the query) and pg_locks (every lock of either backend, and every lock someone waits for; a row
 * lock wait is a ShareLock on the other transaction's `transactionid`, whose `database` is null).
 */
export async function diagnose(admin: postgres.Sql, label: string, a: number[], b: number[]) {
  const pids = [...a, ...b];
  const activity = await admin`
    select pid, state, wait_event_type, wait_event, left(query, 200) as query
    from pg_stat_activity where pid = any(${admin.array(pids)}::int[])`;
  const locks = await admin`
    select pid, locktype, mode, granted, database, relation::regclass::text as relation,
      transactionid::text as transactionid, virtualxid
    from pg_locks where pid = any(${admin.array(pids)}::int[]) or not granted order by pid, granted`;
  return [
    `LOCK_WAIT_TIMEOUT(${label}): B neither passed its step nor waited on a lock within ${WAIT_MS} ms`,
    `pids: A=${JSON.stringify(a)} B=${JSON.stringify(b)}`,
    `pg_stat_activity: ${JSON.stringify(activity)}`,
    `pg_locks: ${JSON.stringify(locks)}`,
  ].join("\n");
}

export const WAIT_MS = 5_000;

/**
 * Forces the interleaving. A runs until the end of its first matching `kind` query (where it holds the lock)
 * and holds there; then B starts. B either passes its own matching query (no lock to wait for) or its
 * backend waits on a lock, seen in pg_stat_activity as `wait_event_type = 'Lock'` (the same for the advisory
 * lock and for a row lock). Then A goes on. Past WAIT_MS it fails with LOCK_WAIT_TIMEOUT and the state of both
 * backends. A is always released and both are always awaited, so nothing is left running on the pool.
 */
export async function forcedPair<T>(
  admin: postgres.Sql,
  label: string,
  kind: "select" | "update",
  start: (side: "A" | "B", hooks: Hooks) => Promise<T>,
  match?: string,
): Promise<{ a: T; b: T; aPids: number[]; bPids: number[] }> {
  const aPids = new Set<number>();
  const bPids = new Set<number>();
  const held = gate();
  const release = gate();
  let bPassed = false;
  const running: Promise<unknown>[] = [];
  try {
    const a = start("A", {
      pids: aPids,
      after: {
        kind,
        match,
        run: async () => {
          held.open();
          await release.opened;
        },
      },
    });
    running.push(a);
    const first = await Promise.race([
      held.opened.then(() => "held" as const),
      a.then(
        () => "ended" as const,
        () => "ended" as const,
      ),
    ]);
    if (first === "ended") throw new Error(`LOCK_WAIT_TIMEOUT(${label}): A ended before its hold point`);
    const b = start("B", {
      pids: bPids,
      after: {
        kind,
        match,
        run: async () => {
          bPassed = true;
        },
      },
    });
    running.push(b);
    // Observed now so an early failure of B isn't unhandled; it is still thrown by Promise.all below.
    b.catch(() => undefined);
    const deadline = Date.now() + WAIT_MS;
    for (;;) {
      if (bPassed) break;
      const bPid = [...bPids][0];
      if (bPid !== undefined) {
        const [row] = await admin<{ wait_event_type: string | null }[]>`
          select wait_event_type from pg_stat_activity where pid = ${bPid}`;
        if (row?.wait_event_type === "Lock") break;
      }
      if (Date.now() > deadline) throw new Error(await diagnose(admin, label, [...aPids], [...bPids]));
      await Bun.sleep(25);
    }
    release.open();
    const [ra, rb] = await Promise.all([a, b]);
    return { a: ra, b: rb, aPids: [...aPids], bPids: [...bPids] };
  } finally {
    release.open();
    await Promise.allSettled(running);
  }
}

/** The outcome the lock is for; a different one fails with a marker the CI step looks for. */
export function outcome(label: string, got: unknown, want: unknown) {
  if (JSON.stringify(got) !== JSON.stringify(want))
    throw new Error(
      `LOCK_OUTCOME_MISMATCH(${label}): got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`,
    );
}
