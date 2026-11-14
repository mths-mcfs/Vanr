// The agent's browser: interventions, the browser log and site policy.

import type { BlockedReason } from "./approvals.ts";

export type InterventionStatus = "active" | "canceled" | "done" | "expired" | "failed" | "pending";

export interface BrowserIntervention {
  id: string;
  agentId: string;
  channelId: string | null;
  controllingUserId: string | null;
  createdAt: string;
  expiresAt: string;
  handledAt: string | null;
  instructions: string;
  kind: "captcha" | "confirm" | "intervention" | "login" | "other";
  note: string | null;
  runnerId: string | null;
  status: InterventionStatus;
  targetUserId: string | null;
  url: string | null;
}

export type BrowserLevel = "balanced" | "free" | "strict";

export type SiteAccess = "read" | "write";

export interface SiteRule {
  access: SiteAccess;
  /** `example.com` or `*.example.com`. */
  pattern: string;
}

export interface AgentBrowserSettings {
  /** Outside the list: strict blocks, balanced allows reading, open allows acting. */
  level: BrowserLevel;
  /** Read and write sites (same as `sites` with `write`; kept for existing callers). */
  permittedDomains: string[];
  /** Private network ranges allowed (CIDR), only on the runner `privateRangesRunnerId`. */
  privateRanges: string[];
  privateRangesRunnerId: string | null;
  sites: SiteRule[];
}

/** One agent action in the browser. The log is append-only: nobody edits or deletes entries. */
export interface BrowserLogEntry {
  id: string;
  action: Record<string, unknown>;
  agentId: string;
  at: string;
  /** `before`: the page attempted it between the previous entry and this one; it was not this entry's action. */
  blocked: { before?: boolean; detail?: string; reason: BlockedReason; url: string }[];
  channelId: string | null;
  hasShot: boolean;
  message: string | null;
  outcome: "blocked" | "error" | "ok";
  runId: string | null;
  tool: string;
  url: string | null;
}
