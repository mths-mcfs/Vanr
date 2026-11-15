// Network of the agent's processes on the runner. The policy that goes with each `exec`,
// `job.start` and `harness.turn` joins the workspace's mode (Settings › Runners), the workspace's domain list
// and the domains allowed for the agent. A host the sandbox proxy blocked becomes a domain request:
// an amber card in the conversation (or only the row in the agent's list, when it came from a job), which whoever
// edits the agent allows or denies. Denied stays denied until someone removes it from the list: the agent does not ask again.
import type { NetworkRequest } from "@vanr/contract";
import { schema } from "@vanr/engine/db";
import { newId } from "@vanr/engine/ids";
import { DOMAIN_RE, type NetworkPolicyFrame } from "@vanr/engine/runner-protocol";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { AppDeps } from "../context";

const { sandboxPolicies, networkRequests, messages } = schema;

export type NetworkRequestRow = typeof networkRequests.$inferSelect;

/** New requests per command: the rest of the blocked hosts only shows in the tool result. */
const FRESH_MAX = 5;

export async function networkPolicyFor(
  deps: AppDeps,
  workspaceId: string,
  agentId: string,
): Promise<NetworkPolicyFrame> {
  const [s] = await deps.db
    .select({ network: sandboxPolicies.network, permittedDomains: sandboxPolicies.permittedDomains })
    .from(sandboxPolicies)
    .where(eq(sandboxPolicies.workspaceId, workspaceId));
  const mode = s?.network ?? "allowlist";
  if (mode === "off") return { mode, domains: [] };
  const allowed = await deps.db
    .select({ domain: networkRequests.domain })
    .from(networkRequests)
    .where(and(eq(networkRequests.agentId, agentId), eq(networkRequests.status, "allowed")));
  const domains = [...new Set([...(s?.permittedDomains ?? []), ...allowed.map((a) => a.domain)])]
    .filter((d) => DOMAIN_RE.test(d))
    .slice(0, 300);
  return { mode, domains };
}

export function toNetworkRequest(row: NetworkRequestRow): NetworkRequest {
  return {
    id: row.id,
    agentId: row.agentId,
    domain: row.domain,
    status: row.status,
    context: row.context,
    channelId: row.channelId,
    threadId: row.threadId,
    messageId: row.messageId,
    deciderUserId: row.decidedBy,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Host as the proxy logged it (`api.example.com:443`) to the list domain (`api.example.com`). */
export function domainOf(host: string): string | null {
  const d = host.trim().toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
  return DOMAIN_RE.test(d) && !d.startsWith("*.") ? d : null;
}

export interface BlockedOutcome {
  /** Requests created now (each one becomes a card). */
  fresh: NetworkRequestRow[];
  /** Already requested and waiting on someone. */
  pending: string[];
  /** Allowed after the command started: running it again is enough. */
  allowed: string[];
  denied: string[];
  /** IP addresses or names outside the domain format: they cannot be requested. */
  other: string[];
}

export async function recordBlocked(
  deps: AppDeps,
  input: {
    workspaceId: string;
    agentId: string;
    hosts: readonly string[];
    context: string;
    channelId?: string | null;
    threadId?: string | null;
    runId?: string | null;
  },
): Promise<BlockedOutcome> {
  const out: BlockedOutcome = { fresh: [], pending: [], allowed: [], denied: [], other: [] };
  const domains = new Set<string>();
  for (const host of input.hosts) {
    const d = domainOf(host);
    if (d) domains.add(d);
    else if (host.trim()) out.other.push(host.trim().slice(0, 253));
  }
  if (domains.size === 0) return out;
  const existing = await deps.db
    .select()
    .from(networkRequests)
    .where(
      and(
        eq(networkRequests.agentId, input.agentId),
        inArray(networkRequests.domain, [...domains]),
        inArray(networkRequests.status, ["pending", "allowed", "denied"]),
      ),
    )
    .orderBy(desc(networkRequests.createdAt));
  for (const domain of domains) {
    const prev = existing.find((r) => r.domain === domain);
    if (prev && prev.status !== "removed") {
      out[prev.status].push(domain);
      continue;
    }
    if (out.fresh.length >= FRESH_MAX) {
      out.other.push(domain);
      continue;
    }
    // The unique index (agent, domain) over pending and allowed rows holds two commands at the same time.
    const [row] = await deps.db
      .insert(networkRequests)
      .values({
        id: newId("nr"),
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        domain,
        context: input.context.slice(0, 2000),
        channelId: input.channelId ?? null,
        threadId: input.threadId ?? null,
        runId: input.runId ?? null,
        createdAt: deps.now(),
      })
      .onConflictDoNothing()
      .returning();
    if (row) out.fresh.push(row);
    else out.pending.push(domain);
  }
  if (out.fresh.length)
    deps.hub.toWorkspace(input.workspaceId, { type: "network.changed", agentId: input.agentId });
  return out;
}

/** Updates the card (the whole request lives in the meta) and notifies the channel; the workspace only learns that it changed. */
export async function publishNetwork(
  deps: AppDeps,
  row: NetworkRequestRow,
  type: "network.requested" | "network.updated",
): Promise<void> {
  const networkRequest = toNetworkRequest(row);
  // One statement merges the request into the card's meta: what else the meta holds stays.
  if (row.messageId)
    await deps.db
      .update(messages)
      .set({ meta: sql`${messages.meta} || ${JSON.stringify({ networkRequest })}::jsonb` })
      .where(eq(messages.id, row.messageId));
  if (row.channelId) deps.hub.toChannel(row.channelId, { type, networkRequest, messageId: row.messageId });
  deps.hub.toWorkspace(row.workspaceId, { type: "network.changed", agentId: row.agentId });
}

const NEXT: Record<"allowed" | "denied" | "removed", NetworkRequestRow["status"][]> = {
  allowed: ["pending"],
  denied: ["pending"],
  removed: ["allowed", "denied"],
};

/** Decides a request. It only leaves the expected state: with two people deciding at the same time, the first one wins. */
export async function decideNetwork(
  deps: AppDeps,
  row: NetworkRequestRow,
  decision: "allowed" | "denied" | "removed",
  userId: string,
): Promise<NetworkRequestRow | null> {
  const [updated] = await deps.db
    .update(networkRequests)
    .set({ status: decision, decidedBy: userId, decidedAt: deps.now() })
    .where(and(eq(networkRequests.id, row.id), inArray(networkRequests.status, NEXT[decision])))
    .returning();
  if (!updated) return null;
  await publishNetwork(deps, updated, "network.updated");
  return updated;
}

/** Text for the model after a command that hit the proxy. */
export function blockedText(o: BlockedOutcome): string {
  const lines: string[] = [];
  if (o.fresh.length)
    lines.push(
      `The sandbox blocked network access to ${o.fresh.map((r) => r.domain).join(", ")}. A card asking a person to allow it is in the conversation; tell them why you need it and run the command again after they allow it.`,
    );
  if (o.pending.length)
    lines.push(`Still waiting for a person to allow ${o.pending.join(", ")}; don't ask again.`);
  if (o.allowed.length) lines.push(`${o.allowed.join(", ")} was just allowed; run the command again.`);
  if (o.denied.length)
    lines.push(`A person denied network access to ${o.denied.join(", ")}. Do the job without it.`);
  if (o.other.length) lines.push(`Also blocked (cannot be requested): ${o.other.join(", ")}.`);
  return lines.join("\n");
}
