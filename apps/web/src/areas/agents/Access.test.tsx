import { describe, expect, test } from "bun:test";
import { act, screen, waitFor, within } from "@testing-library/react";
import { type App, chooseOption, newServer, renderApp } from "../../../test/app.tsx";

const tab = (agentId: string) => `/workspace/workspace_birchwood/agents/${agentId}?tab=access`;

/** A private channel only Ana and Jonas are in, which the agent joined. */
function withPayroll(server = newServer(), agentId = "agt_scout") {
  server.state.channels.push({
    id: "ch_secret",
    workspaceId: "workspace_birchwood",
    name: "payroll",
    topic: "",
    isGeneral: false,
    visibility: "private",
    budgetPerMonthUsd: null,
    createdAt: "2026-11-02T09:00:00.000Z",
    memberIds: ["usr_ana", "usr_jonas"],
  });
  const agent = server.agents.find((each) => each.id === agentId);
  if (agent !== undefined)
    server.agentWork.extra(agent).channels.push({ id: "ch_secret", autoAnswer: false });
  return server;
}

const rules = () =>
  within(screen.getByRole("list", { name: "Rules per channel" }))
    .getAllByRole("listitem")
    .map((row) => row.textContent);

describe("the agent's own accounts", () => {
  test("listed with their state; a member sees them without the controls", async () => {
    await renderApp({ path: tab("agt_scout"), signedInAs: "usr_iris" });
    const accounts = await screen.findByRole("list", { name: "The agent's own accounts" });
    expect(accounts.textContent).toContain("Linear");
    expect(accounts.textContent).toContain("scout@birchwood.example");
    expect(accounts.textContent).toContain("Connected");
    expect(screen.queryByRole("form", { name: "Connect an account" }) === null).toBe(true);
    expect(screen.queryByRole("button", { name: "Disconnect all accounts" }) === null).toBe(true);
  });

  test("the owner connects a service by key, which needs eight characters", async () => {
    const app = await renderApp({ path: tab("agt_scout"), signedInAs: "usr_ana" });
    const form = await screen.findByRole("form", { name: "Connect an account" });
    await chooseOption(app, within(form).getByRole("combobox", { name: "Service" }), "Stripe");
    await app.user.type(within(form).getByLabelText("Key"), "short");
    expect(within(form).getByText("The key needs at least 8 characters.")).toBeDefined();
    expect(within(form).getByRole("button", { name: "Connect" }).hasAttribute("disabled")).toBe(true);
    await app.user.type(within(form).getByLabelText("Key"), "-and-long");
    await app.user.click(within(form).getByRole("button", { name: "Connect" }));
    expect(await screen.findByText("Stripe is connected")).toBeDefined();
    expect(app.server.agentAccess.accounts.get("agt_scout")?.map((each) => each.connector)).toEqual([
      "linear",
      "stripe",
    ]);
  });

  test("a key typed for one service is not kept for another", async () => {
    const app = await renderApp({ path: tab("agt_tally"), signedInAs: "usr_jonas" });
    const form = await screen.findByRole("form", { name: "Connect an account" });
    await chooseOption(app, within(form).getByRole("combobox", { name: "Service" }), "Stripe");
    await app.user.type(within(form).getByLabelText("Key"), "stripe-secret-key");
    await chooseOption(app, within(form).getByRole("combobox", { name: "Service" }), "Linear");
    expect((within(form).getByLabelText("Key") as HTMLInputElement).value).toBe("");
    expect(within(form).getByRole("button", { name: "Sign in on the service" })).toBeDefined();
  });

  test("disconnecting every account asks first", async () => {
    const app = await renderApp({ path: tab("agt_scout"), signedInAs: "usr_ana" });
    await app.user.click(await screen.findByRole("button", { name: "Disconnect all accounts" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Disconnect all of Scout's accounts?" });
    await app.user.click(within(dialog).getByRole("button", { name: "Disconnect all accounts" }));
    expect(await screen.findByText("1 account was disconnected")).toBeDefined();
    expect(await screen.findByText("The agent has no accounts of its own.")).toBeDefined();
  });
});

describe("the rules per channel", () => {
  test("a member never sees the rules of a private channel they are not in", async () => {
    await renderApp({ path: tab("agt_scout"), signedInAs: "usr_iris", server: withPayroll() });
    await screen.findByRole("list", { name: "Rules per channel" });
    expect(rules()).toEqual(["#generalAll connectionsRead only"]);
    expect(document.body.textContent).not.toContain("payroll");
    expect(screen.queryByRole("form", { name: "Add rule" }) === null).toBe(true);
  });

  test("someone in the private channel sees its rule too", async () => {
    await renderApp({ path: tab("agt_scout"), signedInAs: "usr_ana", server: withPayroll() });
    await screen.findByRole("list", { name: "Rules per channel" });
    expect(rules()).toEqual(["#generalAll connectionsRead only", "#payrollLinear · Team LinearOff"]);
  });

  test("a new rule replaces the one for the same channel and connection", async () => {
    const app = await renderApp({ path: tab("agt_scout"), signedInAs: "usr_ana" });
    const form = await screen.findByRole("form", { name: "Add rule" });
    await chooseOption(app, within(form).getByRole("combobox", { name: "Channel" }), "#general");
    await chooseOption(
      app,
      within(form).getByRole("combobox", { name: "Access" }),
      "Each use needs approval",
    );
    await app.user.click(within(form).getByRole("button", { name: "Add rule" }));
    expect(await screen.findByText("Rule saved")).toBeDefined();
    await waitFor(() => expect(rules()).toEqual(["#generalAll connectionsEach use needs approval"]));
  });

  test("the owner who is a member keeps the hidden rules when saving the visible ones", async (): Promise<void> => {
    const server = withPayroll(newServer(), "agt_tally");
    const tally = server.agents.find((each) => each.id === "agt_tally");
    if (tally !== undefined) tally.ownerUserId = "usr_iris";
    server.agentAccess.rules.push(
      { agentId: "agt_tally", channelId: "ch_secret", connectionId: "*", level: "off" },
      { agentId: "agt_tally", channelId: "ch_general", connectionId: "*", level: "read" },
    );
    const app: App = await renderApp({ path: tab("agt_tally"), signedInAs: "usr_iris", server });
    await screen.findByRole("list", { name: "Rules per channel" });
    expect(rules()).toEqual(["#generalAll connectionsRead only"]);
    await app.user.click(
      screen.getByRole("button", { name: "Remove the rule for All connections in #general" }),
    );
    expect(await screen.findByText("Rule removed")).toBeDefined();
    expect(await screen.findByText("No rules")).toBeDefined();
    expect(server.agentAccess.rules.filter((rule) => rule.agentId === "agt_tally")).toEqual([
      { agentId: "agt_tally", channelId: "ch_secret", connectionId: "*", level: "off" },
    ]);
    // The private channel never appears among the choices either.
    const form = screen.getByRole("form", { name: "Add rule" });
    await app.user.click(within(form).getByRole("combobox", { name: "Channel" }));
    expect(screen.queryByRole("option", { name: "#payroll" }) === null).toBe(true);
  });

  test("the workspace's connections that fail to load say so and can be tried again", async () => {
    const server = newServer();
    server.force("listConnectors", { kind: "error", status: 503, code: "unavailable" }, 4);
    const app = await renderApp({ path: tab("agt_scout"), signedInAs: "usr_ana", server });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("The workspace's connections could not be loaded");
    await app.user.click(within(alert).getByRole("button", { name: "Retry" }));
    const form = await screen.findByRole("form", { name: "Add rule" });
    await waitFor(() => expect(screen.queryByRole("alert") === null).toBe(true));
    await app.user.click(within(form).getByRole("combobox", { name: "Connection" }));
    expect(await screen.findByRole("option", { name: "Linear · Team Linear" })).toBeDefined();
  });

  test("after the person leaves a private channel its rule is neither shown nor sent again", async () => {
    const server = withPayroll(newServer(), "agt_tally");
    const payroll = server.state.channels.find((channel) => channel.id === "ch_secret");
    if (payroll !== undefined) payroll.memberIds = ["usr_ana", "usr_iris"];
    const tally = server.agents.find((each) => each.id === "agt_tally");
    if (tally !== undefined) tally.ownerUserId = "usr_iris";
    server.agentAccess.rules.push(
      { agentId: "agt_tally", channelId: "ch_general", connectionId: "*", level: "read" },
      { agentId: "agt_tally", channelId: "ch_secret", connectionId: "*", level: "off" },
    );
    const app = await renderApp({ path: tab("agt_tally"), signedInAs: "usr_iris", server });
    await screen.findByRole("list", { name: "Rules per channel" });
    expect(rules()).toContain("#payrollAll connectionsOff");
    const form = screen.getByRole("form", { name: "Add rule" });
    await chooseOption(app, within(form).getByRole("combobox", { name: "Channel" }), "#payroll");
    // Iris leaves #payroll; the channel list is read again.
    if (payroll !== undefined) payroll.memberIds = ["usr_ana"];
    await act(async () => {
      server.emit("workspace_birchwood", { type: "channel.unread", channelId: "ch_general" });
    });
    await waitFor(() => expect(rules()).toEqual(["#generalAll connectionsRead only"]));
    expect(document.body.textContent).not.toContain("A private channel");
    expect(within(form).getByRole("button", { name: "Add rule" }).hasAttribute("disabled")).toBe(true);
    await app.user.click(
      screen.getByRole("button", { name: "Remove the rule for All connections in #general" }),
    );
    await screen.findByText("Rule removed");
    const sent = server.calls.filter((call) => call.method === "setAgentIdentityChannels");
    expect(sent.some((call) => JSON.stringify(call.params.channels).includes("ch_secret"))).toBe(false);
  });

  test("an error about one service goes away when another is picked", async () => {
    const server = newServer();
    server.force("createAgentIdentityConnection", {
      kind: "error",
      status: 400,
      code: "connector.key_rejected",
      message: "The service refused that key",
    });
    const app = await renderApp({ path: tab("agt_tally"), signedInAs: "usr_jonas", server });
    const form = await screen.findByRole("form", { name: "Connect an account" });
    await chooseOption(app, within(form).getByRole("combobox", { name: "Service" }), "Stripe");
    await app.user.type(within(form).getByLabelText("Key"), "a-long-enough-key");
    await app.user.click(within(form).getByRole("button", { name: "Connect" }));
    expect(await within(form).findByRole("alert")).toBeDefined();
    await chooseOption(app, within(form).getByRole("combobox", { name: "Service" }), "Linear");
    expect(within(form).queryByRole("alert") === null).toBe(true);
  });

  test("rules that fail to load can be tried again", async () => {
    const server = newServer();
    server.force("getAgentIdentity", { kind: "error", status: 503, code: "unavailable" }, 4);
    const app = await renderApp({ path: tab("agt_scout"), signedInAs: "usr_iris", server });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("The agent's accounts and rules could not be loaded");
    await app.user.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("list", { name: "Rules per channel" })).toBeDefined();
  });
});
