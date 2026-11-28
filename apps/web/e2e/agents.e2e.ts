// Agents end to end, against the real server and its runtime with the fake model: create an agent,
// test new instructions in the lab, and turn one of its runs into a workspace skill.
import type { APIRequestContext } from "@playwright/test";
import { expect, test } from "./fixtures.ts";

/** An agent made through the API, in the workspace's #general. */
async function createAgent(api: APIRequestContext, workspaceId: string, name: string, handle: string) {
  const channels = await api.get(`/api/v1/workspaces/${workspaceId}/channels`);
  expect(channels.ok()).toBe(true);
  const { channels: list } = (await channels.json()) as { channels: { id: string; isGeneral: boolean }[] };
  const general = list.find((channel) => channel.isGeneral);
  if (general === undefined) throw new Error("the workspace has no #general");
  const created = await api.post(`/api/v1/workspaces/${workspaceId}/agents`, {
    data: { name, handle, role: "assistant", channelIds: [general.id] },
  });
  expect(created.ok()).toBe(true);
  const agent = (await created.json()) as { id: string };
  return { agentId: agent.id, generalId: general.id };
}

test("an owner creates an agent step by step, and a member sees it after a reload", async ({
  page,
  t,
  seedUser,
  signIn,
}) => {
  const owner = await seedUser({ workspace: "Agent Journey" });
  const member = await seedUser({ joins: { by: owner } });
  await signIn(owner);
  await page.goto(`/workspace/${owner.workspace.id}/agents`);
  await expect(page.getByText(t("agents", "team.empty.title"))).toBeVisible();
  await page.getByRole("button", { name: t("agents", "team.add") }).click();

  const step = (name: string, at: number) =>
    page.getByRole("form", { name: t("agents", "new.stepOf", { at, total: 6, step: name }) });
  const next = () => page.getByRole("button", { name: t("agents", "new.next") }).click();

  await expect(step(t("agents", "new.step.role"), 1)).toBeVisible();
  await page.getByRole("button", { name: new RegExp(`^${t("agents", "role.support")}`) }).click();
  await next();
  await page.getByLabel(t("agents", "field.name"), { exact: true }).fill("Harbor Bot");
  await expect(page.getByLabel(t("agents", "field.handle"))).toHaveValue("harbor-bot");
  await next();
  await page
    .getByRole("textbox", { name: t("agents", "field.instructions") })
    .fill("Answer about the harbor.");
  await next();
  await expect(page.getByRole("checkbox", { name: "#general" })).toBeChecked();
  await next();
  await expect(page.getByRole("combobox", { name: t("agents", "field.model") })).not.toBeEmpty();
  await next();
  const summary = page.getByLabel(t("agents", "new.summary"));
  await expect(summary).toContainText("@harbor-bot");
  await expect(summary).toContainText("#general");
  await page.getByRole("button", { name: t("agents", "new.create") }).click();
  await expect(
    page.getByRole("heading", { name: t("agents", "new.created", { name: "Harbor Bot" }) }),
  ).toBeVisible();

  await signIn(member);
  await page.goto(`/workspace/${owner.workspace.id}/agents`);
  const group = page.getByRole("list", { name: t("agents", "team.owner", { name: owner.name }) });
  await expect(group.getByRole("listitem").filter({ hasText: "Harbor Bot" })).toContainText("@harbor-bot");
  // A member sees the profile but not the controls of whoever manages agents.
  await group.getByRole("button", { name: "Harbor Bot" }).click();
  await page.getByRole("link", { name: t("agents", "card.profile") }).click();
  await page.getByRole("tab", { name: t("agents", "tab.instructions") }).click();
  await expect(page.getByRole("textbox", { name: t("agents", "field.instructions") })).toHaveValue(
    "Answer about the harbor.",
  );
  await expect(page.getByText(t("agents", "instructions.adminOnly"))).toBeVisible();
  await expect(page.getByRole("button", { name: t("agents", "team.add") })).toHaveCount(0);
});

