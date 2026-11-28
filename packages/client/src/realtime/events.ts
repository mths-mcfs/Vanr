// The realtime events a browser receives, each with the schema of its payload. The event names are the
// ones in the server's event table; the names in that table that never reach a browser (the runner's
// protocol, error codes, log lines, the browser's own frames) are listed apart, each with why.
//
// A payload declares what the client relies on. Ids the event is scoped by are required; the rest is
// optional, because the event only signals and the client reads the source of truth again over HTTP.
import * as C from "../contract-schemas.ts";
import type { Infer } from "../schema.ts";
import * as s from "../schema.ts";

const id = s.string;
const opt = s.optional;

const run = <S extends Record<string, s.AnySchema>>(extra: S) =>
  s.object({ agentId: id, runId: opt(id), channelId: opt(id), threadId: opt(s.nullable(id)), ...extra });

const runnerId = { runnerId: id };

export const BROWSER_EVENTS = {
  // Runs and agents at work.
  "run.status_changed": run({ status: opt(s.string) }),
  "run.text_delta": run({ text: opt(s.string) }),
  "run.thinking": run({ text: opt(s.string) }),
  "run.commentary": run({ text: opt(s.string) }),
  "run.tool_call": run({ tool: opt(s.string), toolUseId: opt(s.string) }),
  "run.tool_result": run({ tool: opt(s.string), toolUseId: opt(s.string), isError: opt(s.boolean) }),
  "run.steered": run({ messageId: opt(id) }),
  "run.idle": run({}),
  "run.stopped": run({}),
  "run.completed": run({ status: opt(s.string) }),
  "run.agent_unavailable": run({ reason: s.string }),
  "agent.typing": s.object({ agentId: id, ttlMs: opt(s.number) }),
  "delegation.started": s.object({ agentId: opt(id), delegateAgentId: opt(id), runId: opt(id) }),
  "delegation.completed": s.object({ agentId: opt(id), delegateAgentId: opt(id), runId: opt(id) }),
  // Without view_usage the amounts come null: the notice says only that the agent reached its budget.
  "budget.threshold_reached": s.object({
    agentId: id,
    spentUsd: s.nullable(s.number),
    budgetUsd: s.nullable(s.number),
  }),
  "budget.cap_reached": s.object({
    agentId: id,
    spentUsd: s.nullable(s.number),
    budgetUsd: s.nullable(s.number),
  }),
  "memory.recorded": s.object({ agentId: id, memoryId: opt(id) }),

  // Channels and messages.
  "message.posted": s.object({ message: C.Message }),
  "message.reactions_updated": s.object({ messageId: id, reactions: s.array(C.ReactionCount) }),
  "message.routed": s.object({
    messageId: id,
    claimedBy: opt(s.array(id)),
    viewedBy: opt(s.array(id)),
    blocked: opt(s.array(s.object({ agentId: id, reason: s.string }))),
  }),
  "message.claimed": s.object({ messageId: id, agentId: id }),
  "message.handled": s.object({ messageId: id, agentId: id, runId: id, status: C.HandledStatus }),
  "message.memories_updated": s.object({ messageId: id, memories: s.array(C.MessageMemory) }),
  "message.actions_updated": s.object({ messageId: id, actions: s.array(C.AgentAction) }),
  "thread.info_changed": s.object({ threadId: id, channelId: opt(id), replyCount: opt(s.number) }),
  "channel.unread": s.object({ channelId: opt(id), unreadCount: opt(s.number) }),
  "channel.budget": s.object({
    channelId: id,
    channelName: s.string,
    level: s.string,
    spentUsd: s.nullable(s.number),
    budgetUsd: s.nullable(s.number),
  }),
  "person.typing": s.object({ userId: id, ttlMs: s.number }),

  // Human in the loop.
  "approval.requested": s.object({ approvalId: opt(id), agentId: opt(id) }),
  "approval.resolved": s.object({ approvalId: opt(id), agentId: opt(id) }),
  "proposal.created": s.object({ proposalId: opt(id), agentId: opt(id) }),
  "proposal.decided": s.object({ proposalId: opt(id), agentId: opt(id) }),
  "question.raised": s.object({ questionId: opt(id), channelId: opt(id) }),
  "question.closed": s.object({ questionId: opt(id), channelId: opt(id) }),
  "secret_request.created": s.object({ secretRequestId: opt(id), agentId: opt(id) }),
  "secret_request.updated": s.object({ secretRequestId: opt(id), agentId: opt(id) }),
  "browser_intervention.updated": s.object({ intervention: C.BrowserIntervention }),
  "network.changed": s.object({ agentId: id }),
  "network.requested": s.object({ agentId: opt(id), networkRequestId: opt(id) }),
  "network.updated": s.object({ agentId: opt(id), networkRequestId: opt(id) }),
  "connector.scope": s.object({ connectionId: opt(id), messageId: opt(id) }),

  // The agent's browser, seen live.
  "live_view.frame": s.object({
    agentId: id,
    data: s.string,
    seq: s.number,
    metadata: s.object({ deviceWidth: s.number, deviceHeight: s.number, url: s.nullable(s.string) }),
  }),
  "live_view.status": s.object({
    agentId: id,
    mode: s.literal("watch", "control"),
    controllingUserId: s.nullable(id),
    intervention: s.nullable(s.object({ id, status: C.InterventionStatus })),
  }),
  "live_view.ended": s.object({ agentId: id, reason: opt(s.string) }),
  "live_view.unavailable": s.object({ agentId: id, reason: opt(s.string) }),

  // Runners, jobs and environments.
  "runner.paired": s.object(runnerId),
  "runner.updated": s.object({ ...runnerId, name: opt(s.string) }),
  "runner.deleted": s.object(runnerId),
  "runner.revoked": s.object({ ...runnerId, reason: opt(s.string) }),
  "runner.presence_changed": s.object({ ...runnerId, online: s.boolean }),
  "runner.pause_changed": s.object({ ...runnerId, paused: s.boolean }),
  "runner.sandbox_changed": s.object({ ...runnerId, sandbox: C.RunnerSandbox }),
  "runner.access": s.object({ ...runnerId, access: C.RunnerAccess }),
  "runner.agents_moved": s.object({ runnerId: opt(id), toRunnerId: opt(id) }),
  "job.updated": s.object({ job: C.Job }),
  "environment.updated": s.object({ agentId: id, environment: opt(C.AgentEnvironment) }),

  // Work.
  "assignment.updated": s.object({ assignmentId: id, threadId: opt(id), messageId: opt(id) }),
  "assignment.trail_event": s.object({ assignmentId: id, threadId: opt(id) }),
  "debate.updated": s.object({ debateId: id }),
  "debate.post_created": s.object({ debateId: id, postId: opt(id) }),
  "debate.turn_requested": s.object({ debateId: id, title: opt(s.string) }),
  "debate.requested": s.object({ debateId: id, title: opt(s.string) }),
  "debate.concluded": s.object({ debateId: id, title: opt(s.string) }),
  "debate.suggestion_updated": s.object({ messageId: id, suggestion: C.DebateSuggestion }),
  "issue.created": s.object({ issueId: opt(id), number: opt(s.number) }),
  "issue_column.list_updated": s.object({ columns: s.array(C.IssueColumn) }),
  "calendar_event.saved": s.object({ event: C.CalendarEvent }),
  "calendar_event.removed": s.object({ eventId: id, instanceStart: opt(s.string) }),
  "routine.event": s.object({ routineId: id, runId: opt(id) }),
  "notification.shown": s.object({ notification: C.AppNotification }),
  "notification.hidden": s.object({ id }),
  "notification.counts_updated": s.object({ counts: C.NotificationCounts }),

  // Content.
  "file.created": s.object({ fileId: opt(id), channelId: opt(s.nullable(id)) }),
  "file.updated": s.object({ fileId: opt(id), channelId: opt(s.nullable(id)) }),
  "file.deleted": s.object({ fileId: opt(id), channelId: opt(s.nullable(id)) }),
  "base.created": s.object({ baseId: id }),
  "base.updated": s.object({ baseId: id }),
  "base.deleted": s.object({ baseId: id }),
  "base.rows": s.object({ baseId: id, tableId: opt(id) }),
  "base.recalc": s.object({ baseId: id, tableId: id, processed: s.number, done: s.boolean }),
} as const;

