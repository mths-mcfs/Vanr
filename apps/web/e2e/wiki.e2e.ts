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

test("restrict a page: another member no longer finds it in the tree, the search or at its address", async ({
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
  const title = "Payroll dates";
  const api = await apiAs(owner);
  const slug = await createPage(api, owner, { title, body: "Salaries go out on the 25th." });
  await createPage(api, owner, { title: "Menu", body: "Soup of the day." });

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

  const other = await browserOf(browser, server, await apiAs(teammate), testInfo.project.use.locale);
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
  t,
  seedUser,
  signIn,
  apiAs,
}) => {
  const owner = await seedUser({ workspace: "Harbour Café" });
  const title = "Opening checklist";
  const slug = await createPage(await apiAs(owner), owner, {
    title,
    body: "Doors open at nine. Bring the keys.",
  });
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

/** Selects from the first `start` to the end of the first `end` after it, in the editor's text. */
async function pick(editor: import("@playwright/test").Locator, start: string, end: string) {
  await editor.click();
  await editor.evaluate(
    (element, [start, end]) => {
      const texts: Text[] = [];
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) texts.push(node as Text);
      const from = texts.findIndex((each) => each.data.includes(start));
      const first = texts[from];
      if (first === undefined) throw new Error(`no "${start}"`);
      const offset = first.data.indexOf(start);
      const last = texts
        .slice(from)
        .find((each, n) => (n === 0 ? each.data.indexOf(end, offset) >= 0 : each.data.includes(end)));
      if (last === undefined) throw new Error(`no "${end}"`);
      const close = (last === first ? last.data.indexOf(end, offset) : last.data.indexOf(end)) + end.length;
      window.getSelection()?.setBaseAndExtent(first, offset, last, close);
    },
    [start, end] as const,
  );
}

test("comment on a passage over two paragraphs: the comment holds to it", async ({
  page,
  t,
  seedUser,
  signIn,
  apiAs,
}) => {
  const owner = await seedUser({ workspace: "Harbour Café" });
  const title = "Opening checklist";
  const slug = await createPage(await apiAs(owner), owner, {
    title,
    body: "Doors open at nine.\n\nBring the keys.",
  });
  await signIn(owner);
  await page.goto(`/workspace/${owner.workspace.id}/wiki/${slug}`);
  await expect(
    page.getByRole("status").filter({ hasText: t("wiki", "draft.published", { version: 1 }) }),
  ).toBeVisible();
  await pick(page.getByRole("textbox", { name: t("wiki", "page.editor", { title }) }), "at nine.", "Bring");
  await page.getByRole("button", { name: t("wiki", "comments.onSelection") }).click();
  await page.getByRole("textbox", { name: t("wiki", "comments.new") }).fill("Both on one sign.");
  await page.getByRole("button", { name: t("wiki", "comments.send"), exact: true }).click();
  const comments = page.getByRole("list", { name: t("wiki", "comments.list") });
  await expect(comments.getByText("Both on one sign.")).toBeVisible();
  await page.reload();
  await expect(comments.getByText("Both on one sign.")).toBeVisible();
  await expect(comments.getByText(t("wiki", "comments.orphan"))).toHaveCount(0);
});

test("comment on text not published yet: the person is told to publish, and it never holds elsewhere", async ({
  page,
  t,
  seedUser,
  signIn,
  apiAs,
}) => {
  const owner = await seedUser({ workspace: "Harbour Café" });
  const title = "Kitchen";
  const slug = await createPage(await apiAs(owner), owner, { title, body: "The oven is hot." });
  await signIn(owner);
  await page.goto(`/workspace/${owner.workspace.id}/wiki/${slug}`);
  await expect(
    page.getByRole("status").filter({ hasText: t("wiki", "draft.published", { version: 1 }) }),
  ).toBeVisible();
  const editor = page.getByRole("textbox", { name: t("wiki", "page.editor", { title }) });
  await editor.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Clean the oven.");
  await expect(page.getByRole("status").filter({ hasText: t("wiki", "draft.unpublished") })).toBeVisible();
  // "oven" in the new sentence: the published text has the word, but not this passage.
  await editor.evaluate((element) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const at = node.textContent?.indexOf("Clean the oven") ?? -1;
      if (at >= 0) {
        const from = at + "Clean the ".length;
        window.getSelection()?.setBaseAndExtent(node, from, node, from + "oven".length);
        return;
      }
    }
  });
  await page.getByRole("button", { name: t("wiki", "comments.onSelection") }).click();
  await expect(page.getByRole("alert").filter({ hasText: t("wiki", "comments.publishFirst") })).toBeVisible();
  expect(await page.getByRole("textbox", { name: t("wiki", "comments.new") }).count()).toBe(0);
});

