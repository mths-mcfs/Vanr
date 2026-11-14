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
import { schema } from "@vanr/engine/db";
import { newId } from "@vanr/engine/ids";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { z } from "zod";
import { type AgentRow, agentInWorkspace, requireAgentEditor } from "../agents";
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
  INTERVENTION_TTL_MS,
  type InterventionRow,
  moveIntervention,
  publishIntervention,
  publishSecret,
  secretTarget,
  toIntervention,
  toSecretRequest,
} from "../runners/requests";
import { canManageRunner } from "../runners/runners";
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
  const [row] = await deps.db
    .select()
    .from(browserInterventions)
    .where(and(eq(browserInterventions.id, id), eq(browserInterventions.workspaceId, me.workspaceId)));
  if (!row) throw notFound("Browser request not found");
  const agent = await agentInWorkspace(deps.db, me.workspaceId, row.agentId);
  if (!canTalkTo(await withPlanOwner(deps.db, agent), me.userId)) throw notFound("Browser request not found");
  return { row, agent };
}

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
        .where(eq(secretPrompts.id, row.id))
        .returning();
      if (expired) await publishSecret(deps, expired, "secret_request.updated");
      throw secretClosed("expired");
    }
    await deps.runners
      .call(
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
        { agent: { id: agent.id, handle: agent.handle }, timeoutMs: 20_000 },
      )
      .catch(runnerError);
    const at = deps.now();
    const [next] = await deps.db
      .update(secretPrompts)
      .set({ status: "delivered", fulfilledAt: at, decidedBy: me.userId })
      .where(and(eq(secretPrompts.id, row.id), eq(secretPrompts.status, "pending")))
      .returning();
    if (!next) throw conflict("secret.closed", "This request is no longer open");
    await deps.db
      .insert(runnerSecrets)
      .values({
        agentId: agent.id,
        runnerId: row.runnerId,
        name: row.name,
        workspaceId: me.workspaceId,
        target: row.target,
        filePath: row.filePath,
        browser: row.browser,
        deliveredBy: me.userId,
        updatedAt: at,
      })
      .onConflictDoUpdate({
        target: [runnerSecrets.agentId, runnerSecrets.runnerId, runnerSecrets.name],
        set: {
          target: row.target,
          filePath: row.filePath,
          browser: row.browser,
          deliveredBy: me.userId,
          updatedAt: at,
        },
      });
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
    const before = await browserSettingsOf(deps.db, agent.id);
    const readDomains = (before?.readDomains ?? []).filter((d) => !unique.includes(d));
    const [row] = await deps.db
      .insert(browserPolicies)
      .values({ agentId: agent.id, workspaceId: me.workspaceId, permittedDomains: unique, readDomains })
      .onConflictDoUpdate({
        target: browserPolicies.agentId,
        set: { permittedDomains: unique, readDomains, updatedAt: deps.now() },
      })
      .returning();
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
    const before = await browserSettingsOf(deps.db, agent.id);
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
          const [runner] = await deps.db
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
    const [row] = await deps.db
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
    await pushPolicy(deps, agent.id);
    return c.json(toBrowserSettings(row));
  });

  // The browser log: read only. No route edits or deletes a step.
  const canSeeLog = async (deps: AppDeps, me: WorkspaceMember, agent: AgentRow) =>
    isEditor(me, agent) || canTalkTo(await withPlanOwner(deps.db, agent), me.userId);

  app.get(`${WORKSPACE}/agents/:agentId/browser/steps`, async (c) => {
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
    return c.json({ steps: rows.map(toBrowserLogEntry) });
  });

  app.get(`${WORKSPACE}/agents/:agentId/browser/steps/:stepId/shot`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const agent = await agentInWorkspace(deps.db, me.workspaceId, param(c, "agentId"));
    if (!(await canSeeLog(deps, me, agent))) throw forbidden();
    const [row] = await deps.db
      .select({ shotKey: browserLogEntries.shotKey })
      .from(browserLogEntries)
      .where(and(eq(browserLogEntries.id, param(c, "stepId")), eq(browserLogEntries.agentId, agent.id)));
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
    if (row.status === "active" && row.controllingUserId === me.userId) return c.json(toIntervention(row));
    // Someone else took over first: the same code as who tries through the runner, not "finished".
    if (row.status === "active") throw inControl();
    if (row.status !== "pending") throw closed();
    if (!deps.runners.isOnline(row.runnerId)) throw conflict("runner.offline", "The runner is offline");
    const next = await moveIntervention(deps, row.id, ["pending"], {
      status: "active",
      controllingUserId: me.userId,
    });
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
      const next = await moveIntervention(deps, row.id, ["pending", "active"], {
        status,
        note: note ?? null,
        handledAt: deps.now(),
      });
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

  app.post(`${WORKSPACE}/agents/:agentId/browser/interventions/takeover`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const agent = await agentInWorkspace(deps.db, me.workspaceId, param(c, "agentId"));
    const { runId } = await readJson(c, z.object({ runId: z.string().max(64).optional() }));
    if (!canTalkTo(await withPlanOwner(deps.db, agent), me.userId)) throw forbidden();
    if (!agent.environmentId) throw conflict("browser.no_environment", "This agent has no runner");
    const [runner] = await deps.db.select().from(runners).where(eq(runners.id, agent.environmentId));
    if (!runner || runner.removedAt) throw conflict("browser.no_environment", "This agent has no runner");
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
    const outcome = await deps.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`intervention:${agent.id}`}, 0))`);
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
        const [taken] = await tx
          .update(browserInterventions)
          .set({ status: "active", controllingUserId: me.userId })
          .where(and(eq(browserInterventions.id, open.id), eq(browserInterventions.status, "pending")))
          .returning();
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
      return { kind: "changed" as const, row: created };
    });
    if (outcome.kind === "closed") throw closed();
    if (outcome.kind === "open") {
      if (outcome.row.controllingUserId === me.userId) return c.json(toIntervention(outcome.row));
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
    const open = await deps.db
      .select({ id: browserInterventions.id })
      .from(browserInterventions)
      .where(
        and(
          eq(browserInterventions.agentId, agent.id),
          inArray(browserInterventions.status, ["pending", "active"]),
        ),
      );
    for (const h of open)
      await moveIntervention(deps, h.id, ["pending", "active"], {
        status: "canceled",
        handledAt: deps.now(),
      });
    const [a] = await deps.db
      .select({ environmentId: agents.environmentId })
      .from(agents)
      .where(eq(agents.id, agent.id));
    if (a?.environmentId && deps.runners.isOnline(a.environmentId))
      await deps.runners
        .call(
          a.environmentId,
          "browser.close",
          {},
          { agent: { id: agent.id, handle: agent.handle }, timeoutMs: 15_000 },
        )
        .catch(() => {});
    return c.body(null, 204);
  });
}
