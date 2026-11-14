// Daily quota of the integrations (emails sent, database queries), counted in `integration_usage`
// over a 24 h window. Checking and recording happen together, in a transaction that holds a lock per
// (agent, resource, kind): without it, N parallel calls read the same total before any of them
// records and all of them go over the limit.
import { schema } from "@vanr/engine/db";
import { newId } from "@vanr/engine/ids";
import { and, count, eq, gte, sql } from "drizzle-orm";
import type { AppDeps } from "../context";

const { integrationUsage } = schema;
type Kind = (typeof integrationUsage.$inferInsert)["kind"];

const WINDOW_MS = 24 * 3600_000;

/** Reserves one use within the quota. Returns the reservation id, or null when the day's quota is used up. */
export async function reserveUsage(
  deps: AppDeps,
  input: { workspaceId: string; agentId: string; resourceId: string; kind: Kind; cap: number },
): Promise<string | null> {
  if (input.cap <= 0) return null;
  const at = deps.now();
  const since = new Date(at.getTime() - WINDOW_MS);
  const key = `usage:${input.agentId}:${input.resourceId}:${input.kind}`;
  return deps.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
    const [used] = await tx
      .select({ n: count() })
      .from(integrationUsage)
      .where(
        and(
          eq(integrationUsage.agentId, input.agentId),
          eq(integrationUsage.resourceId, input.resourceId),
          eq(integrationUsage.kind, input.kind),
          gte(integrationUsage.at, since),
        ),
      );
    if ((used?.n ?? 0) >= input.cap) return null;
    const id = newId("use");
    await tx.insert(integrationUsage).values({
      id,
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      resourceId: input.resourceId,
      kind: input.kind,
      at,
    });
    return id;
  });
}

/** Gives the reservation back (the send failed before it went out). */
export async function releaseUsage(deps: AppDeps, id: string): Promise<void> {
  await deps.db.delete(integrationUsage).where(eq(integrationUsage.id, id));
}

/** Recording without a quota (a query with no configured limit: the use still shows on the screen). */
export async function recordUsage(
  deps: AppDeps,
  input: { workspaceId: string; agentId: string; resourceId: string; kind: Kind },
): Promise<void> {
  await deps.db.insert(integrationUsage).values({ id: newId("use"), ...input, at: deps.now() });
}
