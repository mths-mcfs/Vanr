// The session contract of the shell: a protected address sends a visitor to sign in and brings
// them back; a session that ends in the middle does the same without losing what was typed; and
// what one person typed is never handed to another.
import { describe, expect, test } from "bun:test";
import { act, screen, waitFor } from "@testing-library/react";
import { EXAMPLE_PASSWORD } from "../../dev/fake-server.ts";
import { type App, renderApp, WIRES } from "../../test/app.tsx";

const signIn = async (app: App, email: string) => {
  await app.user.type(await screen.findByLabelText("Email"), email);
  await app.user.type(screen.getByLabelText("Password"), EXAMPLE_PASSWORD);
  await app.user.click(screen.getByRole("button", { name: "Sign in" }));
};

describe("a protected address without a session", () => {
  test.each([
    ["/onboarding", "/login?redirect=%2Fonboarding"],
    ["/workspace/workspace_birchwood/agents", "/login?redirect=%2Fworkspace%2Fworkspace_birchwood%2Fagents"],
    [
      "/workspace/workspace_birchwood/settings/members?tab=pending",
      "/login?redirect=%2Fworkspace%2Fworkspace_birchwood%2Fsettings%2Fmembers%3Ftab%3Dpending",
    ],
  ])("%s leads to sign-in and keeps the address", async (path, expected) => {
    const app = await renderApp({ path });
    await screen.findByRole("heading", { level: 1, name: "Sign in" });
    expect(app.address()).toBe(expected);
  });

  test("after signing in the person is where they wanted to be, query string included", async () => {
    const app = await renderApp({ path: "/workspace/workspace_birchwood/settings/members?tab=pending" });
    await signIn(app, "ana@birchwood.example");
    await screen.findByRole("heading", { level: 2, name: "Members" });
    expect(app.address()).toBe("/workspace/workspace_birchwood/settings/members?tab=pending");
  });

  test.each(["https://evil.example/", "//evil.example/", "/\\evil.example", "javascript:alert(1)", "/login"])(
    "an address to return to that is not inside the web is ignored: %s",
    async (redirect) => {
      const app = await renderApp({ path: `/login?redirect=${encodeURIComponent(redirect)}` });
      await signIn(app, "ana@birchwood.example");
      await screen.findByRole("heading", { level: 1, name: "Birchwood Labs" });
      expect(app.address()).toBe("/workspace/workspace_birchwood");
    },
  );

  test("the root address sends a visitor to sign-in and a member to their workspace", async () => {
    const visitor = await renderApp({ path: "/" });
    await screen.findByRole("heading", { level: 1, name: "Sign in" });
    expect(visitor.address()).toBe("/login");
    visitor.unmount();
    const member = await renderApp({ path: "/", signedInAs: "usr_jonas" });
    await screen.findByRole("heading", { level: 1, name: "Birchwood Labs" });
    expect(member.address()).toBe("/workspace/workspace_birchwood");
  });

  test("a workspace the person is not a member of says so, without leaking that it exists", async () => {
    await renderApp({ path: "/workspace/workspace_birchwood/wiki", signedInAs: "usr_noor" });
    await screen.findByRole("heading", { level: 1, name: "You are not a member of this workspace" });
    expect(screen.getByRole("link", { name: "Go to your workspaces" }).getAttribute("href")).toBe("/");
    expect(screen.queryByText("Birchwood Labs")).toBeNull();
  });

  test("a membership gained after the session was cached is found without a reload", async () => {
    const app = await renderApp({ path: "/onboarding", signedInAs: "usr_noor" });
    await screen.findByRole("heading", { level: 1, name: "Name your workspace" });
    app.server.state.members.push({
      workspaceId: "workspace_nightshift",
      userId: "usr_noor",
      role: "member",
    });
    await act(() => app.runtime.router.navigate({ to: "/workspace/workspace_nightshift" }));
    await screen.findByRole("heading", { level: 1, name: "Night Shift" });
  });
});

