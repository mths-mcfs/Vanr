// The agent's email tools over the mailboxes the workspace gave it. The mailbox's policy (folders, senders, day
// window, recipients, send quota) holds on every call, and so does the run's channel: a channel rule on the
// mailbox (or on every connection) can only turn it off, leave it read-only or make every write ask a person.
// A send never goes out from here: it is queued in the outbox, with its undo window and its receipt.
//
// Effect class (seam 1): reading is K0 and raises A (the content comes from outside and the From is not
// authenticated); a draft and organizing are K1; sending, replying and forwarding are K2 for the workspace and
// whoever is already in the thread and K3 for a new address (destinations.ts); deleting is K3.
import { effectiveLevel } from "@vanr/engine/action-credential";
import { schema } from "@vanr/engine/db";
import type { Preview } from "@vanr/engine/effects";
import { randomId } from "@vanr/engine/ids";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { requireRuntime } from "../context";
import { queueSend } from "../outbox";
import { linksIn } from "../runtime/preview";
import { define, type ToolContext, type ToolDef, ToolInputError, type ToolPlan } from "../runtime/tools";
import { channelRulesOf } from "./access";
import { classifyRecipients, workspaceDomains } from "./destinations";
import type { ImapClient } from "./imap";
import { imapDate, quote } from "./imap";
import { folderByRole, type MailAccountRow, mailboxesOf, withImap } from "./mail";
import { actionMode, allowedBy, isAddress, type MailAction, WRITE_ACTIONS } from "./mail-rules";
import { buildMail, type ParsedMail, parseMail } from "./mime";
import { releaseUsage, reserveUsage } from "./usage";

const { mailConnections, outbox } = schema;
type MailboxRow = Awaited<ReturnType<typeof mailboxesOf>>[number];

