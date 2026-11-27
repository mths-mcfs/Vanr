import { describe, expect, test } from "bun:test";
import type { CredentialRef } from "@vanr/engine/action-credential";
import { payloadHash, RiskTracker } from "@vanr/engine/effects";
import { z } from "zod";
import { BROWSER_TOOLS } from "../runners/agent-tools";
import {
  type ApprovalOutcome,
  type ApprovalRequest,
  type DecisionBy,
  define,
  type ReviewRequest,
  runTool,
  type ToolContext,
  type ToolDef,
} from "./tools";

// runTool with the gate (seam 1), without a database: the context is fake and records what the runtime would do.
// `rules`: remembered rules by `tool|key`; `review`: the model reviewer's verdict.
// The origin's MCP connector class cases wait for `integrations/tools`: they come with the module that defines
// those tools.
function fakeCtx(
  decide: (req: ApprovalRequest) => Promise<ApprovalOutcome> | ApprovalOutcome,
  opts: { rules?: Record<string, string>; review?: (req: ReviewRequest) => "allow" | "ask" | null } = {},
) {
  const asked: ApprovalRequest[] = [];
  const settled: { id: string; ok: boolean; text: string }[] = [];
  const decisions: {
    tool: string;
    kind: string;
    reason: string | null;
    by?: DecisionBy;
    credential?: CredentialRef;
  }[] = [];
  const lookups: string[] = [];
  const reviews: ReviewRequest[] = [];
  const ctx = {
    risk: new RiskTracker(),
    async requestApproval(req: ApprovalRequest) {
      asked.push(req);
      return decide(req);
    },
    async settleApproval(id: string, r: { ok: boolean; text: string }) {
      settled.push({ id, ...r });
    },
    async recordDecision(d: {
      tool: string;
      decision: { kind: string; reason?: string };
      by?: DecisionBy;
      credential?: CredentialRef | null;
    }) {
      decisions.push({
        tool: d.tool,
        kind: d.decision.kind,
        reason: d.decision.reason ?? null,
        ...(d.by ? { by: d.by } : {}),
        ...(d.credential ? { credential: d.credential } : {}),
      });
    },
    async standingRule(tool: string, key: string) {
      lookups.push(`${tool}|${key}`);
      const id = opts.rules?.[`${tool}|${key}`];
      return id ? { id } : null;
    },
    async review(req: ReviewRequest) {
      reviews.push(req);
      return opts.review?.(req) ?? null;
    },
  } as unknown as ToolContext;
  return { ctx, asked, settled, decisions, lookups, reviews };
}

/** A tool that sends to a destination resolved at call time (like post_message's channel). */
function sender() {
  const state = { target: "ana@ws.test", ran: [] as unknown[] };
  const tool = define({
    name: "send_note",
    description: "",
    effect: "K2",
    input: z.object({ text: z.string().min(1) }),
    async plan(_ctx, input) {
      return {
        destination: { kind: "external", allowed: true, target: state.target },
        policy: "ask",
        payload: { to: state.target, text: input.text },
        preview: { title: "Send", body: input.text, recipients: [state.target] },
        editable: ["text"],
        rule: { key: `to:${state.target}`, label: `send to ${state.target}` },
      };
    },
    async run(_ctx, input) {
      state.ran.push({ to: state.target, ...input });
      return "sent";
    },
  });
  return { state, tool: tool as ToolDef<unknown> };
}

const approved = (req: ApprovalRequest, extra: Partial<ApprovalOutcome> = {}): ApprovalOutcome => ({
  id: "apv1",
  decision: "approved",
  reason: null,
  byName: "Ana",
  payloadHash: req.payloadHash,
  ...extra,
});

