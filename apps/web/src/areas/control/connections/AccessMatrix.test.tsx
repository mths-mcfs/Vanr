// The Access section of the settings and the agent's own "What it reaches", against the fake server.
// Birchwood has Scout, Ledger and Tally, and one workspace connection, "Team Linear". Jonas is an admin,
// Íris a member.
import { describe, expect, test } from "bun:test";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { chooseOption, newServer, newTestRuntime, renderApp } from "../../../../test/app.tsx";
import { blurOnDisable } from "../../../../test/focus.ts";

const WS = "workspace_birchwood";
const PATH = `/workspace/${WS}/settings/access`;
const LINEAR = "con_github";
const tab = (agentId: string) => `/workspace/${WS}/agents/${agentId}?tab=access`;

describe("the access matrix", () => {
  const grid = () => screen.findByRole("table", { name: "Agents and connections" });
  const rowOf = (table: HTMLElement, agent: string) => {
    const found = within(table)
      .getAllByRole("row")
      .find((row) => within(row).queryByRole("rowheader")?.textContent === agent);
    if (found === undefined) throw new Error(`no row for ${agent}`);
    return found;
  };

  test("a member is kept out of the section", async () => {
    await renderApp({ path: PATH, signedInAs: "usr_iris" });
    expect(await screen.findByText("This section is for admins")).toBeDefined();
    expect(screen.queryByRole("table") === null).toBe(true);
  });

  test("an admin sets how far an agent reaches into a connection; other scopes stay", async () => {
    const server = newServer();
    server.connections.grants.set("agt_scout", [{ connectionId: "", scope: "tool:web_search" }]);
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas", server });
    const table = await grid();
    expect(within(table).getByRole("columnheader", { name: "Team Linear" })).toBeDefined();
    const scout = rowOf(table, "Scout");
    const cell = await within(scout).findByRole("combobox", { name: "What Scout may do in Team Linear" });
    expect(cell.textContent).toBe("Nothing");
    await chooseOption(app, cell, "Read");
    await act(async () => {});
    expect(server.connections.grants.get("agt_scout")).toEqual([
      { connectionId: "", scope: "tool:web_search" },
      { connectionId: LINEAR, scope: "linear:read" },
    ]);
    await chooseOption(
      app,
      within(rowOf(await grid(), "Scout")).getByRole("combobox", {
        name: "What Scout may do in Team Linear",
      }),
      "Read and change",
    );
    await act(async () => {});
    expect(server.connections.grants.get("agt_scout")?.filter((g) => g.connectionId === LINEAR)).toEqual([
      { connectionId: LINEAR, scope: "linear:read" },
      { connectionId: LINEAR, scope: "linear:write" },
    ]);
  });

  test("everything turned off keeps what it gave, spelled out", async () => {
    const server = newServer();
    server.connections.grants.set("agt_tally", [
      { connectionId: "", scope: "*" },
      { connectionId: "", scope: "deny:send_mail" },
    ]);
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas", server });
    const tally = rowOf(await grid(), "Tally");
    const all = await within(tally).findByRole("switch", { name: "Everything for Tally" });
    expect(all.getAttribute("aria-checked")).toBe("true");
    const cell = within(tally).getByRole("combobox", { name: "What Tally may do in Team Linear" });
    expect(cell.hasAttribute("disabled")).toBe(true);
    await app.user.click(all);
    await act(async () => {});
    const after = server.connections.grants.get("agt_tally") ?? [];
    expect(after.some((g) => g.scope === "*")).toBe(false);
    expect(after.filter((g) => g.connectionId === LINEAR).map((g) => g.scope)).toEqual([
      "linear:read",
      "linear:write",
    ]);
    expect(after.some((g) => g.scope === "drive:write")).toBe(true);
    expect(after.some((g) => g.scope === "deny:send_mail")).toBe(true);
    expect(
      (
        await within(rowOf(await grid(), "Tally")).findByRole("switch", { name: "Everything for Tally" })
      ).getAttribute("aria-checked"),
    ).toBe("false");
    await app.user.click(
      within(rowOf(await grid(), "Tally")).getByRole("switch", { name: "Everything for Tally" }),
    );
    await act(async () => {});
    expect(server.connections.grants.get("agt_tally")?.some((g) => g.scope === "*")).toBe(true);
  });

  test("turning everything off builds on the access as it is now", async () => {
    const server = newServer();
    server.connections.grants.set("agt_tally", [{ connectionId: "", scope: "*" }]);
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas", server });
    const all = await within(rowOf(await grid(), "Tally")).findByRole("switch", {
      name: "Everything for Tally",
    });
    // Someone else denies a tool after this screen loaded.
    server.connections.grants.get("agt_tally")?.push({ connectionId: "", scope: "deny:delete_file" });
    await app.user.click(all);
    await act(async () => {});
    expect(server.connections.grants.get("agt_tally")?.some((g) => g.scope === "deny:delete_file")).toBe(
      true,
    );
  });

  test("everything turned off from a stale screen writes nothing when someone already did it", async () => {
    const server = newServer();
    server.connections.grants.set("agt_tally", [{ connectionId: "", scope: "*" }]);
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas", server });
    const all = await within(rowOf(await grid(), "Tally")).findByRole("switch", {
      name: "Everything for Tally",
    });
    expect(all.getAttribute("aria-checked")).toBe("true");
    // Another admin turns it off and leaves Tally reading Team Linear only, after this screen loaded.
    server.connections.grants.set("agt_tally", [{ connectionId: LINEAR, scope: "linear:read" }]);
    await app.user.click(all);
    await act(async () => {});
    expect(server.connections.grants.get("agt_tally")).toEqual([
      { connectionId: LINEAR, scope: "linear:read" },
    ]);
    expect(server.calls.some((call) => call.method === "setAgentScopes")).toBe(false);
    // The row catches up with what is saved.
    const tally = rowOf(await grid(), "Tally");
    await waitFor(() =>
      expect(
        within(tally).getByRole("switch", { name: "Everything for Tally" }).getAttribute("aria-checked"),
      ).toBe("false"),
    );
    expect(
      within(tally).getByRole("combobox", { name: "What Tally may do in Team Linear" }).textContent,
    ).toBe("Read");
  });

  test("everything turned on from a stale screen writes nothing when someone already did it", async () => {
    const server = newServer();
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas", server });
    const all = await within(rowOf(await grid(), "Tally")).findByRole("switch", {
      name: "Everything for Tally",
    });
    expect(all.getAttribute("aria-checked")).toBe("false");
    server.connections.grants.set("agt_tally", [{ connectionId: "", scope: "*" }]);
    await app.user.click(all);
    await act(async () => {});
    expect(server.calls.some((call) => call.method === "setAgentAccess")).toBe(false);
    await waitFor(() =>
      expect(
        within(rowOf(screen.getByRole("table"), "Tally"))
          .getByRole("switch", { name: "Everything for Tally" })
          .getAttribute("aria-checked"),
      ).toBe("true"),
    );
  });

  test("a connection removed meanwhile is refused, and the matrix loads its columns again", async () => {
    const server = newServer();
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas", server });
    const cell = await within(rowOf(await grid(), "Scout")).findByRole("combobox", {
      name: "What Scout may do in Team Linear",
    });
    server.agentAccess.shared.length = 0;
    await chooseOption(app, cell, "Read");
    expect(await screen.findByText("That connection is gone: someone removed it meanwhile.")).toBeDefined();
    expect(server.connections.grants.get("agt_scout") ?? []).toEqual([]);
    expect(await screen.findByText("No workspace connections yet")).toBeDefined();
    expect(within(await grid()).queryByRole("columnheader", { name: "Team Linear" }) === null).toBe(true);
  });

  test("an agent archived meanwhile is refused, and leaves the matrix", async () => {
    const server = newServer();
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas", server });
    const all = await within(rowOf(await grid(), "Ledger")).findByRole("switch", {
      name: "Everything for Ledger",
    });
    const ledger = server.agents.find((agent) => agent.id === "agt_ledger");
    if (ledger === undefined) throw new Error("no Ledger");
    ledger.archivedAt = new Date().toISOString();
    await app.user.click(all);
    expect(await screen.findByText("This agent is archived, so its access can't change.")).toBeDefined();
    await waitFor(() =>
      expect(
        within(screen.getByRole("table"))
          .getAllByRole("rowheader")
          .map((cell) => cell.textContent),
      ).not.toContain("Ledger"),
    );
  });

  test("the switch keeps the focus once the change is saved", async () => {
    const stop = blurOnDisable();
    try {
      const server = newServer();
      const app = await renderApp({ path: PATH, signedInAs: "usr_jonas", server });
      const all = await within(rowOf(await grid(), "Ledger")).findByRole("switch", {
        name: "Everything for Ledger",
      });
      await app.user.click(all);
      await waitFor(() => expect(all.getAttribute("aria-checked")).toBe("true"));
      await waitFor(() => expect(document.activeElement === all).toBe(true));
      expect(all.hasAttribute("disabled")).toBe(false);
    } finally {
      stop();
    }
  });

  test("while a change is on its way, the row's controls wait and say so", async () => {
    const server = newServer();
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas", server });
    const cell = await within(rowOf(await grid(), "Scout")).findByRole("combobox", {
      name: "What Scout may do in Team Linear",
    });
    const held = server.hold("listAgentScopes");
    await chooseOption(app, cell, "Read");
    const scout = rowOf(await grid(), "Scout");
    expect(scout.getAttribute("aria-busy")).toBe("true");
    expect(within(scout).getByRole("switch", { name: "Everything for Scout" }).hasAttribute("disabled")).toBe(
      true,
    );
    expect(within(scout).getByRole("combobox").hasAttribute("disabled")).toBe(true);
    held.release();
    await waitFor(() =>
      expect(rowOf(screen.getByRole("table"), "Scout").getAttribute("aria-busy")).toBe("false"),
    );
    expect(server.connections.grants.get("agt_scout")).toEqual([
      { connectionId: LINEAR, scope: "linear:read" },
    ]);
    expect(
      within(rowOf(await grid(), "Scout"))
        .getByRole("combobox")
        .hasAttribute("disabled"),
    ).toBe(false);
  });

  test("a row whose answer lost a connection leaves that column without a control", async () => {
    const server = newServer();
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas", server });
    await within(rowOf(await grid(), "Ledger")).findByRole("switch", { name: "Everything for Ledger" });
    server.agentAccess.shared.length = 0;
    await act(async () => {
      await app.runtime.queryClient.refetchQueries({
        predicate: (query) => JSON.stringify(query.queryKey).includes("agt_ledger"),
      });
    });
    const ledger = rowOf(await grid(), "Ledger");
    expect(await within(ledger).findByText("Removed")).toBeDefined();
    expect(within(ledger).queryByRole("combobox") === null).toBe(true);
    expect(within(await grid()).getByRole("columnheader", { name: "Team Linear" })).toBeDefined();
  });

  test("two quick changes of one agent write once", async () => {
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas" });
    const all = await within(rowOf(await grid(), "Ledger")).findByRole("switch", {
      name: "Everything for Ledger",
    });
    await act(async () => {
      fireEvent.click(all);
      fireEvent.click(all);
    });
    await act(async () => {});
    expect(app.server.calls.filter((call) => call.method === "setAgentAccess").length).toBe(1);
  });

  test("without connections the matrix still offers everything, and says where to connect", async () => {
    const server = newServer();
    server.agentAccess.shared.length = 0;
    await renderApp({ path: PATH, signedInAs: "usr_jonas", server });
    expect(await screen.findByText("No workspace connections yet")).toBeDefined();
    expect(within(await grid()).getAllByRole("switch").length).toBe(3);
  });

  test("a connection whose sign-in hasn't come back is not offered", async () => {
    const server = newServer();
    const linear = server.agentAccess.shared[0];
    if (linear === undefined) throw new Error("no Team Linear");
    linear.pending = true;
    await renderApp({ path: PATH, signedInAs: "usr_jonas", server });
    expect(await screen.findByText("No workspace connections yet")).toBeDefined();
    expect(within(await grid()).queryByRole("columnheader", { name: "Team Linear" }) === null).toBe(true);
  });

  test("an agent whose access fails to load offers a retry on its row", async () => {
    const server = newServer();
    server.force(
      "getAgentAccess",
      { kind: "error", status: 500, code: "internal" },
      4,
      (p) => p.agentId === "agt_ledger",
    );
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas", server });
    const ledger = rowOf(await grid(), "Ledger");
    expect(await within(ledger).findByText("The access of Ledger could not be loaded")).toBeDefined();
    server.unforce("getAgentAccess");
    await app.user.click(within(ledger).getByRole("button", { name: "Retry" }));
    expect(
      await within(rowOf(await grid(), "Ledger")).findByRole("switch", { name: "Everything for Ledger" }),
    ).toBeDefined();
  });

  test("a workspace without agents says how to start", async () => {
    const server = newServer();
    server.agents.length = 0;
    await renderApp({ path: PATH, signedInAs: "usr_jonas", server });
    expect(await screen.findByText("No agents yet")).toBeDefined();
    expect(screen.getByText("Create an agent, then decide here what it may reach.")).toBeDefined();
    expect(screen.queryByRole("table") === null).toBe(true);
  });

  test("agents that fail to load offer a retry", async () => {
    const server = newServer();
    server.force("listAgents", { kind: "error", status: 500, code: "internal" }, 4);
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas", server });
    expect(await screen.findByText("The access of the agents could not be loaded")).toBeDefined();
    server.unforce("listAgents");
    const block = screen.getByRole("region", { name: "Agents and connections" });
    await app.user.click(within(block).getByRole("button", { name: "Retry" }));
    expect(await within(await grid()).findByRole("switch", { name: "Everything for Scout" })).toBeDefined();
  });

  test("an agent that is gone when saving drops its stale access", async () => {
    const server = newServer();
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas", server });
    const all = await within(rowOf(await grid(), "Ledger")).findByRole("switch", {
      name: "Everything for Ledger",
    });
    server.force("setAgentAccess", { kind: "error", status: 404, code: "not_found" });
    await app.user.click(all);
    expect(await screen.findByText("That no longer exists.")).toBeDefined();
    expect(
      app.server.calls.filter(
        (call) => call.method === "getAgentAccess" && call.params.agentId === "agt_ledger",
      ).length,
    ).toBeGreaterThan(1);
  });
});

