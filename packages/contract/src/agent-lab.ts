// Agent lab: test cases, evals, drafts and memory consolidation.

import type { AgentRole } from "./agents.ts";
import type { Proposal } from "./approvals.ts";

/** A test prompt and what the answer must contain or avoid. */
export interface AgentTestCase {
  id: string;
  agentId: string;
  createdAt: string;
  input: string;
  /** Snippets the answer must contain (case-insensitive). */
  mustInclude: string[];
  mustNotInclude: string[];
  updatedAt: string;
}

export interface AgentEvalSide {
  /** What failed: `include:snippet`, `exclude:snippet` or `error:code`. */
  failed: string[];
  pass: boolean;
  text: string;
}

export interface AgentEvalCase {
  after: AgentEvalSide;
  before: AgentEvalSide;
  caseId: string;
  input: string;
}

export interface AgentEvalSummary {
  afterPass: number;
  beforePass: number;
  cases: number;
  /** Cases that succeeded before and fail after. */
  regressions: number;
}

/** The cases run with the current instructions (before) and the candidate ones (after). Advisory only. */
export interface AgentEval {
  id: string;
  agentId: string;
  costUsd: number;
  createdAt: string;
  done: number;
  error: string | null;
  finishedAt: string | null;
  proposalId: string | null;
  results: AgentEvalCase[];
  status: "done" | "failed" | "running";
  summary: AgentEvalSummary | null;
  /** Cases in the run and how many have finished (for progress). */
  total: number;
}

/** Agent draft built from a description. Nothing is saved. */
export interface AgentDraft {
  handle: string;
  instructions: string;
  model: string;
  name: string;
  role: AgentRole;
  /** Workspace skills that make sense for the agent. */
  skillIds: string[];
  /** Produced by the test model (no Anthropic key): a fixed draft, not a real model. */
  testModel: boolean;
  /** Why the draft came out this way, in one or two sentences. */
  why: string;
}

/** For an existing agent, the draft becomes an instructions proposal (a diff to accept or reject). */
export interface BuilderResult {
  draft: AgentDraft;
  proposal: Proposal | null;
}
