// The account journeys: a person signs up, names a workspace, signs out and signs back in, is turned
// away with a wrong password, picks the language before signing in, and opens an invitation that was
// already accepted. Each one checks what the person sees on the way, in the project's language.
import accountEn from "../src/messages/account/en.ts";
import accountPt from "../src/messages/account/pt-BR.ts";
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

test("sign in with a wrong password: the person is told, and stays on the sign-in page", async ({
  page,
  t,
  seedUser,
}) => {
  const user = await seedUser({ workspace: "Flint Desk" });
  await page.goto("/login");
  await page.getByLabel(t("account", "field.email")).fill(user.email);
  await page.getByLabel(t("account", "field.password"), { exact: true }).fill(`${user.password}-not`);
  await page.getByRole("button", { name: t("account", "signIn.submit"), exact: true }).click();

  await expect(page.getByText(t("errors", "invalid_email_or_password"))).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: t("account", "signIn.title") })).toBeVisible();
  await expect(page).toHaveURL(/\/login/);
});

test("the language picked before signing in changes the page and the document's language", async ({
  page,
  locale,
  t,
}) => {
  const other = locale?.toLowerCase().startsWith("pt") ? "en" : "pt-BR";
  const title = (other === "en" ? accountEn : accountPt)["signIn.title"];
  await page.goto("/login");
  await page.getByRole("combobox", { name: t("common", "language.label") }).click();
  await page.getByRole("option", { name: t("common", `language.${other}`) }).click();

  await expect(page.locator("html")).toHaveAttribute("lang", other);
  await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
  await expect(page).toHaveTitle(new RegExp(`^${title} \\|`));
});

test("an invitation already accepted leads its member in and is closed to a visitor", async ({
  page,
  t,
  seedUser,
  signIn,
  invite,
  apiAs,
}) => {
  const owner = await seedUser({ workspace: "Quarry Hall" });
  const member = await seedUser();
  const invitation = await invite(owner, { email: member.email });
  const accepted = await (await apiAs(member)).post(`/api/v1/invitations/${invitation.token}/accept`, {
    data: {},
  });
  expect(accepted.ok()).toBe(true);
  const link = new URL(invitation.url).pathname;

  // Without a session, the link says it was used and offers the sign-in.
  await page.goto(link);
  await expect(
    page.getByRole("heading", { level: 1, name: t("account", "invite.used.title") }),
  ).toBeVisible();
  await expect(page.getByText(t("account", "invite.used.body"))).toBeVisible();
  await expect(page.getByRole("button", { name: t("account", "invite.accept.submit") })).toHaveCount(0);

  // The member who accepted it is only led into the workspace.
  const workspace = owner.workspace.name;
  await signIn(member);
  await page.goto(link);
  await expect(page.getByText(t("account", "invite.member.body", { workspace }))).toBeVisible();
  await page.getByRole("button", { name: t("account", "invite.member.action", { workspace }) }).click();
  await expect(page.getByRole("heading", { level: 1, name: workspace })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/workspace/${owner.workspace.id}$`));
});
