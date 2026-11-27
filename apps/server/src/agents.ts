// Agents: the API shape, the lookup in the workspace, the month's budget and who may edit.
import {
  AGENT_BODIES,
  AGENT_EXTRAS,
  AGENT_MOUTHS,
  type Agent,
  type AgentAppearance,
  type AgentDetail,
  type AgentRole,
  can,
  type Memory,
} from "@vanr/contract";
import { type Db, schema } from "@vanr/engine/db";
import { contentSha256 } from "@vanr/engine/memory";
import type { BudgetScope } from "@vanr/engine/usage";
import { and, count, eq, gte, inArray, isNull, notInArray, or, sql, sum } from "drizzle-orm";
import type { WorkspaceMember } from "./context";
import { badRequest, forbidden, notFound } from "./http";
import { type Talker, withPlanOwner } from "./runners/plans";
import { canTalkTo } from "./runtime/route";

const { agents, runs, workspaces, channelMemberships, channels, credentials, debates } = schema;

/**
 * Runs that count in the per-agent numbers (the month's usage, the report). The ones of a debate that is still
 * anonymous stay out until it ends: the size of each turn, crossed with each agent's token growth, would tell
 * who each participant is. The cap stays in the ledger, which counts everything.
 */
const outsideAnonymousDebate = () =>
  or(
    isNull(runs.debateId),
    notInArray(
      runs.debateId,
      sql`(select ${debates.id} from ${debates} where ${debates.status} in ('open', 'stalled'))`,
    ),
  );

export type AgentRow = typeof agents.$inferSelect;
export type MemoryRow = typeof schema.memories.$inferSelect;

export const AGENT_ROLES = [
  "dev",
  "ops",
  "qa",
  "pm",
  "support",
  "sales",
  "marketing",
  "content",
  "data",
  "finance",
  "people",
  "research",
  "assistant",
  "custom",
] as const satisfies readonly AgentRole[];

export function isAgentRole(v: string): v is AgentRole {
  return AGENT_ROLES.some((r) => r === v);
}

const listed = <T extends string>(list: readonly T[], value: unknown): T | undefined =>
  list.find((v) => v === value);

/**
 * The appearance as the API gives it. The routes write the body, the mouth and the extra only from the contract's
 * lists; a stored value outside them (or null) is left out on the way out, as if the agent had no such part.
 */
export function toAppearance(stored: AgentAppearance): AgentAppearance {
  const body = listed(AGENT_BODIES, stored.body);
  const mouth = listed(AGENT_MOUTHS, stored.mouth);
  const extra = listed(AGENT_EXTRAS, stored.extra);
  return {
    color: stored.color,
    eyes: stored.eyes,
    adornment: stored.adornment,
    ...(body ? { body } : {}),
    ...(mouth ? { mouth } : {}),
    ...(extra ? { extra } : {}),
  };
}

export function toAgent(row: Talker, viewerId: string, busy: boolean, testModel: boolean): Agent {
  return {
    id: row.id,
    name: row.name,
    handle: row.handle,
    role: isAgentRole(row.role) ? row.role : "custom",
    instructions: row.instructions,
    model: row.model,
    ownerUserId: row.ownerUserId,
    audience: { mode: row.visibilityMode, userIds: row.audienceUserIds },
    reachable: canTalkTo(row, viewerId),
    appearance: toAppearance(row.appearance),
    harness: { kind: row.harnessKind, model: row.harnessModel ?? row.model, environment: row.environmentId },
    advisor: row.advisorModel ? { model: row.advisorModel, maxUses: row.advisorMaxUses } : null,
    busy,
    testModel,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function agentInWorkspace(db: Db, workspaceId: string, agentId: string): Promise<AgentRow> {
  const [row] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.workspaceId, workspaceId), eq(agents.id, agentId)));
  if (!row) throw notFound("Agent not found");
  return row;
}

/** Who edits an agent: who manages agents or the agent's owner. */
export function requireAgentEditor(me: WorkspaceMember, agent: AgentRow) {
  if (can(me.role, "manage_agents") || agent.ownerUserId === me.userId) return;
  throw forbidden();
}

export const monthStart = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
export const monthKey = (now: Date) => now.toISOString().slice(0, 7);

export interface MonthUsage {
  runs: number;
  tokens: number;
  costUsd: number;
}

export async function monthUsage(db: Db, agentIds: string[], now: Date): Promise<Map<string, MonthUsage>> {
  const out = new Map<string, MonthUsage>();
  if (agentIds.length === 0) return out;
  const rows = await db
    .select({
      agentId: runs.agentId,
      runs: count(),
      tokens: sum(sql`${runs.inputTokens} + ${runs.cachedTokens} + ${runs.outputTokens}`),
      cost: sum(runs.costUsd),
    })
    .from(runs)
    .where(
      and(inArray(runs.agentId, agentIds), gte(runs.createdAt, monthStart(now)), outsideAnonymousDebate()),
    )
    .groupBy(runs.agentId);
  for (const r of rows) {
    out.set(r.agentId, { runs: r.runs, tokens: Number(r.tokens ?? 0), costUsd: Number(r.cost ?? 0) });
  }
  return out;
}

