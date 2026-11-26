// The workspace's mail accounts and each agent's mailbox. IMAP/SMTP with an app password (the path that works
// without a platform credential) or Composio when the installation has the key.
import type {
  AgentMailbox,
  ConnectImapInput,
  MailAccount,
  MailFolder,
  MailProviders,
  MailUpdateInput,
  SetAgentMailInput,
} from "@vanr/contract";
import { type Db, schema } from "@vanr/engine/db";
import { newId } from "@vanr/engine/ids";
import { createSealer, type Sealer } from "@vanr/engine/seal";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { AppDeps, WorkspaceMember } from "../context";
import { isUniqueViolation } from "../db-errors";
import { conflict, HttpError, notFound } from "../http";
import { log } from "../logger";
import { backTo, type Starter, saveState, takeState, type Viewer } from "./connectors";
import { ImapClient, ImapError, type ImapFolder } from "./imap";
import { defaultPolicy, isAddress, MAIL_ACTIONS, normalizePolicy, policyInput } from "./mail-rules";
import { assertReachableHost, netPolicy } from "./net";
import { outsideText } from "./outside-text";
import { SmtpError, type SmtpOptions, smtpSend } from "./smtp";

const { mailConnections, agentMailboxes } = schema;
export type MailAccountRow = typeof mailConnections.$inferSelect;
type MailboxRow = typeof agentMailboxes.$inferSelect;
type MailPolicyRow = schema.MailPolicyRow;

interface Preset {
  id: string;
  label: string;
  imap: { host: string; port: number };
  smtp: { host: string; port: number };
  appPasswordGuide: string | null;
}

// Each provider's public servers (each one's documentation, Oct/2026).
const MAIL_PRESETS: readonly Preset[] = [
  {
    id: "gmail",
    label: "Gmail",
    imap: { host: "imap.gmail.com", port: 993 },
    smtp: { host: "smtp.gmail.com", port: 465 },
    appPasswordGuide: "https://myaccount.google.com/apppasswords",
  },
  {
    id: "outlook",
    label: "Outlook",
    imap: { host: "outlook.office365.com", port: 993 },
    smtp: { host: "smtp.office365.com", port: 587 },
    appPasswordGuide: "https://account.live.com/proofs/AppPassword",
  },
  {
    id: "icloud",
    label: "iCloud",
    imap: { host: "imap.mail.me.com", port: 993 },
    smtp: { host: "smtp.mail.me.com", port: 587 },
    appPasswordGuide: "https://account.apple.com",
  },
  {
    id: "yahoo",
    label: "Yahoo",
    imap: { host: "imap.mail.yahoo.com", port: 993 },
    smtp: { host: "smtp.mail.yahoo.com", port: 465 },
    appPasswordGuide: "https://login.yahoo.com/account/security",
  },
  {
    id: "fastmail",
    label: "Fastmail",
    imap: { host: "imap.fastmail.com", port: 993 },
    smtp: { host: "smtp.fastmail.com", port: 465 },
    appPasswordGuide: "https://app.fastmail.com/settings/security/apps",
  },
  {
    id: "zoho",
    label: "Zoho",
    imap: { host: "imap.zoho.com", port: 993 },
    smtp: { host: "smtp.zoho.com", port: 465 },
    appPasswordGuide: null,
  },
];

const smtpSecurity = z.enum(["none", "tls", "starttls"]) satisfies z.ZodType<SmtpOptions["security"]>;

/** The IMAP account's secret (sealed in the database). */
const imapSecret = z.object({
  via: z.literal("imap"),
  imap: z.object({ host: z.string(), port: z.number(), secure: z.boolean() }),
  smtp: z.object({ host: z.string(), port: z.number(), security: smtpSecurity }),
  username: z.string(),
  password: z.string(),
});
type ImapSecret = z.infer<typeof imapSecret>;
const composioSecret = z.object({ via: z.literal("composio"), connectedAccountId: z.string().nullable() });
type ComposioSecret = z.infer<typeof composioSecret>;
const mailSecret = z.discriminatedUnion("via", [imapSecret, composioSecret]);
type MailSecret = z.infer<typeof mailSecret>;

const mailSealer = (deps: AppDeps): Sealer => createSealer(deps.config.authSecret, "mail");
/** Opens what this module sealed and checks its shape: a row that doesn't match is not trusted. */
const openSecret = (deps: AppDeps, row: MailAccountRow): MailSecret | null =>
  row.secret ? mailSecret.parse(JSON.parse(mailSealer(deps).open(row.secret))) : null;

