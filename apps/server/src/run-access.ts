// Who sees a run: the rule lives in one place (the run's detail and "save this flow as a skill").
import { type Db, schema } from "@vanr/engine/db";
import { and, eq, inArray } from "drizzle-orm";
import { readableChannel } from "./channels";
import { revealedDebateIds } from "./debates";
import { HttpError, notFound } from "./http";

const { runs } = schema;

/**
 * The run, if the person may see it: the run's channel, the channel a delegation came from and a debate that
 * already revealed who spoke. A debate's run stays hidden while the debate is anonymous: it would say who wrote.
 */
export async function readableRun(workspaceId: string, userId: string, runId: string, db: Db) {
  const [row] = await db
    .select()
    .from(runs)
    .where(and(eq(runs.id, runId), eq(runs.workspaceId, workspaceId)));
  if (!row) throw notFound("Run not found");
  // A channel the person can't read answers as a missing run: the two must not tell apart.
  const readable = (channelId: string) =>
    readableChannel(db, { workspaceId, userId, channelId }).catch((err: unknown) => {
      throw err instanceof HttpError && err.status === 404 ? notFound("Run not found") : err;
    });
  if (row.channelId) await readable(row.channelId);
  // A delegation shows the question in the detail: only to whoever reads the channel it came from.
  if (row.sourceChannelId) await readable(row.sourceChannelId);
  if (row.debateId) {
    const [ok] = await db
      .select({ id: schema.debates.id })
      .from(schema.debates)
      .where(
        and(
          eq(schema.debates.id, row.debateId),
          inArray(schema.debates.id, revealedDebateIds(db, { workspaceId, userId })),
        ),
      );
    if (!ok) throw notFound("Run not found");
  }
  return row;
}
