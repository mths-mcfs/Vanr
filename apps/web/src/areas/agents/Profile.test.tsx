import { describe, expect, test } from "bun:test";
import { screen, waitFor, within } from "@testing-library/react";
import { type App, chooseOption, newServer, renderApp } from "../../../test/app.tsx";

const BASE = "/workspace/workspace_birchwood/agents";
const path = (agentId: string, tab?: string) => `${BASE}/${agentId}${tab === undefined ? "" : `?tab=${tab}`}`;
const agentIn = (app: App, id: string) => {
  const found = app.server.agents.find((agent) => agent.id === id);
  if (found === undefined) throw new Error(`no agent ${id}`);
  return found;
};

describe("an agent's profile", () => {
  test("who it is, what answers for it, and a way to talk to it", async () => {
    const app = await renderApp({ path: path("agt_scout"), signedInAs: "usr_iris" });
    await screen.findByRole("heading", { level: 1, name: "Scout" });
    const cover = screen.getByRole("heading", { level: 1 }).parentElement?.textContent ?? "";
    expect(cover).toContain("@scout");
    expect(cover).toContain("Assistant");
    // Scout has a run going in the seed.
    expect(cover).toContain("At work");
    await waitFor(() => expect(screen.getByText("Model · Claude Haiku 5.5")).toBeDefined());
    expect(document.title).toBe("Scout | Birchwood Labs | Vanr");
    await app.user.click(screen.getByRole("button", { name: "Message Scout" }));
    expect(app.address()).toBe("/workspace/workspace_birchwood/dm/agent/agt_scout");
  });

  test("the overview: where it works, its owner and what it did lately", async () => {
    await renderApp({ path: path("agt_scout"), signedInAs: "usr_iris" });
    const where = await screen.findByRole("list", { name: "Channels it is in" });
    expect(within(where).getByRole("link", { name: "#general" })).toBeDefined();
    await waitFor(() => expect(screen.getByText("Owner: Ana Beatriz Souza")).toBeDefined());
    const lately = await screen.findByRole("list", { name: "Lately" });
    expect(lately.textContent).toContain("Summarized the print queue");
  });

  test("the tabs live in the address", async () => {
    const app = await renderApp({ path: path("agt_scout"), signedInAs: "usr_iris" });
    await app.user.click(await screen.findByRole("tab", { name: "Activity" }));
    expect(app.address()).toBe(path("agt_scout", "activity"));
    expect(await screen.findByRole("list", { name: "Activity" })).toBeDefined();
  });

  test("an agent that does not exist is not asked for again", async () => {
    const server = newServer();
    server.force(
      "getAgent",
      { kind: "error", status: 404, code: "not_found", message: "Agent not found" },
      5,
    );
    await renderApp({ path: path("agt_nobody"), signedInAs: "usr_iris", server });
    expect((await screen.findByRole("alert")).textContent).toContain("The agent could not be loaded");
    expect(server.calls.filter((call) => call.method === "getAgent")).toHaveLength(1);
  });

  test("an archived agent says so and offers no conversation", async () => {
    const server = newServer();
    const scout = server.agents.find((agent) => agent.id === "agt_scout");
    if (scout !== undefined) scout.archivedAt = "2026-11-10T09:00:00.000Z";
    await renderApp({ path: path("agt_scout"), signedInAs: "usr_ana", server });
    expect(await screen.findByText(/This agent is archived/)).toBeDefined();
    expect(screen.queryByRole("button", { name: "Message Scout" }) === null).toBe(true);
  });
});