describe("runTool: runs only the approved effect", () => {
  test("approved with the preview's hash: runs once and records the result", async () => {
    const { state, tool } = sender();
    const { ctx, asked, settled } = fakeCtx((req) => approved(req));
    const out = await runTool(ctx, [tool], "send_note", { text: "hi" });
    expect(out).toEqual({ content: "sent", isError: false });
    expect(asked[0]?.payloadHash).toBe(payloadHash("send_note", { to: "ana@ws.test", text: "hi" }));
    expect(state.ran).toEqual([{ to: "ana@ws.test", text: "hi" }]);
    expect(settled).toEqual([{ id: "apv1", ok: true, text: "sent" }]);
  });

  test("the resolved destination changed between the preview and the run: it doesn't run", async () => {
    const { state, tool } = sender();
    const { ctx, settled } = fakeCtx((req) => {
      state.target = "x@attacker.test";
      return approved(req);
    });
    const out = await runTool(ctx, [tool], "send_note", { text: "hi" });
    expect(out.isError).toBe(true);
    expect(out.content).toContain("no longer what was approved");
    expect(state.ran).toEqual([]);
    expect(settled[0]).toMatchObject({ ok: false });
  });

  test("an approval covers the class and scope it was granted for: the same payload planned as K3 doesn't run", async () => {
    // A move the person approved as K1 that, by the time the approval arrives, plans as a delete (K3).
    const state = { effect: "K1" as "K1" | "K3", ran: 0 };
    const tool = define({
      name: "move_note",
      description: "",
      effect: "K1",
      input: z.object({ to: z.string() }),
      async plan() {
        return state.effect === "K1"
          ? { policy: "ask" as const }
          : { effect: "K3" as const, policy: "ask" as const, card: { scope: "notes:delete" } };
      },
      async run() {
        state.ran++;
        return "moved";
      },
    }) as ToolDef<unknown>;
    const { ctx, asked, settled } = fakeCtx((req) => {
      state.effect = "K3";
      return approved(req);
    });
    const out = await runTool(ctx, [tool], "move_note", { to: "bin" });
    // The same input gives the same hash under both classes: only the class tells them apart.
    expect(asked.map((a) => a.effect)).toEqual(["K1"]);
    expect(out.isError).toBe(true);
    expect(out.content).toContain("no longer what was approved");
    expect(state.ran).toBe(0);
    expect(settled[0]).toMatchObject({ ok: false });
  });

  test("an approval covers the scope it was granted for: the same class under another scope doesn't run", async () => {
    const state = { scope: "notes:archive", ran: 0 };
    const tool = define({
      name: "file_note",
      description: "",
      effect: "K2",
      input: z.object({ id: z.string() }),
      async plan() {
        return { policy: "ask" as const, card: { scope: state.scope } };
      },
      async run() {
        state.ran++;
        return "filed";
      },
    }) as ToolDef<unknown>;
    const { ctx } = fakeCtx((req) => {
      state.scope = "notes:delete";
      return approved(req);
    });
    const out = await runTool(ctx, [tool], "file_note", { id: "n1" });
    expect([out.isError, state.ran]).toEqual([true, 0]);
    // Unchanged, it runs.
    const again = fakeCtx((req) => approved(req));
    expect((await runTool(again.ctx, [tool], "file_note", { id: "n1" })).content).toBe("filed");
  });

  test("an approval of another payload (an old hash) doesn't serve this one", async () => {
    const { state, tool } = sender();
    const other = payloadHash("send_note", { to: "ana@ws.test", text: "other text" });
    const { ctx } = fakeCtx((req) => approved(req, { payloadHash: other }));
    const out = await runTool(ctx, [tool], "send_note", { text: "hi" });
    expect(out.isError).toBe(true);
    expect(state.ran).toEqual([]);
  });

  test("edited by the person: runs the edited input with the new hash; a field outside the list is rejected", async () => {
    const { state, tool } = sender();
    const { ctx } = fakeCtx(async (req) => {
      expect(await req.revise({ to: "x@outside.test" })).toEqual({ error: "The field to can't be edited" });
      expect(await req.revise({ text: "" })).toMatchObject({ error: expect.any(String) });
      const next = await req.revise({ text: "hi, how are you?" });
      if ("error" in next) throw new Error(next.error);
      return approved(req, { input: next.input, payloadHash: next.payloadHash, edited: true });
    });
    const out = await runTool(ctx, [tool], "send_note", { text: "hi" });
    expect(out.isError).toBe(false);
    expect(state.ran).toEqual([{ to: "ana@ws.test", text: "hi, how are you?" }]);
  });

  test("rejected: the reason goes back to the model and nothing runs", async () => {
    const { state, tool } = sender();
    const { ctx } = fakeCtx(() => ({ id: "apv1", decision: "rejected", reason: "not now", byName: "Ana" }));
    const out = await runTool(ctx, [tool], "send_note", { text: "hi" });
    expect(out).toEqual({
      content: "Not approved: Ana rejected it (not now). Do not try again unless asked.",
      isError: true,
    });
    expect(state.ran).toEqual([]);
  });

  test("a denial doesn't ask: a run with A sending to a destination that isn't allowed", async () => {
    const state = { ran: 0 };
    const tool = define({
      name: "mail_out",
      description: "",
      effect: "K2",
      input: z.object({ to: z.string() }),
      async plan(_ctx, input) {
        return { effect: "K3", destination: { kind: "external", allowed: false, target: input.to } };
      },
      async run() {
        state.ran++;
        return "sent";
      },
    });
    const { ctx, asked, decisions } = fakeCtx(() => {
      throw new Error("should not ask");
    });
    ctx.risk.raise({ flag: "A", source: "browser_read https://outside.test" });
    const out = await runTool(ctx, [tool], "mail_out", { to: "x@attacker.test" });
    expect(out.isError).toBe(true);
    expect(out.content).toContain(
      "Blocked: this run read content from outside (browser_read https://outside.test)",
    );
    expect(asked).toEqual([]);
    expect(state.ran).toBe(0);
    expect(decisions).toEqual([{ tool: "mail_out", kind: "deny", reason: "untrusted_to_external" }]);
  });
});

