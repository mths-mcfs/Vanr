// Rules of the paired runners: the API format, who manages them, which agents use each one and the
// workspace events that notify the screens.
import type { AgentEnvironment, EnvironmentTarget, Job, Runner } from "@vanr/contract";
import { can, type Role } from "@vanr/contract";
import { type Db, schema } from "@vanr/engine/db";
import { createSealer } from "@vanr/engine/seal";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { AppDeps } from "../context";
import { HttpError } from "../http";

const { runners, agents, agentEnvironments, users, runnerJobs, sandboxPolicies } = schema;

export type RunnerRow = typeof runners.$inferSelect;
export type JobRow = typeof runnerJobs.$inferSelect;

export const runnerSealer = (deps: AppDeps) => createSealer(deps.config.authSecret, "runners");

export interface Viewer {
  userId: string;
  role: Role;
}

/** Whoever paired the runner manages it; whoever configures the workspace too. */
export const canManageRunner = (viewer: Viewer, row: RunnerRow) =>
  row.pairedByUserId === viewer.userId || can(viewer.role, "configure");

/** Using the runner as an agent's environment: whoever administers agents, or whoever paired it. */
export const canUseRunner = (viewer: Viewer, row: RunnerRow) =>
  row.pairedByUserId === viewer.userId || can(viewer.role, "manage_agents");

export async function runnerInWorkspace(db: Db, workspaceId: string, id: string): Promise<RunnerRow> {
  const [row] = await db
    .select()
    .from(runners)
    .where(and(eq(runners.id, id), eq(runners.workspaceId, workspaceId), isNull(runners.removedAt)));
  if (!row) throw new HttpError(404, "runner.not_found", "Runner not found");
  return row;
}

export async function agentsUsing(db: Db, runnerIds: string[]) {
  if (runnerIds.length === 0) return [];
  return db
    .select({ id: agents.id, handle: agents.handle, name: agents.name, runnerId: agents.environmentId })
    .from(agents)
    .where(and(inArray(agents.environmentId, runnerIds), isNull(agents.archivedAt)));
}

export async function toRunners(deps: AppDeps, rows: RunnerRow[], viewer: Viewer): Promise<Runner[]> {
  const using = await agentsUsing(
    deps.db,
    rows.map((r) => r.id),
  );
  const pairers = rows.length
    ? await deps.db
        .select({ id: users.id, name: users.name })
        .from(users)
        .where(
          inArray(
            users.id,
            rows.map((r) => r.pairedByUserId),
          ),
        )
    : [];
  const names = new Map(pairers.map((p) => [p.id, p.name]));
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    os: r.os,
    arch: r.arch,
    hostname: r.hostname,
    runnerRelease: r.runnerRelease,
    online: deps.runners.isOnline(r.id),
    lastOnlineAt: r.lastOnlineAt?.toISOString() ?? null,
    paused: r.paused,
    access: r.access,
    agents: using.filter((a) => a.runnerId === r.id).map((a) => a.id),
    manageable: canManageRunner(viewer, r),
    pairedByName: names.get(r.pairedByUserId) ?? "",
    pairedByUserId: r.pairedByUserId,
    shellAllowed: r.access.tools.commands,
    workDir: r.workDir,
    browser: r.browser && r.access.tools.browser,
    executors: r.executors.filter((e) =>
      e === "claude_code" ? r.access.tools.claude : r.access.tools.codex,
    ),
    cli: r.cli,
    sandbox: r.sandbox ?? null,
    credentialRotatedAt: r.credentialRotatedAt?.toISOString() ?? null,
    revokedAt: r.revokedAt?.toISOString() ?? null,
    revokedReason: r.revokedReason ?? null,
    createdAt: r.createdAt.toISOString(),
  }));
}

export async function toRunner(deps: AppDeps, row: RunnerRow, viewer: Viewer): Promise<Runner> {
  const [m] = await toRunners(deps, [row], viewer);
  return m as Runner;
}

/** Sends the runner the list of agents that use it (the CLI finds an agent by its handle). */
export async function pushAgents(deps: AppDeps, runnerId: string) {
  if (!deps.runners.isOnline(runnerId)) return;
  const list = await agentsUsing(deps.db, [runnerId]);
  deps.runners.send(runnerId, {
    type: "agents",
    agents: list.map((a) => ({ id: a.id, handle: a.handle, name: a.name })),
  });
}

export async function targetOf(deps: AppDeps, runnerId: string | null): Promise<EnvironmentTarget | null> {
  if (!runnerId) return null;
  const [m] = await deps.db
    .select({ id: runners.id, name: runners.name })
    .from(runners)
    .where(and(eq(runners.id, runnerId), isNull(runners.removedAt)));
  if (!m) return null;
  return { kind: "runner", runnerId: m.id, name: m.name, online: deps.runners.isOnline(m.id) };
}

export async function environmentOf(deps: AppDeps, agentId: string): Promise<AgentEnvironment> {
  const [agent] = await deps.db
    .select({ environmentId: agents.environmentId, workspaceId: agents.workspaceId })
    .from(agents)
    .where(eq(agents.id, agentId));
  const [state] = await deps.db
    .select()
    .from(agentEnvironments)
    .where(eq(agentEnvironments.agentId, agentId));
  const [settings] = agent?.workspaceId
    ? await deps.db
        .select({ network: sandboxPolicies.network })
        .from(sandboxPolicies)
        .where(eq(sandboxPolicies.workspaceId, agent.workspaceId))
    : [];
  const target = await targetOf(deps, agent?.environmentId ?? null);
  return {
    status: target ? (state?.status ?? "stopped") : "none",
    target,
    storageGib: 0,
    lastUsedAt: state?.lastUsedAt?.toISOString() ?? null,
    network: settings?.network ?? "allowlist",
  };
}

export async function emitEnvironment(deps: AppDeps, workspaceId: string, agentId: string) {
  deps.hub.toWorkspace(workspaceId, {
    type: "environment.updated",
    agentId,
    environment: await environmentOf(deps, agentId),
  });
}

export function toJob(row: JobRow): Job {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    assignmentId: row.assignmentId,
    resumedJobId: row.resumedJobId,
    threadId: row.threadId,
    agentId: row.agentId,
    runnerId: row.runnerId,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    endedAt: row.endedAt?.toISOString() ?? null,
    lastSignalAt: row.lastSignalAt?.toISOString() ?? null,
    tailLine: row.tailLine,
    seconds:
      row.startedAt && row.endedAt
        ? Math.round((row.endedAt.getTime() - row.startedAt.getTime()) / 1000)
        : null,
    prUrl: row.prUrl,
    branch: row.branch,
    files: row.files,
    exitCode: row.exitCode,
  };
}
