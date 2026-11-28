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
} from "@vanr/contract";
import { type Db, schema } from "@vanr/engine/db";
import type { BudgetScope } from "@vanr/engine/usage";
import { and, count, eq, gte, inArray, isNull, notInArray, or, sql, sum } from "drizzle-orm";
import type { Hono } from "hono";
import { readableChannelsSql } from "./channels";
import type { AppEnv, WorkspaceMember } from "./context";
import { badRequest, conflict, forbidden, notFound } from "./http";
import { type Talker, withPlanOwner } from "./runners/plans";
import { canTalkTo } from "./runtime/route";

const { agents, runs, workspaces, channelMemberships, channels, credentials, debates } = schema;

/**
 * Runs that count in the per-agent numbers (the month's usage, the report). The ones of a debate that is still
 * anonymous stay out until it ends: the size of each turn, crossed with each agent's token growth, would tell
 * who each participant is. The cap stays in the ledger, which counts everything.
 */
export const outsideAnonymousDebate = () =>
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

/** An archived agent is read-only: every write to it answers 409 agent.archived. */
export function requireActiveAgent(agent: { archivedAt: Date | null }) {
  if (agent.archivedAt) throw conflict("agent.archived", "This agent was archived");
}

/**
 * The writes under `/agents/:agentId` that stay open on an archived agent: each one only takes something away or
 * ends what is running (the archive itself, revoking its accounts, detaching or stopping its environment, closing
 * its browser, deleting a secret). Clearing the runner (`runnerId: null`) also stays open; that route decides by
 * its body, so it checks the archive itself.
 */
export const ARCHIVED_AGENT_WRITES_OPEN: readonly { method: string; path: RegExp }[] = [
  { method: "DELETE", path: /^$/ },
  { method: "POST", path: /^\/identity\/revoke$/ },
  { method: "DELETE", path: /^\/environment$/ },
  { method: "POST", path: /^\/environment\/stop$/ },
  { method: "PUT", path: /^\/environment\/target$/ },
  { method: "POST", path: /^\/browser\/stop$/ },
  { method: "DELETE", path: /^\/secrets\/[^/]+$/ },
];

const WRITES = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * An archived agent is read-only: every write under `/agents/:agentId` answers 409 agent.archived here, before the
 * route runs, except the ones listed above. A write that reaches an agent another way (a review, a proposal, a
 * request) checks it where it writes. The routes that recheck under a lock keep doing so.
 */
