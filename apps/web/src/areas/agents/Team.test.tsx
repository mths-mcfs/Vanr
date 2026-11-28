// The team: render the app at the screen's address against the fake server, then assert what a person
// sees and does, by role and label.
import { describe, expect, test } from "bun:test";
import { act, screen, waitFor, within } from "@testing-library/react";
import { QUERY_RETRIES } from "@vanr/client/react";
import { newServer, renderApp, TEST_NOW } from "../../../test/app.tsx";

const PATH = "/workspace/workspace_birchwood/agents";
const rows = (owner: string) =>
  within(screen.getByRole("list", { name: owner }))
    .getAllByRole("listitem")
    .map((row) => row.textContent);

describe("the team", () => {
  test("groups the agents by owner, with what each is doing now", async () => {
    await renderApp({ path: PATH, signedInAs: "usr_ana" });
    await screen.findByRole("heading", { level: 1, name: "Agents" });
    expect(screen.getByText("3 agents in this workspace.")).toBeDefined();
    expect(rows("Ana Beatriz Souza's agents")).toEqual(["Scout@scoutAt work", "Ledger@ledgerAt work"]);
    expect(rows("Jonas Lind's agents")).toEqual(["Tally@tallyIdle"]);
    expect(document.title).toBe("Agents | Birchwood Labs | Vanr");
  });

  test("an agent whose owner left the workspace has its own group", async () => {
    const server = newServer();
    const tally = server.agents.find((agent) => agent.id === "agt_tally");
    if (tally !== undefined) tally.ownerUserId = "usr_gone";
    await renderApp({ path: PATH, signedInAs: "usr_ana", server });
    await screen.findByRole("list", { name: "Ana Beatriz Souza's agents" });
    expect(rows("No owner in this workspace")).toEqual(["Tally@tallyIdle"]);
  });

  test("picking an agent opens its card; Escape closes it", async () => {
    const app = await renderApp({ path: PATH, signedInAs: "usr_iris" });
    await app.user.click(await screen.findByRole("button", { name: "Tally" }));
    const card = screen.getByRole("region", { name: "Tally" });
    expect(within(card).getByText("Jonas Lind")).toBeDefined();
    expect(within(card).getByText("Idle")).toBeDefined();
    expect(within(card).getByRole("link", { name: "Open profile" }).getAttribute("href")).toBe(
      `${PATH}/agt_tally`,
    );
    expect(within(card).getByRole("link", { name: "Message Tally" }).getAttribute("href")).toBe(
      "/workspace/workspace_birchwood/dm/agent/agt_tally",
    );
    await app.user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("region", { name: "Tally" }) === null).toBe(true));
  });

  test("an agent the person may not talk to offers no message link", async () => {
    const server = newServer();
    const tally = server.agents.find((agent) => agent.id === "agt_tally");
    if (tally !== undefined) tally.reachable = false;
    const app = await renderApp({ path: PATH, signedInAs: "usr_iris", server });
    await app.user.click(await screen.findByRole("button", { name: "Tally" }));
    const card = screen.getByRole("region", { name: "Tally" });
    expect(within(card).queryByRole("link", { name: "Message Tally" }) === null).toBe(true);
  });

  test("whoever manages agents may add one", async () => {
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas" });
    await app.user.click(await screen.findByRole("button", { name: "Add an agent" }));
    await screen.findByRole("heading", { level: 1, name: "Add an agent" });
    expect(app.address()).toBe(`${PATH}/new`);
  });

  test("a member is not offered to add one", async () => {
    await renderApp({ path: PATH, signedInAs: "usr_iris" });
    await screen.findByRole("list", { name: "Jonas Lind's agents" });
    expect(screen.queryByRole("button", { name: "Add an agent" }) === null).toBe(true);
  });

  test("the delegations of the day, and one that arrives later is marked new", async () => {
    const app = await renderApp({ path: PATH, signedInAs: "usr_ana" });
    const list = await screen.findByRole("list", { name: "Delegations today" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);
    expect(list.textContent).toContain("Scout delegated to Ledger");
    expect(within(list).queryByText("New") === null).toBe(true);
    await act(async () => {
      app.server.agentWork.delegations.unshift({
        workspaceId: "workspace_birchwood",
        requesterAgentId: "agt_tally",
        delegateAgentId: "agt_scout",
        status: "open",
        at: TEST_NOW.toISOString(),
      });
      app.server.emit("workspace_birchwood", { type: "delegation.started", agentId: "agt_tally" });
    });
    await waitFor(() =>
      expect(
        within(screen.getByRole("list", { name: "Delegations today" })).getAllByRole("listitem"),
      ).toHaveLength(2),
    );
    const fresh = within(screen.getByRole("list", { name: "Delegations today" })).getAllByRole("listitem")[0];
    expect(fresh?.textContent).toContain("Tally delegated to Scout");
    expect(fresh?.textContent).toContain("New");
  });

  test("loading: the screen says it is busy until the answer arrives", async () => {
    const server = newServer();
    const held = server.hold("getTeam");
    await renderApp({ path: PATH, signedInAs: "usr_ana", server });
    expect(await within(screen.getByRole("main")).findByText("Loading")).toBeDefined();
    held.release();
    await screen.findByRole("list", { name: "Jonas Lind's agents" });
  });

  test("failed: what could not be loaded, why, and a retry that works", async () => {
    const server = newServer();
    server.force("getTeam", { kind: "error", status: 500, code: "internal" }, 1 + QUERY_RETRIES);
    const app = await renderApp({ path: PATH, signedInAs: "usr_ana", server });
    const alert = await within(screen.getByRole("main")).findByRole("alert");
    expect(alert.textContent).toContain("The agents could not be loaded");
    expect(alert.textContent).toContain("The server ran into a problem. Try again.");
    await app.user.click(within(alert).getByRole("button", { name: "Retry" }));
    await screen.findByRole("list", { name: "Jonas Lind's agents" });
  });

  test("failed with one of the area's own error codes: the area's own text", async () => {
    const server = newServer();
    server.force("getTeam", { kind: "error", status: 409, code: "agent.archived", message: "Archived" });
    await renderApp({ path: PATH, signedInAs: "usr_ana", server });
    expect((await within(screen.getByRole("main")).findByRole("alert")).textContent).toContain(
      "This agent is archived.",
    );
  });

  test("empty: what belongs here, and the way to add one for whoever may", async () => {
    const server = newServer();
    server.agents = [];
    await renderApp({ path: PATH, signedInAs: "usr_ana", server });
    expect(await screen.findByText("No agents in this workspace")).toBeDefined();
    expect(
      screen.getByText("An agent takes a role, joins channels and works alongside people."),
    ).toBeDefined();
    expect(screen.getByRole("button", { name: "Add an agent" })).toBeDefined();
  });

  test("empty, for a member: who to ask instead of a button", async () => {
    const server = newServer();
    server.agents = [];
    await renderApp({ path: PATH, signedInAs: "usr_iris", server });
    expect(
      await screen.findByText(
        "An agent takes a role, joins channels and works alongside people. Ask an admin to add one.",
      ),
    ).toBeDefined();
    expect(screen.queryByRole("button", { name: "Add an agent" }) === null).toBe(true);
  });

  test("an agent starting a run is shown without a reload", async () => {
    const app = await renderApp({ path: PATH, signedInAs: "usr_ana" });
    await screen.findByRole("list", { name: "Jonas Lind's agents" });
    await act(async () => app.server.setAgentBusy("agt_tally", true));
    await waitFor(() => expect(rows("Jonas Lind's agents")).toEqual(["Tally@tallyAt work"]));
  });
});
