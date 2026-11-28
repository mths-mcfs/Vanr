// Routines: list, create, edit, pause, run now, history, duplicate, delete, understand schedule phrases ("every
// Monday at 9am"), the webhook's secret and the public (signed) webhook that fires the routine from outside.
import type {
  DescribeRuleBody,
  ParseRuleBody,
  ParseScheduleBody,
  RecurrenceRule,
  Routine,
  RoutineDuplicateBody,
  RoutineEstimate,
  RoutineInput,
  RoutineRun,
  RoutineRunBody,
  RoutineTarget,
  RoutineTrigger,
  RoutineWebhookResult,
  RoutineWebhookSecret,
  RuleInfo,
  ScheduleParse,
} from "@vanr/contract";
import { can } from "@vanr/contract";
import { schema } from "@vanr/engine/db";
import { newId } from "@vanr/engine/ids";
import { isTimezone, nextRuns, validateRule } from "@vanr/engine/recurrence";
import { describeRule, parseRulePhrase, parseSchedulePhrase, upcoming } from "@vanr/engine/recurrence-text";
import { createSealer, type Sealer } from "@vanr/engine/seal";
import { and, desc, eq } from "drizzle-orm";
import type { Hono } from "hono";
import { z } from "zod";
import { type AgentRow, agentInWorkspace, seesSpend } from "../agents";
import { writableChannel } from "../channels";
import type { AppDeps, AppEnv, Ctx, WorkspaceMember } from "../context";
import {
  debateEstimate,
  fileUpToUsd,
  recentRoutineCosts,
  routineEstimate,
  speakerAgents,
} from "../estimates";
import { errorBody, forbidden, HttpError, notFound, param, readJson } from "../http";
import { mailAccountById, mailboxesOf } from "../integrations/mail";
import {
  anchorOf,
  canSeeRoutine,
  checkRule,
  contextChars,
  fileRoutineSystem,
  nextRunFor,
  policyOf,
  policySchema,
  type RoutineRow,
  registerFire,
  routineById,
  ruleSchema,
  startRoutineRun,
  targetOf,
  targetSchema,
  toRoutine,
  toRoutines,
  toRun,
  triggerOf,
  triggerSchema,
  visibleRunsSql,
  webhookUrl,
} from "../routines";
import { requireCanTalk, requirePlanOwners } from "../runners/plans";
import { newWebhookSecret, verifyWebhook } from "../webhook-signature";
import { requireMember, WORKSPACE } from "../workspace-scope";

const { routines, routineExecutions, agents, channelMemberships } = schema;

/**
 * The most the webhook reads of a body (the origin's limit). The signature covers the body, so it is read whole
 * (up to this) before it is checked; past it the read stops and nothing is written.
 */
export const MAX_WEBHOOK_BODY = 10_000;

const routineFields = {
  name: z.string().trim().max(120).optional(),
  agentId: z.string().min(1),
  prompt: z.string().trim().min(1).max(10_000),
  target: targetSchema,
  trigger: triggerSchema,
  policy: policySchema.optional(),
  active: z.boolean().optional(),
};
const routineInput = z.object(routineFields).strict() satisfies z.ZodType<RoutineInput>;
const routinePatch = z.object(routineFields).partial().strict() satisfies z.ZodType<Partial<RoutineInput>>;
const runBody = z
  .object({ key: z.string().trim().min(1).max(200).optional() })
  .strict() satisfies z.ZodType<RoutineRunBody>;
const duplicateBody = z
  .object({ name: z.string().trim().min(1).max(120).optional() })
  .strict() satisfies z.ZodType<RoutineDuplicateBody>;
const parseScheduleBody = z
  .object({ phrase: z.string().max(300), timezone: z.string().max(64) })
  .strict() satisfies z.ZodType<ParseScheduleBody>;
const parseRuleBody = z
  .object({ phrase: z.string().max(300), timezone: z.string().max(64).optional() })
  .strict() satisfies z.ZodType<ParseRuleBody>;
const describeRuleBody = z.object({ rule: ruleSchema }).strict() satisfies z.ZodType<DescribeRuleBody>;

