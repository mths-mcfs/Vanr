// Runners: pairing (device code), the installer, the list and management of the runners, each agent's
// environment and the settings of the cloud sandbox (not available on this installation).
import type { EnvironmentTarget, MoveAgentsResult, SandboxSettings } from "@vanr/contract";
import { schema } from "@vanr/engine/db";
import { RUNNER_PROTOCOL } from "@vanr/engine/runner-protocol";
import { PRODUCT } from "@vanr/product";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Context, Hono } from "hono";
import { z } from "zod";
import { agentInWorkspace, requireAgentEditor } from "../agents";
import { type AppDeps, type AppEnv, requireUser } from "../context";
import { conflict, forbidden, HttpError, notFound, param, readJson } from "../http";
import { endLiveView, endLiveViewsOf, invalidateRunnerAccess } from "../runners/browser-live";
import { mintSession, revokeRunner } from "../runners/credentials";
import { RunnerCallError } from "../runners/hub";
import { installScript, runnerBundle } from "../runners/install";
import { decideNetwork, toNetworkRequest } from "../runners/network";
import {
  canPair,
  confirmPairing,
  denyPairing,
  describePairing,
  pairingStartInput,
  pollPairing,
  startPairing,
} from "../runners/pairing";
import { cancelRunnerRequests, publishRunnerRequests } from "../runners/requests";
import {
  canManageRunner,
  canUseRunner,
  emitEnvironment,
  environmentOf,
  pushAgents,
  runnerInWorkspace,
  targetOf,
  toRunner,
  toRunners,
} from "../runners/runners";
import { latestManifest } from "../runners/update";
import { requireMember, requirePermission, WORKSPACE } from "../workspace-scope";

const { runners, agents, agentEnvironments, sandboxPolicies, runnerJobs, networkRequests } = schema;

const offline = () => conflict("runner.offline", "The runner is offline");

export function runnerError(err: unknown): never {
  if (err instanceof RunnerCallError) {
    if (err.code === "offline") throw offline();
    throw new HttpError(err.code === "timeout" ? 504 : 409, `runner.${err.code}`, err.message);
  }
  throw err;
}

const MAX_TIMEOUT_S = 3600;

/** Changing the binding and closing its requests commit together, before any new delivery can claim them. */
async function setAgentRunner(deps: AppDeps, agentId: string, runnerId: string | null) {
  const { previous, closed } = await deps.db.transaction(async (tx) => {
    const [agent] = await tx.select().from(agents).where(eq(agents.id, agentId)).for("update");
    const previous = agent?.environmentId ?? null;
    await tx
      .update(agents)
      .set({ environmentId: runnerId, updatedAt: deps.now() })
      .where(eq(agents.id, agentId));
    const closed = await cancelRunnerRequests(
      tx,
      deps.now(),
      previous ?? "",
      previous && previous !== runnerId ? [agentId] : [],
    );
    return { previous, closed };
  });
  if (previous && previous !== runnerId) {
    deps.runners.cancelPending(previous, agentId);
    endLiveView(deps, agentId);
  }
  await publishRunnerRequests(deps, closed);
  return previous;
}

async function sandboxOf(deps: AppDeps, workspaceId: string): Promise<SandboxSettings> {
  const [row] = await deps.db
    .select()
    .from(sandboxPolicies)
    .where(eq(sandboxPolicies.workspaceId, workspaceId));
  return {
    enabled: row?.enabled ?? false,
    // This installation has no cloud sandbox provider: the agents use paired runners.
    available: false,
    network: row?.network ?? "allowlist",
    permittedDomains: row?.permittedDomains ?? [],
    minutesPerDay: row?.minutesPerDay ?? 120,
    commandTimeoutSec: row?.commandTimeoutSec ?? 120,
    timeoutCeilingSec: MAX_TIMEOUT_S,
    requireApproval: row?.requireApproval ?? false,
  };
}

const DOMAIN = /^(\*\.)?([a-z0-9-]+\.)+[a-z]{2,}$/;