test("who reads a page by channel offers channels, not direct messages", async ({
  page,
  t,
  seedUser,
  signIn,
  apiAs,
}) => {
  const owner = await seedUser({ workspace: "Harbour Café" });
  const api = await apiAs(owner);
  const base = `/api/v1/workspaces/${owner.workspace.id}`;
  const agent = await api.post(`${base}/agents`, {
    data: { name: "Scribe", handle: "scribe", role: "content" },
  });
  if (!agent.ok()) throw new Error(`create agent: HTTP ${agent.status()} ${await agent.text()}`);
  const dm = await api.post(`${base}/dms`, {
    data: { agentId: ((await agent.json()) as { id: string }).id },
  });
  if (!dm.ok()) throw new Error(`open DM: HTTP ${dm.status()} ${await dm.text()}`);
  const { channelId: dmId } = (await dm.json()) as { channelId: string };
  const listed = (await (await api.get(`${base}/channels`)).json()) as {
    channels: { id: string; name: string }[];
  };
  const dmChannel = listed.channels.find((each) => each.id === dmId);
  const real = listed.channels.filter((each) => each.id !== dmId);
  // The list has the direct message too, which is why the dialog leaves it out.
  expect(dmChannel !== undefined && real.length > 0).toBe(true);
  const title = "Rota";
  const slug = await createPage(api, owner, { title, body: "Mondays." });

  await signIn(owner);
  await page.goto(`/workspace/${owner.workspace.id}/wiki/${slug}`);
  await page.getByRole("button", { name: t("wiki", "page.actions") }).click();
  await page.getByRole("menuitem", { name: t("wiki", "access.open") }).click();
  const dialog = page.getByRole("dialog", { name: t("wiki", "access.title", { title }) });
  await dialog.getByRole("radio", { name: t("wiki", "access.channel") }).click();
  await dialog.getByRole("combobox", { name: t("wiki", "access.pickChannel") }).click();
  const options = page.getByRole("option");
  await expect(options.first()).toBeVisible();
  expect((await options.allTextContents()).sort()).toEqual(real.map((each) => `#${each.name}`).sort());
});