describe("what an agent reaches, on its Access tab", () => {
  const reach = () => screen.findByRole("region", { name: "What it reaches" });

  test("a member reads it and changes nothing", async () => {
    const server = newServer();
    server.connections.grants.set("agt_scout", [
      { connectionId: "", scope: "drive:read" },
      { connectionId: LINEAR, scope: "linear:read" },
    ]);
    await renderApp({ path: tab("agt_scout"), signedInAs: "usr_iris", server });
    const part = await reach();
    expect(await within(part).findByText("Only someone who manages agents changes this.")).toBeDefined();
    const files = within(part).getByRole("checkbox", { name: "Read in Files" });
    expect(files.getAttribute("aria-checked")).toBe("true");
    expect(files.hasAttribute("disabled")).toBe(true);
    const linear = within(within(part).getByRole("list", { name: "Connections" })).getByRole("listitem");
    expect(linear.textContent).toContain("Team Linear");
    expect(linear.textContent).toContain("Read");
    expect(within(part).queryByRole("combobox") === null).toBe(true);
  });

  test("an admin turns an area on and sets a connection's level", async () => {
    const server = newServer();
    const app = await renderApp({ path: tab("agt_scout"), signedInAs: "usr_jonas", server });
    const part = await reach();
    await app.user.click(await within(part).findByRole("checkbox", { name: "Change in Issues" }));
    await act(async () => {});
    expect(server.connections.grants.get("agt_scout")).toEqual([{ connectionId: "", scope: "issues:write" }]);
    await chooseOption(
      app,
      within(part).getByRole("combobox", { name: "What it may do in Team Linear" }),
      "Read",
    );
    await act(async () => {});
    expect(server.connections.grants.get("agt_scout")).toEqual([
      { connectionId: "", scope: "issues:write" },
      { connectionId: LINEAR, scope: "linear:read" },
    ]);
  });

  test("everything turned off from a stale tab writes nothing when someone already did it", async () => {
    const server = newServer();
    server.connections.grants.set("agt_scout", [{ connectionId: "", scope: "*" }]);
    const app = await renderApp({ path: tab("agt_scout"), signedInAs: "usr_jonas", server });
    const part = await reach();
    const all = await within(part).findByRole("switch", { name: /Everything/ });
    expect(all.getAttribute("aria-checked")).toBe("true");
    server.connections.grants.set("agt_scout", [{ connectionId: "", scope: "drive:read" }]);
    await app.user.click(all);
    await act(async () => {});
    expect(server.connections.grants.get("agt_scout")).toEqual([{ connectionId: "", scope: "drive:read" }]);
    await waitFor(() =>
      expect(within(part).getByRole("checkbox", { name: "Read in Files" }).getAttribute("aria-checked")).toBe(
        "true",
      ),
    );
    expect(
      within(part)
        .getByRole("switch", { name: /Everything/ })
        .getAttribute("aria-checked"),
    ).toBe("false");
  });

  test("an area the agent may change shows reading as part of it", async () => {
    const server = newServer();
    server.connections.grants.set("agt_scout", [{ connectionId: "", scope: "issues:write" }]);
    await renderApp({ path: tab("agt_scout"), signedInAs: "usr_jonas", server });
    const part = await reach();
    const read = await within(part).findByRole("checkbox", { name: "Read in Issues" });
    expect(read.getAttribute("aria-checked")).toBe("true");
    expect(read.hasAttribute("disabled")).toBe(true);
    expect(within(part).getByRole("checkbox", { name: "Read in Files" }).hasAttribute("disabled")).toBe(
      false,
    );
  });

  test("what it reaches failing to load offers a retry", async () => {
    const server = newServer();
    server.force("getAgentAccess", { kind: "error", status: 500, code: "internal" }, 4);
    const app = await renderApp({ path: tab("agt_scout"), signedInAs: "usr_jonas", server });
    expect(await screen.findByText("What this agent reaches could not be loaded")).toBeDefined();
    server.unforce("getAgentAccess");
    await app.user.click(within(await reach()).getByRole("button", { name: "Retry" }));
    expect(await within(await reach()).findByRole("switch", { name: /Everything/ })).toBeDefined();
  });

  test("without workspace connections it says so", async () => {
    const server = newServer();
    server.agentAccess.shared.length = 0;
    await renderApp({ path: tab("agt_scout"), signedInAs: "usr_jonas", server });
    const part = await reach();
    expect(await within(part).findByText("The workspace has no connections yet.")).toBeDefined();
    expect(within(part).queryByRole("combobox") === null).toBe(true);
  });

  test("an agent archived meanwhile is refused, and its tab turns read-only", async () => {
    const server = newServer();
    const app = await renderApp({ path: tab("agt_scout"), signedInAs: "usr_jonas", server });
    const files = await within(await reach()).findByRole("checkbox", { name: "Read in Files" });
    const scout = server.agents.find((agent) => agent.id === "agt_scout");
    if (scout === undefined) throw new Error("no Scout");
    scout.archivedAt = new Date().toISOString();
    await app.user.click(files);
    expect(await screen.findByText("This agent is archived, so its access can't change.")).toBeDefined();
    await waitFor(() =>
      expect(
        within(screen.getByRole("region", { name: "What it reaches" }))
          .getByRole("switch", { name: /Everything/ })
          .hasAttribute("disabled"),
      ).toBe(true),
    );
  });

  test("while a change is on its way, the tab's controls wait and say so", async () => {
    const server = newServer();
    const app = await renderApp({ path: tab("agt_scout"), signedInAs: "usr_jonas", server });
    const part = await reach();
    const files = await within(part).findByRole("checkbox", { name: "Read in Files" });
    const held = server.hold("listAgentScopes");
    await app.user.click(files);
    expect(part.querySelector("[aria-busy]")?.getAttribute("aria-busy")).toBe("true");
    expect(
      within(part)
        .getByRole("switch", { name: /Everything/ })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(files.hasAttribute("disabled")).toBe(true);
    held.release();
    await waitFor(() => expect(part.querySelector("[aria-busy]")?.getAttribute("aria-busy")).toBe("false"));
    expect(server.connections.grants.get("agt_scout")).toEqual([{ connectionId: "", scope: "drive:read" }]);
  });

  test("the box keeps the focus once the change is saved", async () => {
    const stop = blurOnDisable();
    try {
      const server = newServer();
      const app = await renderApp({ path: tab("agt_scout"), signedInAs: "usr_jonas", server });
      const files = await within(await reach()).findByRole("checkbox", { name: "Read in Files" });
      await app.user.click(files);
      await waitFor(() => expect(files.getAttribute("aria-checked")).toBe("true"));
      await waitFor(() => expect(document.activeElement === files).toBe(true));
    } finally {
      stop();
    }
  });
});

describe("the fake server's access rules, as the server's", () => {
  const statusOf = async (call: () => Promise<unknown>) => {
    try {
      await call();
      return "ok";
    } catch (error) {
      const { status, code } = error as { status?: number; code?: string };
      return `${status} ${code}`;
    }
  };

  test("someone who doesn't manage agents is refused before the agent is looked up", async () => {
    const { runtime } = newTestRuntime({ path: "/", signedInAs: "usr_iris" });
    const { client } = runtime.api;
    expect(
      await statusOf(() =>
        client.call("setAgentScopes", { workspaceId: WS, agentId: "agt_nobody", body: { scopes: [] } }),
      ),
    ).toBe("403 forbidden");
    expect(
      await statusOf(() =>
        client.call("setAgentAccess", { workspaceId: WS, agentId: "agt_nobody", body: { all: true } }),
      ),
    ).toBe("403 forbidden");
  });

  test("a rule on one tool takes a name of up to 96 characters", async () => {
    const { runtime, server } = newTestRuntime({ path: "/", signedInAs: "usr_jonas" });
    const { client } = runtime.api;
    const rule = (scope: string) => () =>
      client.call("setAgentScopes", {
        workspaceId: WS,
        agentId: "agt_scout",
        body: { scopes: [{ connectionId: "", scope }] },
      });
    expect(await statusOf(rule(`deny:${"a".repeat(96)}`))).toBe("ok");
    expect(await statusOf(rule(`tool:${"a".repeat(97)}`))).toBe("400 access.unknown_scope");
    expect(server.connections.grants.get("agt_scout")).toEqual([
      { connectionId: "", scope: `deny:${"a".repeat(96)}` },
    ]);
  });
});
