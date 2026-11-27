// A run of an agent as runtime/tools sees it, for the tests of the integration tools. The runtime (the model loop
// that builds this context) comes with a later module, so the context is built by hand on the real deps and rows,
// with recorders for what the runtime would do: approvals (decided by the test), receipts and gate decisions.
import { RiskTracker } from "@vanr/engine/effects";
import { newId } from "@vanr/engine/ids";
import type { AgentRow } from "../src/agents";
import type { ChannelRow } from "../src/channels";
import type { AppDeps } from "../src/context";
import {
  type ApprovalOutcome,
  type ApprovalRequest,
  runTool,
  type ToolContext,
  type ToolDef,
} from "../src/runtime/tools";

export interface ToolRun {
  ctx: ToolContext;
  /** The approvals the gate asked for, in order. */
  approvals: ApprovalRequest[];
  /** The gate decisions recorded (telemetry). */
  decisions: { tool: string; kind: string; reason: string | null }[];
  /** Calls a tool of `tools` in this run. */
  run(tools: readonly ToolDef<unknown>[], name: string, input: unknown): ReturnType<typeof runTool>;
}

/**
 * A run of `agent` in `channel`. `decide` answers every approval request (rejected by default); `recordAction`
 * defaults to nothing, so a queued send needs the caller's (the outbox writes the receipt in its transaction).
 */
export function toolRun(
  deps: AppDeps,
  agent: AgentRow,
  channel: ChannelRow,
  over: Partial<ToolContext> & {
    decide?: (req: ApprovalRequest) => ApprovalOutcome["decision"] | Promise<ApprovalOutcome["decision"]>;
  } = {},
): ToolRun {
  const approvals: ApprovalRequest[] = [];
  const decisions: ToolRun["decisions"] = [];
  const { decide = () => "rejected", ...rest } = over;
  const ctx: ToolContext = {
    deps,
    workspaceId: agent.workspaceId,
    agent,
    channel,
    runId: newId("run"),
    threadId: null,
    trigger: null,
    signal: new AbortController().signal,
    risk: new RiskTracker(),
    async delegate() {
      throw new Error("no delegation in these tests");
    },
    async requestApproval(req) {
      approvals.push(req);
      return {
        id: newId("apv"),
        decision: await decide(req),
        reason: null,
        byName: "Ana",
        input: req.input,
        payloadHash: req.payloadHash,
      };
    },
    async settleApproval() {},
    async recordDecision(d) {
      decisions.push({
        tool: d.tool,
        kind: d.decision.kind,
        reason: "reason" in d.decision ? String(d.decision.reason) : null,
      });
    },
    async standingRule() {
      return null;
    },
    async review() {
      return null;
    },
    async ask() {
      return null;
    },
    async recordAction() {},
    async postCard() {
      throw new Error("no cards in these tests");
    },
    toolOutput() {},
    ...rest,
  };
  return { ctx, approvals, decisions, run: (tools, name, input) => runTool(ctx, tools, name, input) };
}