test("comment on a passage across formatting: the person is told instead of leaving a loose comment", async ({
  page,
  t,
  seedUser,
  signIn,
  apiAs,
}) => {
  const owner = await seedUser({ workspace: "Harbour Café" });
  const title = "Closing checklist";
  const slug = await createPage(await apiAs(owner), owner, { title, body: "Bring the **spare** keys home." });
  await signIn(owner);
  await page.goto(`/workspace/${owner.workspace.id}/wiki/${slug}`);
  await expect(
    page.getByRole("status").filter({ hasText: t("wiki", "draft.published", { version: 1 }) }),
  ).toBeVisible();

  // Select "the spare keys", from the plain text into and past the bold word.
  const editor = page.getByRole("textbox", { name: t("wiki", "page.editor", { title }) });
  await editor.click();
  await editor.evaluate((element) => {
    const texts: Text[] = [];
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) texts.push(node as Text);
    const start = texts.find((each) => each.data.includes("the "));
    const end = texts.find((each) => each.data.includes(" keys"));
    if (start === undefined || end === undefined) throw new Error("passage not found");
    const from = start.data.indexOf("the ");
    const to = end.data.indexOf(" keys") + " keys".length;
    window.getSelection()?.setBaseAndExtent(start, from, end, to);
  });
  await page.getByRole("button", { name: t("wiki", "comments.onSelection") }).click();
  const refused = page.getByRole("alert").filter({ hasText: t("wiki", "comments.cantAnchor") });
  await expect(refused).toBeVisible();
  await expect(page.getByRole("textbox", { name: t("wiki", "comments.new") })).toHaveCount(0);

  // A plain passage then opens the comment, and the refusal goes.
  await pick(editor, "Bring the", "Bring the");
  await page.getByRole("button", { name: t("wiki", "comments.onSelection") }).click();
  await expect(page.getByRole("textbox", { name: t("wiki", "comments.new") })).toBeVisible();
  expect(await refused.count()).toBe(0);
});

test("comment on published text near formatting while the page has unpublished changes: it holds", async ({
  page,
  t,
  seedUser,
  signIn,
  apiAs,
}) => {
  const owner = await seedUser({ workspace: "Harbour Café" });
  const title = "Kitchen";
  const slug = await createPage(await apiAs(owner), owner, {
    title,
    body: "# Kitchen\n\nThe **oven** is hot. See [[Ink suppliers]] for more.\n\n## Closing\n\n- Wipe the bench before you leave.\n\nThe deliveries come on Mondays and Thursdays, before the doors open at nine.",
  });
  await signIn(owner);
  await page.goto(`/workspace/${owner.workspace.id}/wiki/${slug}`);
  await expect(
    page.getByRole("status").filter({ hasText: t("wiki", "draft.published", { version: 1 }) }),
  ).toBeVisible();
  const editor = page.getByRole("textbox", { name: t("wiki", "page.editor", { title }) });
  // The new line goes at the very end, far from the passage picked below.
  await expect(editor).toHaveAttribute("contenteditable", "true");
  await editor.click();
  await editor.evaluate((element) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let last: Text | null = null;
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) last = node as Text;
    if (last !== null) window.getSelection()?.setBaseAndExtent(last, last.length, last, last.length);
  });
  await page.keyboard.press("Enter");
  await page.keyboard.type("Lock the door.");
  await expect(page.getByRole("status").filter({ hasText: t("wiki", "draft.unpublished") })).toBeVisible();
  await expect(editor.getByRole("paragraph").last()).toHaveText("Lock the door.");

  await pick(editor, "is hot.", "is hot.");
  await page.getByRole("button", { name: t("wiki", "comments.onSelection") }).click();
  await expect(page.getByRole("textbox", { name: t("wiki", "comments.new") })).toBeVisible();
  expect(
    await page
      .getByRole("alert")
      .filter({ hasText: t("wiki", "comments.publishFirst") })
      .count(),
  ).toBe(0);
});

