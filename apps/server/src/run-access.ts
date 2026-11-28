// Who sees a run: the rule lives in one place, for the lists (runs, inbox, live runs, the team) and the detail.
import { can, type Role } from "@vanr/contract";
import { type Db, schema } from "@vanr/engine/db";
import { and, eq, inArray, isNull, or, type SQL, sql } from "drizzle-orm";
import { readableChannelsSql } from "./channels";
import { revealedDebateIds } from "./debates";
import { notFound } from "./http";

const { runs } = schema;

/**
 * The workspace's runs the person may see: of a channel they read (or none), a delegation only to whoever reads
 * the channel it came from (the run shows the question), and a debate's turn only once the debate revealed who
 * spoke (a debate's run would say who wrote while it stays anonymous).
 */
export function readableRuns(db: Db, viewer: { workspaceId: string; userId: string }): SQL {
  const readable = readableChannelsSql(viewer);
  return sql`${and(
    eq(runs.workspaceId, viewer.workspaceId),
    or(isNull(runs.channelId), sql`${runs.channelId} in ${readable}`),
    or(isNull(runs.sourceChannelId), sql`${runs.sourceChannelId} in ${readable}`),
    or(isNull(runs.debateId), inArray(runs.debateId, revealedDebateIds(db, viewer))),
  )}`;
}

/**
 * Who may stop a live run: whoever manages agents, the agent's owner, or the person the run works for (its
 * initiator; a routine's run has none). The Stop button and a "stop" typed in the conversation ask this same rule.
 */
export function mayStopRun(
  person: { userId: string; role: Role },
  run: { ownerUserId: string; initiatedBy: string | null },
): boolean {
  return (
    can(person.role, "manage_agents") ||
    run.ownerUserId === person.userId ||
    run.initiatedBy === person.userId
  );
}

/** The run, if the person may see it. One they can't read answers as a missing run: the two must not tell apart. */
export async function readableRun(workspaceId: string, userId: string, runId: string, db: Db) {
  const [row] = await db
    .select()
    .from(runs)
    .where(and(eq(runs.id, runId), readableRuns(db, { workspaceId, userId })));
  if (!row) throw notFound("Run not found");
  return row;
}
