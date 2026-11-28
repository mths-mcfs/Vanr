import { describe, expect, test } from "bun:test";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AssignmentEvent } from "@vanr/contract";
import { newServer, newTestRuntime, renderApp } from "../../../../test/app.tsx";
import { AppProviders } from "../../../app/context.tsx";
import { SuggestionActions } from "../cards.ts";
import { AssignmentPanel } from "./Panel.tsx";

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

  test("an admin who only reads the channel isn't waited on for requests, and isn't shown a list they can't open", async () => {
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
    expect(panel.queryByText("The requests to take part could not be loaded") === null).toBe(true);
    expect(app.server.calls.some((each) => each.method === "listAssignmentJoinRequests")).toBe(false);
  });

  test("the waiting list follows the server: not a provisional decision, requests and a cost pause for the owner, a stuck step for whoever decides", async () => {
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
    paper.pending = { ...paper.pending, provisional: 0, joinRequests: 1 };
    expect([await blocked("usr_ana"), await blocked("usr_jonas")]).toEqual([1, 0]);
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
    // As if the server sent the amount anyway: the page still keeps it to who may view usage.
    (server.assignments as unknown as { host: { seesUsage: () => boolean } }).host.seesUsage = () => true;
    await renderApp({ path: PAGE("asg_paper"), signedInAs: "usr_iris", server });
    const panel = within(await screen.findByRole("region", { name: "Assignment" }));
    expect(await panel.findByText("Steps")).toBeDefined();
    expect(panel.queryByText("$0.42") === null).toBe(true);
    expect(panel.queryByText("Spent") === null).toBe(true);
  });

  test("with no amount sent (null), the panel loads and shows no money", async () => {
    const server = newServer();
    paperOf(server).usage = { ...paperOf(server).usage, dollars: null };
    paperOf(server).limits = { dollars: 5, minutes: null, steps: null };
    (server.assignments as unknown as { host: { seesUsage: () => boolean } }).host.seesUsage = () => true;
    await renderApp({ path: PAGE("asg_paper"), signedInAs: "usr_ana", server });
    const panel = within(await screen.findByRole("region", { name: "Assignment" }));
    expect(await panel.findByText("Steps")).toBeDefined();
    expect(panel.queryByText("Spent") === null).toBe(true);
    expect(panel.queryByText(/\$0\.00/) === null).toBe(true);
  });

  test("the money and the runner's tokens come only to who may view usage", async () => {
    const server = newServer();
    paperOf(server).usage = { ...paperOf(server).usage, jobTokens: 1200 };
    const usage = async (userId: string) =>
      (
        (await (await call(server, userId, "GET", "/assignments/asg_paper")).json()) as {
          usage: { dollars: number | null; jobTokens: number | null };
        }
      ).usage;
    expect(await usage("usr_iris")).toMatchObject({ dollars: null, jobTokens: null });
    expect(await usage("usr_ana")).toMatchObject({ dollars: 0.42, jobTokens: 1200 });
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
