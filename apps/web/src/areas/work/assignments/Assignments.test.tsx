import { describe, expect, test } from "bun:test";
import { screen, waitFor, within } from "@testing-library/react";
import { chooseOption, newServer, renderApp } from "../../../../test/app.tsx";

const LIST = "/workspace/workspace_birchwood/assignments";
const PAGE = (id: string) => `/workspace/workspace_birchwood/assignments/${id}`;

describe("the assignments", () => {
  test("open ones with their agent, place, progress and what waits on the person; closed ones apart", async () => {
    const app = await renderApp({ path: LIST, signedInAs: "usr_ana" });
    await screen.findByRole("heading", { level: 1, name: "Assignments" });
    const paper = within(screen.getByRole("article", { name: "Restock the paper room" }));
    expect(paper.getByText("Working")).toBeDefined();
    expect(paper.getByText("Scout")).toBeDefined();
    expect(paper.getByText("#general")).toBeDefined();
    expect(paper.getByText("1 of 2 steps")).toBeDefined();
    expect(paper.getByText("1 job running")).toBeDefined();
    expect(paper.getByText("3 things wait on you")).toBeDefined();
    expect(screen.queryByRole("article", { name: "Archive last year's jobs" }) === null).toBe(true);
    await app.user.click(screen.getByRole("tab", { name: "Closed (1)" }));
    expect(await screen.findByRole("article", { name: "Archive last year's jobs" })).toBeDefined();
  });

  test("a new assignment opens on its page, not started", async () => {
    const app = await renderApp({ path: LIST, signedInAs: "usr_ana" });
    await app.user.click(await screen.findByRole("button", { name: "New assignment" }));
    const dialog = within(await screen.findByRole("dialog", { name: "New assignment" }));
    await app.user.type(await dialog.findByRole("textbox", { name: "Goal" }), "Label every shelf");
    await app.user.click(dialog.getByRole("button", { name: "Create assignment" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Label every shelf" })).toBeDefined();
    const panel = within(screen.getByRole("region", { name: "Assignment" }));
    expect(panel.getByText("Not started")).toBeDefined();
    expect(panel.getByText("You own it")).toBeDefined();
    await app.user.click(panel.getByRole("button", { name: "Start" }));
    expect(await screen.findByText("Started")).toBeDefined();
    await waitFor(() => expect(panel.getByText("Working")).toBeDefined());
  });

  test("no assignments yet: what one is", async () => {
    const server = newServer();
    server.assignments.assignments = [];
    await renderApp({ path: LIST, signedInAs: "usr_ana", server });
    expect(await screen.findByText("No assignments yet")).toBeDefined();
  });

  test("a list that did not load says so and loads on retry", async () => {
    const server = newServer();
    server.force("listAssignments", { kind: "error", status: 503, code: "unavailable" }, 4);
    const app = await renderApp({ path: LIST, signedInAs: "usr_ana", server });
    expect(await screen.findByText("The assignments could not be loaded")).toBeDefined();
    await app.user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("article", { name: "Restock the paper room" })).toBeDefined();
  });
});

describe("an assignment's page", () => {
  test("pause, resume and close it as done, with a warning for the running job", async () => {
    const app = await renderApp({ path: PAGE("asg_paper"), signedInAs: "usr_ana" });
    const panel = within(await screen.findByRole("region", { name: "Assignment" }));
    await app.user.click(panel.getByRole("button", { name: "Pause" }));
    await waitFor(() => expect(panel.getByRole("button", { name: "Resume" })).toBeDefined());
    await app.user.click(panel.getByRole("button", { name: "Resume" }));
    await waitFor(() => expect(panel.getByRole("button", { name: "Pause" })).toBeDefined());
    await app.user.click(panel.getByRole("button", { name: "Close" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Close the assignment" }));
    expect(dialog.getByText("1 job is still running: closing stops it.")).toBeDefined();
    await app.user.click(dialog.getByRole("button", { name: "Close assignment" }));
    expect(await screen.findByText("Assignment closed")).toBeDefined();
    await waitFor(() => expect(panel.getByText("Done")).toBeDefined());
    expect(app.server.assignments.assignments.find((row) => row.id === "asg_paper")?.outcome).toBe("done");
  });

  test("what waits on the owner: a decision, a result and a command, each acted on", async () => {
    const app = await renderApp({ path: PAGE("asg_paper"), signedInAs: "usr_ana" });
    const panel = within(await screen.findByRole("region", { name: "Assignment" }));
    await app.user.click(panel.getByRole("tab", { name: "Waiting on you" }));
    const decision = within(await panel.findByRole("article", { name: "Decision" }));
    expect(decision.getByText("Which supplier?")).toBeDefined();
    expect(decision.getByText("Recommended")).toBeDefined();
    await app.user.click(decision.getByRole("button", { name: "Choose Northpaper" }));
    await waitFor(() => expect(decision.getByText("Chose Northpaper")).toBeDefined());
    const command = within(panel.getByRole("article", { name: "Command waiting" }));
    await app.user.click(command.getByRole("button", { name: "Deny" }));
    await waitFor(() => expect(command.getByText("Denied")).toBeDefined());
    const result = within(panel.getByRole("article", { name: "Result to accept" }));
    expect((await result.findByText("six")).tagName).toBe("STRONG");
    await app.user.click(result.getByRole("checkbox", { name: "Every printer counted" }));
    await waitFor(() =>
      expect(app.server.assignments.assignments[0]?.submissions[0]?.checklist[0]?.verifiedBy).toBe("usr_ana"),
    );
    await app.user.click(result.getByRole("button", { name: "Accept" }));
    await waitFor(() => expect(result.getByText("Accepted")).toBeDefined());
  });

  test("someone who only views it sees no actions and can ask to take part", async () => {
    const app = await renderApp({ path: PAGE("asg_paper"), signedInAs: "usr_iris" });
    const panel = within(await screen.findByRole("region", { name: "Assignment" }));
    expect(panel.getByText(/You can follow this assignment/)).toBeDefined();
    expect(panel.queryByRole("button", { name: "Pause" }) === null).toBe(true);
    await app.user.click(panel.getByRole("tab", { name: "Waiting on you" }));
    const decision = within(await panel.findByRole("article", { name: "Decision" }));
    expect(decision.queryByRole("button", { name: /Choose/ }) === null).toBe(true);
    await app.user.click(panel.getByRole("tab", { name: "People" }));
    await app.user.click(await panel.findByRole("button", { name: "Ask to take part" }));
    expect(await panel.findByText("Your request is waiting for the owner")).toBeDefined();
    expect(panel.queryByRole("button", { name: "Ask to take part" }) === null).toBe(true);
  });

  test("the plan, the trail read to its end, and the files", async () => {
    const app = await renderApp({ path: PAGE("asg_paper"), signedInAs: "usr_ana" });
    const panel = within(await screen.findByRole("region", { name: "Assignment" }));
    await app.user.click(panel.getByRole("tab", { name: "Plan" }));
    expect(await panel.findByText("Count what is left")).toBeDefined();
    expect(panel.getByText("Checked")).toBeDefined();
    await app.user.click(panel.getByRole("tab", { name: /^Trail/ }));
    expect(await panel.findByText("Scout: asked for a decision")).toBeDefined();
    expect(panel.getByText("Ana Beatriz Souza: started the work")).toBeDefined();
    await waitFor(() => expect(app.server.assignments.assignments[0]?.seen.get("usr_ana")).toBe(3));
    await app.user.click(panel.getByRole("tab", { name: "Files" }));
    expect(await panel.findByText("assignment.md")).toBeDefined();
  });

  test("an assignment of a channel the person can't read shows as not here", async () => {
    const server = newServer();
    server.state.channels.push({
      id: "ch_board",
      workspaceId: "workspace_birchwood",
      name: "board",
      topic: "",
      isGeneral: false,
      visibility: "private",
      budgetPerMonthUsd: null,
      createdAt: "2026-11-02T09:00:00.000Z",
      memberIds: ["usr_ana"],
    });
    const row = server.assignments.assignments.find((each) => each.id === "asg_paper");
    if (row !== undefined) row.channelId = "ch_board";
    await renderApp({ path: PAGE("asg_paper"), signedInAs: "usr_iris", server });
    expect(await screen.findByText("This assignment isn't here")).toBeDefined();
    expect(screen.getByRole("heading", { level: 1, name: "Assignment" })).toBeDefined();
  });
  test("a review is approved with a note, and its pull request opens only as a web address", async () => {
    const server = newServer();
    const row = server.assignments.assignments.find((each) => each.id === "asg_paper");
    row?.reviews.push({
      id: "rev_1",
      decidedAt: null,
      decidedBy: null,
      fileIds: [],
      note: null,
      prUrl: "https://git.example/pr/9",
      status: "pending",
      summary: "Adds the order form.",
      title: "Order form",
    });
    const app = await renderApp({ path: PAGE("asg_paper"), signedInAs: "usr_jonas", server });
    const panel = within(await screen.findByRole("region", { name: "Assignment" }));
    await app.user.click(panel.getByRole("tab", { name: "Waiting on you" }));
    const review = within(await panel.findByRole("article", { name: "Review: Order form" }));
    expect(review.getByRole("link", { name: "Open the pull request" }).getAttribute("href")).toBe(
      "https://git.example/pr/9",
    );
    await app.user.type(review.getByRole("textbox", { name: "Note for the agent" }), "Looks right");
    await app.user.click(review.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(review.getByText("Approved")).toBeDefined());
    expect(row?.reviews[0]?.note).toBe("Looks right");
  });
  test("the owner sets the limits and resumes jobs on their own", async () => {
    const app = await renderApp({ path: PAGE("asg_paper"), signedInAs: "usr_ana" });
    const panel = within(await screen.findByRole("region", { name: "Assignment" }));
    await app.user.click(panel.getByRole("tab", { name: "Settings" }));
    expect(await panel.findByText("lpstat *")).toBeDefined();
    const steps = panel.getByRole("spinbutton", { name: "Step limit" });
    await app.user.type(steps, "40");
    await app.user.click(panel.getByRole("button", { name: "Save limits" }));
    await waitFor(() => expect(app.server.assignments.assignments[0]?.limits.steps).toBe(40));
    await app.user.click(panel.getByRole("switch", { name: "Resume interrupted jobs on their own" }));
    await waitFor(() => expect(app.server.assignments.assignments[0]?.resumeJobs).toBe(true));
  });

  test("someone who doesn't own it is told only the owner changes how it runs", async () => {
    const app = await renderApp({ path: PAGE("asg_paper"), signedInAs: "usr_iris" });
    const panel = within(await screen.findByRole("region", { name: "Assignment" }));
    await app.user.click(panel.getByRole("tab", { name: "Settings" }));
    expect(await panel.findByText("Only the owner changes how this assignment runs.")).toBeDefined();
  });
});

describe("asking to take part", () => {
  test("asking again after a no reopens the one request, and letting someone in twice adds them once", async () => {
    const server = newServer();
    const as = (userId: string) => server.fetch({ session: server.sessionFor(userId) });
    const base = "http://localhost/api/v1/workspaces/workspace_birchwood/assignments/asg_paper/join-requests";
    const post = (userId: string, path = "", body: unknown = {}) =>
      as(userId)(`${base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    expect((await post("usr_iris")).status).toBe(201);
    expect((await post("usr_ana", "/usr_iris/decline")).status).toBe(200);
    expect((await post("usr_iris")).status).toBe(201);
    const listed = (await (await as("usr_ana")(base, { method: "GET" })).json()) as {
      requests: { userId: string; status: string }[];
    };
    expect(listed.requests.filter((each) => each.userId === "usr_iris").map((each) => each.status)).toEqual([
      "pending",
    ]);
    expect((await post("usr_ana", "/usr_iris/accept", { role: "comment" })).status).toBe(200);
    expect((await post("usr_ana", "/usr_iris/accept", { role: "comment" })).status).toBe(409);
    const paper = server.assignments.assignments.find((row) => row.id === "asg_paper");
    expect(paper?.people.filter((person) => person.userId === "usr_iris").length).toBe(1);
    expect((await post("usr_iris")).status).toBe(409);
  });
});

describe("an assignment's states, as each person sees them", () => {
  test("someone who can't act sees open items, not things waiting on them", async () => {
    await renderApp({ path: LIST, signedInAs: "usr_iris" });
    const paper = within(await screen.findByRole("article", { name: "Restock the paper room" }));
    expect(paper.getByText("3 open items")).toBeDefined();
    expect(paper.queryByText(/wait on you/) === null).toBe(true);
  });

  test("requests to take part wait only on who may let people in", async () => {
    const server = newServer();
    const paper = server.assignments.assignments.find((row) => row.id === "asg_paper");
    if (paper !== undefined) {
      paper.people.push({ userId: "usr_iris", role: "decide" });
      paper.pending = { ...paper.pending, decisions: 0, submissions: 0, commands: 0, joinRequests: 2 };
    }
    await renderApp({ path: LIST, signedInAs: "usr_iris", server });
    const row = within(await screen.findByRole("article", { name: "Restock the paper room" }));
    expect(row.getByText("2 open items")).toBeDefined();
    expect(row.queryByText(/wait on you/) === null).toBe(true);
  });

  test("a public channel the person isn't in can hold a new assignment, and the form says it adds them", async () => {
    const server = newServer();
    server.state.channels.push({
      id: "ch_press",
      workspaceId: "workspace_birchwood",
      name: "press",
      topic: "",
      isGeneral: false,
      visibility: "public",
      budgetPerMonthUsd: null,
      createdAt: "2026-11-02T09:00:00.000Z",
      memberIds: [],
    });
    const app = await renderApp({ path: LIST, signedInAs: "usr_ana", server });
    await app.user.click(await screen.findByRole("button", { name: "New assignment" }));
    const dialog = within(await screen.findByRole("dialog", { name: "New assignment" }));
    await app.user.type(await dialog.findByRole("textbox", { name: "Goal" }), "Count the press sheets.");
    await chooseOption(app, dialog.getByRole("combobox", { name: "Channel" }), "#press");
    expect(
      dialog.getByText("You aren't in #press yet: creating the assignment there adds you to it."),
    ).toBeDefined();
    await app.user.click(dialog.getByRole("button", { name: "Create assignment" }));
    await waitFor(() =>
      expect(app.server.assignments.assignments.some((row) => row.channelId === "ch_press")).toBe(true),
    );
  });

  test("agents that couldn't be loaded say so, with a retry, instead of saying none can", async () => {
    const server = newServer();
    server.force("listAssignmentEligibleAgents", { kind: "error", status: 503, code: "unavailable" }, 4);
    const app = await renderApp({ path: LIST, signedInAs: "usr_ana", server });
    await app.user.click(await screen.findByRole("button", { name: "New assignment" }));
    const dialog = within(await screen.findByRole("dialog", { name: "New assignment" }));
    expect(
      await dialog.findByText("The agents that can take an assignment could not be loaded"),
    ).toBeDefined();
    expect(dialog.queryByText(/No agent can take an assignment yet/) === null).toBe(true);
    await app.user.click(dialog.getByRole("button", { name: "Retry" }));
    expect(await dialog.findByRole("textbox", { name: "Goal" })).toBeDefined();
  });

  test("channels that couldn't be loaded say so in the form, with a retry, and the form starts in #general", async () => {
    const server = newServer();
    // The page asks for the channels too: they stay down until the retry.
    server.force("listChannels", { kind: "error", status: 503, code: "unavailable" }, 100);
    const app = await renderApp({ path: LIST, signedInAs: "usr_ana", server });
    await app.user.click(await screen.findByRole("button", { name: "New assignment" }));
    const dialog = within(await screen.findByRole("dialog", { name: "New assignment" }));
    expect(
      await dialog.findByText(
        "The channels an assignment can live in could not be loaded",
        {},
        { timeout: 8000 },
      ),
    ).toBeDefined();
    server.unforce("listChannels");
    await app.user.click(dialog.getByRole("button", { name: "Retry" }));
    expect(await dialog.findByRole("textbox", { name: "Goal" })).toBeDefined();
    expect(dialog.getByRole("combobox", { name: "Channel" }).textContent).toContain("#general");
  });

  test("requests to take part that couldn't be loaded say so, with a retry", async () => {
    const server = newServer();
    server.force("listAssignmentJoinRequests", { kind: "error", status: 503, code: "unavailable" }, 4);
    const app = await renderApp({ path: PAGE("asg_paper"), signedInAs: "usr_ana", server });
    const panel = within(await screen.findByRole("region", { name: "Assignment" }));
    await app.user.click(panel.getByRole("tab", { name: "People" }));
    expect(await panel.findByText("The requests to take part could not be loaded")).toBeDefined();
  });

  test("a command rule stopped stays gone when the settings open again", async () => {
    const app = await renderApp({ path: PAGE("asg_paper"), signedInAs: "usr_ana" });
    const panel = within(await screen.findByRole("region", { name: "Assignment" }));
    await app.user.click(panel.getByRole("tab", { name: "Settings" }));
    await app.user.click(await panel.findByRole("button", { name: "Stop allowing" }));
    await waitFor(() => expect(panel.queryByText("lpstat *") === null).toBe(true));
    expect(app.server.assignments.assignments[0]?.rules).toEqual([]);
  });

  test("accepting the result closes the assignment and stops its jobs", async () => {
    const app = await renderApp({ path: PAGE("asg_paper"), signedInAs: "usr_ana" });
    const panel = within(await screen.findByRole("region", { name: "Assignment" }));
    await app.user.click(panel.getByRole("tab", { name: "Waiting on you" }));
    const result = within(await panel.findByRole("article", { name: "Result to accept" }));
    await app.user.click(result.getByRole("button", { name: "Accept" }));
    await waitFor(() => expect(panel.getByText("Done")).toBeDefined());
    const row = app.server.assignments.assignments[0];
    expect([row?.runningJobs, row?.closedAt !== null]).toEqual([0, true]);
  });
});
