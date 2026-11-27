// The wiki journeys. Each one checks what the people see, in the project's language.
import type { Browser } from "@playwright/test";
import type { SeededMember, SeededUser } from "./fixtures.ts";
import { expect, test } from "./fixtures.ts";
import { apiAs, join } from "./people.ts";
import type { RunningServer } from "./server.ts";

/** A page made through the API, as the owner would through the form. */
async function createPage(
  server: RunningServer,
  owner: SeededMember,
  input: { title: string; body: string },
): Promise<string> {
  const api = await apiAs(server, owner);
  try {
    const created = await api.post(`/api/v1/workspaces/${owner.workspace.id}/wiki/pages`, { data: input });
    if (!created.ok()) throw new Error(`create page: HTTP ${created.status()} ${await created.text()}`);
    return ((await created.json()) as { slug: string }).slug;
  } finally {
    await api.dispose();
  }
}

/** A second browser, signed in as the person, in the same language as the first. */
async function browserOf(
  browser: Browser,
  server: RunningServer,
  person: SeededUser,
  locale: string | undefined,
) {
  const api = await apiAs(server, person);
  const storageState = await api.storageState();
  await api.dispose();
  return browser.newContext({ baseURL: server.url, storageState, ...(locale !== undefined && { locale }) });
}

test("edit a page together: each sees the other's change before it is published", async ({
  page,
  browser,
  server,
  t,
  seedUser,
  signIn,
}, testInfo) => {
  const owner = await seedUser({ workspace: "Harbour Café" });
  const teammate = await join(server, owner, await seedUser());
  const title = "Shift handover";
  const slug = await createPage(server, owner, { title, body: "Doors open at nine." });
  const address = `/workspace/${owner.workspace.id}/wiki/${slug}`;

  await signIn(owner);
  await page.goto(address);
  const other = await browserOf(browser, server, teammate, testInfo.project.use.locale);
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

test("restrict a page: another member no longer finds it in the tree, the search or at its address", async ({
  page,
  browser,
  server,
  t,
  seedUser,
  signIn,
}, testInfo) => {
  const owner = await seedUser({ workspace: "Harbour Café" });
  const teammate = await join(server, owner, await seedUser());
  const title = "Payroll dates";
  const slug = await createPage(server, owner, { title, body: "Salaries go out on the 25th." });
  await createPage(server, owner, { title: "Menu", body: "Soup of the day." });

  await signIn(owner);
  await page.goto(`/workspace/${owner.workspace.id}/wiki/${slug}`);
  await page.getByRole("button", { name: t("wiki", "page.actions") }).click();
  await page.getByRole("menuitem", { name: t("wiki", "access.open") }).click();
  const dialog = page.getByRole("dialog", { name: t("wiki", "access.title", { title }) });
  await dialog.getByRole("radio", { name: t("wiki", "access.private") }).click();
  await dialog.getByRole("button", { name: t("wiki", "access.save") }).click();
  await expect(page.getByText(t("wiki", "access.byPeople", { names: owner.name }))).toBeVisible();
  // The restricted page has a new address: the old one no longer answers, even for the owner.
  await expect(page).not.toHaveURL(new RegExp(`/wiki/${slug}$`));
  const restricted = new URL(page.url()).pathname;

  // The owner still sees it in the tree, marked as restricted.
  await page.goto(`/workspace/${owner.workspace.id}/wiki`);
  const ownTree = page.getByRole("navigation", { name: t("wiki", "index.tree") });
  await expect(
    ownTree.getByRole("link", { name: title }).getByRole("img", { name: t("wiki", "access.restricted") }),
  ).toBeVisible();

  const other = await browserOf(browser, server, teammate, testInfo.project.use.locale);
  const second = await other.newPage();
  await second.goto(`/workspace/${owner.workspace.id}/wiki`);
  const tree = second.getByRole("navigation", { name: t("wiki", "index.tree") });
  await expect(tree.getByRole("link", { name: "Menu" })).toBeVisible();
  await expect(tree.getByRole("link", { name: title })).toHaveCount(0);
  await expect(second.getByText(t("wiki", "index.count", { count: 1 }))).toBeVisible();
  await second.getByRole("searchbox", { name: t("wiki", "index.search") }).fill("Salaries");
  await expect(second.getByText(t("wiki", "index.noResults"))).toBeVisible();
  for (const address of [`/workspace/${owner.workspace.id}/wiki/${slug}`, restricted]) {
    await second.goto(address);
    await expect(second.getByText(t("wiki", "page.missing.title"))).toBeVisible();
    await expect(second.getByText("Salaries go out on the 25th.")).toHaveCount(0);
  }
  await other.close();
});

test("comment on a passage: the comment keeps the quoted passage", async ({
  page,
  server,
  t,
  seedUser,
  signIn,
}) => {
  const owner = await seedUser({ workspace: "Harbour Café" });
  const title = "Opening checklist";
  const slug = await createPage(server, owner, { title, body: "Doors open at nine. Bring the keys." });
  await signIn(owner);
  await page.goto(`/workspace/${owner.workspace.id}/wiki/${slug}`);
  await expect(
    page.getByRole("status").filter({ hasText: t("wiki", "draft.published", { version: 1 }) }),
  ).toBeVisible();

  // Select "open at nine" in the editor, as a person would by dragging over it.
  const editor = page.getByRole("textbox", { name: t("wiki", "page.editor", { title }) });
  await editor.click();
  await editor.evaluate((element) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const at = node.textContent?.indexOf("open at nine") ?? -1;
      if (at >= 0) {
        window.getSelection()?.setBaseAndExtent(node, at, node, at + "open at nine".length);
        return;
      }
    }
  });
  await page.getByRole("button", { name: t("wiki", "comments.onSelection") }).click();
  await page
    .getByRole("textbox", { name: t("wiki", "comments.new") })
    .fill("Nine on weekdays, ten on Sundays.");
  await page.getByRole("button", { name: t("wiki", "comments.send"), exact: true }).click();

  const comments = page.getByRole("list", { name: t("wiki", "comments.list") });
  await expect(comments.getByText("open at nine", { exact: true })).toBeVisible();
  await expect(comments.getByText("Nine on weekdays, ten on Sundays.")).toBeVisible();
  await expect(page.getByRole("heading", { name: t("wiki", "comments.title", { count: 1 }) })).toBeVisible();

  // After a reload the comment is still anchored to the passage.
  await page.reload();
  await expect(comments.getByText("open at nine", { exact: true })).toBeVisible();
  await expect(comments.getByText(t("wiki", "comments.orphan"))).toHaveCount(0);
});

