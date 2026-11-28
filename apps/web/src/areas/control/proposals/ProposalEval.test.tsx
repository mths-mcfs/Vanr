// The test cases on the card of a pending change to Scout's instructions, against the fake server: nothing to
// compare without cases, a run read again every 1.5 s until it ends, a run that can't start, and the cases that
// got worse listed first.
import { describe, expect, test } from "bun:test";
import { screen, waitFor, within } from "@testing-library/react";
import type { AgentEval, AgentTestCase } from "@vanr/contract";
import { newServer, renderApp } from "../../../../test/app.tsx";

const PATH = "/workspace/workspace_birchwood/proposals";
const TITLE = "Answer print questions with the shop's hours";
const card = () => screen.findByRole("article", { name: TITLE });
const testCase = (id: string, input: string): AgentTestCase => ({
  id,
  agentId: "agt_scout",
  createdAt: "2026-11-14T10:00:00.000Z",
  input,
  mustInclude: ["9 to 18"],
  mustNotInclude: [],
  updatedAt: "2026-11-14T10:00:00.000Z",
});
const side = (pass: boolean, text: string) => ({ pass, text, failed: pass ? [] : ["include:9 to 18"] });

describe("the test cases of an instructions proposal", () => {
  test("an agent without test cases has nothing to compare", async () => {
    await renderApp({ path: PATH, signedInAs: "usr_ana" });
    const tone = await card();
    expect(
      await within(tone).findByText("This agent has no test cases, so there is nothing to compare."),
    ).toBeDefined();
    expect(within(tone).queryByRole("button", { name: /Run/ }) === null).toBe(true);
  });

  test("a run in progress is read again every 1.5 s until it ends", async () => {
    const server = newServer();
    server.control.testCases.set("agt_scout", [
      testCase("tc_1", "When do you open?"),
      testCase("tc_2", "Hours?"),
    ]);
    const app = await renderApp({ path: PATH, server, signedInAs: "usr_ana" });
    const tone = await card();
    await app.user.click(await within(tone).findByRole("button", { name: "Run 2 test cases" }));
    expect(await within(tone).findByText("Running 0 of 2")).toBeDefined();
    const run = server.control.evals[0];
    if (run === undefined) throw new Error("no run");
    expect(run.proposalId).toBe("prop_tone");
    run.done = 1;
    expect(await within(tone).findByText("Running 1 of 2", undefined, { timeout: 4000 })).toBeDefined();
    Object.assign(run, {
      status: "done",
      done: 2,
      summary: { beforePass: 2, afterPass: 2, cases: 2, regressions: 0 },
      results: [],
    } satisfies Partial<AgentEval>);
    expect(await within(tone).findByText("Nothing got worse", undefined, { timeout: 4000 })).toBeDefined();
    const reads = server.calls.filter((call) => call.method === "listAgentEvals").length;
    await new Promise((resolve) => setTimeout(resolve, 1800));
    // Finished: no more reads.
    expect(server.calls.filter((call) => call.method === "listAgentEvals").length).toBe(reads);
    expect(within(tone).getByRole("button", { name: "Run again" })).toBeDefined();
  });

  test("a run that can't start says why and keeps the button", async () => {
    const server = newServer();
    server.control.testCases.set("agt_scout", [testCase("tc_1", "When do you open?")]);
    server.force("createAgentEval", { kind: "error", status: 500, code: "internal" });
    const app = await renderApp({ path: PATH, server, signedInAs: "usr_ana" });
    const tone = await card();
    await app.user.click(await within(tone).findByRole("button", { name: "Run 1 test case" }));
    await waitFor(() => expect(server.calls.some((call) => call.method === "createAgentEval")).toBe(true));
    const toasts = screen.getByRole("region", { name: /Notifications/ });
    await waitFor(() => expect((toasts.textContent ?? "").length > 0).toBe(true));
    expect(server.control.evals).toEqual([]);
    expect(within(tone).getByRole("button", { name: "Run 1 test case" })).toBeDefined();
  });

  test("the cases that got worse come first, with the score", async () => {
    const server = newServer();
    server.control.testCases.set("agt_scout", [
      testCase("tc_1", "Fine case"),
      testCase("tc_2", "Worse case"),
    ]);
    server.control.evals = [
      {
        id: "eval_1",
        agentId: "agt_scout",
        costUsd: 0.0012,
        createdAt: "2026-11-14T11:00:00.000Z",
        done: 2,
        error: null,
        finishedAt: "2026-11-14T11:01:00.000Z",
        proposalId: "prop_tone",
        status: "done",
        summary: { beforePass: 2, afterPass: 1, cases: 2, regressions: 1 },
        total: 2,
        results: [
          {
            caseId: "tc_1",
            input: "Fine case",
            before: side(true, "9 to 18"),
            after: side(true, "Open 9 to 18"),
          },
          {
            caseId: "tc_2",
            input: "Worse case",
            before: side(true, "9 to 18"),
            after: side(false, "Ask the shop"),
          },
        ],
      },
    ];
    await renderApp({ path: PATH, server, signedInAs: "usr_ana" });
    const tone = await card();
    expect(await within(tone).findByText("Today 2 of 2 pass, with the proposal 1 of 2")).toBeDefined();
    expect(within(tone).getByText("1 got worse")).toBeDefined();
    const worse = within(tone).getByText("Worse case");
    const fine = within(tone).getByText("Fine case");
    expect(Boolean(worse.compareDocumentPosition(fine) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    expect(within(tone).getByText("Missing “9 to 18”")).toBeDefined();
  });
});
