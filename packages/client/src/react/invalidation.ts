// What each realtime event makes stale, as a table: event -> the cache keys to refetch. An event that
// changes nothing cached says why instead. A test walks the server's event table and fails if an event
// is in neither place.
import type { QueryClient } from "@tanstack/react-query";
import type { MethodName } from "../api/index.ts";
import type { BrowserEventName, EventPayload } from "../realtime/events.ts";
import type { AnyRealtimeEvent, EventScope } from "../realtime/socket.ts";
import { type KeyPrefix, prefixKey } from "./keys.ts";

export interface InvalidationContext {
  workspaceId: string;
  scope: EventScope;
}

export type InvalidationRule<E extends BrowserEventName> =
  | { keys: (payload: EventPayload<E>, ctx: InvalidationContext) => KeyPrefix[] }
  | { none: string };

/** A prefix inside the event's workspace; undefined values are dropped (they would match nothing). */
const ws =
  (ctx: InvalidationContext) =>
  (method: MethodName, extra: Record<string, string | null | undefined> = {}): KeyPrefix => {
    const args: Record<string, unknown> = { workspaceId: ctx.workspaceId };
    for (const [k, v] of Object.entries(extra)) if (typeof v === "string") args[k] = v;
    return { method, args };
  };

const channelOf = (ctx: InvalidationContext) =>
  ctx.scope.kind === "channel" ? ctx.scope.channelId : undefined;

const messagesIn = (ctx: InvalidationContext): KeyPrefix[] => {
  const channelId = channelOf(ctx);
  return channelId ? [ws(ctx)("listChannelMessages", { channelId })] : [ws(ctx)("listChannelMessages")];
};

const runEnded = (p: { agentId: string; runId?: string | undefined }, ctx: InvalidationContext) => {
  const k = ws(ctx);
  return [
    k("listActiveRuns"),
    k("listChannelActiveRuns"),
    k("listRuns"),
    k("getRun", { runId: p.runId }),
    k("getAgentInbox", { agentId: p.agentId }),
    k("getUsage"),
  ];
};

const STREAMED = "streamed run output: rendered as it arrives; nothing cached changes until the run ends";
const PRESENCE = "presence: shown live and gone after ttlMs";
const LIVE_VIEW = "live view: frames and status are drawn as they arrive and never cached";

