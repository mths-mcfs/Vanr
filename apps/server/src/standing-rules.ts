// A narrow "always allow". The person who approves can remember the request: the agent runs the same tool with
// the same predicate (the post's channel, the email's account and recipients, the exact command) without asking,
// for 30 days. The rule is only looked up after the gate and only where the request would come from a workspace
// rule, at K1/K2 and in a run without A (`rememberable` in effects.ts): it never covers K3, a request asked for
// risk, nor a run that read outside content. The list is editable: whoever answers for the agent revokes.
import { createHash } from "node:crypto";
import { type ApprovalRule, can } from "@vanr/contract";
import { type Db, schema } from "@vanr/engine/db";
import { STANDING_RULE_TTL_MS } from "@vanr/engine/effects";
import { newId } from "@vanr/engine/ids";
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import type { WorkspaceMember } from "./context";
import { ownersOf } from "./control";

const { approvalRules } = schema;

export type ApprovalRuleRow = typeof approvalRules.$inferSelect;

/** The predicate can be long (a whole command): the index keeps its hash. */
const keyOf = (key: string) => createHash("sha256").update(key).digest("hex");

/**
 * The live rule (not revoked, not expired) that matches the call, read from the database on every call (no cache:
 * a revoked or expired rule stops matching at once). Found: one statement matches and counts the use.
 */
export async function matchRule(
  db: Db,
  q: { workspaceId: string; agentId: string; tool: string; key: string; at: Date },
): Promise<{ id: string } | null> {
  const [row] = await db
    .update(approvalRules)
    .set({ uses: sql`${approvalRules.uses} + 1`, lastUsedAt: q.at })
    .where(
      and(
        eq(approvalRules.workspaceId, q.workspaceId),
        eq(approvalRules.agentId, q.agentId),
        eq(approvalRules.tool, q.tool),
        eq(approvalRules.ruleKey, keyOf(q.key)),
        isNull(approvalRules.revokedAt),
        gt(approvalRules.expiresAt, q.at),
      ),
    )
    .returning({ id: approvalRules.id });
  return row ?? null;
}

/** Remembers (or renews for 30 more days) the rule of this predicate. */
export async function rememberRule(
  db: Db,
  r: {
    workspaceId: string;
    agentId: string;
    tool: string;
    key: string;
    label: string;
    approvalId: string;
    byUserId: string;
    at: Date;
  },
): Promise<ApprovalRuleRow> {
  const expiresAt = new Date(r.at.getTime() + STANDING_RULE_TTL_MS);
  const [row] = await db
    .insert(approvalRules)
    .values({
      id: newId("rule"),
      workspaceId: r.workspaceId,
      agentId: r.agentId,
      tool: r.tool,
      ruleKey: keyOf(r.key),
      label: r.label,
      approvalId: r.approvalId,
      createdByUserId: r.byUserId,
      createdAt: r.at,
      expiresAt,
    })
    .onConflictDoUpdate({
      target: [approvalRules.agentId, approvalRules.tool, approvalRules.ruleKey],
      targetWhere: sql`revoked_at is null`,
      set: {
        label: r.label,
        approvalId: r.approvalId,
        createdByUserId: r.byUserId,
        createdAt: r.at,
        expiresAt,
      },
    })
    .returning();
  if (!row) throw new Error("approval rule upsert returned nothing");
  return row;
}

/** Whoever answers for the agent or manages agents sees and revokes its rules. */
function canManage(me: WorkspaceMember, ownerUserId: string | undefined): boolean {
  return ownerUserId === me.userId || can(me.role, "manage_agents");
}

/** The live rules the person may see (those of their agents; all of them for whoever manages agents). */
export async function rulesView(
  db: Db,
  me: WorkspaceMember,
  at: Date,
  agentId?: string,
): Promise<ApprovalRule[]> {
  const rows = await db
    .select()
    .from(approvalRules)
    .where(
      and(
        eq(approvalRules.workspaceId, me.workspaceId),
        isNull(approvalRules.revokedAt),
        gt(approvalRules.expiresAt, at),
        agentId ? eq(approvalRules.agentId, agentId) : undefined,
      ),
    )
    .orderBy(desc(approvalRules.createdAt))
    .limit(500);
  const owners = await ownersOf(
    db,
    me.workspaceId,
    rows.map((r) => r.agentId),
  );
  return rows
    .filter((r) => canManage(me, owners.get(r.agentId)?.ownerUserId))
    .map((r) => ({
      id: r.id,
      agentId: r.agentId,
      tool: r.tool,
      label: r.label,
      createdByUserId: r.createdByUserId,
      createdAt: r.createdAt.toISOString(),
      expiresAt: r.expiresAt.toISOString(),
      uses: r.uses,
      lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
    }));
}

/**
 * Revokes the rule (only whoever answers for the agent or manages agents). The revoke is one conditional
 * statement: revoking twice, or at the same time as a use is counted, leaves one revoke and the uses counted.
 */
export async function revokeRule(
  db: Db,
  me: WorkspaceMember,
  id: string,
  at: Date,
): Promise<"ok" | "not_found" | "forbidden"> {
  const [row] = await db
    .select()
    .from(approvalRules)
    .where(
      and(
        eq(approvalRules.workspaceId, me.workspaceId),
        eq(approvalRules.id, id),
        isNull(approvalRules.revokedAt),
      ),
    );
  if (!row) return "not_found";
  const owner = (await ownersOf(db, me.workspaceId, [row.agentId])).get(row.agentId);
  if (!canManage(me, owner?.ownerUserId)) return "forbidden";
  const done = await db
    .update(approvalRules)
    .set({ revokedAt: at, revokedByUserId: me.userId })
    .where(and(eq(approvalRules.id, id), isNull(approvalRules.revokedAt)))
    .returning({ id: approvalRules.id });
  return done.length > 0 ? "ok" : "not_found";
}
