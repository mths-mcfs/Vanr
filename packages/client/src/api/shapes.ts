// Answers whose shape @vanr/contract doesn't declare yet: pages, counts and small results that only one
// route returns. Their types come from these schemas (Infer), so the type and the check can't drift.
import * as C from "../contract-schemas.ts";
import type { Infer } from "../schema.ts";
import * as s from "../schema.ts";

export const Health = s.object({
  status: s.literal("ok"),
  version: s.string,
  edition: s.string,
  database: s.literal("ok", "error"),
  modules: s.array(s.string),
});
export type Health = Infer<typeof Health>;

export const AuthConfig = s.object({
  socialProviders: s.object({ google: s.boolean, github: s.boolean, apple: s.boolean }),
  signupOpen: s.boolean,
  firstRun: s.boolean,
});
export type AuthConfig = Infer<typeof AuthConfig>;

export const AgentSkill = s.object({
  id: s.string,
  autoGrantNewAgents: s.boolean,
  createdBy: s.nullable(s.string),
  description: s.string,
  name: s.string,
  problems: s.array(s.string),
  slug: s.string,
  source: s.literal("builtin", "custom", "github"),
  sourceRunId: s.nullable(s.string),
  sourceUrl: s.nullable(s.string),
  enabled: s.boolean,
});
export type AgentSkill = Infer<typeof AgentSkill>;

export const AgentUsage = s.object({ agentId: s.string, costUsd: s.number });
export type AgentUsage = Infer<typeof AgentUsage>;

export const ApprovalStats = s.object({
  since: s.string,
  byEffect: s.array(
    s.object({
      effect: C.EffectClass,
      calls: s.number,
      auto: s.number,
      asked: s.number,
      denied: s.number,
      approved: s.number,
      edited: s.number,
      rejected: s.number,
      expired: s.number,
      p50Ms: s.nullable(s.number),
      p90Ms: s.nullable(s.number),
    }),
  ),
});
export type ApprovalStats = Infer<typeof ApprovalStats>;

export const UndoAllResult = s.object({
  actions: s.array(C.AgentAction),
  failed: s.array(s.object({ actionId: s.string, code: s.string })),
});
export type UndoAllResult = Infer<typeof UndoAllResult>;

export const FileVersion = s.object({
  version: s.number,
  note: s.nullable(s.string),
  author: C.ActorRef,
  createdAt: s.string,
});
export type FileVersion = Infer<typeof FileVersion>;

export const FileLink = s.object({ url: s.string, expiresAt: s.string });
export type FileLink = Infer<typeof FileLink>;

export const ThreadFollow = s.object({ threadId: s.string, following: s.boolean });
export type ThreadFollow = Infer<typeof ThreadFollow>;

export const ThreadPage = s.object({ threads: s.array(C.ThreadInfo), nextCursor: s.nullable(s.string) });
export type ThreadPage = Infer<typeof ThreadPage>;

export const NotificationPage = s.object({
  items: s.array(C.AppNotification),
  nextCursor: s.nullable(s.string),
  counts: C.NotificationCounts,
});
export type NotificationPage = Infer<typeof NotificationPage>;

export const WikiGraph = s.object({
  nodes: s.array(s.object({ slug: s.string, title: s.string, folder: s.string })),
  edges: s.array(s.object({ from: s.string, to: s.string })),
});
export type WikiGraph = Infer<typeof WikiGraph>;

export const WikiImportResult = s.object({
  created: s.number,
  skipped: s.number,
  failed: s.array(s.object({ path: s.string, error: s.string })),
});
export type WikiImportResult = Infer<typeof WikiImportResult>;

export const WikiPropSchema = s.object({ defs: s.array(C.WikiPropDef), version: s.number });
export type WikiPropSchema = Infer<typeof WikiPropSchema>;

export const WikiPageVersionBody = s.object({ version: s.number, body: s.string });
export type WikiPageVersionBody = Infer<typeof WikiPageVersionBody>;

export const DebateBlindReview = s.object({
  a: s.string,
  b: s.string,
  pick: s.nullable(s.literal("a", "b", "tie")),
});
export type DebateBlindReview = Infer<typeof DebateBlindReview>;

