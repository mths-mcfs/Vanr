// The proposals page against the fake server. In Birchwood, Scout (Ana's) proposes to end its answers
// with the shop's hours, and Ledger's change to the workspace's context went stale.
import { describe, expect, test } from "bun:test";
import { screen, waitFor, within } from "@testing-library/react";
import { QUERY_RETRIES } from "@vanr/client/react";
import { newServer, renderApp } from "../../../../test/app.tsx";

const PATH = "/workspace/workspace_birchwood/proposals";
const card = (name: string) => screen.findByRole("article", { name });
const absent = (element: HTMLElement | null) => element === null;
const titles = () => screen.getAllByRole("article").map((each) => each.getAttribute("aria-label"));

describe("the proposals page", () => {
  test("pending first, the diff from today's text, and what only can be rejected", async () => {
    await renderApp({ path: PATH, signedInAs: "usr_ana" });
    const tone = await card("Answer print questions with the shop's hours");
    expect(within(tone).getByText("Scout proposes")).toBeDefined();
    expect(within(tone).getByText("Instructions of Scout")).toBeDefined();
    expect(within(tone).getByText("Three people asked for the hours this week.")).toBeDefined();
    expect(within(tone).getByText("Added:", { exact: false }).closest("[data-kind]")?.textContent).toBe(
      "Added: + End with the opening hours: 9 to 18.\n",
    );
    expect(within(tone).getByRole("button", { name: "Accept" })).toBeDefined();

    const stale = await card("Mention the new address");
    expect(within(stale).getByText(/can only be rejected/)).toBeDefined();
    expect(absent(within(stale).queryByRole("button", { name: "Accept" }))).toBe(true);
    expect(within(stale).getByRole("button", { name: "Reject" })).toBeDefined();
    // The stale one is not counted: it can't be accepted.
    expect(screen.getByText("1 to decide.")).toBeDefined();
    expect(document.title).toBe("Proposals | Birchwood Labs | Vanr");
  });

  test("accept after editing: the edited text is what is applied, then undo and redo it", async () => {
    const app = await renderApp({ path: PATH, signedInAs: "usr_ana" });
    const tone = await card("Answer print questions with the shop's hours");
    await app.user.click(within(tone).getByRole("button", { name: "Edit the final text" }));
    const final = within(tone).getByRole("textbox", { name: "Final text" });
    await app.user.clear(final);
    await app.user.type(final, "You help the print shop.{enter}Be brief.{enter}Open 9 to 17.");
    await app.user.click(within(tone).getByRole("button", { name: "Accept" }));
    expect(await within(tone).findByText("Accepted by Ana Beatriz Souza.")).toBeDefined();
    expect(app.server.control.proposals[0]?.proposal.after).toBe(
      "You help the print shop.\nBe brief.\nOpen 9 to 17.",
    );
    // Accepted moves below nothing pending: the stale one is still pending, so it comes first.
    await waitFor(() =>
      expect(titles()).toEqual(["Mention the new address", "Answer print questions with the shop's hours"]),
    );

    await app.user.click(within(tone).getByRole("button", { name: "Undo" }));
    expect(await within(tone).findByText("Undone: the text is back to what it was.")).toBeDefined();
    await app.user.click(within(tone).getByRole("button", { name: "Redo" }));
    await waitFor(() =>
      expect(absent(within(tone).queryByText("Undone: the text is back to what it was."))).toBe(true),
    );
    expect(app.server.control.proposals[0]?.proposal.undone).toBe(false);
  });

  test("rejecting becomes a lesson", async () => {
    const app = await renderApp({ path: PATH, signedInAs: "usr_ana" });
    const stale = await card("Mention the new address");
    await app.user.click(within(stale).getByRole("button", { name: "Reject" }));
    expect(await screen.findByText("Rejected. The agent learns from it.")).toBeDefined();
    expect(await within(stale).findByText("Rejected by Ana Beatriz Souza.")).toBeDefined();
  });

  test("a member sees the wait, not the decision", async () => {
    await renderApp({ path: PATH, signedInAs: "usr_iris" });
    const tone = await card("Answer print questions with the shop's hours");
    expect(within(tone).getByText("Waiting for someone who can decide.")).toBeDefined();
    expect(absent(within(tone).queryByRole("button", { name: /Accept|Reject|Edit/ }))).toBe(true);
    expect(screen.getByText("Nothing to decide.")).toBeDefined();
  });

  test("the filter by agent", async () => {
    const app = await renderApp({ path: `${PATH}?agent=agt_ledger`, signedInAs: "usr_ana" });
    await card("Mention the new address");
    expect(titles()).toEqual(["Mention the new address"]);
    expect(app.address()).toBe(`${PATH}?agent=agt_ledger`);
  });

  test("a filter that matches nothing can be cleared", async () => {
    await renderApp({ path: `${PATH}?agent=agt_tally`, signedInAs: "usr_ana" });
    expect(await screen.findByText("No proposals from Tally")).toBeDefined();
    expect(screen.getByRole("combobox", { name: "Agent" }).textContent).toBe("Tally");
  });

  test("no proposals yet", async () => {
    const empty = newServer();
    empty.control.proposals = [];
    await renderApp({ path: PATH, server: empty, signedInAs: "usr_ana" });
    expect(await screen.findByText("No proposals yet")).toBeDefined();
  });

  test("a list that failed to load says so and tries again", async () => {
    const server = newServer();
    server.force("listProposals", { kind: "error", status: 500, code: "internal" }, 1 + QUERY_RETRIES);
    const app = await renderApp({ path: PATH, server, signedInAs: "usr_ana" });
    expect(await screen.findByText("The proposals could not be loaded")).toBeDefined();
    await app.user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await card("Mention the new address")).toBeDefined();
  });
});
