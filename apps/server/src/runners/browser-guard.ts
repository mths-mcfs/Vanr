// Rules of each agent's browser and the per-step log.
//
// The policy goes to the runner with every browser operation: the agent always operates as "agent", and only
// the input of whoever took control goes as "person". The runner applies it before every load and every
// action (apps/runner/src/cdp.ts); the server only builds the policy from the settings.
//
// The log keeps each step of the agent in the browser: time, tool, what it asked for, URL, result and the
// page thumbnail. The table only grows (a database trigger) and the thumbnail stays in the server's blobs,
// outside the Drive: no agent tool reaches it.
import type { AgentBrowserSettings, BrowserLevel, BrowserLogEntry, SiteRule } from "@vanr/contract";
import { type BrowserDriver, type BrowserPolicy, DEFAULT_BROWSER_LEVEL } from "@vanr/engine/browser-policy";
import { type Db, schema } from "@vanr/engine/db";
import { newId } from "@vanr/engine/ids";
import type { BlockedLoad } from "@vanr/engine/runner-protocol";
import { and, desc, eq, inArray, lt, or } from "drizzle-orm";
import type { AppDeps } from "../context";
import { log } from "../logger";

const { agents, browserPolicies, browserInterventions, browserLogEntries } = schema;

type BrowserSettingsRow = typeof browserPolicies.$inferSelect;
type BrowserLogEntryRow = typeof browserLogEntries.$inferSelect;

export async function browserSettingsOf(db: Db, agentId: string): Promise<BrowserSettingsRow | undefined> {
  const [row] = await db.select().from(browserPolicies).where(eq(browserPolicies.agentId, agentId));
  return row;
}

/** A row without a level is from before it: a filled list meant "only these sites". */
export function levelOf(row: BrowserSettingsRow | undefined): BrowserLevel {
  return row?.level ?? (row && row.permittedDomains.length > 0 ? "strict" : DEFAULT_BROWSER_LEVEL);
}

function sitesOf(row: BrowserSettingsRow | undefined): SiteRule[] {
  return [
    ...(row?.permittedDomains ?? []).map((pattern) => ({ pattern, access: "write" as const })),
    ...(row?.readDomains ?? []).map((pattern) => ({ pattern, access: "read" as const })),
  ];
}

export function toBrowserSettings(row: BrowserSettingsRow | undefined): AgentBrowserSettings {
  return {
    permittedDomains: row?.permittedDomains ?? [],
    level: levelOf(row),
    sites: sitesOf(row),
    privateRanges: row?.privateRanges ?? [],
    privateRangesRunnerId: row?.privateRangesRunnerId ?? null,
  };
}

/** The agent's open browser request (at most one). */
export async function openIntervention(db: Db, agentId: string) {
  const [h] = await db
    .select()
    .from(browserInterventions)
    .where(
      and(
        eq(browserInterventions.agentId, agentId),
        inArray(browserInterventions.status, ["pending", "active"]),
      ),
    );
  return h ?? null;
}

/** Who drives the browser now: the person who took over (active request) or the agent. */
export async function driverOf(db: Db, agentId: string): Promise<BrowserDriver> {
  return (await openIntervention(db, agentId))?.status === "active" ? "person" : "agent";
}

/** The agent's policy on runner `runnerId`. A private range only holds on the runner where it was allowed. */
export async function policyFor(
  deps: Pick<AppDeps, "db">,
  agentId: string,
  runnerId: string,
  driver: BrowserDriver,
): Promise<BrowserPolicy> {
  const row = await browserSettingsOf(deps.db, agentId);
  return {
    driver,
    level: levelOf(row),
    sites: sitesOf(row),
    privateRanges: row && row.privateRangesRunnerId === runnerId ? row.privateRanges : [],
  };
}

/**
 * Sends the current policy to the agent's open Chrome: the driver changed or the lists changed. With no
 * runner online, nothing (the next operation already carries the new policy).
 */
