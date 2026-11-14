import {
  bigint,
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { agents } from "./agents";
import { createdAt, ts, updatedAt } from "./columns";
import { workspaces } from "./workspaces";

const workspace = () =>
  text("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" });

const assignment = () =>
  text("assignment_id")
    .notNull()
    .references(() => assignments.id, { onDelete: "cascade" });

export type PlanItemStatusRow = "todo" | "doing" | "blocked_on_you" | "done" | "dropped";

/**
 * Legacy plan, as jsonb on the assignment itself. Only the boot import reads it (the plan lives in
 * `assignment_plan_items`).
 */
export interface AssignmentPlanRow {
  version: number;
  items: { id: string; title: string; status: PlanItemStatusRow; note?: string }[];
}

/** Who changed it: a person, the assignment's agent, the verifier (clean context) or the engine. */
export interface AssignmentActor {
  type: "person" | "agent" | "verifier" | "system";
  id: string | null;
}

/**
 * Assignment cap: USD for the runtime through the API; job minutes and steps (runs and jobs) for the
 * runner.
 */
export interface AssignmentLimits {
  usd: number | null;
  minutes: number | null;
  steps: number | null;
}

/** Assignment: a goal with its own thread, plan, decisions and submission. */
export const assignments = pgTable(
  "assignments",
  {
    id: text("id").primaryKey(),
    workspaceId: workspace(),
    title: text("title").notNull(),
    goal: text("goal").notNull(),
    status: text("status", { enum: ["proposed", "active", "paused", "wrapping_up", "done", "canceled"] })
      .notNull()
      .default("proposed"),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    channelId: text("channel_id").notNull(),
    /** Id of the root message (the plan card). */
    threadId: text("thread_id").notNull(),
    executor: text("executor", { enum: ["agent", "claude_code", "codex"] })
      .notNull()
      .default("agent"),
    runnerId: text("runner_id"),
    repoDir: text("repo_dir"),
    ownerId: text("owner_id").notNull(),
    commandPolicy: text("command_policy", { enum: ["always", "when_safe", "never"] })
      .notNull()
      .default("when_safe"),
    resumeJobs: boolean("resume_jobs").notNull().default(true),
    /** Executor model; null uses the agent's. */
    model: text("model"),
    /** Legacy (see AssignmentPlanRow). */
    plan: jsonb("plan").$type<AssignmentPlanRow>().notNull().default({ version: 0, items: [] }),
    /** Plan version in `assignment_plan_items` (each edit by a person, the agent or the verifier adds 1). */
    planVersion: integer("plan_version").notNull().default(0),
    /** Durable workflow driving the assignment; a fork changes the id. */
    workflowId: text("workflow_id"),
    limits: jsonb("limits").$type<AssignmentLimits>().notNull().default({ usd: 5, minutes: 480, steps: 30 }),
    /** Cap that paused the assignment (null: not paused by a cap). */
    ceiling: text("ceiling", { enum: ["usd", "minutes", "steps"] }),
    /** Assignment deadline (optional): once passed, the owner is notified. */
    dueAt: ts("due_at"),
    /** The engine waits until this time (the agent asked to come back later, decision deadline). */
    wakeAt: ts("wake_at"),
    /** Why the engine is waiting (working, person, submission, timer, paused, ceiling, stuck...). */
    waitReason: text("wait_reason"),
    /** What the agent reported (becomes notes.md). */
    findings: jsonb("findings").$type<{ text: string; at: string; prUrl?: string }[]>().notNull().default([]),
    outcome: text("outcome", { enum: ["done", "canceled"] }),
    wikiPageId: text("wiki_page_id"),
    createdAt: createdAt(),
    startedAt: ts("started_at"),
    pausedAt: ts("paused_at"),
    closedAt: ts("closed_at"),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("assignments_workspace_idx").on(t.workspaceId),
    index("assignments_thread_idx").on(t.threadId),
    index("assignments_agent_idx").on(t.agentId),
  ],
);

export const assignmentParticipants = pgTable(
  "assignment_participants",
  {
    assignmentId: assignment(),
    userId: text("user_id").notNull(),
    role: text("role", { enum: ["decide", "comment"] }).notNull(),
    addedBy: text("added_by"),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.assignmentId, t.userId] })],
);

export const assignmentJoinRequests = pgTable(
  "assignment_join_requests",
  {
    assignmentId: assignment(),
    userId: text("user_id").notNull(),
    status: text("status", { enum: ["pending", "accepted", "declined"] })
      .notNull()
      .default("pending"),
    role: text("role", { enum: ["decide", "comment"] }),
    createdAt: createdAt(),
    decidedAt: ts("decided_at"),
  },
  (t) => [primaryKey({ columns: [t.assignmentId, t.userId] })],
);