test("comment on a passage while another comment is still sending: the new one stays open", async ({
  page,
  t,
  seedUser,
  signIn,
  apiAs,
}) => {
  const owner = await seedUser({ workspace: "Harbour Café" });
  const title = "Opening checklist";
  const slug = await createPage(await apiAs(owner), owner, {
    title,
    body: "Doors open at nine. Bring the keys.",
  });
  await signIn(owner);
  await page.goto(`/workspace/${owner.workspace.id}/wiki/${slug}`);
  await expect(
    page.getByRole("status").filter({ hasText: t("wiki", "draft.published", { version: 1 }) }),
  ).toBeVisible();
  const editor = page.getByRole("textbox", { name: t("wiki", "page.editor", { title }) });
  const pick = async (passage: string) => {
    await editor.click();
    await editor.evaluate((element, passage) => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        const at = node.textContent?.indexOf(passage) ?? -1;
        if (at >= 0) {
          window.getSelection()?.setBaseAndExtent(node, at, node, at + passage.length);
          return;
        }
      }
    }, passage);
    await page.getByRole("button", { name: t("wiki", "comments.onSelection") }).click();
  };
  // The first comment answers slowly, as on a slow connection.
  await page.route(/\/comments$/, async (route) => {
    if (route.request().method() === "POST") await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.continue();
  });
  const composer = page.getByRole("textbox", { name: t("wiki", "comments.new") });

  await pick("open at nine");
  await composer.fill("Nine on weekdays.");
  await page.getByRole("button", { name: t("wiki", "comments.send"), exact: true }).click();
  await page.getByRole("button", { name: t("wiki", "comments.cancel") }).click();
  await pick("the keys");
  await composer.fill("Both sets.");

  const comments = page.getByRole("list", { name: t("wiki", "comments.list") });
  await expect(comments.getByText("Nine on weekdays.")).toBeVisible();
  await page.waitForTimeout(300);
  await expect(composer).toHaveValue("Both sets.");
});

/**
 * An agent's proposed change to a page, made through its `propose_wiki_edit` tool: the fake model's
 * directive in a direct message, run by the harness runtime. Returns once the proposal is on the page.
 */
async function propose(
  api: APIRequestContext,
  owner: SeededMember,
  slug: string,
  edit: { oldStr: string; newStr: string },
) {
  const base = `/api/v1/workspaces/${owner.workspace.id}`;
  const made = await api.post(`${base}/agents`, {
    data: { name: "Scribe", handle: "scribe", role: "content" },
  });
  if (!made.ok()) throw new Error(`create agent: HTTP ${made.status()} ${await made.text()}`);
  const agent = (await made.json()) as { id: string };
  const meta = await api.patch(`${base}/wiki/pages/${slug}/meta`, {
    data: { parentVersion: 1, agentEdits: "propose" },
  });
  if (!meta.ok()) throw new Error(`agents propose: HTTP ${meta.status()} ${await meta.text()}`);
  const dm = await api.post(`${base}/dms`, { data: { agentId: agent.id } });
  if (!dm.ok()) throw new Error(`open DM: HTTP ${dm.status()} ${await dm.text()}`);
  const { channelId } = (await dm.json()) as { channelId: string };
  const directive = JSON.stringify({
    slug,
    parent_version: 1,
    edits: [{ old_str: edit.oldStr, new_str: edit.newStr }],
    note: "The oven stays warm otherwise.",
  });
  const posted = await api.post(`${base}/channels/${channelId}/messages`, {
    data: { body: `[[tool:propose_wiki_edit ${directive}]]`, clientId: `proposal-${slug}` },
  });
  if (!posted.ok()) throw new Error(`post: HTTP ${posted.status()} ${await posted.text()}`);
  // The agent's run is asynchronous: the proposal is there once its tool ran.
  await expect
    .poll(
      async () => {
        const notes = await api.get(`${base}/wiki/pages/${slug}/annotations`);
        return ((await notes.json()) as { proposals: unknown[] }).proposals.length;
      },
      { timeout: 20_000 },
    )
    .toBe(1);
}

test("accept a proposal: an agent's change lands on the page as a new version", async ({
  page,
  t,
  seedUser,
  signIn,
  apiAs,
}) => {
  const owner = await seedUser({ workspace: "Harbour Café" });
  const title = "Closing checklist";
  const api = await apiAs(owner);
  const slug = await createPage(api, owner, { title, body: "Cover the oven." });
  await propose(api, owner, slug, { oldStr: "Cover the oven.", newStr: "Cover the oven and switch it off." });

  await signIn(owner);
  await page.goto(`/workspace/${owner.workspace.id}/wiki/${slug}`);
  const proposals = page.getByRole("region", { name: t("wiki", "proposals.title", { count: 1 }) });
  await expect(proposals.getByText("Cover the oven and switch it off.")).toBeVisible();
  await proposals.getByRole("button", { name: t("wiki", "proposals.accept") }).click();
  await expect(page.getByText(t("wiki", "proposals.decided", { version: 2 })).first()).toBeVisible();
  await expect(page.getByRole("textbox", { name: t("wiki", "page.editor", { title }) })).toContainText(
    "Cover the oven and switch it off.",
  );
});

