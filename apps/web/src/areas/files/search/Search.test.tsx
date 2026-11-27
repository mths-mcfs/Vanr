// The workspace's search: the query in the address, results with the words marked and a link to where
// each one lives, the kind filters, the operators' help and the answer to a question with its sources.
import { describe, expect, test } from "bun:test";
import { screen, waitFor, within } from "@testing-library/react";
import { QUERY_RETRIES } from "@vanr/client/react";
import { newServer, renderApp } from "../../../../test/app.tsx";

const PATH = "/workspace/workspace_birchwood/search";
const field = () => screen.getByRole("searchbox", { name: "Search the workspace" });

describe("the search", () => {
  test("asks for two characters, then lists what matches with the words marked and a link to each", async () => {
    const app = await renderApp({ path: PATH, signedInAs: "usr_ana" });
    await screen.findByRole("heading", { level: 1, name: "Search" });
    expect(screen.getByText("Type at least two characters to search")).toBeDefined();
    await app.user.type(field(), "drying");
    const results = await screen.findByRole("list", { name: "Results" });
    const hit = within(results).getByRole("listitem");
    expect(hit.textContent).toContain("File");
    expect(hit.textContent).toContain("#design");
    expect(hit.textContent).toContain("Scout");
    expect(within(hit).getByText("drying", { selector: "mark" })).toBeDefined();
    expect(within(hit).getByRole("link", { name: "field-notes.txt" }).getAttribute("href")).toBe(
      "/workspace/workspace_birchwood/files?file=fil_notes",
    );
    expect(app.address()).toBe(`${PATH}?q=drying`);
    expect(document.title).toBe("Search | Birchwood Labs | Vanr");
  });

  test("opens with the query in the address, and says when nothing matches", async () => {
    await renderApp({ path: `${PATH}?q=plan`, signedInAs: "usr_ana" });
    expect((field() as HTMLInputElement).value).toBe("plan");
    await screen.findByRole("link", { name: "Release plan" });
    await renderApp({ path: `${PATH}?q=zebra`, signedInAs: "usr_ana" });
    expect(await screen.findByText("Nothing matches “zebra”")).toBeDefined();
  });

  test("a kind filter asks the server for that kind only", async () => {
    const app = await renderApp({ path: `${PATH}?q=plan`, signedInAs: "usr_ana" });
    await screen.findByRole("link", { name: "Release plan" });
    await app.user.click(screen.getByRole("button", { name: "Messages" }));
    expect(await screen.findByText("Nothing matches “plan”")).toBeDefined();
    const last = app.server.calls.filter((call) => call.method === "getSearch").at(-1);
    expect(last?.params.kinds).toBe("message");
  });

  test("the operators' help puts an example into the query", async () => {
    const app = await renderApp({ path: `${PATH}?q=ink`, signedInAs: "usr_ana" });
    await app.user.click(screen.getByRole("button", { name: "Search operators" }));
    await app.user.click(screen.getByRole("button", { name: "Add has:link" }));
    expect((field() as HTMLInputElement).value).toBe("ink has:link");
  });

  test("failed: says so, with a retry that works", async () => {
    const server = newServer();
    server.force("getSearch", { kind: "error", status: 500, code: "internal" }, 1 + QUERY_RETRIES);
    const app = await renderApp({ path: `${PATH}?q=ink`, signedInAs: "usr_ana", server });
    const alert = await within(screen.getByRole("main")).findByRole("alert");
    expect(alert.textContent).toContain("The search did not go through");
    await app.user.click(within(alert).getByRole("button", { name: "Retry" }));
    await screen.findByRole("list", { name: "Results" });
  });

  test("a question is answered with numbered sources that lead to where each one lives", async () => {
    const app = await renderApp({ path: `${PATH}?q=ink`, signedInAs: "usr_ana" });
    await app.user.click(screen.getByRole("button", { name: "Ask" }));
    const answer = await screen.findByRole("region", { name: "Answer" });
    await waitFor(() =>
      expect(answer.textContent).toContain("The workspace mentions this in field-notes.txt."),
    );
    expect(within(answer).getByRole("link", { name: "Source 1" }).getAttribute("href")).toBe("#ask-source-1");
    const sources = within(answer).getByRole("list", { name: "Sources" });
    expect(within(sources).getByRole("link", { name: "field-notes.txt" })).toBeDefined();
    expect(within(answer).getByText("Answered by the test model, not a real one.")).toBeDefined();
  });

  test("a question that cannot be answered says why, and the search still works", async () => {
    const server = newServer();
    server.force("askSearch", { kind: "error", status: 503, code: "search.ask_no_model" });
    const app = await renderApp({ path: `${PATH}?q=ink`, signedInAs: "usr_ana", server });
    await app.user.click(screen.getByRole("button", { name: "Ask" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("No model is set up to answer questions in this workspace.");
    expect(await screen.findByRole("list", { name: "Results" })).toBeDefined();
  });

  test("a server without the runtime yet says answers are not available here", async () => {
    const server = newServer();
    server.force("askSearch", { kind: "error", status: 503, code: "not_available" });
    const app = await renderApp({ path: `${PATH}?q=ink`, signedInAs: "usr_ana", server });
    await app.user.click(screen.getByRole("button", { name: "Ask" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Answers to questions are not available on this server yet.",
    );
  });

  test("opened with a question from the palette, it asks at once", async () => {
    await renderApp({ path: `${PATH}?q=ink&ask=1`, signedInAs: "usr_ana" });
    const answer = await screen.findByRole("region", { name: "Answer" });
    await waitFor(() => expect(answer.textContent).toContain("field-notes.txt"));
  });
});

describe("the search, past the happy path", () => {
  test("an operator that would pass the length limit leaves the query as it is", async () => {
    const long = "a".repeat(195);
    const app = await renderApp({ path: `${PATH}?q=${long}`, signedInAs: "usr_ana" });
    await app.user.click(screen.getByRole("button", { name: "Search operators" }));
    await app.user.click(screen.getByRole("button", { name: "Add has:link" }));
    expect((field() as HTMLInputElement).value).toBe(long);
  });
});