export const BaseQueryResult = s.object({
  rows: s.array(C.BaseRow),
  total: s.number,
  nextCursor: s.nullable(s.string),
  groups: s.optional(s.array(s.object({ key: s.nullable(s.string), count: s.number }))),
  /** Title and place of each row that these rows' relations link to. */
  linked: s.optional(s.record(C.BaseLinkedRow)),
});
export type BaseQueryResult = Infer<typeof BaseQueryResult>;

export const BaseRowDetail = s.merge(
  C.BaseRow,
  s.object({ body: s.string, linked: s.optional(s.record(C.BaseLinkedRow)) }),
);
export type BaseRowDetail = Infer<typeof BaseRowDetail>;

export const BaseImportResult = s.object({
  created: s.number,
  skipped: s.number,
  addedProps: s.array(s.string),
  table: C.BaseTable,
});
export type BaseImportResult = Infer<typeof BaseImportResult>;

export const BaseCsvExport = s.object({ fileName: s.string, csv: s.string });
export type BaseCsvExport = Infer<typeof BaseCsvExport>;

export const DesktopRelease = s.object({
  url: s.string,
  version: s.string,
  size: s.number,
  sha256: s.string,
});
export type DesktopRelease = Infer<typeof DesktopRelease>;

export const RunnerOutages = s.object({
  outages: s.array(
    s.object({
      runnerId: s.string,
      name: s.string,
      since: s.string,
      agentIds: s.array(s.string),
      waitingJobs: s.number,
    }),
  ),
  targets: s.array(s.object({ runnerId: s.string, name: s.string, online: s.boolean })),
});
export type RunnerOutages = Infer<typeof RunnerOutages>;

export const AssignmentList = s.object({
  assignments: s.array(C.Assignment),
  counts: s.object({ active: s.number, blockedOnYou: s.number, closed: s.number }),
});
export type AssignmentList = Infer<typeof AssignmentList>;

export const AssignmentEventPage = s.object({
  events: s.array(C.AssignmentEvent),
  seenSeq: s.number,
  lastSeq: s.number,
});
export type AssignmentEventPage = Infer<typeof AssignmentEventPage>;

export const AssignmentFiles = s.object({
  files: s.array(
    s.object({ name: s.string, content: s.string, updatedAt: s.string, writtenAt: s.nullable(s.string) }),
  ),
  editedOnRunner: s.array(s.object({ name: s.string, diff: s.string })),
});
export type AssignmentFiles = Infer<typeof AssignmentFiles>;

export const AssignmentPlan = s.object({
  current: s.nullable(s.object({ version: s.number, items: s.array(C.AssignmentPlanItem) })),
});
export type AssignmentPlan = Infer<typeof AssignmentPlan>;

export const AssignmentPlanVersion = s.object({
  version: s.number,
  author: C.AssignmentActorRef,
  note: s.nullable(s.string),
  items: s.array(
    s.object({
      id: s.string,
      title: s.string,
      criteria: s.string,
      milestone: s.nullable(s.string),
      status: C.PlanItemStatus,
    }),
  ),
  createdAt: s.string,
});
export type AssignmentPlanVersion = Infer<typeof AssignmentPlanVersion>;

export const AssignmentSummary = s.object({
  plan: s.object({ done: s.number, total: s.number, inProgress: s.number, waiting: s.number }),
  running: s.number,
  pendingDecisions: s.number,
  provisionalDecisions: s.number,
  pendingReviews: s.number,
});
export type AssignmentSummary = Infer<typeof AssignmentSummary>;

export const RoutineWebhookSecret = s.object({ url: s.string, secret: s.string });
export type RoutineWebhookSecret = Infer<typeof RoutineWebhookSecret>;

export const Ok = s.object({ ok: s.literal(true) });

export const FileText = s.object({
  version: s.number,
  status: C.ExtractStatus,
  pages: s.array(s.object({ page: s.number, markdown: s.string })),
});
export type FileText = Infer<typeof FileText>;