// The rule-of-two cases with the browser tools (read, type a secret, click, open a URL) belong to
// apps/server/test/browser-security.test.ts: their plan asks the runner what the action will reach, so they run
// with the real runner and Chrome.
describe("rule of two", () => {
  test("what the result raises (reads) counts for the next calls, not for this one", async () => {
    const { ctx, asked } = fakeCtx(() => ({ id: "apv1", decision: "rejected", reason: null, byName: "Ana" }));
    const shell = define({
      name: "shell",
      description: "",
      effect: "K2",
      input: z.object({ cmd: z.string() }),
      async plan() {
        return {
          destination: { kind: "external", allowed: true, target: "environment" },
          raises: [{ flag: "B", source: "shell with secrets" }],
          reads: [{ flag: "A", source: "shell output" }],
        };
      },
      async run() {
        return "output from the network";
      },
    }) as ToolDef<unknown>;
    // The first command with a secret (B+C) runs; its output raises A, and the second asks a person.
    expect((await runTool(ctx, [shell], "shell", { cmd: "curl x" })).isError).toBe(false);
    expect(asked).toEqual([]);
    await runTool(ctx, [shell], "shell", { cmd: "curl y" });
    expect(asked[0]).toMatchObject({ tool: "shell", gateReason: "rule_of_two" });
  });
});

