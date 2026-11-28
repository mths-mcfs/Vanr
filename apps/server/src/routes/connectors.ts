// The workspace's connectors (catalog and own MCP server), the GitHub App, and each agent's access: raw scopes,
// the per-resource view of the access tab, the repositories and the agent's own identity. Reading is for
// members; connecting, changing and disconnecting a workspace connection is `configure`; an agent's access and
// repositories are `manage_agents`; an agent's own identity is whoever edits the agent. Every id in a path is
// looked up inside the caller's workspace: an id of another workspace is 404.
import {
  type AccessInput,
  type AgentAccess,
  type ChannelAccessRule,
  can,
  type IdentityConnectInput,
  type SaveToolsInput,
  type ScopeGrant,
} from "@vanr/contract";
import { schema } from "@vanr/engine/db";
import { and, eq, isNull, ne } from "drizzle-orm";
import type { Hono } from "hono";
import { z } from "zod";
import { agentInWorkspace, channelViewer, requireAgentEditor } from "../agents";
import { type AppDeps, type AppEnv, type Ctx, requireUser, type WorkspaceMember } from "../context";
import { conflict, forbidden, notFound, param, readJson, unauthorized } from "../http";
import {
  accessView,
  activeConnections,
  applyAccessInput,
  grantsOf,
  replaceGrants,
  validateGrants,
} from "../integrations/access";
import { catalogResponse } from "../integrations/catalog";
import {
  connectCustom,
  connectionById,
  connectWithKey,
  disconnect,
  finishOAuth,
  refreshCustom,
  type Starter,
  saveCustomTools,
  startCatalogOAuth,
  startScopeStepUp,
  toConnection,
  toCustomServer,
} from "../integrations/connectors";
import {
  finishInstall,
  installations,
  installUrl,
  isRepoPattern,
  removeInstallation,
  repositoriesOf,
  toInstallation,
} from "../integrations/github-app";
import {
  connectIdentity,
  identityOf,
  revokeIdentity,
  scopeTarget,
  setChannelRules,
} from "../integrations/identity";
import { requireMember, requirePermission, WORKSPACE } from "../workspace-scope";

const { connections, agents } = schema;

const nextPath = z.string().trim().min(1).max(500);
const toolAccess = z.enum(["read", "write", "approval", "off"]);
const grant = z.object({ connectionId: z.string().max(64), scope: z.string().min(1).max(200) });

const keyInput = z.object({
  connector: z.string().min(1).max(64),
  apiKey: z.string().trim().min(8).max(2000),
  serverUrl: z.string().max(500).optional(),
  label: z.string().trim().max(120).optional(),
});
const customInput = z.object({
  serverUrl: z.string().trim().min(1).max(500),
  apiKey: z.string().trim().min(1).max(2000).optional(),
  label: z.string().trim().max(120).optional(),
  nextPath,
});
const toolsInput = z.object({
  label: z.string().trim().max(120),
  tools: z
    .array(
      z.object({
        name: z.string().min(1).max(200),
        access: toolAccess,
        label: z.string().max(120),
        confirmed: z.boolean().optional(),
      }),
    )
    .max(500),
}) satisfies z.ZodType<SaveToolsInput>;
const accessInput = z
  .object({
    all: z.boolean(),
    connectors: z.record(z.string().max(64), z.boolean()),
    scopes: z.array(grant).max(500),
    tools: z.object({
      allow: z.array(z.string().max(96)).max(200),
      deny: z.array(z.string().max(96)).max(200),
    }),
  })
  .partial()
  .strict() satisfies z.ZodType<AccessInput>;
const identityInput = z.object({
  connector: z.string().min(1).max(64),
  apiKey: z.string().trim().min(8).max(2000).optional(),
  nextPath,
}) satisfies z.ZodType<IdentityConnectInput>;
const channelRules = z.object({
  channels: z
    .array(
      z.object({
        channelId: z.string().min(1).max(64),
        connectionId: z.string().min(1).max(64),
        level: z.enum(["off", "read", "approval"]),
      }),
    )
    .max(500),
}) satisfies z.ZodType<{ channels: ChannelAccessRule[] }>;

