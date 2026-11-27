// The bases journey: a person makes a Tasks base with hours, then a Projects base whose rows link to
// tasks through a relation and add up their hours with a rollup. It checks what the person sees, in the
// project's language.
import type { Page } from "@playwright/test";
import { expect, type Text, test } from "./fixtures.ts";

async function newBase(page: Page, t: Text, title: string) {
  await page
    .getByRole("button", { name: t("files", "bases.new") })
    .first()
    .click();
  const dialog = page.getByRole("dialog", { name: t("files", "bases.new") });
  await dialog.getByRole("textbox", { name: t("files", "bases.name") }).fill(title);
  await dialog.getByRole("button", { name: t("files", "bases.create") }).click();
  await expect(page.getByRole("button", { name: t("files", "base.rename", { title }) })).toBeVisible();
}

async function newProperty(
  page: Page,
  t: Text,
  name: string,
  type: string,
  fill?: (dialog: ReturnType<Page["getByRole"]>) => Promise<void>,
) {
  await page.getByRole("button", { name: t("files", "property.new") }).click();
  const dialog = page.getByRole("dialog", { name: t("files", "property.new") });
  await dialog.getByRole("textbox", { name: t("files", "property.name") }).fill(name);
  await dialog.getByRole("combobox", { name: t("files", "property.type") }).selectOption({ label: type });
  await fill?.(dialog);
  await dialog.getByRole("button", { name: t("files", "property.save") }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("button", { name: t("files", "property.editNamed", { name }) })).toBeVisible();
}

const cell = (t: Text, prop: string, row: string) => t("files", "cell.label", { prop, row });

test("bases: a relation links projects to tasks and a rollup adds up their hours", async ({
  page,
  t,
  seedUser,
  signIn,
}) => {
  const user = await seedUser({ workspace: "Laundry" });
  await signIn(user);
  await page.goto(`/workspace/${user.workspace.id}/bases`);
  await expect(page.getByRole("heading", { level: 1, name: t("files", "bases.title") })).toBeVisible();
  await expect(page.getByText(t("files", "bases.empty.title"))).toBeVisible();

  await newBase(page, t, "Tasks");
  await newProperty(page, t, "Hours", t("files", "type.number"));
  const grid = page.getByRole("table");
  for (const [name, hours] of [
    ["Wash", "2"],
    ["Dry", "3,5"],
  ] as const) {
    await page.getByRole("button", { name: t("files", "row.new") }).click();
    const title = grid.getByRole("textbox", { name: cell(t, "Name", t("files", "row.untitled")) });
    await title.fill(name);
    await title.press("Enter");
    const time = grid.getByRole("textbox", { name: cell(t, "Hours", name) });
    await time.fill(hours);
    await time.press("Enter");
    // The field writes the number the way the interface language does.
    await expect(time).toHaveValue(new RegExp(`^${hours.replace(",", "[.,]")}$`));
  }

  await page.goto(`/workspace/${user.workspace.id}/bases`);
  await newBase(page, t, "Projects");
  await newProperty(page, t, "Tasks", t("files", "type.relation"), async (dialog) => {
    await dialog
      .getByRole("combobox", { name: t("files", "property.relationTo") })
      .selectOption({ label: "Tasks" });
  });
  await newProperty(page, t, "Total hours", t("files", "type.rollup"), async (dialog) => {
    await dialog
      .getByRole("combobox", { name: t("files", "property.rollupRelation") })
      .selectOption({ label: "Tasks" });
    const target = dialog.getByRole("combobox", { name: t("files", "property.rollupProperty") });
    await expect(target.getByRole("option", { name: "Hours" })).toBeAttached();
    await target.selectOption({ label: "Hours" });
    await dialog
      .getByRole("combobox", { name: t("files", "property.rollupFunction") })
      .selectOption({ label: t("files", "rollup.sum") });
  });

  await page.getByRole("button", { name: t("files", "row.new") }).click();
  const title = grid.getByRole("textbox", { name: cell(t, "Name", t("files", "row.untitled")) });
  await title.fill("Home");
  await title.press("Enter");
  await grid.getByRole("button", { name: cell(t, "Tasks", "Home") }).click();
  const picker = page.getByRole("dialog", { name: cell(t, "Tasks", "Home") });
  const choices = picker.getByRole("list", { name: t("files", "cell.choices") });
  await choices.getByRole("checkbox", { name: "Wash" }).check();
  await choices.getByRole("checkbox", { name: "Dry" }).check();
  await picker.getByRole("button", { name: t("files", "cell.done") }).click();

  await expect(grid.getByRole("button", { name: cell(t, "Tasks", "Home") })).toHaveText(
    /Wash, Dry|Dry, Wash/,
  );
  // 2 + 3.5 hours, written the way the interface language writes numbers.
  await expect(grid.getByRole("cell").filter({ hasText: /^5[.,]5$/ })).toBeVisible();

  // The rollup follows the tasks: a change to one of them shows on the project.
  await page.goto(`/workspace/${user.workspace.id}/bases`);
  await page.getByRole("link", { name: "Tasks" }).click();
  const wash = page.getByRole("table").getByRole("textbox", { name: cell(t, "Hours", "Wash") });
  await wash.fill("4");
  await wash.press("Enter");
  await expect(wash).toHaveValue("4");
  await page.goto(`/workspace/${user.workspace.id}/bases`);
  await page.getByRole("link", { name: "Projects" }).click();
  await expect(
    page
      .getByRole("table")
      .getByRole("cell")
      .filter({ hasText: /^7[.,]5$/ }),
  ).toBeVisible();
});
