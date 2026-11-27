// Debates: open, list the ones the person sees, read, post, skip the turn, conclude, cancel, resume, the people at
// the table, issues from the synthesis, the verdict, the blind review, the metrics and the debate suggestions the
// agents leave in a chat.
//
// Who sees a debate is debates.ts's rule: the list filters with `visibleDebates` (SQL) and a read goes through
// `visibleDebateById` (`canSeeDebate`); for everyone else the debate doesn't exist (404). While a debate is open its
// agents speak under pseudonyms: every answer here goes out through `toDebate`, `toPost` and `toDetail`, which mask
// the author (and the run) of an agent's post, and no error says who wrote what.
//
// An agent's turn and the synthesis ask the runtime for a text (`complete`): until slice S6 the debate's advance stops
// at that step before writing anything and the debate waits there (debates.ts). Everything a person does here works
// without it.
import type {
  AcceptedDebateSuggestion,
  ActorRef,
  CreateDebateBody,
  Debate,
  DebateBlindReview,
  DebateClaim,
  DebateDetail,
  DebateEndReason,
  DebateEstimate,
  DebateIssuesBody,
  DebateIssuesResult,
  DebateMetrics,
  DebateParticipantsBody,
  DebatePost,
  DebatePostBody,
  DebateReviewPickBody,
  DebateSuggestion,
  DebateSuggestionOverrides,
  DebateVerdict,
  DebateVerdictBody,
} from "@vanr/contract";
import { can } from "@vanr/contract";
import { schema } from "@vanr/engine/db";
import { ANSWER_MAX, answerKey } from "@vanr/engine/debate-protocol";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { z } from "zod";
import { readableChannel } from "../channels";
import type { AppDeps, AppEnv, Ctx, WorkspaceMember } from "../context";
import {
  answerRound,
  changeDebate,
  commentOn,
  type DebatePostRow,
  type DebateRow,
  debateById,
  freezePseudonyms,
  leaveRound,
  MAX_ROUNDS,
  openDebate,
  recastPseudonyms,
  saveDebate,
  scheduleAdvance,
  stopDebate,
  toDebate,
  toDetail,
  toPost,
  turnKey,
  visibleDebateById,
  visibleDebates,
} from "../debates";
import { debateEstimate, speakerAgents } from "../estimates";
import { conflict, forbidden, HttpError, notFound, param, readJson, readQuery } from "../http";
import { createIssue, issueById } from "../issues";
import { type MessageRow, messageInWorkspace } from "../messages";
import { closeNotifications } from "../notifications";
import { personalPlanError, withPlanOwners } from "../runners/plans";
import { requireMember, WORKSPACE } from "../workspace-scope";

const { debates, debatePosts, agents, members, messages, runs } = schema;
const person = (me: WorkspaceMember): ActorRef => ({ type: "person", id: me.userId });
const ids = z.array(z.string().min(1).max(64)).max(20);

/** The debate's agents. A personal-plan agent only joins the debate asked by whoever paired its runner. */
async function checkAgents(
  deps: AppDeps,
  workspaceId: string,
  agentIds: string[],
  initiatedBy: string | null,
) {
  if (agentIds.length === 0) return;
  const rows = await deps.db
    .select()
    .from(agents)
    .where(and(eq(agents.workspaceId, workspaceId), inArray(agents.id, agentIds), isNull(agents.archivedAt)));
  if (rows.length !== new Set(agentIds).size) throw notFound("Agent not found");
  for (const a of await withPlanOwners(deps.db, rows))
    if (a.planOwnerUserId !== null && a.planOwnerUserId !== initiatedBy) throw personalPlanError();
}

async function checkPeople(deps: AppDeps, workspaceId: string, userIds: string[]) {
  if (userIds.length === 0) return;
  const rows = await deps.db
    .select({ id: members.userId })
    .from(members)
    .where(and(eq(members.workspaceId, workspaceId), inArray(members.userId, userIds)));
  if (rows.length !== new Set(userIds).size) throw notFound("Member not found");
}

/** Who runs the debate: whoever opened or asked for it, whoever leads it, or an admin. */
function requireHost(row: DebateRow, me: WorkspaceMember) {
  const createdByMe = row.createdBy.type === "person" && row.createdBy.id === me.userId;
  if (createdByMe || row.requesterUserId === me.userId || row.leadUserId === me.userId) return;
  if (can(me.role, "configure")) return;
  throw forbidden("Only who opened the debate or an admin can do that");
}