for (const wire of WIRES) {
  describe(`a session that ends in the middle (${wire} wire)`, () => {
    test("any call answering 401 sends the person to sign in, once, and back to the same address", async () => {
      const app = await renderApp({ path: "/workspace/workspace_birchwood", signedInAs: "usr_ana", wire });
      await screen.findByRole("heading", { level: 1, name: "Birchwood Labs" });
      app.server.blockConnections(true);
      app.server.expireSessions();
      // Three calls fail at once: the frame's own and the screen's.
      await app.user.click(screen.getByRole("link", { name: "Agents" }));
      await screen.findByRole("heading", { level: 1, name: "Sign in" });
      expect((await screen.findByRole("status")).textContent).toBe(
        "Your session ended. Sign in to pick up where you left off.",
      );
      expect(app.address()).toMatch(
        /^\/login\?redirect=%2Fworkspace%2Fworkspace_birchwood(%2Fagents)?&reason=ended$/,
      );
      app.server.blockConnections(false);
      await signIn(app, "ana@birchwood.example");
      await waitFor(() => expect(app.address()).toMatch(/^\/workspace\/workspace_birchwood(\/agents)?$/));
      expect(screen.queryByRole("heading", { level: 1, name: "Sign in" })).toBeNull();
    });

    test("the real-time connection closing with 4401 does the same", async () => {
      const app = await renderApp({
        path: "/workspace/workspace_birchwood/agents",
        signedInAs: "usr_ana",
        wire,
      });
      await screen.findByRole("heading", { level: 1, name: "Agents" });
      await waitFor(() => expect(app.server.openSockets()).toHaveLength(1));
      await act(async () => app.server.expireSessions());
      await screen.findByRole("heading", { level: 1, name: "Sign in" });
      expect(app.address()).toBe("/login?redirect=%2Fworkspace%2Fworkspace_birchwood%2Fagents&reason=ended");
    });

    test("an open form keeps what was typed and gives it back to the same person", async () => {
      const app = await renderApp({ path: "/onboarding", signedInAs: "usr_noor", wire });
      await app.user.type(await screen.findByLabelText("Workspace name"), "Elsewhere Press");
      await app.user.type(screen.getByLabelText("What does this team do?"), "We print zines.");
      app.server.expireSessions();
      await app.user.click(screen.getByRole("button", { name: "Create workspace" }));
      await screen.findByRole("heading", { level: 1, name: "Sign in" });
      expect(app.address()).toBe("/login?redirect=%2Fonboarding&reason=ended");
      await signIn(app, "noor@elsewhere.example");
      await screen.findByRole("heading", { level: 1, name: "Name your workspace" });
      expect(screen.getByLabelText<HTMLInputElement>("Workspace name").value).toBe("Elsewhere Press");
      expect(screen.getByLabelText<HTMLTextAreaElement>("What does this team do?").value).toBe(
        "We print zines.",
      );
      await app.user.click(screen.getByRole("button", { name: "Create workspace" }));
      await screen.findByRole("heading", { level: 1, name: "Elsewhere Press" });
    });

    test("the text is gone when someone else signs in", async () => {
      const app = await renderApp({ path: "/onboarding", signedInAs: "usr_noor", wire });
      await app.user.type(await screen.findByLabelText("Workspace name"), "Elsewhere Press");
      app.server.expireSessions();
      await app.user.click(screen.getByRole("button", { name: "Create workspace" }));
      await screen.findByRole("heading", { level: 1, name: "Sign in" });
      await signIn(app, "ana@birchwood.example");
      await screen.findByRole("heading", { level: 1, name: "Name your workspace" });
      expect(screen.getByLabelText<HTMLInputElement>("Workspace name").value).toBe("");
    });

    test("the text survives a reload of the tab, and a sent form leaves nothing behind", async () => {
      const app = await renderApp({ path: "/onboarding", signedInAs: "usr_noor", wire });
      await app.user.type(await screen.findByLabelText("Workspace name"), "Elsewhere Press");
      app.unmount();
      const reloaded = await renderApp({
        path: "/onboarding",
        server: app.server,
        jar: app.jar,
        tabStore: app.tabStore,
        wire,
      });
      expect((await screen.findByLabelText<HTMLInputElement>("Workspace name")).value).toBe(
        "Elsewhere Press",
      );
      await reloaded.user.click(screen.getByRole("button", { name: "Create workspace" }));
      await screen.findByRole("heading", { level: 1, name: "Elsewhere Press" });
      await act(() => reloaded.runtime.router.navigate({ to: "/onboarding" }));
      expect((await screen.findByLabelText<HTMLInputElement>("Workspace name")).value).toBe("");
    });

    test("signing out on purpose drops the text", async () => {
      const app = await renderApp({ path: "/onboarding", signedInAs: "usr_noor", wire });
      await app.user.type(await screen.findByLabelText("Workspace name"), "Elsewhere Press");
      await app.user.click(screen.getByRole("button", { name: "Sign out" }));
      await signIn(app, "noor@elsewhere.example");
      await screen.findByRole("heading", { level: 1, name: "Name your workspace" });
      expect(screen.getByLabelText<HTMLInputElement>("Workspace name").value).toBe("");
    });

    test("what the last person had on screen is not shown to the next one", async () => {
      const app = await renderApp({ path: "/workspace/workspace_birchwood", signedInAs: "usr_ana", wire });
      await screen.findByText(/2 approvals are waiting for you/);
      await app.user.click(screen.getByRole("button", { name: "Ana Beatriz Souza, account menu" }));
      await app.user.click(await screen.findByRole("menuitem", { name: "Sign out" }));
      await signIn(app, "jonas@birchwood.example");
      await screen.findByRole("heading", { level: 1, name: "Birchwood Labs" });
      await screen.findByRole("button", { name: "Jonas Lind, account menu" });
      expect(screen.queryByText(/approvals are waiting for you/)).toBeNull();
    });
  });
}
