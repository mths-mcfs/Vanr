import { describe, expect, test } from "bun:test";
import { screen } from "@testing-library/react";
import { type App, renderApp } from "../../../test/app.tsx";

const create = (app: App) => app.user.click(screen.getByRole("button", { name: "Create workspace" }));

describe("first workspace", () => {
  test("retrying a failed session refresh opens the workspace without creating it again", async () => {
    const app = await renderApp({ path: "/onboarding", signedInAs: "usr_noor" });
    await app.user.type(await screen.findByLabelText("Workspace name"), "Elsewhere Press");
    app.server.force("getMe", { kind: "offline" });
    await create(app);
    await screen.findByRole("alert");
    await app.user.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByRole("heading", { level: 1, name: "Elsewhere Press" });
    expect(app.server.calls.filter((call) => call.method === "createWorkspace")).toHaveLength(1);
  });

  test("reloading after a failed session refresh does not restore the completed creation", async () => {
    const app = await renderApp({ path: "/onboarding", signedInAs: "usr_noor" });
    await app.user.type(await screen.findByLabelText("Workspace name"), "Elsewhere Press");
    await app.user.type(screen.getByLabelText("What does this team do?"), "We print zines.");
    app.server.force("getMe", { kind: "offline" });
    await create(app);
    await screen.findByRole("alert");
    app.unmount();
    const reloaded = await renderApp({
      path: "/onboarding",
      server: app.server,
      jar: app.jar,
      tabStore: app.tabStore,
    });
    expect((await screen.findByLabelText<HTMLInputElement>("Workspace name")).value).toBe("");
    expect(screen.getByLabelText<HTMLTextAreaElement>("What does this team do?").value).toBe("");
    await create(reloaded);
    expect(app.server.calls.filter((call) => call.method === "createWorkspace")).toHaveLength(1);
  });

  test("idle and field error", async () => {
    const app = await renderApp({ path: "/onboarding", signedInAs: "usr_noor" });
    await screen.findByRole("heading", { level: 1, name: "Name your workspace" });
    expect(screen.getByText("Signed in as noor@elsewhere.example.")).toBeDefined();
    await create(app);
    expect(screen.getByText("Give the workspace a name.")).toBeDefined();
    expect(app.server.calls.filter((call) => call.method === "createWorkspace")).toEqual([]);
  });

  test("sending, then the new workspace opens with its first steps", async () => {
    const app = await renderApp({ path: "/onboarding", signedInAs: "usr_noor" });
    await app.user.type(await screen.findByLabelText("Workspace name"), "  Elsewhere Press ");
    await app.user.type(screen.getByLabelText("What does this team do?"), "We print zines.");
    const held = app.server.hold("createWorkspace");
    await create(app);
    expect(screen.getByRole("button", { name: "Create workspace" }).getAttribute("aria-busy")).toBe("true");
    held.release();
    await screen.findByRole("heading", { level: 1, name: "Elsewhere Press" });
    expect(app.server.calls.find((call) => call.method === "createWorkspace")?.params).toMatchObject({
      name: "Elsewhere Press",
      context: "We print zines.",
    });
    expect(screen.getByText("1 person and 0 agents work here. No agent is at work right now.")).toBeDefined();
    expect(screen.getByRole("heading", { level: 2, name: "First steps" })).toBeDefined();
    expect(screen.getByRole("link", { name: "Add an agent" }).getAttribute("href")).toMatch(/\/agents\/new$/);
    expect(screen.getByRole("link", { name: "Bring people in" }).getAttribute("href")).toMatch(
      /\/settings\/members$/,
    );
  });

  test("server error keeps the form and what was typed", async () => {
    const app = await renderApp({ path: "/onboarding", signedInAs: "usr_noor" });
    app.server.force("createWorkspace", { kind: "error", status: 500, code: "internal" });
    await app.user.type(await screen.findByLabelText("Workspace name"), "Elsewhere Press");
    await create(app);
    expect((await screen.findByRole("alert")).textContent).toBe("The server ran into a problem. Try again.");
    expect(screen.getByLabelText<HTMLInputElement>("Workspace name").value).toBe("Elsewhere Press");
  });

  test("signing out from here goes to sign-in with the notice", async () => {
    const app = await renderApp({ path: "/onboarding", signedInAs: "usr_noor" });
    await app.user.click(await screen.findByRole("button", { name: "Sign out" }));
    expect((await screen.findByRole("status")).textContent).toBe("You signed out.");
    expect(app.address()).toBe("/login?reason=signed_out");
  });
});