const isClosed = (row: Pick<DebateRow, "status">) => row.status === "done" || row.status === "canceled";
const closedError = () => conflict("debate.closed", "This debate is closed");
const turnChanged = () => conflict("debate.turn_changed", "The turn changed; reload the debate");

/** The person holds a speaker slot and hasn't answered in this round yet (the rounds run in parallel). */
function isMyTurn(row: DebateRow, userId: string) {
  return (
    row.status === "open" &&
    row.phase !== "concluding" &&
    row.pendingSpeakers.some((s) => s.type === "person" && s.id === userId)
  );
}

/** The person's claim in the round: it shows beside the agents', but not in the majority (that is the agents'). */
async function personClaim(
  deps: AppDeps,
  row: DebateRow,
  userId: string,
  answer: string,
  confidence?: number,
): Promise<DebateClaim> {
  const key = answerKey(answer, row.options);
  const [before] = await deps.db
    .select({ claimData: debatePosts.claimData })
    .from(debatePosts)
    .where(
      and(
        eq(debatePosts.debateId, row.id),
        eq(debatePosts.round, row.round - 1),
        eq(debatePosts.kind, "speaker"),
        sql`${debatePosts.author}->>'id' = ${userId}`,
      ),
    );
  return {
    answer,
    key,
    confidence: confidence ?? null,
    reason: "",
    evidence: [],
    changed: !!before?.claimData && before.claimData.key !== key,
  };
}

const debateOf = (c: Ctx, me: WorkspaceMember) =>
  visibleDebateById(c.get("deps").db, me, param(c, "debateId"));

/**
 * Changes the debate under its lock (debates.ts, `changeDebate`): `decide` reads the locked row and either returns
 * what to write, throws the rejection, or returns null for "nothing to change". The debate as it is after it.
 */
async function changeLocked(
  deps: AppDeps,
  row: DebateRow,
  decide: Parameters<typeof changeDebate>[2],
): Promise<DebateRow> {
  const saved = await changeDebate(deps, row.id, decide);
  return saved ?? debateById(deps.db, row.workspaceId, row.id);
}

const createBody = z
  .object({
    title: z.string().trim().min(1).max(200),
    goal: z.string().trim().min(1).max(4000),
    agentIds: ids.min(1).max(8),
    userIds: ids.optional(),
    rounds: z.number().int().min(0).max(MAX_ROUNDS).optional(),
    format: z.enum(["decision", "plan"]).optional(),
    deadline: z.iso.datetime({ offset: true }).optional(),
    options: z.array(z.string().trim().min(1).max(200)).min(2).max(8).optional(),
    spendCapPercent: z.number().min(0.1).max(100).optional(),
    speakers: z
      .array(z.object({ type: z.enum(["agent", "person"]), id: z.string().min(1) }))
      .max(20)
      .optional(),
    sourceIssueId: z.string().optional(),
    channelId: z.string().optional(),
  })
  .strict() satisfies z.ZodType<CreateDebateBody>;

const postBody = z
  .object({
    body: z.string().trim().min(1).max(20_000),
    answer: z.string().trim().min(1).max(ANSWER_MAX).optional(),
    confidence: z.number().min(0).max(1).optional(),
    wantsExtraRound: z.boolean().optional(),
    replyTo: z.string().optional(),
  })
  .strict() satisfies z.ZodType<DebatePostBody>;

const participantsBody = z
  .object({
    agentsToAdd: ids.optional(),
    agentsToRemove: ids.optional(),
    peopleToAdd: ids.optional(),
    peopleToRemove: ids.optional(),
    addSpeakerUserIds: ids.optional(),
    removeSpeakerUserIds: ids.optional(),
  })
  .strict() satisfies z.ZodType<DebateParticipantsBody>;

const issuesBody = z
  .object({
    items: z
      .array(
        z.object({
          title: z.string().trim().min(1).max(300),
          owner: z.string().max(100).optional(),
          step: z.string().max(500).optional(),
          description: z.string().max(20_000).optional(),
        }),
      )
      .min(1)
      .max(30),
  })
  .strict() satisfies z.ZodType<DebateIssuesBody>;

const verdictBody = z
  .object({ action: z.enum(["accept", "revert"]) })
  .strict() satisfies z.ZodType<DebateVerdictBody>;
const pickBody = z
  .object({ pick: z.enum(["a", "b", "tie"]) })
  .strict() satisfies z.ZodType<DebateReviewPickBody>;
