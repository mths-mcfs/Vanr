// The Usage section against the real server. A member is kept out and refused by the server. An owner
// with two agents reads the month: nothing spent yet (the journeys' model costs nothing), the workspace's
// budget as the sum of the two agents' default budgets, and each agent on the default. Lowering the
// default lowers the workspace's budget, and it holds after a reload.
import { expect, test } from "./fixtures.ts";

test("a member is kept out of usage, and the server refuses the report", async ({
  page,
  t,
  seedUser,
  signIn,
}) => {
  const owner = await seedUser({ workspace: "Usage Closed Journey" });
  const member = await seedUser({ joins: { by: owner } });
  await signIn(member);
  await page.goto(`/workspace/${owner.workspace.id}/settings/usage`);
  await expect(page.getByText(t("shell", "settings.locked.title"))).toBeVisible();
  const sections = page.getByRole("navigation", { name: t("shell", "settings.sections") });
  await expect(sections.getByRole("link", { name: t("shell", "settings.usage") })).toHaveCount(0);
  const refused = await page.request.get(`/api/v1/workspaces/${owner.workspace.id}/usage/report`);
  expect(refused.status()).toBe(403);
});

test("an owner reads the month's usage and lowers the default agent budget", async ({
  page,
  t,
  seedUser,
  signIn,
  apiAs,
}) => {
  const owner = await seedUser({ workspace: "Usage Journey" });
  const api = await apiAs(owner);
  const workspaceId = owner.workspace.id;
  for (const [name, handle] of [
    ["Night Clerk", "night-clerk"],
    ["Day Clerk", "day-clerk"],
  ]) {
    const created = await api.post(`/api/v1/workspaces/${workspaceId}/agents`, {
      data: { name, handle, role: "operations" },
    });
    expect(created.ok()).toBe(true);
  }
  const settings = (await (await api.get(`/api/v1/workspaces/${workspaceId}/settings`)).json()) as {
    agentBudgetDefaultUsd: number;
  };
  const locale = test.info().project.name === "pt-BR" ? "pt-BR" : "en-US";
  const usd = (value: number) =>
    new Intl.NumberFormat(locale, { style: "currency", currency: "USD" }).format(value);

  await signIn(owner);
  await page.goto(`/workspace/${workspaceId}/settings/usage`);
  const month = page.getByRole("region", { name: t("control", "use.title") });
  await expect(
    month.getByText(t("control", "use.ofBudget", { budget: usd(settings.agentBudgetDefaultUsd * 2) })),
  ).toBeVisible();
  await expect(month.getByText(t("control", "use.nothingYet"))).toBeVisible();
  await expect(month.getByText(t("control", "use.whereFrom", { count: 2 }))).toBeVisible();
  const agents = month.getByRole("list", { name: t("control", "use.byAgent") });
  for (const name of ["Day Clerk", "Night Clerk"]) {
    await expect(agents.getByRole("listitem").filter({ hasText: name })).toContainText(
      t("control", "use.agentDefault", { budget: usd(settings.agentBudgetDefaultUsd) }),
    );
  }

  const form = page.getByRole("form", { name: t("control", "use.defaultTitle") });
  const field = form.getByLabel(t("control", "use.defaultField"));
  await field.fill(locale === "pt-BR" ? "7,50" : "7.50");
  await form.getByRole("button", { name: t("control", "use.defaultSave") }).click();
  await expect(
    page.getByText(t("control", "use.defaultSaved", { budget: usd(7.5) }), { exact: true }),
  ).toBeVisible();
  await expect(month.getByText(t("control", "use.ofBudget", { budget: usd(15) }))).toBeVisible();

  await page.reload();
  await expect(month.getByText(t("control", "use.ofBudget", { budget: usd(15) }))).toBeVisible();
  const saved = (await (await api.get(`/api/v1/workspaces/${workspaceId}/settings`)).json()) as {
    agentBudgetDefaultUsd: number;
  };
  expect(saved.agentBudgetDefaultUsd).toBe(7.5);
});