/**
 * The body as text, reading at most `max` bytes; past that it cancels the read and returns null. Local to the
 * webhook: the base's `readJson` doesn't cap the body yet (the server base's cap arrives at the next merge).
 */
async function readCapped(body: ReadableStream<Uint8Array> | null, max: number): Promise<string | null> {
  if (!body) return "";
  const reader = body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    parts.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(parts));
}

/** Cipher of the webhook's secret: its own key (the HKDF `info` keeps it apart from the credentials' one). */
const sealers = new Map<string, Sealer>();
function webhookSealer(deps: AppDeps): Sealer {
  const key = deps.config.authSecret;
  let sealer = sealers.get(key);
  if (!sealer) {
    sealer = createSealer(key, "routine-webhook");
    sealers.set(key, sealer);
  }
  return sealer;
}

/**
 * Turning on needs a next time: a "once" that already passed and a series that ended (`until`, `count`) would stay
 * on without ever running. Event, email and webhook have no time.
 */
function nextRunToActivate(trigger: RoutineTrigger, now: Date, anchor: Date): Date | null {
  if (trigger.kind !== "schedule" && trigger.kind !== "once") return null;
  const next = nextRunFor(trigger, now, anchor);
  if (!next)
    throw trigger.kind === "once"
      ? new HttpError(400, "rule.past", "That time has passed", { code: "rule.past" })
      : new HttpError(400, "rule.ended", "This schedule has no more runs", { code: "rule.ended" });
  return next;
}

/**
 * Checks what only the server knows: the agent, the channel, the rule and the time. `askedBy` is whom the routine
 * runs for (its creator): a debate it opens is asked by that person.
 */
async function checkInput(
  deps: AppDeps,
  me: WorkspaceMember,
  input: { agentId: string; target: RoutineTarget; trigger: RoutineTrigger },
  askedBy: string,
) {
  const agent = await agentInWorkspace(deps.db, me.workspaceId, input.agentId);
  if (agent.archivedAt) throw notFound("Agent not found");
  await requireCanTalk(deps.db, agent, me.userId);
  const { target, trigger } = input;
  if (target.kind === "channel") {
    await writableChannel(deps.db, {
      workspaceId: me.workspaceId,
      userId: me.userId,
      channelId: target.channelId,
    });
    const [inChannel] = await deps.db
      .select({ id: channelMemberships.memberId })
      .from(channelMemberships)
      .where(
        and(
          eq(channelMemberships.channelId, target.channelId),
          eq(channelMemberships.memberType, "agent"),
          eq(channelMemberships.memberId, agent.id),
        ),
      );
    if (!inChannel)
      throw new HttpError(400, "routine.agent_not_in_channel", `${agent.name} is not in this channel`, {
        agentId: agent.id,
      });
  }
  if (target.kind === "debate") {
    const table: AgentRow[] = [];
    for (const id of target.agentIds) {
      const a = await agentInWorkspace(deps.db, me.workspaceId, id);
      if (a.archivedAt) throw notFound("Agent not found");
      table.push(a);
    }
    await requirePlanOwners(deps.db, table, askedBy);
  }
  if (trigger.kind === "schedule") checkRule(trigger.rule);
  if (trigger.kind === "once") {
    if (!isTimezone(trigger.timezone)) throw new HttpError(400, "rule.timezone", "Unknown time zone");
    if (new Date(trigger.at) <= deps.now()) throw new HttpError(400, "rule.past", "That time has passed");
  }
  if (trigger.kind === "email") {
    // The routine reads the inbox as the agent: it needs access to the inbox and to the folder.
    const account = await mailAccountById(deps.db, me.workspaceId, trigger.accountId);
    if (account.via !== "imap")
      throw new HttpError(400, "routine.email_unsupported", "Use an inbox connected by IMAP", {
        accountId: account.id,
      });
    const box = (await mailboxesOf(deps.db, agent.id)).find((b) => b.accountId === account.id);
    if (!box || box.level === "none")
      throw new HttpError(400, "routine.email_no_access", `${agent.name} has no access to this inbox`, {
        accountId: account.id,
      });
    if (box.policy.folders.length > 0 && !box.policy.folders.includes(trigger.folder))
      throw new HttpError(400, "routine.email_folder", `${agent.name} can't read this folder`, {
        folder: trigger.folder,
      });
  }
}

