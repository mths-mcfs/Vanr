// The workspace's email, databases and storage, and what each agent gets of each one. Reading the list is for
// members; connecting, changing and disconnecting is `configure`; giving an agent a mailbox or a database (and
// listing a database's tables to choose from) is `manage_agents`. Every id in a path is looked up inside the
// caller's workspace: an id of another workspace is 404.
import type {
  ConnectImapInput,
  DatabaseConnectInput,
  DatabaseUpdateInput,
  S3Input,
  SetAgentDatabaseInput,
  SetAgentMailInput,
  StorageInput,
} from "@vanr/contract";
import { schema } from "@vanr/engine/db";
import { and, eq } from "drizzle-orm";
import type { Hono } from "hono";
import { z } from "zod";
import { agentInWorkspace } from "../agents";
import type { AppEnv, Ctx } from "../context";
import { param, readJson, unauthorized } from "../http";
import {
  connectDatabase,
  DB_ACTIONS,
  databaseById,
  databasePolicyInput,
  databasesOf,
  provider,
  setAgentDatabase,
  tablesOf,
  toAgentDatabase,
  toDatabaseConnection,
  updateDatabase,
} from "../integrations/databases";
import {
  connectComposio,
  connectImap,
  finishComposio,
  foldersOf,
  mailAccountById,
  mailAccountsOf,
  mailboxesOf,
  mailProviders,
  mailUpdateInput,
  setAgentMailbox,
  toMailAccount,
  toMailbox,
  updateMailAccount,
} from "../integrations/mail";
import { policyInput } from "../integrations/mail-rules";
import {
  saveStorage,
  startMigration,
  storageRow,
  testStorage,
  toStorageConfig,
} from "../integrations/storage";
import { requireMember, requirePermission, WORKSPACE } from "../workspace-scope";

const { mailConnections, agentMailboxes, dataSources, agentDatabases } = schema;

const host = z.string().trim().min(1).max(253);
const port = z.number().int().min(1).max(65_535);

const imapInput = z.object({
  preset: z.string().min(1).max(32),
  address: z.string().trim().min(3).max(254),
  password: z.string().min(1).max(500),
  username: z.string().trim().max(254).optional(),
  imapHost: host.optional(),
  imapPort: port.optional(),
  smtpHost: host.optional(),
  smtpPort: port.optional(),
}) satisfies z.ZodType<ConnectImapInput>;

const s3Input = z.object({
  endpoint: z.string().trim().min(1).max(500),
  region: z.string().trim().max(64),
  bucket: z.string().trim().min(3).max(63),
  prefix: z.string().trim().max(200).nullable(),
  pathAddressing: z.boolean(),
  accessKeyId: z.string().trim().min(1).max(200).optional(),
  secretAccessKey: z.string().trim().min(1).max(200).optional(),
}) satisfies z.ZodType<S3Input>;

const storageInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("builtin") }),
  z.object({ kind: z.literal("s3"), s3: s3Input }),
]) satisfies z.ZodType<StorageInput>;

const dbInput = z.object({
  provider,
  label: z.string().trim().max(120).optional(),
  url: z.string().trim().max(2000).optional(),
  host: host.optional(),
  port: port.optional(),
  database: z.string().trim().min(1).max(120).optional(),
  username: z.string().trim().min(1).max(120).optional(),
  password: z.string().max(500).optional(),
  sslmode: z.enum(["disable", "require", "verify-full"]).optional(),
}) satisfies z.ZodType<DatabaseConnectInput>;

const dbUpdateInput = z
  .object({
    label: z.string().trim().min(1).max(120),
    password: z.string().min(1).max(500),
    disabledActions: z.array(z.enum(DB_ACTIONS)).max(DB_ACTIONS.length),
  })
  .partial()
  .strict() satisfies z.ZodType<DatabaseUpdateInput>;

const agentMailInput = z.object({
  level: z.enum(["none", "read", "read_write"]),
  deletable: z.boolean().optional(),
  policy: policyInput.optional(),
}) satisfies z.ZodType<SetAgentMailInput>;

