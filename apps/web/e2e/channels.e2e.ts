// Channels end to end, against the real server: someone makes a public channel and another person
// finds it and joins; someone makes a private one and adds a person, who finds it after a reload; a
// message is pinned and unpinned; a person leaves a private channel and it is gone for them.
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

  test("a message pinned to the channel shows among the pinned, and leaves them once unpinned", async ({
    page,
    t,
    seedUser,
    signIn,
    apiAs,
  }) => {
    const owner = await seedUser({ workspace: "Pins Journey" });
    const api = await apiAs(owner);
    const base = `/api/v1/workspaces/${owner.workspace.id}`;
    const { channels } = (await (await api.get(`${base}/channels`)).json()) as {
      channels: { id: string; isGeneral: boolean }[];
    };
    const general = channels.find((channel) => channel.isGeneral)?.id ?? "";
    const posted = await api.post(`${base}/channels/${general}/messages`, {
      data: { body: "Kiln B runs hot on Fridays", clientId: `pin-${Date.now().toString(36)}` },
    });
    expect(posted.ok()).toBe(true);

    await signIn(owner);
    await page.goto(`/workspace/${owner.workspace.id}/channel/${general}`);
    const message = page.getByRole("article").filter({ hasText: "Kiln B runs hot on Fridays" });
    await message.hover();
    const toggle = message.getByRole("button", { name: t("chat", "tools.pin") });
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: t("chat", "pins.button"), exact: true }).click();
    const pins = page.getByRole("dialog", { name: t("chat", "pins.title") });
    await expect(pins.getByText("Kiln B runs hot on Fridays")).toBeVisible();
    await page.keyboard.press("Escape");

    await message.hover();
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await page.getByRole("button", { name: t("chat", "pins.button"), exact: true }).click();
    await expect(pins.getByText(t("chat", "pins.empty"))).toBeVisible();
  });

  test("leaving a private channel takes the person home, and it is gone for them", async ({
    page,
    t,
    seedUser,
    signIn,
  }) => {
    const owner = await seedUser({ workspace: "Leave Journey" });
    const member = await seedUser({ joins: { by: owner } });
    await signIn(owner);
    await page.goto(`/workspace/${owner.workspace.id}`);
    const sidebar = page.getByRole("complementary");
    await sidebar.getByRole("button", { name: t("chat", "make.open") }).click();
    const make = page.getByRole("dialog", { name: t("chat", "make.title") });
    await make.getByRole("textbox", { name: t("chat", "make.name") }).fill("ledger-room");
    await make.getByRole("radio", { name: new RegExp(t("chat", "make.private")) }).click();
    await make.getByRole("button", { name: t("chat", "make.go") }).click();
    await expect(page.getByRole("heading", { name: /ledger-room/ })).toBeVisible();
    const address = page.url();
    await page.getByRole("button", { name: t("chat", "people.buttonCount", { count: 1 }) }).click();
    const people = page.getByRole("dialog", { name: t("chat", "people.title", { channel: "ledger-room" }) });
    await people.getByRole("searchbox", { name: t("chat", "people.add") }).fill(member.name);
    await people.getByRole("button", { name: t("chat", "people.addNamed", { name: member.name }) }).click();
    await expect(
      people.getByRole("list", { name: t("chat", "people.list") }).getByText(member.name),
    ).toBeVisible();

    await signIn(member);
    await page.goto(address);
    await expect(page.getByRole("heading", { name: /ledger-room/ })).toBeVisible();
    await page.getByRole("button", { name: t("chat", "people.buttonCount", { count: 2 }) }).click();
    const mine = page.getByRole("dialog", { name: t("chat", "people.title", { channel: "ledger-room" }) });
    await mine.getByRole("button", { name: t("chat", "people.leave") }).click();
    await expect(page).toHaveURL(new RegExp(`/workspace/${owner.workspace.id}$`));
    await expect(sidebar.getByRole("link", { name: /ledger-room/ })).toHaveCount(0);
    await page.goto(address);
    await expect(page.getByRole("heading", { name: /ledger-room/ })).toHaveCount(0);
  });
});