export function registerRunners(app: Hono<AppEnv>) {
  // ---- installer and bundle (no session) ----

  app.get("/api/v1/runners/install.sh", async (c) => {
    const deps = c.get("deps");
    const bundle = await runnerBundle();
    return c.body(installScript({ server: deps.config.publicUrl, sha256: bundle.sha256 }), 200, {
      "content-type": "text/x-shellscript; charset=utf-8",
      "cache-control": "no-store",
    });
  });

  app.get(`/runner/${PRODUCT.runnerName}.mjs`, async (c) => {
    const bundle = await runnerBundle();
    return c.body(bundle.bytes as Uint8Array<ArrayBuffer>, 200, {
      "content-type": "text/javascript; charset=utf-8",
      "x-content-sha256": bundle.sha256,
      "cache-control": "no-store",
    });
  });

  // The signed manifest of the served version (the runner checks it with the public key pinned in it).
  app.get("/api/v1/runners/runner/latest", async (c) => {
    const manifest = await latestManifest(c.get("deps"));
    if (!manifest) throw notFound("This server does not sign runner updates");
    return c.json(manifest, 200, { "cache-control": "no-store" });
  });

  // ---- the runner's session: device credential → single-use session + new credential ----

  app.post("/api/v1/runners/session", async (c) => {
    const input = await readJson(
      c,
      z.object({
        runnerId: z.string().max(64).optional(),
        protocol: z.number().int(),
        version: z.string().max(40).optional(),
      }),
    );
    // Version before the credential, as in the `hello`: an old runner rotates nothing.
    if (input.protocol !== RUNNER_PROTOCOL)
      throw new HttpError(426, "runner.outdated", "This runner is out of date; update it");
    const auth = c.req.header("authorization") ?? "";
    const credential = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    return c.json(await mintSession(c.get("deps"), credential), 200, { "cache-control": "no-store" });
  });

  // ---- pairing: the runner (no session) ----

  app.post("/api/v1/runner-pairings", async (c) => {
    const input = await readJson(c, pairingStartInput);
    return c.json(await startPairing(c.get("deps"), input));
  });

  app.post("/api/v1/runner-pairings/token", async (c) => {
    const { deviceCode } = await readJson(c, z.object({ deviceCode: z.string().min(16).max(200) }));
    const res = await pollPairing(c.get("deps"), deviceCode);
    return c.json(res.body, res.status);
  });

  // ---- pairing: the person on /connect ----

  app.get("/api/v1/runner-pairings/:pairingCode", async (c) => {
    const user = requireUser(c);
    return c.json(await describePairing(c.get("deps"), param(c, "pairingCode"), user.id));
  });

  app.post("/api/v1/runner-pairings/:pairingCode/deny", async (c) => {
    const user = requireUser(c);
    await denyPairing(c.get("deps"), param(c, "pairingCode"), user.id);
    return c.body(null, 204);
  });

  app.post(`${WORKSPACE}/runner-pairings/:pairingCode/confirm`, async (c) => {
    const me = requireMember(c);
    if (!canPair(me)) throw forbidden();
    const input = await readJson(c, z.object({ name: z.string().trim().max(80).optional() }));
    return c.json(await confirmPairing(c.get("deps"), me, param(c, "pairingCode"), input));
  });

  // ---- the workspace's runners ----

  app.get(`${WORKSPACE}/runners`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const rows = await deps.db
      .select()
      .from(runners)
      .where(and(eq(runners.workspaceId, me.workspaceId), isNull(runners.removedAt)))
      .orderBy(runners.createdAt);
    return c.json({ runners: await toRunners(deps, rows, me) });
  });

  app.get(`${WORKSPACE}/runners/outages`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const rows = await deps.db
      .select()
      .from(runners)
      .where(and(eq(runners.workspaceId, me.workspaceId), isNull(runners.removedAt)));
    const down = rows.filter((r) => !deps.runners.isOnline(r.id));
    const using = down.length
      ? await deps.db
          .select({ id: agents.id, runnerId: agents.environmentId })
          .from(agents)
          .where(
            and(
              inArray(
                agents.environmentId,
                down.map((d) => d.id),
              ),
              isNull(agents.archivedAt),
            ),
          )
      : [];
    const waiting = down.length
      ? await deps.db
          .select({ runnerId: runnerJobs.runnerId })
          .from(runnerJobs)
          .where(
            and(
              inArray(
                runnerJobs.runnerId,
                down.map((d) => d.id),
              ),
              inArray(runnerJobs.status, ["queued", "running"]),
            ),
          )
      : [];
    return c.json({
      outages: down
        .map((d) => ({
          runnerId: d.id,
          name: d.name,
          since: (d.disconnectedAt ?? d.lastOnlineAt ?? d.createdAt).toISOString(),
          agentIds: using.filter((u) => u.runnerId === d.id).map((u) => u.id),
          waitingJobs: waiting.filter((w) => w.runnerId === d.id).length,
        }))
        .filter((o) => o.agentIds.length > 0),
      targets: rows
        .filter((r) => canUseRunner(me, r))
        .map((r) => ({ runnerId: r.id, name: r.name, online: deps.runners.isOnline(r.id) })),
    });
  });

  app.patch(`${WORKSPACE}/runners/:runnerId`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const row = await runnerInWorkspace(deps.db, me.workspaceId, param(c, "runnerId"));
    if (!canManageRunner(me, row)) throw forbidden();
    const { name } = await readJson(c, z.object({ name: z.string().trim().min(1).max(80) }));
    await deps.db.update(runners).set({ name, updatedAt: deps.now() }).where(eq(runners.id, row.id));
    deps.hub.toWorkspace(me.workspaceId, { type: "runner.updated", runnerId: row.id, name });
    return c.json({ id: row.id, name });
  });

  app.delete(`${WORKSPACE}/runners/:runnerId`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const row = await runnerInWorkspace(deps.db, me.workspaceId, param(c, "runnerId"));
    if (!canManageRunner(me, row)) throw forbidden();
    const { moved, closed } = await deps.db.transaction(async (tx) => {
      await tx.update(runners).set({ removedAt: deps.now() }).where(eq(runners.id, row.id));
      const moved = await tx
        .update(agents)
        .set({ environmentId: null, updatedAt: deps.now() })
        .where(eq(agents.environmentId, row.id))
        .returning({ id: agents.id });
      const closed = await cancelRunnerRequests(tx, deps.now(), row.id);
      return { moved, closed };
    });
    deps.runners.close(row.id, {
      type: "rejected",
      reason: "revoked",
      message: "Removed from the workspace",
    });
    endLiveViewsOf(deps, row.id);
    await publishRunnerRequests(deps, closed);
    deps.hub.toWorkspace(me.workspaceId, { type: "runner.deleted", runnerId: row.id });
    for (const a of moved) await emitEnvironment(deps, me.workspaceId, a.id);
    return c.body(null, 204);
  });

  // Revoking: the credential stops working and the connection drops now; the runner comes back by pairing again.
  app.post(`${WORKSPACE}/runners/:runnerId/revoke`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const row = await runnerInWorkspace(deps.db, me.workspaceId, param(c, "runnerId"));
    if (!canManageRunner(me, row)) throw forbidden();
    await revokeRunner(deps, row, "manual");
    return c.json(await toRunner(deps, await runnerInWorkspace(deps.db, me.workspaceId, row.id), me));
  });

  app.post(`${WORKSPACE}/runners/:runnerId/access/reduce`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const row = await runnerInWorkspace(deps.db, me.workspaceId, param(c, "runnerId"));
    if (!canManageRunner(me, row)) throw forbidden();
    const input = await readJson(
      c,
      z.union([
        z.object({
          removeFolder: z.object({
            path: z.string().min(1).max(1024),
            agentId: z.string().max(64).optional(),
          }),
        }),
        z.object({ disableTool: z.enum(["claude", "codex", "commands", "browser"]) }),
      ]),
    );
    // Only the runner changes its access (its config is the source); the server keeps what it returns.
    const res = await deps.runners
      .call<"access.reduce", { access: typeof row.access }>(row.id, "access.reduce", input, {
        timeoutMs: 15_000,
      })
      .catch(runnerError);
    await deps.db
      .update(runners)
      .set({ access: res.access, updatedAt: deps.now() })
      .where(eq(runners.id, row.id));
    deps.hub.toWorkspace(me.workspaceId, { type: "runner.access", runnerId: row.id, access: res.access });
    // What was running started under the wider access: it stops, and so does a live view without the browser.
    invalidateRunnerAccess(deps, row.id, res.access);
    return c.json({ access: res.access });
  });

  app.post(`${WORKSPACE}/runners/:runnerId/move-agents`, async (c) => {
    const me = requirePermission(c, "manage_agents");
    const deps = c.get("deps");
    const from = await runnerInWorkspace(deps.db, me.workspaceId, param(c, "runnerId"));
    const input = await readJson(
      c,
      z.object({
        toRunnerId: z.string().min(1).max(64),
        agentIds: z.array(z.string().max(64)).max(200).optional(),
      }),
    );
    const to = await runnerInWorkspace(deps.db, me.workspaceId, input.toRunnerId);
    const candidates = await deps.db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.environmentId, from.id), isNull(agents.archivedAt)));
    const wanted = input.agentIds ? new Set(input.agentIds) : null;
    const picked = candidates.filter((a) => !wanted || wanted.has(a.id)).map((a) => a.id);
    // Moved only while still on this runner: an agent another change took elsewhere meanwhile stays there.
    const { moved, closed } = await deps.db.transaction(async (tx) => {
      const moved = picked.length
        ? (
            await tx
              .update(agents)
              .set({ environmentId: to.id, updatedAt: deps.now() })
              .where(and(inArray(agents.id, picked), eq(agents.environmentId, from.id)))
              .returning({ id: agents.id })
          ).map((a) => a.id)
        : [];
      const closed = await cancelRunnerRequests(tx, deps.now(), from.id, to.id !== from.id ? moved : []);
      return { moved, closed };
    });
    if (to.id !== from.id)
      for (const id of moved) {
        deps.runners.cancelPending(from.id, id);
        endLiveView(deps, id);
      }
    await publishRunnerRequests(deps, closed);
    const skipped = [...(wanted ?? [])].filter((id) => !moved.includes(id));
    const queued = (
      await deps.db
        .select({ id: runnerJobs.id })
        .from(runnerJobs)
        .where(and(eq(runnerJobs.runnerId, from.id), inArray(runnerJobs.status, ["queued", "running"])))
    ).length;
    deps.hub.toWorkspace(me.workspaceId, {
      type: "runner.agents_moved",
      runnerId: from.id,
      toRunnerId: to.id,
      agentIds: moved,
    });
    for (const id of moved) {
      await emitEnvironment(deps, me.workspaceId, id);
    }
    await pushAgents(deps, to.id);
    const result: MoveAgentsResult = { moved, skipped, restarted: 0, queued };
    return c.json(result);
  });

  app.get("/api/v1/desktop/releases/latest", (c) =>
    // There is no desktop app on this installation: the client takes a 404 as "no version".
    c.json({ error: { code: "not_found", message: "No desktop app for this platform" } }, 404),
  );

  // ---- the agent's environment ----

  app.get(`${WORKSPACE}/agents/:agentId/environment`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const agent = await agentInWorkspace(deps.db, me.workspaceId, param(c, "agentId"));
    return c.json(await environmentOf(deps, agent.id));
  });

  const setStatus = async (
    deps: AppDeps,
    workspaceId: string,
    agentId: string,
    status: "running" | "stopped" | "none",
  ) => {
    await deps.db
      .insert(agentEnvironments)
      .values({ agentId, workspaceId, status, lastUsedAt: deps.now() })
      .onConflictDoUpdate({
        target: agentEnvironments.agentId,
        set: { status, updatedAt: deps.now(), ...(status === "running" ? { lastUsedAt: deps.now() } : {}) },
      });
    await emitEnvironment(deps, workspaceId, agentId);
    return environmentOf(deps, agentId);
  };

  app.post(`${WORKSPACE}/agents/:agentId/environment/start`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const agent = await agentInWorkspace(deps.db, me.workspaceId, param(c, "agentId"));
    requireAgentEditor(me, agent);
    if (!agent.environmentId)
      throw conflict("sandbox.not_set_up", "This installation has no cloud sandbox; pair a runner");
    if (!deps.runners.isOnline(agent.environmentId)) throw offline();
    return c.json(await setStatus(deps, me.workspaceId, agent.id, "running"));
  });

  app.post(`${WORKSPACE}/agents/:agentId/environment/stop`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const agent = await agentInWorkspace(deps.db, me.workspaceId, param(c, "agentId"));
    requireAgentEditor(me, agent);
    if (agent.environmentId) {
      // Stops what the agent had running there.
      const running = await deps.db
        .select({ id: runnerJobs.id })
        .from(runnerJobs)
        .where(and(eq(runnerJobs.agentId, agent.id), eq(runnerJobs.status, "running")));
      for (const t of running)
        await deps.runners
          .call(
            agent.environmentId,
            "job.cancel",
            { jobId: t.id },
            { agent: { id: agent.id, handle: agent.handle } },
          )
          .catch(() => {});
    }
    return c.json(await setStatus(deps, me.workspaceId, agent.id, "stopped"));
  });

  app.delete(`${WORKSPACE}/agents/:agentId/environment`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const agent = await agentInWorkspace(deps.db, me.workspaceId, param(c, "agentId"));
    requireAgentEditor(me, agent);
    const previous = await setAgentRunner(deps, agent.id, null);
    await setStatus(deps, me.workspaceId, agent.id, "none");
    if (previous) {
      await pushAgents(deps, previous);
    }
    return c.body(null, 204);
  });

  app.put(`${WORKSPACE}/agents/:agentId/environment/target`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const agent = await agentInWorkspace(deps.db, me.workspaceId, param(c, "agentId"));
    requireAgentEditor(me, agent);
    const { runnerId } = await readJson(c, z.object({ runnerId: z.string().max(64).nullable() }));
    if (runnerId) {
      const runner = await runnerInWorkspace(deps.db, me.workspaceId, runnerId);
      if (!canUseRunner(me, runner)) throw forbidden("Only who paired this runner can lend it to agents");
    }
    const previous = await setAgentRunner(deps, agent.id, runnerId);
    if (runnerId)
      await deps.db
        .insert(agentEnvironments)
        .values({ agentId: agent.id, workspaceId: me.workspaceId, status: "running", lastUsedAt: deps.now() })
        .onConflictDoUpdate({
          target: agentEnvironments.agentId,
          set: { status: "running", updatedAt: deps.now() },
        });
    const target = await targetOf(deps, runnerId);
    // The same shape as every `environment.updated`: the agent's page updates the card without fetching.
    await emitEnvironment(deps, me.workspaceId, agent.id);
    for (const id of new Set([previous, runnerId])) if (id) await pushAgents(deps, id);
    const out: EnvironmentTarget = target ?? { kind: "cloud", runnerId: null, name: null, online: false };
    return c.json(out);
  });

  // ---- the agent's network domains (requests the sandbox blocked) ----

  app.get(`${WORKSPACE}/agents/:agentId/environment/domains`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const agent = await agentInWorkspace(deps.db, me.workspaceId, param(c, "agentId"));
    const rows = await deps.db
      .select()
      .from(networkRequests)
      .where(
        and(
          eq(networkRequests.agentId, agent.id),
          inArray(networkRequests.status, ["pending", "allowed", "denied"]),
        ),
      )
      .orderBy(networkRequests.domain);
    // The command that hit the block may come from a private channel: the list shows only the domain.
    return c.json({ domains: rows.map((r) => ({ ...toNetworkRequest(r), context: "" })) });
  });

  const decide = (decision: "allowed" | "denied" | "removed") => async (c: Context<AppEnv>) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const [row] = await deps.db
      .select()
      .from(networkRequests)
      .where(
        and(
          eq(networkRequests.id, param(c, "networkRequestId")),
          eq(networkRequests.workspaceId, me.workspaceId),
        ),
      );
    if (!row) throw notFound("Request not found");
    requireAgentEditor(me, await agentInWorkspace(deps.db, me.workspaceId, row.agentId));
    const updated = await decideNetwork(deps, row, decision, me.userId);
    if (!updated) throw conflict("network.decided", "Someone already decided this request");
    return c.json(toNetworkRequest(updated));
  };
  app.post(`${WORKSPACE}/network-requests/:networkRequestId/allow`, decide("allowed"));
  app.post(`${WORKSPACE}/network-requests/:networkRequestId/deny`, decide("denied"));
  app.delete(`${WORKSPACE}/network-requests/:networkRequestId`, decide("removed"));

  // ---- the cloud sandbox (the workspace's settings) ----

  app.get(`${WORKSPACE}/sandbox-settings`, async (c) => {
    const me = requireMember(c);
    return c.json(await sandboxOf(c.get("deps"), me.workspaceId));
  });

  app.put(`${WORKSPACE}/sandbox-settings`, async (c) => {
    const me = requirePermission(c, "configure");
    const deps = c.get("deps");
    const input = await readJson(
      c,
      z.object({
        enabled: z.boolean().optional(),
        network: z.enum(["off", "allowlist", "open"]).optional(),
        permittedDomains: z
          .array(z.string().trim().toLowerCase().regex(DOMAIN, "Use a domain like example.com"))
          .max(100)
          .optional(),
        minutesPerDay: z.number().int().min(0).max(1440).optional(),
        commandTimeoutSec: z.number().int().min(5).max(MAX_TIMEOUT_S).optional(),
        requireApproval: z.boolean().optional(),
      }),
    );
    // An empty workspace list in `allowlist` mode holds: the commands reach only what was allowed per agent.
    // A partial change merges with the row as it is now, under the workspace's lock: two changes at once keep both.
    await deps.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`sandbox:${me.workspaceId}`}, 0))`,
      );
      const current = await sandboxOf({ ...deps, db: tx }, me.workspaceId);
      const next = { ...current, ...input };
      const values = {
        enabled: next.enabled,
        network: next.network,
        permittedDomains: next.permittedDomains,
        minutesPerDay: next.minutesPerDay,
        commandTimeoutSec: next.commandTimeoutSec,
        requireApproval: next.requireApproval,
      };
      await tx
        .insert(sandboxPolicies)
        .values({ workspaceId: me.workspaceId, ...values })
        .onConflictDoUpdate({
          target: sandboxPolicies.workspaceId,
          set: { ...values, updatedAt: deps.now() },
        });
    });
    return c.json(await sandboxOf(deps, me.workspaceId));
  });
}
