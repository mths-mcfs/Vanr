// Allowed email destinations: workspace domains and the mailbox admin's list count as known.
// A new address is an irreversible effect (K3) and, in a run that read outside content, it is denied.
//
// "Of the workspace": domain of a workspace mailbox or of a member's email (except the public
// providers, where the domain says nothing). External thread participants make neither address nor
// domain known. The list the admin allowed on the mailbox (`recipientAllowlist`) also counts.
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
  "mail.ru",
  "inbox.ru",
  "list.ru",
  "bk.ru",
  "yandex.ru",
  "yandex.com",
  "ya.ru",
  "fastmail.com",
  "fastmail.fm",
  "protonmail.ch",
  "pm.me",
  "gmx.net",
  "gmx.de",
  "mac.com",
  "zohomail.com",
  "aim.com",
  "hey.com",
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
  /** Participants of the message replied to or forwarded; they do not grant recipient trust. */
  thread: readonly string[];
}

/** Splits the recipients into known (workspace domains, admin list) and new. */
export function classifyRecipients(
  recipients: readonly string[],
  known: KnownRecipients,
): { known: string[]; fresh: string[] } {
  const allow = known.allowList.map((e) => e.toLowerCase());
  const ok = (raw: string) => {
    const a = raw.toLowerCase();
    const d = domainOf(a);
    return known.workspaceDomains.has(d) || allow.some((e) => e === a || e === `@${d}`);
  };
  const out = { known: [] as string[], fresh: [] as string[] };
  for (const r of recipients) (ok(r) ? out.known : out.fresh).push(r);
  return out;
}
