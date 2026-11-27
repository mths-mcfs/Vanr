// Issues, board columns and activity.

import type { ActorRef } from "./common.ts";

export type IssueStage = "canceled" | "done" | "in_progress" | "reviewing" | "todo";

export type IssuePriority = "high" | "low" | "medium" | "none" | "urgent";

export interface IssueCriterion {
  id: string;
  done: boolean;
  text: string;
}

export interface Issue {
  id: string;
  assignee: ActorRef | null;
  boardPosition: number;
  channelId: string | null;
  columnId: string;
  createdAt: string;
  createdBy: ActorRef;
  criteria: IssueCriterion[];
  debates: { id: string; title: string }[];
  description: string;
  dueDate: string | null;
  files: string[];
  labels: string[];
  number: number;
  priority: IssuePriority;
  pullRequests: string[];
  source: { id?: string; kind: "agent" | "debate" | "manual" | "message" } | null;
  status: IssueStage;
  subIssues: { id: string; number: number; status: IssueStage; title: string }[];
  title: string;
  updatedAt: string;
  work: { reason: string | null; runId: string | null; state: "blocked" | "idle" | "working" } | null;
}

export interface IssueColumn {
  id: string;
  name: string;
  position: number;
  stage: IssueStage;
}

export interface IssueActivity {
  id: string;
  attachments: string[];
  author: ActorRef;
  auto: boolean;
  createdAt: string;
  event: string | null;
  kind: "comment" | "event";
  text: string;
  textKey: string | null;
  textVars: Record<string, string | number> | null;
}

/** Body of `createIssue`. */
export interface IssueInput {
  assignee?: ActorRef | null;
  channelId?: string;
  columnId?: string;
  criteria?: string[];
  description?: string;
  dueDate?: string | null;
  labels?: string[];
  priority?: IssuePriority;
  title: string;
}

/** Body of `updateIssue`. */
export interface IssuePatch {
  assignee?: ActorRef | null;
  boardPosition?: number;
  columnId?: string;
  description?: string;
  dueDate?: string | null;
  labels?: string[];
  priority?: IssuePriority;
  title?: string;
}

/** Body of `createIssueComment`. */
export interface IssueCommentInput {
  attachedFileIds?: string[];
  text: string;
}

/** Body of `createIssueColumn`. */
export interface IssueColumnInput {
  afterId?: string;
  name: string;
  stage: IssueStage;
}

/** Body of `updateIssueColumn`. */
export interface IssueColumnPatch {
  index?: number;
  name?: string;
}