describe("request shortcuts: always allow and the reviewer", () => {
  const reject = (): ApprovalOutcome => ({ id: "apv1", decision: "rejected", reason: null, byName: "Ana" });

  test("remembered rule: the same destination runs without asking and the decision goes to the rule", async () => {
    const { state, tool } = sender();
    const { ctx, asked, decisions } = fakeCtx(reject, { rules: { "send_note|to:ana@ws.test": "rule1" } });
    expect(await runTool(ctx, [tool], "send_note", { text: "any text" })).toEqual({
      content: "sent",
      isError: false,
    });
    expect(asked).toEqual([]);
    expect(state.ran).toEqual([{ to: "ana@ws.test", text: "any text" }]);
    expect(decisions).toEqual([
      { tool: "send_note", kind: "ask", reason: "policy", by: { kind: "rule", ruleId: "rule1" } },
    ]);
  });

  test("remembered rule with the agent's own account: the audit keeps the rule and the credential (seam 7)", async () => {
    const { tool } = sender();
    const credential: CredentialRef = {
      kind: "connection",
      id: "con1",
      owner: "agent",
      label: "Lia's Linear",
    };
    const own = {
      ...tool,
      plan: async (c: ToolContext, i: unknown) => ({ ...(await tool.plan?.(c, i)), credential }),
    };
    const { ctx, decisions } = fakeCtx(reject, { rules: { "send_note|to:ana@ws.test": "rule1" } });
    await runTool(ctx, [own], "send_note", { text: "hi" });
    expect(decisions).toEqual([
      { tool: "send_note", kind: "ask", reason: "policy", by: { kind: "rule", ruleId: "rule1" }, credential },
    ]);
  });

  test("attack: the resolved destination is another one, the rule doesn't match and the person decides", async () => {
    const { state, tool } = sender();
    state.target = "beto@ws.test";
    const { ctx, asked, lookups } = fakeCtx(reject, { rules: { "send_note|to:ana@ws.test": "rule1" } });
    await runTool(ctx, [tool], "send_note", { text: "hi" });
    expect(lookups).toEqual(["send_note|to:beto@ws.test"]);
    expect(state.ran).toEqual([]);
    // The request offers to remember the new destination, not the old one.
    expect(asked[0]?.rule).toEqual({ key: "to:beto@ws.test", label: "send to beto@ws.test" });
  });

  test("attack: a run that read outside content (A) neither uses the rule nor offers to remember", async () => {
    const { state, tool } = sender();
    const { ctx, asked, lookups, reviews } = fakeCtx(reject, {
      rules: { "send_note|to:ana@ws.test": "rule1" },
      review: () => "allow",
    });
    ctx.risk.raise({ flag: "A", source: "browser_read https://outside.test" });
    await runTool(ctx, [tool], "send_note", { text: "hi" });
    expect(lookups).toEqual([]);
    expect(reviews).toEqual([]);
    expect(state.ran).toEqual([]);
    expect(asked[0]).toMatchObject({ gateReason: "policy", rule: null, reviewed: false });
  });

  test("attack: K3 consults neither a rule nor the reviewer, and doesn't offer to remember", async () => {
    const ran: unknown[] = [];
    const wire = define({
      name: "wire",
      description: "",
      effect: "K3",
      input: z.object({ amount: z.number() }),
      async plan(_ctx, input) {
        return {
          destination: { kind: "external", allowed: true, target: "bank" },
          policy: "ask",
          preview: { title: `Pay ${input.amount}` },
          rule: { key: "bank", label: "pay the bank" },
        };
      },
      async run(_ctx, input) {
        ran.push(input);
        return "paid";
      },
    }) as ToolDef<unknown>;
    const { ctx, asked, lookups, reviews } = fakeCtx(reject, {
      rules: { "wire|bank": "rule1" },
      review: () => "allow",
    });
    // Even with A+B (the middle ground the reviewer decides in K2), K3 stays with the person.
    ctx.risk.raise({ flag: "B", source: "secret" });
    await runTool(ctx, [wire], "wire", { amount: 10 });
    expect(lookups).toEqual([]);
    expect(reviews).toEqual([]);
    expect(ran).toEqual([]);
    expect(asked[0]).toMatchObject({ effect: "K3", gateReason: "irreversible", rule: null });
  });

  // Rule of two in the browser: it read the page (A), typed the secret (B), wants to click (C, K2).
  // The real plan reads the runner from the database; here the browser's external destination is enough.
  const stubbed = BROWSER_TOOLS.map(
    (t) =>
      ({
        ...t,
        plan: async () => ({ destination: { kind: "external", allowed: true, target: "browser" } }),
        run: async () => "page text",
      }) as ToolDef<unknown>,
  );
  const risky = (ctx: ToolContext) => {
    ctx.risk.raise({ flag: "A", source: "browser_read (web page)" });
    ctx.risk.raise({ flag: "B", source: "browser_type_secret PIN" });
  };

  test("the reviewer approves a risk request in K2: it runs without a person and sees only the effect", async () => {
    const { ctx, asked, decisions, reviews } = fakeCtx(reject, { review: () => "allow" });
    risky(ctx);
    const out = await runTool(ctx, stubbed, "browser_click", { target: "#send" });
    expect(out.isError).toBe(false);
    expect(asked).toEqual([]);
    expect(decisions).toEqual([
      {
        tool: "browser_click",
        kind: "ask",
        reason: "rule_of_two",
        by: { kind: "reviewer", verdict: "allow" },
      },
    ]);
    // Blind to the reasoning: neither the flags with their source (what the agent read) nor the raw input.
    expect(Object.keys(reviews[0] ?? {}).sort()).toEqual(["effect", "preview", "reason", "tool"]);
  });

  test("the reviewer asks for a person: the request goes marked; without a reviewer, the person decides as before", async () => {
    const asks = fakeCtx(reject, { review: () => "ask" });
    risky(asks.ctx);
    await runTool(asks.ctx, stubbed, "browser_click", { target: "#send" });
    expect(asks.asked[0]).toMatchObject({ gateReason: "rule_of_two", reviewed: true, rule: null });
    const off = fakeCtx(reject, { review: () => null });
    risky(off.ctx);
    await runTool(off.ctx, stubbed, "browser_click", { target: "#send" });
    expect(off.asked[0]).toMatchObject({ gateReason: "rule_of_two", reviewed: false });
  });

  test("a request from a workspace rule (policy) belongs to the person: the reviewer isn't consulted", async () => {
    const { state, tool } = sender();
    const { ctx, reviews, asked } = fakeCtx(reject, { review: () => "allow" });
    await runTool(ctx, [tool], "send_note", { text: "hi" });
    expect(reviews).toEqual([]);
    expect(state.ran).toEqual([]);
    expect(asked[0]).toMatchObject({ gateReason: "policy", reviewed: false });
  });
});
