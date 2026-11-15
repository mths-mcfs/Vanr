// The test of the worked example. Copy its shape: render the app at the screen's address against
// the fake server, then assert what a person sees and does, by role and label.
import { describe, expect, test } from "bun:test";
import { act, screen, waitFor, within } from "@testing-library/react";
import { QUERY_RETRIES } from "@vanr/client/react";
import { newServer, renderApp } from "../../../test/app.tsx";

const PATH = "/workspace/workspace_birchwood/agents";
const rows = () =>
  within(screen.getByRole("list", { name: "Agents" }))
    .getAllByRole("listitem")
    .map((row) => row.textContent);

describe("the agents of a workspace", () => {
  test("lists them with what is known: name, handle and whether each is working", async () => {
    await renderApp({ path: PATH, signedInAs: "usr_ana" });
    await screen.findByRole("heading", { level: 1, name: "Agents" });
    expect(await screen.findByText("3 agents in this workspace.")).toBeDefined();
    expect(rows()).toEqual(["Scout@scoutAt work", "Ledger@ledgerAt work", "Tally@tallyIdle"]);
    expect(screen.getByRole("link", { name: "Scout" }).getAttribute("href")).toBe(`${PATH}/agt_scout`);
    expect(document.title).toBe("Agents | Birchwood Labs | Vanr");
  });

  test("loading: the screen says it is busy until the answer arrives", async () => {
    const server = newServer();
    const held = server.hold("listAgents");
    await renderApp({ path: PATH, signedInAs: "usr_ana", server });
    expect(await within(screen.getByRole("main")).findByText("Loading")).toBeDefined();
    expect(screen.queryByRole("list", { name: "Agents" })).toBeNull();
    held.release();
    await screen.findByRole("list", { name: "Agents" });
  });

  test("failed: what could not be loaded, why, and a retry that works", async () => {
    const server = newServer();
    // A failure worth retrying is tried again by the client: the first call and its three retries.
    server.force("listAgents", { kind: "error", status: 500, code: "internal" }, 1 + QUERY_RETRIES);
    const app = await renderApp({ path: PATH, signedInAs: "usr_ana", server });
    const alert = await within(screen.getByRole("main")).findByRole("alert");
    expect(alert.textContent).toContain("The agents could not be loaded");
    expect(alert.textContent).toContain("The server ran into a problem. Try again.");
    await app.user.click(within(alert).getByRole("button", { name: "Retry" }));
    await screen.findByRole("list", { name: "Agents" });
  });

  test("failed with one of the area's own error codes: the area's own text", async () => {
    const server = newServer();
    server.force("listAgents", { kind: "error", status: 409, code: "agent.archived", message: "Archived" });
    await renderApp({ path: PATH, signedInAs: "usr_ana", server });
    expect((await within(screen.getByRole("main")).findByRole("alert")).textContent).toContain(
      "This agent is archived.",
    );
  });

  test("empty: what belongs here and how to add it", async () => {
    const server = newServer();
    server.agents = [];
    const app = await renderApp({ path: PATH, signedInAs: "usr_ana", server });
    expect(await screen.findByText("No agents in this workspace")).toBeDefined();
    expect(
      screen.getByText("An agent takes a role, joins channels and works alongside people."),
    ).toBeDefined();
    await app.user.click(screen.getByRole("button", { name: "Add an agent" }));
    await screen.findByRole("heading", { level: 1, name: "Add an agent" });
    expect(app.address()).toBe(`${PATH}/new`);
  });

  test("an agent starting a run is shown without a reload", async () => {
    const app = await renderApp({ path: PATH, signedInAs: "usr_ana" });
    await screen.findByRole("list", { name: "Agents" });
    await act(async () => app.server.setAgentBusy("agt_tally", true));
    await waitFor(() =>
      expect(rows()).toEqual(["Scout@scoutAt work", "Ledger@ledgerAt work", "Tally@tallyAt work"]),
    );
  });
});
