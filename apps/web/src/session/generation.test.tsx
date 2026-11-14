// A session generation: what was asked for by one person is never answered to, or shown to, the
// next. Signing out, a session that ends and another person signing in each end the generation.
import { describe, expect, test } from "bun:test";
import { act, screen, waitFor } from "@testing-library/react";
import { isApiError } from "@vanr/client";
import { EXAMPLE_PASSWORD } from "../../dev/fake-server.ts";
import { type App, newServer, newTestRuntime, renderApp } from "../../test/app.tsx";

const HOME = "/workspace/workspace_birchwood";
const calls = (app: Pick<App, "server">, method: string) =>
  app.server.calls.filter((call) => call.method === method).length;

async function codeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (cause) {
    if (isApiError(cause)) return cause.code;
    throw cause;
  }
  return "no failure";
}

describe("signing out ends the generation", () => {
  test.each([
    ["/onboarding", "Sign out"],
    [`${HOME}/wiki`, "Sign out"],
    ["/invite/inv-mel-pending", "Sign out and switch account"],
  ])("a failed sign-out at %s keeps the session visible and can be retried", async (path, action) => {
    const inFrame = path.startsWith(HOME);
    const userId = inFrame ? "usr_ana" : "usr_noor";
    const app = await renderApp({ path, signedInAs: userId });
    if (inFrame) {
      await app.user.click(await screen.findByRole("button", { name: "Ana Beatriz Souza, account menu" }));
    }
    const role = inFrame ? "menuitem" : "button";
    app.server.force("signOut", { kind: "error", status: 503, code: "unavailable" });
    await app.user.click(await screen.findByRole(role, { name: action }));
    await screen.findByRole("alert");
    expect(screen.queryByText("You signed out.")).toBeNull();
    expect(app.address()).toBe(path);
    expect(app.server.userOf(app.jar.session)?.id).toBe(userId);
    await app.advance(2000);
    await app.user.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByRole("heading", { level: 1, name: "Sign in" });
    expect(app.jar.session).toBeUndefined();
  });

  test("an answer to who is signed in that arrives after signing out does not bring the session back", async () => {
    const app = await renderApp({ path: "/onboarding", signedInAs: "usr_noor" });
    await screen.findByLabelText("Workspace name");
    // The server answers "Noor" now; the answer only arrives after she signed out.
    const late = app.server.delay("getMe");
    const pending = app.runtime.session.load(true);
    await waitFor(() => expect(calls(app, "getMe")).toBe(2));
    await app.user.click(screen.getByRole("button", { name: "Sign out" }));
    await screen.findByRole("heading", { level: 1, name: "Sign in" });
    await act(async () => {
      late.release();
      await pending;
    });
    expect(await pending).toBeNull();
    expect(app.runtime.gate.userId()).toBeNull();
    expect(app.jar.session).toBeUndefined();
    // A protected address still asks her to sign in.
    await act(() => app.runtime.router.navigate({ to: "/onboarding" }));
    await screen.findByRole("heading", { level: 1, name: "Sign in" });
    expect(screen.queryByLabelText("Workspace name")).toBeNull();
    expect(app.address()).toBe("/login?redirect=%2Fonboarding");
  });

  test("a write whose answer arrives after signing out changes nothing on screen", async () => {
    const app = await renderApp({ path: "/onboarding", signedInAs: "usr_noor" });
    await app.user.type(await screen.findByLabelText("Workspace name"), "Elsewhere Press");
    const late = app.server.delay("createWorkspace");
    await app.user.click(screen.getByRole("button", { name: "Create workspace" }));
    await waitFor(() => expect(calls(app, "createWorkspace")).toBe(1));
    await app.user.click(screen.getByRole("button", { name: "Sign out" }));
    await screen.findByRole("heading", { level: 1, name: "Sign in" });
    await act(async () => late.release());
    expect(app.address()).toBe("/login?reason=signed_out");
    expect(app.runtime.gate.userId()).toBeNull();
  });

  test("the client of the person who left rejects every call without sending it", async () => {
    const app = await renderApp({ path: HOME, signedInAs: "usr_ana" });
    await screen.findByRole("heading", { level: 1, name: "Birchwood Labs" });
    const before = app.runtime.api.client;
    await app.user.click(screen.getByRole("button", { name: "Ana Beatriz Souza, account menu" }));
    await app.user.click(await screen.findByRole("menuitem", { name: "Sign out" }));
    await screen.findByRole("heading", { level: 1, name: "Sign in" });
    expect(app.runtime.api.client).not.toBe(before);
    const sent = app.server.calls.length;
    expect(await codeOf(() => before.api.getOverview({ workspaceId: "workspace_birchwood" }))).toBe(
      "canceled",
    );
    expect(await codeOf(() => before.call("listAgents", { workspaceId: "workspace_birchwood" }))).toBe(
      "canceled",
    );
    expect(app.server.calls).toHaveLength(sent);
  });

  test("after signing out nothing is left in the cache, and no call of the workspace leaves", async () => {
    const app = await renderApp({ path: HOME, signedInAs: "usr_ana" });
    await screen.findByText(/2 approvals are waiting for you/);
    await app.user.click(screen.getByRole("button", { name: "Ana Beatriz Souza, account menu" }));
    await app.user.click(await screen.findByRole("menuitem", { name: "Sign out" }));
    await screen.findByRole("heading", { level: 1, name: "Sign in" });
    const after = app.server.calls.length;
    const cached = app.runtime.queryClient.getQueryCache().getAll();
    // What is cached now was asked for by nobody in particular: who is signed in, and how to sign in.
    expect(cached.map((query) => query.queryKey[2]).sort()).toEqual(["getAuthConfig", "getMe"]);
    expect(app.server.calls.slice(after).map((call) => call.method)).toEqual([]);
    const workspaceCalls = ["getOverview", "listAgents", "listActiveRuns", "listNotificationCounts"];
    const sinceSignOut = app.server.calls.slice(
      app.server.calls.findIndex((call) => call.method === "signOut"),
    );
    expect(sinceSignOut.filter((call) => workspaceCalls.includes(call.method))).toEqual([]);
  });

  test("a session that ends cancels what was in flight: its late answer is not cached for the next person", async () => {
    const app = await renderApp({ path: HOME, signedInAs: "usr_ana" });
    await screen.findByRole("heading", { level: 1, name: "Birchwood Labs" });
    const late = app.server.delay("getOverview");
    const overview = codeOf(() =>
      app.runtime.api.client.api.getOverview({ workspaceId: "workspace_birchwood" }),
    );
    await waitFor(() => expect(calls(app, "getOverview")).toBeGreaterThan(1));
    app.server.expireSessions();
    await screen.findByRole("heading", { level: 1, name: "Sign in" });
    late.release();
    expect(await overview).toBe("canceled");
    expect(
      app.runtime.queryClient
        .getQueryCache()
        .getAll()
        .some((query) => query.queryKey[2] === "getOverview"),
    ).toBe(false);
  });
});