export async function workspaceBudgetDefaults(db: Db, workspaceId: string) {
  const [workspace] = await db
    .select({
      defaultBudget: workspaces.agentBudgetDefaultUsd,
      primaryCredentialId: workspaces.primaryCredentialId,
      name: workspaces.name,
      context: workspaces.context,
    })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));
  if (!workspace) throw notFound("Workspace not found");
  return workspace;
}

export const budgetOf = (agent: AgentRow, defaultBudget: number) => agent.budgetPerMonthUsd ?? defaultBudget;

/** The agent's cap for the month, as a ledger scope. */
export async function agentBudgetScope(db: Db, agent: AgentRow): Promise<BudgetScope> {
  const workspace = await workspaceBudgetDefaults(db, agent.workspaceId);
  return { kind: "agent", id: agent.id, limitUsd: budgetOf(agent, workspace.defaultBudget), period: "month" };
}

/** A workspace key that still holds (not revoked). */
export async function requireCredential(db: Db, workspaceId: string, id: string | null | undefined) {
  if (!id) return;
  const [row] = await db
    .select({ id: credentials.id })
    .from(credentials)
    .where(
      and(eq(credentials.id, id), eq(credentials.workspaceId, workspaceId), isNull(credentials.revokedAt)),
    );
  if (!row) throw badRequest("Unknown credential", { field: "credentialId" });
}

/** Cost per agent since a date, for the usage report and the overview. */
export async function usageSince(db: Db, workspaceId: string, since: Date) {
  const rows = await db
    .select({ agentId: runs.agentId, calls: count(), cost: sum(runs.costUsd) })
    .from(runs)
    .where(and(eq(runs.workspaceId, workspaceId), gte(runs.createdAt, since), outsideAnonymousDebate()))
    .groupBy(runs.agentId);
  return new Map(rows.map((r) => [r.agentId, { calls: r.calls, costUsd: Number(r.cost ?? 0) }]));
}

export async function agentChannels(db: Db, agentId: string) {
  return db
    .select({ id: channelMemberships.channelId, autoAnswer: channelMemberships.autoAnswer })
    .from(channelMemberships)
    .innerJoin(channels, eq(channels.id, channelMemberships.channelId))
    .where(
      and(
        eq(channelMemberships.memberType, "agent"),
        eq(channelMemberships.memberId, agentId),
        eq(channels.kind, "channel"),
        isNull(channels.archivedAt),
      ),
    );
}

export async function toAgentDetail(
  db: Db,
  row: AgentRow,
  input: { viewerId: string; busy: boolean; testModel: boolean; now: Date },
): Promise<AgentDetail> {
  const workspace = await workspaceBudgetDefaults(db, row.workspaceId);
  const usage = (await monthUsage(db, [row.id], input.now)).get(row.id) ?? { runs: 0, tokens: 0, costUsd: 0 };
  const budget = budgetOf(row, workspace.defaultBudget);
  return {
    ...toAgent(await withPlanOwner(db, row), input.viewerId, input.busy, input.testModel),
    budgetSpentPct: budget > 0 ? Math.min(999, Math.round((usage.costUsd / budget) * 100)) : 100,
    budgetPerMonthUsd: budget,
    inheritedBudgetUsd: workspace.defaultBudget,
    budgetInherited: row.budgetPerMonthUsd === null,
    credentialId: row.credentialId,
    channels: await agentChannels(db, row.id),
    queuedApprovals: (
      await db
        .select({ id: schema.approvals.id })
        .from(schema.approvals)
        .where(and(eq(schema.approvals.agentId, row.id), eq(schema.approvals.status, "pending")))
    ).length,
    monthRuns: usage.runs,
    monthTokens: usage.tokens,
    costThisMonthUsd: usage.costUsd,
  };
}

export function toMemory(row: MemoryRow): Memory {
  return {
    id: row.id,
    agentId: row.agentId,
    scope: row.scope,
    path: row.path,
    sha256: contentSha256(row.text),
    text: row.text,
    kind: row.kind,
    about: row.about,
    pinned: row.pinned,
    archived: row.archived,
    verified: row.verified,
    untrustedSource: row.untrustedSource,
    uses: row.uses,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    source: row.source,
    origin: row.origin ?? null,
    replaces: row.replaces,
    editorUserId: row.editorUserId,
    updatedAt: row.updatedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

/** The agents' names and handles, for message authorship and the directory. */
export async function agentNames(
  db: Db,
  ids: string[],
): Promise<Map<string, { name: string; handle: string }>> {
  const out = new Map<string, { name: string; handle: string }>();
  if (ids.length === 0) return out;
  const rows = await db
    .select({ id: agents.id, name: agents.name, handle: agents.handle })
    .from(agents)
    .where(inArray(agents.id, ids));
  for (const r of rows) out.set(r.id, { name: r.name, handle: r.handle });
  return out;
}
