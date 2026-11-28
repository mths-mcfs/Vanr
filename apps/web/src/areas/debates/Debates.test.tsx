import { describe, expect, test } from "bun:test";
import { act, screen, waitFor, within } from "@testing-library/react";
import { chooseOption, newServer, renderApp } from "../../../test/app.tsx";
import { optionsOf } from "./NewDebate.tsx";
import { usdText } from "./shared.tsx";

const WORKSPACE = "workspace_birchwood";
const LIST = `/workspace/${WORKSPACE}/debates`;

const article = (name: string) => screen.queryByRole("article", { name });

describe("the debates", () => {
  test("what needs the person and what is being argued come first, and are not listed again", async () => {
    await renderApp({ path: LIST, signedInAs: "usr_ana" });
    await screen.findByRole("heading", { level: 1, name: "Debates" });
    const you = within(screen.getByRole("region", { name: "Needs you (1)" }));
    const paper = within(you.getByRole("article", { name: "Which paper supplier do we keep?" }));
    expect(paper.getByText("Your turn")).toBeDefined();
    expect(paper.getByText("Round 1 of 2")).toBeDefined();
    expect(paper.getByText("Ana Beatriz Souza, waited on")).toBeDefined();
    const live = within(screen.getByRole("region", { name: "Being argued now (1)" }));
    const ink = within(live.getByRole("article", { name: "Should we switch to refillable ink?" }));
    expect(ink.getByText("Opening answers, still sealed")).toBeDefined();
    expect(ink.getByText("Tally, thinking")).toBeDefined();
    const rest = within(screen.getByRole("list", { name: "Everything else" }));
    expect(rest.getByText("Stuck on Ledger: The model did not answer")).toBeDefined();
    expect(rest.queryByRole("article", { name: "Which paper supplier do we keep?" }) === null).toBe(true);
    // A finished debate is not in the ongoing view.
    expect(article("Which logo goes on the new sign?") === null).toBe(true);
  });

  test("the views and the search list one result without groups", async () => {
    const app = await renderApp({ path: LIST, signedInAs: "usr_ana" });
    await app.user.click(await screen.findByRole("tab", { name: "Finished" }));
    const logo = within(await screen.findByRole("article", { name: "Which logo goes on the new sign?" }));
    expect(logo.getByText("Concluded")).toBeDefined();
    expect(article("Should we switch to refillable ink?") === null).toBe(true);
    expect(screen.queryByRole("region", { name: "Needs you (1)" }) === null).toBe(true);

    await app.user.click(screen.getByRole("tab", { name: "Ongoing" }));
    // A participant's name finds the debates they sit at.
    await app.user.type(screen.getByRole("searchbox", { name: "Find a debate" }), "tally");
    await waitFor(() => expect(article("Which paper supplier do we keep?") === null).toBe(true));
    expect(screen.getByRole("article", { name: "Should we switch to refillable ink?" })).toBeDefined();
    await app.user.type(screen.getByRole("searchbox", { name: "Find a debate" }), "zzz");
    expect(await screen.findByText("Nothing matches. Clear the search or pick another view.")).toBeDefined();
  });

  test("yours: the debates the person opened or sits at", async () => {
    const app = await renderApp({ path: LIST, signedInAs: "usr_ana" });
    await app.user.click(await screen.findByRole("tab", { name: "Yours" }));
    await screen.findByRole("article", { name: "Which logo goes on the new sign?" });
    expect(screen.getByRole("article", { name: "Which paper supplier do we keep?" })).toBeDefined();
    expect(article("Do we open on Saturdays?") === null).toBe(true);
  });

  test("a debate in a channel the person doesn't read is not there, nor counted", async () => {
    const server = newServer();
    server.state.channels.push({
      id: "ch_board",
      workspaceId: WORKSPACE,
      name: "board",
      topic: "",
      isGeneral: false,
      visibility: "private",
      budgetPerMonthUsd: null,
      createdAt: "2026-11-01T00:00:00.000Z",
      memberIds: ["usr_ana"],
    });
    server.debates.debates.push(
      server.debates.make(WORKSPACE, {
        id: "deb_board",
        title: "Do we sell the shop?",
        channelId: "ch_board",
        agentIds: ["agt_scout"],
        status: "done",
        phase: null,
        createdBy: { type: "person", id: "usr_ana" },
        requesterUserId: "usr_ana",
      }),
    );
    const app = await renderApp({ path: LIST, signedInAs: "usr_iris", server });
    await app.user.click(await screen.findByRole("tab", { name: "Finished" }));
    await screen.findByRole("article", { name: "Which logo goes on the new sign?" });
    expect(article("Do we sell the shop?") === null).toBe(true);
    await app.user.click(screen.getByText("How debates went in the last 90 days"));
    const figures = await screen.findByText("Concluded", { selector: "dt" });
    expect(figures.nextElementSibling?.textContent).toBe("1");
  });

  test("the numbers show spend only to who may see it", async () => {
    const asOwner = await renderApp({ path: LIST, signedInAs: "usr_ana" });
    await asOwner.user.click(await screen.findByText("How debates went in the last 90 days"));
    expect(await screen.findByText("Average cost per debate")).toBeDefined();
    expect(screen.getByText("$0.0123")).toBeDefined();
    asOwner.unmount();

    const asMember = await renderApp({ path: LIST, signedInAs: "usr_iris" });
    await asMember.user.click(await screen.findByText("How debates went in the last 90 days"));
    await screen.findByText("Verdict accepted");
    expect(screen.queryByText("Average cost per debate") === null).toBe(true);
  });

  test("the numbers that did not load say so and load on retry", async () => {
    const server = newServer();
    server.force("listDebateMetrics", { kind: "error", status: 503, code: "unavailable" }, 4);
    const app = await renderApp({ path: LIST, signedInAs: "usr_ana", server });
    await app.user.click(await screen.findByText("How debates went in the last 90 days"));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent?.includes("The numbers could not be loaded")).toBe(true);
    await app.user.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Verdict accepted")).toBeDefined();
  });

  test("no debates yet: an invitation to start one", async () => {
    const server = newServer();
    server.debates.debates = [];
    await renderApp({ path: LIST, signedInAs: "usr_ana", server });
    expect(await screen.findByText("No debates yet")).toBeDefined();
    expect(screen.getAllByRole("button", { name: "Start a debate" }).length).toBeGreaterThan(0);
  });

  test("a list that did not load says so and loads on retry", async () => {
    const server = newServer();
    server.force("listDebates", { kind: "error", status: 503, code: "unavailable" }, 4);
    const app = await renderApp({ path: LIST, signedInAs: "usr_ana", server });
    expect(await screen.findByText("The debates could not be loaded")).toBeDefined();
    await app.user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("article", { name: "Which paper supplier do we keep?" })).toBeDefined();
  });

  test("a debate that changes elsewhere shows here without a reload", async () => {
    const app = await renderApp({ path: LIST, signedInAs: "usr_ana" });
    await screen.findByRole("article", { name: "Should we switch to refillable ink?" });
    const ink = app.server.debates.debates.find((row) => row.id === "deb_ink");
    if (ink === undefined) throw new Error("the seed has no ink debate");
    Object.assign(ink, {
      status: "stalled",
      phase: null,
      stallInfo: { agentId: "agt_tally", reason: "Out of time", round: 0 },
    });
    await act(async () => app.server.emit(WORKSPACE, { type: "debate.updated", debateId: "deb_ink" }));
    expect(await screen.findByText("Stuck on Tally: Out of time")).toBeDefined();
  });
});

