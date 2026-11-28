// An agent's access against the real server. The workspace has one connection, an MCP server of its own
// (a double on a local port). An owner gives an agent read access to it in the settings' Access matrix,
// follows the agent's name to its Access tab, sees the same level there, and turns every connection off
// for the agent in #general. After a reload the rule and the level are both still there.
import { expect, test } from "./fixtures.ts";
import { type McpDouble, startMcpDouble } from "./mcp-double.ts";

let double: McpDouble;
test.beforeEach(async () => {
  double = await startMcpDouble([
    { name: "lookup_invoice", description: "Finds an invoice", readOnly: true },
  ]);
});
test.afterEach(async () => {
  await double.stop();
});

test("an owner sets an agent's access to a connection and its channel access", async ({
  page,
  t,
  seedUser,
  signIn,
  apiAs,
}) => {
  const owner = await seedUser({ workspace: "Agent Reach Journey" });
  const api = await apiAs(owner);
  const workspaceId = owner.workspace.id;
  const channels = (await (await api.get(`/api/v1/workspaces/${workspaceId}/channels`)).json()) as {
    channels: { id: string; isGeneral: boolean }[];
  };
  const general = channels.channels.find((channel) => channel.isGeneral);
  if (general === undefined) throw new Error("the workspace has no #general");
  const created = await api.post(`/api/v1/workspaces/${workspaceId}/agents`, {
    data: { name: "Invoice Clerk", handle: "invoice-clerk", role: "finance", channelIds: [general.id] },
  });
  expect(created.ok()).toBe(true);
  const { id: agentId } = (await created.json()) as { id: string };
  const server = await api.post(`/api/v1/workspaces/${workspaceId}/connectors/custom`, {
    data: { serverUrl: double.url, label: "Ledger tools", nextPath: "/" },
  });
  expect(server.ok()).toBe(true);
  const started = (await server.json()) as { status: string; server?: { id: string } };
  expect(started.status).toBe("server");
  const serverId = started.server?.id ?? "";

  await signIn(owner);
  await page.goto(`/workspace/${workspaceId}/settings/access`);
  const grid = page.getByRole("table", { name: t("control", "grid.title") });
  await expect(grid.getByRole("columnheader", { name: "Ledger tools" })).toBeVisible();
  const level = grid.getByRole("combobox", {
    name: t("control", "grid.levelFor", { agent: "Invoice Clerk", connection: "Ledger tools" }),
  });
  await expect(level).toHaveText(t("control", "grid.level.none"));
  await level.click();
  await page.getByRole("option", { name: t("control", "grid.level.read"), exact: true }).click();
  await expect(level).toHaveText(t("control", "grid.level.read"));
  const scopes = (await (
    await api.get(`/api/v1/workspaces/${workspaceId}/agents/${agentId}/scopes`)
  ).json()) as {
    scopes: { connectionId: string; scope: string }[];
  };
  expect(scopes.scopes).toEqual([{ connectionId: serverId, scope: `custom:${serverId}:read` }]);

  await grid.getByRole("link", { name: "Invoice Clerk" }).click();
  const reach = page.getByRole("region", { name: t("agents", "reach.title") });
  await expect(
    reach.getByRole("combobox", { name: t("agents", "reach.levelOf", { connection: "Ledger tools" }) }),
  ).toHaveText(t("agents", "reach.level.read"));

  const add = page.getByRole("form", { name: t("agents", "access.addRule") });
  await add.getByRole("combobox", { name: t("agents", "access.channel") }).click();
  await page.getByRole("option", { name: "#general" }).click();
  await add.getByRole("combobox", { name: t("agents", "access.level") }).click();
  await page.getByRole("option", { name: t("agents", "access.level.off") }).click();
  await add.getByRole("button", { name: t("agents", "access.addRule") }).click();
  await expect(page.getByText(t("agents", "access.ruleSaved"), { exact: true })).toBeVisible();

  await page.reload();
  const rules = page.getByRole("list", { name: t("agents", "access.rules") });
  await expect(rules.getByRole("listitem")).toHaveCount(1);
  await expect(rules).toContainText("#general");
  await expect(rules).toContainText(t("agents", "access.allConnections"));
  await expect(rules).toContainText(t("agents", "access.level.off"));
  await expect(
    page
      .getByRole("region", { name: t("agents", "reach.title") })
      .getByRole("combobox", { name: t("agents", "reach.levelOf", { connection: "Ledger tools" }) }),
  ).toHaveText(t("agents", "reach.level.read"));
});
