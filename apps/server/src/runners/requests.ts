// An agent's requests that depend on a person and on the agent's runner: a secret and the browser. The secret
// goes sealed from the person's browser straight to the runner; the server keeps only the request and the
// name. A browser intervention waits for the person to take over, do it and hand the control back.
import type { BrowserIntervention, SecretRequest } from "@vanr/contract";
import { schema } from "@vanr/engine/db";
import { and, eq, inArray, lte } from "drizzle-orm";
import type { AppDeps } from "../context";
import { closeNotifications, notify } from "../notifications";
import { pushPolicy } from "./browser-guard";
import { refreshStream } from "./browser-live";

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
  if (row.messageId) {
    const [msg] = await deps.db.select().from(messages).where(eq(messages.id, row.messageId));
    if (msg)
      await deps.db
        .update(messages)
        .set({ meta: { ...msg.meta, secretRequest } })
        .where(eq(messages.id, msg.id));
  }
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
): Promise<InterventionRow | null> {
  const [row] = await deps.db
    .update(browserInterventions)
    .set(set)
    .where(and(eq(browserInterventions.id, id), inArray(browserInterventions.status, from)))
    .returning();
  if (row) await publishIntervention(deps, row);
  return row ?? null;
}

/** The tick's sweep: expired secret requests and browser interventions. */
export async function expireRunnerRequests(deps: AppDeps) {
  const now = deps.now();
  const secrets = await deps.db
    .update(secretPrompts)
    .set({ status: "expired" })
    .where(and(eq(secretPrompts.status, "pending"), lte(secretPrompts.expiresAt, now)))
    .returning();
  for (const row of secrets) await publishSecret(deps, row, "secret_request.updated");
  const interventions = await deps.db
    .update(browserInterventions)
    .set({ status: "expired", handledAt: now })
    .where(
      and(
        inArray(browserInterventions.status, ["pending", "active"]),
        lte(browserInterventions.expiresAt, now),
      ),
    )
    .returning();
  for (const row of interventions) await publishIntervention(deps, row);
}
