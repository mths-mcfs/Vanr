// Threads end to end, against the real server and its runtime with the fake model: a person opens a
// thread on a message beside the channel, an agent answers inside it, the thread shows in the list
// and on its own page, and the person who started it closes it.
import { expect, test } from "./fixtures.ts";

test.describe("threads", () => {
  test.setTimeout(90_000);

  test("reply in a thread, get an agent's answer there, find it in the list and close it", async ({
    page,
    t,
    seedUser,
    signIn,
    apiAs,
  }) => {
    const owner = await seedUser({ workspace: "Thread Journey" });
    const api = await apiAs(owner);
    const base = `/api/v1/workspaces/${owner.workspace.id}`;
    const { channels } = (await (await api.get(`${base}/channels`)).json()) as {
      channels: { id: string; isGeneral: boolean }[];
    };
    const general = channels.find((channel) => channel.isGeneral)?.id ?? "";
    const handle = `loom${Date.now().toString(36)}`;
    const created = await api.post(`${base}/agents`, {
      data: { name: "Loom", handle, role: "assistant", channelIds: [general] },
    });
    expect(created.ok()).toBe(true);
    const posted = await api.post(`${base}/channels/${general}/messages`, {
      data: { body: "Which thread count for the linen run?", clientId: `thread-root-${handle}` },
    });
    expect(posted.ok()).toBe(true);
    const root = (await posted.json()) as { id: string };

    await signIn(owner);
    await page.goto(`/workspace/${owner.workspace.id}/channel/${general}`);
    const message = page.getByRole("article").filter({ hasText: "Which thread count for the linen run?" });
    await message.hover();
    await message.getByRole("button", { name: t("chat", "tools.thread") }).click();

    const panel = page.getByRole("region", { name: t("chat", "thread.label") });
    await expect(panel.getByText(t("chat", "thread.noReplies"))).toBeVisible();
    const field = panel.getByRole("textbox", { name: t("chat", "thread.hint") });
    await field.fill(`@${handle} what do you suggest?`);
    await field.press("Enter");
    // The agent answers inside the thread, not in the channel.
    await expect(panel.getByText(/Got the request/)).toBeVisible({ timeout: 30_000 });
    await expect(
      page.getByRole("log", { name: t("chat", "history.label"), exact: true }).getByText(/Got the request/),
    ).toHaveCount(0);
    const answered = page
      .getByRole("log", { name: t("chat", "history.label"), exact: true })
      .getByRole("article")
      .filter({
        hasText: "Which thread count for the linen run?",
      });
    await expect(
      answered.getByRole("button", { name: t("chat", "thread.replies", { count: 2 }) }),
    ).toBeVisible({
      timeout: 30_000,
    });

    // The list shows it; its page shows it whole, and whoever started it closes it there.
    await page.goto(`/workspace/${owner.workspace.id}/threads`);
    const list = page.getByRole("list", { name: t("chat", "threads.rows") });
    await list.getByRole("link", { name: /Which thread count for the linen run/ }).click();
    await expect(page).toHaveURL(new RegExp(`/threads/${root.id}$`));
    const whole = page.getByRole("region", { name: t("chat", "thread.label") });
    await expect(whole.getByText(/Got the request/)).toBeVisible();
    await whole.getByRole("button", { name: t("chat", "thread.shut") }).click();
    await expect(whole.getByText(t("chat", "thread.state.closed"))).toBeVisible();
    await page.goto(`/workspace/${owner.workspace.id}/threads`);
    await page.getByRole("tab", { name: t("chat", "threads.tab.closed") }).click();
    await expect(list.getByRole("link", { name: /Which thread count for the linen run/ })).toBeVisible();
  });
});