describe("the instructions and their history", () => {
  test("an admin saves a new text with a reason, compares and goes back to an old version", async () => {
    const app = await renderApp({ path: path("agt_scout", "instructions"), signedInAs: "usr_jonas" });
    const editor = await screen.findByRole("textbox", { name: "Instructions" });
    await app.user.type(editor, "Be brief.");
    await app.user.type(screen.getByLabelText("Why this change (optional)"), "Shorter answers");
    await app.user.click(screen.getByRole("button", { name: "Save instructions" }));
    expect(await screen.findByText("Instructions saved")).toBeDefined();
    expect(agentIn(app, "agt_scout").instructions).toBe("Be brief.");

    const history = await screen.findByRole("list", { name: "History" });
    await waitFor(() => expect(within(history).getAllByRole("listitem")).toHaveLength(2));
    const [latest] = within(history).getAllByRole("listitem");
    expect(latest?.textContent).toContain("Version 2");
    expect(latest?.textContent).toContain("Edited");
    expect(latest?.textContent).toContain("Jonas Lind");
    expect(latest?.textContent).toContain("Current");
    expect(latest?.textContent).toContain("Shorter answers");

    await app.user.click(within(history).getByRole("button", { name: "Compare with the one before" }));
    const diff = screen.getByRole("region", { name: "Changes" });
    expect(diff.textContent).toContain("+1 / −0 lines");
    expect(diff.textContent).toContain("+ Be brief.");

    await app.user.click(within(history).getByRole("button", { name: "Go back to this version" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Go back to version 1?" });
    await app.user.click(within(dialog).getByRole("button", { name: "Go back to this version" }));
    expect(await screen.findByText("Version 1 is the current text again")).toBeDefined();
    expect(agentIn(app, "agt_scout").instructions).toBe("");
    await waitFor(() =>
      expect(within(screen.getByRole("list", { name: "History" })).getAllByRole("listitem")).toHaveLength(3),
    );
  });

  test("a member reads the instructions and their history, and changes nothing", async () => {
    const server = newServer();
    const scout = server.agents.find((agent) => agent.id === "agt_scout");
    if (scout !== undefined) scout.instructions = "Keep the queue moving.";
    await renderApp({ path: path("agt_scout", "instructions"), signedInAs: "usr_iris", server });
    const editor = (await screen.findByRole("textbox", { name: "Instructions" })) as HTMLTextAreaElement;
    expect(editor.readOnly).toBe(true);
    expect(screen.getByText("Only admins change the instructions.")).toBeDefined();
    await screen.findByRole("list", { name: "History" });
    expect(screen.queryByRole("button", { name: "Go back to this version" }) === null).toBe(true);
  });

  test("a history that fails to load can be tried again", async () => {
    const server = newServer();
    server.force("listAgentInstructionVersions", { kind: "error", status: 503, code: "unavailable" }, 4);
    const app = await renderApp({ path: path("agt_scout", "instructions"), signedInAs: "usr_iris", server });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("The history could not be loaded");
    await app.user.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("list", { name: "History" })).toBeDefined();
  });
});

describe("the harness and the model", () => {
  test("an admin changes the model; a harness that cannot run here says why", async () => {
    const app = await renderApp({ path: path("agt_scout", "harness"), signedInAs: "usr_jonas" });
    const claude = await screen.findByRole("radio", { name: /Claude Code/ });
    expect(claude.hasAttribute("disabled") || claude.getAttribute("data-disabled") !== null).toBe(true);
    expect(screen.getAllByText("The agent has no runner yet.").length).toBeGreaterThan(0);
    await chooseOption(app, screen.getByRole("combobox", { name: "Model" }), "Claude Opus 5.5");
    expect(await screen.findByText("Harness saved")).toBeDefined();
    expect(agentIn(app, "agt_scout").model).toBe("claude-opus-5-5");
  });

  test("a member sees the choices locked", async () => {
    await renderApp({ path: path("agt_scout", "harness"), signedInAs: "usr_iris" });
    expect(await screen.findByText("Only admins change the harness and the model.")).toBeDefined();
    expect(screen.getByRole("radio", { name: /^Model/ }).hasAttribute("disabled")).toBe(true);
  });
});

describe("the agent's skills", () => {
  test("whoever edits the agent turns a skill on", async () => {
    const app = await renderApp({ path: path("agt_scout", "skills"), signedInAs: "usr_ana" });
    const list = await screen.findByRole("list", { name: "Skills" });
    await app.user.click(within(list).getByRole("switch", { name: /Release notes/ }));
    expect(await screen.findByText("Release notes is on for this agent")).toBeDefined();
    expect(app.server.agentWork.extra(agentIn(app, "agt_scout")).skills.get("skl_release")).toBe(true);
  });

  test("a member sees which are on without the switches", async () => {
    await renderApp({ path: path("agt_scout", "skills"), signedInAs: "usr_iris" });
    const list = await screen.findByRole("list", { name: "Skills" });
    expect(
      within(list)
        .getByRole("switch", { name: /Release notes/ })
        .hasAttribute("disabled"),
    ).toBe(true);
  });

  test("no skills in the workspace: where to make one", async () => {
    const server = newServer();
    server.agentWork.skills = [];
    await renderApp({ path: path("agt_scout", "skills"), signedInAs: "usr_ana", server });
    expect(await screen.findByText("The workspace has no skills yet")).toBeDefined();
    expect(screen.getByRole("link", { name: "Open the skills catalog" })).toBeDefined();
  });
});

describe("activity and saving a run as a skill", () => {
  test("an admin drafts a skill from a finished run, saves it and turns it on here", async () => {
    const app = await renderApp({ path: path("agt_scout", "activity"), signedInAs: "usr_jonas" });
    const runs = await screen.findByRole("list", { name: "Activity" });
    const [done, failed] = within(runs).getAllByRole("listitem");
    expect(done?.textContent).toContain("Done");
    expect(failed?.textContent).toContain("Failed");
    expect(within(failed as HTMLElement).queryByRole("button", { name: "Save as a skill" }) === null).toBe(
      true,
    );

    await app.user.click(within(done as HTMLElement).getByRole("button", { name: "Save as a skill" }));
    const dialog = await screen.findByRole("dialog", { name: "Save this run as a skill" });
    expect(await within(dialog).findByText("The test model wrote this draft, not a real one.")).toBeDefined();
    expect((within(dialog).getByLabelText("Name") as HTMLInputElement).value).toBe(
      "Summarized the print queue",
    );
    await app.user.click(within(dialog).getByRole("button", { name: "Save the skill" }));
    expect(await screen.findByText("Summarized the print queue was added to the skills")).toBeDefined();
    const saved = app.server.agentWork.skills.find((skill) => skill.name === "Summarized the print queue");
    expect(saved?.sourceRunId).toBe("run_scout_1");

    await app.user.click(within(dialog).getByRole("button", { name: "Turn it on for Scout" }));
    await waitFor(() =>
      expect(app.server.agentWork.extra(agentIn(app, "agt_scout")).skills.get(saved?.id ?? "")).toBe(true),
    );
  });

  test("a run from a private place asks before the whole workspace may read it", async () => {
    const server = newServer();
    server.agentWork.privateRuns.add("run_scout_1");
    const app = await renderApp({ path: path("agt_scout", "activity"), signedInAs: "usr_jonas", server });
    const runs = await screen.findByRole("list", { name: "Activity" });
    await app.user.click(within(runs).getAllByRole("button", { name: "Save as a skill" })[0] as HTMLElement);
    const dialog = await screen.findByRole("dialog", { name: "Save this run as a skill" });
    await within(dialog).findByText(/private channel or a direct message/);
    const save = within(dialog).getByRole("button", { name: "Save the skill" });
    expect(save.hasAttribute("disabled")).toBe(true);
    await app.user.click(within(dialog).getByRole("checkbox", { name: /All workspace members may read/ }));
    expect(save.hasAttribute("disabled")).toBe(false);
  });

  test("an archived agent's run still becomes a skill, but the skill is not turned on for it", async () => {
    const server = newServer();
    const scout = server.agents.find((agent) => agent.id === "agt_scout");
    if (scout !== undefined) scout.archivedAt = "2026-11-10T09:00:00.000Z";
    const app = await renderApp({ path: path("agt_scout", "activity"), signedInAs: "usr_jonas", server });
    const runs = await screen.findByRole("list", { name: "Activity" });
    await app.user.click(within(runs).getAllByRole("button", { name: "Save as a skill" })[0] as HTMLElement);
    const dialog = await screen.findByRole("dialog", { name: "Save this run as a skill" });
    await within(dialog).findByLabelText("Name");
    await app.user.click(within(dialog).getByRole("button", { name: "Save the skill" }));
    expect(await screen.findByText("Summarized the print queue was added to the skills")).toBeDefined();
    expect(within(dialog).queryByRole("button", { name: "Turn it on for Scout" }) === null).toBe(true);
  });

  test("a member sees the runs without the button", async () => {
    await renderApp({ path: path("agt_scout", "activity"), signedInAs: "usr_iris" });
    await screen.findByRole("list", { name: "Activity" });
    expect(screen.queryByRole("button", { name: "Save as a skill" }) === null).toBe(true);
  });

  test("no runs yet: where they come from", async () => {
    await renderApp({ path: path("agt_tally", "activity"), signedInAs: "usr_iris" });
    expect(await screen.findByText("No runs yet")).toBeDefined();
  });
});

describe("the agent's settings", () => {
  test("its owner without the admin role changes only who may talk to it", async () => {
    const server = newServer();
    const tally = server.agents.find((agent) => agent.id === "agt_tally");
    if (tally !== undefined) tally.ownerUserId = "usr_iris";
    const app = await renderApp({ path: path("agt_tally", "settings"), signedInAs: "usr_iris", server });
    expect(await screen.findByText(/As its owner you change/)).toBeDefined();
    expect((screen.getByLabelText("Name") as HTMLInputElement).readOnly).toBe(true);
    await app.user.click(screen.getByRole("radio", { name: "Only its owner" }));
    await app.user.click(screen.getByRole("button", { name: "Save settings" }));
    expect(await screen.findByText("Settings saved")).toBeDefined();
    expect(agentIn(app, "agt_tally").audience.mode).toBe("owner");
    const sent = server.calls.filter((call) => call.method === "updateAgent").at(-1)?.params ?? {};
    expect(Object.keys(sent).sort()).toEqual(["agentId", "appearance", "audience", "workspaceId"]);
    expect(screen.queryByRole("button", { name: "Archive Tally" }) === null).toBe(true);
  });

  test("an admin archives an agent after confirming", async () => {
    const app = await renderApp({ path: path("agt_tally", "settings"), signedInAs: "usr_jonas" });
    await app.user.click(await screen.findByRole("button", { name: "Archive Tally" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Archive Tally?" });
    await app.user.click(within(dialog).getByRole("button", { name: "Archive Tally" }));
    await screen.findByRole("heading", { level: 1, name: "Agents" });
    expect(app.address()).toBe(BASE);
    expect(agentIn(app, "agt_tally").archivedAt === null).toBe(false);
  });
});
