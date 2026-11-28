// Channels end to end, against the real server: someone makes a public channel and another person
// finds it and joins; someone makes a private one and adds a person, who finds it after a reload.
import { expect, test } from "./fixtures.ts";

test.describe("channels", () => {
  test("a public channel made by one person is found and joined by another", async ({
    page,
    t,
    seedUser,
    signIn,
  }) => {
    const owner = await seedUser({ workspace: "Channels Journey" });
    const member = await seedUser({ joins: { by: owner } });
    await signIn(owner);
    await page.goto(`/workspace/${owner.workspace.id}`);
    const sidebar = page.getByRole("complementary");
    await sidebar.getByRole("button", { name: t("chat", "make.open") }).click();
    const make = page.getByRole("dialog", { name: t("chat", "make.title") });
    await make.getByRole("textbox", { name: t("chat", "make.name") }).fill("Glaze Lab");
    await expect(make.getByText(t("chat", "make.preview", { name: "glaze-lab" }))).toBeVisible();
    await make.getByRole("button", { name: t("chat", "make.go") }).click();
    await expect(page.getByRole("heading", { name: /glaze-lab/ })).toBeVisible();

    await signIn(member);
    await page.goto(`/workspace/${owner.workspace.id}`);
    await sidebar.getByRole("button", { name: t("chat", "find.openList") }).click();
    const browse = page.getByRole("dialog", { name: t("chat", "find.title") });
    await browse.getByRole("button", { name: t("chat", "find.joinNamed", { channel: "glaze-lab" }) }).click();
    await expect(page.getByRole("heading", { name: /glaze-lab/ })).toBeVisible();
    await expect(
      page.getByRole("textbox", { name: t("chat", "composer.hintChannel", { channel: "glaze-lab" }) }),
    ).toBeVisible();
    await expect(sidebar.getByRole("link", { name: /glaze-lab/ })).toBeVisible();
  });

  test("a private channel shows to a person once they are added", async ({ page, t, seedUser, signIn }) => {
    const owner = await seedUser({ workspace: "Private Channels Journey" });
    const member = await seedUser({ joins: { by: owner } });
    await signIn(owner);
    await page.goto(`/workspace/${owner.workspace.id}`);
    const sidebar = page.getByRole("complementary");
    await sidebar.getByRole("button", { name: t("chat", "make.open") }).click();
    const make = page.getByRole("dialog", { name: t("chat", "make.title") });
    await make.getByRole("textbox", { name: t("chat", "make.name") }).fill("payroll");
    await make.getByRole("radio", { name: new RegExp(t("chat", "make.private")) }).click();
    await make.getByRole("button", { name: t("chat", "make.go") }).click();
    await expect(page.getByRole("heading", { name: /payroll/ })).toBeVisible();

    await page.getByRole("button", { name: t("chat", "people.buttonCount", { count: 1 }) }).click();
    const people = page.getByRole("dialog", { name: t("chat", "people.title", { channel: "payroll" }) });
    await people.getByRole("searchbox", { name: t("chat", "people.add") }).fill(member.name);
    await people.getByRole("button", { name: t("chat", "people.addNamed", { name: member.name }) }).click();
    await expect(
      people.getByRole("list", { name: t("chat", "people.list") }).getByText(member.name),
    ).toBeVisible();

    await signIn(member);
    await page.goto(`/workspace/${owner.workspace.id}`);
    await expect(sidebar.getByRole("link", { name: /payroll/ })).toBeVisible();
    await sidebar.getByRole("link", { name: /payroll/ }).click();
    await expect(page.getByRole("heading", { name: /payroll/ })).toBeVisible();
  });
});