/** Only whoever created the routine or an admin changes it. */
function requireEditor(me: WorkspaceMember, row: RoutineRow) {
  if (row.createdBy !== me.userId && !can(me.role, "configure"))
    throw forbidden("Only who created the routine or an admin can change it");
}

/** The routine, if the person may see it (otherwise 404, the same as one that doesn't exist). */
async function routineOf(c: Ctx, me: WorkspaceMember, opts: { edit?: boolean } = {}) {
  const deps = c.get("deps");
  const row = await routineById(deps.db, me.workspaceId, param(c, "routineId"));
  if (!(await canSeeRoutine(deps, me, row))) throw notFound("Routine not found");
  if (opts.edit) requireEditor(me, row);
  return row;
}

const defaultName = (prompt: string) => {
  const line = prompt.split("\n")[0]?.trim() ?? "";
  return line.length > 60 ? `${line.slice(0, 59)}…` : line || "Routine";
};

function ruleInfo(rule: RecurrenceRule | null, now: Date): RuleInfo {
  if (!rule)
    return {
      ok: false,
      rule: null,
      code: "rule.empty",
      error: "No rule",
      description: null,
      upcomingFireTimes: [],
    };
  const code = validateRule(rule);
  if (code) return { ok: false, rule, code, error: code, description: null, upcomingFireTimes: [] };
  return {
    ok: true,
    rule,
    code: null,
    error: null,
    description: describeRule(rule, "en"),
    upcomingFireTimes: upcoming(rule, now, 4),
  };
}

const noSchedule = (error: string): ScheduleParse => ({
  ok: false,
  trigger: null,
  description: null,
  upcomingFireTimes: [],
  error,
});