const overridesBody = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    goal: z.string().trim().min(1).max(4000).optional(),
    agentIds: ids.min(1).max(8).optional(),
    rounds: z.number().int().min(0).max(MAX_ROUNDS).optional(),
  })
  .strict() satisfies z.ZodType<DebateSuggestionOverrides>;

/** The issue a debate came from, read from its saved origin (outside data for this code). */
const issueOrigin = z.object({ issueId: z.string() });

/** The suggestion an agent left in a message's meta, read through its schema (the saved row is outside data). */
const suggestionMeta = z.object({
  title: z.string(),
  goal: z.string().optional(),
  agentIds: z.array(z.string()),
  state: z.enum(["accepted", "dismissed", "pending"]).optional(),
  debateId: z.string().nullable().optional(),
});

function suggestionOf(row: MessageRow): DebateSuggestion {
  const parsed = suggestionMeta.safeParse(row.meta.debateSuggestion);
  if (!parsed.success) throw notFound("Suggestion not found");
  const s = parsed.data;
  return {
    messageId: row.id,
    title: s.title,
    goal: s.goal ?? s.title,
    agentIds: s.agentIds,
    state: s.state ?? "pending",
    debateId: s.debateId ?? null,
    proposerAgentId: row.authorId,
  };
}

async function suggestionMessage(c: Ctx, me: WorkspaceMember) {
  const { db } = c.get("deps");
  const row = await messageInWorkspace(db, me.workspaceId, param(c, "messageId"));
  if (!row) throw notFound("Message not found");
  await readableChannel(db, { workspaceId: me.workspaceId, userId: me.userId, channelId: row.channelId });
  const suggestion = suggestionOf(row);
  if (suggestion.state !== "pending")
    throw conflict("debate.suggestion_closed", "This suggestion was already answered");
  return { row, suggestion };
}

/**
 * Closes the suggestion before acting, in a conditional swap (it leaves "pending" only once): two clicks on
 * "Open" at the same time (two tabs, two people) would open two debates.
 */
async function claimSuggestion(deps: AppDeps, messageId: string, state: "accepted" | "dismissed") {
  const [claimed] = await deps.db
    .update(messages)
    .set({
      meta: sql`jsonb_set(${messages.meta}, '{debateSuggestion,state}', ${JSON.stringify(state)}::jsonb)`,
    })
    .where(
      and(
        eq(messages.id, messageId),
        sql`coalesce(${messages.meta}->'debateSuggestion'->>'state', 'pending') = 'pending'`,
      ),
    )
    .returning({ id: messages.id });
  if (!claimed) throw conflict("debate.suggestion_closed", "This suggestion was already answered");
}

async function releaseSuggestion(deps: AppDeps, messageId: string) {
  await deps.db
    .update(messages)
    .set({ meta: sql`jsonb_set(${messages.meta}, '{debateSuggestion,state}', '"pending"'::jsonb)` })
    .where(eq(messages.id, messageId));
}

/** Writes the answered suggestion into the message (only its own keys) and tells the channel. */
async function settleSuggestion(
  deps: AppDeps,
  row: MessageRow,
  suggestion: DebateSuggestion,
  extra: { debate?: { debateId: string; title: string } } = {},
) {
  const patch = {
    title: suggestion.title,
    agentIds: suggestion.agentIds,
    state: suggestion.state,
    debateId: suggestion.debateId,
  };
  const set = extra.debate
    ? sql`jsonb_set(${messages.meta}, '{debateSuggestion}', coalesce(${messages.meta}->'debateSuggestion', '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb) || ${JSON.stringify({ debate: extra.debate })}::jsonb`
    : sql`jsonb_set(${messages.meta}, '{debateSuggestion}', coalesce(${messages.meta}->'debateSuggestion', '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb)`;
  await deps.db.update(messages).set({ meta: set }).where(eq(messages.id, row.id));
  deps.hub.toChannel(row.channelId, { type: "debate.suggestion_updated", messageId: row.id, suggestion });
}