export const assignmentDecisions = pgTable(
  "assignment_decisions",
  {
    id: text("id").primaryKey(),
    assignmentId: assignment(),
    question: text("question").notNull(),
    options: jsonb("options").$type<string[]>().notNull(),
    status: text("status", { enum: ["pending", "provisional", "taken"] }).notNull(),
    chosen: text("chosen"),
    chosenBy: text("chosen_by"),
    chosenAt: ts("chosen_at"),
    blocking: boolean("blocking").notNull().default(true),
    recommendation: text("recommendation"),
    why: text("why"),
    impact: text("impact"),
    opinions: jsonb("opinions")
      .$type<{ userId: string; option: string; at: string }[]>()
      .notNull()
      .default([]),
    messageId: text("message_id"),
    /**
     * Decision deadline: once passed, the assignment goes on with the recommendation (or asks again,
     * without one).
     */
    deadlineAt: ts("deadline_at"),
    createdAt: createdAt(),
  },
  (t) => [index("assignment_decisions_assignment_idx").on(t.assignmentId)],
);

export const assignmentReviews = pgTable(
  "assignment_reviews",
  {
    id: text("id").primaryKey(),
    assignmentId: assignment(),
    title: text("title").notNull(),
    summary: text("summary").notNull(),
    status: text("status", { enum: ["pending", "approved", "changes_requested"] })
      .notNull()
      .default("pending"),
    note: text("note"),
    decidedBy: text("decided_by"),
    decidedAt: ts("decided_at"),
    fileIds: jsonb("file_ids").$type<string[]>().notNull().default([]),
    prUrl: text("pr_url"),
    messageId: text("message_id"),
    createdAt: createdAt(),
  },
  (t) => [index("assignment_reviews_assignment_idx").on(t.assignmentId)],
);

/** Command the executor wants to run that needs a person (assignment autonomy). */
export const assignmentCommands = pgTable(
  "assignment_commands",
  {
    id: text("id").primaryKey(),
    assignmentId: assignment(),
    jobId: text("job_id"),
    runId: text("run_id"),
    command: text("command").notNull(),
    tool: text("tool").notNull(),
    state: text("state", { enum: ["pending", "allowed", "denied", "expired"] })
      .notNull()
      .default("pending"),
    /** Rules written by "always approve" (e.g. `Bash(npm test *)`). */
    rules: jsonb("rules").$type<string[]>().notNull().default([]),
    always: boolean("always").notNull().default(false),
    decidedBy: text("decided_by"),
    messageId: text("message_id"),
    createdAt: createdAt(),
    decidedAt: ts("decided_at"),
  },
  (t) => [index("assignment_commands_assignment_idx").on(t.assignmentId)],
);

export const assignmentCommandRules = pgTable(
  "assignment_command_rules",
  {
    id: text("id").primaryKey(),
    assignmentId: assignment(),
    rule: text("rule").notNull(),
    by: text("by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("assignment_command_rules_assignment_idx").on(t.assignmentId)],
);

export const assignmentSubmissions = pgTable(
  "assignment_submissions",
  {
    id: text("id").primaryKey(),
    assignmentId: assignment(),
    status: text("status", { enum: ["pending", "accepted", "changes_requested", "superseded"] })
      .notNull()
      .default("pending"),
    auto: boolean("auto").notNull().default(false),
    note: text("note").notNull(),
    fileIds: jsonb("file_ids").$type<string[]>().notNull().default([]),
    checklist: jsonb("checklist")
      .$type<{ id: string; text: string; checkedBy: string | null }[]>()
      .notNull()
      .default([]),
    messageId: text("message_id"),
    decidedBy: text("decided_by"),
    decidedAt: ts("decided_at"),
    changesNote: text("changes_note"),
    createdAt: createdAt(),
  },
  (t) => [index("assignment_submissions_assignment_idx").on(t.assignmentId)],
);

/** Autonomy counters (commands allowed automatically, asked, blocked). */
export const assignmentCommandStats = pgTable("assignment_command_stats", {
  assignmentId: text("assignment_id")
    .primaryKey()
    .references(() => assignments.id, { onDelete: "cascade" }),
  auto: integer("auto").notNull().default(0),
  asked: integer("asked").notNull().default(0),
  blocked: integer("blocked").notNull().default(0),
});

/**
 * Plan item (deliverable): the engine reads one at a time, inside a step. Only the verifier writes
 * `passes`; the executor marks `done` and leaves the summary and the proofs.
 */
export const assignmentPlanItems = pgTable(
  "assignment_plan_items",
  {
    assignmentId: assignment(),
    id: text("id").notNull(),
    ord: integer("ord").notNull(),
    title: text("title").notNull(),
    /** Definition of done (what the verifier checks). */
    criteria: text("criteria").notNull().default(""),
    /**
     * Milestone: items of the same milestone are validated together at its end. Without one, the item is
     * its own milestone.
     */
    milestone: text("milestone"),
    kind: text("kind", { enum: ["work", "fix", "change"] })
      .notNull()
      .default("work"),
    /** Fix item: which item it fixes. */
    fixes: text("fixes"),
    status: text("status", { enum: ["todo", "doing", "blocked_on_you", "done", "dropped"] })
      .notNull()
      .default("todo"),
    /** null: not verified; true/false: the verifier's verdict. */
    passes: boolean("passes"),
    verdict: text("verdict"),
    verifiedAt: ts("verified_at"),
    /** Verdicts already given to this item (validation rounds). */
    checks: integer("checks").notNull().default(0),
    /** What the executor says it did. */
    summary: text("summary"),
    /** Times the engine sent work on this item since a person's last action. */
    turns: integer("turns").notNull().default(0),
    /**
     * How many times the loop counters (`turns`, `checks`) were reset. Part of the engine's keys (fix,
     * verdict, stuck): after "try again", round 1 is a different round 1.
     */
    epoch: integer("epoch").notNull().default(0),
    createdBy: jsonb("created_by").$type<AssignmentActor>().notNull(),
    updatedBy: jsonb("updated_by").$type<AssignmentActor>().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    doneAt: ts("done_at"),
  },
  (t) => [
    primaryKey({ columns: [t.assignmentId, t.id] }),
    index("assignment_plan_items_ord_idx").on(t.assignmentId, t.ord),
  ],
);

/** Each plan version: who changed it, what they said and a snapshot of the items. */
export const assignmentPlanVersions = pgTable(
  "assignment_plan_versions",
  {
    assignmentId: assignment(),
    version: integer("version").notNull(),
    author: jsonb("author").$type<AssignmentActor>().notNull(),
    note: text("note"),
    items: jsonb("items")
      .$type<
        { id: string; title: string; criteria: string; milestone: string | null; status: PlanItemStatusRow }[]
      >()
      .notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.assignmentId, t.version] })],
);

