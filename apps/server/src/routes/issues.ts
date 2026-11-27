// Issues: list, open by number, create, edit, check a criterion, timeline, comment, ask an agent and the
// board's columns (issue_column.list_updated tells the workspace when they change).
import type {
  ActorRef,
  IssueColumnInput,
  IssueColumnPatch,
  IssueCommentInput,
  IssueInput,
  IssuePatch,
  IssuePriority,
} from "@vanr/contract";
import { schema } from "@vanr/engine/db";
import { and, asc, desc, eq, ilike, or, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { z } from "zod";
import { agentInWorkspace } from "../agents";
import { channelInWorkspace, openDm, writableChannel } from "../channels";
import type { AppDeps, AppEnv, Ctx, WorkspaceMember } from "../context";
import { fileFor } from "../drive";
import { notFound, param, readJson, readQuery } from "../http";
import {
  addColumn,
  addComment,
  changeColumn,
  columnsOf,
  createIssue,
  deleteColumn,
  issueById,
  issueByNumber,
  publishColumns,
  STAGES,
  setCriterion,
  settleIssueWork,
  toActivity,
  toColumn,
  toIssue,
  toIssues,
  updateIssue,
} from "../issues";
import { log } from "../logger";
import { postMessage } from "../messages";
import { requireCanTalk } from "../runners/plans";
import { requireMember, WORKSPACE } from "../workspace-scope";

const { issues, issueTimeline } = schema;
const PRIORITIES = ["none", "low", "medium", "high", "urgent"] as const satisfies readonly IssuePriority[];
const me$ = (me: WorkspaceMember): ActorRef => ({ type: "person", id: me.userId });

/** Longest issue list one request answers. */
export const ISSUE_LIST_LIMIT = 1000;
/** Files one comment attaches at most. */
export const COMMENT_FILES_MAX = 10;

const actorSchema = z.object({ type: z.enum(["person", "agent"]), id: z.string().min(1).max(64) }).strict();
const dueDate = z.iso.date().nullable();
const labels = z.array(z.string().trim().min(1).max(40)).max(20);
/** A short number as the URL carries it: digits only, no sign, no leading zero. */
const issueSeq = /^[1-9][0-9]{0,9}$/;
/** The issue number is a Postgres integer: anything above it can't be one. */
const ISSUE_SEQ_MAX = 2_147_483_647;

export const createIssueBody = z
  .object({
    title: z.string().trim().min(1).max(300),
    description: z.string().max(50_000).optional(),
    criteria: z.array(z.string().trim().min(1).max(500)).max(50).optional(),
    assignee: actorSchema.nullable().optional(),
    priority: z.enum(PRIORITIES).optional(),
    dueDate: dueDate.optional(),
    labels: labels.optional(),
    columnId: z.string().min(1).max(64).optional(),
    channelId: z.string().min(1).max(64).optional(),
  })
  .strict() satisfies z.ZodType<IssueInput>;

/** The largest board position a client may write. */
export const BOARD_POSITION_MAX = 2 ** 40;

export const updateIssueBody = z
  .object({
    title: z.string().trim().min(1).max(300).optional(),
    description: z.string().max(50_000).optional(),
    columnId: z.string().min(1).max(64).optional(),
    // Bounded far below 2^53, so the positions the board adds after the last one stay distinct.
    boardPosition: z.number().min(-BOARD_POSITION_MAX).max(BOARD_POSITION_MAX).optional(),
    assignee: actorSchema.nullable().optional(),
    priority: z.enum(PRIORITIES).optional(),
    dueDate: dueDate.optional(),
    labels: labels.optional(),
  })
  .strict() satisfies z.ZodType<IssuePatch>;

const commentBody = z
  .object({
    text: z.string().trim().min(1).max(20_000),
    attachedFileIds: z.array(z.string().min(1).max(64)).max(COMMENT_FILES_MAX).optional(),
  })
  .strict() satisfies z.ZodType<IssueCommentInput>;
const columnBody = z
  .object({
    name: z.string().trim().max(40),
    stage: z.enum(STAGES),
    afterId: z.string().min(1).max(64).optional(),
  })
  .strict() satisfies z.ZodType<IssueColumnInput>;
const columnPatch = z
  .object({ name: z.string().trim().max(40).optional(), index: z.number().int().min(0).optional() })
  .strict() satisfies z.ZodType<IssueColumnPatch>;

/**
 * An agent assignee starts working right away, so whoever assigns has to be able to talk to it. A person assignee
 * (and the agent's workspace) is checked again in the transaction that writes (`checkLinks` in issues.ts).
 */
async function checkAgentAssignee(deps: AppDeps, workspaceId: string, a: ActorRef, asker: string) {
  const agent = await agentInWorkspace(deps.db, workspaceId, a.id);
  if (agent.archivedAt) throw notFound("Agent not found");
  await requireCanTalk(deps.db, agent, asker);
}

async function issueOf(c: Ctx, me: WorkspaceMember) {
  return issueById(c.get("deps").db, me.workspaceId, param(c, "issueId"));
}

function columnsReply(c: Ctx, workspaceId: string, cols: Awaited<ReturnType<typeof columnsOf>>) {
  publishColumns(c.get("deps"), workspaceId, cols);
  return c.json({ columns: cols.map(toColumn) });
}

export function registerIssues(app: Hono<AppEnv>) {
  app.get(`${WORKSPACE}/issues`, async (c) => {
    const me = requireMember(c);
    const { db } = c.get("deps");
    const { q } = readQuery(c, z.object({ q: z.string().trim().max(200).optional() }));
    const like = q ? `%${q.replace(/^#/, "").replace(/[%_\\]/g, "\\$&")}%` : null;
    const rows = await db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.workspaceId, me.workspaceId),
          like
            ? or(
                ilike(issues.title, like),
                ilike(issues.description, like),
                sql`${issues.number}::text ilike ${like}`,
              )
            : undefined,
        ),
      )
      .orderBy(asc(issues.boardPosition), desc(issues.number))
      .limit(ISSUE_LIST_LIMIT);
    return c.json({ issues: await toIssues(db, me.workspaceId, rows) });
  });

  // A number of another workspace, one that doesn't exist and one that isn't a number answer the same 404.
  app.get(`${WORKSPACE}/issues/seq/:issueSeq`, async (c) => {
    const me = requireMember(c);
    const { db } = c.get("deps");
    const raw = param(c, "issueSeq");
    if (!issueSeq.test(raw) || Number(raw) > ISSUE_SEQ_MAX) throw notFound("Issue not found");
    return c.json(await toIssue(db, await issueByNumber(db, me.workspaceId, Number(raw))));
  });

  app.post(`${WORKSPACE}/issues`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const input = await readJson(c, createIssueBody);
    // Before creating: if the agent can't start, the issue isn't left halfway.
    if (input.assignee?.type === "agent") {
      await checkAgentAssignee(deps, me.workspaceId, input.assignee, me.userId);
    }
    if (input.channelId)
      await writableChannel(deps.db, {
        workspaceId: me.workspaceId,
        userId: me.userId,
        channelId: input.channelId,
      });
    const row = await createIssue(deps, {
      workspaceId: me.workspaceId,
      ...input,
      source: { kind: "manual" },
      author: me$(me),
    });
    if (row.assignee?.type === "agent") {
      const started = await askAgent(deps, me, row.id, row.assignee.id);
      return c.json(await toIssue(deps.db, started), 201);
    }
    return c.json(await toIssue(deps.db, row), 201);
  });

  app.patch(`${WORKSPACE}/issues/:issueId`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const row = await issueOf(c, me);
    const input = await readJson(c, updateIssueBody);
    const updated = await updateIssue(deps, row, input, me$(me));
    return c.json(await toIssue(deps.db, updated));
  });

  app.put(`${WORKSPACE}/issues/:issueId/criteria/:criterionId`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const row = await issueOf(c, me);
    const { done } = await readJson(c, z.object({ done: z.boolean() }).strict());
    const updated = await setCriterion(deps, row, param(c, "criterionId"), done, me$(me));
    return c.json(await toIssue(deps.db, updated));
  });

  app.get(`${WORKSPACE}/issues/:issueId/activity`, async (c) => {
    const me = requireMember(c);
    const row = await issueOf(c, me);
    const rows = await c
      .get("deps")
      .db.select()
      .from(issueTimeline)
      .where(eq(issueTimeline.issueId, row.id))
      .orderBy(asc(issueTimeline.seq));
    return c.json({ activity: rows.map(toActivity) });
  });

  app.post(`${WORKSPACE}/issues/:issueId/comments`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const row = await issueOf(c, me);
    const input = await readJson(c, commentBody);
    // Each file has to be of the workspace and one the person can open: otherwise the same 404 as a missing one.
    const attachments: string[] = [];
    for (const id of new Set(input.attachedFileIds ?? [])) {
      attachments.push((await fileFor(deps.db, me.workspaceId, id, me$(me))).id);
    }
    return c.json(await addComment(deps, row, { text: input.text, attachments }, me$(me)), 201);
  });

  app.post(`${WORKSPACE}/issues/:issueId/ask-agent`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const row = await issueOf(c, me);
    const { agentId } = await readJson(c, z.object({ agentId: z.string().min(1).max(64) }).strict());
    return c.json(await toIssue(deps.db, await askAgent(deps, me, row.id, agentId)));
  });

  // ---- columns ----

  app.get(`${WORKSPACE}/issue-columns`, async (c) => {
    const me = requireMember(c);
    const cols = await columnsOf(c.get("deps").db, me.workspaceId);
    return c.json({ columns: cols.map(toColumn) });
  });

  app.post(`${WORKSPACE}/issue-columns`, async (c) => {
    const me = requireMember(c);
    const { db } = c.get("deps");
    const input = await readJson(c, columnBody);
    return columnsReply(c, me.workspaceId, await addColumn(db, me.workspaceId, input));
  });

  app.patch(`${WORKSPACE}/issue-columns/:issueColumnId`, async (c) => {
    const me = requireMember(c);
    const { db } = c.get("deps");
    const input = await readJson(c, columnPatch);
    const cols = await changeColumn(db, me.workspaceId, param(c, "issueColumnId"), input);
    return columnsReply(c, me.workspaceId, cols);
  });

  app.delete(`${WORKSPACE}/issue-columns/:issueColumnId`, async (c) => {
    const me = requireMember(c);
    const { db } = c.get("deps");
    const { moveTo } = readQuery(c, z.object({ moveTo: z.string().min(1).max(64) }));
    const cols = await deleteColumn(db, me.workspaceId, param(c, "issueColumnId"), moveTo);
    return columnsReply(c, me.workspaceId, cols);
  });
}