// An agent proposes the change through its `propose_wiki_edit` tool, driven by the fake model's
// directive in a direct message. That run needs the harness runtime (#88); until it lands this journey
// is marked fixme (#99).
test.fixme("accept a proposal: an agent's change lands on the page as a new version", async ({
  page,
  server,
  t,
  seedUser,
  signIn,
}) => {
  const owner = await seedUser({ workspace: "Harbour Café" });
  const title = "Closing checklist";
  const slug = await createPage(server, owner, { title, body: "Cover the oven." });
  const api = await apiAs(server, owner);
  try {
    const base = `/api/v1/workspaces/${owner.workspace.id}`;
    const agent = (await (
      await api.post(`${base}/agents`, { data: { name: "Scribe", handle: "scribe", role: "content" } })
    ).json()) as { id: string };
    await api.patch(`${base}/wiki/pages/${slug}/meta`, { data: { parentVersion: 1, agentEdits: "propose" } });
    const dm = (await (await api.post(`${base}/dms`, { data: { agentId: agent.id } })).json()) as {
      channelId: string;
    };
    const directive = JSON.stringify({
      slug,
      parent_version: 1,
      edits: [{ old_str: "Cover the oven.", new_str: "Cover the oven and switch it off." }],
      note: "The oven stays warm otherwise.",
    });
    await api.post(`${base}/channels/${dm.channelId}/messages`, {
      data: { body: `[[tool:propose_wiki_edit ${directive}]]`, clientId: `proposal-${slug}` },
    });
  } finally {
    await api.dispose();
  }

  await signIn(owner);
  await page.goto(`/workspace/${owner.workspace.id}/wiki/${slug}`);
  const proposals = page.getByRole("region", { name: t("wiki", "proposals.title", { count: 1 }) });
  await expect(proposals.getByText("Cover the oven and switch it off.")).toBeVisible();
  await proposals.getByRole("button", { name: t("wiki", "proposals.accept") }).click();
  await expect(page.getByText(t("wiki", "proposals.decided", { version: 3 }))).toBeVisible();
  await expect(page.getByRole("textbox", { name: t("wiki", "page.editor", { title }) })).toContainText(
    "Cover the oven and switch it off.",
  );
});
