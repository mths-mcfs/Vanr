// Pure rules of the agents' email: addresses, access policy and what each action requires.
import type { schema } from "@vanr/engine/db";
import { z } from "zod";

const ADDRESS = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/;
const DOMAIN = /^@[^\s@,;<>"]+\.[^\s@,;<>"]+$/;

type MailPolicyRow = schema.MailPolicyRow;

export const isAddress = (s: string) => ADDRESS.test(s);
export const isAddressOrDomain = (s: string) => ADDRESS.test(s) || DOMAIN.test(s);

export const addressOrDomain = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .refine(isAddressOrDomain, { message: "Use name@domain.com or @domain.com" });

/** Does the address match the list (exact address or @domain)? An empty list = anyone. */
export function allowedBy(list: readonly string[], address: string): boolean {
  if (list.length === 0) return true;
  const a = address.toLowerCase();
  const domain = a.slice(a.indexOf("@"));
  return list.some((entry) => entry === a || entry === domain);
}

export const MAIL_ACTIONS = [
  "search",
  "read",
  "folders",
  "draft",
  "organize",
  "send",
  "reply",
  "forward",
  "delete",
] as const;
export type MailAction = (typeof MAIL_ACTIONS)[number];

/** What needs write access to the mailbox; the rest is read access. */
export const WRITE_ACTIONS: readonly MailAction[] = [
  "draft",
  "organize",
  "send",
  "reply",
  "forward",
  "delete",
];
/** They leave the mailbox: they ask for approval, unless the policy allows known recipients. */
export const OUTGOING: readonly MailAction[] = ["send", "reply", "forward"];

export function defaultPolicy(): MailPolicyRow {
  return {
    folders: [],
    senderAllowlist: [],
    lookbackDays: null,
    recipientAllowlist: [],
    sendsPerDay: 25,
    autoSend: false,
    senderAddress: null,
  };
}

/** With no allowed recipients, sending without asking does not apply. */
export function normalizePolicy(p: MailPolicyRow): MailPolicyRow {
  return { ...p, autoSend: p.autoSend && p.recipientAllowlist.length > 0 };
}

export const policyInput = z
  .object({
    folders: z.array(z.string().trim().min(1).max(200)).max(50),
    senderAllowlist: z.array(addressOrDomain).max(200),
    lookbackDays: z.number().int().min(1).max(3650).nullable(),
    recipientAllowlist: z.array(addressOrDomain).max(200),
    sendsPerDay: z.number().int().min(0).max(1000),
    autoSend: z.boolean(),
    senderAddress: z
      .string()
      .trim()
      .toLowerCase()
      .refine(isAddress, { message: "Use a full address" })
      .nullable(),
  })
  .partial()
  .strict();

/**
 * How the action runs for this agent: `off` (disabled on the account or no level), `ask` (approval)
 * or `run`. Sending asks for approval, unless every recipient is allowed and the policy says to
 * send without asking. Deleting requires "can delete" and always asks.
 */
export function actionMode(input: {
  action: MailAction;
  level: "none" | "read" | "read_write";
  deletable: boolean;
  policy: MailPolicyRow;
  disabledActions: readonly string[];
  confirmActions: readonly string[];
  recipients?: readonly string[];
}): "off" | "ask" | "run" {
  const { action, level, policy } = input;
  if (level === "none" || input.disabledActions.includes(action)) return "off";
  if (WRITE_ACTIONS.includes(action) && level !== "read_write") return "off";
  if (action === "delete") return input.deletable ? "ask" : "off";
  if (OUTGOING.includes(action)) {
    const known = (input.recipients ?? []).every((r) => allowedBy(policy.recipientAllowlist, r));
    if (
      policy.autoSend &&
      known &&
      policy.recipientAllowlist.length > 0 &&
      !input.confirmActions.includes(action)
    )
      return "run";
    return "ask";
  }
  return input.confirmActions.includes(action) ? "ask" : "run";
}