const agentDatabaseInput = z.object({
  level: z.enum(["none", "read"]),
  policy: databasePolicyInput.optional(),
}) satisfies z.ZodType<SetAgentDatabaseInput>;

/** The person who starts a hosted-mail round trip, with the session the callback must come back in. */
function starter(c: Ctx, permission: "configure") {
  const me = requirePermission(c, permission);
  const sessionId = c.get("sessionId");
  if (!sessionId) throw unauthorized();
  return { ...me, sessionId };
}

export function registerIntegrations(app: Hono<AppEnv>) {
  // ---- Email ----

  app.get(`${WORKSPACE}/mail/providers`, (c) => {
    requireMember(c);
    return c.json(mailProviders(c.get("deps")));
  });

  app.get(`${WORKSPACE}/mail/accounts`, async (c) => {
    const me = requireMember(c);
    return c.json({ accounts: await mailAccountsOf(c.get("deps").db, me.workspaceId) });
  });

  app.post(`${WORKSPACE}/mail/accounts/imap`, async (c) => {
    const me = requirePermission(c, "configure");
    const row = await connectImap(c.get("deps"), me, await readJson(c, imapInput));
    return c.json({ account: toMailAccount(row, []) }, 201);
  });

  app.post(`${WORKSPACE}/mail/accounts/composio`, async (c) => {
    const me = starter(c, "configure");
    const input = await readJson(
      c,
      z.object({ provider: z.enum(["gmail", "outlook"]), label: z.string().trim().max(120).optional() }),
    );
    return c.json(await connectComposio(c.get("deps"), me, input));
  });

  app.get("/api/v1/mail/composio/callback", async (c) => {
    const q = c.req.query();
    const to = await finishComposio(
      c.get("deps"),
      { userId: c.get("user")?.id ?? "", sessionId: c.get("sessionId") ?? "" },
      { state: q.state, status: q.status },
    );
    return new Response(null, { status: 302, headers: { location: to, "cache-control": "no-store" } });
  });

  app.patch(`${WORKSPACE}/mail/accounts/:accountId`, async (c) => {
    const me = requirePermission(c, "configure");
    const deps = c.get("deps");
    const row = await mailAccountById(deps.db, me.workspaceId, param(c, "accountId"));
    const updated = await updateMailAccount(deps, row, await readJson(c, mailUpdateInput));
    const boxes = await deps.db.select().from(agentMailboxes).where(eq(agentMailboxes.accountId, row.id));
    return c.json({ account: toMailAccount(updated, boxes) });
  });

  app.delete(`${WORKSPACE}/mail/accounts/:accountId`, async (c) => {
    const me = requirePermission(c, "configure");
    const { db } = c.get("deps");
    const row = await mailAccountById(db, me.workspaceId, param(c, "accountId"));
    await db
      .delete(mailConnections)
      .where(and(eq(mailConnections.id, row.id), eq(mailConnections.workspaceId, me.workspaceId)));
    return c.body(null, 204);
  });

  app.get(`${WORKSPACE}/mail/accounts/:accountId/folders`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const row = await mailAccountById(deps.db, me.workspaceId, param(c, "accountId"));
    return c.json({ folders: await foldersOf(deps, row) });
  });

  app.get(`${WORKSPACE}/agents/:agentId/mail`, async (c) => {
    const me = requireMember(c);
    const { db } = c.get("deps");
    const agent = await agentInWorkspace(db, me.workspaceId, param(c, "agentId"));
    return c.json({ mailboxes: (await mailboxesOf(db, agent.id)).map(toMailbox) });
  });

  app.put(`${WORKSPACE}/agents/:agentId/mail/:mailId`, async (c) => {
    const me = requirePermission(c, "manage_agents");
    const deps = c.get("deps");
    const agent = await agentInWorkspace(deps.db, me.workspaceId, param(c, "agentId"));
    const account = await mailAccountById(deps.db, me.workspaceId, param(c, "mailId"));
    const input = await readJson(c, agentMailInput);
    return c.json(toMailbox(await setAgentMailbox(deps, me.workspaceId, agent.id, account, input)));
  });

  // ---- Databases ----

  app.get(`${WORKSPACE}/databases`, async (c) => {
    const me = requireMember(c);
    return c.json({ connections: await databasesOf(c.get("deps").db, me.workspaceId) });
  });

  app.post(`${WORKSPACE}/databases`, async (c) => {
    const me = requirePermission(c, "configure");
    const row = await connectDatabase(c.get("deps"), me, await readJson(c, dbInput));
    return c.json({ connection: toDatabaseConnection(row, []) }, 201);
  });

  app.patch(`${WORKSPACE}/databases/:databaseId`, async (c) => {
    const me = requirePermission(c, "configure");
    const deps = c.get("deps");
    const row = await databaseById(deps.db, me.workspaceId, param(c, "databaseId"));
    const updated = await updateDatabase(deps, row, await readJson(c, dbUpdateInput));
    const links = await deps.db.select().from(agentDatabases).where(eq(agentDatabases.connectionId, row.id));
    return c.json({ connection: toDatabaseConnection(updated, links) });
  });

  app.delete(`${WORKSPACE}/databases/:databaseId`, async (c) => {
    const me = requirePermission(c, "configure");
    const { db } = c.get("deps");
    const row = await databaseById(db, me.workspaceId, param(c, "databaseId"));
    await db
      .delete(dataSources)
      .where(and(eq(dataSources.id, row.id), eq(dataSources.workspaceId, me.workspaceId)));
    return c.body(null, 204);
  });

  app.get(`${WORKSPACE}/databases/:databaseId/tables`, async (c) => {
    const me = requirePermission(c, "manage_agents");
    const deps = c.get("deps");
    const row = await databaseById(deps.db, me.workspaceId, param(c, "databaseId"));
    return c.json({ tables: await tablesOf(deps, row) });
  });

  app.get(`${WORKSPACE}/agents/:agentId/databases`, async (c) => {
    const me = requireMember(c);
    const { db } = c.get("deps");
    const agent = await agentInWorkspace(db, me.workspaceId, param(c, "agentId"));
    const rows = await db.select().from(agentDatabases).where(eq(agentDatabases.agentId, agent.id));
    return c.json({ databases: rows.map(toAgentDatabase) });
  });

  app.put(`${WORKSPACE}/agents/:agentId/databases/:databaseId`, async (c) => {
    const me = requirePermission(c, "manage_agents");
    const deps = c.get("deps");
    const agent = await agentInWorkspace(deps.db, me.workspaceId, param(c, "agentId"));
    const row = await databaseById(deps.db, me.workspaceId, param(c, "databaseId"));
    const input = await readJson(c, agentDatabaseInput);
    return c.json(toAgentDatabase(await setAgentDatabase(deps, me.workspaceId, agent.id, row, input)));
  });

  // ---- Storage ----

  app.get(`${WORKSPACE}/storage`, async (c) => {
    const me = requirePermission(c, "configure");
    return c.json(toStorageConfig(await storageRow(c.get("deps").db, me.workspaceId)));
  });

  app.post(`${WORKSPACE}/storage/test`, async (c) => {
    const me = requirePermission(c, "configure");
    return c.json(await testStorage(c.get("deps"), me.workspaceId, await readJson(c, s3Input)));
  });

  app.put(`${WORKSPACE}/storage`, async (c) => {
    const me = requirePermission(c, "configure");
    const input = await readJson(c, storageInput);
    return c.json(toStorageConfig(await saveStorage(c.get("deps"), me.workspaceId, input)));
  });

  app.post(`${WORKSPACE}/storage/migrate`, async (c) => {
    const me = requirePermission(c, "configure");
    const deps = c.get("deps");
    return c.json(await startMigration(deps, deps.localBlobs, me.workspaceId));
  });

  app.get(`${WORKSPACE}/storage/migration-status`, async (c) => {
    const me = requirePermission(c, "configure");
    return c.json(toStorageConfig(await storageRow(c.get("deps").db, me.workspaceId)).transfer);
  });
}
