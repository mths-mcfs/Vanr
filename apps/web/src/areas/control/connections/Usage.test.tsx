// The Usage section of the settings, against the fake server. Birchwood has Scout, Ledger and Tally, each
// on the workspace's default of $20 a month. Jonas is an admin there, Íris a member.
import { describe, expect, test } from "bun:test";
import { screen, within } from "@testing-library/react";
import { newServer, renderApp } from "../../../../test/app.tsx";

const WS = "workspace_birchwood";
const PATH = `/workspace/${WS}/settings/usage`;

const spending = () => {
  const server = newServer();
  server.usage.push(
    { workspaceId: WS, agentId: "agt_scout", kind: "model", calls: 10, costUsd: 12.5 },
    { workspaceId: WS, agentId: null, kind: "search", calls: 3, costUsd: 1.2 },
    { workspaceId: WS, agentId: null, kind: "embedding", calls: 40, costUsd: 0.5 },
  );
  return server;
};
const month = () => screen.findByRole("region", { name: "This month" });

describe("usage", () => {
  test("a member is kept out of the section", async () => {
    await renderApp({ path: PATH, signedInAs: "usr_iris" });
    expect(await screen.findByText("This section is for admins")).toBeDefined();
    expect(screen.queryByRole("region", { name: "This month" }) === null).toBe(true);
  });

  test("an admin reads the month against the budget; the search index shows but doesn't count", async () => {
    await renderApp({ path: PATH, signedInAs: "usr_jonas", server: spending() });
    const part = await month();
    expect(await within(part).findByText("$13.70")).toBeDefined();
    expect(within(part).getByText("of $60.00")).toBeDefined();
    expect(within(part).getByText("23% of the budget is spent.")).toBeDefined();
    expect(
      within(part).getByText("$14.20 in all, with $0.50 for the search index, which this server pays."),
    ).toBeDefined();
    expect(within(part).getByText(/sum of the monthly budgets of its 3 active agents/)).toBeDefined();
    expect(
      within(part)
        .getByRole("meter", { name: "Share of the workspace's budget spent" })
        .getAttribute("aria-valuenow"),
    ).toBe("23");
    const kinds = within(part).getByRole("list", { name: "By kind" });
    const rows = within(kinds)
      .getAllByRole("listitem")
      .map((item) => item.textContent);
    expect(rows).toEqual([
      "Agents' runs10 calls$12.50",
      "Search index40 calls Not counted in the budget.$0.50",
      "Search answers3 calls$1.20",
    ]);
    const agents = within(part).getByRole("list", { name: "By agent" });
    const scout = within(agents)
      .getAllByRole("listitem")
      .find((item) => item.textContent?.includes("Scout"));
    expect(scout?.textContent).toContain("of $20.00, the default");
    expect(scout?.textContent).toContain("$12.50");
    expect(
      within(scout as HTMLElement)
        .getByRole("meter", { name: "Share of Scout's budget spent" })
        .getAttribute("aria-valuenow"),
    ).toBe("63");
    expect(
      within(scout as HTMLElement)
        .getByRole("link", { name: "Scout" })
        .getAttribute("href"),
    ).toBe(`/workspace/${WS}/agents/agt_scout`);
  });

  test("an agent's own budget reads as its own, and a spent budget says what stops", async () => {
    const server = newServer();
    server.agentBudgets.set("agt_ledger", 5);
    server.usage.push({ workspaceId: WS, agentId: "agt_ledger", kind: "model", calls: 2, costUsd: 46 });
    await renderApp({ path: PATH, signedInAs: "usr_jonas", server });
    const part = await month();
    expect(
      await within(part).findByText(/The budget is spent\. Search answers, wiki checks and agent drafts/),
    ).toBeDefined();
    expect(
      within(part)
        .getByRole("meter", { name: "Share of the workspace's budget spent" })
        .getAttribute("data-tone"),
    ).toBe("over");
    const ledger = within(within(part).getByRole("list", { name: "By agent" }))
      .getAllByRole("listitem")
      .find((item) => item.textContent?.includes("Ledger"));
    expect(ledger?.textContent).toContain("of $5.00, its own");
  });

  test("an amount under a cent is not shown as nothing", async () => {
    const server = newServer();
    server.usage.push({ workspaceId: WS, agentId: null, kind: "wiki", calls: 1, costUsd: 0.004 });
    await renderApp({ path: PATH, signedInAs: "usr_jonas", server });
    const kinds = within(await month()).getByRole("list", { name: "By kind" });
    expect(await within(kinds).findByText("under $0.01")).toBeDefined();
    expect(within(kinds).getByText("Wiki checks")).toBeDefined();
  });

  test("a month with nothing spent says so", async () => {
    await renderApp({ path: PATH, signedInAs: "usr_jonas" });
    expect(await within(await month()).findByText("Nothing spent yet this month.")).toBeDefined();
    expect(within(await month()).getByText("0% of the budget is spent.")).toBeDefined();
  });

  test("a report that fails to load offers a retry", async () => {
    const server = spending();
    server.force("getUsageReport", { kind: "error", status: 500, code: "internal" }, 4);
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas", server });
    expect(await screen.findByText("The usage could not be loaded")).toBeDefined();
    server.unforce("getUsageReport");
    await app.user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await within(await month()).findByText("$13.70")).toBeDefined();
  });
});

describe("the default agent budget", () => {
  const form = () => screen.findByRole("form", { name: "Default agent budget" });

  test("an admin changes it, and the workspace's budget follows", async () => {
    const server = spending();
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas", server });
    const field = within(await form()).getByLabelText(/^Per agent, per month/);
    expect((field as HTMLInputElement).value).toBe("20");
    await app.user.clear(field);
    await app.user.type(field, "10,000");
    expect(within(await form()).getByText("An amount from 0 to $100,000.00, such as 12.50.")).toBeDefined();
    expect(
      within(await form())
        .getByRole("button", { name: "Save default" })
        .hasAttribute("disabled"),
    ).toBe(true);
    await app.user.clear(field);
    await app.user.type(field, "12.50");
    await app.user.click(within(await form()).getByRole("button", { name: "Save default" }));
    expect(await screen.findByText("New agents now get $12.50 a month.")).toBeDefined();
    expect(
      app.server.calls.find((call) => call.method === "updateSettings")?.params.agentBudgetDefaultUsd,
    ).toBe(12.5);
    expect(await within(await month()).findByText("of $37.50")).toBeDefined();
  });

  test("with no active agents the workspace's budget is one agent's default", async () => {
    const server = newServer();
    for (const agent of server.agents) agent.archivedAt = "2026-11-01T00:00:00.000Z";
    await renderApp({ path: PATH, signedInAs: "usr_jonas", server });
    const part = await month();
    expect(await within(part).findByText("of $20.00")).toBeDefined();
    expect(
      within(part).getByText(/With no active agents, the workspace's budget is one agent's default budget/),
    ).toBeDefined();
    expect(within(part).getByText("No active agents")).toBeDefined();
  });
});
