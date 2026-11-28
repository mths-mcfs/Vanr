import { describe, expect, test } from "bun:test";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Assignment, AssignmentEvent } from "@vanr/contract";
import { newServer, newTestRuntime, renderApp } from "../../../../test/app.tsx";
import { AppProviders } from "../../../app/context.tsx";
import { SuggestionActions } from "../cards.ts";
import { AssignmentPanel } from "./Panel.tsx";
import { Summary } from "./PanelParts.tsx";

const WS = "workspace_birchwood";
const LIST = `/workspace/${WS}/assignments`;
const PAGE = (id: string) => `/workspace/${WS}/assignments/${id}`;
const API = `http://localhost/api/v1/workspaces/${WS}`;

type Server = ReturnType<typeof newServer>;
const room = (id: string, name: string, visibility: "public" | "private", memberIds: string[]) => ({
  id,
  workspaceId: WS,
  name,
  topic: "",
  isGeneral: false,
  visibility,
  budgetPerMonthUsd: null,
  createdAt: "2026-11-01T00:00:00.000Z",
  memberIds,
});
/** A call to the fake server as a person, the way the browser makes it. */
const call = (server: Server, userId: string, method: string, path: string, body?: unknown) =>
  server.fetch({ session: server.sessionFor(userId) })(`${API}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
const paperOf = (server: Server) => {
  const paper = server.assignments.assignments.find((row) => row.id === "asg_paper");
  if (paper === undefined) throw new Error("asg_paper is missing from the seed");
  return paper;
};
const event = (seq: number): AssignmentEvent => ({
  actor: { type: "agent", id: "agt_scout" },
  at: "2026-11-14T10:00:00.000Z",
  data: {},
  itemId: null,
  kind: "item_done",
  seq,
});

describe("where a new assignment can live", () => {
  test("the person's direct messages are never offered, and the server refuses one", async () => {
    const server = newServer();
    server.state.channels.push(room("ch_dm_iris", "dm", "private", ["usr_ana", "usr_iris"]));
    server.dms.set(WS, [
      { channelId: "ch_dm_iris", unread: 0, with: { id: "usr_iris", name: "Íris Valença", type: "person" } },
    ]);
    const app = await renderApp({ path: LIST, signedInAs: "usr_ana", server });
    await app.user.click(await screen.findByRole("button", { name: "New assignment" }));
    const dialog = within(await screen.findByRole("dialog", { name: "New assignment" }));
    await app.user.click(await dialog.findByRole("combobox", { name: "Channel" }));
    expect(await screen.findByRole("option", { name: "#general" })).toBeDefined();
    expect(screen.queryByRole("option", { name: "#dm" }) === null).toBe(true);
    const sent = await call(server, "usr_ana", "POST", "/assignments", {
      goal: "In a DM",
      agentId: "agt_scout",
      channelId: "ch_dm_iris",
    });
    expect(sent.status).toBe(400);
  });

  test("an agent of another workspace is no agent here", async () => {
    const server = newServer();
    const other = server.agents.find((agent) => agent.workspaceId !== WS);
    if (other === undefined) throw new Error("the seed has no agent in another workspace");
    const sent = await call(server, "usr_jonas", "POST", "/assignments", {
      goal: "Borrow an agent",
      agentId: other.id,
      channelId: "ch_general",
    });
    expect(sent.status).toBe(404);
  });

  test("the agent is checked first, as on the server: another workspace's in a direct message is no agent", async () => {
    const server = newServer();
    server.state.channels.push(room("ch_dm_iris", "dm", "private", ["usr_jonas", "usr_iris"]));
    server.dms.set(WS, [
      { channelId: "ch_dm_iris", unread: 0, with: { id: "usr_iris", name: "Íris Valença", type: "person" } },
    ]);
    const other = server.agents.find((agent) => agent.workspaceId !== WS);
    if (other === undefined) throw new Error("the seed has no agent in another workspace");
    const sent = await call(server, "usr_jonas", "POST", "/assignments", {
      goal: "Borrow an agent",
      agentId: other.id,
      channelId: "ch_dm_iris",
    });
    expect(sent.status).toBe(404);
    expect(((await sent.json()) as { error: { message: string } }).error.message).toBe("Agent not found");
  });

  test("the agent has to be in the channel", async () => {
    const server = newServer();
    server.state.channels.push(room("ch_ops", "ops", "public", ["usr_ana"]));
    const sent = await call(server, "usr_ana", "POST", "/assignments", {
      goal: "Tidy ops",
      agentId: "agt_scout",
      channelId: "ch_ops",
    });
    expect(sent.status).toBe(409);
  });

  test("the agent's own command setting holds unless the person picks one", async () => {
    const app = await renderApp({ path: LIST, signedInAs: "usr_ana" });
    await app.user.click(await screen.findByRole("button", { name: "New assignment" }));
    const dialog = within(await screen.findByRole("dialog", { name: "New assignment" }));
    await app.user.type(await dialog.findByRole("textbox", { name: "Goal" }), "Label the shelves.");
    expect(dialog.getByRole("combobox", { name: "Commands on the runner" }).textContent).toContain(
      "As set on the agent",
    );
    await app.user.click(dialog.getByRole("button", { name: "Create assignment" }));
    await waitFor(() =>
      expect(app.server.calls.filter((each) => each.method === "createAssignment").length).toBe(1),
    );
    const made = app.server.calls.find((each) => each.method === "createAssignment");
    expect(made !== undefined && "commandPolicy" in made.params).toBe(false);
  });
});

describe("who sees an assignment and what waits on them", () => {
  test("its owner sees it in a private channel they can't read, as on the server", async () => {
    const server = newServer();
    server.state.channels.push(room("ch_vault", "vault", "private", ["usr_jonas"]));
    server.assignments.assignments.push(
      server.assignments.make(WS, {
        id: "asg_vault",
        title: "Vault job",
        goal: "Count the vault.",
        agentId: "agt_scout",
        ownerId: "usr_ana",
        channelId: "ch_vault",
      }),
    );
    await renderApp({ path: LIST, signedInAs: "usr_ana", server });
    expect(await screen.findByRole("article", { name: "Vault job" })).toBeDefined();
  });

  test("an admin who only reads the assignment isn't waited on for requests, but lists and answers them", async () => {
    const server = newServer();
    const paper = paperOf(server);
    paper.people = [];
    paper.pending = {
      commands: 0,
      decisions: 0,
      joinRequests: 1,
      provisional: 0,
      reviews: 0,
      submissions: 0,
    };
    paper.requests = [
      {
        createdAt: "2026-11-14T12:00:00.000Z",
        name: "Íris Valença",
        role: null,
        status: "pending",
        userId: "usr_iris",
      },
    ];
    const app = await renderApp({ path: LIST, signedInAs: "usr_jonas", server });
    const row = within(await screen.findByRole("article", { name: "Restock the paper room" }));
    expect(row.getByText("1 open item")).toBeDefined();
    expect(row.queryByText(/waits on you/) === null).toBe(true);
    await app.user.click(row.getByRole("link", { name: "Restock the paper room" }));
    const panel = within(await screen.findByRole("region", { name: "Assignment" }));
    await app.user.click(panel.getByRole("tab", { name: "People" }));
    await panel.findByText(/Ana Beatriz Souza owns it/);
    // They manage it (configure), as the server's managesAssignment: the request is theirs to answer.
    expect(await panel.findByText("Íris Valença")).toBeDefined();
    expect(panel.queryByText("The requests to take part could not be loaded") === null).toBe(true);
    expect(app.server.calls.some((each) => each.method === "listAssignmentJoinRequests")).toBe(true);
  });

  test("a provisional decision is open, but waits on no one", async () => {
    const server = newServer();
    paperOf(server).pending = {
      commands: 0,
      decisions: 0,
      joinRequests: 0,
      provisional: 2,
      reviews: 0,
      submissions: 0,
    };
    await renderApp({ path: LIST, signedInAs: "usr_ana", server });
    const row = within(await screen.findByRole("article", { name: "Restock the paper room" }));
    expect(row.getByText("2 open items")).toBeDefined();
    expect(row.queryByText(/wait on you|waits on you/) === null).toBe(true);
  });

  test("the waiting list follows the server: not a provisional decision, requests for who decides and manages, a cost pause for the owner, a stuck step for whoever decides", async () => {
    const server = newServer();
    const paper = paperOf(server);
    const blocked = async (userId: string) => {
      const answer = await call(server, userId, "GET", "/assignments");
      return ((await answer.json()) as { counts: { blockedOnYou: number } }).counts.blockedOnYou;
    };
    paper.pending = {
      commands: 0,
      decisions: 0,
      joinRequests: 0,
      provisional: 2,
      reviews: 0,
      submissions: 0,
    };
    paper.plan = { ...paper.plan, items: paper.plan.items.map((item) => ({ ...item, stallReason: null })) };
    expect([await blocked("usr_ana"), await blocked("usr_jonas")]).toEqual([0, 0]);
    // Jonas decides and is an admin: he may let people in, so a request waits on him too.
    paper.pending = { ...paper.pending, provisional: 0, joinRequests: 1 };
    expect([await blocked("usr_ana"), await blocked("usr_jonas")]).toEqual([1, 1]);
    paper.pending = { ...paper.pending, joinRequests: 0 };
    paper.status = "paused";
    paper.ceiling = "usd";
    expect([await blocked("usr_ana"), await blocked("usr_jonas")]).toEqual([1, 0]);
    paper.status = "active";
    paper.ceiling = null;
    paper.plan = {
      ...paper.plan,
      items: paper.plan.items.map((item, at) => (at === 1 ? { ...item, stallReason: "turns" } : item)),
    };
    expect([await blocked("usr_ana"), await blocked("usr_jonas")]).toEqual([1, 1]);
  });

  test("someone who only follows a decision can't weigh in on it", async () => {
    const server = newServer();
    const sent = await call(
      server,
      "usr_iris",
      "POST",
      "/assignments/asg_paper/decisions/dec_supplier/opinion",
      {
        option: "Northpaper",
      },
    );
    expect(sent.status).toBe(403);
  });
});

describe("what an assignment cost", () => {
  test("a member who may not view usage sees no amount, even if one came", async () => {
    const server = newServer();
    // The server sends the amount today: the page still keeps it to who may view usage.
    await renderApp({ path: PAGE("asg_paper"), signedInAs: "usr_iris", server });
    const panel = within(await screen.findByRole("region", { name: "Assignment" }));
    expect(await panel.findByText("Steps")).toBeDefined();
    expect(panel.queryByText("$0.42") === null).toBe(true);
    expect(panel.queryByText("Spent") === null).toBe(true);
  });

  test("with no amount sent (null), the summary shows no money", async () => {
    const test = newTestRuntime({ path: "/", signedInAs: "usr_ana" });
    const shown = (await (
      await call(test.server, "usr_ana", "GET", "/assignments/asg_paper")
    ).json()) as Assignment;
    // As X10's server sends it to who may not view usage: the amount and the runner's tokens are null.
    const assignment = {
      ...shown,
      usage: { ...shown.usage, dollars: null, jobTokens: null } as unknown as Assignment["usage"],
      limits: { dollars: 5, minutes: null, steps: null },
    };
    const view = await act(async () =>
      render(
        <AppProviders runtime={test.runtime}>
          <Summary workspaceId={WS} assignment={assignment} />
        </AppProviders>,
      ),
    );
    expect(await screen.findByText("Steps")).toBeDefined();
    expect(screen.queryByText("Spent") === null).toBe(true);
    expect(screen.queryByText(/\$0\.00/) === null).toBe(true);
    view.unmount();
  });

  test("an admin sees what it cost", async () => {
    await renderApp({ path: PAGE("asg_paper"), signedInAs: "usr_ana" });
    const panel = within(await screen.findByRole("region", { name: "Assignment" }));
    expect(await panel.findByText("Spent")).toBeDefined();
  });
});

describe("the trail of an assignment", () => {
  test("a short trail whose events don't start at 1 offers nothing older", async () => {
    const server = newServer();
    paperOf(server).events = Array.from({ length: 13 }, (_, at) => event(400 + at));
    const app = await renderApp({ path: PAGE("asg_paper"), signedInAs: "usr_ana", server });
    const panel = within(await screen.findByRole("region", { name: "Assignment" }));
    await app.user.click(panel.getByRole("tab", { name: /^Trail/ }));
    await waitFor(() => expect(panel.getAllByRole("listitem").length).toBeGreaterThanOrEqual(13));
    expect(panel.queryByRole("button", { name: "Show older" }) === null).toBe(true);
  });

  test("an event already shown stays when a new one pushes it out of the latest page", async () => {
    const server = newServer();
    paperOf(server).events = Array.from({ length: 55 }, (_, at) => event(1 + at));
    const app = await renderApp({ path: PAGE("asg_paper"), signedInAs: "usr_ana", server });
    const panel = within(await screen.findByRole("region", { name: "Assignment" }));
    await app.user.click(panel.getByRole("tab", { name: /^Trail/ }));
    const timeline = () =>
      panel.getAllByRole("list").find((list) => list.classList.contains("work-timeline"));
    await waitFor(() => expect(timeline()?.children.length).toBe(50));
    // Pausing adds an event: the latest page now starts one later, and the one it left stays.
    await app.user.click(panel.getByRole("button", { name: "Pause" }));
    await waitFor(() => expect(timeline()?.children.length).toBe(51));
    await app.user.click(panel.getByRole("button", { name: "Show older" }));
    await waitFor(() => expect(timeline()?.children.length).toBe(56));
  });

  test("sixty events arriving between two reads leave no gap: the older ones load in order", async () => {
    const server = newServer();
    paperOf(server).events = Array.from({ length: 55 }, (_, at) => event(1 + at));
    const app = await renderApp({ path: PAGE("asg_paper"), signedInAs: "usr_ana", server });
    const panel = within(await screen.findByRole("region", { name: "Assignment" }));
    await app.user.click(panel.getByRole("tab", { name: /^Trail/ }));
    const timeline = () =>
      panel.getAllByRole("list").find((list) => list.classList.contains("work-timeline"));
    await waitFor(() => expect(timeline()?.children.length).toBe(50));
    // As after a reconnect: everything is read again, and 60 came in the meantime.
    paperOf(server).events.push(...Array.from({ length: 60 }, (_, at) => event(56 + at)));
    await act(async () => app.runtime.queryClient.invalidateQueries());
    for (const shown of [50, 100, 115]) {
      await waitFor(() => expect(timeline()?.children.length).toBe(shown));
      if (shown < 115) await app.user.click(await panel.findByRole("button", { name: "Show older" }));
    }
    await waitFor(() => expect(panel.queryByRole("button", { name: "Show older" }) === null).toBe(true));
  });

  test("a short trail that grows past a page while open offers nothing older", async () => {
    const server = newServer();
    paperOf(server).events = Array.from({ length: 30 }, (_, at) => event(1 + at));
    const app = await renderApp({ path: PAGE("asg_paper"), signedInAs: "usr_ana", server });
    const panel = within(await screen.findByRole("region", { name: "Assignment" }));
    await app.user.click(panel.getByRole("tab", { name: /^Trail/ }));
    const timeline = () =>
      panel.getAllByRole("list").find((list) => list.classList.contains("work-timeline"));
    await waitFor(() => expect(timeline()?.children.length).toBe(30));
    paperOf(server).events.push(...Array.from({ length: 25 }, (_, at) => event(31 + at)));
    await act(async () => app.runtime.queryClient.invalidateQueries());
    await waitFor(() => expect(timeline()?.children.length).toBe(55));
    expect(panel.queryByRole("button", { name: "Show older" }) === null).toBe(true);
  });

  test("a long trail loads its older events on request, then offers no more", async () => {
    const server = newServer();
    paperOf(server).events = Array.from({ length: 60 }, (_, at) => event(1001 + at));
    const app = await renderApp({ path: PAGE("asg_paper"), signedInAs: "usr_ana", server });
    const panel = within(await screen.findByRole("region", { name: "Assignment" }));
    await app.user.click(panel.getByRole("tab", { name: /^Trail/ }));
    const timeline = () =>
      panel.getAllByRole("list").find((list) => list.classList.contains("work-timeline"));
    await waitFor(() => expect(timeline()?.children.length).toBe(50));
    await app.user.click(panel.getByRole("button", { name: "Show older" }));
    await waitFor(() => expect(timeline()?.children.length).toBe(60));
    await waitFor(() => expect(panel.queryByRole("button", { name: "Show older" }) === null).toBe(true));
  });
});

describe("the cards and the people of an assignment", () => {
  test("a decision someone else took first loads again, without its choices", async () => {
    const app = await renderApp({ path: PAGE("asg_paper"), signedInAs: "usr_ana" });
    const panel = within(await screen.findByRole("region", { name: "Assignment" }));
    await app.user.click(panel.getByRole("tab", { name: /^Waiting on you/ }));
    const choose = await panel.findByRole("button", { name: "Choose Northpaper" });
    const decision = app.server.assignments.assignments[0]?.decisions[0];
    if (decision !== undefined) {
      decision.status = "taken";
      decision.chosen = "Mill & Co";
    }
    await app.user.click(choose);
    expect(await panel.findByText("Chose Mill & Co")).toBeDefined();
    expect(panel.queryByRole("button", { name: "Choose Northpaper" }) === null).toBe(true);
  });

  test("asking for changes waits for a note", async () => {
    const server = newServer();
    paperOf(server).reviews = [
      {
        id: "rev_1",
        decidedAt: null,
        decidedBy: null,
        fileIds: [],
        note: null,
        prUrl: null,
        status: "pending",
        summary: "The count sheet.",
        title: "Count sheet",
      },
    ];
    const app = await renderApp({ path: PAGE("asg_paper"), signedInAs: "usr_ana", server });
    const panel = within(await screen.findByRole("region", { name: "Assignment" }));
    await app.user.click(panel.getByRole("tab", { name: /^Waiting on you/ }));
    const review = within(await panel.findByRole("article", { name: "Review: Count sheet" }));
    const changes = review.getByRole("button", { name: "Ask for changes" }) as HTMLButtonElement;
    expect(changes.disabled).toBe(true);
    await app.user.type(review.getByRole("textbox", { name: "Note for the agent" }), "Add the toner.");
    expect(changes.disabled).toBe(false);
  });

  test("a request being answered, a person being removed, a rule being dropped and the resume switch wait for the server", async () => {
    const server = newServer();
    const paper = paperOf(server);
    paper.requests = [
      {
        createdAt: "2026-11-14T12:00:00.000Z",
        name: "Íris Valença",
        role: null,
        status: "pending",
        userId: "usr_iris",
      },
    ];
    paper.pending = { ...paper.pending, joinRequests: 1 };
    const held = [
      server.hold("runActionOnAssignmentJoinRequest"),
      server.hold("deleteAssignmentParticipant"),
      server.hold("deleteAssignmentCommandRule"),
      server.hold("updateAssignment"),
    ];
    const app = await renderApp({ path: PAGE("asg_paper"), signedInAs: "usr_ana", server });
    const panel = within(await screen.findByRole("region", { name: "Assignment" }));
    await app.user.click(panel.getByRole("tab", { name: "People" }));
    const accept = (await panel.findByRole("button", { name: "Let Íris Valença in" })) as HTMLButtonElement;
    await app.user.click(accept);
    expect(accept.disabled).toBe(true);
    expect(
      (panel.getByRole("button", { name: "Turn Íris Valença down" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    const remove = panel.getByRole("button", { name: /^Remove / }) as HTMLButtonElement;
    await app.user.click(remove);
    expect(remove.disabled).toBe(true);
    await app.user.click(panel.getByRole("tab", { name: "Settings" }));
    const drop = (await panel.findByRole("button", { name: "Stop allowing" })) as HTMLButtonElement;
    await app.user.click(drop);
    expect(drop.disabled).toBe(true);
    const resume = panel.getByRole("switch", { name: "Resume interrupted jobs on their own" });
    await app.user.click(resume);
    expect(resume.hasAttribute("disabled")).toBe(true);
    for (const each of held) each.release();
  });

  test("the people on an assignment change on the page as they change", async () => {
    const app = await renderApp({ path: PAGE("asg_paper"), signedInAs: "usr_ana" });
    const panel = within(await screen.findByRole("region", { name: "Assignment" }));
    await app.user.click(panel.getByRole("tab", { name: "People" }));
    await panel.findByText("Jonas Lind");
    app.server.assignments.assignments[0]?.people.push({ userId: "usr_iris", role: "comment" });
    await act(async () =>
      app.server.emit(WS, {
        type: "assignment.updated",
        assignmentId: "asg_paper",
        threadId: "thr_asg_paper",
      }),
    );
    expect(await panel.findByText("Íris Valença")).toBeDefined();
  });
});

describe("the pieces the chat mounts", () => {
  test("a panel moved to another assignment starts over, with nothing typed for the one before", async () => {
    const test = newTestRuntime({ path: "/", signedInAs: "usr_ana" });
    const user = userEvent.setup();
    const tree = (assignmentId: string) => (
      <AppProviders runtime={test.runtime}>
        <AssignmentPanel workspaceId={WS} assignmentId={assignmentId} />
      </AppProviders>
    );
    // The other assignment is already loaded, as in a chat that showed it before: no loading in between.
    const view = await act(async () => render(tree("asg_old")));
    await screen.findByRole("tab", { name: "Settings" });
    await act(async () => view.rerender(tree("asg_paper")));
    await waitFor(() =>
      expect(screen.getByRole("region", { name: "Assignment" }).textContent).toContain("1 job running"),
    );
    const panel = () => within(screen.getByRole("region", { name: "Assignment" }));
    await user.click(await screen.findByRole("tab", { name: "Settings" }));
    await user.type(await panel().findByRole("textbox", { name: "Step limit" }), "7");
    await act(async () => view.rerender(tree("asg_old")));
    await waitFor(() =>
      expect(screen.queryByRole("tab", { name: "Settings", selected: true }) === null).toBe(true),
    );
    await user.click(await screen.findByRole("tab", { name: "Settings" }));
    expect(((await panel().findByRole("textbox", { name: "Step limit" })) as HTMLInputElement).value).toBe(
      "",
    );
    view.unmount();
  });

  test("an answer to one suggestion never shows on the next one", async () => {
    const test = newTestRuntime({ path: "/", signedInAs: "usr_ana" });
    const rights = { act: true, comment: true };
    const tree = (suggestionId: string) => (
      <AppProviders runtime={test.runtime}>
        <SuggestionActions
          workspaceId={WS}
          assignmentId="asg_paper"
          suggestionId={suggestionId}
          rights={rights}
        />
      </AppProviders>
    );
    const view = await act(async () => render(tree("msg_one")));
    await act(async () => screen.getByRole("button", { name: "Accept" }).click());
    expect(await screen.findByText("Accepted")).toBeDefined();
    await act(async () => view.rerender(tree("msg_two")));
    expect(await screen.findByRole("button", { name: "Accept" })).toBeDefined();
    view.unmount();
  });
});