export function mailProviders(deps: AppDeps): MailProviders {
  const cfg = deps.config.integrations.composio;
  return {
    // Only the provider with an auth config: without it, `connectComposio` rejects (mail.composio_unavailable).
    composio: cfg ? (["gmail", "outlook"] as const).filter((p) => !!cfg.authConfigs[p]) : [],
    imap: true,
    presets: [
      ...MAIL_PRESETS.map((p) => ({
        id: p.id,
        label: p.label,
        host: p.imap.host,
        port: p.imap.port,
        appPasswordGuide: p.appPasswordGuide,
      })),
      { id: "other", label: "Other", host: "", port: 993, appPasswordGuide: null },
    ],
  };
}

export function toMailAccount(row: MailAccountRow, boxes: readonly MailboxRow[]): MailAccount {
  return {
    id: row.id,
    provider: row.provider,
    preset: row.preset,
    via: row.via,
    address: row.address,
    label: row.label,
    status: row.status,
    disabledActions: row.disabledActions,
    confirmActions: row.confirmActions,
    agents: boxes.filter((b) => b.accountId === row.id).map((b) => ({ agentId: b.agentId, level: b.level })),
  };
}

export const toMailbox = (row: MailboxRow): AgentMailbox => ({
  accountId: row.accountId,
  level: row.level,
  deletable: row.deletable,
  policy: row.policy,
});

export async function mailAccountsOf(db: Db, workspaceId: string) {
  const rows = await db
    .select()
    .from(mailConnections)
    .where(eq(mailConnections.workspaceId, workspaceId))
    .orderBy(mailConnections.createdAt);
  const boxes = rows.length
    ? await db
        .select()
        .from(agentMailboxes)
        .where(
          inArray(
            agentMailboxes.accountId,
            rows.map((r) => r.id),
          ),
        )
    : [];
  return rows.map((r) => toMailAccount(r, boxes));
}

export async function mailAccountById(db: Db, workspaceId: string, id: string): Promise<MailAccountRow> {
  const [row] = await db
    .select()
    .from(mailConnections)
    .where(and(eq(mailConnections.workspaceId, workspaceId), eq(mailConnections.id, id)));
  if (!row) throw notFound("Mail account not found");
  return row;
}

/**
 * How to talk to the server. Loopback with the local network allowed (test server, local bridge) goes without
 * TLS; the rest uses TLS on IMAP and, on SMTP, direct TLS on 465 and STARTTLS on the others.
 */
async function transport(
  host: string,
  imapPort: number,
  smtpHost: string,
  smtpPort: number,
  allowPrivate: boolean,
) {
  await assertReachableHost(host, allowPrivate, "mail.blocked_host");
  await assertReachableHost(smtpHost, allowPrivate, "mail.blocked_host");
  const loop = (h: string) => allowPrivate && (h === "localhost" || h === "::1" || /^127\./.test(h));
  const security: SmtpOptions["security"] = loop(smtpHost) ? "none" : smtpPort === 465 ? "tls" : "starttls";
  return {
    imap: { host, port: imapPort, secure: !loop(host) },
    smtp: { host: smtpHost, port: smtpPort, security },
  };
}

/** Every form of the account's password a mail server could echo back (IMAP LOGIN quotes it, AUTH PLAIN and
 * LOGIN send it in base64, alone or with the user). */
