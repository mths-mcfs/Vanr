import { describe, expect, test } from "bun:test";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { chooseOption, newServer, renderApp } from "../../../test/app.tsx";
import { fit, issueItem } from "./Outcome.tsx";
import { stalledBy } from "./shared.tsx";

const WORKSPACE = "workspace_birchwood";
const PAGE = (id: string) => `/workspace/${WORKSPACE}/debates/${id}`;

const grid = () => within(screen.getByRole("table"));

describe("an open debate", () => {
  test("agents show only by their letter, the round's majority, and what is sealed", async () => {
    await renderApp({ path: PAGE("deb_paper"), signedInAs: "usr_ana" });
    await screen.findByRole("heading", { level: 1, name: "Which paper supplier do we keep?" });
    expect(grid().getByRole("rowheader", { name: "Participant A" })).toBeDefined();
    expect(grid().getByRole("rowheader", { name: "Participant B" })).toBeDefined();
    expect(grid().getByRole("rowheader", { name: "Ana Beatriz Souza" })).toBeDefined();
    // The agents come first, in letter order, then the people.
    expect(
      grid()
        .getAllByRole("rowheader")
        .map((cell) => cell.textContent),
    ).toEqual(["Participant A", "Participant B", "Ana Beatriz Souza", "Majority"]);
    // No agent's name is put on a position while the debate runs.
    expect(grid().queryByText("Scout") === null).toBe(true);
    expect(grid().queryByText("Ledger") === null).toBe(true);
    expect(grid().getByText("Northpaper: 2 of 3")).toBeDefined();
    expect(grid().getByText("80% sure")).toBeDefined();
    expect(screen.getByText(/agents speak under a letter/)).toBeDefined();
    expect(screen.getByText("1 answer is sealed until everyone in this round has answered.")).toBeDefined();
  });

  test("on their turn the person gives an answer, how sure they are and why", async () => {
    const app = await renderApp({ path: PAGE("deb_paper"), signedInAs: "usr_ana" });
    const turn = within(await screen.findByRole("region", { name: "It's your turn" }));
    await chooseOption(app, turn.getByRole("combobox", { name: "Your answer" }), "Mill & Co");
    await chooseOption(app, turn.getByRole("combobox", { name: "How sure are you?" }), "60%");
    await app.user.type(turn.getByRole("textbox", { name: "Your argument" }), "Cheaper wins this quarter.");
    await app.user.click(turn.getByRole("button", { name: "Give my position" }));
    expect(await screen.findByText("Your position is in")).toBeDefined();
    const call = app.server.calls.filter((each) => each.method === "createDebatePost").at(-1);
    expect(call?.params).toMatchObject({
      body: "Cheaper wins this quarter.",
      answer: "Mill & Co",
      confidence: 0.6,
    });
    // The turn is over: what is left is a comment, which never counts as a position.
    expect(await screen.findByRole("region", { name: "Add a comment" })).toBeDefined();
    expect(screen.getByText("2 answers are sealed until everyone in this round has answered.")).toBeDefined();
  });

  test("a sealed position shows once the round closes", async () => {
    const server = newServer();
    const asAna = await renderApp({ path: PAGE("deb_paper"), signedInAs: "usr_ana", server });
    const turn = within(await screen.findByRole("region", { name: "It's your turn" }));
    await asAna.user.type(turn.getByRole("textbox", { name: "Your argument" }), "Speed beats price.");
    await asAna.user.click(turn.getByRole("button", { name: "Give my position" }));
    expect(await screen.findByText("Your position is in")).toBeDefined();
    // Sealed: counted, not shown.
    expect(screen.queryByText("Speed beats price.") === null).toBe(true);
    asAna.unmount();

    const asJonas = await renderApp({ path: PAGE("deb_paper"), signedInAs: "usr_jonas", server });
    await asJonas.user.click(await screen.findByRole("button", { name: "Conclude now" }));
    await screen.findByRole("region", { name: "Synthesis" });
    expect(await screen.findByText("Speed beats price.")).toBeDefined();
  });

  test("skipping the turn", async () => {
    const app = await renderApp({ path: PAGE("deb_paper"), signedInAs: "usr_ana" });
    const turn = within(await screen.findByRole("region", { name: "It's your turn" }));
    await app.user.click(turn.getByRole("button", { name: "Skip my turn" }));
    expect(await screen.findByText("You skipped this round")).toBeDefined();
    await waitFor(() => expect(screen.queryByRole("region", { name: "It's your turn" }) === null).toBe(true));
  });

  test("a turn that moved on keeps the draft and says so", async () => {
    const server = newServer();
    server.force("createDebatePost", { kind: "error", status: 409, code: "debate.turn_changed" }, 1);
    const app = await renderApp({ path: PAGE("deb_paper"), signedInAs: "usr_ana", server });
    const turn = within(await screen.findByRole("region", { name: "It's your turn" }));
    await app.user.type(turn.getByRole("textbox", { name: "Your argument" }), "Faster wins.");
    await app.user.click(turn.getByRole("button", { name: "Give my position" }));
    expect(await screen.findByText(/The turn moved on while you were writing/)).toBeDefined();
    expect((turn.getByRole("textbox", { name: "Your argument" }) as HTMLTextAreaElement).value).toBe(
      "Faster wins.",
    );
  });

  test("someone outside the table comments, and doesn't steer", async () => {
    const app = await renderApp({ path: PAGE("deb_paper"), signedInAs: "usr_iris" });
    const box = within(await screen.findByRole("region", { name: "Add a comment" }));
    expect(screen.queryByRole("button", { name: "Conclude now" }) === null).toBe(true);
    expect(screen.queryByRole("button", { name: "Cancel debate" }) === null).toBe(true);
    await app.user.type(box.getByRole("textbox", { name: "Add a comment" }), "Ask the print room too.");
    await app.user.click(box.getByRole("button", { name: "Comment" }));
    expect(await screen.findByText("Comment posted")).toBeDefined();
    expect(await screen.findByText("Ask the print room too.")).toBeDefined();
    // Commenting makes her take part, so she keeps reading it wherever it lives.
    expect(app.server.debates.debates.find((row) => row.id === "deb_paper")?.userIds).toContain("usr_iris");
  });

  test("who opened it concludes it, and the synthesis follows", async () => {
    const app = await renderApp({ path: PAGE("deb_paper"), signedInAs: "usr_jonas" });
    await app.user.click(await screen.findByRole("button", { name: "Conclude now" }));
    const synthesis = within(await screen.findByRole("region", { name: "Synthesis" }));
    expect(synthesis.getByText("The table settled on Northpaper.")).toBeDefined();
    expect(screen.getByText("It was concluded by hand.")).toBeDefined();
    // Closed, so revealed: the letters give way to names.
    expect(await screen.findByRole("rowheader", { name: /^Scout/ })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Conclude now" }) === null).toBe(true);
    expect(app.server.debates.debates.find((row) => row.id === "deb_paper")?.status).toBe("done");
  });

  test("cancelling asks first, then closes the debate", async () => {
    const app = await renderApp({ path: PAGE("deb_paper"), signedInAs: "usr_jonas" });
    await app.user.click(await screen.findByRole("button", { name: "Cancel debate" }));
    const dialog = within(await screen.findByRole("alertdialog", { name: "Cancel this debate?" }));
    await app.user.click(dialog.getByRole("button", { name: "Keep it going" }));
    expect(app.server.debates.debates.find((row) => row.id === "deb_paper")?.status).toBe("open");
    await app.user.click(screen.getByRole("button", { name: "Cancel debate" }));
    const again = within(await screen.findByRole("alertdialog", { name: "Cancel this debate?" }));
    await app.user.click(again.getByRole("button", { name: "Cancel debate" }));
    expect(await screen.findByText("The debate was canceled")).toBeDefined();
    expect(await screen.findByText("This debate is closed. Nothing more can be posted.")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Conclude now" }) === null).toBe(true);
    // A canceled debate is no longer blind: who said what shows.
    expect(await screen.findByRole("rowheader", { name: /^Scout/ })).toBeDefined();
    expect(screen.queryByRole("rowheader", { name: "Participant A" }) === null).toBe(true);
  });

  test("a new post from elsewhere shows without a reload", async () => {
    const app = await renderApp({ path: PAGE("deb_paper"), signedInAs: "usr_ana" });
    await screen.findByRole("table");
    const paper = app.server.debates.debates.find((row) => row.id === "deb_paper");
    if (paper === undefined) throw new Error("the seed has no paper debate");
    paper.posts.push(
      app.server.debates.post(
        "pst_new",
        1,
        { type: "person", id: "usr_jonas" },
        null,
        "Price matters most.",
        null,
        "comment",
      ),
    );
    await act(async () => app.server.emit(WORKSPACE, { type: "debate.post_created", debateId: "deb_paper" }));
    expect(await screen.findByText("Price matters most.")).toBeDefined();
  });
});

describe("an action starts once, however fast the clicks", () => {
  const twice = async (button: HTMLElement) =>
    act(async () => {
      fireEvent.click(button);
      fireEvent.click(button);
    });
  const callsOf = (app: { server: { calls: { method: string }[] } }, method: string) =>
    app.server.calls.filter((call) => call.method === method).length;

  test("a position", async () => {
    const app = await renderApp({ path: PAGE("deb_paper"), signedInAs: "usr_ana" });
    const turn = within(await screen.findByRole("region", { name: "It's your turn" }));
    await app.user.type(turn.getByRole("textbox", { name: "Your argument" }), "Faster wins.");
    await twice(turn.getByRole("button", { name: "Give my position" }));
    expect(await screen.findByText("Your position is in")).toBeDefined();
    expect(callsOf(app, "createDebatePost")).toBe(1);
  });

  test("skipping, concluding and the verdict", async () => {
    const asMember = await renderApp({ path: PAGE("deb_paper"), signedInAs: "usr_ana" });
    await twice(await screen.findByRole("button", { name: "Skip my turn" }));
    expect(await screen.findByText("You skipped this round")).toBeDefined();
    expect(callsOf(asMember, "skipDebate")).toBe(1);
    asMember.unmount();

    const asOpener = await renderApp({ path: PAGE("deb_paper"), signedInAs: "usr_jonas" });
    await twice(await screen.findByRole("button", { name: "Conclude now" }));
    expect(await screen.findByText("Concluding: the synthesis comes next")).toBeDefined();
    expect(callsOf(asOpener, "concludeDebate")).toBe(1);
    asOpener.unmount();

    const asOwner = await renderApp({ path: PAGE("deb_logo"), signedInAs: "usr_ana" });
    await twice(await screen.findByRole("button", { name: "Revert the verdict" }));
    expect(await screen.findByText(/^Reverted by/)).toBeDefined();
    expect(callsOf(asOwner, "setDebateVerdict")).toBe(1);
  });

  test("steps into issues: a click while the debate reloads makes nothing twice", async () => {
    const app = await renderApp({ path: PAGE("deb_logo"), signedInAs: "usr_ana" });
    const synthesis = within(await screen.findByRole("region", { name: "Synthesis" }));
    const button = synthesis.getByRole("button", { name: "Turn 2 steps into issues" });
    // The reload after the issues are made answers late, as on a slow network.
    const late = app.server.delay("getDebate");
    await app.user.click(button);
    expect(await screen.findByText("2 issues created")).toBeDefined();
    await act(async () => {
      fireEvent.click(button);
    });
    late.release();
    await waitFor(() =>
      expect(synthesis.queryByRole("button", { name: /into issues?/ }) === null).toBe(true),
    );
    expect(callsOf(app, "createDebateIssue")).toBe(1);
    expect(app.server.debates.debates.find((row) => row.id === "deb_logo")?.issues.length).toBe(2);
  });

  test("steps into issues: after a failed batch, a retry sends only what wasn't made", async () => {
    const server = newServer();
    const logo = server.debates.debates.find((row) => row.id === "deb_logo");
    if (logo?.synthesis == null) throw new Error("the seed has no logo synthesis");
    logo.synthesis.structured.items = Array.from({ length: 31 }, (_, n) => ({ title: `Step ${n + 1}` }));
    // The second batch (the 31st step alone) fails once.
    server.force(
      "createDebateIssue",
      { kind: "error", status: 503, code: "unavailable" },
      1,
      (params) => Array.isArray(params.items) && params.items.length === 1,
    );
    const app = await renderApp({ path: PAGE("deb_logo"), signedInAs: "usr_ana", server });
    const synthesis = within(await screen.findByRole("region", { name: "Synthesis" }));
    // The reload after the batches fails too, so the page can't learn from the server what was made.
    server.force("getDebate", { kind: "error", status: 503, code: "unavailable" }, 50);
    await app.user.click(synthesis.getByRole("button", { name: "Turn 31 steps into issues" }));
    const retry = await synthesis.findByRole("button", { name: "Turn 1 step into an issue" });
    await app.user.click(retry);
    expect(await screen.findByText("1 issue created")).toBeDefined();
    const sent = app.server.calls
      .filter((call) => call.method === "createDebateIssue")
      .map((call) => (call.params.items as { title: string }[]).map((item) => item.title));
    expect(sent.map((items) => items.length)).toEqual([30, 1, 1]);
    expect(sent[2]).toEqual(["Step 31"]);
    expect(logo.issues.length).toBe(31);
  });

  test("a comment typed while the last one was sending stays", async () => {
    const app = await renderApp({ path: PAGE("deb_paper"), signedInAs: "usr_iris" });
    const box = within(await screen.findByRole("region", { name: "Add a comment" }));
    const field = box.getByRole("textbox", { name: "Add a comment" }) as HTMLTextAreaElement;
    await app.user.type(field, "First thought.");
    const held = app.server.hold("createDebatePost");
    await app.user.click(box.getByRole("button", { name: "Comment" }));
    await app.user.type(field, " And another.");
    held.release();
    expect(await screen.findByText("Comment posted")).toBeDefined();
    expect(field.value).toBe("First thought. And another.");
  });

  test("steps into issues: each one is made once", async () => {
    const app = await renderApp({ path: PAGE("deb_logo"), signedInAs: "usr_ana" });
    const synthesis = within(await screen.findByRole("region", { name: "Synthesis" }));
    await twice(synthesis.getByRole("button", { name: "Turn 2 steps into issues" }));
    expect(await screen.findByText("2 issues created")).toBeDefined();
    expect(callsOf(app, "createDebateIssue")).toBe(1);
    expect(app.server.debates.debates.find((row) => row.id === "deb_logo")?.issues.length).toBe(2);
  });
});

describe("a stuck debate", () => {
  test("who opened it can also conclude it from there", async () => {
    const app = await renderApp({ path: PAGE("deb_hours"), signedInAs: "usr_iris" });
    const conclude = await screen.findByRole("button", { name: "Conclude now" });
    expect(conclude.hasAttribute("disabled")).toBe(false);
    await app.user.click(conclude);
    expect(await screen.findByRole("region", { name: "Synthesis" })).toBeDefined();
  });

  test("who opened it tries again; anyone else only reads why", async () => {
    const asOpener = await renderApp({ path: PAGE("deb_hours"), signedInAs: "usr_iris" });
    // Still blind: the page never says which agent got stuck, as that would give away its letter.
    expect(await screen.findByText("A participant is taking longer than expected in round 1.")).toBeDefined();
    expect(screen.queryByText(/Stuck on/) === null).toBe(true);
    await asOpener.user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("The debate picked up again")).toBeDefined();
    // Nobody was left to answer in the round: it goes on to the synthesis.
    expect(await screen.findByRole("region", { name: "Synthesis" })).toBeDefined();
    asOpener.unmount();

    const server = newServer();
    await renderApp({ path: PAGE("deb_hours"), signedInAs: "usr_tomas", server });
    await screen.findByText("A participant is taking longer than expected in round 1.");
    expect(screen.queryByRole("button", { name: "Try again" }) === null).toBe(true);
  });
});

describe("a concluded debate", () => {
  test("names are revealed beside their letters, and a change says why", async () => {
    await renderApp({ path: PAGE("deb_logo"), signedInAs: "usr_ana" });
    await screen.findByRole("heading", { level: 1, name: "Which logo goes on the new sign?" });
    const scout = grid().getByRole("rowheader", { name: /^Scout/ });
    expect(within(scout).getByText("A")).toBeDefined();
    expect(grid().getByText("Changed: It reads from across the road")).toBeDefined();
    expect(grid().getByText("Round mark: 2 of 2")).toBeDefined();
    expect(screen.getByText("It stopped because everyone agreed.")).toBeDefined();
  });

  test("the synthesis, its open points and the vote before and after", async () => {
    await renderApp({ path: PAGE("deb_logo"), signedInAs: "usr_iris" });
    const synthesis = within(await screen.findByRole("region", { name: "Synthesis" }));
    expect(synthesis.getByText("Use the round mark on the sign.")).toBeDefined();
    expect(synthesis.getByText("It reads at any size")).toBeDefined();
    expect(synthesis.getByText("would have to show: that it shows at night")).toBeDefined();
    expect(synthesis.getByText("Split, Round mark 1, Wordmark 1")).toBeDefined();
    // Iris didn't open it: no steps to turn into issues, no verdict buttons.
    expect(synthesis.queryByRole("button", { name: /into issues?/ }) === null).toBe(true);
    expect(screen.queryByRole("button", { name: "Revert the verdict" }) === null).toBe(true);
    expect(screen.getByText(/^Accepted by Ana Beatriz Souza/)).toBeDefined();
  });

  test("who steers it turns steps into issues, and they aren't offered again", async () => {
    const app = await renderApp({ path: PAGE("deb_logo"), signedInAs: "usr_ana" });
    const synthesis = within(await screen.findByRole("region", { name: "Synthesis" }));
    expect(synthesis.getByRole("checkbox", { name: "Order the sign (for Scout)" })).toBeDefined();
    await app.user.click(synthesis.getByRole("checkbox", { name: "Tell the landlord" }));
    await app.user.click(synthesis.getByRole("button", { name: "Turn 1 step into an issue" }));
    expect(await screen.findByText("1 issue created")).toBeDefined();
    expect(await synthesis.findByRole("link", { name: /^#\d+ Order the sign$/ })).toBeDefined();
    // The issue was really made, where the debate lives.
    const made = app.server.work.issues.find((issue) => issue.title === "Order the sign");
    expect(made?.channelId ?? null).toBe(null);
    expect(synthesis.queryByRole("checkbox", { name: "Order the sign (for Scout)" }) === null).toBe(true);
    expect(synthesis.getByRole("checkbox", { name: "Tell the landlord" })).toBeDefined();
  });

  test("the verdict is reverted by who steers it", async () => {
    const app = await renderApp({ path: PAGE("deb_logo"), signedInAs: "usr_ana" });
    await app.user.click(await screen.findByRole("button", { name: "Revert the verdict" }));
    expect(await screen.findByText(/^Reverted by Ana Beatriz Souza/)).toBeDefined();
    // A reverted verdict can be accepted again, as the server allows.
    await app.user.click(await screen.findByRole("button", { name: "Accept the verdict" }));
    expect(await screen.findByText(/^Accepted by Ana Beatriz Souza/)).toBeDefined();
  });

  test("the blind read draws a pair once opened and keeps the pick", async () => {
    const app = await renderApp({ path: PAGE("deb_logo"), signedInAs: "usr_iris" });
    await app.user.click(await screen.findByText("Read it blind"));
    const first = within(await screen.findByRole("article", { name: "First" }));
    expect(first.getByText(/Both agents ended on the round mark/)).toBeDefined();
    expect(
      within(screen.getByRole("article", { name: "Second" })).getByText(/The round mark reads at any size/),
    ).toBeDefined();
    await app.user.click(screen.getByRole("button", { name: "The first is better" }));
    expect(await screen.findByText("You chose: First")).toBeDefined();
    expect(app.server.debates.picks.get("deb_logo/usr_iris")?.pick).toBe("debate");
  });

  test("the pair is drawn per person: someone else may read it the other way round", async () => {
    const app = await renderApp({ path: PAGE("deb_logo"), signedInAs: "usr_jonas" });
    await app.user.click(await screen.findByText("Read it blind"));
    const first = within(await screen.findByRole("article", { name: "First" }));
    expect(first.getByText(/The round mark reads at any size/)).toBeDefined();
    await app.user.click(screen.getByRole("button", { name: "The first is better" }));
    expect(await screen.findByText("You chose: First")).toBeDefined();
    expect(app.server.debates.picks.get("deb_logo/usr_jonas")?.pick).toBe("single");
  });

  test("a debate lost from sight drops the blind pair it held", async () => {
    const app = await renderApp({ path: PAGE("deb_logo"), signedInAs: "usr_iris" });
    await app.user.click(await screen.findByText("Read it blind"));
    await screen.findByRole("article", { name: "First" });
    app.server.state.channels.push({
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
    const logo = app.server.debates.debates.find((row) => row.id === "deb_logo");
    if (logo === undefined) throw new Error("the seed has no logo debate");
    logo.channelId = "ch_board";
    await act(async () => app.server.emit(WORKSPACE, { type: "debate.updated", debateId: "deb_logo" }));
    expect(await screen.findByText("This debate isn't here")).toBeDefined();
    const cached = app.runtime.queryClient
      .getQueryCache()
      .findAll()
      .filter((query) => JSON.stringify(query.queryKey).includes("reviewDebate"));
    expect(cached.length).toBe(0);
  });

  test("spend shows only to who may see it", async () => {
    const asOwner = await renderApp({ path: PAGE("deb_logo"), signedInAs: "usr_ana" });
    expect(await screen.findByText("Spent so far: $0.0123")).toBeDefined();
    asOwner.unmount();
    await renderApp({ path: PAGE("deb_logo"), signedInAs: "usr_iris" });
    await screen.findByRole("heading", { level: 1, name: "Which logo goes on the new sign?" });
    expect(screen.queryByText(/Spent so far/) === null).toBe(true);
  });
});

describe("a debate that can't be read", () => {
  test("one that doesn't exist", async () => {
    await renderApp({ path: PAGE("deb_nope"), signedInAs: "usr_ana" });
    expect(await screen.findByText("This debate isn't here")).toBeDefined();
    expect(screen.getByRole("link", { name: "All debates" })).toBeDefined();
  });

  test("one in a channel the person doesn't read is the same as one that doesn't exist", async () => {
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
      }),
    );
    await renderApp({ path: PAGE("deb_board"), signedInAs: "usr_iris", server });
    expect(await screen.findByText("This debate isn't here")).toBeDefined();
    expect(screen.queryByText("Do we sell the shop?") === null).toBe(true);
  });

  test("once lost, a later failure of another kind never shows it again", async () => {
    const app = await renderApp({ path: PAGE("deb_paper"), signedInAs: "usr_iris" });
    await screen.findByRole("heading", { level: 1, name: "Which paper supplier do we keep?" });
    app.server.state.channels.push({
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
    const paper = app.server.debates.debates.find((row) => row.id === "deb_paper");
    if (paper === undefined) throw new Error("the seed has no paper debate");
    paper.channelId = "ch_board";
    await act(async () => app.server.emit(WORKSPACE, { type: "debate.updated", debateId: "deb_paper" }));
    expect(await screen.findByText("This debate isn't here")).toBeDefined();
    // The next read fails for another reason: the page still shows nothing of the debate.
    app.server.force("getDebate", { kind: "error", status: 503, code: "unavailable" }, 50);
    const before = app.server.calls.filter((call) => call.method === "getDebate").length;
    await act(async () => app.server.emit(WORKSPACE, { type: "debate.updated", debateId: "deb_paper" }));
    for (let n = 0; n < 5; n++) await app.advance(60_000);
    await waitFor(() => {
      const state = app.runtime.queryClient
        .getQueryCache()
        .findAll()
        .find((query) => JSON.stringify(query.queryKey).includes("getDebate"))?.state;
      expect(state?.fetchStatus).toBe("idle");
      expect((state?.error as { status?: number } | null)?.status).toBe(503);
    });
    expect(app.server.calls.filter((call) => call.method === "getDebate").length > before).toBe(true);
    expect(screen.getByText("This debate isn't here")).toBeDefined();
    expect(
      screen.queryByRole("heading", { level: 1, name: "Which paper supplier do we keep?" }) === null,
    ).toBe(true);
  });

  test("one that didn't load says so and loads on retry", async () => {
    const server = newServer();
    server.force("getDebate", { kind: "error", status: 503, code: "unavailable" }, 3);
    const app = await renderApp({ path: PAGE("deb_paper"), signedInAs: "usr_ana", server });
    expect(await screen.findByText("This debate could not be loaded")).toBeDefined();
    await app.user.click(screen.getByRole("button", { name: "Retry" }));
    expect(
      await screen.findByRole("heading", { level: 1, name: "Which paper supplier do we keep?" }),
    ).toBeDefined();
  });
});

describe("steps as the server takes them", () => {
  test("cut to the limits without half an emoji or a trailing space", () => {
    expect(fit(`${"a".repeat(299)}😀`, 300)).toBe("a".repeat(299));
    expect(fit("  title  ", 300)).toBe("title");
    expect(issueItem({ title: " Order ", owner: " ", step: "Call them" })).toEqual({
      title: "Order",
      step: "Call them",
    });
  });
});

describe("who a stuck debate waits on", () => {
  const info = { reason: "The model did not answer", round: 1 };
  test("while blind: the letter the server sends, or no one in particular, never the agent", () => {
    expect(stalledBy({ ...info, agentId: null, pseudonym: "B" }, true)).toEqual({
      kind: "letter",
      letter: "B",
    });
    expect(stalledBy({ ...info, agentId: null, pseudonym: null }, true)).toEqual({ kind: "someone" });
    // An older server that still sends the id: the page never turns it into a name while blind.
    expect(stalledBy({ ...info, agentId: "agt_ledger" }, true)).toEqual({ kind: "someone" });
  });

  test("once revealed: the agent, or its letter when the server names none", () => {
    expect(stalledBy({ ...info, agentId: "agt_ledger", pseudonym: null }, false)).toEqual({
      kind: "agent",
      agentId: "agt_ledger",
    });
    expect(stalledBy({ ...info, agentId: null, pseudonym: "A" }, false)).toEqual({
      kind: "letter",
      letter: "A",
    });
  });
});