export async function pushPolicy(deps: AppDeps, agentId: string) {
  const [agent] = await deps.db
    .select({ handle: agents.handle, environmentId: agents.environmentId })
    .from(agents)
    .where(eq(agents.id, agentId));
  if (!agent?.environmentId || !deps.runners.isOnline(agent.environmentId)) return;
  const policy = await policyFor(deps, agentId, agent.environmentId, await driverOf(deps.db, agentId));
  await deps.runners
    .call(
      agent.environmentId,
      "browser.policy",
      { policy },
      { agent: { id: agentId, handle: agent.handle }, timeoutMs: 10_000 },
    )
    .catch((err) => log.warn("browser.policy_push_failed", { err, agentId }));
}

// ---- per-step log ----

const STEP_TEXT_MAX = 500;

const clipValue = (v: unknown): unknown =>
  typeof v === "string" && v.length > STEP_TEXT_MAX ? `${v.slice(0, STEP_TEXT_MAX)}…` : v;

const stepShotKey = (workspaceId: string, agentId: string, stepId: string) =>
  `browser-log/${workspaceId}/${agentId}/${stepId}.jpg`;

interface StepInput {
  workspaceId: string;
  agentId: string;
  runnerId: string;
  runId: string | null;
  channelId: string | null;
  tool: string;
  /** What the tool asked for. Never carries a secret's value (the secret goes by name). */
  action: Record<string, unknown>;
  url: string | null;
  outcome: BrowserLogEntryRow["outcome"];
  message: string | null;
  blocked: BlockedLoad[];
  /** JPEG thumbnail in base64, from the runner. */
  shot?: string;
}

/** Records the step. A failure to record doesn't undo the action, which already happened: it stays in the server log. */
export async function recordStep(deps: AppDeps, input: StepInput): Promise<void> {
  const id = newId("bs");
  try {
    let shotKey: string | null = null;
    if (input.shot) {
      shotKey = stepShotKey(input.workspaceId, input.agentId, id);
      await deps.blobs.put(shotKey, new Uint8Array(Buffer.from(input.shot, "base64")), "image/jpeg");
    }
    await deps.db.insert(browserLogEntries).values({
      id,
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      runnerId: input.runnerId,
      runId: input.runId,
      channelId: input.channelId,
      tool: input.tool,
      action: Object.fromEntries(Object.entries(input.action).map(([k, v]) => [k, clipValue(v)])),
      url: input.url ? (clipValue(input.url) as string) : null,
      outcome: input.outcome,
      message: input.message ? (clipValue(input.message) as string) : null,
      blocked: input.blocked.slice(0, 10),
      shotKey,
      at: deps.now(),
    });
  } catch (err) {
    log.error("browser.step_record_failed", { err, agentId: input.agentId, tool: input.tool });
  }
}

export function toBrowserLogEntry(row: BrowserLogEntryRow): BrowserLogEntry {
  return {
    id: row.id,
    agentId: row.agentId,
    runId: row.runId,
    channelId: row.channelId,
    tool: row.tool,
    action: row.action,
    url: row.url,
    outcome: row.outcome,
    message: row.message,
    blocked: row.blocked,
    hasShot: !!row.shotKey,
    at: row.at.toISOString(),
  };
}

export const STEPS_PAGE_MAX = 100;

/** The agent's steps, newest to oldest (`before` = id of the last one on the previous page). */
export async function listSteps(
  db: Db,
  agentId: string,
  opts: { runId?: string; before?: string; limit: number },
): Promise<BrowserLogEntryRow[]> {
  const conds = [eq(browserLogEntries.agentId, agentId)];
  if (opts.runId) conds.push(eq(browserLogEntries.runId, opts.runId));
  if (opts.before) {
    const [ref] = await db
      .select({ at: browserLogEntries.at })
      .from(browserLogEntries)
      .where(and(eq(browserLogEntries.id, opts.before), eq(browserLogEntries.agentId, agentId)));
    // The same time (ms) with a smaller id also comes: the order is (time, id).
    const after =
      ref &&
      or(
        lt(browserLogEntries.at, ref.at),
        and(eq(browserLogEntries.at, ref.at), lt(browserLogEntries.id, opts.before)),
      );
    if (after) conds.push(after);
  }
  return db
    .select()
    .from(browserLogEntries)
    .where(and(...conds))
    .orderBy(desc(browserLogEntries.at), desc(browserLogEntries.id))
    .limit(Math.min(opts.limit, STEPS_PAGE_MAX));
}
