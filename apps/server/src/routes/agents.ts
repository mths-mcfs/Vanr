// Agents: registry, channels, harness, credentials, runs, usage, the agent's inbox, the team and skills.
import {
  AGENT_BODIES,
  AGENT_EXTRAS,
  AGENT_MOUTHS,
  type AgentAppearance,
  type AgentInbox,
  type Credential,
  can,
  type InstructionVersion,
  type Model,
  type Run,
  type RunStep,
  type Team,
  type WorkingRun,
} from "@vanr/contract";
import { type Db, schema } from "@vanr/engine/db";
import { newId } from "@vanr/engine/ids";
import {
  ADVISOR_MAX_USES,
  ADVISOR_PAIRS,
  advisorPairOk,
  DEFAULT_MODEL,
  findModel,
  MODELS,
} from "@vanr/engine/models/catalog";
import { keyPreview } from "@vanr/engine/seal";
import { HANDLE_RE } from "@vanr/engine/text";
import { and, asc, desc, eq, gte, inArray, isNull, notInArray, or, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { z } from "zod";
import { type InstructionVersionRow, initialInstructions, writeInstructions } from "../agent-memory";
import {
  AGENT_ROLES,
  type AgentRow,
  agentChannels,
  agentInWorkspace,
  channelViewer,
  monthStart,
  requireAgentEditor,
  requireCredential,
  toAgent,
  toAgentDetail,
} from "../agents";
import { readableChannel, readableChannelsSql } from "../channels";
import { type AppEnv, requireUser, type WorkspaceMember } from "../context";
import { waitingForMe } from "../control";
import { isUniqueViolation } from "../db-errors";
import { revealedDebateIds } from "../debates";
import { importInstructions, parseGithubUrl } from "../github";
import { badRequest, conflict, forbidden, HttpError, notFound, param, readJson, readQuery } from "../http";
import { repoReadToken } from "../integrations/github-app";
import { takenHandles } from "../members";
import { platformKeyAvailable } from "../models";
import { readableRun } from "../run-access";
import { type Executor, executorModelOk, harnessView, withPlanOwner, withPlanOwners } from "../runners/plans";
import { requireMember, requirePermission, WORKSPACE } from "../workspace-scope";
import { toSkill } from "./skills";

const { agents, credentials, channels, channelMemberships, members, users, runs, runEvents, workspaces } =
  schema;
const { skills, skillGrants, delegations, messages, agentGrants, instructionVersions } = schema;

function toInstructionVersion(v: InstructionVersionRow): InstructionVersion {
  return {
    id: v.id,
    agentId: v.agentId,
    seq: v.seq,
    text: v.text,
    author: { type: v.authorKind, id: v.authorId },
    reason: v.reason,
    source: v.source,
    proposalId: v.proposalId,
    restoredFromSeq: v.restoredFromSeq,
    createdAt: v.createdAt.toISOString(),
  };
}

const part = z.string().trim().min(1).max(32);
/** The free parts stay free text; the body, the mouth and the extra take only the contract's lists. */
const appearance = z
  .object({
    color: part,
    eyes: part,
    adornment: part,
    body: z.enum(AGENT_BODIES).optional(),
    mouth: z.enum(AGENT_MOUTHS).optional(),
    extra: z.enum(AGENT_EXTRAS).optional(),
  })
  .strict() satisfies z.ZodType<AgentAppearance>;
const DEFAULT_APPEARANCE: AgentAppearance = { color: "teal", eyes: "dots", adornment: "none" };
const audience = z
  .object({
    mode: z.enum(["everyone", "people", "owner"]),
    userIds: z.array(z.string().min(1).max(64)).max(200),
  })
  .strict();
const modelId = z.string().refine((m) => findModel(m) !== null, "Unknown model");
const budget = z.number().min(0).max(100_000).nullable();
const advisor = z
  .object({ model: modelId, maxUses: z.number().int().min(1).max(ADVISOR_MAX_USES) })
  .strict()
  .nullable();

/**
 * The advisor columns for the agent's final model. A request with an invalid pair is rejected; changing the
 * model without touching the advisor turns off one that no longer holds (Opus has no advisor).
 */
function advisorColumns(
  model: string,
  asked: z.infer<typeof advisor> | undefined,
  current: { advisorModel: string | null } | null,
): { advisorModel?: string | null; advisorMaxUses?: number } {
  if (asked === undefined) {
    if (current?.advisorModel && !advisorPairOk(model, current.advisorModel)) return { advisorModel: null };
    return {};
  }
  if (asked === null) return { advisorModel: null };
  if (!advisorPairOk(model, asked.model))
    throw new HttpError(400, "agent.advisor_pair", "This model can't use that advisor", {
      field: "advisor",
      model,
      advisor: asked.model,
    });
  return { advisorModel: asked.model, advisorMaxUses: asked.maxUses };
}

const agentFields = {
  name: z.string().trim().min(1).max(60),
  role: z.enum(AGENT_ROLES),
  instructions: z.string().max(20_000),
  model: modelId,
  ownerUserId: z.string().min(1).max(64),
  audience,
  credentialId: z.string().min(1).max(64).nullable(),
  budgetPerMonthUsd: budget,
  appearance,
  advisor,
};

const createInput = z
  .object({
    ...agentFields,
    handle: z.string().trim().toLowerCase().regex(HANDLE_RE, "Use 2-32 letters, numbers, - or _"),
    instructions: agentFields.instructions.optional(),
    model: modelId.optional(),
    ownerUserId: agentFields.ownerUserId.optional(),
    audience: audience.optional(),
    credentialId: agentFields.credentialId.optional(),
    budgetPerMonthUsd: budget.optional(),
    appearance: appearance.optional(),
    channelIds: z.array(z.string().min(1).max(64)).max(100).optional(),
    advisor: advisor.optional(),
  })
  .strict();

const updateInput = z
  .object({
    name: agentFields.name,
    role: agentFields.role,
    instructions: agentFields.instructions,
    model: agentFields.model,
    ownerUserId: agentFields.ownerUserId,
    audience: agentFields.audience,
    credentialId: agentFields.credentialId,
    budgetPerMonthUsd: agentFields.budgetPerMonthUsd,
    appearance: agentFields.appearance,
    advisor: agentFields.advisor,
    instructionsReason: z.string().trim().max(500),
  })
  .partial()
  .strict();

async function requireMemberIds(db: Db, workspaceId: string, ids: string[]) {
  if (ids.length === 0) return;
  const rows = await db
    .select({ id: members.userId })
    .from(members)
    .where(and(eq(members.workspaceId, workspaceId), inArray(members.userId, ids)));
  if (rows.length !== new Set(ids).size) throw badRequest("Unknown member", { field: "userIds" });
}

async function workspaceChannelIds(db: Db, workspaceId: string, ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select({ id: channels.id })
    .from(channels)
    .where(
      and(eq(channels.workspaceId, workspaceId), eq(channels.kind, "channel"), inArray(channels.id, ids)),
    );
  if (rows.length !== new Set(ids).size) throw badRequest("Unknown channel", { field: "channelIds" });
  return rows.map((r) => r.id);
}

/** Of these channels, the private ones the person is not a member of. */
function privateChannelsOutside(db: Db, userId: string, ids: string[]) {
  return db
    .select({ id: channels.id })
    .from(channels)
    .where(
      and(
        inArray(channels.id, ids),
        eq(channels.visibility, "private"),
        notInArray(
          channels.id,
          db
            .select({ id: channelMemberships.channelId })
            .from(channelMemberships)
            .where(and(eq(channelMemberships.memberType, "person"), eq(channelMemberships.memberId, userId))),
        ),
      ),
    );
}

/**
 * The workspace's runs the person may see: of a channel they read (or none), and a debate's turn only once the
 * debate they see revealed who said what (the output tokens per agent would tell whose each anonymous turn is).
 */
function readableRuns(db: Db, me: WorkspaceMember) {
  return and(
    eq(runs.workspaceId, me.workspaceId),
    or(isNull(runs.channelId), sql`${runs.channelId} in ${readableChannelsSql(me)}`),
    or(isNull(runs.debateId), inArray(runs.debateId, revealedDebateIds(db, me))),
  );
}

/** A delegation asked from a channel the person doesn't read: the run shows, the question doesn't. */
const questionHidden = (me: WorkspaceMember) =>
  sql<boolean>`${runs.sourceChannelId} is not null and ${runs.sourceChannelId} not in ${readableChannelsSql(me)}`;

export function toRun(row: typeof runs.$inferSelect): Run {
  return {
    id: row.id,
    agentId: row.agentId,
    channelId: row.channelId,
    threadId: row.threadId,
    status: row.status,
    what: row.what,
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
    repo: null,
    blockedRepo: null,
    error: row.error,
    errorCode: row.errorCode,
    errorVars: row.errorVars ?? null,
    inputTokens: row.inputTokens,
    cachedTokens: row.cachedTokens,
    outputTokens: row.outputTokens,
    costUsd: row.costUsd,
    sourceMessageId: row.sourceMessageId,
  };
}

function toCredential(row: typeof credentials.$inferSelect): Credential {
  return {
    id: row.id,
    label: row.label,
    provider: row.provider,
    keyPreview: row.keyPreview,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

const firstSentence = (text: string) => {
  const line = text.trim().split(/\n+/)[0] ?? "";
  const sentence = /^(.{1,160}?[.!?])(\s|$)/.exec(line)?.[1] ?? line.slice(0, 160);
  return sentence.trim();
};

export function registerAgents(app: Hono<AppEnv>) {
  app.get("/api/v1/models", (c) => {
    requireUser(c);
    const models: Model[] = MODELS.map((m) => ({
      id: m.id,
      label: m.label,
      provider: "anthropic",
      inputPricePerMillion: m.price.input,
      outputPricePerMillion: m.price.output,
      advisors: [...(ADVISOR_PAIRS[m.id] ?? [])],
      available: true,
    }));
    return c.json({ models, defaultModel: DEFAULT_MODEL });
  });

  app.get(`${WORKSPACE}/agents`, async (c) => {
    const me = requireMember(c);
    const { db, runtime } = c.get("deps");
    const rows = await db
      .select()
      .from(agents)
      .where(and(eq(agents.workspaceId, me.workspaceId), isNull(agents.archivedAt)))
      .orderBy(asc(agents.name));
    const busy = runtime.busyAgents();
    const talkers = await withPlanOwners(db, rows);
    const testModel = await c.get("deps").testModelFor(me.workspaceId);
    return c.json({ agents: talkers.map((r) => toAgent(r, me.userId, busy.has(r.id), testModel(r))) });
  });

  app.post(`${WORKSPACE}/agents`, async (c) => {
    const me = requirePermission(c, "manage_agents");
    const { db, runtime, now } = c.get("deps");
    const input = await readJson(c, createInput);
    if ((await takenHandles(db, me.workspaceId)).has(input.handle)) {
      throw conflict("agent.handle_taken", "That @ is already in use", { handle: input.handle });
    }
    const ownerUserId = input.ownerUserId ?? me.userId;
    await requireMemberIds(db, me.workspaceId, [ownerUserId, ...(input.audience?.userIds ?? [])]);
    await requireCredential(db, me.workspaceId, input.credentialId);
    const channelIds = await workspaceChannelIds(db, me.workspaceId, [...new Set(input.channelIds ?? [])]);
    const advised = advisorColumns(input.model ?? DEFAULT_MODEL, input.advisor, null);
    const id = newId("agt");
    let row: AgentRow | undefined;
    try {
      row = await db.transaction(async (tx) => {
        const [created] = await tx
          .insert(agents)
          .values({
            id,
            workspaceId: me.workspaceId,
            name: input.name,
            handle: input.handle,
            role: input.role,
            instructions: input.instructions ?? "",
            model: input.model ?? DEFAULT_MODEL,
            ownerUserId,
            visibilityMode: input.audience?.mode ?? "everyone",
            audienceUserIds: input.audience?.userIds ?? [],
            appearance: input.appearance ?? DEFAULT_APPEARANCE,
            credentialId: input.credentialId ?? null,
            budgetPerMonthUsd: input.budgetPerMonthUsd ?? null,
            ...advised,
            createdBy: me.userId,
          })
          .returning();
        if (channelIds.length) {
          await tx
            .insert(channelMemberships)
            .values(
              channelIds.map((channelId) => ({ channelId, memberType: "agent" as const, memberId: id })),
            );
        }
        await initialInstructions(
          tx,
          now(),
          { id, workspaceId: me.workspaceId, instructions: input.instructions ?? "" },
          { type: "person", id: me.userId },
        );
        // A new agent starts with everything granted; the access tab narrows it.
        await tx
          .insert(agentGrants)
          .values({ agentId: id, workspaceId: me.workspaceId, connectionId: "", scope: "*" });
        const autoGranted = await tx
          .select({ id: skills.id })
          .from(skills)
          .where(and(eq(skills.workspaceId, me.workspaceId), eq(skills.autoGrantNewAgents, true)));
        if (autoGranted.length) {
          await tx
            .insert(skillGrants)
            .values(autoGranted.map((s) => ({ agentId: id, skillId: s.id, enabled: true })));
        }
        return created;
      });
    } catch (err) {
      // Two creations with the same @ at once: the unique index decides.
      if (isUniqueViolation(err))
        throw conflict("agent.handle_taken", "That @ is already in use", { handle: input.handle });
      throw err;
    }
    if (!row) throw new Error("agent insert returned nothing");
    const testModel = await c.get("deps").testModelFor(me.workspaceId);
    return c.json(
      toAgent(await withPlanOwner(db, row), me.userId, runtime.isBusy(row.id), testModel(row)),
      201,
    );
  });

  app.get(`${WORKSPACE}/agents/:agentId`, async (c) => {
    const me = requireMember(c);
    const { db, runtime, now } = c.get("deps");
    const row = await agentInWorkspace(db, me.workspaceId, param(c, "agentId"));
    return c.json(
      await toAgentDetail(db, row, {
        viewer: channelViewer(me),
        busy: runtime.isBusy(row.id),
        testModel: (await c.get("deps").testModelFor(me.workspaceId))(row),
        now: now(),
      }),
    );
  });

  app.patch(`${WORKSPACE}/agents/:agentId`, async (c) => {
    const me = requireMember(c);
    const { db, runtime, now } = c.get("deps");
    const row = await agentInWorkspace(db, me.workspaceId, param(c, "agentId"));
    requireAgentEditor(me, row);
    if (row.archivedAt) throw conflict("agent.archived", "This agent was archived");
    const input = await readJson(c, updateInput);
    // Whoever manages agents changes everything. The owner without that role only touches the appearance and
    // who may talk to the agent: name, instructions, model, key and budget stay with the workspace.
    if (!can(me.role, "manage_agents")) {
      const restricted = Object.entries(input).filter(
        ([key, value]) => value !== undefined && key !== "appearance" && key !== "audience",
      );
      if (restricted.length > 0) throw forbidden();
    }
    await requireMemberIds(db, me.workspaceId, [
      ...(input.ownerUserId ? [input.ownerUserId] : []),
      ...(input.audience?.userIds ?? []),
    ]);
    await requireCredential(db, me.workspaceId, input.credentialId);
    const advised = advisorColumns(input.model ?? row.model, input.advisor, row);
    // Instructions only change through the versioned writer (author, reason, undo).
    if (input.instructions !== undefined)
      await writeInstructions(db, now(), {
        agentId: row.id,
        text: input.instructions,
        author: { type: "person", id: me.userId },
        reason: input.instructionsReason ?? "",
        source: "edit",
      });
    const [updated] = await db
      .update(agents)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.role !== undefined ? { role: input.role } : {}),
        ...(input.model !== undefined ? { model: input.model } : {}),
        ...(input.ownerUserId !== undefined ? { ownerUserId: input.ownerUserId } : {}),
        ...(input.audience !== undefined
          ? { visibilityMode: input.audience.mode, audienceUserIds: input.audience.userIds }
          : {}),
        ...(input.credentialId !== undefined ? { credentialId: input.credentialId } : {}),
        ...(input.budgetPerMonthUsd !== undefined
          ? { budgetPerMonthUsd: input.budgetPerMonthUsd, budgetNotice: null }
          : {}),
        ...(input.appearance !== undefined ? { appearance: input.appearance } : {}),
        ...advised,
        updatedAt: now(),
      })
      .where(eq(agents.id, row.id))
      .returning();
    if (!updated) throw notFound("Agent not found");
    const testModel = await c.get("deps").testModelFor(me.workspaceId);
    return c.json(
      toAgent(await withPlanOwner(db, updated), me.userId, runtime.isBusy(updated.id), testModel(updated)),
    );
  });

  // Archive: the agent leaves the lists and stops answering; its @ stays reserved.
  app.delete(`${WORKSPACE}/agents/:agentId`, async (c) => {
    const me = requirePermission(c, "manage_agents");
    const { db, now } = c.get("deps");
    const row = await agentInWorkspace(db, me.workspaceId, param(c, "agentId"));
    if (!row.archivedAt) await db.update(agents).set({ archivedAt: now() }).where(eq(agents.id, row.id));
    return c.body(null, 204);
  });

  app.get(`${WORKSPACE}/agents/:agentId/channels`, async (c) => {
    const me = requireMember(c);
    const { db } = c.get("deps");
    const row = await agentInWorkspace(db, me.workspaceId, param(c, "agentId"));
    return c.json({ channels: await agentChannels(db, row.id, channelViewer(me)) });
  });

  // Replaces the whole channel list (DMs stay out) and the autoAnswer of each one.
  app.put(`${WORKSPACE}/agents/:agentId/channels`, async (c) => {
    const me = requireMember(c);
    const { db } = c.get("deps");
    const row = await agentInWorkspace(db, me.workspaceId, param(c, "agentId"));
    requireAgentEditor(me, row);
    const input = await readJson(
      c,
      z.object({
        channels: z
          .array(z.object({ channelId: z.string().min(1).max(64), autoAnswer: z.boolean() }).strict())
          .max(200),
      }),
    );
    const wanted = new Map(input.channels.map((ch) => [ch.channelId, ch.autoAnswer]));
    await workspaceChannelIds(db, me.workspaceId, [...wanted.keys()]);
    const viewer = channelViewer(me);
    await db.transaction(async (tx) => {
      // The links are read under the agent's lock, in the same transaction as the writes: what counts as added is
      // decided on the list the writes act on. A private channel the person doesn't read stays as it is.
      await tx.select({ id: agents.id }).from(agents).where(eq(agents.id, row.id)).for("update");
      const visible = new Set((await agentChannels(tx, row.id, viewer)).map((ch) => ch.id));
      const added = [...wanted.keys()].filter((id) => !visible.has(id));
      // Stricter than the source: an owner without manage_agents only adds a private channel they belong to, so
      // they can't put their agent where they can't read. Removing one, and changing autoAnswer, stay open.
      if (!viewer.seesAll && added.length && (await privateChannelsOutside(tx, me.userId, added)).length)
        throw forbidden();
      const drop = [...visible].filter((id) => !wanted.has(id));
      if (drop.length) {
        await tx
          .delete(channelMemberships)
          .where(
            and(
              eq(channelMemberships.memberType, "agent"),
              eq(channelMemberships.memberId, row.id),
              inArray(channelMemberships.channelId, drop),
            ),
          );
      }
      for (const [channelId, autoAnswer] of wanted) {
        // A link that was there only changes its autoAnswer: one removed in the meantime is not brought back.
        if (visible.has(channelId)) {
          await tx
            .update(channelMemberships)
            .set({ autoAnswer })
            .where(
              and(
                eq(channelMemberships.channelId, channelId),
                eq(channelMemberships.memberType, "agent"),
                eq(channelMemberships.memberId, row.id),
              ),
            );
          continue;
        }
        await tx
          .insert(channelMemberships)
          .values({ channelId, memberType: "agent", memberId: row.id, autoAnswer })
          .onConflictDoUpdate({
            target: [
              channelMemberships.channelId,
              channelMemberships.memberType,
              channelMemberships.memberId,
            ],
            set: { autoAnswer },
          });
      }
    });
    return c.json({ channels: await agentChannels(db, row.id, viewer) });
  });

  app.get(`${WORKSPACE}/agents/:agentId/runtime`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const row = await agentInWorkspace(deps.db, me.workspaceId, param(c, "agentId"));
    return c.json(await harnessView(deps, row, me.userId));
  });

  app.put(`${WORKSPACE}/agents/:agentId/runtime`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const { db, now } = deps;
    const row = await agentInWorkspace(db, me.workspaceId, param(c, "agentId"));
    requireAgentEditor(me, row);
    const input = await readJson(
      c,
      z
        .object({
          harness: z.enum(["model", "claude_code", "codex"]),
          model: z.string().max(100).optional(),
          fallback: z.boolean().optional(),
          agreeToPlanTerms: z.boolean().optional(),
        })
        .strict(),
    );
    const remote = input.harness !== "model";
    // As in PATCH: the owner without manage_agents doesn't change the harness or the model (the fallback stays
    // theirs), or /runtime would be a way around the edit's rule.
    if (!can(me.role, "manage_agents")) {
      const modelChanged =
        input.model !== undefined &&
        (remote ? (input.model || null) !== row.harnessModel : input.model !== row.model);
      if (input.harness !== row.harnessKind || modelChanged) throw forbidden();
    }
    const view = await harnessView(deps, row, me.userId);
    const option = view.options.find((o) => o.kind === input.harness);
    // Choosing again the harness already saved asks for nothing (e.g. only changing the model).
    if (remote && input.harness !== row.harnessKind && !option?.available) {
      throw conflict("harness.unavailable", "This harness is not available on the agent's environment", {
        reason: option?.reason ?? "",
      });
    }
    // The plan is personal: switching to Claude Code or Codex asks to accept the notice.
    if (remote && input.harness !== row.harnessKind && input.agreeToPlanTerms !== true)
      throw conflict("harness.terms_required", "Accept the plan terms to use this harness");
    if (input.model !== undefined) {
      const ok = remote ? executorModelOk(input.harness as Executor, input.model) : !!findModel(input.model);
      if (!ok) throw badRequest("Unknown model", { field: "model" });
    }
    const [updated] = await db
      .update(agents)
      .set({
        harnessKind: input.harness,
        ...(input.model !== undefined
          ? remote
            ? { harnessModel: input.model || null }
            : { model: input.model }
          : // Another harness without a model: the previous executor's model doesn't carry over, its default applies.
            input.harness !== row.harnessKind
            ? { harnessModel: null }
            : {}),
        ...(input.fallback !== undefined ? { harnessFallback: input.fallback } : {}),
        // As in PATCH: a new model turns off an advisor that no longer holds for it.
        ...(remote ? {} : advisorColumns(input.model ?? row.model, undefined, row)),
        updatedAt: now(),
      })
      .where(eq(agents.id, row.id))
      .returning();
    if (!updated) throw notFound("Agent not found");
    return c.json(await harnessView(deps, updated, me.userId));
  });

  // ---- credentials ----

  app.get(`${WORKSPACE}/credentials`, async (c) => {
    const me = requirePermission(c, "manage_credentials");
    const rows = await c
      .get("deps")
      .db.select()
      .from(credentials)
      .where(eq(credentials.workspaceId, me.workspaceId))
      .orderBy(asc(credentials.createdAt));
    return c.json({ credentials: rows.map(toCredential) });
  });

  app.get(`${WORKSPACE}/credentials/platform`, (c) => {
    requireMember(c);
    return c.json({ available: platformKeyAvailable(c.get("deps")) });
  });

  const apiKey = z.string().trim().min(10).max(400);
  app.post(`${WORKSPACE}/credentials`, async (c) => {
    const me = requirePermission(c, "manage_credentials");
    const { db, sealer } = c.get("deps");
    const input = await readJson(
      c,
      z
        .object({
          label: z.string().trim().min(1).max(60),
          provider: z.enum(["anthropic", "openai"]),
          apiKey,
          providerAccount: z.string().max(100).optional(),
          providerProject: z.string().max(100).optional(),
        })
        .strict(),
    );
    const extra: Record<string, string> = {};
    for (const k of ["providerAccount", "providerProject"] as const) {
      const v = input[k];
      if (v) extra[k] = v;
    }
    const [row] = await db
      .insert(credentials)
      .values({
        id: newId("cred"),
        workspaceId: me.workspaceId,
        label: input.label,
        provider: input.provider,
        secret: sealer.seal(input.apiKey),
        keyPreview: keyPreview(input.apiKey),
        extra,
        createdBy: me.userId,
      })
      .returning();
    if (!row) throw new Error("credential insert returned nothing");
    return c.json(toCredential(row), 201);
  });

  app.post(`${WORKSPACE}/credentials/:credentialId/rotate`, async (c) => {
    const me = requirePermission(c, "manage_credentials");
    const { db, sealer } = c.get("deps");
    const input = await readJson(c, z.object({ apiKey }).strict());
    const [row] = await db
      .update(credentials)
      .set({ secret: sealer.seal(input.apiKey), keyPreview: keyPreview(input.apiKey), revokedAt: null })
      .where(and(eq(credentials.id, param(c, "credentialId")), eq(credentials.workspaceId, me.workspaceId)))
      .returning();
    if (!row) throw notFound("Credential not found");
    return c.json(toCredential(row));
  });

  // Without purge the key is revoked (out of use, still in the list); with purge, it leaves the database.
  app.delete(`${WORKSPACE}/credentials/:credentialId`, async (c) => {
    const me = requirePermission(c, "manage_credentials");
    const { db, now } = c.get("deps");
    const { purge } = readQuery(c, z.object({ purge: z.enum(["true", "false"]).optional() }));
    const id = param(c, "credentialId");
    const [row] = await db
      .select({ id: credentials.id })
      .from(credentials)
      .where(and(eq(credentials.id, id), eq(credentials.workspaceId, me.workspaceId)));
    if (!row) throw notFound("Credential not found");
    await db.transaction(async (tx) => {
      await tx
        .update(agents)
        .set({ credentialId: null })
        .where(and(eq(agents.workspaceId, me.workspaceId), eq(agents.credentialId, id)));
      await tx
        .update(workspaces)
        .set({ primaryCredentialId: null })
        .where(and(eq(workspaces.id, me.workspaceId), eq(workspaces.primaryCredentialId, id)));
      if (purge === "true") await tx.delete(credentials).where(eq(credentials.id, id));
      else await tx.update(credentials).set({ revokedAt: now() }).where(eq(credentials.id, id));
    });
    return c.body(null, 204);
  });

  app.post(`${WORKSPACE}/agent-imports/github`, async (c) => {
    const me = requirePermission(c, "manage_agents");
    const deps = c.get("deps");
    const input = await readJson(c, z.object({ url: z.string().min(1).max(500) }).strict());
    // A private repository is read with the workspace's own GitHub App installation, as the skill import does.
    const ref = parseGithubUrl(input.url);
    const token = await repoReadToken(deps, me.workspaceId, ref.owner);
    return c.json({ files: await importInstructions(deps.fetchExternal, ref, token) });
  });

  // ---- runs ----

  app.get(`${WORKSPACE}/runs`, async (c) => {
    const me = requireMember(c);
    const { db } = c.get("deps");
    const q = readQuery(
      c,
      z.object({
        agentId: z.string().min(1).max(64).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      }),
    );
    const rows = await db
      .select({ run: runs, hidden: questionHidden(me) })
      .from(runs)
      .where(and(readableRuns(db, me), q.agentId ? eq(runs.agentId, q.agentId) : undefined))
      .orderBy(desc(runs.createdAt), desc(runs.id))
      .limit(q.limit);
    return c.json({ runs: rows.map((r) => toRun(r.hidden ? { ...r.run, what: "" } : r.run)) });
  });

  app.get(`${WORKSPACE}/runs/:runId`, async (c) => {
    const me = requireMember(c);
    const { db } = c.get("deps");
    const row = await readableRun(me.workspaceId, me.userId, param(c, "runId"), db);
    const steps = await db
      .select()
      .from(runEvents)
      .where(eq(runEvents.runId, row.id))
      .orderBy(asc(runEvents.seq));
    return c.json({
      run: toRun(row),
      steps: steps.map(
        (s): RunStep => ({ seq: s.seq, kind: s.kind, createdAt: s.createdAt.toISOString(), data: s.data }),
      ),
    });
  });

  // Stops the run: whoever started it, the agent's owner or whoever manages agents.
  // A run that already ended answers 409 run.already_ended (the client drops the row and reloads).
  app.post(`${WORKSPACE}/runs/:runId/cancel`, async (c) => {
    const me = requireMember(c);
    const { db, runtime } = c.get("deps");
    const row = await readableRun(me.workspaceId, me.userId, param(c, "runId"), db);
    const info = runtime.liveInfo(row.id);
    if (!info) throw conflict("run.already_ended", "This run already finished");
    const allowed =
      can(me.role, "manage_agents") || info.ownerUserId === me.userId || info.triggerAuthorId === me.userId;
    if (!allowed) throw forbidden();
    runtime.cancel(row.id, me.userId);
    return c.body(null, 204);
  });

  app.get(`${WORKSPACE}/channels/:channelId/active-runs`, async (c) => {
    const me = requireMember(c);
    const { db, runtime } = c.get("deps");
    const { channel } = await readableChannel(db, {
      workspaceId: me.workspaceId,
      userId: me.userId,
      channelId: param(c, "channelId"),
    });
    return c.json({ runs: runtime.activeRuns({ workspaceId: me.workspaceId, channelId: channel.id }) });
  });

  // "Working now": the live runs in the conversations the person can read.
  app.get(`${WORKSPACE}/active-runs`, async (c) => {
    const me = requireMember(c);
    const { db, runtime } = c.get("deps");
    const active = runtime.activeRuns({ workspaceId: me.workspaceId });
    if (active.length === 0) return c.json({ runs: [] });
    const readable = new Set(
      (
        await db
          .select({ id: channels.id })
          .from(channels)
          .where(sql`${channels.id} in ${readableChannelsSql(me)}`)
      ).map((r) => r.id),
    );
    const what = new Map(
      (
        await db
          .select({ id: runs.id, what: runs.what })
          .from(runs)
          .where(
            inArray(
              runs.id,
              active.map((a) => a.runId),
            ),
          )
      ).map((r) => [r.id, r.what]),
    );
    const out: WorkingRun[] = active
      .filter((a) => readable.has(a.channelId))
      .map((a) => ({
        runId: a.runId,
        agentId: a.agentId,
        channelId: a.channelId,
        threadId: a.threadId,
        status: a.status,
        startedAt: a.startedAt,
        what: what.get(a.runId) ?? "",
      }));
    return c.json({ runs: out });
  });

  app.get(`${WORKSPACE}/usage`, async (c) => {
    const me = requirePermission(c, "view_usage");
    const { db, now } = c.get("deps");
    const rows = await db
      .select({ agentId: runs.agentId, cost: sql<number>`coalesce(sum(${runs.costUsd}), 0)` })
      .from(runs)
      .where(and(eq(runs.workspaceId, me.workspaceId), gte(runs.createdAt, monthStart(now()))))
      .groupBy(runs.agentId);
    return c.json({ usage: rows.map((r) => ({ agentId: r.agentId, costUsd: Number(r.cost) })) });
  });

  // The instructions' timeline: each version with author, reason and source (edit, proposal, restore).
  app.get(`${WORKSPACE}/agents/:agentId/instruction-versions`, async (c) => {
    const me = requireMember(c);
    const { db } = c.get("deps");
    const row = await agentInWorkspace(db, me.workspaceId, param(c, "agentId"));
    const rows = await db
      .select()
      .from(instructionVersions)
      .where(eq(instructionVersions.agentId, row.id))
      .orderBy(desc(instructionVersions.seq))
      .limit(500);
    return c.json({ versions: rows.map(toInstructionVersion) });
  });

  // Going back to a version = writing a new one with its text. Who changes instructions: whoever manages agents.
  app.post(`${WORKSPACE}/agents/:agentId/instruction-versions/:instructionVersionId/restore`, async (c) => {
    const me = requirePermission(c, "manage_agents");
    const { db, now } = c.get("deps");
    const row = await agentInWorkspace(db, me.workspaceId, param(c, "agentId"));
    if (row.archivedAt) throw conflict("agent.archived", "This agent was archived");
    const input = await readJson(c, z.object({ reason: z.string().trim().max(500).optional() }).strict());
    const [v] = await db
      .select()
      .from(instructionVersions)
      .where(
        and(
          eq(instructionVersions.id, param(c, "instructionVersionId")),
          eq(instructionVersions.agentId, row.id),
        ),
      );
    if (!v) throw notFound("Version not found");
    const done = await writeInstructions(db, now(), {
      agentId: row.id,
      text: v.text,
      author: { type: "person", id: me.userId },
      reason: input.reason ?? "",
      source: "restore",
      restoredFromSeq: v.seq,
    });
    if (!done?.changed || !done.version)
      throw conflict("instructions.same", "The instructions already have this text");
    return c.json(toInstructionVersion(done.version));
  });

  app.get(`${WORKSPACE}/agents/:agentId/inbox`, async (c) => {
    const me = requireMember(c);
    const { db, now } = c.get("deps");
    const row = await agentInWorkspace(db, me.workspaceId, param(c, "agentId"));
    const { limit } = readQuery(c, z.object({ limit: z.coerce.number().int().min(1).max(50).default(10) }));
    // Stricter than the source: the person's own runs, under the same rule as GET /runs, so one of a private
    // channel they left doesn't show its question or its place.
    const mine = await db
      .select({ run: runs, hidden: questionHidden(me) })
      .from(runs)
      .innerJoin(messages, eq(messages.id, runs.sourceMessageId))
      .where(
        and(
          readableRuns(db, me),
          eq(runs.agentId, row.id),
          eq(messages.authorKind, "person"),
          eq(messages.authorId, me.userId),
        ),
      )
      .orderBy(desc(runs.createdAt))
      .limit(limit);
    const out: AgentInbox = {
      waiting: await waitingForMe(db, me, row.id, now()),
      recent: mine.map(({ run, hidden }) => ({
        runId: run.id,
        what: hidden ? "" : run.what,
        status: run.status,
        at: run.createdAt.toISOString(),
        channelId: run.channelId,
        threadId: run.threadId,
      })),
    };
    return c.json(out);
  });

  // ---- team ----

  app.get(`${WORKSPACE}/team`, async (c) => {
    const me = requireMember(c);
    const { db, runtime, now } = c.get("deps");
    const agentRows = await db
      .select()
      .from(agents)
      .where(and(eq(agents.workspaceId, me.workspaceId), isNull(agents.archivedAt)))
      .orderBy(asc(agents.name));
    const people = await db
      .select({ userId: members.userId, name: users.name, handle: members.handle, image: users.image })
      .from(members)
      .innerJoin(users, eq(users.id, members.userId))
      .where(eq(members.workspaceId, me.workspaceId))
      .orderBy(asc(users.name));
    const since = new Date(now().getTime() - 24 * 60 * 60 * 1000);
    const recent = await db
      .select()
      .from(delegations)
      .where(and(eq(delegations.workspaceId, me.workspaceId), gte(delegations.createdAt, since)))
      .orderBy(desc(delegations.createdAt))
      .limit(100);
    const busy = runtime.busyAgents();
    const testModel = await c.get("deps").testModelFor(me.workspaceId);
    const team: Team = {
      agents: (await withPlanOwners(db, agentRows)).map((a) => {
        const agent = toAgent(a, me.userId, busy.has(a.id), testModel(a));
        return {
          id: agent.id,
          name: agent.name,
          handle: agent.handle,
          role: agent.role,
          ownerUserId: agent.ownerUserId,
          busy: agent.busy,
          useWhen: firstSentence(a.instructions),
          capabilities: [],
          reachable: agent.reachable,
          appearance: agent.appearance,
        };
      }),
      people,
      delegations: recent.map((x) => ({
        requesterAgentId: x.requesterAgentId,
        delegateAgentId: x.delegateAgentId,
        status: x.status,
        at: x.createdAt.toISOString(),
      })),
    };
    return c.json(team);
  });

  // ---- skills per agent ----

  app.get(`${WORKSPACE}/agents/:agentId/skills`, async (c) => {
    const me = requireMember(c);
    const { db } = c.get("deps");
    const row = await agentInWorkspace(db, me.workspaceId, param(c, "agentId"));
    return c.json({ skills: await skillsForAgent(db, me.workspaceId, row.id) });
  });

  app.put(`${WORKSPACE}/agents/:agentId/skills`, async (c) => {
    const me = requireMember(c);
    const { db } = c.get("deps");
    const row = await agentInWorkspace(db, me.workspaceId, param(c, "agentId"));
    requireAgentEditor(me, row);
    const input = await readJson(
      c,
      z.object({
        skills: z.array(z.object({ id: z.string().min(1).max(64), enabled: z.boolean() }).strict()).max(200),
      }),
    );
    const ids = [...new Set(input.skills.map((s) => s.id))];
    if (ids.length) {
      const found = await db
        .select({ id: skills.id })
        .from(skills)
        .where(and(eq(skills.workspaceId, me.workspaceId), inArray(skills.id, ids)));
      if (found.length !== ids.length) throw badRequest("Unknown skill", { field: "skills" });
    }
    for (const s of input.skills) {
      await db
        .insert(skillGrants)
        .values({ agentId: row.id, skillId: s.id, enabled: s.enabled })
        .onConflictDoUpdate({
          target: [skillGrants.agentId, skillGrants.skillId],
          set: { enabled: s.enabled },
        });
    }
    return c.json({ skills: await skillsForAgent(db, me.workspaceId, row.id) });
  });
}

async function skillsForAgent(db: Db, workspaceId: string, agentId: string) {
  const rows = await db
    .select({ skill: skills, enabled: skillGrants.enabled })
    .from(skills)
    .leftJoin(skillGrants, and(eq(skillGrants.skillId, skills.id), eq(skillGrants.agentId, agentId)))
    .where(eq(skills.workspaceId, workspaceId))
    .orderBy(asc(skills.name));
  return rows.map((r) => ({ ...toSkill(r.skill), enabled: r.enabled ?? false }));
}