export type BrowserEventName = keyof typeof BROWSER_EVENTS;
export type EventPayload<E extends BrowserEventName> = Infer<(typeof BROWSER_EVENTS)[E]>;

/** Names in the server's event table that a browser never receives, and why. */
export const NOT_BROWSER_EVENTS = {
  "access.changed": "runner protocol: the server tells a runner its access changed",
  "app.browser_log_purge": "database setting used by the browser-log purge job",
  "browser.act": "agent tool call logged by the server",
  "browser.close": "agent tool call logged by the server",
  "browser.inspect": "agent tool call handled by the runner",
  "browser.open": "agent tool call logged by the server",
  "cli.changed": "runner protocol: the runner reports its installed CLIs",
  "harness.event": "runner protocol: an event from the harness running on the runner",
  "harness.tool": "runner protocol: the harness called a tool",
  "harness.tool_result": "runner protocol: a tool result going back to the harness",
  "harness.turn": "runner protocol: a harness turn",
  "harness.unavailable": "error code and notice template, not an event",
  "item.completed": "external protocol (the Codex CLI's JSON stream)",
  "job.ack": "runner protocol: the runner took a job",
  "job.done": "runner protocol: a job finished",
  "job.event": "runner protocol: a job's progress (browsers get job.updated)",
  "live_view.input": "a frame the browser sends (input for the live view)",
  "live_view.stream_ended": "runner protocol: the live stream stopped on the runner",
  "live_view.subscribe": "a frame the browser sends (start watching)",
  "live_view.unsubscribe": "a frame the browser sends (stop watching)",
  "runner.state": "runner protocol: the runner's state report",
  "sandbox.changed": "runner protocol: the runner's sandbox setting",
  "thread.started": "external protocol (the Codex CLI)",
  "turn.completed": "external protocol (the coding CLIs)",
  "turn.failed": "external protocol (the coding CLIs)",
  "assignment.agent_not_in_channel": "error code",
  "assignment.engine_act_failed": "server log line",
  "base.title_required": "error code",
  "calendar.end_before_start": "error code",
  "channel.general": "error code",
  "channel.name_taken": "error code",
  "connector.unknown_tool": "error code",
  "debate.out_of_turn": "error code",
  "file.kind_mismatch": "error code",
  "identity.exists": "error code",
  "identity.unknown_channel": "error code",
  "issues.activityText.created": "translation key in the web app",
  "mail.composio_unavailable": "server log line",
  "mail.send_failed": "server log line",
  "notification.unknown_channel": "error code",
  "notifications.kind.mentionIn": "translation key in the web app",
  "notify.deliver": "background job name (sending push and email notices)",
  "notify.deliver_failed": "server log line",
  "routine.agent_not_in_channel": "error code",
  "routines.run.channel_gone": "server log line",
  "search.reindex_failed": "server log line",
  "server.started": "server log line",
  "thread.already_moved": "error code",
  "thread.not_moved": "error code",
} as const;

export const isBrowserEvent = (name: string): name is BrowserEventName => Object.hasOwn(BROWSER_EVENTS, name);