export function registerRoutines(app: Hono<AppEnv>) {
  app.get(`${WORKSPACE}/routines`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const rows = await deps.db
      .select()
      .from(routines)
      .where(eq(routines.workspaceId, me.workspaceId))
      .orderBy(desc(routines.createdAt))
      .limit(500);
    const visible: RoutineRow[] = [];
    for (const row of rows) if (await canSeeRoutine(deps, me, row)) visible.push(row);
    return c.json<{ routines: Routine[] }>({ routines: await toRoutines(deps, me, visible) });
  });

  app.post(`${WORKSPACE}/routines`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const input = await readJson(c, routineInput);
    await checkInput(deps, me, input, me.userId);
    const now = deps.now();
    // It starts paused: turning it on is an explicit action (`active: true` here, or the switch later).
    const active = input.active === true;
    const [row] = await deps.db
      .insert(routines)
      .values({
        id: newId("rtn"),
        workspaceId: me.workspaceId,
        name: input.name || defaultName(input.prompt),
        prompt: input.prompt,
        agentId: input.agentId,
        target: input.target,
        trigger: input.trigger,
        policy: input.policy ?? {},
        active,
        nextFireAt: active ? nextRunToActivate(input.trigger, now, now) : null,
        hookId: input.trigger.kind === "webhook" ? newId("hook") : null,
        createdBy: me.userId,
        createdAt: now,
      })
      .returning();
    if (!row) throw new Error("routine insert failed");
    return c.json<Routine>(await toRoutine(deps, me, row), 201);
  });

  // One PATCH pauses/resumes and edits (only the fields that came). It reads, decides and writes under the
  // routine's row lock: a fire claiming the routine at the same time waits, and so does another edit.
  app.patch(`${WORKSPACE}/routines/:routineId`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const id = param(c, "routineId");
    await routineOf(c, me, { edit: true });
    const patch = await readJson(c, routinePatch);
    const updated = await deps.db.transaction(async (tx) => {
      const scoped = { ...deps, db: tx };
      const [row] = await tx
        .select()
        .from(routines)
        .where(and(eq(routines.id, id), eq(routines.workspaceId, me.workspaceId)))
        .for("no key update");
      if (!row) throw notFound("Routine not found");
      requireEditor(me, row);
      const before = triggerOf(row);
      const next = {
        agentId: patch.agentId ?? row.agentId,
        target: patch.target ?? targetOf(row),
        trigger: patch.trigger ?? before,
      };
      if (patch.agentId || patch.target || patch.trigger) await checkInput(scoped, me, next, row.createdBy);
      const active = patch.active ?? row.active;
      const turnedOn = patch.active === true && !row.active;
      const scheduleChanged = !!patch.trigger || turnedOn;
      const triggerChanged = JSON.stringify(next.trigger) !== JSON.stringify(before);
      // A trigger sent again starts the series again (the `count` restarts from here).
      const anchor = patch.trigger ? deps.now() : anchorOf(row);
      // Turning on again (or changing the time of one that is on) without a next time is an error, not a routine
      // left on and stopped.
      const nextFireAt =
        scheduleChanged && active ? nextRunToActivate(next.trigger, deps.now(), anchor) : null;
      const [saved] = await tx
        .update(routines)
        .set({
          ...(patch.name !== undefined
            ? { name: patch.name || defaultName(patch.prompt ?? row.prompt) }
            : {}),
          ...(patch.prompt !== undefined ? { prompt: patch.prompt } : {}),
          agentId: next.agentId,
          target: next.target,
          trigger: next.trigger,
          active,
          ...(patch.policy ? { policy: { ...policyOf(row), ...patch.policy } } : {}),
          ...(scheduleChanged ? { nextFireAt } : {}),
          ...(patch.trigger ? { scheduleFrom: anchor } : {}),
          ...(active === false ? { nextFireAt: null } : {}),
          // Turning it on, or a person's pause: no reason left over. A pause over the series' end (the last fire
          // recorded, not yet started) is the person's, so that fire doesn't run.
          ...(turnedOn || patch.active === false ? { pausedReason: null } : {}),
          ...(next.trigger.kind === "webhook" && !row.hookId ? { hookId: newId("hook") } : {}),
          ...(next.trigger.kind !== "webhook" ? { hookId: null, webhookSecret: null } : {}),
          // Another inbox or folder: the cursor starts again (the first check only marks the position).
          ...(triggerChanged ? { cursor: null } : {}),
        })
        .where(eq(routines.id, row.id))
        .returning();
      return saved;
    });
    if (!updated) throw notFound("Routine not found");
    return c.json<Routine>(await toRoutine(deps, me, updated));
  });

  app.delete(`${WORKSPACE}/routines/:routineId`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const row = await routineOf(c, me, { edit: true });
    await deps.db.delete(routines).where(eq(routines.id, row.id));
    return c.body(null, 204);
  });

  // It runs in the background; the answer already says `running` and the history shows the result. With the
  // client's key, the same request repeated (a double click, a resend) runs once.
  app.post(`${WORKSPACE}/routines/:routineId/run`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const row = await routineOf(c, me, { edit: true });
    const { key } = await readJson(c, runBody);
    const reg = await registerFire(deps, row.id, { trigger: "manual", key: key ? `manual:${key}` : null });
    if (!reg.duplicate) deps.runtime.track(startRoutineRun(deps, reg.run), "routine.manual");
    return c.json<Routine>({ ...(await toRoutine(deps, me, row)), running: true });
  });

  // The webhook's secret (Standard Webhooks): makes a new one and shows it only here; the old one stops working.
  app.post(`${WORKSPACE}/routines/:routineId/webhook-secret`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const row = await routineOf(c, me, { edit: true });
    const url = webhookUrl(deps, row);
    if (!url || !row.hookId)
      throw new HttpError(400, "routine.not_webhook", "This routine has no webhook trigger");
    const secret = newWebhookSecret();
    // Only while the routine still has this webhook: an edit that took the trigger away doesn't get a secret back.
    const [saved] = await deps.db
      .update(routines)
      .set({ webhookSecret: webhookSealer(deps).seal(secret) })
      .where(and(eq(routines.id, row.id), eq(routines.hookId, row.hookId)))
      .returning({ id: routines.id });
    if (!saved) throw new HttpError(400, "routine.not_webhook", "This routine has no webhook trigger");
    c.header("cache-control", "no-store");
    return c.json<RoutineWebhookSecret>({ url, secret });
  });

  // The cost before running: the cap when there is one and what the latest executions measured.
  app.get(`${WORKSPACE}/routines/:routineId/estimate`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const row = await routineOf(c, me);
    const at = deps.now();
    const target = targetOf(row);
    // What the latest runs cost is spend: only with view_usage, and only the runs the person sees.
    const recent = seesSpend(me) ? await recentRoutineCosts(deps.db, row.id, me) : null;
    const [agent] = await speakerAgents(deps.db, me.workspaceId, [row.agentId]);
    // The trigger can add outside content to the request (webhook, email, event): its ceiling counts.
    const extra = contextChars(triggerOf(row));
    let bound: { upToUsd: number; calls: number } | null = null;
    if (agent && target.kind === "file")
      bound = { upToUsd: fileUpToUsd(agent, fileRoutineSystem(agent), row.prompt, extra, at), calls: 1 };
    else if (target.kind === "debate")
      bound = debateEstimate(
        await speakerAgents(deps.db, me.workspaceId, target.agentIds),
        { roundLimit: target.roundLimit, titleChars: row.name.length, goalChars: row.prompt.length + extra },
        at,
      );
    return c.json<RoutineEstimate>(
      routineEstimate({ upToUsd: bound?.upToUsd ?? null, calls: bound?.calls ?? null, recent: recent ?? [] }),
    );
  });

  app.get(`${WORKSPACE}/routines/:routineId/runs`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const row = await routineOf(c, me);
    const rows = await deps.db
      .select()
      .from(routineExecutions)
      .where(and(eq(routineExecutions.routineId, row.id), visibleRunsSql(me)))
      .orderBy(desc(routineExecutions.at))
      .limit(30);
    return c.json<{ runs: RoutineRun[] }>({ runs: rows.map(toRun) });
  });

  app.post(`${WORKSPACE}/routines/:routineId/duplicate`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const row = await routineOf(c, me);
    const { name } = await readJson(c, duplicateBody);
    const trigger = triggerOf(row);
    await checkInput(
      deps,
      me,
      {
        agentId: row.agentId,
        target: targetOf(row),
        trigger:
          trigger.kind === "once" && new Date(trigger.at) <= deps.now() ? { kind: "webhook" } : trigger,
      },
      me.userId,
    );
    const [copy] = await deps.db
      .insert(routines)
      .values({
        id: newId("rtn"),
        workspaceId: me.workspaceId,
        name: name ?? `${row.name} (copy)`,
        prompt: row.prompt,
        agentId: row.agentId,
        target: row.target,
        trigger: row.trigger,
        // The copy starts paused: whoever duplicated it reviews it before turning it on.
        active: false,
        nextFireAt: null,
        policy: row.policy,
        hookId: trigger.kind === "webhook" ? newId("hook") : null,
        createdBy: me.userId,
        createdAt: deps.now(),
      })
      .returning();
    if (!copy) throw new Error("routine insert failed");
    return c.json<Routine>(await toRoutine(deps, me, copy), 201);
  });

  app.post(`${WORKSPACE}/routines/parse-schedule`, async (c) => {
    requireMember(c);
    const deps = c.get("deps");
    const { phrase, timezone } = await readJson(c, parseScheduleBody);
    const now = deps.now();
    if (!isTimezone(timezone)) return c.json<ScheduleParse>(noSchedule("rule.timezone"));
    const parsed = parseSchedulePhrase(phrase, timezone, now);
    if (!parsed.ok) return c.json<ScheduleParse>(noSchedule(parsed.code));
    if (parsed.kind === "once") {
      const at = parsed.at.toISOString();
      return c.json<ScheduleParse>({
        ok: true,
        trigger: { kind: "once", at, timezone },
        description: `Once, ${at}`,
        upcomingFireTimes: [at],
        error: null,
      });
    }
    return c.json<ScheduleParse>({
      ok: true,
      trigger: { kind: "schedule", rule: parsed.rule },
      description: describeRule(parsed.rule, "en"),
      upcomingFireTimes: nextRuns(parsed.rule, now, 4).map((d) => d.toISOString()),
      error: null,
    });
  });

  app.post(`${WORKSPACE}/routines/parse-rule`, async (c) => {
    requireMember(c);
    const deps = c.get("deps");
    const { phrase, timezone } = await readJson(c, parseRuleBody);
    const tz = timezone ?? "UTC";
    const rejected = (code: string): RuleInfo => ({
      ok: false,
      rule: null,
      code,
      error: code,
      description: null,
      upcomingFireTimes: [],
    });
    if (!isTimezone(tz)) return c.json<RuleInfo>(rejected("rule.timezone"));
    const parsed = parseRulePhrase(phrase, tz);
    if (!parsed.ok) return c.json<RuleInfo>(rejected(parsed.code));
    return c.json<RuleInfo>(ruleInfo(parsed.rule, deps.now()));
  });

  app.post(`${WORKSPACE}/routines/describe-rule`, async (c) => {
    requireMember(c);
    const deps = c.get("deps");
    const { rule } = await readJson(c, describeRuleBody);
    return c.json<RuleInfo>(ruleInfo(rule, deps.now()));
  });

  // The public webhook, Standard Webhooks: the path only says which routine (it carries the public hook id, never
  // the secret); the signature proves the sender (`webhook-id`, `webhook-timestamp`, `webhook-signature`). The
  // `webhook-id` is the dedupe key: the same message repeated doesn't run again and comes back 200 with
  // `duplicate`, so the sender stops resending. The body goes into the request marked as outside data.
  app.post("/api/v1/hooks/routines/:routineId", async (c) => {
    const deps = c.get("deps");
    const hookId = param(c, "routineId");
    const [row] = await deps.db.select().from(routines).where(eq(routines.hookId, hookId));
    if (!row || triggerOf(row).kind !== "webhook")
      return c.json(errorBody("not_found", "Unknown webhook"), 404);
    if (!row.webhookSecret)
      return c.json(errorBody("webhook.no_secret", "Generate the webhook secret first"), 401);
    const length = Number(c.req.header("content-length") ?? "0");
    if (length > MAX_WEBHOOK_BODY) return c.json(errorBody("payload_too_large", "Body is too large"), 413);
    // Without content-length (a chunked body), it reads only up to the limit and stops.
    const raw = await readCapped(c.req.raw.body, MAX_WEBHOOK_BODY);
    if (raw === null) return c.json(errorBody("payload_too_large", "Body is too large"), 413);
    const check = verifyWebhook(
      webhookSealer(deps).open(row.webhookSecret),
      {
        id: c.req.header("webhook-id"),
        timestamp: c.req.header("webhook-timestamp"),
        signature: c.req.header("webhook-signature"),
      },
      raw,
      deps.now(),
    );
    if (!check.ok) return c.json(errorBody(check.code, "Invalid webhook signature"), 401);
    if (!row.active) return c.json(errorBody("routine.inactive", "This routine is paused"), 409);
    const [agent] = await deps.db.select({ id: agents.id }).from(agents).where(eq(agents.id, row.agentId));
    if (!agent) return c.json(errorBody("not_found", "Unknown webhook"), 404);
    const reg = await registerFire(deps, row.id, {
      trigger: "webhook",
      key: `webhook:${check.id}`,
      ...(raw ? { context: { text: `Webhook payload:\n${raw}`, untrusted: `webhook ${row.name}` } } : {}),
    });
    if (reg.duplicate) return c.json<RoutineWebhookResult>({ ok: true, duplicate: true }, 200);
    deps.runtime.track(startRoutineRun(deps, reg.run), "routine.webhook");
    return c.json<RoutineWebhookResult>({ ok: true, runId: reg.run.id }, 202);
  });
}