export function registerDebates(app: Hono<AppEnv>) {
  app.get(`${WORKSPACE}/debates`, async (c) => {
    const me = requireMember(c);
    const rows = await c
      .get("deps")
      .db.select()
      .from(debates)
      .where(visibleDebates(me))
      .orderBy(desc(debates.updatedAt))
      .limit(500);
    return c.json<{ debates: Debate[] }>({ debates: rows.map(toDebate) });
  });

  // The ceiling of what opening a debate can cost, for the dialog to show before opening.
  app.get(`${WORKSPACE}/debates/estimate`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const q = readQuery(
      c,
      z.object({
        agentIds: z
          .string()
          .max(20 * 65)
          .default(""),
        rounds: z.coerce.number().int().min(1).max(MAX_ROUNDS).default(3),
        format: z.enum(["decision", "plan"]).optional(),
      }),
    );
    const agentIds = q.agentIds.split(",").filter(Boolean).slice(0, 20);
    const speakers = await speakerAgents(deps.db, me.workspaceId, agentIds);
    return c.json<DebateEstimate>(
      debateEstimate(speakers, { roundLimit: q.rounds, format: q.format }, deps.now()),
    );
  });

  // What the debate promises (a decision), over the debates the person sees.
  app.get(`${WORKSPACE}/debates/metrics`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const { days } = readQuery(c, z.object({ days: z.coerce.number().int().min(1).max(365).default(90) }));
    const since = new Date(deps.now().getTime() - days * DAY_MS);
    const rows = await deps.db
      .select()
      .from(debates)
      .where(and(visibleDebates(me), eq(debates.status, "done"), sql`${debates.updatedAt} >= ${since}`))
      .limit(2000);
    return c.json<DebateMetrics>(await debateMetrics(deps, rows, days));
  });

  app.get(`${WORKSPACE}/debates/:debateId`, async (c) => {
    const me = requireMember(c);
    return c.json<DebateDetail>(await toDetail(c.get("deps"), await debateOf(c, me)));
  });

  app.post(`${WORKSPACE}/debates`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const input = await readJson(c, createBody);
    const speakers = input.speakers ?? [];
    await checkAgents(
      deps,
      me.workspaceId,
      [...input.agentIds, ...speakers.filter((s) => s.type === "agent").map((s) => s.id)],
      me.userId,
    );
    await checkPeople(deps, me.workspaceId, [
      ...(input.userIds ?? []),
      ...speakers.filter((s) => s.type === "person").map((s) => s.id),
    ]);
    if (input.channelId)
      await readableChannel(deps.db, {
        workspaceId: me.workspaceId,
        userId: me.userId,
        channelId: input.channelId,
      });
    if (input.deadline && new Date(input.deadline) <= deps.now())
      throw new HttpError(400, "debate.deadline_past", "The deadline must be in the future");
    const sourceIssue = input.sourceIssueId
      ? await issueById(deps.db, me.workspaceId, input.sourceIssueId)
      : null;
    const row = await openDebate(deps, {
      workspaceId: me.workspaceId,
      title: input.title,
      goal: input.goal,
      agentIds: input.agentIds,
      userIds: input.userIds,
      speakers: input.speakers,
      roundLimit: input.rounds,
      format: input.format,
      deadline: input.deadline,
      options: input.options,
      spendCapPercent: input.spendCapPercent,
      createdBy: person(me),
      requesterUserId: me.userId,
      channelId: input.channelId ?? null,
      origin: sourceIssue
        ? { kind: "issue", issueId: sourceIssue.id, issueSeq: sourceIssue.number }
        : { kind: "manual" },
    });
    if (sourceIssue) await saveDebate(deps, row, { issueIds: [sourceIssue.id] });
    return c.json<DebateDetail>(await toDetail(deps, await debateById(deps.db, me.workspaceId, row.id)), 201);
  });

  // The round runs in parallel: whoever holds a speaker slot and hasn't answered in this round gives their position
  // (hidden until the round closes); otherwise it is a comment (it doesn't change the queue).
  app.post(`${WORKSPACE}/debates/:debateId/posts`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const row = await debateOf(c, me);
    const input = await readJson(c, postBody);
    if (isClosed(row)) throw closedError();
    if (input.replyTo) {
      // A hidden post answers as one that doesn't exist: nobody learns it is there before the round closes.
      const [target] = await deps.db
        .select({ id: debatePosts.id })
        .from(debatePosts)
        .where(
          and(
            eq(debatePosts.id, input.replyTo),
            eq(debatePosts.debateId, row.id),
            eq(debatePosts.hiddenUntilRoundEnd, false),
          ),
        );
      if (!target) throw notFound("Post not found");
    }
    const myTurn = isMyTurn(row, me.userId);
    // Only a person at the table, on their turn, asks for another round; a comment from outside doesn't move it.
    if (input.wantsExtraRound && !myTurn)
      throw conflict(
        "debate.out_of_turn",
        "Only a person at the table on their turn can ask for another round",
      );
    if (!myTurn) {
      const commented = await commentOn(deps, row.id, person(me), {
        body: input.body,
        replyTo: input.replyTo ?? null,
      });
      if (!commented) throw closedError();
      return c.json<DebatePost>(toPost(commented.post, commented.debate), 201);
    }
    // The position, leaving the queue and the request for one more round (on the last one, up to the maximum) go in
    // together (answerRound): the round doesn't close without them.
    const extend = input.wantsExtraRound && row.round >= row.roundLimit && row.roundLimit < MAX_ROUNDS;
    const answered = await answerRound(
      deps,
      row,
      person(me),
      {
        kind: "speaker",
        body: input.body,
        replyTo: input.replyTo ?? null,
        wantsExtraRound: input.wantsExtraRound ?? false,
        claimData: input.answer
          ? await personClaim(deps, row, me.userId, input.answer, input.confidence)
          : null,
      },
      extend ? { roundLimit: row.roundLimit + 1 } : {},
    );
    if (!answered) throw turnChanged();
    await closeNotifications(deps, me.workspaceId, turnKey(row.id), me.userId);
    scheduleAdvance(deps, row.id);
    return c.json<DebatePost>(toPost(answered.post, answered.debate), 201);
  });

  app.post(`${WORKSPACE}/debates/:debateId/skip`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const row = await debateOf(c, me);
    if (!isMyTurn(row, me.userId)) throw conflict("debate.out_of_turn", "It isn't your round to answer");
    const saved = await leaveRound(deps, row, person(me));
    if (!saved) throw turnChanged();
    await closeNotifications(deps, me.workspaceId, turnKey(row.id), me.userId);
    scheduleAdvance(deps, row.id);
    return c.json<DebateDetail>(await toDetail(deps, saved));
  });

  // Ends the debate now and goes to the synthesis.
  app.post(`${WORKSPACE}/debates/:debateId/conclude`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const row = await debateOf(c, me);
    requireHost(row, me);
    if (isClosed(row)) throw closedError();
    const saved = await stopDebate(deps, row, "concluded");
    if (!saved) throw closedError();
    return c.json<DebateDetail>(await toDetail(deps, saved));
  });

  app.post(`${WORKSPACE}/debates/:debateId/cancel`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const row = await debateOf(c, me);
    requireHost(row, me);
    const saved = await changeDebate(deps, row.id, (fresh) =>
      isClosed(fresh) ? null : { status: "canceled", phase: null, pendingSpeakers: [] },
    );
    if (!saved) throw closedError();
    await closeNotifications(deps, me.workspaceId, turnKey(row.id));
    return c.json<DebateDetail>(await toDetail(deps, saved));
  });

  // Stalled (an agent failed): tries again from whoever stalled it.
  app.post(`${WORKSPACE}/debates/:debateId/resume`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const row = await debateOf(c, me);
    requireHost(row, me);
    const saved = await changeDebate(deps, row.id, (fresh) =>
      fresh.status === "stalled"
        ? {
            status: "open",
            stallInfo: null,
            phase: fresh.pendingSpeakers.length ? "debating" : "concluding",
          }
        : null,
    );
    if (!saved) throw conflict("debate.not_stalled", "This debate is not stalled");
    scheduleAdvance(deps, row.id);
    return c.json<DebateDetail>(await toDetail(deps, saved));
  });

  app.put(`${WORKSPACE}/debates/:debateId/participants`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const row = await debateOf(c, me);
    requireHost(row, me);
    const input = await readJson(c, participantsBody);
    const agentsToAdd = input.agentsToAdd ?? [];
    const speakersToAdd = input.addSpeakerUserIds ?? [];
    await checkAgents(deps, me.workspaceId, agentsToAdd, row.requesterUserId);
    await checkPeople(deps, me.workspaceId, [...(input.peopleToAdd ?? []), ...speakersToAdd]);
    const removeAgents = new Set(input.agentsToRemove ?? []);
    const removeUsers = new Set(input.peopleToRemove ?? []);
    const unseat = new Set([...(input.removeSpeakerUserIds ?? []), ...removeUsers]);
    const gone = (s: ActorRef) => (s.type === "agent" ? removeAgents.has(s.id) : unseat.has(s.id));
    const saved = await changeLocked(deps, row, async (fresh, tx) => {
      const agentIds = [
        ...new Set([...fresh.agentIds.filter((id) => !removeAgents.has(id)), ...agentsToAdd]),
      ];
      if (agentIds.length === 0) throw new HttpError(400, "debate.no_agents", "Keep at least one agent");
      const userIds = [
        ...new Set([
          ...fresh.userIds.filter((id) => !removeUsers.has(id)),
          ...(input.peopleToAdd ?? []),
          ...speakersToAdd,
        ]),
      ];
      const speakers = fresh.speakers.filter((s) => !gone(s));
      for (const id of agentsToAdd)
        if (!speakers.some((s) => s.type === "agent" && s.id === id)) speakers.push({ type: "agent", id });
      // Whoever takes a speaker slot goes in at the end of the order.
      for (const id of speakersToAdd)
        if (!speakers.some((s) => s.type === "person" && s.id === id)) speakers.push({ type: "person", id });
      return {
        agentIds,
        userIds,
        speakers,
        pendingSpeakers: fresh.pendingSpeakers.filter((s) => !gone(s)),
        pseudonyms: recastPseudonyms(fresh.pseudonyms, agentIds, await freezePseudonyms(tx, fresh)),
        leadAgentId:
          fresh.leadAgentId && agentIds.includes(fresh.leadAgentId)
            ? fresh.leadAgentId
            : (agentIds[0] ?? null),
        // The step decides again whether someone is still missing (an agent thinks, a person answers, synthesis).
        ...(fresh.phase === "human_turn" ? { phase: "debating" as const } : {}),
      };
    });
    // Whoever left the table loses the turn's notice with it.
    for (const id of unseat) await closeNotifications(deps, me.workspaceId, turnKey(row.id), id);
    if (saved.status === "open") scheduleAdvance(deps, row.id);
    return c.json<DebateDetail>(await toDetail(deps, saved));
  });

  // Items of the synthesis become issues (sub-issues of the source issue, when the debate came from one).
  app.post(`${WORKSPACE}/debates/:debateId/issues`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const row = await debateOf(c, me);
    requireHost(row, me);
    const { items } = await readJson(c, issuesBody);
    const origin = issueOrigin.safeParse(row.origin);
    const parentId = origin.success ? origin.data.issueId : null;
    const workspaceAgents = await deps.db
      .select({ id: agents.id, name: agents.name, handle: agents.handle })
      .from(agents)
      .where(and(eq(agents.workspaceId, me.workspaceId), isNull(agents.archivedAt)));
    const created: DebateIssuesResult["issues"] = [];
    for (const item of items) {
      const owner = item.owner?.trim().replace(/^@/, "").toLowerCase();
      const agent = owner
        ? workspaceAgents.find((a) => a.handle === owner || a.name.toLowerCase() === owner)
        : undefined;
      const issue = await createIssue(deps, {
        workspaceId: me.workspaceId,
        title: item.title,
        description: [item.description, item.step].filter(Boolean).join("\n\n"),
        assignee: agent ? { type: "agent", id: agent.id } : null,
        parentId,
        source: { kind: "debate", id: row.id },
        author: person(me),
      });
      created.push({ id: issue.id, number: issue.number, title: issue.title });
    }
    await changeDebate(deps, row.id, (fresh) => ({
      issueIds: [...new Set([...fresh.issueIds, ...created.map((i) => i.id)])],
    }));
    return c.json<DebateIssuesResult>({ numbers: created.map((i) => i.number), issues: created }, 201);
  });

  // The verdict: whoever runs the debate accepts it, or reverts it later.
  app.post(`${WORKSPACE}/debates/:debateId/verdict`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const row = await debateOf(c, me);
    requireHost(row, me);
    const { action } = await readJson(c, verdictBody);
    const at = deps.now().toISOString();
    const saved = await changeLocked(deps, row, (fresh) => {
      if (fresh.status !== "done") throw conflict("debate.not_done", "The debate has no verdict yet");
      const current = fresh.verdictState ?? null;
      let verdict: DebateVerdict | null = current;
      if (action === "accept" && current?.state !== "accepted")
        verdict = { state: "accepted", acceptedAt: at, endorsedBy: me.userId };
      if (action === "revert") {
        if (!current) throw conflict("debate.verdict_not_accepted", "Accept the verdict before reverting it");
        if (current.state === "accepted")
          verdict = { ...current, state: "reverted", revertedAt: at, revertedBy: me.userId };
      }
      return verdict === current ? null : { verdictState: verdict };
    });
    return c.json<DebateDetail>(await toDetail(deps, saved));
  });

  // The blind read: the synthesis against a single agent's answer (the lead's round 0), in an order drawn once per
  // person. The person picks without knowing which is which.
  app.get(`${WORKSPACE}/debates/:debateId/review`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const row = await debateOf(c, me);
    const pair = await reviewPair(deps, row);
    let mine = row.blindReviews.find((r) => r.userId === me.userId);
    if (!mine) {
      const entry = {
        userId: me.userId,
        debateFirst: Math.random() < 0.5,
        pick: null,
        at: deps.now().toISOString(),
      };
      // One entry per person, even with two requests at once (the order can't change later).
      const [saved] = await deps.db
        .update(debates)
        .set({ blindReviews: sql`${debates.blindReviews} || ${JSON.stringify([entry])}::jsonb` })
        .where(
          and(
            eq(debates.id, row.id),
            sql`not ${debates.blindReviews} @> ${JSON.stringify([{ userId: me.userId }])}::jsonb`,
          ),
        )
        .returning();
      const fresh = saved ?? (await debateById(deps.db, me.workspaceId, row.id));
      mine = fresh.blindReviews.find((r) => r.userId === me.userId) ?? entry;
    }
    return c.json<DebateBlindReview>(reviewView(pair, mine));
  });

  app.post(`${WORKSPACE}/debates/:debateId/review`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const row = await debateOf(c, me);
    const { pick } = await readJson(c, pickBody);
    const pair = await reviewPair(deps, row);
    const mine = row.blindReviews.find((r) => r.userId === me.userId);
    if (!mine) throw conflict("debate.review_not_started", "Open the blind review first");
    const choice = pick === "tie" ? "tie" : (pick === "a") === mine.debateFirst ? "debate" : "single";
    const updated = { ...mine, pick: choice, at: deps.now().toISOString() } as const;
    // Only this person's entry changes in the database: writing back the list read before would lose the pick of
    // whoever picked at the same time.
    const patch = JSON.stringify({ pick: updated.pick, at: updated.at });
    await deps.db
      .update(debates)
      .set({
        blindReviews: sql`(select coalesce(jsonb_agg(case when e->>'userId' = ${me.userId} then e || ${patch}::jsonb else e end order by i), '[]'::jsonb) from jsonb_array_elements(${debates.blindReviews}) with ordinality as x(e, i))`,
      })
      .where(eq(debates.id, row.id));
    return c.json<DebateBlindReview>(reviewView(pair, updated));
  });

  app.post(`${WORKSPACE}/debate-suggestions/:messageId/accept`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const { row, suggestion } = await suggestionMessage(c, me);
    const overrides = await readJson(c, overridesBody);
    const agentIds = overrides.agentIds ?? suggestion.agentIds;
    await checkAgents(deps, me.workspaceId, agentIds, me.userId);
    await claimSuggestion(deps, row.id, "accepted");
    let debate: DebateRow;
    try {
      debate = await openDebate(deps, {
        workspaceId: me.workspaceId,
        title: overrides.title ?? suggestion.title,
        goal: overrides.goal ?? suggestion.goal,
        agentIds,
        roundLimit: overrides.rounds,
        createdBy: { type: "agent", id: suggestion.proposerAgentId },
        requesterUserId: me.userId,
        channelId: row.channelId,
        origin: { kind: "suggestion", channelId: row.channelId, agentId: suggestion.proposerAgentId },
      });
    } catch (err) {
      await releaseSuggestion(deps, row.id);
      throw err;
    }
    const accepted: DebateSuggestion = {
      ...suggestion,
      state: "accepted",
      debateId: debate.id,
      title: debate.title,
    };
    await settleSuggestion(deps, row, accepted, { debate: { debateId: debate.id, title: debate.title } });
    return c.json<AcceptedDebateSuggestion>(
      { debate: await toDetail(deps, debate), suggestion: accepted },
      201,
    );
  });

  app.post(`${WORKSPACE}/debate-suggestions/:messageId/dismiss`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const { row, suggestion } = await suggestionMessage(c, me);
    await claimSuggestion(deps, row.id, "dismissed");
    const dismissed: DebateSuggestion = { ...suggestion, state: "dismissed" };
    await settleSuggestion(deps, row, dismissed);
    return c.json<{ suggestion: DebateSuggestion }>({ suggestion: dismissed });
  });
}

