import { describe, expect, test } from "bun:test";
import { screen, waitFor, within } from "@testing-library/react";
import { type App, newServer, renderApp } from "../../../test/app.tsx";

const PATH = "/workspace/workspace_birchwood/agents";
const lab = (agentId: string) => `${PATH}/${agentId}?tab=lab`;

async function addCase(app: App, input: string, must: string, mustNot = "") {
  await app.user.type(screen.getByLabelText("Prompt"), input);
  await app.user.type(screen.getByLabelText("The answer must say"), must);
  if (mustNot !== "") await app.user.type(screen.getByLabelText("The answer must not say"), mustNot);
  await app.user.click(screen.getByRole("button", { name: "Add a case" }));
}

describe("the lab", () => {
  test("an admin adds a case and runs it against new instructions, side by side", async () => {
    const app = await renderApp({ path: lab("agt_scout"), signedInAs: "usr_jonas" });
    expect(await screen.findByText("No test cases yet. Add one below.")).toBeDefined();
    await addCase(app, "Say hello to the shop", "hello", "goodbye");
    const cases = await screen.findByRole("list", { name: "Test cases" });
    expect(cases.textContent).toContain("Say hello to the shop");
    expect(cases.textContent).toContain("says “hello”");
    expect(cases.textContent).toContain("never “goodbye”");
    expect(screen.getByText("1 of 50 cases")).toBeDefined();
    expect((screen.getByLabelText("Prompt") as HTMLTextAreaElement).value).toBe("");

    await app.user.type(screen.getByLabelText("Instructions to try"), "Greet warmly.");
    await app.user.click(screen.getByRole("button", { name: "Run the cases" }));
    expect(await screen.findByText("Running: 0 of 1 cases done")).toBeDefined();
    // Followed until it ends, without a reload.
    const summary = await screen.findByText(
      "Current instructions pass 1 of 1; the new text passes 1 of 1.",
      {},
      { timeout: 4000 },
    );
    expect(summary).toBeDefined();
    const results = screen.getByRole("region", { name: "Test results" });
    expect(within(results).getByRole("region", { name: "Current" }).textContent).toContain("Pass");
    expect(within(results).getByRole("region", { name: "New text" }).textContent).toContain(
      "Say hello to the shop",
    );
  });

  test("instructions that break a passing case say what got worse", async () => {
    const server = newServer();
    const app = await renderApp({ path: lab("agt_scout"), signedInAs: "usr_jonas", server });
    await screen.findByText("No test cases yet. Add one below.");
    await addCase(app, "Say hello", "hello");
    await screen.findByText("1 of 50 cases");
    await app.user.clear(screen.getByLabelText("Instructions to try"));
    // The fake model fails on [[fail]], as the real one; pasted, since typing reads brackets as keys.
    await app.user.click(screen.getByLabelText("Instructions to try"));
    await app.user.paste("[[fail]]");
    await app.user.click(screen.getByRole("button", { name: "Run the cases" }));
    await screen.findByText(/the new text passes 0 of 1\. 1 case got worse\./, {}, { timeout: 4000 });
    const after = within(screen.getByRole("region", { name: "Test results" })).getByRole("region", {
      name: "New text",
    });
    expect(after.textContent).toContain("Fail");
    expect(after.textContent).toContain("No answer (fake_failure)");
    expect(after.textContent).toContain("Now fails");
  });

  test("a case can be removed", async () => {
    const app = await renderApp({ path: lab("agt_scout"), signedInAs: "usr_ana" });
    await screen.findByText("No test cases yet. Add one below.");
    await addCase(app, "Count the paper", "paper");
    await app.user.click(await screen.findByRole("button", { name: "Remove the case “Count the paper”" }));
    expect(await screen.findByText("No test cases yet. Add one below.")).toBeDefined();
  });

  test("a run already going is said in the area's own words", async () => {
    const server = newServer();
    server.force("createAgentEval", { kind: "error", status: 409, code: "agent_eval.running" });
    const app = await renderApp({ path: lab("agt_scout"), signedInAs: "usr_jonas", server });
    await screen.findByText("No test cases yet. Add one below.");
    await addCase(app, "Say hi", "hi");
    await screen.findByText("1 of 50 cases");
    await app.user.click(screen.getByRole("button", { name: "Run the cases" }));
    expect(await screen.findByText("A test run is already going for this agent.")).toBeDefined();
  });

  test("the owner without the admin role keeps the cases but does not run new text", async () => {
    const server = newServer();
    const tally = server.agents.find((agent) => agent.id === "agt_tally");
    if (tally !== undefined) tally.ownerUserId = "usr_iris";
    const app = await renderApp({ path: lab("agt_tally"), signedInAs: "usr_iris", server });
    await screen.findByText("No test cases yet. Add one below.");
    await addCase(app, "Tally the day", "day");
    await screen.findByText("1 of 50 cases");
    expect(screen.getByText(/Only admins try new instructions/)).toBeDefined();
    expect(screen.queryByRole("button", { name: "Run the cases" }) === null).toBe(true);
  });

  test("without a case there is nothing to run", async () => {
    await renderApp({ path: lab("agt_scout"), signedInAs: "usr_jonas" });
    await screen.findByText("No test cases yet. Add one below.");
    expect(screen.getByRole("button", { name: "Run the cases" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("Add a test case to run.")).toBeDefined();
  });

  test("while the cases are loading there is nothing to run yet", async () => {
    const server = newServer();
    const held = server.hold("listAgentTestCases");
    await renderApp({ path: lab("agt_scout"), signedInAs: "usr_jonas", server });
    const run = await screen.findByRole("button", { name: "Run the cases" });
    expect(run.hasAttribute("disabled")).toBe(true);
    held.release();
  });

  test("an archived agent's lab is closed, and nothing is asked of the server", async () => {
    const server = newServer();
    const scout = server.agents.find((agent) => agent.id === "agt_scout");
    if (scout !== undefined) scout.archivedAt = "2026-11-10T09:00:00.000Z";
    await renderApp({ path: lab("agt_scout"), signedInAs: "usr_jonas", server });
    expect(await screen.findByText("The lab is closed for an archived agent")).toBeDefined();
    expect(screen.queryByRole("alert") === null).toBe(true);
    const asked = server.calls.map((call) => call.method);
    expect(asked.includes("listAgentTestCases") || asked.includes("listAgentEvals")).toBe(false);
  });

  test("anyone else is told whose the lab is", async () => {
    await renderApp({ path: lab("agt_scout"), signedInAs: "usr_iris" });
    expect(await screen.findByText("The lab is for the agent's owner and admins")).toBeDefined();
  });

  test("cases that fail to load can be tried again", async () => {
    const server = newServer();
    server.force("listAgentTestCases", { kind: "error", status: 503, code: "unavailable" }, 4);
    const app = await renderApp({ path: lab("agt_scout"), signedInAs: "usr_jonas", server });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("The test cases could not be loaded");
    await app.user.click(within(alert).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByText("No test cases yet. Add one below.")).toBeDefined());
  });
});