describe("two tabs of one browser", () => {
  const otherTab = (app: App) => newTestRuntime({ path: "/", server: app.server, jar: app.jar });

  test("signing out in one tab: the other goes to sign-in at its next call, and back to where it was", async () => {
    const app = await renderApp({ path: HOME, signedInAs: "usr_ana" });
    await screen.findByRole("heading", { level: 1, name: "Birchwood Labs" });
    await otherTab(app).runtime.api.auth.signOut();
    expect(app.jar.session).toBeUndefined();
    // Nothing tells this tab until it asks the server for something.
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Birchwood Labs");
    await app.user.click(screen.getByRole("link", { name: "Agents" }));
    await screen.findByRole("heading", { level: 1, name: "Sign in" });
    expect(app.address()).toBe("/login?redirect=%2Fworkspace%2Fworkspace_birchwood%2Fagents&reason=ended");
    expect(app.runtime.gate.userId()).toBeNull();
    expect(app.server.openSockets()).toEqual([]);
  });

  test("someone else signing in from the other tab: this one drops the first person's data and drafts", async () => {
    const app = await renderApp({ path: HOME, signedInAs: "usr_ana" });
    await screen.findByText(/2 approvals are waiting for you/);
    app.runtime.drafts.write("note", "Ana's half sentence");
    await act(() => app.runtime.router.navigate({ to: "/onboarding" }));
    await app.user.type(await screen.findByLabelText("Workspace name"), "Private workspace");
    await app.user.type(screen.getByLabelText("What does this team do?"), "Private context");
    const tab = otherTab(app);
    await tab.runtime.api.auth.signOut();
    await tab.runtime.api.auth.signIn({
      body: { email: "jonas@birchwood.example", password: EXAMPLE_PASSWORD },
    });
    const before = app.runtime.api.client;
    // The next time this tab asks who is signed in, the answer is someone else.
    expect((await act(() => app.runtime.session.load(true)))?.user.id).toBe("usr_jonas");
    expect(app.runtime.gate.userId()).toBe("usr_jonas");
    expect(app.runtime.api.client).not.toBe(before);
    expect(app.runtime.drafts.read("note")).toBeUndefined();
    await screen.findByText("Signed in as jonas@birchwood.example.");
    expect(screen.getByLabelText<HTMLInputElement>("Workspace name").value).toBe("");
    expect(screen.getByLabelText<HTMLTextAreaElement>("What does this team do?").value).toBe("");
    await act(() => app.runtime.router.navigate({ to: HOME }));
    await screen.findByRole("button", { name: "Jonas Lind, account menu" });
    await waitFor(() => expect(screen.queryByText(/approvals are waiting for you/)).toBeNull());
  });
});

describe("the generation is one client at a time", () => {
  test("a call's own signal still cancels it, and a new generation answers as usual", async () => {
    const server = newServer();
    const { runtime, jar } = newTestRuntime({ path: "/", server, signedInAs: "usr_ana" });
    const stop = new AbortController();
    const held = server.hold("getOverview");
    const first = codeOf(() =>
      runtime.api.client.api.getOverview({ workspaceId: "workspace_birchwood" }, { signal: stop.signal }),
    );
    stop.abort();
    expect(await first).toBe("canceled");
    held.release();

    let changes = 0;
    const stopListening = runtime.api.subscribe(() => changes++);
    runtime.api.renew();
    expect(changes).toBe(1);
    stopListening();
    runtime.api.renew();
    expect(changes).toBe(1);
    expect(jar.session).toBeDefined();
    expect((await runtime.api.client.api.getOverview({ workspaceId: "workspace_birchwood" })).people).toBe(4);
  });
});