test("accept a proposal that no longer applies: the person is told, and nothing is saved", async ({
  page,
  t,
  seedUser,
  signIn,
  apiAs,
}) => {
  const owner = await seedUser({ workspace: "Harbour Café" });
  const title = "Closing checklist";
  const api = await apiAs(owner);
  const slug = await createPage(api, owner, { title, body: "Cover the oven." });
  await propose(api, owner, slug, { oldStr: "Cover the oven.", newStr: "Cover the oven well." });
  // Someone publishes a new text of that sentence before the review.
  const base = `/api/v1/workspaces/${owner.workspace.id}`;
  const edited = await api.put(`${base}/wiki/pages/${slug}`, {
    data: { body: "Cover the stove.", parentVersion: 1 },
  });
  if (!edited.ok()) throw new Error(`edit: HTTP ${edited.status()} ${await edited.text()}`);

  await signIn(owner);
  await page.goto(`/workspace/${owner.workspace.id}/wiki/${slug}`);
  const proposals = page.getByRole("region", { name: t("wiki", "proposals.title", { count: 1 }) });
  await proposals.getByRole("button", { name: t("wiki", "proposals.accept") }).click();
  await expect(page.getByText(t("wiki", "proposals.staleCount", { count: 1 })).first()).toBeVisible();
  await expect(page.getByText(t("wiki", "proposals.state.stale"), { exact: true })).toBeVisible();
  // Counted at once: both notices would come together, and a waiting check passes once one fades.
  expect(await page.getByText(/^(Saved as version|Salva como versão)/).count()).toBe(0);
  const now = (await (await api.get(`${base}/wiki/pages/${slug}`)).json()) as {
    version: number;
    body: string;
  };
  expect(now).toMatchObject({ version: 2, body: "Cover the stove." });
});

test("a shared address with ?at= opens the page at that heading", async ({
  page,
  t,
  seedUser,
  signIn,
  apiAs,
}) => {
  const owner = await seedUser({ workspace: "Harbour Café" });
  const filler = Array.from({ length: 40 }, (_, n) => `Filler paragraph ${n}.`).join("\n\n");
  const body = [
    "Intro.",
    filler,
    "## Deliveries",
    "Milk at ten.",
    filler,
    "## Closing",
    "Lock the door.",
    filler,
  ].join("\n\n");
  const title = "Long handbook";
  const slug = await createPage(await apiAs(owner), owner, { title, body });
  await signIn(owner);
  // The live document arrives late, as on a slow connection: the published text is on screen and
  // scrolled first, then the live editor takes its place and must land on the heading too.
  await page.routeWebSocket(/\/wiki\/collab/, (socket) => {
    const server = socket.connectToServer();
    server.onMessage((message) => setTimeout(() => socket.send(message), 1200));
  });
  // Opened straight from the address, as a new tab or a shared link would.
  await page.goto(`/workspace/${owner.workspace.id}/wiki/${slug}?at=${encodeURIComponent("Closing")}`);
  await expect(
    page.getByRole("status").filter({ hasText: t("wiki", "draft.published", { version: 1 }) }),
  ).toBeVisible();
  const editor = page.getByRole("textbox", { name: t("wiki", "page.editor", { title }) });
  await expect(editor).toHaveAttribute("contenteditable", "true");
  const heading = editor.getByRole("heading", { name: "Closing" });
  await expect(heading).toBeInViewport();
  // Still there once everything settled: nothing put the page back at the top.
  await page.waitForTimeout(1500);
  await expect(heading).toBeInViewport();
});
