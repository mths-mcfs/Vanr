// The wiki journeys. Each one checks what the people see, in the project's language.
import type { APIRequestContext, Browser } from "@playwright/test";
import type { SeededMember } from "./fixtures.ts";
import { expect, test } from "./fixtures.ts";
import type { RunningServer } from "./server.ts";

/** A page made through the API, as the owner would through the form. */
async function createPage(
  api: APIRequestContext,
  owner: SeededMember,
  input: { title: string; body: string },
): Promise<string> {
  const created = await api.post(`/api/v1/workspaces/${owner.workspace.id}/wiki/pages`, { data: input });
  if (!created.ok()) throw new Error(`create page: HTTP ${created.status()} ${await created.text()}`);
  return ((await created.json()) as { slug: string }).slug;
}

/** A second browser, signed in as the person (through their API client), in the same language as the first. */
async function browserOf(
  browser: Browser,
  server: RunningServer,
  api: APIRequestContext,
  locale: string | undefined,
) {
  const storageState = await api.storageState();
  return browser.newContext({ baseURL: server.url, storageState, ...(locale !== undefined && { locale }) });
}

test("edit a page together: each sees the other's change before it is published", async ({
  page,
  browser,
  server,
  t,
  seedUser,
  signIn,
  apiAs,
}, testInfo) => {
  const owner = await seedUser({ workspace: "Harbour Café" });
  const teammate = await seedUser({ joins: { by: owner } });
  const title = "Shift handover";
  const slug = await createPage(await apiAs(owner), owner, { title, body: "Doors open at nine." });
  const address = `/workspace/${owner.workspace.id}/wiki/${slug}`;

  await signIn(owner);
  await page.goto(address);
  const other = await browserOf(browser, server, await apiAs(teammate), testInfo.project.use.locale);
  const second = await other.newPage();
  await second.goto(address);

  for (const tab of [page, second]) {
    await expect(
      tab.getByRole("status").filter({ hasText: t("wiki", "draft.published", { version: 1 }) }),
    ).toBeVisible();
  }
  // Each sees the other on the page.
  await expect(
    page.getByRole("list", { name: t("wiki", "live.presence") }).getByRole("img", { name: teammate.name }),
  ).toBeVisible();
  await expect(
    second.getByRole("list", { name: t("wiki", "live.presence") }).getByRole("img", { name: owner.name }),
  ).toBeVisible();

  const mine = page.getByRole("textbox", { name: t("wiki", "page.editor", { title }) });
  await mine.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type(" Bring the keys.");

  // The change reaches the other editor before anyone publishes it.
  const theirs = second.getByRole("textbox", { name: t("wiki", "page.editor", { title }) });
  await expect(theirs).toContainText("Doors open at nine. Bring the keys.");
  await expect(page.getByRole("status").filter({ hasText: t("wiki", "draft.unpublished") })).toBeVisible();

  // The other person adds a line of their own, and the first sees it.
  await theirs.click();
  await second.keyboard.press("Control+End");
  await second.keyboard.press("Enter");
  await second.keyboard.type("Milk arrives at ten.");
  await expect(mine).toContainText("Milk arrives at ten.");

  await page.getByRole("button", { name: t("wiki", "draft.publish") }).click();
  for (const tab of [page, second]) {
    await expect(
      tab.getByRole("status").filter({ hasText: t("wiki", "draft.published", { version: 2 }) }),
    ).toBeVisible();
  }
  await other.close();
});
