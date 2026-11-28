// The approvals page against the fake server. In Birchwood, Scout (Ana's) asks to post in #print-queue,
// Tally (Jonas's) asks to email the October invoices, and Ledger's post in #design was approved earlier,
// with Ledger allowed to post there for 30 days.
import { describe, expect, test } from "bun:test";
import { act, screen, waitFor, within } from "@testing-library/react";
import { QUERY_RETRIES } from "@vanr/client/react";
import { newServer, renderApp } from "../../../../test/app.tsx";

const PATH = "/workspace/workspace_birchwood/approvals";
const card = (name: string) => screen.findByRole("article", { name });
const absent = (element: HTMLElement | null) => element === null;

describe("the approvals page", () => {
  test("what waits: the reach, the exact effect, why it asks, and who decides", async () => {
    await renderApp({ path: PATH, signedInAs: "usr_ana" });
    const post = await card("Post in #print-queue");
    expect(within(post).getByRole("img", { name: "Reach: Acts outside the workspace" })).toBeDefined();
    expect(within(post).getByText("The Hartley proofs are ready for pickup.")).toBeDefined();
    expect(within(post).getByText("The workspace asks a person before this kind of action.")).toBeDefined();
    expect(within(post).getByText("Scout asks")).toBeDefined();
    expect(within(post).getByRole("button", { name: "Approve sending" })).toBeDefined();
    expect(within(post).getByRole("checkbox", { name: /Always allow for 30 days/ })).toBeDefined();
    expect(within(post).getByText(/Posts in #print-queue/)).toBeDefined();

    // Tally is Jonas's: Ana sees it, the misleading link and that Jonas decides.
    const mail = await card("Email the October invoices");
    expect(within(mail).getByRole("img", { name: "Reach: Cannot be undone" })).toBeDefined();
    expect(within(mail).getByText("billing@hartley.example")).toBeDefined();
    expect(within(mail).getByText("The text shows one address and the link goes to another.")).toBeDefined();
    expect(within(mail).getByText("Read outside content: email from billing@hartley.example")).toBeDefined();
    expect(within(mail).getByText("Waiting for Jonas Lind to decide.")).toBeDefined();
    expect(absent(within(mail).queryByRole("button", { name: /Approve/ }))).toBe(true);

    expect(screen.getByText("1 waits for a decision.")).toBeDefined();
    expect(document.title).toBe("Approvals | Birchwood Labs | Vanr");
    // Ana owns the workspace: she sees the gate's numbers and the rules she answers for.
    const stats = screen.getByRole("region", { name: "The gate, last 30 days" });
    const k2 = within(stats).getByRole("heading", { name: "K2 Acts outside the workspace" }).closest("li");
    expect(k2?.textContent).toContain("Asked a person8");
    const rules = await screen.findByRole("list", { name: "Always allowed rules" });
    expect(within(rules).getByText("Posts in #design")).toBeDefined();
  });

  test("approve and always allow: the rule appears, and the queued post can be undone", async () => {
    const app = await renderApp({ path: PATH, signedInAs: "usr_ana" });
    const post = await card("Post in #print-queue");
    await app.user.click(within(post).getByRole("checkbox", { name: /Always allow for 30 days/ }));
    await app.user.click(within(post).getByRole("button", { name: "Approve sending" }));

    expect(await within(post).findByText("Approved by Ana Beatriz Souza.")).toBeDefined();
    expect(await screen.findByText("Approved. It won't ask again for this for 30 days.")).toBeDefined();
    const rules = screen.getByRole("list", { name: "Always allowed rules" });
    expect(await within(rules).findByText("Posts in #print-queue")).toBeDefined();
    expect(app.server.control.approvals[0]?.approval.status).toBe("approved");

    // The approved post waits in the send queue: the receipt counts down and undoing cancels it.
    const receipt = await within(post).findByRole("region", { name: "What the agent changed" });
    expect(within(receipt).getByText("Will post in #print-queue")).toBeDefined();
    expect(within(receipt).getByRole("timer").textContent).toBe("Leaves in 30 seconds");
    await app.advance(5000);
    expect(within(receipt).getByRole("timer").textContent).toBe("Leaves in 25 seconds");
    await app.user.click(within(receipt).getByRole("button", { name: "Undo" }));
    expect(
      await within(receipt).findByText("Canceled by Ana Beatriz Souza. Nothing went out."),
    ).toBeDefined();
    expect(absent(within(receipt).queryByRole("button", { name: /Undo|Redo/ }))).toBe(true);
  });

  test("reject with a ready reason: the agent reads it", async () => {
    const app = await renderApp({ path: PATH, signedInAs: "usr_ana" });
    const post = await card("Post in #print-queue");
    await app.user.click(within(post).getByRole("button", { name: "Reject" }));
    const dialog = await screen.findByRole("dialog", { name: "Reject this request" });
    await app.user.click(within(dialog).getByRole("button", { name: "I need to review this first" }));
    expect((within(dialog).getByRole("textbox", { name: "Reason" }) as HTMLTextAreaElement).value).toBe(
      "I need to review this first",
    );
    await app.user.click(within(dialog).getByRole("button", { name: "Reject" }));
    expect(
      await within(post).findByText("Rejected by Ana Beatriz Souza: I need to review this first"),
    ).toBeDefined();
    expect(app.server.control.approvals[0]?.approval.reason).toBe("I need to review this first");
  });

  test("edit and approve: only the editable fields, and what runs is the edited text", async () => {
    const app = await renderApp({ path: PATH, signedInAs: "usr_ana" });
    const post = await card("Post in #print-queue");
    await app.user.click(within(post).getByRole("button", { name: "Edit and approve" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit before approving" });
    const text = within(dialog).getByRole("textbox", { name: "Text" });
    await app.user.clear(text);
    await app.user.type(text, "Proofs ready at 3pm.");
    await app.user.click(within(dialog).getByRole("button", { name: "Save and approve" }));
    expect(await within(post).findByText("Edited before it was approved.")).toBeDefined();
    expect(within(post).getByText("Proofs ready at 3pm.")).toBeDefined();
    expect(app.server.control.approvals[0]?.approval.input).toMatchObject({ text: "Proofs ready at 3pm." });
  });

  test("a request that changed since it was opened is not approved blind, and shows its new version", async () => {
    const app = await renderApp({ path: PATH, signedInAs: "usr_ana" });
    const post = await card("Post in #print-queue");
    const stored = app.server.control.approvals[0]?.approval;
    if (stored === undefined || stored.preview === null) throw new Error("no approval");
    stored.payloadHash = "hash_post_2";
    stored.preview = { ...stored.preview, body: "The Hartley proofs are delayed." };
    await app.user.click(within(post).getByRole("button", { name: "Approve sending" }));
    expect(
      await screen.findByText("The request changed since you opened it. Look at it again before you decide."),
    ).toBeDefined();
    expect(await within(post).findByText("The Hartley proofs are delayed.")).toBeDefined();
    expect(stored.status).toBe("pending");
  });

  test("an edit is sent with the version it started from: a change meanwhile is refused", async () => {
    const app = await renderApp({ path: PATH, signedInAs: "usr_ana" });
    const post = await card("Post in #print-queue");
    await app.user.click(within(post).getByRole("button", { name: "Edit and approve" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit before approving" });
    const stored = app.server.control.approvals[0]?.approval;
    if (stored === undefined) throw new Error("no approval");
    stored.payloadHash = "hash_post_2";
    await act(async () => {
      app.server.emit("workspace_birchwood", { type: "approval.requested", approvalId: "apr_post" });
    });
    await app.user.click(within(dialog).getByRole("button", { name: "Save and approve" }));
    expect(
      await screen.findByText("The request changed since you opened it. Look at it again before you decide."),
    ).toBeDefined();
    expect(stored.status).toBe("pending");
    await waitFor(() => expect(screen.queryByRole("dialog") === null).toBe(true));
  });

  test("always allow is asked again when the rule it would remember changed", async () => {
    const app = await renderApp({ path: PATH, signedInAs: "usr_ana" });
    const post = await card("Post in #print-queue");
    await app.user.click(within(post).getByRole("checkbox", { name: /Always allow for 30 days/ }));
    const stored = app.server.control.approvals[0]?.approval;
    if (stored === undefined) throw new Error("no approval");
    stored.rememberLabel = "#design";
    await act(async () => {
      app.server.emit("workspace_birchwood", { type: "approval.requested", approvalId: "apr_post" });
    });
    expect(await within(post).findByText(/Posts in #design/)).toBeDefined();
    const box = within(post).getByRole("checkbox", { name: /Always allow for 30 days/ });
    expect(box.getAttribute("aria-checked")).toBe("false");
    await app.user.click(within(post).getByRole("button", { name: "Approve sending" }));
    expect(await within(post).findByText("Approved by Ana Beatriz Souza.")).toBeDefined();
    expect(app.server.control.rules.map((rule) => rule.rule.label)).toEqual(["#design"]);
  });

  test("past its deadline the decision is no longer offered", async () => {
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas" });
    const mail = await card("Email the October invoices");
    expect(within(mail).getByText("Decide within 40 min")).toBeDefined();
    await app.advance(41 * 60_000);
    expect(await within(mail).findByText("Nobody decided in time, so nothing ran.")).toBeDefined();
    expect(within(mail).queryByRole("button", { name: /Approve|Reject/ }) === null).toBe(true);
  });

  test("a decision made elsewhere closes the open dialog", async () => {
    const app = await renderApp({ path: PATH, signedInAs: "usr_ana" });
    const post = await card("Post in #print-queue");
    await app.user.click(within(post).getByRole("button", { name: "Reject" }));
    await screen.findByRole("dialog", { name: "Reject this request" });
    const stored = app.server.control.approvals[0]?.approval;
    if (stored === undefined) throw new Error("no approval");
    stored.status = "approved";
    stored.deciderUserId = "usr_jonas";
    await act(async () => {
      app.server.emit("workspace_birchwood", { type: "approval.resolved", approvalId: "apr_post" });
    });
    expect(await within(post).findByText("Approved by Jonas Lind.")).toBeDefined();
    expect(screen.queryByRole("dialog") === null).toBe(true);
  });

  test("a member sees who decides and no decision; the requester can undo what ran for them", async () => {
    const app = await renderApp({ path: PATH, signedInAs: "usr_iris" });
    const post = await card("Post in #print-queue");
    expect(within(post).getByText("Waiting for Ana Beatriz Souza to decide.")).toBeDefined();
    expect(absent(within(post).queryByRole("button", { name: /Approve|Reject/ }))).toBe(true);
    expect(absent(within(post).queryByRole("checkbox"))).toBe(true);
    expect(absent(screen.queryByRole("region", { name: "The gate, last 30 days" }))).toBe(true);
    expect(await screen.findByText(/No rules yet/)).toBeDefined();
    expect(screen.getByText("Nothing waits for a decision.")).toBeDefined();

    await app.user.click(screen.getByRole("tab", { name: "Decided" }));
    const done = await card("Post in #design");
    expect(within(done).getByText("Done.")).toBeDefined();
    const receipt = await within(done).findByRole("region", { name: "What the agent changed" });
    expect(within(receipt).getByText("Posted in #design")).toBeDefined();
    await app.user.click(within(receipt).getByRole("button", { name: "Undo" }));
    expect(await within(receipt).findByText("Undone by Íris Valença")).toBeDefined();
    expect(within(receipt).getByRole("button", { name: "Redo" })).toBeDefined();
  });

  test("someone who neither asked nor answers for the agent sees the receipt without undo", async () => {
    await renderApp({ path: `${PATH}?show=decided`, signedInAs: "usr_tomas" });
    const done = await card("Post in #design");
    const receipt = await within(done).findByRole("region", { name: "What the agent changed" });
    expect(within(receipt).getByText("Posted in #design")).toBeDefined();
    expect(absent(within(receipt).queryByRole("button", { name: "Undo" }))).toBe(true);
  });

  test("a private channel's request shows only to its members and to whoever decides", async () => {
    const server = newServer();
    const general = server.state.channels.find((channel) => channel.id === "ch_general");
    if (general === undefined) throw new Error("no #general");
    general.visibility = "private";
    general.memberIds = ["usr_ana", "usr_iris"];
    await renderApp({ path: PATH, server, signedInAs: "usr_tomas" });
    await card("Email the October invoices");
    expect(absent(screen.queryByRole("article", { name: "Post in #print-queue" }))).toBe(true);
  });

  test("a decision made elsewhere lands on the open page", async () => {
    const app = await renderApp({ path: PATH, signedInAs: "usr_iris" });
    const post = await card("Post in #print-queue");
    const stored = app.server.control.approvals[0]?.approval;
    if (stored === undefined) throw new Error("no approval");
    stored.status = "approved";
    stored.deciderUserId = "usr_ana";
    await act(async () => {
      app.server.emit("workspace_birchwood", {
        type: "approval.resolved",
        approvalId: "apr_post",
        agentId: "agt_scout",
      });
    });
    expect(await within(post).findByText("Approved by Ana Beatriz Souza.")).toBeDefined();
  });

  test("revoking a rule makes the agent ask again", async () => {
    const app = await renderApp({ path: PATH, signedInAs: "usr_ana" });
    await app.user.click(await screen.findByRole("button", { name: "Revoke “Posts in #design” for Ledger" }));
    const confirm = await screen.findByRole("alertdialog", { name: "Revoke this rule?" });
    expect(within(confirm).getByText("Ledger will ask a person again for: Posts in #design.")).toBeDefined();
    await app.user.click(within(confirm).getByRole("button", { name: "Revoke" }));
    expect(await screen.findByText("Revoked. The agent will ask again.")).toBeDefined();
    expect(await screen.findByText(/No rules yet/)).toBeDefined();
    expect(app.server.control.rules).toEqual([]);
  });

  test("the empty states: nothing waiting and nothing decided", async () => {
    const server = newServer();
    server.control.approvals = [];
    const app = await renderApp({ path: PATH, server, signedInAs: "usr_ana" });
    expect(await screen.findByText("Nothing waits for a decision")).toBeDefined();
    await app.user.click(screen.getByRole("tab", { name: "Decided" }));
    expect(await screen.findByText("No decisions yet")).toBeDefined();
  });

  test("the search: by the agent's name, and a search with no match", async () => {
    const app = await renderApp({ path: PATH, signedInAs: "usr_ana" });
    await card("Post in #print-queue");
    const search = screen.getByRole("searchbox", { name: "Search approvals" });
    await app.user.type(search, "zebra");
    expect(await screen.findByText("No approval matches “zebra”")).toBeDefined();
    await app.user.clear(search);
    await app.user.type(search, "tally");
    await waitFor(() =>
      expect(screen.getAllByRole("article").map((each) => each.getAttribute("aria-label"))).toEqual([
        "Email the October invoices",
      ]),
    );
  });

  test("a list that failed to load says so and tries again", async () => {
    const server = newServer();
    server.force("listApprovals", { kind: "error", status: 500, code: "internal" }, 1 + QUERY_RETRIES);
    const app = await renderApp({ path: PATH, server, signedInAs: "usr_ana" });
    expect(await screen.findByText("The approvals could not be loaded")).toBeDefined();
    await app.user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await card("Post in #print-queue")).toBeDefined();
  });

  test("while the list is on its way, the page says it is loading", async () => {
    const server = newServer();
    const held = server.hold("listApprovals");
    await renderApp({ path: PATH, server, signedInAs: "usr_ana" });
    // The rules beside it are not held: once they are in, the loading left is the list's.
    await screen.findByRole("list", { name: "Always allowed rules" });
    expect(screen.getByText("Loading")).toBeDefined();
    expect(screen.queryByRole("list", { name: "Approvals" }) === null).toBe(true);
    held.release();
    expect(await card("Post in #print-queue")).toBeDefined();
  });
});