/** Connections that already count (an OAuth that didn't come back stays out). */
async function liveConnections(deps: AppDeps, workspaceId: string) {
  return (await activeConnections(deps.db, workspaceId)).filter((c) => c.status !== "pending");
}

async function accessOf(deps: AppDeps, workspaceId: string, agentId: string): Promise<AgentAccess> {
  return accessView(await grantsOf(deps.db, agentId), await liveConnections(deps, workspaceId));
}

/** Who starts a round trip, with the session the callback must come back in. */
function withSession(c: Ctx, me: WorkspaceMember): Starter {
  const sessionId = c.get("sessionId");
  if (!sessionId) throw unauthorized();
  return { ...me, sessionId };
}

/** Who comes back from a round trip: the account and the session of the request that carries the callback. */
const viewerOf = (c: Ctx) => ({ userId: c.get("user")?.id ?? "", sessionId: c.get("sessionId") ?? "" });

const redirect = (to: string) =>
  new Response(null, { status: 302, headers: { location: to, "cache-control": "no-store" } });

export function registerConnectors(app: Hono<AppEnv>) {
  app.get("/api/v1/connectors/catalog", (c) => {
    requireUser(c);
    // The connectors' OAuth uses dynamic client registration: it doesn't depend on the server's configuration.
    return c.json(catalogResponse(true));
  });

  // Back from OAuth (catalog connector or own MCP server). A browser navigation: it answers with a redirect.
  app.get("/api/v1/connectors/oauth/callback", async (c) => {
    const q = c.req.query();
    return redirect(
      await finishOAuth(c.get("deps"), viewerOf(c), {
        code: q.code,
        state: q.state,
        error: q.error,
        iss: q.iss,
      }),
    );
  });

  app.get("/api/v1/github-app/callback", async (c) => {
    const q = c.req.query();
    return redirect(
      await finishInstall(c.get("deps"), viewerOf(c), {
        installation_id: q.installation_id,
        setup_action: q.setup_action,
        state: q.state,
        code: q.code,
      }),
    );
  });

  // ---- Catalog connectors ----

  app.get(`${WORKSPACE}/connectors`, async (c) => {
    const me = requireMember(c);
    const rows = await c
      .get("deps")
      .db.select()
      .from(connections)
      .where(
        and(
          eq(connections.workspaceId, me.workspaceId),
          eq(connections.custom, false),
          isNull(connections.revokedAt),
          isNull(connections.agentId),
          ne(connections.status, "pending"),
        ),
      )
      .orderBy(connections.createdAt);
    return c.json({ connections: rows.map(toConnection) });
  });

  app.post(`${WORKSPACE}/connectors`, async (c) => {
    const me = requirePermission(c, "configure");
    const input = await readJson(c, keyInput);
    return c.json(toConnection(await connectWithKey(c.get("deps"), me, input)), 201);
  });

  app.post(`${WORKSPACE}/connectors/:connectorId/oauth/start`, async (c) => {
    const me = withSession(c, requirePermission(c, "configure"));
    const input = await readJson(c, z.object({ nextPath, serverUrl: z.string().max(500).optional() }));
    const consentUrl = await startCatalogOAuth(c.get("deps"), me, param(c, "connectorId"), input.nextPath);
    return c.json({ consentUrl });
  });

  // ---- Own MCP server ----

  app.get(`${WORKSPACE}/connectors/custom`, async (c) => {
    const me = requireMember(c);
    const rows = await liveConnections(c.get("deps"), me.workspaceId);
    return c.json({ servers: rows.filter((r) => r.custom).map(toCustomServer) });
  });

  app.post(`${WORKSPACE}/connectors/custom`, async (c) => {
    const me = withSession(c, requirePermission(c, "configure"));
    const input = await readJson(c, customInput);
    return c.json(await connectCustom(c.get("deps"), me, input));
  });

  /** An own MCP server of the workspace; `live` leaves out one whose OAuth hasn't come back (no secret yet). */
  const customById = async (deps: AppDeps, workspaceId: string, id: string, live = false) => {
    const row = await connectionById(deps, workspaceId, id);
    if (!row.custom || (live && row.status === "pending")) throw notFound("Server not found");
    return row;
  };

  app.post(`${WORKSPACE}/connectors/custom/:customId/refresh`, async (c) => {
    const me = requirePermission(c, "configure");
    const deps = c.get("deps");
    const row = await customById(deps, me.workspaceId, param(c, "customId"), true);
    return c.json(toCustomServer(await refreshCustom(deps, row)));
  });

  app.put(`${WORKSPACE}/connectors/custom/:customId/tools`, async (c) => {
    const me = requirePermission(c, "configure");
    const deps = c.get("deps");
    const row = await customById(deps, me.workspaceId, param(c, "customId"), true);
    const input = await readJson(c, toolsInput);
    return c.json(toCustomServer(await saveCustomTools(deps, row, input)));
  });

  app.delete(`${WORKSPACE}/connectors/custom/:customId`, async (c) => {
    const me = requirePermission(c, "configure");
    const deps = c.get("deps");
    await disconnect(deps, await customById(deps, me.workspaceId, param(c, "customId")));
    return c.body(null, 204);
  });

  // The extra scope step: the workspace authorizes what the service asked for (a workspace account: `configure`;
  // an agent's own account: whoever edits the agent).
  app.post(`${WORKSPACE}/connectors/:connectorId/scope`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const input = await readJson(c, z.object({ nextPath }));
    const row = await scopeTarget(deps, me.workspaceId, param(c, "connectorId"));
    if (!row) throw notFound("Connection not found");
    if (row.agentId) requireAgentEditor(me, await agentInWorkspace(deps.db, me.workspaceId, row.agentId));
    else if (!can(me.role, "configure")) throw forbidden();
    return c.json({ consentUrl: await startScopeStepUp(deps, withSession(c, me), row, input.nextPath) });
  });

  app.delete(`${WORKSPACE}/connectors/:connectorId`, async (c) => {
    const me = requirePermission(c, "configure");
    const deps = c.get("deps");
    await disconnect(deps, await connectionById(deps, me.workspaceId, param(c, "connectorId")));
    return c.body(null, 204);
  });

  // ---- GitHub App ----

  app.get(`${WORKSPACE}/github-app`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const rows = await installations(deps, me.workspaceId);
    return c.json({
      installable: deps.config.integrations.githubApp !== null,
      installations: rows.map(toInstallation),
    });
  });

  app.post(`${WORKSPACE}/github-app/install`, async (c) => {
    const me = withSession(c, requirePermission(c, "configure"));
    const input = await readJson(c, z.object({ nextPath }));
    return c.json({ installUrl: await installUrl(c.get("deps"), me, input.nextPath) });
  });

  app.delete(`${WORKSPACE}/github-app/installations/:installationId`, async (c) => {
    const me = requirePermission(c, "configure");
    await removeInstallation(c.get("deps"), me.workspaceId, param(c, "installationId"));
    return c.body(null, 204);
  });

  app.get(`${WORKSPACE}/github/repositories`, async (c) => {
    const me = requireMember(c);
    return c.json(await repositoriesOf(c.get("deps"), me.workspaceId));
  });

  // ---- The agent's access ----

  app.get(`${WORKSPACE}/agents/:agentId/repositories`, async (c) => {
    const me = requireMember(c);
    const agent = await agentInWorkspace(c.get("deps").db, me.workspaceId, param(c, "agentId"));
    return c.json({ repositories: agent.repositories });
  });

  app.put(`${WORKSPACE}/agents/:agentId/repositories`, async (c) => {
    const me = requirePermission(c, "manage_agents");
    const { db } = c.get("deps");
    const agent = await agentInWorkspace(db, me.workspaceId, param(c, "agentId"));
    const input = await readJson(
      c,
      z.object({
        repositories: z
          .array(z.string().trim().refine(isRepoPattern, { message: "Use owner/repo or owner/*" }))
          .max(200),
      }),
    );
    const repositories = [...new Set(input.repositories)];
    await db.update(agents).set({ repositories }).where(eq(agents.id, agent.id));
    return c.json({ repositories });
  });

  // ---- The agent's own identity (seam 7) ----

  app.get(`${WORKSPACE}/agents/:agentId/identity`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const agent = await agentInWorkspace(deps.db, me.workspaceId, param(c, "agentId"));
    return c.json(await identityOf(deps, agent, channelViewer(me)));
  });

  app.post(`${WORKSPACE}/agents/:agentId/identity/connections`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const agent = await agentInWorkspace(deps.db, me.workspaceId, param(c, "agentId"));
    requireAgentEditor(me, agent);
    if (agent.archivedAt) throw conflict("agent.archived", "This agent was archived");
    const input = await readJson(c, identityInput);
    return c.json(await connectIdentity(deps, withSession(c, me), agent, input));
  });

  // Revoking stays open on an archived agent: it only takes access away, and the archive doesn't disconnect.
  app.post(`${WORKSPACE}/agents/:agentId/identity/revoke`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const agent = await agentInWorkspace(deps.db, me.workspaceId, param(c, "agentId"));
    requireAgentEditor(me, agent);
    return c.json({ revoked: await revokeIdentity(deps, agent) });
  });

  app.put(`${WORKSPACE}/agents/:agentId/identity/channels`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const agent = await agentInWorkspace(deps.db, me.workspaceId, param(c, "agentId"));
    requireAgentEditor(me, agent);
    if (agent.archivedAt) throw conflict("agent.archived", "This agent was archived");
    const input = await readJson(c, channelRules);
    return c.json({ channels: await setChannelRules(deps, agent, input.channels, channelViewer(me)) });
  });

  app.get(`${WORKSPACE}/agents/:agentId/scopes`, async (c) => {
    const me = requireMember(c);
    const { db } = c.get("deps");
    const agent = await agentInWorkspace(db, me.workspaceId, param(c, "agentId"));
    return c.json({ scopes: await grantsOf(db, agent.id) });
  });

  app.put(`${WORKSPACE}/agents/:agentId/scopes`, async (c) => {
    const me = requirePermission(c, "manage_agents");
    const deps = c.get("deps");
    const agent = await agentInWorkspace(deps.db, me.workspaceId, param(c, "agentId"));
    const input = await readJson(c, z.object({ scopes: z.array(grant).max(500) }));
    const grants: ScopeGrant[] = validateGrants(input.scopes, await liveConnections(deps, me.workspaceId));
    await replaceGrants(deps.db, me.workspaceId, agent.id, grants);
    return c.json({ scopes: await grantsOf(deps.db, agent.id) });
  });

  app.get(`${WORKSPACE}/agents/:agentId/access`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const agent = await agentInWorkspace(deps.db, me.workspaceId, param(c, "agentId"));
    return c.json(await accessOf(deps, me.workspaceId, agent.id));
  });

  app.put(`${WORKSPACE}/agents/:agentId/access`, async (c) => {
    const me = requirePermission(c, "manage_agents");
    const deps = c.get("deps");
    const agent = await agentInWorkspace(deps.db, me.workspaceId, param(c, "agentId"));
    const input = await readJson(c, accessInput);
    const active = await liveConnections(deps, me.workspaceId);
    await replaceGrants(deps.db, me.workspaceId, agent.id, (current) =>
      validateGrants(applyAccessInput(current, input, active), active),
    );
    return c.json(await accessOf(deps, me.workspaceId, agent.id));
  });
}
