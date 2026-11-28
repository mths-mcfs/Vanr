import { describe, expect, test } from "bun:test";
import { screen, waitFor, within } from "@testing-library/react";
import { chooseOption, newServer, renderApp } from "../../../../test/app.tsx";

const issuePage = (number: string) => `/workspace/workspace_birchwood/issues/${number}`;

describe("an issue's page", () => {
  test("its description, criteria and details; checking a criterion is saved and shows in the activity", async () => {
    const app = await renderApp({ path: issuePage("1"), signedInAs: "usr_ana" });
    await screen.findByRole("heading", { level: 1, name: "#1 Reprint the spring catalogue" });
    expect(screen.getByText("Friday").tagName).toBe("STRONG");
    const criteria = screen.getByRole("region", { name: "Acceptance criteria" });
    const paper = within(criteria).getByRole("checkbox", { name: "Paper ordered" });
    expect(paper.getAttribute("aria-checked")).toBe("false");
    await app.user.click(paper);
    await waitFor(() =>
      expect(app.server.work.issues[0]?.criteria.find((c) => c.text === "Paper ordered")?.done).toBe(true),
    );
    const activity = screen.getByRole("region", { name: "Activity" });
    expect(await within(activity).findByText(/Ana Beatriz Souza met “Paper ordered”/)).toBeDefined();
    expect(within(activity).getByText(/Ana Beatriz Souza opened the issue/)).toBeDefined();
    expect(document.title).toBe("#1 Reprint the spring catalogue | Birchwood Labs | Vanr");
  });

  test("a comment is posted, shown, and the box empties", async () => {
    const app = await renderApp({ path: issuePage("1"), signedInAs: "usr_ana" });
    const box = await screen.findByRole("textbox", { name: "Comment" });
    await app.user.type(box, "Proofs look **sharp**");
    await app.user.click(screen.getByRole("button", { name: "Post comment" }));
    expect(await screen.findByText("Comment posted")).toBeDefined();
    expect((await screen.findByText("sharp")).tagName).toBe("STRONG");
    expect((screen.getByRole("textbox", { name: "Comment" }) as HTMLTextAreaElement).value).toBe("");
  });

  test("its priority changes from the side, and it is handed to an agent while no agent has it", async () => {
    const app = await renderApp({ path: issuePage("1"), signedInAs: "usr_ana" });
    await screen.findByRole("heading", { level: 1, name: "#1 Reprint the spring catalogue" });
    await chooseOption(app, screen.getByRole("combobox", { name: "Priority" }), "Urgent");
    await waitFor(() => expect(app.server.work.issues[0]?.priority).toBe("urgent"));
    const ask = screen.getByRole("region", { name: "Hand it to an agent" });
    await chooseOption(app, within(ask).getByRole("combobox", { name: "Agent" }), "Scout");
    await app.user.click(within(ask).getByRole("button", { name: "Ask to work on it" }));
    expect(await screen.findByText("Scout is on it")).toBeDefined();
    expect(await screen.findByText("Scout is working on this.")).toBeDefined();
    expect(screen.queryByRole("region", { name: "Hand it to an agent" }) === null).toBe(true);
  });

  test("an agent stopped for a reason it can't name says something plain, never the code", async () => {
    const server = newServer();
    const issue = server.work.issues.find((each) => each.number === 2);
    if (issue !== undefined) issue.work = { state: "blocked", reason: "E_SOCKET_HUP_42", runId: null };
    await renderApp({ path: issuePage("2"), signedInAs: "usr_ana", server });
    expect(await screen.findByText("Scout stopped: something went wrong on the way.")).toBeDefined();
    expect(screen.queryByText(/E_SOCKET_HUP_42/) === null).toBe(true);
  });

  test("a pull request opens only when it is a web address", async () => {
    const server = newServer();
    const issue = server.work.issues.find((each) => each.number === 2);
    if (issue !== undefined) issue.pullRequests = ["https://git.example/pr/7", "javascript:alert(1)"];
    await renderApp({ path: issuePage("2"), signedInAs: "usr_ana", server });
    const prs = await screen.findByRole("region", { name: "Pull requests" });
    expect(within(prs).getByRole("link", { name: "https://git.example/pr/7" })).toBeDefined();
    expect(within(prs).queryByRole("link", { name: /javascript/ }) === null).toBe(true);
    expect(within(prs).getByText("javascript:alert(1)")).toBeDefined();
  });

  test("a number that doesn't exist, isn't a number, or belongs to a hidden channel reads as not here", async () => {
    const server = newServer();
    const hidden = server.work.issues.find((each) => each.number === 3);
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
    if (hidden !== undefined) hidden.channelId = "ch_board";
    for (const number of ["99", "abc", "0", "3"]) {
      const view = await renderApp({ path: issuePage(number), signedInAs: "usr_iris", server });
      expect(await screen.findByText("This issue isn't here")).toBeDefined();
      expect(screen.getByRole("link", { name: "All issues" })).toBeDefined();
      view.unmount();
    }
    expect(
      server.calls.filter((call) => call.method === "getIssueBySeq").map((call) => call.params.issueSeq),
    ).toEqual(["99", "3"]);
  });

  test("a page that did not load says so and loads on retry", async () => {
    const server = newServer();
    server.force("getIssueBySeq", { kind: "error", status: 503, code: "unavailable" }, 4);
    const app = await renderApp({ path: issuePage("1"), signedInAs: "usr_ana", server });
    expect(await screen.findByText("This issue could not be loaded")).toBeDefined();
    await app.user.click(screen.getByRole("button", { name: "Retry" }));
    expect(
      await screen.findByRole("heading", { level: 1, name: "#1 Reprint the spring catalogue" }),
    ).toBeDefined();
  });
});
