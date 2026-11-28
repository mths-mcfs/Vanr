// An agent's requests that depend on a person and on the agent's runner: a secret and the browser. The secret
// goes sealed from the person's browser straight to the runner; the server keeps only the request and the
// name. A browser intervention waits for the person to take over, do it and hand the control back.
import type { BrowserIntervention, SecretRequest } from "@vanr/contract";
import { type Db, schema } from "@vanr/engine/db";
import { and, eq, gt, inArray, lte, sql } from "drizzle-orm";
import type { AppDeps } from "../context";
import { closeNotifications, notify } from "../notifications";
import { canTalkTo } from "../runtime/route";
import { pushPolicy } from "./browser-guard";
import { refreshStream } from "./browser-live";
import { withPlanOwner } from "./plans";
import { personMayUseRunner } from "./runners";

const { secretPrompts, browserInterventions, messages } = schema;

export type SecretRequestRow = typeof secretPrompts.$inferSelect;
export type InterventionRow = typeof browserInterventions.$inferSelect;

export const SECRET_TTL_MS = 30 * 60 * 1000;
export const INTERVENTION_TTL_MS = 15 * 60 * 1000;

export function toSecretRequest(row: SecretRequestRow): SecretRequest {
  return {
    id: row.id,
    agentId: row.agentId,
    name: row.name,
    purpose: row.purpose,
    target: row.target === "env" ? { kind: "env" } : { kind: "file", path: row.filePath ?? "" },
    status: row.status,
    targetUserId: row.targetUserId,
    channelId: row.channelId,
    deciderUserId: row.decidedBy,
    runnerId: row.runnerId,
    publicKey: row.publicKey,
    browser: row.browser ?? null,
    expiresAt: row.expiresAt.toISOString(),
    fulfilledAt: row.fulfilledAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** The target as the runner and the sealed box know it: `env` or `file:<path>`. */
export const secretTarget = (row: Pick<SecretRequestRow, "target" | "filePath">) =>
  row.target === "env" ? "env" : `file:${row.filePath ?? ""}`;

/** Updates the card (the whole request lives in the meta), tells the channel and the person. */
export async function publishSecret(
  deps: AppDeps,
  row: SecretRequestRow,
  type: "secret_request.created" | "secret_request.updated",
) {
  const secretRequest = toSecretRequest(row);
  // One statement merges the request into the card's meta: what else the meta holds stays.
  if (row.messageId)
    await deps.db
      .update(messages)
      .set({ meta: sql`${messages.meta} || ${JSON.stringify({ secretRequest })}::jsonb` })
      .where(eq(messages.id, row.messageId));
  if (row.channelId) deps.hub.toChannel(row.channelId, { type, secretRequest, messageId: row.messageId });
  else if (row.targetUserId) deps.hub.toUser(row.workspaceId, row.targetUserId, { type, secretRequest });
  const groupKey = `secret:${row.id}`;
  if (row.status !== "pending") {
    await closeNotifications(deps, row.workspaceId, groupKey);
    return;
  }
  if (!row.targetUserId) return;
  await notify(deps, {
    workspaceId: row.workspaceId,
    userId: row.targetUserId,
    kind: "question_for_you",
    reason: "secret_prompt",
    groupKey,
    waiting: true,
    actor: { type: "agent", id: row.agentId },
    source: {
      runnerId: row.runnerId,
      ...(row.channelId ? { channelId: row.channelId } : {}),
      ...(row.threadId ? { threadId: row.threadId } : {}),
      ...(row.messageId ? { messageId: row.messageId } : {}),
    },
    latest: { text: `${row.name}: ${row.purpose}`.slice(0, 280), expiresAt: row.expiresAt.toISOString() },
  });
}

export function toIntervention(row: InterventionRow): BrowserIntervention {
  return {
    id: row.id,
    agentId: row.agentId,
    status: row.status,
    kind: row.kind,
    instructions: row.instructions,
    controllingUserId: row.controllingUserId,
    targetUserId: row.targetUserId,
    runnerId: row.runnerId,
    url: row.url,
    channelId: row.channelId,
    note: row.note,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    handledAt: row.handledAt?.toISOString() ?? null,
  };
}

/**
 * Who waits for the end of each browser intervention: the `browser_ask_person` tool and the browser tools that
 * arrived with the person in control (from any run of the agent).
 */
const interventionWaiters = new Map<string, Set<(row: InterventionRow) => void>>();

// Control belongs to the granting session in this server process. Unbound controls after a restart are released.
const controlSessions = new WeakMap<AppDeps, Map<string, string>>();
export function interventionSession(deps: AppDeps, id: string, sessionId?: string) {
  let sessions = controlSessions.get(deps);
  if (!sessions) {
    sessions = new Map();
    controlSessions.set(deps, sessions);
  }
  if (sessionId) sessions.set(id, sessionId);
  return sessions.get(id);
}

export async function revalidateInterventions(deps: AppDeps, endedSessionId?: string) {
  const { browserInterventions: h, sessions, members, agents } = schema;
  const active = await deps.db.select().from(h).where(eq(h.status, "active"));
  for (const row of active) {
    const sessionId = interventionSession(deps, row.id);
    if (endedSessionId && sessionId !== endedSessionId) continue;
    const [right] =
      sessionId && !endedSessionId
        ? await deps.db
            .select({ id: sessions.id })
            .from(sessions)
            .innerJoin(
              members,
              and(eq(members.userId, sessions.userId), eq(members.workspaceId, row.workspaceId)),
            )
            .where(
              and(
                eq(sessions.id, sessionId),
                eq(sessions.userId, row.controllingUserId ?? ""),
                gt(sessions.expiresAt, deps.now()),
              ),
            )
        : [];
    const [agent] = await deps.db.select().from(agents).where(eq(agents.id, row.agentId));
    const [runner] = await deps.db.select().from(schema.runners).where(eq(schema.runners.id, row.runnerId));
    // Control stays only while the controller may still use the runner (a demoted role loses it).
    if (
      right &&
      agent &&
      runner &&
      agent.environmentId === row.runnerId &&
      canTalkTo(await withPlanOwner(deps.db, agent), row.controllingUserId ?? "") &&
      (await personMayUseRunner(
        deps.db,
        { workspaceId: row.workspaceId, userId: row.controllingUserId ?? "" },
        runner,
      ))
    )
      continue;
    await moveIntervention(
      deps,
      row.id,
      ["active"],
      { status: "canceled", handledAt: deps.now() },
      { controller: row.controllingUserId ?? "" },
    );
  }
}

/** Closes only open requests of the old binding; delivered secret metadata stays available. */
export async function cancelRunnerRequests(db: Db, now: Date, runnerId: string, agentIds?: string[]) {
  const secrets = await db
    .update(secretPrompts)
    .set({ status: "canceled" })
    .where(
      and(
        eq(secretPrompts.runnerId, runnerId),
        eq(secretPrompts.status, "pending"),
        agentIds ? inArray(secretPrompts.agentId, agentIds) : undefined,
      ),
    )
    .returning();
  const interventions = await db
    .update(browserInterventions)
    .set({ status: "canceled", handledAt: now })
    .where(
      and(
        eq(browserInterventions.runnerId, runnerId),
        inArray(browserInterventions.status, ["pending", "active"]),
        agentIds ? inArray(browserInterventions.agentId, agentIds) : undefined,
      ),
    )
    .returning();
  return { secrets, interventions };
}

export async function publishRunnerRequests(
  deps: AppDeps,
  closed: Awaited<ReturnType<typeof cancelRunnerRequests>>,
) {
  for (const row of closed.secrets) await publishSecret(deps, row, "secret_request.updated");
  for (const row of closed.interventions) await publishIntervention(deps, row);
}

const isOpen = (status: InterventionRow["status"]) => status === "pending" || status === "active";

/**
 * Waits for the intervention to close. `recheck` reads it again after registering the wait: if it closed between
 * the caller's read and the registration, the wait ends at once instead of hanging.
 */
export function waitIntervention(
  id: string,
  signal: AbortSignal,
  recheck?: () => Promise<InterventionRow | null | undefined>,
): Promise<InterventionRow | null> {
  return new Promise((resolve) => {
    const waiters = interventionWaiters.get(id) ?? new Set();
    interventionWaiters.set(id, waiters);
    const finish = (row: InterventionRow | null) => {
      signal.removeEventListener("abort", onAbort);
      waiters.delete(finisher);
      if (waiters.size === 0 && interventionWaiters.get(id) === waiters) interventionWaiters.delete(id);
      resolve(row);
    };
    const finisher = (row: InterventionRow) => finish(row);
    const onAbort = () => finish(null);
    if (signal.aborted) return finish(null);
    signal.addEventListener("abort", onAbort, { once: true });
    waiters.add(finisher);
    void recheck?.()
      .then((row) => {
        if (row && !isOpen(row.status)) finish(row);
      })
      .catch(() => {});
  });
}

export async function publishIntervention(deps: AppDeps, row: InterventionRow) {
  const intervention = toIntervention(row);
  if (row.channelId)
    deps.hub.toChannel(row.channelId, { type: "browser_intervention.updated", intervention });
  const people = new Set([row.targetUserId, row.controllingUserId].filter((u): u is string => !!u));
  if (!row.channelId)
    for (const u of people)
      deps.hub.toUser(row.workspaceId, u, { type: "browser_intervention.updated", intervention });
  const groupKey = `intervention:${row.id}`;
  const open = isOpen(row.status);
  // Who drives changed (took over, handed back, expired): the open Chrome follows the new rule.
  await pushPolicy(deps, row.agentId);
  if (!open) {
    controlSessions.get(deps)?.delete(row.id);
    for (const finish of [...(interventionWaiters.get(row.id) ?? [])]) finish(row);
    await closeNotifications(deps, row.workspaceId, groupKey);
  } else if (row.status === "active") {
    // The person took over the browser: the request was met, the notice leaves "blocked on you".
    await closeNotifications(deps, row.workspaceId, groupKey);
  } else if (row.status === "pending" && row.targetUserId && row.kind !== "intervention") {
    await notify(deps, {
      workspaceId: row.workspaceId,
      userId: row.targetUserId,
      kind: "browser_intervention",
      groupKey,
      waiting: true,
      actor: { type: "agent", id: row.agentId },
      source: {
        interventionId: row.id,
        runnerId: row.runnerId,
        ...(row.channelId ? { channelId: row.channelId } : {}),
        ...(row.threadId ? { threadId: row.threadId } : {}),
        ...(row.messageId ? { messageId: row.messageId } : {}),
      },
      latest: { text: row.instructions.slice(0, 280), expiresAt: row.expiresAt.toISOString() },
    });
  }
  await refreshStream(deps, row.agentId);
}

/** Moves the state if it is still one of the expected ones; returns the new row (null = it already changed). */
export async function moveIntervention(
  deps: AppDeps,
  id: string,
  from: InterventionRow["status"][],
  set: Partial<Pick<InterventionRow, "status" | "controllingUserId" | "note" | "handledAt">>,
  auth: { controller?: string; sessionId?: string } = {},
): Promise<InterventionRow | null> {
  const change = async (db: Db) => {
    if (auth.sessionId) {
      const [session] = await db
        .select({ id: schema.sessions.id })
        .from(schema.sessions)
        .where(and(eq(schema.sessions.id, auth.sessionId), gt(schema.sessions.expiresAt, deps.now())))
        .for("share");
      if (!session) return null;
    }
    const [row] = await db
      .update(browserInterventions)
      .set(set)
      .where(
        and(
          eq(browserInterventions.id, id),
          inArray(browserInterventions.status, from),
          auth.controller === undefined
            ? undefined
            : eq(browserInterventions.controllingUserId, auth.controller),
          set.status === "active" ? gt(browserInterventions.expiresAt, deps.now()) : undefined,
          set.status === "active"
            ? sql`exists (select 1 from ${schema.agents} where ${schema.agents.id} = ${browserInterventions.agentId} and ${schema.agents.environmentId} = ${browserInterventions.runnerId})`
            : undefined,
        ),
      )
      .returning();
    if (row && auth.sessionId) interventionSession(deps, row.id, auth.sessionId);
    return row ?? null;
  };
  const row = auth.sessionId ? await deps.db.transaction(change) : await change(deps.db);
  if (row) await publishIntervention(deps, row);
  return row ?? null;
}

/** The tick's sweep: expired secret requests and browser interventions. */
export async function expireRunnerRequests(deps: AppDeps, agentId?: string) {
  const now = deps.now();
  const secrets = await deps.db
    .update(secretPrompts)
    .set({ status: "expired" })
    .where(
      and(
        eq(secretPrompts.status, "pending"),
        lte(secretPrompts.expiresAt, now),
        agentId ? eq(secretPrompts.agentId, agentId) : undefined,
      ),
    )
    .returning();
  for (const row of secrets) await publishSecret(deps, row, "secret_request.updated");
  const interventions = await deps.db
    .update(browserInterventions)
    .set({ status: "expired", handledAt: now })
    .where(
      and(
        inArray(browserInterventions.status, ["pending", "active"]),
        lte(browserInterventions.expiresAt, now),
        agentId ? eq(browserInterventions.agentId, agentId) : undefined,
      ),
    )
    .returning();
  for (const row of interventions) await publishIntervention(deps, row);
}
