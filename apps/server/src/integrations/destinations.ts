// Allowed email destinations: the agent sends to the workspace or to whoever is already in the
// conversation; a new address is an irreversible effect (K3) and, in a run that read outside content, it is denied.
//
// "Of the workspace": domain of a workspace mailbox or of a member's email (except the public
// providers, where the domain says nothing). "Of the thread": sender and recipients of the message being
// replied to or forwarded; their domain also counts, except for a public provider (then only the
// exact address). The list the admin allowed on the mailbox (`recipientAllowlist`) also counts.
import { type Db, schema } from "@vanr/engine/db";
import { eq } from "drizzle-orm";

const { mailConnections, members, users } = schema;

/** Providers where the domain belongs to everyone: only the exact address identifies the person. */
export const PUBLIC_MAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "yahoo.com",
  "yahoo.com.br",
  "icloud.com",
  "me.com",
  "proton.me",
  "protonmail.com",
  "aol.com",
  "gmx.com",
  "zoho.com",
  "uol.com.br",
  "bol.com.br",
  "terra.com.br",
  "ig.com.br",
]);

export const domainOf = (address: string) => address.slice(address.lastIndexOf("@") + 1).toLowerCase();

/** Domains of the workspace: of the mailboxes and of the members' emails (no public provider). */
export async function workspaceDomains(db: Db, workspaceId: string): Promise<Set<string>> {
  const boxes = await db
    .select({ address: mailConnections.address })
    .from(mailConnections)
    .where(eq(mailConnections.workspaceId, workspaceId));
  const people = await db
    .select({ email: users.email })
    .from(members)
    .innerJoin(users, eq(users.id, members.userId))
    .where(eq(members.workspaceId, workspaceId));
  const out = new Set<string>();
  for (const a of [...boxes.map((b) => b.address), ...people.map((p) => p.email)]) {
    const d = domainOf(a);
    if (d && !PUBLIC_MAIL_DOMAINS.has(d)) out.add(d);
  }
  return out;
}

export interface KnownRecipients {
  workspaceDomains: ReadonlySet<string>;
  /** The mailbox list allowed by the admin (address or `@domain`); empty allows nobody here. */
  allowList: readonly string[];
  /** Participants of the message replied to or forwarded. */
  thread: readonly string[];
}

/** Splits the recipients into known (workspace, thread, admin list) and new. */
export function classifyRecipients(
  recipients: readonly string[],
  known: KnownRecipients,
): { known: string[]; fresh: string[] } {
  const thread = new Set(known.thread.map((a) => a.toLowerCase()));
  const threadDomains = new Set([...thread].map(domainOf).filter((d) => d && !PUBLIC_MAIL_DOMAINS.has(d)));
  const allow = known.allowList.map((e) => e.toLowerCase());
  const ok = (raw: string) => {
    const a = raw.toLowerCase();
    const d = domainOf(a);
    return (
      known.workspaceDomains.has(d) ||
      thread.has(a) ||
      threadDomains.has(d) ||
      allow.some((e) => e === a || e === `@${d}`)
    );
  };
  const out = { known: [] as string[], fresh: [] as string[] };
  for (const r of recipients) (ok(r) ? out.known : out.fresh).push(r);
  return out;
}
