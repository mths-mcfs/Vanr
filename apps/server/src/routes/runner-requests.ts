// An agent's secrets and browser: the person delivers the sealed secret (the server only relays the box to the
// runner), lists and deletes them; sets the allowed sites; answers a browser intervention, takes the control
// or stops the browser.
import { type AgentSecret, isSealedBox, SECRET_MAX_BYTES } from "@vanr/contract";
import {
  BROWSER_LEVELS,
  checkRanges,
  PRIVATE_RANGES_MAX,
  SITE_PATTERN,
  SITES_MAX,
  siteRule,
} from "@vanr/engine/browser-policy";
import { type Db, schema } from "@vanr/engine/db";
import { newId } from "@vanr/engine/ids";
import { and, eq, gt, inArray, lte, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { z } from "zod";
import { type AgentRow, agentInWorkspace, requireActiveAgent, requireAgentEditor } from "../agents";
import type { AppDeps, AppEnv, WorkspaceMember } from "../context";
import { conflict, forbidden, HttpError, notFound, param, readJson, readQuery } from "../http";
import {
  browserSettingsOf,
  listSteps,
  pushPolicy,
  STEPS_PAGE_MAX,
  toBrowserLogEntry,
  toBrowserSettings,
} from "../runners/browser-guard";
import { RunnerCallError } from "../runners/hub";
import { withPlanOwner } from "../runners/plans";
import {
  expireRunnerRequests,
  INTERVENTION_TTL_MS,
  type InterventionRow,
  interventionSession,
  moveIntervention,
  publishIntervention,
  publishSecret,
  secretTarget,
  toIntervention,
  toSecretRequest,
} from "../runners/requests";
import { canManageRunner, canUseRunner } from "../runners/runners";
import { canTalkTo } from "../runtime/route";
import { requireMember, WORKSPACE } from "../workspace-scope";
import { runnerError } from "./runners";

const {
  secretPrompts,
  runnerSecrets,
  browserPolicies,
  browserInterventions,
  browserLogEntries,
  runners,
  agents,
  runs,
} = schema;

/**
 * The agent's browser policy is read and written under the agent's lock: two changes at once (the sites, the
 * level and private ranges) apply one after the other, each on the row as the other left it.
 */
/** A browser policy write: one at a time per agent, and none once the agent is archived (read under its row lock). */
const underAgentPolicyLock = <T>(deps: AppDeps, agentId: string, fn: (tx: Db) => Promise<T>) =>
  deps.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`browser-policy:${agentId}`}, 0))`);
    const [agent] = await tx.select().from(agents).where(eq(agents.id, agentId)).for("share");
    if (!agent) throw notFound("Agent not found");
    requireActiveAgent(agent);
    return fn(tx);
  });

const isEditor = (me: WorkspaceMember, agent: AgentRow) => {
  try {
    requireAgentEditor(me, agent);
    return true;
  } catch {
    return false;
  }
};

async function interventionIn(
  deps: AppDeps,
  me: WorkspaceMember,
  id: string,
): Promise<{ row: InterventionRow; agent: AgentRow }> {
  let [row] = await deps.db
    .select()
    .from(browserInterventions)
    .where(and(eq(browserInterventions.id, id), eq(browserInterventions.workspaceId, me.workspaceId)));
  if (!row) throw notFound("Browser request not found");
  const agent = await agentInWorkspace(deps.db, me.workspaceId, row.agentId);
  if (!canTalkTo(await withPlanOwner(deps.db, agent), me.userId)) throw notFound("Browser request not found");
  if ((row.status === "pending" || row.status === "active") && row.expiresAt <= deps.now()) {
    await expireRunnerRequests(deps, agent.id);
    [row] = await deps.db.select().from(browserInterventions).where(eq(browserInterventions.id, id));
    if (!row) throw notFound("Browser request not found");
  }
  return { row, agent };
}

/** A runner call whose answer never came: the runner may have done it. */
const UNSURE: ReadonlySet<string> = new Set(["offline", "timeout", "canceled"]);
const runnerOffline = () => conflict("runner.offline", "The runner is offline");
const closed = () => conflict("browser.intervention_closed", "This request is already finished");
const inControl = () => conflict("browser.in_control", "Someone else has control");
/** A closed secret request: an expired one has its own code so the page doesn't say "someone answered". */
const secretClosed = (status: string) =>
  status === "expired"
    ? conflict("secret_request.expired", "This request expired")
    : conflict("secret.closed", "This request is no longer open");

export function registerRunnerRequests(app: Hono<AppEnv>) {
  // ---- secrets ----

  app.post(`${WORKSPACE}/secret-requests/:secretRequestId/deliver`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const { box } = await readJson(c, z.object({ box: z.unknown() }));
    if (!isSealedBox(box))
      throw new HttpError(400, "invalid_request", "Malformed sealed value", { field: "box" });
    // The box carries the ciphertext in base64 plus the AES-GCM tag.
    if (Math.floor((box.ct.length * 3) / 4) > SECRET_MAX_BYTES + 64)
      throw new HttpError(413, "secret.exceeds_limit", "Secrets can have up to 16 KB");
    const [row] = await deps.db
      .select()
      .from(secretPrompts)
      .where(
        and(eq(secretPrompts.id, param(c, "secretRequestId")), eq(secretPrompts.workspaceId, me.workspaceId)),
      );
    if (!row) throw notFound("Secret request not found");
    const authorized = deps.runners.authorization(row.runnerId, row.agentId);
    const agent = await agentInWorkspace(deps.db, me.workspaceId, row.agentId);
    if (!canTalkTo(await withPlanOwner(deps.db, agent), me.userId))
      throw notFound("Secret request not found");
    if (row.targetUserId && row.targetUserId !== me.userId)
      throw forbidden("This request is for someone else");
    if (row.status !== "pending") throw secretClosed(row.status);
    if (row.expiresAt <= deps.now()) {
      const [expired] = await deps.db
        .update(secretPrompts)
        .set({ status: "expired" })
        .where(and(eq(secretPrompts.id, row.id), eq(secretPrompts.status, "pending")))
        .returning();
      if (expired) await publishSecret(deps, expired, "secret_request.updated");
      throw secretClosed("expired");
    }
    if (!deps.runners.isOnline(row.runnerId)) throw runnerOffline();
    // The database decides first: one statement takes the request out of `pending` (a decline, or another
    // attempt to deliver, that lost gets `secret.closed`), and the secret's row is written with it, so a secret on the
    // runner's disk always has its row. Only the winner sends the box to the runner.
    const at = deps.now();
    const key = and(
      eq(runnerSecrets.agentId, agent.id),
      eq(runnerSecrets.runnerId, row.runnerId),
      eq(runnerSecrets.name, row.name),
    );
    const won = await deps.db.transaction(async (tx) => {
      const [runner] = await tx.select().from(runners).where(eq(runners.id, row.runnerId)).for("share");
      const [current] = await tx.select().from(agents).where(eq(agents.id, agent.id)).for("share");
      if (
        !runner ||
        runner.removedAt ||
        runner.revokedAt ||
        current?.environmentId !== row.runnerId ||
        !authorized()
      )
        throw secretClosed("canceled");
      const [taken] = await tx
        .update(secretPrompts)
        .set({ status: "delivered", fulfilledAt: at, decidedBy: me.userId })
        .where(
          and(
            eq(secretPrompts.id, row.id),
            eq(secretPrompts.status, "pending"),
            gt(secretPrompts.expiresAt, deps.now()),
          ),
        )
        .returning();
      if (!taken) return null;
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`secret:${row.runnerId}:${agent.id}:${row.name}`}, 0))`,
      );
      const [previous] = await tx.select().from(runnerSecrets).where(key);
      const revision = new Date(Math.max(at.getTime(), (previous?.updatedAt.getTime() ?? 0) + 1));
      const values = {
        target: row.target,
        filePath: row.filePath,
        browser: row.browser,
        deliveredBy: me.userId,
        updatedAt: revision,
      };
      await tx
        .insert(runnerSecrets)
        .values({
          agentId: agent.id,
          runnerId: row.runnerId,
          name: row.name,
          workspaceId: me.workspaceId,
          ...values,
        })
        .onConflictDoUpdate({
          target: [runnerSecrets.agentId, runnerSecrets.runnerId, runnerSecrets.name],
          set: values,
        });
      return { next: taken, previous: previous ?? null, revision };
    });
    if (!won) {
      const [now] = await deps.db
        .select({ status: secretPrompts.status })
        .from(secretPrompts)
        .where(eq(secretPrompts.id, row.id));
      throw secretClosed(now?.status ?? "pending");
    }
    const { next, previous, revision } = won;
    try {
      await deps.runners.call(
        row.runnerId,
        "secret.store",
        {
          requestId: row.id,
          workspaceId: row.workspaceId,
          name: row.name,
          target: secretTarget(row),
          browser: row.browser ?? null,
          box,
        },
        { agent: { id: agent.id, handle: agent.handle }, timeoutMs: 20_000, authorized },
      );
    } catch (err) {
      // The runner didn't store it: the request can be answered again. When the runner answered with an error
      // nothing was stored and the secret's row goes back to what it was; when the answer never came (no
      // answer in time, the connection dropped on the way) the value may be on the disk, so the row stays and
      // the secret can still be listed and deleted.
      const notStored = err instanceof RunnerCallError && !UNSURE.has(err.code);
      const reopened = await deps.db.transaction(async (tx) => {
        const [runner] = await tx.select().from(runners).where(eq(runners.id, row.runnerId)).for("share");
        const [current] = await tx.select().from(agents).where(eq(agents.id, agent.id)).for("share");
        const status =
          current?.environmentId === row.runnerId && runner && !runner.revokedAt && !runner.removedAt
            ? "pending"
            : "canceled";
        const [reopened] = await tx
          .update(secretPrompts)
          .set({ status, fulfilledAt: null, decidedBy: null })
          .where(and(eq(secretPrompts.id, row.id), eq(secretPrompts.status, "delivered")))
          .returning();
        if (!notStored) return reopened;
        const ownRevision = and(key, eq(runnerSecrets.updatedAt, revision));
        if (previous) await tx.update(runnerSecrets).set(previous).where(ownRevision);
        else await tx.delete(runnerSecrets).where(ownRevision);
        return reopened;
      });
      if (reopened?.status === "canceled") await publishSecret(deps, reopened, "secret_request.updated");
      runnerError(err);
    }
    await publishSecret(deps, next, "secret_request.updated");
    return c.json(toSecretRequest(next));
  });

  app.post(`${WORKSPACE}/secret-requests/:secretRequestId/decline`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const [row] = await deps.db
      .select()
      .from(secretPrompts)
      .where(
        and(eq(secretPrompts.id, param(c, "secretRequestId")), eq(secretPrompts.workspaceId, me.workspaceId)),
      );
    if (!row) throw notFound("Secret request not found");
    const agent = await agentInWorkspace(deps.db, me.workspaceId, row.agentId);
    if (!canTalkTo(await withPlanOwner(deps.db, agent), me.userId))
      throw notFound("Secret request not found");
    if (row.targetUserId && row.targetUserId !== me.userId && !isEditor(me, agent))
      throw forbidden("This request is for someone else");
    const [next] = await deps.db
      .update(secretPrompts)
      .set({ status: "declined", decidedBy: me.userId })
      .where(and(eq(secretPrompts.id, row.id), eq(secretPrompts.status, "pending")))
      .returning();
    if (!next) throw secretClosed(row.status);
    await publishSecret(deps, next, "secret_request.updated");
    return c.json(toSecretRequest(next));
  });

  app.get(`${WORKSPACE}/agents/:agentId/secrets`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const agent = await agentInWorkspace(deps.db, me.workspaceId, param(c, "agentId"));
    const rows = await deps.db
      .select()
      .from(runnerSecrets)
      .where(eq(runnerSecrets.agentId, agent.id))
      .orderBy(runnerSecrets.name);
    const secrets: AgentSecret[] = rows.map((r) => ({
      name: r.name,
      runnerId: r.runnerId,
      target: r.target === "env" ? { kind: "env" } : { kind: "file", path: r.filePath ?? "" },
      browser: r.browser ?? null,
      fulfilledByUserId: r.deliveredBy ?? "",
      fulfilledAt: r.updatedAt.toISOString(),
    }));
    return c.json({ secrets });
  });

  app.delete(`${WORKSPACE}/agents/:agentId/secrets/:secretId`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const agent = await agentInWorkspace(deps.db, me.workspaceId, param(c, "agentId"));
    const { runnerId } = readQuery(c, z.object({ runnerId: z.string().min(1).max(64) }));
    // The secret is keyed by its name on the agent and the runner.
    const name = param(c, "secretId");
    const [runner] = await deps.db
      .select()
      .from(runners)
      .where(and(eq(runners.id, runnerId), eq(runners.workspaceId, me.workspaceId)));
    // Who edits the agent deletes it; so does who paired the runner (it is their disk).
    if (!isEditor(me, agent) && !(runner && canManageRunner(me, runner))) throw forbidden();
    const key = and(
      eq(runnerSecrets.agentId, agent.id),
      eq(runnerSecrets.runnerId, runnerId),
      eq(runnerSecrets.name, name),
    );
    const [row] = await deps.db.select().from(runnerSecrets).where(key);
    if (!row) throw notFound("Secret not found");
    if (runner && !runner.removedAt) {
      await deps.runners
        .call(
          runnerId,
          "secret.remove",
          { name },
          { agent: { id: agent.id, handle: agent.handle }, timeoutMs: 15_000 },
        )
        .catch((err) => {
          if (err instanceof RunnerCallError && err.code === "not_found") return;
          runnerError(err);
        });
    }
    await deps.db.delete(runnerSecrets).where(key);
    return c.body(null, 204);
  });

  // ---- browser ----

  app.get(`${WORKSPACE}/agents/:agentId/browser`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const agent = await agentInWorkspace(deps.db, me.workspaceId, param(c, "agentId"));
    return c.json(toBrowserSettings(await browserSettingsOf(deps.db, agent.id)));
  });

  /** Read-and-write sites (the list from before the level). Takes the ones that come in here off the read list. */
  app.put(`${WORKSPACE}/agents/:agentId/browser`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const agent = await agentInWorkspace(deps.db, me.workspaceId, param(c, "agentId"));
    requireAgentEditor(me, agent);
    requireActiveAgent(agent);
    const { permittedDomains } = await readJson(
      c,
      z.object({
        permittedDomains: z
          .array(
            z
              .string()
              .trim()
              .toLowerCase()
              .regex(SITE_PATTERN, "Use a domain like example.com or *.example.com"),
          )
          .max(SITES_MAX),
      }),
    );
    const unique = [...new Set(permittedDomains)];
    // The read list kept comes from the row as it is now: two changes at once apply one after the other.
    const row = await underAgentPolicyLock(deps, agent.id, async (tx) => {
      const before = await browserSettingsOf(tx, agent.id);
      const readDomains = (before?.readDomains ?? []).filter((d) => !unique.includes(d));
      const [saved] = await tx
        .insert(browserPolicies)
        .values({ agentId: agent.id, workspaceId: me.workspaceId, permittedDomains: unique, readDomains })
        .onConflictDoUpdate({
          target: browserPolicies.agentId,
          set: { permittedDomains: unique, readDomains, updatedAt: deps.now() },
        })
        .returning();
      return saved;
    });
    await pushPolicy(deps, agent.id);
    return c.json(toBrowserSettings(row));
  });

  /**
   * Level, sites with access and private network ranges. Level and sites: who edits the agent. Private ranges
   * open the home or company network to the agent: only who administers the workspace or paired the agent's
   * runner, and they only hold on that runner.
   */
  app.put(`${WORKSPACE}/agents/:agentId/browser/policy`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const agent = await agentInWorkspace(deps.db, me.workspaceId, param(c, "agentId"));
    requireAgentEditor(me, agent);
    requireActiveAgent(agent);
    const body = await readJson(
      c,
      z.object({
        level: z.enum(BROWSER_LEVELS),
        sites: z.array(siteRule).max(SITES_MAX * 2),
        privateRanges: z.array(z.string().trim().max(64)).max(PRIVATE_RANGES_MAX).optional(),
      }),
    );
    // The same site on both lists: write wins.
    const write = [...new Set(body.sites.filter((r) => r.access === "write").map((r) => r.pattern))];
    const read = [...new Set(body.sites.filter((r) => r.access === "read").map((r) => r.pattern))].filter(
      (d) => !write.includes(d),
    );
    if (write.length > SITES_MAX || read.length > SITES_MAX)
      throw new HttpError(400, "invalid_request", `Up to ${SITES_MAX} sites in each list`, {
        field: "sites",
      });
    const row = await underAgentPolicyLock(deps, agent.id, async (tx) => {
      const before = await browserSettingsOf(tx, agent.id);
      let ranges = {
        privateRanges: before?.privateRanges ?? [],
        privateRangesRunnerId: before?.privateRangesRunnerId ?? null,
      };
      if (body.privateRanges) {
        const list = [...new Set(body.privateRanges)];
        const checked = checkRanges(list);
        if (!checked.ok)
          throw new HttpError(400, "browser.bad_range", `Not a private network range: ${checked.bad}`, {
            field: "privateRanges",
          });
        const runnerId = list.length > 0 ? agent.environmentId : null;
        const changed =
          JSON.stringify(list) !== JSON.stringify(ranges.privateRanges) ||
          runnerId !== ranges.privateRangesRunnerId;
        if (changed) {
          if (list.length > 0 && !runnerId)
            throw conflict("browser.no_environment", "This agent has no runner");
          // Closing needs no special permission; opening or changing does (on the current runner).
          if (list.length > 0) {
            const [runner] = await tx
              .select()
              .from(runners)
              .where(and(eq(runners.id, runnerId as string), eq(runners.workspaceId, me.workspaceId)));
            if (!runner || !canManageRunner(me, runner))
              throw forbidden(
                "Only an admin or the person who paired this runner can open its private network",
              );
          }
          ranges = { privateRanges: list, privateRangesRunnerId: runnerId };
        }
      }
      const [saved] = await tx
        .insert(browserPolicies)
        .values({
          agentId: agent.id,
          workspaceId: me.workspaceId,
          permittedDomains: write,
          readDomains: read,
          level: body.level,
          ...ranges,
        })
        .onConflictDoUpdate({
          target: browserPolicies.agentId,
          set: {
            permittedDomains: write,
            readDomains: read,
            level: body.level,
            ...ranges,
            updatedAt: deps.now(),
          },
        })
        .returning();
      return saved;
    });
    await pushPolicy(deps, agent.id);
    return c.json(toBrowserSettings(row));
  });

  // The browser log: read only. No route edits or deletes a step.
  const canSeeLog = async (deps: AppDeps, me: WorkspaceMember, agent: AgentRow) =>
    isEditor(me, agent) || canTalkTo(await withPlanOwner(deps.db, agent), me.userId);

  app.get(`${WORKSPACE}/agents/:agentId/browser/log`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const agent = await agentInWorkspace(deps.db, me.workspaceId, param(c, "agentId"));
    if (!(await canSeeLog(deps, me, agent))) throw forbidden();
    const q = readQuery(
      c,
      z.object({
        runId: z.string().max(64).optional(),
        before: z.string().max(64).optional(),
        limit: z.coerce.number().int().min(1).max(STEPS_PAGE_MAX).default(50),
      }),
    );
    const rows = await listSteps(deps.db, agent.id, q);
    return c.json({ entries: rows.map(toBrowserLogEntry) });
  });

  app.get(`${WORKSPACE}/agents/:agentId/browser/log/:entryId/shot`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const agent = await agentInWorkspace(deps.db, me.workspaceId, param(c, "agentId"));
    if (!(await canSeeLog(deps, me, agent))) throw forbidden();
    const [row] = await deps.db
      .select({ shotKey: browserLogEntries.shotKey })
      .from(browserLogEntries)
      .where(and(eq(browserLogEntries.id, param(c, "entryId")), eq(browserLogEntries.agentId, agent.id)));
    const blob = row?.shotKey ? await deps.blobs.get(row.shotKey) : null;
    if (!blob) throw notFound("No screenshot for this step");
    return c.body(blob.bytes as Uint8Array<ArrayBuffer>, 200, {
      "content-type": "image/jpeg",
      "cache-control": "private, max-age=86400, immutable",
    });
  });

  app.get(`${WORKSPACE}/agents/:agentId/browser/interventions`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const agent = await agentInWorkspace(deps.db, me.workspaceId, param(c, "agentId"));
    if (!canTalkTo(await withPlanOwner(deps.db, agent), me.userId)) return c.json({ intervention: null });
    const [row] = await deps.db
      .select()
      .from(browserInterventions)
      .where(
        and(
          eq(browserInterventions.agentId, agent.id),
          inArray(browserInterventions.status, ["pending", "active"]),
        ),
      )
      .orderBy(browserInterventions.createdAt)
      .limit(1);
    return c.json({ intervention: row ? toIntervention(row) : null });
  });

  app.get(`${WORKSPACE}/browser-interventions/:interventionId`, async (c) => {
    const me = requireMember(c);
    const { row } = await interventionIn(c.get("deps"), me, param(c, "interventionId"));
    return c.json(toIntervention(row));
  });

  app.post(`${WORKSPACE}/browser-interventions/:interventionId/control`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const { row } = await interventionIn(deps, me, param(c, "interventionId"));
    if (row.targetUserId && row.targetUserId !== me.userId)
      throw forbidden("This request is for someone else");
    if (
      row.status === "active" &&
      row.controllingUserId === me.userId &&
      interventionSession(deps, row.id) === c.get("sessionId")
    )
      return c.json(toIntervention(row));
    // Someone else took over first: the same code as who tries through the runner, not "finished".
    if (row.status === "active") throw inControl();
    if (row.status !== "pending") throw closed();
    // Taking a request is driving the browser, as /start: only whoever may use the intervention's runner.
    const [runner] = await deps.db.select().from(runners).where(eq(runners.id, row.runnerId));
    if (!runner || runner.removedAt) throw conflict("browser.no_environment", "This agent has no runner");
    if (!canUseRunner(me, runner)) throw forbidden("Only who paired this runner can use it");
    if (!deps.runners.isOnline(row.runnerId)) throw conflict("runner.offline", "The runner is offline");
    const next = await moveIntervention(
      deps,
      row.id,
      ["pending"],
      {
        status: "active",
        controllingUserId: me.userId,
      },
      { sessionId: c.get("sessionId") ?? undefined },
    );
    if (!next) {
      const [now] = await deps.db
        .select()
        .from(browserInterventions)
        .where(eq(browserInterventions.id, row.id));
      throw now?.status === "active" ? inControl() : closed();
    }
    return c.json(toIntervention(next));
  });

  // The person ends the intervention: `complete` closes it as done, `fail` as failed (with an optional note).
  const finish = (status: "done" | "failed", path: "complete" | "fail") =>
    app.post(`${WORKSPACE}/browser-interventions/:interventionId/${path}`, async (c) => {
      const me = requireMember(c);
      const deps = c.get("deps");
      const { row } = await interventionIn(deps, me, param(c, "interventionId"));
      const note =
        status === "failed"
          ? (await readJson(c, z.object({ note: z.string().trim().max(500).optional() }))).note
          : undefined;
      if (row.status !== "pending" && row.status !== "active") throw closed();
      const mine =
        row.controllingUserId === me.userId ||
        (!row.controllingUserId && (!row.targetUserId || row.targetUserId === me.userId));
      if (!mine) throw forbidden("Someone else has control");
      const next = await moveIntervention(
        deps,
        row.id,
        [row.status],
        {
          status,
          note: note ?? null,
          handledAt: deps.now(),
        },
        row.status === "active" ? { controller: me.userId } : {},
      );
      if (!next) throw closed();
      return c.json(toIntervention(next));
    });
  finish("done", "complete");
  finish("failed", "fail");

  app.post(`${WORKSPACE}/browser-interventions/:interventionId/cancel`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const { row, agent } = await interventionIn(deps, me, param(c, "interventionId"));
    const allowed =
      row.controllingUserId === me.userId ||
      row.targetUserId === me.userId ||
      !row.targetUserId ||
      isEditor(me, agent);
    if (!allowed) throw forbidden();
    const next = await moveIntervention(deps, row.id, ["pending", "active"], {
      status: "canceled",
      handledAt: deps.now(),
    });
    if (!next) throw closed();
    return c.json(toIntervention(next));
  });

  app.post(`${WORKSPACE}/agents/:agentId/browser/interventions/start`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const agent = await agentInWorkspace(deps.db, me.workspaceId, param(c, "agentId"));
    const { runId } = await readJson(c, z.object({ runId: z.string().max(64).optional() }));
    if (!canTalkTo(await withPlanOwner(deps.db, agent), me.userId)) throw forbidden();
    if (!agent.environmentId) throw conflict("browser.no_environment", "This agent has no runner");
    const [runner] = await deps.db.select().from(runners).where(eq(runners.id, agent.environmentId));
    if (!runner || runner.removedAt) throw conflict("browser.no_environment", "This agent has no runner");
    // Driving the browser is using the runner: only whoever may use it (who paired it or manages agents).
    if (!canUseRunner(me, runner)) throw forbidden("Only who paired this runner can use it");
    if (!deps.runners.isOnline(runner.id)) throw conflict("runner.offline", "The runner is offline");
    if (!runner.browser || !runner.access.tools.browser)
      throw conflict("browser.disabled", "The browser is turned off on this runner");
    // Taken over from the run's card: the notice goes to the run's channel (everyone there sees who drives).
    const [run] = runId
      ? await deps.db
          .select({ channelId: runs.channelId, threadId: runs.threadId })
          .from(runs)
          .where(and(eq(runs.id, runId), eq(runs.workspaceId, me.workspaceId), eq(runs.agentId, agent.id)))
      : [];
    // At most one open intervention per agent: reading the open one and taking it (or opening a new one) is
    // one step, under the agent's lock, so two people taking over at once leave one of them in control.
    const expired: InterventionRow[] = [];
    const outcome = await deps.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`intervention:${agent.id}`}, 0))`);
      const [session] = await tx
        .select({ id: schema.sessions.id })
        .from(schema.sessions)
        .where(
          and(eq(schema.sessions.id, c.get("sessionId") ?? ""), gt(schema.sessions.expiresAt, deps.now())),
        )
        .for("share");
      if (!session) throw closed();
      const [currentRunner] = await tx.select().from(runners).where(eq(runners.id, runner.id)).for("share");
      const [current] = await tx.select().from(agents).where(eq(agents.id, agent.id)).for("share");
      if (
        !currentRunner ||
        currentRunner.revokedAt ||
        currentRunner.removedAt ||
        current?.environmentId !== runner.id
      )
        throw closed();
      expired.push(
        ...(await tx
          .update(browserInterventions)
          .set({ status: "expired", handledAt: deps.now() })
          .where(
            and(
              eq(browserInterventions.agentId, agent.id),
              inArray(browserInterventions.status, ["pending", "active"]),
              lte(browserInterventions.expiresAt, deps.now()),
            ),
          )
          .returning()),
      );
      const [open] = await tx
        .select()
        .from(browserInterventions)
        .where(
          and(
            eq(browserInterventions.agentId, agent.id),
            inArray(browserInterventions.status, ["pending", "active"]),
          ),
        );
      if (open?.status === "active") return { kind: "open" as const, row: open };
      if (open) {
        if (open.targetUserId && open.targetUserId !== me.userId)
          throw forbidden("This request is for someone else");
        const [taken] = await tx
          .update(browserInterventions)
          .set({ status: "active", controllingUserId: me.userId })
          .where(
            and(
              eq(browserInterventions.id, open.id),
              eq(browserInterventions.status, "pending"),
              gt(browserInterventions.expiresAt, deps.now()),
            ),
          )
          .returning();
        if (taken) interventionSession(deps, taken.id, c.get("sessionId") ?? undefined);
        return taken ? { kind: "changed" as const, row: taken } : { kind: "closed" as const };
      }
      const now = deps.now();
      const [created] = await tx
        .insert(browserInterventions)
        .values({
          id: newId("bi"),
          workspaceId: me.workspaceId,
          agentId: agent.id,
          runnerId: runner.id,
          kind: "intervention",
          status: "active",
          controllingUserId: me.userId,
          targetUserId: me.userId,
          channelId: run?.channelId ?? null,
          threadId: run?.threadId ?? null,
          runId: run ? runId : null,
          createdAt: now,
          expiresAt: new Date(now.getTime() + INTERVENTION_TTL_MS),
        })
        .returning();
      if (!created) throw new Error("intervention insert failed");
      interventionSession(deps, created.id, c.get("sessionId") ?? undefined);
      return { kind: "changed" as const, row: created };
    });
    for (const row of expired) await publishIntervention(deps, row);
    if (outcome.kind === "closed") throw closed();
    if (outcome.kind === "open") {
      if (
        outcome.row.controllingUserId === me.userId &&
        interventionSession(deps, outcome.row.id) === c.get("sessionId")
      )
        return c.json(toIntervention(outcome.row));
      throw inControl();
    }
    const row = outcome.row;
    await publishIntervention(deps, row);
    return c.json(toIntervention(row));
  });

  app.post(`${WORKSPACE}/agents/:agentId/browser/stop`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const agent = await agentInWorkspace(deps.db, me.workspaceId, param(c, "agentId"));
    if (!canTalkTo(await withPlanOwner(deps.db, agent), me.userId) && !isEditor(me, agent)) throw forbidden();
    // Closing the browser acts on the runner: as starting a takeover, only whoever may use it. The runner checked
    // is the one the close goes to, so a move in between doesn't reach one they can't use.
    const [runner] = agent.environmentId
      ? await deps.db.select().from(runners).where(eq(runners.id, agent.environmentId))
      : [];
    if (runner && !canUseRunner(me, runner)) throw forbidden("Only who paired this runner can use it");
    // Only the interventions on a runner the person may use: one opened on another runner (after a move, or with
    // no runner when this read) isn't theirs to end.
    const open = (
      await deps.db
        .select({ id: browserInterventions.id, runner: runners })
        .from(browserInterventions)
        .innerJoin(runners, eq(runners.id, browserInterventions.runnerId))
        .where(
          and(
            eq(browserInterventions.agentId, agent.id),
            inArray(browserInterventions.status, ["pending", "active"]),
          ),
        )
    ).filter((h) => canUseRunner(me, h.runner));
    for (const h of open)
      await moveIntervention(deps, h.id, ["pending", "active"], {
        status: "canceled",
        handledAt: deps.now(),
      });
    if (runner && deps.runners.isOnline(runner.id))
      await deps.runners
        .call(
          runner.id,
          "browser.close",
          {},
          { agent: { id: agent.id, handle: agent.handle }, timeoutMs: 15_000 },
        )
        .catch(() => {});
    return c.body(null, 204);
  });
}