const DAY_MS = 86_400_000;

/** The synthesis (decision and summary) and a single agent's answer (round 0 of the synthesis' lead). */
async function reviewPair(deps: AppDeps, row: DebateRow): Promise<{ debate: string; single: string }> {
  if (row.status !== "done") throw conflict("debate.not_done", "The debate has no verdict yet");
  const structured = z
    .object({ structured: z.object({ summary: z.string().optional(), decision: z.string().optional() }) })
    .safeParse(row.synthesis);
  const synth = structured.success ? structured.data.structured : null;
  const debate = [synth?.decision, synth?.summary].filter((x) => x?.trim()).join("\n\n");
  const lead = row.leadAgentId ?? row.agentIds[0];
  const [first] = lead
    ? await deps.db
        .select()
        .from(debatePosts)
        .where(
          and(
            eq(debatePosts.debateId, row.id),
            eq(debatePosts.round, 0),
            eq(debatePosts.kind, "turn"),
            sql`${debatePosts.author}->>'id' = ${lead}`,
          ),
        )
    : [];
  const single = first ? singleAnswer(first) : "";
  if (!debate || !single) throw conflict("debate.review_unavailable", "This debate has nothing to compare");
  return { debate, single };
}

const singleAnswer = (p: DebatePostRow) =>
  [p.claimData?.answer, p.body].filter((x) => x?.trim()).join("\n\n");

