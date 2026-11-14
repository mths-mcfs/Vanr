// Shapes of jsonb columns that have no counterpart in @vanr/contract. The engine modules that write
// these columns validate the values before they reach the database.
import type { ActorRef, BlockedReason } from "@vanr/contract";

/** Value of a typed property: text, number, flag, list, date range or people. */
export type PropValue =
  | string
  | number
  | boolean
  | string[]
  | { start: string; end?: string }
  | ActorRef
  | ActorRef[]
  | null;

/** Stored values by property id. A property without a value is absent, not `null`. */
export type Props = Record<string, PropValue>;

/** The concrete credential an action used, as recorded for audit. */
export interface CredentialRef {
  kind: "connection" | "mailbox" | "database" | "computer_plan";
  /** Id of the connection, mail account, database or environment. */
  id: string;
  owner: "agent" | "org" | "requester";
  /** Display name. */
  label: string;
}

/** A load blocked during a browser action, by the origin rule or by the network proxy. */
export interface BlockedLoad {
  url: string;
  reason: BlockedReason;
  /** Category of the sensitive site, or the kind of address the proxy blocked. */
  detail?: string;
  /** Blocked between the previous response and this action (timer or background request), not by it. */
  before?: boolean;
}
