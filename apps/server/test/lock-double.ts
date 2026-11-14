// A double of the database for the lock tests on Postgres (concurrency-postgres.test.ts): it instruments each
// transaction (records its pg_backend_pid(), runs a hook before or after its first select or update, so a test
// can hold one transaction at the point where the lock matters) and, with VANR_TEST_DROP_LOCKS=1, leaves the
// locks out (no pg_advisory_xact_lock, no FOR UPDATE), so CI can see the tests fail without them.
import type { Db } from "@vanr/engine/db";
import { sql } from "drizzle-orm";

/** The mutant mode of the forced tests: the double leaves the locks out. */
export const DROP_LOCKS = process.env.VANR_TEST_DROP_LOCKS === "1";

export interface Hooks {
  /** Runs once, after the first query of `kind` of the transaction resolved (the point where it holds). */
  after?: { kind: "select" | "update"; run: () => Promise<void> };
  /** Runs before the first query of `kind` is sent (the second transaction says it is about to read). */
  before?: { kind: "select"; run: () => void };
  pids: Set<number>;
}

// biome-ignore lint/suspicious/noExplicitAny: the double wraps drizzle's builders, whatever their type
type Any = any;

/** A query builder whose await runs the hooks; in DROP_LOCKS mode `.for("update")` is left out. */
export function wrapQuery(q: Any, done: () => Promise<void>): Any {
  return new Proxy(q, {
    get(target, prop) {
      if (prop === "for" && DROP_LOCKS) return () => wrapQuery(target, done);
      if (prop === "then") {
        return (ok: (v: unknown) => unknown, fail: (e: unknown) => unknown) =>
          target
            .then(async (v: unknown) => {
              await done();
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
            return wrapQuery(q, async () => {
              if (hooks.after?.kind === kind && !fired.has(`after:${kind}`)) {
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
