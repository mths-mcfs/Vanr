// The account journeys: a person signs up, names a workspace, signs out and signs back in.
// Each one checks what the person sees on the way, in the project's language.
import { expect, test } from "./fixtures.ts";

test("sign up: a new person creates an account and is asked to name a workspace", async ({ page, t }) => {
  const email = `new-${test.info().testId}@people.example`;
  await page.goto("/signup");
  await expect(page.getByRole("heading", { level: 1, name: t("account", "signUp.title") })).toBeVisible();

  await page.getByLabel(t("account", "field.name")).fill("Rosa Lima");
  await page.getByLabel(t("account", "field.email")).fill(email);
  await page.getByLabel(t("account", "field.password"), { exact: true }).fill("a long enough password");
  await page.getByRole("button", { name: t("account", "signUp.submit") }).click();

  await expect(page.getByRole("heading", { level: 1, name: t("account", "workspace.title") })).toBeVisible();
  await expect(page.getByText(t("account", "workspace.signedInAs", { email }))).toBeVisible();
  await expect(page.getByLabel(t("account", "workspace.name"))).toBeEditable();
  await expect(page).toHaveURL(/\/onboarding$/);
});

test("new workspace: a signed-in person names a workspace and lands in it", async ({
  page,
  t,
  seedUser,
  signIn,
}) => {
  const user = await seedUser();
  await signIn(user);
  await page.goto("/");
  // No workspace yet: the app sends the person to name one.
  await expect(page.getByRole("heading", { level: 1, name: t("account", "workspace.title") })).toBeVisible();

  const name = "Birchwood Studio";
  await page.getByLabel(t("account", "workspace.name")).fill(name);
  await page.getByLabel(t("account", "workspace.context")).fill("A small design studio.");
  await page.getByRole("button", { name: t("account", "workspace.submit") }).click();

  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
  const sidebar = page.getByRole("complementary", { name: t("shell", "sidebar.label") });
  await expect(
    sidebar.getByRole("button", { name: t("shell", "workspace.menu", { workspace: name }) }),
  ).toBeVisible();
  await expect(
    sidebar.getByRole("button", { name: t("shell", "person.menu", { name: user.name }) }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/workspace\/[^/]+$/);
});

test("sign in: a member signs out, then signs back in to the workspace", async ({
  page,
  t,
  seedUser,
  signIn,
}) => {
  const user = await seedUser({ workspace: "Juniper Labs" });
  await signIn(user);
  await page.goto("/");
  const sidebar = page.getByRole("complementary", { name: t("shell", "sidebar.label") });
  await expect(page.getByRole("heading", { level: 1, name: user.workspace.name })).toBeVisible();

  await sidebar.getByRole("button", { name: t("shell", "person.menu", { name: user.name }) }).click();
  await page.getByRole("menuitem", { name: t("shell", "person.signOut") }).click();

  await expect(page.getByRole("heading", { level: 1, name: t("account", "signIn.title") })).toBeVisible();
  await expect(page.getByText(t("account", "signIn.notice.signedOut"))).toBeVisible();
  await expect(sidebar).toBeHidden();

  // The workspace is closed to a signed-out browser: it goes back to sign in.
  await page.goto(`/workspace/${user.workspace.id}`);
  await expect(page.getByRole("heading", { level: 1, name: t("account", "signIn.title") })).toBeVisible();

  await page.getByLabel(t("account", "field.email")).fill(user.email);
  await page.getByLabel(t("account", "field.password"), { exact: true }).fill(user.password);
  await page.getByRole("button", { name: t("account", "signIn.submit"), exact: true }).click();

  await expect(page.getByRole("heading", { level: 1, name: user.workspace.name })).toBeVisible();
  await expect(
    sidebar.getByRole("button", { name: t("shell", "person.menu", { name: user.name }) }),
  ).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/workspace/${user.workspace.id}$`));
});