const FOLDER = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[^\r\n\0"\\]+$/, "Invalid folder name");
const SEARCH_TEXT = z
  .string()
  .trim()
  .max(200)
  .transform((s) => s.replace(/[\r\n\0]/g, " "));
const ADDRESS = z.string().trim().toLowerCase().refine(isAddress, { message: "Use a full email address" });

/** What the mailbox tools read of a run: its agent, its workspace and the channel it runs in. */
type MailRun = Pick<ToolContext, "deps" | "agent" | "workspaceId" | "channel">;

interface Box {
  account: MailAccountRow;
  box: MailboxRow;
  /** The run's channel asks a person for every write on this mailbox. */
  channelAsks: boolean;
}

/**
 * The agent's own mailboxes, of the run's workspace, active and by IMAP, as the run's channel leaves them: a
 * channel can turn a mailbox off or leave it read-only, never widen it.
 */
async function boxesOf(ctx: MailRun): Promise<Box[]> {
  const boxes = (await mailboxesOf(ctx.deps.db, ctx.agent.id)).filter(
    (b) => b.level !== "none" && b.workspaceId === ctx.workspaceId,
  );
  if (boxes.length === 0) return [];
  const accounts = await ctx.deps.db
    .select()
    .from(mailConnections)
    .where(
      and(
        eq(mailConnections.workspaceId, ctx.workspaceId),
        inArray(
          mailConnections.id,
          boxes.map((b) => b.accountId),
        ),
        eq(mailConnections.status, "active"),
        eq(mailConnections.via, "imap"),
      ),
    );
  const rules = await channelRulesOf(ctx.deps.db, ctx.workspaceId, ctx.agent.id);
  return boxes.flatMap((box) => {
    const account = accounts.find((a) => a.id === box.accountId);
    if (!account) return [];
    const granted = box.level === "read_write" ? "write" : "read";
    const effective = effectiveLevel(granted, rules, ctx.channel.id, [account.id]);
    if (!effective) return [];
    const level = effective.level === "write" ? box.level : "read";
    return [{ account, box: { ...box, level }, channelAsks: effective.ask }];
  });
}

function modeOf(b: Box, action: MailAction, recipients?: string[]) {
  const mode = actionMode({
    action,
    level: b.box.level,
    deletable: b.box.deletable,
    policy: b.box.policy,
    disabledActions: b.account.disabledActions,
    confirmActions: b.account.confirmActions,
    recipients,
  });
  return mode === "run" && b.channelAsks && WRITE_ACTIONS.includes(action) ? "ask" : mode;
}

async function pick(ctx: MailRun, account: string, action: MailAction, recipients?: string[]) {
  const all = await boxesOf(ctx);
  const key = account.trim().toLowerCase();
  const found = all.find((b) => b.account.address === key || b.account.id === account);
  if (!found)
    throw new ToolInputError(
      `Unknown mailbox. Available: ${all.map((b) => b.account.address).join(", ") || "none"}`,
    );
  const mode = modeOf(found, action, recipients);
  if (mode === "off") throw new ToolInputError(`You can't ${action} in ${found.account.address}.`);
  return { ...found, mode };
}

function folderAllowed(policy: schema.MailPolicyRow, folder: string) {
  if (policy.folders.length > 0 && !policy.folders.includes(folder))
    throw new ToolInputError(`The folder ${folder} is not available. Allowed: ${policy.folders.join(", ")}`);
}

/**
 * A message inside the policy: its sender allowed (the strict one: a From that isn't one unambiguous mailbox
 * matches no list) and inside the day window.
 */
function visible(policy: schema.MailPolicyRow, mail: ParsedMail, now: Date): boolean {
  if (
    policy.senderAllowlist.length > 0 &&
    !(mail.fromAddress && allowedBy(policy.senderAllowlist, mail.fromAddress))
  )
    return false;
  // With a day window, a message without a readable date is outside it (fail closed).
  if (policy.lookbackDays !== null) {
    const at = mail.date ? new Date(mail.date).getTime() : Number.NaN;
    if (Number.isNaN(at) || now.getTime() - at > policy.lookbackDays * 86_400_000) return false;
  }
  return true;
}

async function readOne(
  imap: ImapClient,
  policy: schema.MailPolicyRow,
  folder: string,
  uid: number,
  now: Date,
  /** Opens the folder for writing: the change then acts on the message checked here, in the same selection. */
  writable = false,
) {
  folderAllowed(policy, folder);
  await imap.open(folder, !writable);
  const [msg] = await imap.fetch([uid], 262_144);
  if (!msg) throw new ToolInputError(`No message ${uid} in ${folder}.`);
  const mail = parseMail(msg.raw);
  if (!visible(policy, mail, now)) throw new ToolInputError("That message is outside what you can read.");
  return { mail, flags: msg.flags };
}

/**
 * Queues the send in the outbox (its undo window, its receipt in the conversation, the check of the mailbox
 * when it goes out). The day's quota is reserved first and comes back if the send is undone or fails.
 */
async function send(
  ctx: ToolContext,
  b: Box,
  mail: {
    to: string[];
    cc: string[];
    subject: string;
    text: string;
    inReplyTo?: string | null;
    references?: string | null;
  },
): Promise<string> {
  const reserved = await reserveUsage(ctx.deps, {
    workspaceId: ctx.workspaceId,
    agentId: ctx.agent.id,
    resourceId: b.account.id,
    kind: "mail_send",
    cap: b.box.policy.sendsPerDay,
  });
  if (!reserved)
    throw new ToolInputError(
      `Daily limit of ${b.box.policy.sendsPerDay} emails reached for ${b.account.address}.`,
    );
  const from = b.box.policy.senderAddress ?? b.account.address;
  const domain = from.slice(from.indexOf("@") + 1);
  try {
    const raw = buildMail({
      from,
      to: mail.to,
      cc: mail.cc,
      subject: mail.subject,
      text: mail.text,
      date: ctx.deps.now(),
      messageId: `<${randomId(20)}@${domain}>`,
      inReplyTo: mail.inReplyTo,
      references: mail.references,
    });
    await queueSend(ctx, {
      kind: "mail",
      payload: {
        accountId: b.account.id,
        envelope: { from, to: [...mail.to, ...mail.cc] },
        raw,
        usageId: reserved,
      },
      title: mail.to.join(", "),
    });
  } catch (err) {
    // Back only when nothing was queued: a send already in the outbox (its wake-up failed after the commit)
    // still goes out, and the outbox gives its reservation back if it is undone or fails.
    const [queued] = await ctx.deps.db
      .select({ id: outbox.id })
      .from(outbox)
      .where(and(eq(outbox.workspaceId, ctx.workspaceId), sql`${outbox.payload}->>'usageId' = ${reserved}`));
    if (!queued) await releaseUsage(ctx.deps, reserved);
    throw err;
  }
  const seconds = Math.round(ctx.deps.config.undoSendMs / 1000);
  return `Queued: the email to ${mail.to.join(", ")} goes out in ${seconds} s; the person who asked can undo it until then.`;
}

const account = z.string().min(1).max(254).describe("Mailbox address");

/**
 * The plan of a send: K2 if every recipient is of the workspace, of the thread or of the mailbox's list; K3 if
 * there is a new address (the destination is not allowed: without A it asks a person, with A the gate denies).
 * A mailbox in "ask" mode adds the request.
 */
async function outgoing(
  ctx: ToolContext,
  b: Box & { mode: "ask" | "run" },
  mail: { to: string[]; cc: string[]; subject: string; text: string; thread: string[] },
  card: { action: "send" | "reply" | "forward"; title: string; payload: Record<string, unknown> },
): Promise<ToolPlan> {
  // A send is queued by the outbox, whose wake-up is the runtime's: rejected here, before any approval is asked.
  requireRuntime(ctx.deps.runtime, "wakeAt");
  const all = [...mail.to, ...mail.cc];
  const { fresh } = classifyRecipients(all, {
    workspaceDomains: await workspaceDomains(ctx.deps.db, ctx.workspaceId),
    allowList: b.box.policy.recipientAllowlist,
    thread: mail.thread,
  });
  const from = b.box.policy.senderAddress ?? b.account.address;
  const preview: Preview = {
    title: card.title,
    body: `Subject: ${mail.subject}\n\n${mail.text}`,
    recipients: [...mail.to, ...mail.cc.map((c) => `cc: ${c}`)],
    links: linksIn(mail.text),
  };
  return {
    effect: fresh.length ? "K3" : "K2",
    destination: {
      kind: "external",
      allowed: fresh.length === 0,
      target: (fresh.length ? fresh : all).join(", "),
    },
    ...(b.mode === "ask" ? { policy: "ask" as const } : {}),
    payload: { from, to: mail.to, cc: mail.cc, subject: mail.subject, text: mail.text, ...card.payload },
    preview,
    card: {
      scope: `mail:${b.account.id}:${card.action}`,
      params: { from, to: mail.to, cc: mail.cc, subject: mail.subject },
    },
    // "Always allow" covers this mailbox and exactly these recipients (only in K2).
    ...(fresh.length === 0
      ? {
          rule: {
            key: `mail:${b.account.id}:${card.action}:${[...new Set(all.map((a) => a.toLowerCase()))].sort().join(",")}`,
            label: `${all.join(", ")} (${from})`,
          },
        }
      : {}),
  };
}

/** A write in "ask" mode (the account's or the channel's rule): the plan asks a person. */
const askedBy = (b: { mode: "ask" | "run" }): ToolPlan => (b.mode === "ask" ? { policy: "ask" } : {});

const READ_UNTRUSTED = (what: string) => [{ flag: "A" as const, source: what }];

const mailFolders = define({
  name: "mail_folders",
  description: "List the folders of a mailbox you can use.",
  effect: "K0",
  input: z.object({ account }),
  async run(ctx, input) {
    const b = await pick(ctx, input.account, "folders");
    const folders = await withImap(ctx.deps, b.account, (imap) => imap.folders());
    const allowed = b.box.policy.folders;
    // The names come from the mail server: they count as outside content for the run's next calls.
    return {
      content: folders
        .filter((f) => allowed.length === 0 || allowed.includes(f.name))
        .map((f) => `${f.name}${f.special ? ` (${f.special})` : ""}`)
        .join("\n"),
      reads: READ_UNTRUSTED(`mail_folders ${input.account}`),
    };
  },
});

const mailSearch = define({
  name: "mail_search",
  description: "Search a mailbox. Returns uid, date, sender and subject; read one with mail_read.",
  effect: "K0",
  input: z.object({
    account,
    folder: FOLDER.default("INBOX"),
    from: SEARCH_TEXT.optional(),
    subject: SEARCH_TEXT.optional(),
    text: SEARCH_TEXT.optional(),
    unreadOnly: z.boolean().default(false),
    sinceDays: z.number().int().min(1).max(3650).optional(),
    limit: z.number().int().min(1).max(30).default(10),
  }),
  async plan(_ctx, input) {
    return { raises: READ_UNTRUSTED(`mail_search ${input.account}/${input.folder}`) };
  },
  async run(ctx, input) {
    const b = await pick(ctx, input.account, "search");
    const { policy } = b.box;
    folderAllowed(policy, input.folder);
    const now = ctx.deps.now();
    const days = [input.sinceDays, policy.lookbackDays].filter((d): d is number => typeof d === "number");
    const criteria = [
      input.from ? `FROM ${quote(input.from)}` : "",
      input.subject ? `SUBJECT ${quote(input.subject)}` : "",
      input.text ? `TEXT ${quote(input.text)}` : "",
      input.unreadOnly ? "UNSEEN" : "",
      days.length ? `SINCE ${imapDate(new Date(now.getTime() - Math.min(...days) * 86_400_000))}` : "",
    ]
      .filter(Boolean)
      .join(" ");
    const lines = await withImap(ctx.deps, b.account, async (imap) => {
      await imap.open(input.folder, true);
      const uids = (await imap.search(criteria || "ALL")).slice(-200).reverse();
      const out: string[] = [];
      for (let i = 0; i < uids.length && out.length < input.limit; i += 20) {
        const batch = await imap.fetch(uids.slice(i, i + 20), 8_192);
        for (const m of batch.sort((x, y) => y.uid - x.uid)) {
          const mail = parseMail(m.raw);
          if (!visible(policy, mail, now)) continue;
          const unread = m.flags.includes("\\Seen") ? "" : " [unread]";
          out.push(`${m.uid}\t${mail.date ?? ""}\t${mail.from}\t${mail.subject}${unread}`);
          if (out.length >= input.limit) break;
        }
      }
      return out;
    });
    return lines.length ? `uid\tdate\tfrom\tsubject\n${lines.join("\n")}` : "No messages found.";
  },
});

const mailRead = define({
  name: "mail_read",
  description: "Read one message (text, sender, recipients, attachments by name).",
  effect: "K0",
  input: z.object({ account, folder: FOLDER.default("INBOX"), uid: z.number().int().positive() }),
  async plan(_ctx, input) {
    return { raises: READ_UNTRUSTED(`mail_read ${input.account}/${input.folder}/${input.uid}`) };
  },
  async run(ctx, input) {
    const b = await pick(ctx, input.account, "read");
    const { mail } = await withImap(ctx.deps, b.account, (imap) =>
      readOne(imap, b.box.policy, input.folder, input.uid, ctx.deps.now()),
    );
    return [
      `From: ${mail.from}`,
      `To: ${mail.to.join(", ")}`,
      ...(mail.cc.length ? [`Cc: ${mail.cc.join(", ")}`] : []),
      `Date: ${mail.date ?? ""}`,
      `Subject: ${mail.subject}`,
      ...(mail.attachments.length ? [`Attachments: ${mail.attachments.join(", ")}`] : []),
      "",
      mail.text,
    ].join("\n");
  },
});

const mailDraft = define({
  name: "mail_draft",
  description: "Save a draft in the mailbox for a person to review and send.",
  effect: "K1",
  input: z.object({
    account,
    to: z.array(ADDRESS).min(1).max(50),
    cc: z.array(ADDRESS).max(50).default([]),
    subject: z.string().max(300),
    text: z.string().max(50_000),
  }),
  async plan(ctx, input) {
    return askedBy(await pick(ctx, input.account, "draft"));
  },
  async run(ctx, input) {
    const b = await pick(ctx, input.account, "draft");
    const from = b.box.policy.senderAddress ?? b.account.address;
    const raw = buildMail({
      from,
      to: input.to,
      cc: input.cc,
      subject: input.subject,
      text: input.text,
      date: ctx.deps.now(),
      messageId: `<${randomId(20)}@${from.slice(from.indexOf("@") + 1)}>`,
    });
    const folder = await withImap(ctx.deps, b.account, async (imap) => {
      const drafts = await folderByRole(imap, "drafts", "Drafts");
      folderAllowed(b.box.policy, drafts);
      await imap.append(drafts, raw, "\\Draft \\Seen");
      return drafts;
    });
    return `Draft saved in ${folder}.`;
  },
});

const mailOrganize = define({
  name: "mail_organize",
  description: "Mark a message as read or flagged, or move it to another folder.",
  effect: "K1",
  input: z.object({
    account,
    folder: FOLDER.default("INBOX"),
    uid: z.number().int().positive(),
    markRead: z.boolean().optional(),
    flag: z.boolean().optional(),
    moveTo: FOLDER.optional(),
  }),
  async plan(ctx, input) {
    return askedBy(await pick(ctx, input.account, "organize"));
  },
  async run(ctx, input) {
    const b = await pick(ctx, input.account, "organize");
    if (input.moveTo) folderAllowed(b.box.policy, input.moveTo);
    await withImap(ctx.deps, b.account, async (imap) => {
      await readOne(imap, b.box.policy, input.folder, input.uid, ctx.deps.now(), true);
      if (input.markRead) await imap.addFlags(input.uid, "\\Seen");
      if (input.flag) await imap.addFlags(input.uid, "\\Flagged");
      if (input.moveTo) await imap.move(input.uid, input.moveTo);
    });
    return "Done.";
  },
});

const sendInput = z.object({
  account,
  to: z.array(ADDRESS).min(1).max(50),
  cc: z.array(ADDRESS).max(50).default([]),
  subject: z.string().max(300),
  text: z.string().min(1).max(50_000),
});

const mailSend = define({
  name: "mail_send",
  description: "Send a new email. A person approves it first unless the mailbox allows these recipients.",
  effect: "K2",
  input: sendInput,
  async plan(ctx, input) {
    const b = await pick(ctx, input.account, "send", [...input.to, ...input.cc]);
    return {
      ...(await outgoing(
        ctx,
        b,
        { ...input, thread: [] },
        { action: "send", title: `Send an email to ${input.to.join(", ")}`, payload: {} },
      )),
      editable: ["to", "cc", "subject", "text"],
    };
  },
  async run(ctx, input) {
    const b = await pick(ctx, input.account, "send", [...input.to, ...input.cc]);
    return send(ctx, b, { to: input.to, cc: input.cc, subject: input.subject, text: input.text });
  },
});

const replyInput = z.object({
  account,
  folder: FOLDER.default("INBOX"),
  uid: z.number().int().positive(),
  text: z.string().min(1).max(50_000),
  replyAll: z.boolean().default(false),
});

/** Who is already in the message's conversation: its sender (the strict one) and its recipients. */
const participants = (mail: ParsedMail) => [
  ...(mail.fromAddress ? [mail.fromAddress] : []),
  ...mail.to,
  ...mail.cc,
];

async function replyTarget(ctx: ToolContext, b: Box, input: z.infer<typeof replyInput>) {
  const { mail } = await withImap(ctx.deps, b.account, (imap) =>
    readOne(imap, b.box.policy, input.folder, input.uid, ctx.deps.now()),
  );
  // The reply goes to the one unambiguous sender: a From that hides another address gets no reply.
  if (!mail.fromAddress) throw new ToolInputError("That message has no single sender to reply to.");
  const self = b.account.address;
  const to = [mail.fromAddress].filter((a) => a !== self);
  if (to.length === 0)
    throw new ToolInputError("That message is from this mailbox; send a new email instead.");
  const cc = input.replyAll ? [...mail.to, ...mail.cc].filter((a) => a !== self && !to.includes(a)) : [];
  const subject = /^re:/i.test(mail.subject) ? mail.subject : `Re: ${mail.subject}`;
  return { mail, to, cc, subject };
}

const mailReply = define({
  name: "mail_reply",
  description: "Reply to a message. A person approves it first unless the mailbox allows these recipients.",
  effect: "K2",
  input: replyInput,
  async plan(ctx, input) {
    const first = await pick(ctx, input.account, "reply");
    const t = await replyTarget(ctx, first, input);
    const b = await pick(ctx, input.account, "reply", [...t.to, ...t.cc]);
    return {
      ...(await outgoing(
        ctx,
        b,
        { to: t.to, cc: t.cc, subject: t.subject, text: input.text, thread: participants(t.mail) },
        { action: "reply", title: `Reply to ${t.to.join(", ")}`, payload: { inReplyTo: t.mail.messageId } },
      )),
      editable: ["text"],
    };
  },
  async run(ctx, input) {
    const first = await pick(ctx, input.account, "reply");
    const t = await replyTarget(ctx, first, input);
    const b = await pick(ctx, input.account, "reply", [...t.to, ...t.cc]);
    const references = [t.mail.references, t.mail.messageId].filter(Boolean).join(" ") || null;
    return send(ctx, b, {
      to: t.to,
      cc: t.cc,
      subject: t.subject,
      text: input.text,
      inReplyTo: t.mail.messageId,
      references,
    });
  },
});

const forwardInput = z.object({
  account,
  folder: FOLDER.default("INBOX"),
  uid: z.number().int().positive(),
  to: z.array(ADDRESS).min(1).max(50),
  text: z.string().max(50_000).default(""),
});

/** The text a forward sends: the agent's note and the original message quoted. */
const forwardText = (mail: ParsedMail, text: string) =>
  [
    text,
    "",
    "---------- Forwarded message ---------",
    `From: ${mail.from}`,
    `Date: ${mail.date ?? ""}`,
    `Subject: ${mail.subject}`,
    `To: ${mail.to.join(", ")}`,
    "",
    mail.text,
  ].join("\n");

const forwardSubject = (mail: ParsedMail) =>
  /^fwd?:/i.test(mail.subject) ? mail.subject : `Fwd: ${mail.subject}`;

const mailForward = define({
  name: "mail_forward",
  description: "Forward a message. A person approves it first unless the mailbox allows these recipients.",
  effect: "K2",
  input: forwardInput,
  async plan(ctx, input) {
    const b = await pick(ctx, input.account, "forward", input.to);
    const { mail } = await withImap(ctx.deps, b.account, (imap) =>
      readOne(imap, b.box.policy, input.folder, input.uid, ctx.deps.now()),
    );
    return {
      ...(await outgoing(
        ctx,
        b,
        {
          to: input.to,
          cc: [],
          subject: forwardSubject(mail),
          text: forwardText(mail, input.text),
          thread: participants(mail),
        },
        {
          action: "forward",
          title: `Forward an email to ${input.to.join(", ")}`,
          payload: { messageId: mail.messageId, folder: input.folder, uid: input.uid },
        },
      )),
      editable: ["to", "text"],
    };
  },
  async run(ctx, input) {
    const b = await pick(ctx, input.account, "forward", input.to);
    const { mail } = await withImap(ctx.deps, b.account, (imap) =>
      readOne(imap, b.box.policy, input.folder, input.uid, ctx.deps.now()),
    );
    return send(ctx, b, {
      to: input.to,
      cc: [],
      subject: forwardSubject(mail),
      text: forwardText(mail, input.text),
    });
  },
});

const mailDelete = define({
  name: "mail_delete",
  description: "Move a message to the trash. A person always approves it first.",
  effect: "K3",
  input: z.object({ account, folder: FOLDER.default("INBOX"), uid: z.number().int().positive() }),
  async plan(ctx, input) {
    const b = await pick(ctx, input.account, "delete");
    const { mail } = await withImap(ctx.deps, b.account, (imap) =>
      readOne(imap, b.box.policy, input.folder, input.uid, ctx.deps.now()),
    );
    return {
      payload: {
        account: b.account.address,
        folder: input.folder,
        uid: input.uid,
        messageId: mail.messageId,
      },
      preview: {
        title: `Delete message ${input.uid} from ${input.folder}`,
        body: `From: ${mail.from}\nSubject: ${mail.subject}\n\n${mail.text.slice(0, 2000)}`,
      },
      card: {
        scope: `mail:${b.account.id}:delete`,
        params: { account: b.account.address, folder: input.folder, uid: input.uid },
      },
    };
  },
  async run(ctx, input) {
    const b = await pick(ctx, input.account, "delete");
    await withImap(ctx.deps, b.account, async (imap) => {
      const trash = await folderByRole(imap, "trash", "Trash");
      folderAllowed(b.box.policy, trash);
      await readOne(imap, b.box.policy, input.folder, input.uid, ctx.deps.now(), true);
      await imap.move(input.uid, trash);
    });
    return "Moved to the trash.";
  },
});

const ALL: readonly [MailAction, ToolDef<unknown>][] = [
  ["folders", mailFolders],
  ["search", mailSearch],
  ["read", mailRead],
  ["draft", mailDraft],
  ["organize", mailOrganize],
  ["send", mailSend],
  ["reply", mailReply],
  ["forward", mailForward],
  ["delete", mailDelete],
];

/** Only the tools some mailbox of the agent allows in the run's channel. */
export async function mailToolsFor(ctx: MailRun): Promise<ToolDef<unknown>[]> {
  const boxes = await boxesOf(ctx);
  if (boxes.length === 0) return [];
  return ALL.filter(([action]) => boxes.some((b) => modeOf(b, action, []) !== "off")).map(([, tool]) => tool);
}
