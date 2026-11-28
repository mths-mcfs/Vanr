// The Connectors section against the real server. A member is kept out of it. An owner adds an MCP
// server of the workspace's own (a double on a local port with one tool that only reads and one that
// moves money), reviews the access the server suggests for each tool, changes one, and saves. After a
// reload the server still lists the decisions.
import { expect, test } from "./fixtures.ts";
import { type McpDouble, startMcpDouble } from "./mcp-double.ts";

let double: McpDouble;
test.beforeEach(async () => {
  double = await startMcpDouble([
    { name: "lookup_invoice", description: "Finds an invoice by number", readOnly: true },
    { name: "refund_invoice", description: "Refunds an invoice" },
  ]);
});
test.afterEach(async () => {
  await double.stop();
});

test("a member is not offered the connectors and the server refuses their changes", async ({
  page,
  t,
  seedUser,
  signIn,
}) => {
  const owner = await seedUser({ workspace: "Connectors Closed Journey" });
  const member = await seedUser({ joins: { by: owner } });
  await signIn(member);
  await page.goto(`/workspace/${owner.workspace.id}/settings/connectors`);
  await expect(page.getByText(t("shell", "settings.locked.title"))).toBeVisible();
  const sections = page.getByRole("navigation", { name: t("shell", "settings.sections") });
  await expect(sections.getByRole("link", { name: t("shell", "settings.general") })).toBeVisible();
  await expect(sections.getByRole("link", { name: t("shell", "settings.connectors") })).toHaveCount(0);
  await expect(page.getByRole("list", { name: t("control", "svc.title") })).toHaveCount(0);
  const refused = await page.request.post(`/api/v1/workspaces/${owner.workspace.id}/connectors/custom`, {
    data: { serverUrl: double.url, nextPath: "/" },
  });
  expect(refused.status()).toBe(403);
});

test("an owner adds an MCP server, reviews what each tool may do, and the decision holds", async ({
  page,
  t,
  seedUser,
  signIn,
  apiAs,
}) => {
  const owner = await seedUser({ workspace: "Connectors Journey" });
  await signIn(owner);
  await page.goto(`/workspace/${owner.workspace.id}/settings/connectors`);
  const mine = page.getByRole("region", { name: t("control", "mcp.title") });
  await expect(mine.getByText(t("control", "mcp.none"))).toBeVisible();
  await expect(page.getByRole("list", { name: t("control", "svc.title") })).toBeVisible();

  await mine.getByRole("button", { name: t("control", "mcp.add") }).click();
  const add = page.getByRole("dialog", { name: t("control", "mcp.addTitle") });
  await add.getByLabel(t("control", "mcp.address")).fill(double.url);
  await add.getByLabel(t("control", "mcp.name")).fill("Ledger tools");
  await add.getByRole("button", { name: t("control", "mcp.addAction") }).click();

  const review = page.getByRole("dialog", {
    name: t("control", "mcp.reviewTitle", { name: "Ledger tools" }),
  });
  const tools = review.getByRole("list", { name: t("control", "mcp.tools") });
  const lookup = tools.getByRole("listitem").filter({ hasText: "lookup_invoice" });
  const refund = tools.getByRole("listitem").filter({ hasText: "refund_invoice" });
  await expect(lookup).toContainText(
    t("control", "mcp.suggested", { level: t("control", "mcp.access.read") }),
  );
  await expect(refund).toContainText(
    t("control", "mcp.suggested", { level: t("control", "mcp.access.approval") }),
  );
  await refund
    .getByRole("combobox", { name: t("control", "mcp.toolAccessFor", { tool: "refund_invoice" }) })
    .click();
  await page.getByRole("option", { name: t("control", "mcp.access.off") }).click();
  await review.getByRole("button", { name: t("control", "mcp.save") }).click();
  await expect(page.getByText(t("control", "mcp.saved", { name: "Ledger tools" }))).toBeVisible();
  await expect(review).toHaveCount(0);

  await page.reload();
  const listed = page
    .getByRole("list", { name: t("control", "mcp.title") })
    .getByRole("listitem")
    .filter({ hasText: "Ledger tools" });
  await expect(listed).toContainText(t("control", "mcp.toolCount", { count: 2 }));
  await expect(listed).not.toContainText(t("control", "mcp.waiting", { count: 2 }));

  const api = await apiAs(owner);
  const saved = (await (
    await api.get(`/api/v1/workspaces/${owner.workspace.id}/connectors/custom`)
  ).json()) as {
    servers: { label: string; tools: { name: string; access: string; confirmed: boolean }[] }[];
  };
  expect(saved.servers.map((server) => server.label)).toEqual(["Ledger tools"]);
  expect(saved.servers[0]?.tools.map((tool) => [tool.name, tool.access, tool.confirmed])).toEqual([
    ["lookup_invoice", "read", true],
    ["refund_invoice", "off", true],
  ]);
});
