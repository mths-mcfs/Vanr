// Assignment state that the engine and the UI read the same way: waiting on a person, stuck item, stale
// and the latest activity. No dependency on the engine (the UI imports it without starting DBOS).
import { schema } from "@vanr/engine/db";
import { eq, max, or } from "drizzle-orm";
import type { AppDeps } from "../context";
import type { AssignmentRow } from "../forward-types";
import type { PlanItemRow } from "./plan";

const { assignmentEvents, messages, runnerJobs } = schema;

/** With no activity for longer than this, the active assignment is stale. */
export const STALE_MS = 30 * 60_000;
/** Turns on an item without a person touching it: past this, the item is stuck and the assignment waits for someone. */
export const MAX_TURNS = 4;
/** Validation rounds of an item (rejected, fix, again). */
export const MAX_ROUNDS = 3;

export type StateItem = Pick<PlanItemRow, "status" | "passes" | "checks" | "turns" | "kind">;

/** What waits on a person: blocking decisions (with a deadline), reviews and commands, the submission. */
export interface PersonPending {
  decisions: { id: string; deadlineAt: Date | null }[];
  others: number;
  submission: boolean;
}

export function itemStuck(i: StateItem): "turns" | "rounds" | null {
  if (i.status === "dropped") return null;
  if (i.status !== "done") return i.turns >= MAX_TURNS ? "turns" : null;
  return i.kind !== "fix" && i.passes !== true && i.checks >= MAX_ROUNDS ? "rounds" : null;
}

/** Waits on a person: decision, review, command, submission, item blocked on you or stuck. */
export function waitingOnPerson(s: { person: PersonPending; items: readonly StateItem[] }): boolean {
  return (
    s.person.decisions.length > 0 ||
    s.person.others > 0 ||
    s.person.submission ||
    s.items.some((i) => i.status === "blocked_on_you" || itemStuck(i) !== null)
  );
}

/** Active, waiting on nobody, no timer requested and no activity for more than 30 min. */
export function isStale(
  s: {
    status: AssignmentRow["status"];
    person: PersonPending;
    items: readonly StateItem[];
    wakeAt: Date | null;
    lastActivity: Date | null;
  },
  now: Date,
): boolean {
  return (
    s.status === "active" &&
    !waitingOnPerson(s) &&
    !(s.wakeAt && s.wakeAt > now) &&
    s.lastActivity !== null &&
    now.getTime() - s.lastActivity.getTime() > STALE_MS
  );
}

/** Latest activity: assignment event, message in the thread or job row. */
export async function lastActivityOf(
  deps: Pick<AppDeps, "db">,
  row: AssignmentRow,
  jobs?: { lastSignalAt: Date | null }[],
): Promise<Date | null> {
  const [ev] = await deps.db
    .select({ at: max(assignmentEvents.at) })
    .from(assignmentEvents)
    .where(eq(assignmentEvents.assignmentId, row.id));
  const [msg] = await deps.db
    .select({ at: max(messages.createdAt) })
    .from(messages)
    .where(or(eq(messages.threadId, row.threadId), eq(messages.id, row.threadId)));
  const jobTimes =
    jobs ??
    (await deps.db
      .select({ lastSignalAt: runnerJobs.lastSignalAt })
      .from(runnerJobs)
      .where(eq(runnerJobs.assignmentId, row.id)));
  const all = [ev?.at, msg?.at, ...jobTimes.map((t) => t.lastSignalAt), row.startedAt].filter(
    (d): d is Date => d instanceof Date,
  );
  return all.length ? new Date(Math.max(...all.map((d) => d.getTime()))) : null;
}
