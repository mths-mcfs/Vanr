// The workspace settings, end to end: invite someone, change a member's role, set where the files
// go, and what a member who may not change anything sees.
import { expect, test } from "./fixtures.ts";

test("an owner invites several people at once; a repeated address counts once", async ({
  page,
  t,
  seedUser,
  signIn,
}) => {
  const owner = await seedUser({ workspace: "Invite Journey" });
  await signIn(owner);
  await page.goto(`/workspace/${owner.workspace.id}/settings/members`);
  const form = page.getByRole("form", { name: t("settings", "members.inviteTitle") });
  const stamp = Date.now().toString(36);
  const pia = `pia-${stamp}@people.example`;
  const rui = `rui-${stamp}@people.example`;
  await form.getByLabel(t("settings", "members.emails")).fill(`${pia}, ${rui}; ${pia.toUpperCase()}`);
  await form.getByRole("combobox", { name: t("settings", "members.role") }).click();
  await page.getByRole("option", { name: t("settings", "role.admin") }).click();
  await form.getByRole("button", { name: t("settings", "members.invite", { count: 2 }) }).click();

  const results = page.getByRole("list", { name: t("settings", "members.results"), exact: true });
  await expect(results.getByRole("listitem")).toHaveCount(2);
  await expect(results.getByText(t("settings", "members.result.invited", { email: pia }))).toBeVisible();
  await expect(results.getByText(t("settings", "members.result.invited", { email: rui }))).toBeVisible();
  await expect(results.getByText(/\/invite\//)).toHaveCount(2);
  const pending = page.getByRole("list", { name: t("settings", "members.pending") });
  await expect(pending.getByRole("listitem").filter({ hasText: pia })).toContainText(
    t("settings", "role.admin"),
  );

  // Still open after a reload: the server has them.
  await page.reload();
  await expect(pending.getByRole("listitem").filter({ hasText: rui })).toBeVisible();
});

test("an owner changes a member's role, and it holds after a reload", async ({
  page,
  t,
  seedUser,
  signIn,
}) => {
  const owner = await seedUser({ workspace: "Role Journey" });
  const member = await seedUser({ joins: { by: owner } });
  await signIn(owner);
  await page.goto(`/workspace/${owner.workspace.id}/settings/members`);
  const role = page.getByRole("combobox", { name: t("settings", "members.roleOf", { name: member.name }) });
  await expect(role).toHaveText(t("settings", "role.member"));
  await role.click();
  await page.getByRole("option", { name: t("settings", "role.admin") }).click();
  await expect(
    page.getByText(
      t("settings", "members.roleChanged", { name: member.name, role: t("settings", "role.admin") }),
      { exact: true },
    ),
  ).toBeVisible();
  await page.reload();
  await expect(role).toHaveText(t("settings", "role.admin"));
});

test("a member reads the settings but changes nothing, and Storage is closed to them", async ({
  page,
  t,
  seedUser,
  signIn,
}) => {
  const owner = await seedUser({ workspace: "Read Only Journey" });
  const member = await seedUser({ joins: { by: owner } });
  await signIn(member);
  const base = `/workspace/${owner.workspace.id}/settings`;

  await page.goto(`${base}/general`);
  const name = page.getByLabel(t("settings", "general.name"), { exact: true });
  await expect(name).toHaveValue(owner.workspace.name);
  await expect(name).toHaveAttribute("readonly", "");
  await expect(page.getByText(t("settings", "general.readOnly"))).toBeVisible();
  const sections = page.getByRole("navigation", { name: t("shell", "settings.sections") });
  await expect(sections.getByRole("link", { name: t("shell", "settings.general") })).toBeVisible();
  await expect(sections.getByRole("link", { name: t("shell", "settings.storage") })).toHaveCount(0);

  await page.goto(`${base}/storage`);
  await expect(page.getByText(t("shell", "settings.locked.title"))).toBeVisible();
  await expect(page.getByRole("radiogroup")).toHaveCount(0);

  await page.goto(`${base}/members`);
  const people = page.getByRole("list", { name: t("settings", "members.list") });
  await expect(people.getByRole("listitem").filter({ hasText: owner.name })).toContainText(
    t("settings", "role.owner"),
  );
  await expect(page.getByRole("form", { name: t("settings", "members.inviteTitle") })).toHaveCount(0);
  await expect(page.getByRole("combobox")).toHaveCount(0);

  // The server refuses what the screen does not offer.
  const refused = await page.request.patch(`/api/v1/workspaces/${owner.workspace.id}/settings`, {
    data: { name: "Taken over" },
  });
  expect(refused.status()).toBe(403);
});

test("an owner sets the storage destination to a bucket, tests it and saves it", async ({
  page,
  t,
  seedUser,
  signIn,
  bucket,
}) => {
  const owner = await seedUser({ workspace: "Storage Journey" });
  await signIn(owner);
  await page.goto(`/workspace/${owner.workspace.id}/settings/storage`);
  await expect(page.getByRole("radio", { name: t("settings", "storage.kind.builtin") })).toBeChecked();
  await page.getByRole("radio", { name: t("settings", "storage.kind.s3") }).check();
  await page.getByLabel(t("settings", "storage.endpoint"), { exact: true }).fill(bucket.endpoint);
  await page.getByLabel(t("settings", "storage.region"), { exact: true }).fill("auto");
  await page.getByLabel(t("settings", "storage.bucket"), { exact: true }).fill(bucket.name);
  await page.getByLabel(t("settings", "storage.accessKeyId"), { exact: true }).fill("journeykeyid0001");
  await page.getByLabel(t("settings", "storage.secretAccessKey"), { exact: true }).fill("journeysecret0002");
  await page.getByRole("checkbox", { name: t("settings", "storage.pathAddressing") }).check();

  await page.getByRole("button", { name: t("settings", "storage.test") }).click();
  await expect(page.getByText(t("settings", "storage.testPassed"))).toBeVisible();
  const steps = page.getByRole("list", { name: t("settings", "storage.steps") });
  await expect(steps.getByRole("listitem")).toHaveCount(4);

  await page.getByRole("button", { name: t("settings", "action.save") }).click();
  await expect(page.getByText(t("settings", "storage.savedBucket"), { exact: true })).toBeVisible();

  await page.reload();
  await expect(page.getByRole("radio", { name: t("settings", "storage.kind.s3") })).toBeChecked();
  await expect(page.getByLabel(t("settings", "storage.bucket"), { exact: true })).toHaveValue(bucket.name);
  await expect(page.getByText(/0001/)).toBeVisible();
  await expect(page.getByRole("heading", { name: t("settings", "storage.copyTitle") })).toBeVisible();
});