/**
 * Work the engine dispatched, keyed by (assignment, item, attempt). A durable workflow step runs at least
 * once: when repeated, it finds the row and does not dispatch again; the job carries an id derived from the
 * key and the runner rejects the repeat.
 */
export const assignmentWork = pgTable(
  "assignment_work",
  {
    id: text("id").primaryKey(),
    assignmentId: assignment(),
    /** "" on the planning turn. */
    itemId: text("item_id").notNull(),
    n: integer("n").notNull(),
    kind: text("kind", { enum: ["plan", "run", "task"] }).notNull(),
    /** The run (agent in the conversation) or the job (runner). */
    refId: text("ref_id"),
    status: text("status", { enum: ["starting", "running", "ended"] })
      .notNull()
      .default("starting"),
    outcome: text("outcome", { enum: ["done", "failed", "canceled", "interrupted"] }),
    startedAt: createdAt(),
    endedAt: ts("ended_at"),
  },
  (t) => [
    uniqueIndex("assignment_work_key_uq").on(t.assignmentId, t.itemId, t.n),
    index("assignment_work_ref_idx").on(t.refId),
  ],
);

/** Append-only assignment trail: the UI draws the timeline from here. Not engine state. */
export const assignmentEvents = pgTable(
  "assignment_events",
  {
    seq: bigserial("seq", { mode: "number" }).primaryKey(),
    assignmentId: assignment(),
    /** A step that runs again does not duplicate the event. */
    key: text("key"),
    kind: text("kind").notNull(),
    actor: jsonb("actor").$type<AssignmentActor>().notNull(),
    itemId: text("item_id"),
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
    at: createdAt(),
  },
  (t) => [
    uniqueIndex("assignment_events_key_uq").on(t.key),
    index("assignment_events_assignment_idx").on(t.assignmentId, t.seq),
  ],
);

/** Proof in the submission: diff, test log, screenshot (a file), preview (link) and changed files. */
export const assignmentProofs = pgTable(
  "assignment_proofs",
  {
    id: text("id").primaryKey(),
    assignmentId: assignment(),
    itemId: text("item_id"),
    jobId: text("job_id"),
    kind: text("kind", { enum: ["diff", "test_log", "screenshot", "preview", "files"] }).notNull(),
    title: text("title").notNull(),
    body: text("body"),
    fileId: text("file_id"),
    url: text("url"),
    by: jsonb("by").$type<AssignmentActor>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("assignment_proofs_assignment_idx").on(t.assignmentId)],
);

/** How far each person has seen the trail ("what changed since you looked"). */
export const assignmentSeen = pgTable(
  "assignment_seen",
  {
    assignmentId: assignment(),
    userId: text("user_id").notNull(),
    seq: bigint("seq", { mode: "number" }).notNull(),
    at: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.assignmentId, t.userId] })],
);
