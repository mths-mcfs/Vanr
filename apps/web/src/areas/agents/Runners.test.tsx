import { describe, expect, test } from "bun:test";
import { act, screen, waitFor, within } from "@testing-library/react";
import { newServer, renderApp } from "../../../test/app.tsx";

const SECTION = "/workspace/workspace_birchwood/settings/runners";
const page = (runnerId: string) => `/workspace/workspace_birchwood/settings/runners/${runnerId}`;

describe("the runners section", () => {
  test("every runner with who paired it and whether it is online, and how to pair one", async () => {
    await renderApp({ path: SECTION, signedInAs: "usr_iris" });
    const list = await screen.findByRole("list", { name: "Runners" });
    const rows = within(list)
      .getAllByRole("listitem")
      .map((row) => row.textContent);
    expect(rows).toEqual([
      "Studio MacPaired by Ana Beatriz Souza · darwin arm64Online",
      "Shed boxPaired by Jonas Lind · darwin arm64Offline",
    ]);
    expect(screen.getByText(/vanr-runner pair --server/)).toBeDefined();
  });

  test("a runner paired elsewhere shows up without a reload", async () => {
    const app = await renderApp({ path: SECTION, signedInAs: "usr_iris" });
    await screen.findByRole("list", { name: "Runners" });
    await act(async () => {
      app.server.runnerWork.runners.push(
        app.server.runnerWork.runner("rnr_new", "Attic", "usr_jonas", "Jonas Lind", true, []),
      );
      app.server.emit("workspace_birchwood", { type: "runner.paired", runnerId: "rnr_new" });
    });
    await waitFor(() =>
      expect(within(screen.getByRole("list", { name: "Runners" })).getAllByRole("listitem")).toHaveLength(3),
    );
  });

  test("no runners: what a runner is", async () => {
    const server = newServer();
    server.runnerWork.runners = [];
    await renderApp({ path: SECTION, signedInAs: "usr_iris", server });
    expect(await screen.findByText("No runners yet")).toBeDefined();
  });
});

describe("a runner's page", () => {
  test("whoever may manage it renames it, turns a tool off and moves its agents", async () => {
    const app = await renderApp({ path: page("rnr_studio"), signedInAs: "usr_ana" });
    await screen.findByRole("heading", { level: 1, name: "Studio Mac" });
    expect(screen.getByRole("list", { name: "Agents on it" }).textContent).toContain("Scout");
    const name = screen.getByLabelText("Name");
    await app.user.clear(name);
    await app.user.type(name, "Studio");
    await app.user.click(screen.getByRole("button", { name: "Rename" }));
    expect(await screen.findByText("Runner renamed")).toBeDefined();
    await app.user.click(screen.getByRole("button", { name: "Disable Commands" }));
    expect(await screen.findByText("Commands is off on this runner")).toBeDefined();
    expect(app.server.runnerWork.runners[0]?.access.tools.commands).toBe(false);
    await app.user.click(screen.getByRole("combobox", { name: "Move every agent to" }));
    await app.user.click(await screen.findByRole("option", { name: "Shed box" }));
    await app.user.click(screen.getByRole("button", { name: "Move agents" }));
    expect(await screen.findByText("1 agent was moved")).toBeDefined();
    expect(app.server.runnerWork.targets.get("agt_scout")).toBe("rnr_shed");
  });

  test("removing it asks first and goes back to the list", async () => {
    const app = await renderApp({ path: page("rnr_shed"), signedInAs: "usr_jonas" });
    await app.user.click(await screen.findByRole("button", { name: "Remove" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Remove Shed box?" });
    await app.user.click(within(dialog).getByRole("button", { name: "Remove" }));
    await screen.findByRole("list", { name: "Runners" });
    expect(app.address()).toBe(SECTION);
  });

  test("someone who may not manage it only reads it", async () => {
    await renderApp({ path: page("rnr_studio"), signedInAs: "usr_iris" });
    await screen.findByRole("heading", { level: 1, name: "Studio Mac" });
    expect(screen.queryByRole("button", { name: "Rename" }) === null).toBe(true);
    expect(screen.queryByRole("button", { name: "Remove" }) === null).toBe(true);
  });

  test("a member who paired a runner manages it but does not move agents", async () => {
    const server = newServer();
    const shed = server.runnerWork.runners.find((runner) => runner.id === "rnr_shed");
    if (shed !== undefined) Object.assign(shed, { pairedByUserId: "usr_iris", pairedByName: "Íris Valença" });
    server.runnerWork.targets.set("agt_tally", "rnr_shed");
    await renderApp({ path: page("rnr_shed"), signedInAs: "usr_iris", server });
    await screen.findByRole("heading", { level: 1, name: "Shed box" });
    expect(screen.getByRole("button", { name: "Rename" })).toBeDefined();
    expect(screen.getByRole("list", { name: "Agents on it" }).textContent).toContain("Tally");
    expect(screen.queryByRole("form", { name: "Move agents" }) === null).toBe(true);
  });

  test("a dialog opened on one runner does not stay open on a runner of another workspace", async () => {
    const server = newServer();
    server.runnerWork.runners.push(
      server.runnerWork.runner(
        "rnr_night",
        "Studio Mac",
        "usr_jonas",
        "Jonas Lind",
        true,
        [],
        "workspace_nightshift",
      ),
    );
    // Night Shift's runners are already in the cache, so the switch shows no loading screen in between.
    const night = "/workspace/workspace_nightshift/settings/runners/rnr_night";
    const app = await renderApp({ path: night, signedInAs: "usr_ana", server });
    await screen.findByRole("heading", { level: 1, name: "Studio Mac" });
    await act(() =>
      app.runtime.router.navigate({ to: "/workspace/workspace_birchwood/settings/runners/rnr_studio" }),
    );
    await app.user.click(await screen.findByRole("button", { name: "Remove" }));
    await screen.findByRole("alertdialog", { name: "Remove Studio Mac?" });
    // Ana is only a member of Night Shift, where another runner has the same name.
    await act(() => app.runtime.router.navigate({ to: night }));
    await screen.findByRole("heading", { level: 1, name: "Studio Mac" });
    await waitFor(() => expect(screen.queryByRole("alertdialog") === null).toBe(true));
    expect(screen.queryByRole("button", { name: "Remove" }) === null).toBe(true);
  });

  test("a runner that is not there says so", async () => {
    await renderApp({ path: page("rnr_gone"), signedInAs: "usr_iris" });
    expect(await screen.findByText("No such runner")).toBeDefined();
  });
});