/**
 * Asks an agent to work on the issue: it becomes the assignee, the issue goes to "in progress" and the request
 * reaches the person's DM with the agent (the message starts the run). The entry checked that the runtime is there.
 */
async function askAgent(deps: AppDeps, me: WorkspaceMember, issueId: string, agentId: string) {
  const { db } = deps;
  const agent = await agentInWorkspace(db, me.workspaceId, agentId);
  if (agent.archivedAt) throw notFound("Agent not found");
  await requireCanTalk(db, agent, me.userId);
  const row = await issueById(db, me.workspaceId, issueId);
  const cols = await columnsOf(db, me.workspaceId);
  const current = cols.find((x) => x.id === row.columnId);
  const working = current?.stage === "todo" ? cols.find((x) => x.stage === "in_progress") : current;
  const updated = await updateIssue(
    deps,
    row,
    { assignee: { type: "agent", id: agent.id }, ...(working ? { columnId: working.id } : {}) },
    me$(me),
  );
  const channelId = await openDm(db, {
    workspaceId: me.workspaceId,
    userId: me.userId,
    other: { type: "agent", id: agent.id },
  });
  const channel = await channelInWorkspace(db, me.workspaceId, channelId);
  if (!channel) throw notFound("Channel not found");
  const criteria = updated.criteria.map((x) => `- [${x.done ? "x" : " "}] ${x.text}`).join("\n");
  const body = [`#${updated.number} ${updated.title}`, updated.description.trim(), criteria]
    .filter(Boolean)
    .join("\n\n");
  const { message } = await postMessage(deps, {
    workspaceId: me.workspaceId,
    channel,
    author: me$(me),
    body,
    clientId: `worked-issue:${row.id}:${deps.now().getTime()}`,
    meta: { workedIssue: { issueId: row.id, number: updated.number } },
  });
  // The work belongs to this message: only the run that serves it (or its block) takes it out of "working".
  const [withWork] = await db
    .update(issues)
    .set({ work: { state: "working", reason: null, runId: null, messageId: message.id } })
    .where(eq(issues.id, row.id))
    .returning();
  try {
    await deps.runtime.onPersonMessage({ workspaceId: me.workspaceId, channel, message });
  } catch (err) {
    // Nothing will serve the request: the issue doesn't stay "working" with no run behind it.
    log.error("runtime.route_failed", { messageId: message.id, err });
    await settleIssueWork(db, me.workspaceId, [message.id], {
      state: "blocked",
      reason: "interrupted",
      runId: null,
    });
    return issueById(db, me.workspaceId, row.id);
  }
  return withWork ?? updated;
}
