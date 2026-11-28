import { describe, expect, test } from "bun:test";
import { screen, waitFor, within } from "@testing-library/react";
import { type App, newServer, renderApp } from "../../../test/app.tsx";

/** The agent the server keeps under a handle; a missing one fails the test. */
const byHandle = (app: App, handle: string) => {
  const found = app.server.agents.find((agent) => agent.handle === handle);
  if (found === undefined) throw new Error(`no agent @${handle}`);
  return found;
};

const PATH = "/workspace/workspace_birchwood/agents/new";
const next = (app: App) => app.user.click(screen.getByRole("button", { name: "Next" }));
const form = (step: string) => screen.findByRole("form", { name: new RegExp(`: ${step}$`) });

describe("adding an agent", () => {
  test("from a role to a created agent, with the handle drawn from the name", async () => {
    const app = await renderApp({ path: PATH, signedInAs: "usr_ana" });
    await form("Role");
    const support = screen.getByRole("button", { name: /^Support/ });
    await app.user.click(support);
    expect(support.getAttribute("aria-pressed")).toBe("true");
    await next(app);

    await form("Name");
    await app.user.type(screen.getByLabelText("Name"), "Maré Alta");
    expect((screen.getByLabelText("Handle") as HTMLInputElement).value).toBe("mare-alta");
    await next(app);

    await form("Instructions");
    await app.user.type(screen.getByLabelText("Instructions"), "Answer about tides.");
    await next(app);

    await form("Channels");
    expect(
      (screen.getByRole("checkbox", { name: "#general" }) as HTMLElement).getAttribute("aria-checked"),
    ).toBe("true");
    await app.user.click(screen.getByRole("checkbox", { name: "#design" }));
    await next(app);

    await form("Model and access");
    await waitFor(() => expect(screen.getByLabelText("Model").textContent).toContain("Claude Haiku 5.5"));
    await next(app);

    await form("Review");
    const review = screen.getByLabelText("What will be created");
    expect(review.textContent).toContain("Maré Alta");
    expect(review.textContent).toContain("@mare-alta");
    expect(review.textContent).toContain("Support");
    expect(review.textContent).toContain("#general, #design");
    expect(review.textContent).toContain("All workspace members");
    await app.user.click(screen.getByRole("button", { name: "Create the agent" }));

    await screen.findByRole("heading", { name: "Maré Alta is ready" });
    const created = byHandle(app, "mare-alta");
    expect(created.role).toBe("support");
    expect(created.instructions).toBe("Answer about tides.");
    expect(created.ownerUserId).toBe("usr_ana");
    expect(app.server.agentWork.extra(created).channels.map((each) => each.id)).toEqual([
      "ch_general",
      "ch_design",
    ]);
    await app.user.click(screen.getByRole("button", { name: "Open profile" }));
    await screen.findByRole("heading", { level: 1, name: "Maré Alta" });
  });

  test("a handle already in use stops the name step", async () => {
    const app = await renderApp({ path: PATH, signedInAs: "usr_ana" });
    await form("Role");
    await next(app);
    await app.user.type(await screen.findByLabelText("Name"), "Scout");
    expect(await screen.findByText("That handle is taken. Pick another.")).toBeDefined();
    expect(screen.getByRole("button", { name: "Next" }).hasAttribute("disabled")).toBe(true);
    await app.user.clear(screen.getByLabelText("Handle"));
    await app.user.type(screen.getByLabelText("Handle"), "A");
    expect(screen.getByText(/2 to 32 characters from a–z/)).toBeDefined();
  });

  test("a handle the server refuses at the end sends the person back to the name", async () => {
    const server = newServer();
    server.force("createAgent", { kind: "error", status: 409, code: "agent.handle_taken" });
    const app = await renderApp({ path: PATH, signedInAs: "usr_ana", server });
    await form("Role");
    await next(app);
    await app.user.type(await screen.findByLabelText("Name"), "Old Hand");
    for (const step of ["Instructions", "Channels", "Model and access"]) {
      await next(app);
      await form(step);
    }
    await waitFor(() => expect(screen.getByLabelText("Model").textContent).toContain("Claude Haiku 5.5"));
    await next(app);
    await app.user.click(await screen.findByRole("button", { name: "Create the agent" }));
    await form("Name");
    expect(screen.getByText("That handle is taken. Pick another.")).toBeDefined();
    expect(screen.getByRole("button", { name: "Next" }).hasAttribute("disabled")).toBe(true);
    await app.user.clear(screen.getByLabelText("Handle"));
    await app.user.type(screen.getByLabelText("Handle"), "old-hand-2");
    expect(screen.getByRole("button", { name: "Next" }).hasAttribute("disabled")).toBe(false);
  });

  test("a description fills the wizard; the suggested skills are turned on after creating", async () => {
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas" });
    await form("Role");
    const draft = screen.getByRole("button", { name: "Draft it" });
    expect(draft.hasAttribute("disabled")).toBe(true);
    await app.user.type(screen.getByLabelText("Describe the agent and get a draft"), "Helps with shipping");
    await app.user.click(draft);
    await form("Name");
    expect(screen.getByText(/Filled in by the test model/)).toBeDefined();
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Courier");
    for (const step of ["Instructions", "Channels", "Model and access", "Review"]) {
      await next(app);
      await form(step);
    }
    await waitFor(() =>
      expect(screen.getByLabelText("What will be created").textContent).toContain("Claude Haiku 5.5"),
    );
    await app.user.click(screen.getByRole("button", { name: "Create the agent" }));
    await screen.findByRole("heading", { name: "Courier is ready" });
    const courier = byHandle(app, "courier");
    expect(courier.instructions).toBe("You help with this: Helps with shipping");
    expect(app.server.agentWork.extra(courier).skills.get("skl_release")).toBe(true);
  });

  test("a failed draft says why and keeps the wizard where it was", async () => {
    const server = newServer();
    server.force("createAgentDraft", { kind: "error", status: 500, code: "internal" });
    const app = await renderApp({ path: PATH, signedInAs: "usr_ana", server });
    await form("Role");
    await app.user.type(screen.getByLabelText("Describe the agent and get a draft"), "Anything");
    await app.user.click(screen.getByRole("button", { name: "Draft it" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "The server ran into a problem. Try again.",
    );
    expect(screen.getByRole("form", { name: "Step 1 of 6: Role" })).toBeDefined();
  });

  test("picking people for the audience needs at least one", async () => {
    const app = await renderApp({ path: PATH, signedInAs: "usr_ana" });
    await form("Role");
    await next(app);
    await app.user.type(await screen.findByLabelText("Name"), "Quiet");
    for (const step of ["Instructions", "Channels", "Model and access"]) {
      await next(app);
      await form(step);
    }
    await app.user.click(screen.getByRole("radio", { name: "Only the people I pick" }));
    expect(screen.getByRole("alert").textContent).toBe("Choose one person or more.");
    expect(screen.getByRole("button", { name: "Next" }).hasAttribute("disabled")).toBe(true);
    await app.user.click(screen.getByRole("checkbox", { name: "Íris Valença" }));
    expect(screen.getByRole("button", { name: "Next" }).hasAttribute("disabled")).toBe(false);
  });

  test("a member is told who adds agents", async () => {
    await renderApp({ path: PATH, signedInAs: "usr_iris" });
    expect(await screen.findByText("Only admins add agents")).toBeDefined();
    expect(screen.queryByRole("form") === null).toBe(true);
  });

  test("the channels that fail to load can be tried again", async () => {
    const server = newServer();
    server.force("listChannels", { kind: "error", status: 503, code: "unavailable" }, 4);
    const app = await renderApp({ path: PATH, signedInAs: "usr_ana", server });
    await form("Role");
    await next(app);
    await app.user.type(await screen.findByLabelText("Name"), "Retry Me");
    await next(app);
    await next(app);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("The channels could not be loaded");
    expect(screen.getByRole("button", { name: "Next" }).hasAttribute("disabled")).toBe(true);
    await app.user.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("checkbox", { name: "#general" })).toBeDefined();
  });
});