function mailSecrets(secret: Pick<ImapSecret, "username" | "password">): string[] {
  const { username: u, password: p } = secret;
  return [p, p.replace(/\\/g, "\\\\").replace(/"/g, '\\"'), `\0${u}\0${p}`, `${u}\0${p}`, `${u}:${p}`];
}

/** The mail server couldn't be used: its own words, without the password we sent it. */
const mailUnreachable = (err: unknown, secret: Pick<ImapSecret, "username" | "password">) =>
  new HttpError(400, "mail.unreachable", outsideText(err, mailSecrets(secret)) || "Mail server unreachable");

/** Opens the account's IMAP session; a rejected login marks the account to reconnect. */
export async function withImap<T>(
  deps: AppDeps,
  row: MailAccountRow,
  fn: (imap: ImapClient, secret: ImapSecret) => Promise<T>,
): Promise<T> {
  const secret = openSecret(deps, row);
  if (secret?.via !== "imap")
    throw new HttpError(400, "mail.unsupported", "This account is not connected by IMAP");
  let imap: ImapClient | null = null;
  try {
    imap = await ImapClient.open({
      ...imapOf(deps, secret),
      user: secret.username,
      password: secret.password,
    });
    await imap.login();
    return await fn(imap, secret);
  } catch (err) {
    if (err instanceof ImapError && err.kind === "auth") {
      await deps.db
        .update(mailConnections)
        .set({ status: "reauth_required" })
        .where(eq(mailConnections.id, row.id));
      throw new HttpError(400, "mail.auth", "The mail server rejected the password");
    }
    if (err instanceof ImapError || err instanceof SmtpError) throw mailUnreachable(err, secret);
    throw err;
  } finally {
    await imap?.close();
  }
}

/**
 * The kept server is checked again on every connection (the name can start pointing at the internal network
 * after it was connected) and the connection goes to the checked IP.
 */
// The clients resolve the host once, check it and the TLS rule, and connect to the IP they checked.
const imapOf = (deps: AppDeps, secret: ImapSecret) => ({
  ...secret.imap,
  policy: netPolicy(deps.config.integrations),
});

const smtpOf = (deps: AppDeps, secret: ImapSecret): SmtpOptions => ({
  ...secret.smtp,
  policy: netPolicy(deps.config.integrations),
  user: secret.username,
  password: secret.password,
});

export async function folderByRole(imap: ImapClient, role: "sent" | "drafts" | "trash", fallback: string) {
  const folders = await imap.folders();
  return folders.find((f) => f.special === role)?.name ?? fallback;
}

/** Errors of sends that had already gone out when they failed (the error stays the one that happened). */
const sentOutErrors = new WeakSet<Error>();

/**
 * Sends through the account's SMTP and keeps the copy in Sent (servers like Gmail already do it). A failure
 * says whether the message got out: a failure before that gives the quota back; after it, it doesn't.
 */
export async function transmitMail(
  deps: AppDeps,
  account: MailAccountRow,
  envelope: { from: string; to: string[] },
  raw: string,
): Promise<void> {
  let sentOut = false;
  try {
    await withImap(deps, account, async (imap, secret) => {
      await smtpSend(smtpOf(deps, secret), envelope, raw);
      sentOut = true;
      if (account.provider !== "gmail") {
        const sent = await folderByRole(imap, "sent", "Sent");
        await imap.append(sent, raw).catch(() => {});
      }
    });
  } catch (err) {
    const failure = err instanceof Error ? err : new Error(String(err));
    if (sentOut) sentOutErrors.add(failure);
    throw failure;
  }
}

/** Did the failure come after SMTP accepted (the copy in Sent, the IMAP session closing)? */
export const sentOutOf = (err: unknown) => err instanceof Error && sentOutErrors.has(err);

export async function connectImap(
  deps: AppDeps,
  me: WorkspaceMember,
  input: ConnectImapInput,
): Promise<MailAccountRow> {
  const address = input.address.trim().toLowerCase();
  if (!isAddress(address)) throw new HttpError(400, "mail.invalid_address", "Use a full e-mail address");
  const preset = MAIL_PRESETS.find((p) => p.id === input.preset);
  if (!preset && input.preset !== "other")
    throw new HttpError(400, "mail.unknown_preset", "Unknown provider");
  if (!preset && (!input.imapHost || !input.smtpHost))
    throw new HttpError(400, "mail.servers_required", "Enter the IMAP and SMTP servers");
  const t = await transport(
    preset?.imap.host ?? input.imapHost ?? "",
    preset?.imap.port ?? input.imapPort ?? 993,
    preset?.smtp.host ?? input.smtpHost ?? "",
    preset?.smtp.port ?? input.smtpPort ?? 587,
    deps.config.integrations.allowPrivateNetworks,
  );
  const secret: ImapSecret = {
    via: "imap",
    ...t,
    username: input.username?.trim() || address,
    password: input.password,
  };
  // Checks the password before keeping it: logs in and lists the folders.
  let imap: ImapClient | null = null;
  try {
    imap = await ImapClient.open({
      ...imapOf(deps, secret),
      user: secret.username,
      password: secret.password,
    });
    await imap.login();
    await imap.folders();
  } catch (err) {
    if (err instanceof ImapError && err.kind === "auth")
      throw new HttpError(400, "mail.auth", "The mail server rejected the password");
    throw mailUnreachable(err, secret);
  } finally {
    await imap?.close();
  }
  const at = deps.now();
  try {
    const [row] = await deps.db
      .insert(mailConnections)
      .values({
        id: newId("mail"),
        workspaceId: me.workspaceId,
        provider: preset?.id ?? "other",
        preset: input.preset,
        via: "imap",
        address,
        label: address,
        status: "active",
        secret: mailSealer(deps).seal(JSON.stringify(secret)),
        createdBy: me.userId,
        createdAt: at,
        updatedAt: at,
      })
      .returning();
    if (!row) throw new Error("mail account insert failed");
    return row;
  } catch (err) {
    if (isUniqueViolation(err))
      throw conflict("mail.exists", "This address is already connected", { address });
    throw err;
  }
}

const composioStart = z.object({ id: z.string(), redirect_url: z.string().url() });

/**
 * Composio: creates the connected account and returns the authorization link. The callback verifies
 * authorization and the authenticated mailbox before marking it active.
 */
export async function connectComposio(
  deps: AppDeps,
  me: Starter,
  input: { provider: "gmail" | "outlook"; label?: string },
): Promise<{ accountId: string; redirectUrl: string }> {
  const cfg = deps.config.integrations.composio;
  const authConfig = cfg?.authConfigs[input.provider];
  if (!cfg || !authConfig)
    throw new HttpError(400, "mail.composio_unavailable", "Composio is not set up on this server");
  const accountId = newId("mail");
  const state = await saveState(deps, me, {
    kind: "mail",
    targetId: accountId,
    nextPath: "",
    ttlMs: 30 * 60_000,
  });
  const callback = `${deps.config.publicUrl}/api/v1/mail/composio/callback?state=${state}`;
  let started: z.infer<typeof composioStart>;
  try {
    const res = await deps.fetchExternal(`${cfg.apiUrl}/api/v3/connected_accounts`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": cfg.apiKey },
      body: JSON.stringify({
        auth_config: { id: authConfig },
        connection: { user_id: accountId, callback_url: callback },
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Composio answered ${res.status}`);
    started = composioStart.parse(await res.json());
  } catch (err) {
    log.warn("mail.composio_failed", { error: outsideText(err, [cfg.apiKey]) });
    throw new HttpError(502, "mail.composio_failed", "Could not start the connection");
  }
  const at = deps.now();
  const secret: ComposioSecret = { via: "composio", connectedAccountId: started.id };
  await deps.db.insert(mailConnections).values({
    id: accountId,
    workspaceId: me.workspaceId,
    provider: input.provider,
    preset: null,
    via: "composio",
    address: `pending:${accountId}`,
    label: input.label?.trim() || input.provider,
    status: "pending",
    secret: mailSealer(deps).seal(JSON.stringify(secret)),
    createdBy: me.userId,
    createdAt: at,
    updatedAt: at,
  });
  return { accountId, redirectUrl: started.redirect_url };
}

export async function finishComposio(
  deps: AppDeps,
  viewer: Viewer,
  query: { state?: string; status?: string },
): Promise<string> {
  const taken = await takeState(deps, "mail", query.state, viewer);
  if (!taken.row?.targetId) return "/?mail_error=state";
  const st = taken.row;
  const back = (p: string) => backTo(st, p);
  if (!taken.ok) return back("mail_error=state");
  const account = and(
    eq(mailConnections.id, st.targetId ?? ""),
    eq(mailConnections.workspaceId, st.workspaceId),
  );
  if (query.status !== "success") {
    await deps.db.delete(mailConnections).where(account);
    return back("mail_error=denied");
  }
  const [pending] = await deps.db.select().from(mailConnections).where(account);
  if (pending?.status !== "pending") return back("mail_error=state");
  const cfg = deps.config.integrations.composio;
  const secret = openSecret(deps, pending);
  if (!cfg || secret?.via !== "composio" || !secret.connectedAccountId) return back("mail_error=state");
  try {
    const provider = z.enum(["gmail", "outlook"]).parse(pending.provider);
    const headers = { "content-type": "application/json", "x-api-key": cfg.apiKey };
    const res = await deps.fetchExternal(
      `${cfg.apiUrl}/api/v3/connected_accounts/${encodeURIComponent(secret.connectedAccountId)}`,
      { headers, signal: AbortSignal.timeout(15_000) },
    );
    if (!res.ok) throw new Error("Could not verify the connected account");
    const remote = z
      .object({
        id: z.literal(secret.connectedAccountId),
        user_id: z.literal(pending.id),
        status: z.literal("ACTIVE"),
        is_disabled: z.literal(false),
        toolkit: z.object({ slug: z.literal(pending.provider) }),
        auth_config: z.object({ id: z.literal(cfg.authConfigs[provider] ?? "") }),
      })
      .parse(await res.json());
    const gmail = provider === "gmail";
    const profile = await deps.fetchExternal(`${cfg.apiUrl}/api/v3/tools/execute/proxy`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        connected_account_id: remote.id,
        user_id: pending.id,
        method: "GET",
        endpoint: gmail
          ? "https://gmail.googleapis.com/gmail/v1/users/me/profile"
          : "https://graph.microsoft.com/v1.0/me?$select=mail",
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!profile.ok) throw new Error("Could not verify the mailbox");
    const result = z
      .object({
        status: z.literal(200),
        data: z.object({ emailAddress: z.string().optional(), mail: z.string().nullable().optional() }),
      })
      .parse(await profile.json());
    const address = (gmail ? result.data.emailAddress : result.data.mail)?.trim().toLowerCase();
    if (!address || !isAddress(address)) throw new Error("The mailbox has no valid email address");
    const [row] = await deps.db
      .update(mailConnections)
      .set({ address, status: "active", updatedAt: deps.now() })
      .where(and(account, eq(mailConnections.status, "pending")))
      .returning({ id: mailConnections.id });
    return row ? back(`mail_connected=${row.id}`) : back("mail_error=state");
  } catch {
    return back("mail_error=unverified");
  }
}

const ACTION = z.enum(MAIL_ACTIONS);
export const mailUpdateInput = z
  .object({
    label: z.string().trim().min(1).max(120),
    password: z.string().min(1).max(500),
    disabledActions: z.array(ACTION).max(MAIL_ACTIONS.length),
    confirmActions: z.array(ACTION).max(MAIL_ACTIONS.length),
  })
  .partial()
  .strict();

export async function updateMailAccount(
  deps: AppDeps,
  row: MailAccountRow,
  input: MailUpdateInput,
): Promise<MailAccountRow> {
  const set: Partial<typeof mailConnections.$inferInsert> = { updatedAt: deps.now() };
  if (input.label !== undefined) set.label = input.label;
  if (input.disabledActions) set.disabledActions = [...new Set(input.disabledActions)];
  if (input.confirmActions) set.confirmActions = [...new Set(input.confirmActions)];
  if (input.password !== undefined) {
    const secret = openSecret(deps, row);
    if (secret?.via !== "imap") throw new HttpError(400, "mail.unsupported", "This account has no password");
    const next: ImapSecret = { ...secret, password: input.password };
    let imap: ImapClient | null = null;
    try {
      imap = await ImapClient.open({
        ...imapOf(deps, next),
        user: next.username,
        password: next.password,
      });
      await imap.login();
    } catch (err) {
      if (err instanceof ImapError && err.kind === "auth")
        throw new HttpError(400, "mail.auth", "The mail server rejected the password");
      throw mailUnreachable(err, next);
    } finally {
      await imap?.close();
    }
    set.secret = mailSealer(deps).seal(JSON.stringify(next));
    set.status = "active";
  }
  const [updated] = await deps.db
    .update(mailConnections)
    .set(set)
    .where(eq(mailConnections.id, row.id))
    .returning();
  return updated ?? row;
}

const ROLE: Record<NonNullable<ImapFolder["special"]>, MailFolder["role"]> = {
  inbox: "inbox",
  sent: "sent",
  drafts: "drafts",
  trash: "trash",
  archive: "archive",
  junk: "other",
};

const toFolder = (f: ImapFolder): MailFolder => ({
  id: f.name,
  name: f.name,
  role: f.special ? ROLE[f.special] : "other",
});

export async function foldersOf(deps: AppDeps, row: MailAccountRow): Promise<MailFolder[]> {
  return withImap(deps, row, async (imap) => (await imap.folders()).map(toFolder));
}

export async function mailboxesOf(db: Db, agentId: string): Promise<MailboxRow[]> {
  return db.select().from(agentMailboxes).where(eq(agentMailboxes.agentId, agentId));
}

export async function setAgentMailbox(
  deps: AppDeps,
  workspaceId: string,
  agentId: string,
  account: MailAccountRow,
  input: SetAgentMailInput,
): Promise<MailboxRow> {
  const [current] = await deps.db
    .select()
    .from(agentMailboxes)
    .where(and(eq(agentMailboxes.agentId, agentId), eq(agentMailboxes.accountId, account.id)));
  const parsed = input.policy ? policyInput.parse(input.policy) : {};
  const policy: MailPolicyRow = normalizePolicy({ ...(current?.policy ?? defaultPolicy()), ...parsed });
  if (policy.senderAddress && policy.senderAddress !== account.address)
    throw new HttpError(400, "mail.from_not_allowed", "Send from the account address", {
      address: account.address,
    });
  const values = {
    level: input.level,
    deletable: input.level === "read_write" ? (input.deletable ?? current?.deletable ?? false) : false,
    policy,
  };
  const [row] = await deps.db
    .insert(agentMailboxes)
    .values({ agentId, accountId: account.id, workspaceId, ...values })
    .onConflictDoUpdate({ target: [agentMailboxes.agentId, agentMailboxes.accountId], set: values })
    .returning();
  if (!row) throw new Error("mailbox upsert failed");
  return row;
}