export function registerArchivedAgentGuard(app: Hono<AppEnv>) {
  app.use("/api/v1/workspaces/:workspaceId/agents/:agentId/*", async (c, next) => {
    if (!WRITES.has(c.req.method)) return next();
    const agentId = c.req.param("agentId");
    const rest = c.req.path.slice(c.req.path.indexOf(`/agents/${agentId}`) + `/agents/${agentId}`.length);
    if (ARCHIVED_AGENT_WRITES_OPEN.some((w) => w.method === c.req.method && w.path.test(rest))) return next();
    const member = c.get("member");
    if (!member || !agentId) return next();
    const [row] = await c
      .get("deps")
      .db.select({ archivedAt: agents.archivedAt })
      .from(agents)
      .where(and(eq(agents.workspaceId, member.workspaceId), eq(agents.id, agentId)));
    if (row) requireActiveAgent(row);
    return next();
  });
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

/** Who looks at an agent's channels: whoever manages agents sees every one, anyone else only those they read. */
export interface ChannelViewer {
  userId: string;
  seesAll: boolean;
}

export const channelViewer = (me: WorkspaceMember): ChannelViewer => ({
  userId: me.userId,
  seesAll: can(me.role, "manage_agents"),
});

/**
 * The condition on `channels` for the channels a viewer may see of an agent's: channels only (DMs stay out), and,
 * for a viewer who doesn't manage agents, the public ones and the private ones they belong to. A private channel
 * they are not a member of stays out: its id would name a channel whose runs answer them 404. Every route that
 * shows or changes an agent's channels (its memberships and its channel rules) uses this one rule.
 */
export function visibleAgentChannel(db: Db, viewer?: ChannelViewer) {
  return and(
    eq(channels.kind, "channel"),
    viewer && !viewer.seesAll
      ? or(
          eq(channels.visibility, "public"),
          inArray(
            channels.id,
            db
              .select({ id: channelMemberships.channelId })
              .from(channelMemberships)
              .where(
                and(
                  eq(channelMemberships.memberType, "person"),
                  eq(channelMemberships.memberId, viewer.userId),
                ),
              ),
          ),
        )
      : undefined,
  );
}

/** The agent's channels, as `visibleAgentChannel` lets the viewer see them (archived ones stay out). */
export async function agentChannels(db: Db, agentId: string, viewer?: ChannelViewer) {
  return db
    .select({ id: channelMemberships.channelId, autoAnswer: channelMemberships.autoAnswer })
    .from(channelMemberships)
    .innerJoin(channels, eq(channels.id, channelMemberships.channelId))
    .where(
      and(
        eq(channelMemberships.memberType, "agent"),
        eq(channelMemberships.memberId, agentId),
        isNull(channels.archivedAt),
        visibleAgentChannel(db, viewer),
      ),
    );
}

export async function toAgentDetail(
  db: Db,
  row: AgentRow,
  input: { viewer: ChannelViewer; seesUsage: boolean; busy: boolean; testModel: boolean; now: Date },
): Promise<AgentDetail> {
  return {
    ...toAgent(await withPlanOwner(db, row), input.viewer.userId, input.busy, input.testModel),
    ...(input.seesUsage ? await spendOf(db, row, input.now) : NO_SPEND),
    budgetInherited: row.budgetPerMonthUsd === null,
    credentialId: row.credentialId,
    channels: await agentChannels(db, row.id, input.viewer),
    // Pending requests the viewer may see, as the approvals list shows them: whoever decides them (the agent's
    // owner, or someone who manages agents once the owner left) sees all of them, anyone else only those of
    // conversations they read (and the ones asked outside any conversation).
    queuedApprovals: (
      await db
        .select({ id: schema.approvals.id })
        .from(schema.approvals)
        .where(
          and(
            eq(schema.approvals.agentId, row.id),
            eq(schema.approvals.status, "pending"),
            (await decidesFor(db, row, input.viewer))
              ? undefined
              : sql`(${schema.approvals.channelId} is null or ${schema.approvals.channelId} in ${readableChannelsSql({ workspaceId: row.workspaceId, userId: input.viewer.userId })})`,
          ),
        )
    ).length,
  };
}

type Spend = Pick<
  AgentDetail,
  | "budgetSpentPct"
  | "budgetPerMonthUsd"
  | "inheritedBudgetUsd"
  | "monthRuns"
  | "monthTokens"
  | "costThisMonthUsd"
>;

/** Spend and budget are shown under `view_usage`, as GET /usage: whoever doesn't have it gets nulls. */
const NO_SPEND: Spend = {
  budgetSpentPct: null,
  budgetPerMonthUsd: null,
  inheritedBudgetUsd: null,
  monthRuns: null,
  monthTokens: null,
  costThisMonthUsd: null,
};

async function spendOf(db: Db, row: AgentRow, now: Date): Promise<Spend> {
  const workspace = await workspaceBudgetDefaults(db, row.workspaceId);
  const usage = (await monthUsage(db, [row.id], now)).get(row.id) ?? { runs: 0, tokens: 0, costUsd: 0 };
  const budget = budgetOf(row, workspace.defaultBudget);
  return {
    budgetSpentPct: budget > 0 ? Math.min(999, Math.round((usage.costUsd / budget) * 100)) : 100,
    budgetPerMonthUsd: budget,
    inheritedBudgetUsd: workspace.defaultBudget,
    monthRuns: usage.runs,
    monthTokens: usage.tokens,
    costThisMonthUsd: usage.costUsd,
  };
}

/** The viewer decides the agent's approvals: its owner, or someone who manages agents once the owner left. */
async function decidesFor(db: Db, row: AgentRow, viewer: ChannelViewer): Promise<boolean> {
  if (row.ownerUserId === viewer.userId) return true;
  if (!viewer.seesAll) return false;
  const [owner] = await db
    .select({ userId: schema.members.userId })
    .from(schema.members)
    .where(and(eq(schema.members.workspaceId, row.workspaceId), eq(schema.members.userId, row.ownerUserId)));
  return owner === undefined;
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
