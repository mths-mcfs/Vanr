// Changes of one calendar series at the same time on a real Postgres. Every write to a series locks the whole
// family (the root and its parts) in id order before anything else: so a split and an edit of the whole family
// run one after the other, and two edits of the whole family from different parts don't deadlock.
//
// The "forced" test runs in the CI mode VANR_TEST_DROP_LOCKS=1 (no locks) and the "ordered" test in
// VANR_TEST_DROP_ORDERED_LOCKS=1 (the family's ordered lock left out, the per-row locks kept); in each mode CI
// expects them to fail on their outcome (LOCK_OUTCOME_MISMATCH). These run only in the CI postgres job.
import { describe, expect, test } from "bun:test";
import type { CalendarEvent } from "@vanr/contract";
import { schema } from "@vanr/engine/db";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { expand } from "../src/calendar";
import type { AppDeps, WorkspaceMember } from "../src/context";
import { editEvent } from "../src/routes/calendar";
import type { RunningServer } from "../src/server";
import { body, signedIn, startTestServer } from "./harness";
import { forcedPair, instrumented, outcome } from "./lock-double";
import { NO_POSTGRES, TEST_POSTGRES_URL, testDatabaseUrl } from "./postgres";
import { seedWorkspace } from "./seed";

const onPostgres = (name: string) => (TEST_POSTGRES_URL ? name : `${name} (skipped: ${NO_POSTGRES})`);

/** The lock of one event row (`lockedEvent`); the family's lock filters on the workspace first. */
const EVENT_LOCK = 'where ("calendar_entries"."id" = $1 and';
const FAMILY_LOCK = 'order by "calendar_entries"."id"';

async function withSeries(
  prefix: string,
  run: (ctx: {
    server: RunningServer;
    admin: postgres.Sql;
    me: WorkspaceMember;
    root: CalendarEvent;
    part: CalendarEvent;
  }) => Promise<void>,
) {
  const url = await testDatabaseUrl(prefix);
  const server = await startTestServer({ env: { DATABASE_URL: url } });
  const admin = postgres(url, { max: 1, onnotice: () => {} });
  try {
    const ana = await signedIn(server, "Ana", `ana@${prefix.replaceAll("_", "-")}.test`);
    const { workspaceId } = await seedWorkspace(server, ana, "Agenda");
    const call = async (method: string, path: string, data: unknown) => {
      const res = await ana.browser.json(`/api/v1/workspaces/${workspaceId}${path}`, method, data);
      if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
      return (await body(res)) as CalendarEvent;
    };
    // Five days, split at the third: the root has the 15th and 16th, the part the 17th to the 19th.
    const root = await call("POST", "/calendar/events", {
      title: "Original",
      start: "2027-04-15T12:00:00Z",
      end: "2027-04-15T13:00:00Z",
      timezone: "UTC",
      rule: { freq: "daily", count: 5, timezone: "UTC" },
    });
    const part = await call("PATCH", `/calendar/events/${root.id}`, {
      scope: "following",
      instanceStart: "2027-04-17T12:00:00Z",
      title: "Original",
    });
    const me: WorkspaceMember = { workspaceId, userId: ana.user.id, role: "owner", handle: "ana" };
    await run({ server, admin, me, root, part });
  } finally {
    await server.stop();
    await admin.end({ timeout: 5 });
  }
}

const withDb = (deps: AppDeps, hooks: Parameters<typeof instrumented>[1]): AppDeps => ({
  ...deps,
  db: instrumented(deps.db, hooks),
});

/** The event as the route reads it before its transaction. */
async function visibleRow(server: RunningServer, id: string) {
  const [row] = await server.deps.db
    .select()
    .from(schema.calendarEntries)
    .where(eq(schema.calendarEntries.id, id));
  if (!row) throw new Error(`no event ${id}`);
  return row;
}

/** The titles of the family's occurrences, in time order. */
async function titles(server: RunningServer, workspaceId: string) {
  const rows = await server.deps.db
    .select()
    .from(schema.calendarEntries)
    .where(eq(schema.calendarEntries.workspaceId, workspaceId));
  const from = new Date("2027-04-14T00:00:00Z");
  const to = new Date("2027-04-21T00:00:00Z");
  return rows
    .flatMap((r) => expand(r, from, to))
    .sort((a, b) => a.start.localeCompare(b.start))
    .map((e) => e.title);
}

/** "ok", or the Postgres code a request would answer 500 for (40P01 for a deadlock). */
const settled = (p: Promise<unknown>) =>
  p.then(
    () => "ok",
    // biome-ignore lint/suspicious/noExplicitAny: drizzle wraps the driver's error in `cause`
    (err: any) => String(err?.cause?.code ?? err?.code ?? err?.message ?? err),
  );

describe.skipIf(!TEST_POSTGRES_URL)(onPostgres("calendar series at once on Postgres"), () => {
  test("forced: a split waits on the family's lock, so an edit of every part reaches the new part", async () => {
    await withSeries("cal_split", async ({ server, admin, me, root, part }) => {
      const rootRow = await visibleRow(server, root.id);
      const partRow = await visibleRow(server, part.id);
      // A splits the part on the 18th and holds once it has the family's lock. With the lock B, an edit of
      // every part, waits and then renames the new part too; without it, B renames the parts there are and the
      // part A makes afterwards keeps A's title.
      const run = await forcedPair(
        admin,
        "calendar-split-all",
        "select",
        (side, hooks) =>
          side === "A"
            ? editEvent(withDb(server.deps, hooks), me, partRow, {
                scope: "following",
                instanceStart: "2027-04-18T12:00:00Z",
                title: "Split",
              })
            : editEvent(withDb(server.deps, hooks), me, rootRow, { scope: "all", title: "All" }),
        { match: FAMILY_LOCK, bKind: "update", bMatch: '"calendar_entries"' },
      );
      expect(run.aPids[0]).not.toBe(run.bPids[0]);
      const got = await titles(server, me.workspaceId);
      outcome("calendar-split-all", got, ["All", "All", "All", "All", "All"]);
      expect(got).toEqual(["All", "All", "All", "All", "All"]);
    });
  }, 60_000);

  test("ordered: two edits of every part from different parts take the family's lock in one order", async () => {
    await withSeries("cal_order", async ({ server, admin, me, root, part }) => {
      const rootRow = await visibleRow(server, root.id);
      const partRow = await visibleRow(server, part.id);
      // A edits from the root, B from the part; A holds once it locked its own row. With the family's lock in
      // id order B waits for all of it; without it, each holds its own row and then waits for the other's, and
      // Postgres ends one of them with a deadlock (40P01, a 500 for the person).
      const run = await forcedPair(
        admin,
        "calendar-family-order",
        "select",
        (side, hooks) =>
          settled(
            editEvent(withDb(server.deps, hooks), me, side === "A" ? rootRow : partRow, {
              scope: "all",
              title: `Edit ${side}`,
            }),
          ),
        { match: EVENT_LOCK },
      );
      const names = await titles(server, me.workspaceId);
      const got = { requests: [run.a, run.b], titles: new Set(names).size, occurrences: names.length };
      outcome("calendar-family-order", got, { requests: ["ok", "ok"], titles: 1, occurrences: 5 });
      expect(got).toEqual({ requests: ["ok", "ok"], titles: 1, occurrences: 5 });
    });
  }, 60_000);
});
