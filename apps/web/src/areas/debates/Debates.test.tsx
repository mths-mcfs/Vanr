import { describe, expect, test } from "bun:test";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { chooseOption, newServer, renderApp } from "../../../test/app.tsx";
import { optionsFit, optionsOf } from "./NewDebate.tsx";
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
    // While blind, the row never says which agent got stuck: that would give away its letter.
    const hours = within(rest.getByRole("article", { name: "Do we open on Saturdays?" }));
    expect(hours.getByText("A participant is taking longer than expected")).toBeDefined();
    expect(hours.queryByText(/Stuck on/) === null).toBe(true);
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

  test("the numbers are written in the person's language, and count what moved", async () => {
    const server = newServer();
    const logo = server.debates.debates.find((row) => row.id === "deb_logo");
    if (logo === undefined) throw new Error("the seed has no logo debate");
    logo.posts = [
      server.debates.post("pst_a", 1, { type: "agent", id: "agt_ledger" }, "B", "Convinced.", {
        ...server.debates.claim("Round mark", 0.7),
        changed: true,
      }),
    ];
    for (let n = 0; n < 1233; n++)
      server.debates.debates.push(
        server.debates.make(WORKSPACE, { id: `deb_old${n}`, title: `Old ${n}`, status: "done", phase: null }),
      );
    const app = await renderApp({ path: LIST, signedInAs: "usr_ana", server });
    await app.user.click(await screen.findByText("How debates went in the last 90 days"));
    const settled = await screen.findByText("Concluded", { selector: "dt" });
    expect(settled.nextElementSibling?.textContent).toBe("1,234");
    expect(screen.getByText("1 of 1 challenged")).toBeDefined();
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
    expect(await screen.findByText("A participant is taking longer than expected")).toBeDefined();
    expect(screen.getAllByText("A participant is taking longer than expected").length).toBe(2);
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

  test("an agent that leaves the list while the form is open no longer counts", async () => {
    const app = await renderApp({ path: LIST, signedInAs: "usr_ana" });
    await app.user.click(await screen.findByRole("button", { name: "Start a debate" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Start a debate" }));
    await app.user.type(dialog.getByRole("textbox", { name: /^Question/ }), "Which printer first?");
    await app.user.click(await dialog.findByRole("checkbox", { name: "Scout" }));
    await app.user.click(dialog.getByRole("checkbox", { name: "Tally" }));
    expect(await dialog.findByText("At most 5 model calls, up to $0.2125")).toBeDefined();
    const tally = app.server.agents.find((agent) => agent.id === "agt_tally");
    if (tally === undefined) throw new Error("the seed has no Tally");
    tally.archivedAt = "2026-11-14T12:00:00.000Z";
    await act(async () =>
      app.server.emit(WORKSPACE, {
        type: "budget.cap_reached",
        agentId: "agt_tally",
        spentUsd: null,
        budgetUsd: null,
      }),
    );
    await waitFor(() => expect(dialog.queryByRole("checkbox", { name: /Tally/ }) === null).toBe(true));
    expect(dialog.getByText("Tally is no longer available and was taken off the table.")).toBeDefined();
    // Only Scout is left at the table: the ceiling and what is sent drop Tally.
    expect(await dialog.findByText("At most 3 model calls, up to $0.1275")).toBeDefined();
    // Tally coming back doesn't bring the pick back: it stays off the table until picked again.
    tally.archivedAt = null;
    await act(async () =>
      app.server.emit(WORKSPACE, {
        type: "budget.cap_reached",
        agentId: "agt_tally",
        spentUsd: null,
        budgetUsd: null,
      }),
    );
    const back = await dialog.findByRole("checkbox", { name: "Tally" });
    expect(back.getAttribute("aria-checked")).toBe("false");
    expect(dialog.getByRole("checkbox", { name: "1. Scout" })).toBeDefined();
    await app.user.click(dialog.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(app.address().startsWith(`/workspace/${WORKSPACE}/debates/deb`)).toBe(true));
    expect(app.server.debates.debates.at(-1)?.agentIds).toEqual(["agt_scout"]);
  });

  test("a pick that left the lists comes back unpicked, so the table never goes over", async () => {
    const server = newServer();
    const base = server.agents.find((agent) => agent.id === "agt_scout");
    if (base === undefined) throw new Error("the seed has no Scout");
    const names = ["Ash", "Birch", "Cedar", "Dogwood", "Elm", "Fir", "Gum"];
    for (const name of names)
      server.agents.push({ ...base, id: `agt_${name.toLowerCase()}`, name, handle: name.toLowerCase() });
    const app = await renderApp({ path: LIST, signedInAs: "usr_ana", server });
    await app.user.click(await screen.findByRole("button", { name: "Start a debate" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Start a debate" }));
    await app.user.type(dialog.getByRole("textbox", { name: /^Question/ }), "Which tree?");
    for (const name of ["Scout", ...names])
      await app.user.click(await dialog.findByRole("checkbox", { name }));
    const refresh = () =>
      act(async () =>
        app.server.emit(WORKSPACE, {
          type: "budget.cap_reached",
          agentId: "agt_scout",
          spentUsd: null,
          budgetUsd: null,
        }),
      );
    // Scout leaves while the form is open, and an eighth agent takes its place.
    base.archivedAt = "2026-11-14T12:00:00.000Z";
    await refresh();
    await waitFor(() => expect(dialog.queryByRole("checkbox", { name: /Scout/ }) === null).toBe(true));
    await app.user.click(dialog.getByRole("checkbox", { name: "Ledger" }));
    expect(dialog.getByRole("button", { name: "Start" }).hasAttribute("disabled")).toBe(false);
    // Scout comes back, but not picked: it left the table and stays off it, so the table stays at eight.
    base.archivedAt = null;
    await refresh();
    const back = await dialog.findByRole("checkbox", { name: "Scout" });
    expect(back.getAttribute("aria-checked")).toBe("false");
    expect(dialog.getByRole("button", { name: "Start" }).hasAttribute("disabled")).toBe(false);
  });

  test("a person removed from the workspace leaves the table, and the order closes up", async () => {
    const app = await renderApp({ path: LIST, signedInAs: "usr_ana" });
    await app.user.click(await screen.findByRole("button", { name: "Start a debate" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Start a debate" }));
    await app.user.type(dialog.getByRole("textbox", { name: /^Question/ }), "Which printer first?");
    await app.user.click(await dialog.findByRole("checkbox", { name: "Scout" }));
    await app.user.click(await dialog.findByRole("checkbox", { name: /Íris/ }));
    await app.user.click(await dialog.findByRole("checkbox", { name: /Tomás/ }));
    expect(dialog.getByRole("checkbox", { name: "3. Tomás Eriksen" })).toBeDefined();
    const at = app.server.state.members.findIndex(
      (m) => m.workspaceId === WORKSPACE && m.userId === "usr_iris",
    );
    app.server.state.members.splice(at, 1);
    await act(async () => {
      await app.runtime.queryClient.invalidateQueries();
    });
    await waitFor(() => expect(dialog.queryByRole("checkbox", { name: /Íris/ }) === null).toBe(true));
    expect(dialog.getByRole("checkbox", { name: "2. Tomás Eriksen" })).toBeDefined();
    expect(
      dialog.getByText("Íris Valença is no longer available and was taken off the table."),
    ).toBeDefined();
    await app.user.click(dialog.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(app.address().startsWith(`/workspace/${WORKSPACE}/debates/deb`)).toBe(true));
    const made = app.server.debates.debates.at(-1);
    expect(made?.userIds).toEqual(["usr_tomas"]);
    expect(made?.speakers).toEqual([
      { type: "agent", id: "agt_scout" },
      { type: "person", id: "usr_tomas" },
    ]);
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
    expect(
      dialog.getByText("Give 2 to 8 different answers of up to 200 characters each, or none."),
    ).toBeDefined();
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
    // Scout runs on Jonas's personal plan: only Jonas can seat it.
    server.debates.planOwners.set("agt_scout", "usr_jonas");
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
    expect(server.debates.debates.some((row) => row.title === "Which printer first?")).toBe(false);
  });

  test("two clicks on Start before the screen redraws open one debate", async () => {
    const app = await renderApp({ path: LIST, signedInAs: "usr_ana" });
    await app.user.click(await screen.findByRole("button", { name: "Start a debate" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Start a debate" }));
    await app.user.type(dialog.getByRole("textbox", { name: /^Question/ }), "Which printer first?");
    await app.user.click(await dialog.findByRole("checkbox", { name: "Scout" }));
    const start = dialog.getByRole("button", { name: "Start" });
    // Both in the same tick: the button's pending state has not reached the screen yet.
    await act(async () => {
      fireEvent.click(start);
      fireEvent.click(start);
    });
    await waitFor(() => expect(app.address().startsWith(`/workspace/${WORKSPACE}/debates/deb`)).toBe(true));
    expect(app.server.calls.filter((call) => call.method === "createDebate").length).toBe(1);
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

  test("the answers are trimmed and repeats dropped, and a long one is refused, never cut", () => {
    expect(optionsOf(" Yes \n\nno\nYes\n")).toEqual(["Yes", "no"]);
    const long = "a".repeat(201);
    expect(optionsOf(`Yes\n${long}`)).toEqual(["Yes", long]);
    expect(optionsFit(["Yes", long])).toBe(false);
    expect(optionsFit(["Yes", "a".repeat(200)])).toBe(true);
    expect(optionsFit([])).toBe(true);
    expect(optionsFit(["Yes"])).toBe(false);
    // Counted as the server counts, in characters: an emoji is one, never half of one.
    expect(optionsFit(["Yes", `${"a".repeat(199)}😀😀`])).toBe(false);
    expect(optionsFit(["Yes", "😀".repeat(150)])).toBe(true);
  });

  test("a new table's cost never shows the last table's figure while it loads", async () => {
    const server = newServer();
    const app = await renderApp({ path: LIST, signedInAs: "usr_ana", server });
    await app.user.click(await screen.findByRole("button", { name: "Start a debate" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Start a debate" }));
    await app.user.click(await dialog.findByRole("checkbox", { name: "Scout" }));
    expect(await dialog.findByText("At most 3 model calls, up to $0.1275")).toBeDefined();
    const held = server.hold("estimateDebate");
    await app.user.click(dialog.getByRole("checkbox", { name: "Tally" }));
    expect(await dialog.findByText("Working out the cost…")).toBeDefined();
    expect(dialog.queryByText("At most 3 model calls, up to $0.1275") === null).toBe(true);
    held.release();
    expect(await dialog.findByText("At most 5 model calls, up to $0.2125")).toBeDefined();
  });
});

describe("the fake follows the server", () => {
  const server = newServer();
  const ops = server.debates.operations();
  const as = (userId: string) => server.sessionFor(userId);
  /** Calls one of the fake's operations directly, as the person. */
  const call = (name: string, params: Record<string, unknown>, userId = "usr_ana") => {
    const operation = ops[name];
    if (operation === undefined) throw new Error(`the fake has no ${name}`);
    return operation({ workspaceId: WORKSPACE, ...params }, as(userId));
  };
  const open = (body: Record<string, unknown>, userId = "usr_ana") =>
    call("createDebate", { title: "Q", goal: "G", agentIds: ["agt_scout"], ...body }, userId);

  test("a speaker who isn't an agent or member of the workspace is refused", () => {
    expect(open({ speakers: [{ type: "agent", id: "agt_fjell" }] }).status).toBe(404);
    expect(open({ speakers: [{ type: "person", id: "usr_noor" }] }).status).toBe(404);
  });

  test("whoever holds a speaker slot takes part, and so sees the debate", () => {
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
    const made = open({ channelId: "ch_board", speakers: [{ type: "person", id: "usr_iris" }] });
    expect(made.status).toBe(201);
    const id = (made.body as { id: string }).id;
    expect(call("getDebate", { debateId: id }, "usr_iris").status).toBe(200);
    expect(call("getDebate", { debateId: id }, "usr_tomas").status).toBe(404);
  });

  test("more than 20 speaker slots are refused", () => {
    const slots = Array.from({ length: 21 }, () => ({ type: "agent", id: "agt_scout" }));
    expect(open({ speakers: slots }).status).toBe(400);
  });

  test("a debate from an issue of a private channel stays in that channel", () => {
    server.state.channels.push({
      id: "ch_back",
      workspaceId: WORKSPACE,
      name: "back-office",
      topic: "",
      isGeneral: false,
      visibility: "private",
      budgetPerMonthUsd: null,
      createdAt: "2026-11-01T00:00:00.000Z",
      memberIds: ["usr_ana"],
    });
    const issue = server.work.issues[0];
    if (issue === undefined) throw new Error("the seed has no issue");
    issue.channelId = "ch_back";
    const made = open({ sourceIssueId: issue.id });
    expect(made.status).toBe(201);
    expect((made.body as { channelId: string }).channelId).toBe("ch_back");
    expect(open({ sourceIssueId: issue.id, channelId: "ch_general" }).status).toBe(400);
    // Someone who doesn't read the channel can't open a debate from its issue.
    expect(open({ sourceIssueId: issue.id }, "usr_iris").status).toBe(404);
  });

  test("an archived agent adds nothing to the estimate", () => {
    const ledger = server.agents.find((agent) => agent.id === "agt_ledger");
    if (ledger === undefined) throw new Error("the seed has no Ledger");
    ledger.archivedAt = "2026-11-01T00:00:00.000Z";
    const answer = call("estimateDebate", { agentIds: "agt_scout,agt_ledger", rounds: "1" });
    expect((answer.body as { calls: number }).calls).toBe(3);
  });

  test("spend goes only to who may see usage", () => {
    const read = (userId: string) =>
      (call("getDebate", { debateId: "deb_logo" }, userId).body as { spentUsd: number | null }).spentUsd;
    expect(read("usr_ana")).toBe(0.0123);
    expect(read("usr_iris")).toBe(null);
    const mean = (userId: string) =>
      (call("listDebateMetrics", { days: "90" }, userId).body as { meanCostUsd: number | null }).meanCostUsd;
    expect(mean("usr_iris")).toBe(null);
    expect(typeof mean("usr_ana")).toBe("number");
  });

  test("a turn can't be skipped while the synthesis is being written", () => {
    const paper = server.debates.debates.find((row) => row.id === "deb_paper");
    if (paper === undefined) throw new Error("the seed has no paper debate");
    paper.phase = "concluding";
    expect(call("skipDebate", { debateId: "deb_paper" }).status).toBe(409);
  });

  test("a step longer than the server takes is refused", () => {
    const long = "a".repeat(301);
    expect(call("createDebateIssue", { debateId: "deb_logo", items: [{ title: long }] }).status).toBe(400);
    expect(call("createDebateIssue", { debateId: "deb_logo", items: [] }).status).toBe(400);
  });

  test("each issue is linked to the debate as soon as it is made", () => {
    const logo = server.debates.debates.find((row) => row.id === "deb_logo");
    if (logo === undefined) throw new Error("the seed has no logo debate");
    expect(logo.format).toBe("plan");
    const before = logo.issues.length;
    // The second title passes the debate's count (code points) but not the issue store's (UTF-16 units).
    const answer = call("createDebateIssue", {
      debateId: "deb_logo",
      items: [{ title: "Book the sign maker" }, { title: "😀".repeat(151) }],
    });
    expect(answer.status).toBe(400);
    expect(logo.issues.length).toBe(before + 1);
    expect(logo.issues.at(-1)?.title).toBe("Book the sign maker");
  });

  test("a round's majority groups answers by their key, as the server does", () => {
    const paper = server.debates.debates.find((row) => row.id === "deb_paper");
    if (paper === undefined) throw new Error("the seed has no paper debate");
    paper.posts.push(
      server.debates.post(
        "pst_k1",
        2,
        { type: "person", id: "usr_ana" },
        null,
        "A",
        server.debates.claim("Yes", null),
      ),
      server.debates.post(
        "pst_k2",
        2,
        { type: "person", id: "usr_jonas" },
        null,
        "B",
        server.debates.claim("yes", null),
      ),
      server.debates.post(
        "pst_k3",
        2,
        { type: "agent", id: "agt_scout" },
        "A",
        "C",
        server.debates.claim("No", null),
      ),
    );
    const majority = server.debates.roundMajority(paper, ["pst_k1", "pst_k2", "pst_k3"]);
    expect(majority?.winner).toBe("Yes");
    expect(majority?.groups.map((group) => [group.answer, group.count])).toEqual([
      ["Yes", 2],
      ["No", 1],
    ]);
  });
});