describe("starting a debate", () => {
  test("two agents and a person, in the order picked, then the debate's page", async () => {
    const app = await renderApp({ path: LIST, signedInAs: "usr_ana" });
    await app.user.click(await screen.findByRole("button", { name: "Start a debate" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Start a debate" }));
    expect(dialog.getByText("Pick an agent to see what this can cost.")).toBeDefined();
    await app.user.type(dialog.getByRole("textbox", { name: /^Question/ }), "Do we print on recycled paper?");
    await app.user.click(await dialog.findByRole("checkbox", { name: "Tally" }));
    await app.user.click(dialog.getByRole("checkbox", { name: "Scout" }));
    expect(dialog.getByRole("checkbox", { name: "1. Tally" })).toBeDefined();
    expect(dialog.getByRole("checkbox", { name: "2. Scout" })).toBeDefined();
    await app.user.click(dialog.getByRole("checkbox", { name: "Íris Valença" }));
    expect(dialog.getByRole("checkbox", { name: "3. Íris Valença" })).toBeDefined();
    await chooseOption(app, dialog.getByRole("combobox", { name: "Rounds of challenge" }), "2 rounds");
    // The owner sees the ceiling in dollars: 2 agents × 3 rounds + the synthesis.
    expect(await dialog.findByText("At most 7 model calls, up to $0.2975")).toBeDefined();
    await app.user.click(dialog.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(app.address().startsWith(`/workspace/${WORKSPACE}/debates/deb`)).toBe(true));
    const made = app.server.debates.debates.at(-1);
    expect(made?.title).toBe("Do we print on recycled paper?");
    // A blank goal is the question.
    expect(made?.goal).toBe("Do we print on recycled paper?");
    expect(made?.roundLimit).toBe(2);
    expect(made?.speakers).toEqual([
      { type: "agent", id: "agt_tally" },
      { type: "agent", id: "agt_scout" },
      { type: "person", id: "usr_iris" },
    ]);
    expect(made?.userIds).toEqual(["usr_iris"]);
  });

  test("a member sees how many calls it can take, never the money", async () => {
    const app = await renderApp({ path: LIST, signedInAs: "usr_iris" });
    await app.user.click(await screen.findByRole("button", { name: "Start a debate" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Start a debate" }));
    await app.user.click(await dialog.findByRole("checkbox", { name: "Scout" }));
    expect(await dialog.findByText("At most 3 model calls")).toBeDefined();
    expect(dialog.queryByText(/\$/) === null).toBe(true);
  });

  test("wrong answers, cap and deadline hold the form, and say why", async () => {
    const app = await renderApp({ path: LIST, signedInAs: "usr_ana" });
    await app.user.click(await screen.findByRole("button", { name: "Start a debate" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Start a debate" }));
    const start = dialog.getByRole("button", { name: "Start" });
    await app.user.type(dialog.getByRole("textbox", { name: /^Question/ }), "Which printer first?");
    await app.user.click(await dialog.findByRole("checkbox", { name: "Scout" }));
    expect(start.hasAttribute("disabled")).toBe(false);

    await app.user.type(dialog.getByRole("textbox", { name: "Possible answers" }), "Laser\n Laser \n");
    expect(dialog.getByText("Give at least 2 and at most 8 different answers, or none.")).toBeDefined();
    expect(start.hasAttribute("disabled")).toBe(true);
    await app.user.type(dialog.getByRole("textbox", { name: "Possible answers" }), "\nInkjet");
    expect(start.hasAttribute("disabled")).toBe(false);

    await app.user.type(dialog.getByRole("textbox", { name: "Spending cap (%)" }), "250");
    expect(dialog.getByText("Use a number from 0.1 to 100.")).toBeDefined();
    expect(start.hasAttribute("disabled")).toBe(true);
    await app.user.clear(dialog.getByRole("textbox", { name: "Spending cap (%)" }));

    const deadline = dialog.getByLabelText("Deadline");
    await app.user.type(deadline, "2020-01-01T10:00");
    expect(dialog.getByText("Pick a moment in the future.")).toBeDefined();
    expect(start.hasAttribute("disabled")).toBe(true);
  });

  test("a refused start stays in the form with the server's reason", async () => {
    const server = newServer();
    server.force("createDebate", { kind: "error", status: 403, code: "agent.personal_plan" }, 1);
    const app = await renderApp({ path: LIST, signedInAs: "usr_ana", server });
    await app.user.click(await screen.findByRole("button", { name: "Start a debate" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Start a debate" }));
    await app.user.type(dialog.getByRole("textbox", { name: /^Question/ }), "Which printer first?");
    await app.user.click(await dialog.findByRole("checkbox", { name: "Scout" }));
    await app.user.click(dialog.getByRole("button", { name: "Start" }));
    expect(
      await dialog.findByText(
        "One of these agents runs on someone else's personal plan and can't join your debate.",
      ),
    ).toBeDefined();
    expect(dialog.getByRole("textbox", { name: /^Question/ })).toBeDefined();
  });

  test("no agent to seat: the form says why, and archived agents are never offered", async () => {
    const server = newServer();
    for (const agent of server.agents) agent.archivedAt = "2026-11-01T00:00:00.000Z";
    const app = await renderApp({ path: LIST, signedInAs: "usr_ana", server });
    await app.user.click(await screen.findByRole("button", { name: "Start a debate" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Start a debate" }));
    expect(await dialog.findByText(/No agent can join a debate you start/)).toBeDefined();
    expect(dialog.queryByRole("checkbox", { name: "Scout" }) === null).toBe(true);
  });

  test("the agents that did not load say so and load on retry", async () => {
    const server = newServer();
    server.force("listAgents", { kind: "error", status: 503, code: "unavailable" }, 4);
    const app = await renderApp({ path: LIST, signedInAs: "usr_ana", server });
    await app.user.click(await screen.findByRole("button", { name: "Start a debate" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Start a debate" }));
    expect(await dialog.findByText("The agents could not be loaded")).toBeDefined();
    await app.user.click(dialog.getAllByRole("button", { name: "Retry" })[0] as HTMLElement);
    expect(await dialog.findByRole("checkbox", { name: "Scout" })).toBeDefined();
  });

  test("money the server leaves out is never shown as zero", () => {
    expect(usdText(null, "en")).toBe(null);
    expect(usdText(undefined, "en")).toBe(null);
    expect(usdText(0.0123, "en")).toBe("$0.0123");
  });

  test("the answers are trimmed and repeats dropped", () => {
    expect(optionsOf(" Yes \n\nno\nYes\n")).toEqual(["Yes", "no"]);
  });
});