test("an owner tests new instructions in the lab with the fake model", async ({
  page,
  t,
  seedUser,
  signIn,
  apiAs,
}) => {
  const owner = await seedUser({ workspace: "Lab Journey" });
  const { agentId } = await createAgent(await apiAs(owner), owner.workspace.id, "Tide Teller", "tide-teller");
  await signIn(owner);
  await page.goto(`/workspace/${owner.workspace.id}/agents/${agentId}?tab=lab`);
  await expect(page.getByText(t("agents", "lab.casesEmpty"))).toBeVisible();
  await page.getByLabel(t("agents", "lab.input")).fill("Say hello to the harbor");
  await page.getByLabel(t("agents", "lab.mustInclude")).fill("hello");
  await page.getByLabel(t("agents", "lab.mustNotInclude")).fill("goodbye");
  await page.getByRole("button", { name: t("agents", "lab.add") }).click();
  const cases = page.getByRole("list", { name: t("agents", "lab.cases") });
  await expect(cases).toContainText("Say hello to the harbor");
  await expect(page.getByText(t("agents", "lab.count", { count: 1, max: 50 }))).toBeVisible();

  await page.getByLabel(t("agents", "lab.candidate")).fill("Greet everyone warmly.");
  await page.getByRole("button", { name: t("agents", "lab.run") }).click();
  // Followed until it ends: the fake model repeats the prompt, so both sides pass.
  await expect(page.getByText(t("agents", "lab.summary", { before: 1, after: 1, cases: 1 }))).toBeVisible({
    timeout: 20_000,
  });
  const results = page.getByRole("region", { name: t("agents", "lab.result") });
  await expect(results.getByRole("region", { name: t("agents", "lab.after") })).toContainText(
    t("agents", "lab.pass"),
  );
});

test("an owner turns an agent's run into a skill and turns it on for the agent", async ({
  page,
  t,
  seedUser,
  signIn,
  apiAs,
}) => {
  const owner = await seedUser({ workspace: "Skill Journey" });
  const api = await apiAs(owner);
  const workspaceId = owner.workspace.id;
  const { agentId, generalId } = await createAgent(api, workspaceId, "Shelf Keeper", "shelf-keeper");
  const posted = await api.post(`/api/v1/workspaces/${workspaceId}/channels/${generalId}/messages`, {
    data: { body: "@shelf-keeper count the shelves", clientId: `skill-${Date.now()}` },
  });
  expect(posted.ok()).toBe(true);
  // The real runtime answers with the fake model; the run ends on its own.
  await expect
    .poll(
      async () => {
        const answer = await api.get(`/api/v1/workspaces/${workspaceId}/runs?agentId=${agentId}`);
        const { runs } = (await answer.json()) as { runs: { status: string }[] };
        return runs[0]?.status;
      },
      { timeout: 20_000 },
    )
    .toBe("done");

  await signIn(owner);
  await page.goto(`/workspace/${workspaceId}/agents/${agentId}?tab=activity`);
  const runs = page.getByRole("list", { name: t("agents", "activity.title") });
  await expect(runs.getByRole("listitem").first()).toContainText(t("agents", "run.done"));
  await runs
    .getByRole("button", { name: t("agents", "saveSkill.action") })
    .first()
    .click();
  const dialog = page.getByRole("dialog", { name: t("agents", "saveSkill.title") });
  await expect(dialog.getByText(t("agents", "saveSkill.testModel"))).toBeVisible();
  const name = dialog.getByLabel(t("agents", "skill.name"));
  await expect(name).not.toHaveValue("");
  await name.fill("Shelf count");
  await dialog.getByRole("button", { name: t("agents", "saveSkill.save") }).click();
  await expect(
    page.getByText(t("agents", "saveSkill.saved", { name: "Shelf count" }), { exact: true }),
  ).toBeVisible();
  await dialog
    .getByRole("button", { name: t("agents", "saveSkill.enable", { name: "Shelf Keeper" }) })
    .click();
  await expect(dialog).toHaveCount(0);

  await page.getByRole("tab", { name: t("agents", "tab.skills") }).click();
  await expect(
    page
      .getByRole("list", { name: t("agents", "agentSkills.title") })
      .getByRole("switch", { name: /Shelf count/ }),
  ).toBeChecked();
  await page.goto(`/workspace/${workspaceId}/skills`);
  await expect(page.getByRole("list", { name: t("shell", "route.skills") })).toContainText("Shelf count");
});