export const INVALIDATION: { [E in BrowserEventName]: InvalidationRule<E> } = {
  "run.status_changed": {
    keys: (p, ctx) => [
      ws(ctx)("listActiveRuns"),
      ws(ctx)("listChannelActiveRuns", { channelId: p.channelId ?? channelOf(ctx) }),
      ws(ctx)("getAgentInbox", { agentId: p.agentId }),
    ],
  },
  "run.text_delta": { none: STREAMED },
  "run.thinking": { none: STREAMED },
  "run.commentary": { none: STREAMED },
  "run.tool_call": { none: STREAMED },
  "run.tool_result": { none: STREAMED },
  "run.steered": { keys: (_p, ctx) => [ws(ctx)("listChannelActiveRuns", { channelId: channelOf(ctx) })] },
  "run.idle": { keys: (_p, ctx) => [ws(ctx)("listActiveRuns")] },
  "run.stopped": { keys: runEnded },
  "run.completed": { keys: runEnded },
  "run.agent_unavailable": { none: "a notice for the person; the agent and its runs are unchanged" },
  "agent.typing": { none: PRESENCE },
  "person.typing": { none: PRESENCE },
  "delegation.started": { keys: (_p, ctx) => [ws(ctx)("getTeam")] },
  "delegation.completed": { keys: (_p, ctx) => [ws(ctx)("getTeam")] },
  "budget.threshold_reached": {
    keys: (p, ctx) => [ws(ctx)("getAgent", { agentId: p.agentId }), ws(ctx)("getUsage")],
  },
  "budget.cap_reached": {
    keys: (p, ctx) => [
      ws(ctx)("getAgent", { agentId: p.agentId }),
      ws(ctx)("listAgents"),
      ws(ctx)("getUsage"),
    ],
  },
  "memory.recorded": {
    keys: (p, ctx) => [
      ws(ctx)("listAgentMemories", { agentId: p.agentId }),
      ws(ctx)("getMemoryMine"),
      ws(ctx)("getMemoryWorkspace"),
    ],
  },

  "message.posted": {
    keys: (p, ctx) => [
      ws(ctx)("listChannelMessages", { channelId: p.message.channelId }),
      ws(ctx)("listChannels"),
      ws(ctx)("getDms"),
      ...(p.message.threadId
        ? [ws(ctx)("getThread", { threadId: p.message.threadId }), ws(ctx)("listThreads")]
        : []),
    ],
  },
  "message.reactions_updated": {
    keys: (p, ctx) => [ws(ctx)("listMessageReactions", { messageId: p.messageId }), ...messagesIn(ctx)],
  },
  "message.routed": { keys: (_p, ctx) => messagesIn(ctx) },
  "message.claimed": { keys: (_p, ctx) => messagesIn(ctx) },
  "message.handled": { keys: (_p, ctx) => messagesIn(ctx) },
  "message.memories_updated": { keys: (_p, ctx) => messagesIn(ctx) },
  "message.actions_updated": { keys: (_p, ctx) => messagesIn(ctx) },
  "thread.info_changed": {
    keys: (p, ctx) => [
      ws(ctx)("getThread", { threadId: p.threadId }),
      ws(ctx)("listThreads"),
      ws(ctx)("listChannelThreads", { channelId: p.channelId ?? channelOf(ctx) }),
    ],
  },
  "channel.unread": { keys: (_p, ctx) => [ws(ctx)("listChannels"), ws(ctx)("getDms")] },
  "channel.budget": { keys: (_p, ctx) => [ws(ctx)("listChannels")] },

  "approval.requested": {
    keys: (p, ctx) => [ws(ctx)("listApprovals"), ws(ctx)("getAgentInbox", { agentId: p.agentId })],
  },
  "approval.resolved": {
    keys: (p, ctx) => [
      ws(ctx)("listApprovals"),
      ws(ctx)("getApproval", { approvalId: p.approvalId }),
      ws(ctx)("getAgentInbox", { agentId: p.agentId }),
      ws(ctx)("listApprovalStats"),
    ],
  },
  "proposal.created": { keys: (_p, ctx) => [ws(ctx)("listProposals"), ws(ctx)("getAgentInbox")] },
  "proposal.decided": { keys: (_p, ctx) => [ws(ctx)("listProposals"), ws(ctx)("getAgentInbox")] },
  "question.raised": { keys: (_p, ctx) => messagesIn(ctx) },
  "question.closed": { keys: (_p, ctx) => messagesIn(ctx) },
  "secret_request.created": {
    keys: (p, ctx) => [ws(ctx)("listAgentSecrets", { agentId: p.agentId }), ...messagesIn(ctx)],
  },
  "secret_request.updated": {
    keys: (p, ctx) => [ws(ctx)("listAgentSecrets", { agentId: p.agentId }), ...messagesIn(ctx)],
  },
  "browser_intervention.updated": {
    keys: (p, ctx) => [
      ws(ctx)("getBrowserIntervention", { interventionId: p.intervention.id }),
      ws(ctx)("listAgentBrowserInterventions"),
    ],
  },
  "network.changed": {
    keys: (p, ctx) => [
      ws(ctx)("listAgentEnvironmentDomains", { agentId: p.agentId }),
      ws(ctx)("getAgentEnvironment", { agentId: p.agentId }),
    ],
  },
  "network.requested": {
    keys: (p, ctx) => [ws(ctx)("listAgentEnvironmentDomains", { agentId: p.agentId }), ...messagesIn(ctx)],
  },
  "network.updated": {
    keys: (p, ctx) => [ws(ctx)("listAgentEnvironmentDomains", { agentId: p.agentId }), ...messagesIn(ctx)],
  },
  "connector.scope": { keys: (_p, ctx) => [ws(ctx)("listConnectors"), ...messagesIn(ctx)] },

  "live_view.frame": { none: LIVE_VIEW },
  "live_view.status": { none: LIVE_VIEW },
  "live_view.ended": { none: LIVE_VIEW },
  "live_view.unavailable": { none: LIVE_VIEW },

  "runner.paired": { keys: (_p, ctx) => [ws(ctx)("listRunners"), ws(ctx)("listRunnerOutages")] },
  "runner.updated": { keys: (_p, ctx) => [ws(ctx)("listRunners")] },
  "runner.deleted": { keys: (_p, ctx) => [ws(ctx)("listRunners"), ws(ctx)("listRunnerOutages")] },
  "runner.revoked": { keys: (_p, ctx) => [ws(ctx)("listRunners"), ws(ctx)("listRunnerOutages")] },
  "runner.presence_changed": { keys: (_p, ctx) => [ws(ctx)("listRunners"), ws(ctx)("listRunnerOutages")] },
  "runner.pause_changed": { keys: (_p, ctx) => [ws(ctx)("listRunners")] },
  "runner.sandbox_changed": { keys: (_p, ctx) => [ws(ctx)("listRunners")] },
  "runner.access": { keys: (_p, ctx) => [ws(ctx)("listRunners")] },
  "runner.agents_moved": {
    keys: (_p, ctx) => [ws(ctx)("listRunners"), ws(ctx)("listAgents"), ws(ctx)("listRunnerOutages")],
  },
  "job.updated": {
    keys: (p, ctx) => [ws(ctx)("listThreadJobs"), ws(ctx)("getJobOutput", { jobId: p.job.id })],
  },
  "environment.updated": { keys: (p, ctx) => [ws(ctx)("getAgentEnvironment", { agentId: p.agentId })] },

  "assignment.updated": {
    keys: (p, ctx) => {
      const k = ws(ctx);
      const a = { assignmentId: p.assignmentId };
      return [
        k("listAssignments"),
        k("getAssignment", a),
        k("getAssignmentSummary", a),
        k("getAssignmentPlan", a),
        k("listAssignmentDecisions", a),
        k("listAssignmentSubmissions", a),
        k("listAssignmentReviews", a),
        k("listAssignmentCommands", a),
        k("getThreadAssignment", { threadId: p.threadId }),
      ];
    },
  },
  "assignment.trail_event": {
    keys: (p, ctx) => [ws(ctx)("listAssignmentEvents", { assignmentId: p.assignmentId })],
  },
  "debate.updated": {
    keys: (p, ctx) => [ws(ctx)("listDebates"), ws(ctx)("getDebate", { debateId: p.debateId })],
  },
  "debate.post_created": { keys: (p, ctx) => [ws(ctx)("getDebate", { debateId: p.debateId })] },
  "debate.turn_requested": { keys: (p, ctx) => [ws(ctx)("getDebate", { debateId: p.debateId })] },
  "debate.requested": { keys: (_p, ctx) => [ws(ctx)("listDebates")] },
  "debate.concluded": {
    keys: (p, ctx) => [
      ws(ctx)("listDebates"),
      ws(ctx)("getDebate", { debateId: p.debateId }),
      ws(ctx)("listDebateMetrics"),
    ],
  },
  "debate.suggestion_updated": { keys: (_p, ctx) => messagesIn(ctx) },
  "issue.created": { keys: (_p, ctx) => [ws(ctx)("listIssues")] },
  "issue_column.list_updated": { keys: (_p, ctx) => [ws(ctx)("listIssueColumns")] },
  "calendar_event.saved": { keys: (_p, ctx) => [ws(ctx)("getCalendar")] },
  "calendar_event.removed": { keys: (_p, ctx) => [ws(ctx)("getCalendar")] },
  "routine.event": {
    keys: (p, ctx) => [ws(ctx)("listRoutines"), ws(ctx)("listRoutineRuns", { routineId: p.routineId })],
  },
  "notification.shown": { keys: (_p, ctx) => [ws(ctx)("listNotifications")] },
  "notification.hidden": { keys: (_p, ctx) => [ws(ctx)("listNotifications")] },
  "notification.counts_updated": { keys: (_p, ctx) => [ws(ctx)("listNotificationCounts")] },

  "file.created": { keys: (_p, ctx) => [ws(ctx)("listFiles")] },
  "file.updated": {
    keys: (p, ctx) => [
      ws(ctx)("listFiles"),
      ws(ctx)("getFile", { fileId: p.fileId }),
      ws(ctx)("listFileVersions", { fileId: p.fileId }),
    ],
  },
  "file.deleted": {
    keys: (p, ctx) => [
      ws(ctx)("listFiles"),
      ws(ctx)("getFileTrash"),
      ws(ctx)("getFile", { fileId: p.fileId }),
    ],
  },
  "base.created": { keys: (_p, ctx) => [ws(ctx)("listBases")] },
  "base.updated": { keys: (p, ctx) => [ws(ctx)("listBases"), ws(ctx)("getBase", { baseId: p.baseId })] },
  "base.deleted": { keys: (p, ctx) => [ws(ctx)("listBases"), ws(ctx)("getBase", { baseId: p.baseId })] },
  "base.rows": {
    keys: (p, ctx) => [
      ws(ctx)("createBaseTableQuery", { baseId: p.baseId, tableId: p.tableId }),
      ws(ctx)("getBaseRow", { baseId: p.baseId }),
    ],
  },
  "base.recalc": {
    keys: (p, ctx) => [
      ws(ctx)("getBase", { baseId: p.baseId }),
      ws(ctx)("createBaseTableQuery", { baseId: p.baseId }),
    ],
  },
};

/** The prefixes an event makes stale (empty for the ones that change nothing cached). */
export function keysForEvent(event: AnyRealtimeEvent, workspaceId: string): KeyPrefix[] {
  const rule = INVALIDATION[event.type] as InvalidationRule<typeof event.type>;
  if ("none" in rule) return [];
  // `event` pairs its type with its payload; the table is indexed the same way.
  return (rule.keys as (p: unknown, ctx: InvalidationContext) => KeyPrefix[])(event.payload, {
    workspaceId,
    scope: event.scope,
  });
}

export async function invalidateForEvent(qc: QueryClient, event: AnyRealtimeEvent, workspaceId: string) {
  await Promise.all(
    keysForEvent(event, workspaceId).map((p) => qc.invalidateQueries({ queryKey: prefixKey(p) })),
  );
}