function reviewView(
  pair: { debate: string; single: string },
  mine: { debateFirst: boolean; pick: "debate" | "single" | "tie" | null },
): DebateBlindReview {
  const pick =
    mine.pick === null
      ? null
      : mine.pick === "tie"
        ? "tie"
        : (mine.pick === "debate") === mine.debateFirst
          ? "a"
          : "b";
  return mine.debateFirst
    ? { a: pair.debate, b: pair.single, pick }
    : { a: pair.single, b: pair.debate, pick };
}

const END_REASONS = ["budget", "concluded", "deadline", "max_rounds", "no_change", "unanimous"] as const;
const endReason = z.enum(END_REASONS);

async function debateMetrics(deps: AppDeps, rows: DebateRow[], days: number): Promise<DebateMetrics> {
  const debateIds = rows.map((r) => r.id);
  const changes = debateIds.length
    ? await deps.db
        .select({
          debateId: debatePosts.debateId,
          challenged: sql<boolean>`bool_or(${debatePosts.round} > 0)`,
          changed: sql<boolean>`coalesce(bool_or((${debatePosts.claimData}->>'changed')::boolean), false)`,
        })
        .from(debatePosts)
        .where(and(inArray(debatePosts.debateId, debateIds), eq(debatePosts.kind, "turn")))
        .groupBy(debatePosts.debateId)
    : [];
  const [cost] = debateIds.length
    ? await deps.db
        .select({ total: sql<number>`coalesce(sum(${runs.costUsd}), 0)::float8` })
        .from(runs)
        .where(inArray(runs.debateId, debateIds))
    : [{ total: 0 }];
  const challenged = changes.filter((c) => c.challenged);
  const changedDebates = challenged.filter((c) => c.changed).length;
  const endReasons: Partial<Record<DebateEndReason, number>> = {};
  for (const r of rows) {
    const reason = endReason.safeParse(r.endReason);
    if (reason.success) endReasons[reason.data] = (endReasons[reason.data] ?? 0) + 1;
  }
  const blindReviews = { debate: 0, single: 0, tie: 0 };
  for (const r of rows) for (const v of r.blindReviews) if (v.pick) blindReviews[v.pick]++;
  const accepted = rows.filter((r) => r.verdictState).length;
  const reverted30 = rows.filter(
    (r) =>
      r.verdictState?.state === "reverted" &&
      r.verdictState.revertedAt &&
      Date.parse(r.verdictState.revertedAt) - Date.parse(r.verdictState.acceptedAt) <= 30 * DAY_MS,
  ).length;
  return {
    days,
    settled: rows.length,
    accepted,
    reverted30,
    changedDebates,
    challenged: challenged.length,
    endReasons,
    blindReviews,
    meanCostUsd: rows.length ? Math.round(((cost?.total ?? 0) / rows.length) * 1_000_000) / 1_000_000 : 0,
    // Many debates with a challenge and almost no change of position: the debate is theater.
    theater: challenged.length >= 10 && changedDebates / challenged.length < 0.1,
  };
}
