// An assignment end to end, against the real server and its runtime with the fake model: the owner gives an
// agent a goal from the assignments page, starts it, pauses and resumes it, and closes it as done; the list
// then shows it among the closed ones, and the server holds the outcome.
import { expect, test } from "./fixtures.ts";

test.describe("the assignments", () => {
  // Starting hands the goal to the runtime: more than the usual 30 s on a busy machine.
  test.setTimeout(90_000);

  test("an assignment goes from a goal to done", async ({ page, t, seedUser, signIn, apiAs }) => {
    const owner = await seedUser({ workspace: "Assignment Journey" });
    const api = await apiAs(owner);
    const base = `/api/v1/workspaces/${owner.workspace.id}`;
    const { channels } = (await (await api.get(`${base}/channels`)).json()) as {
      channels: { id: string; isGeneral: boolean }[];
    };
    const general = channels.find((channel) => channel.isGeneral)?.id ?? "";
    const made = await api.post(`${base}/agents`, {
      data: {
        name: "Ledger",
        handle: `ledger${Date.now().toString(36)}`,
        role: "assistant",
        channelIds: [general],
      },
    });
    expect(made.ok()).toBe(true);
    await signIn(owner);
    await page.goto(`/workspace/${owner.workspace.id}/assignments`);

    await expect(page.getByText(t("work", "asg.empty.title"))).toBeVisible();
    await page
      .getByRole("button", { name: t("work", "asg.new") })
      .first()
      .click();
    const dialog = page.getByRole("dialog", { name: t("work", "asg.new") });
    await dialog.getByRole("textbox", { name: t("work", "asg.form.goal") }).fill("Every shelf has a label.");
    await dialog.getByRole("textbox", { name: t("work", "asg.form.title") }).fill("Label the shelves");
    await dialog.getByRole("button", { name: t("work", "asg.form.create") }).click();

    await expect(page.getByRole("heading", { level: 1, name: "Label the shelves" })).toBeVisible();
    const panel = page.getByRole("region", { name: t("work", "asg.panel") });
    await expect(panel.getByText(t("work", "asg.status.proposed"), { exact: true })).toBeVisible();
    await expect(panel.getByText(t("work", "asg.role.owner"), { exact: true })).toBeVisible();

    await panel.getByRole("button", { name: t("work", "asg.start") }).click();
    await expect(panel.getByText(t("work", "asg.status.active"), { exact: true })).toBeVisible();
    await panel.getByRole("button", { name: t("work", "asg.pause") }).click();
    await expect(panel.getByText(t("work", "asg.status.paused"), { exact: true })).toBeVisible();
    await panel.getByRole("button", { name: t("work", "asg.resume") }).click();
    await expect(panel.getByText(t("work", "asg.status.active"), { exact: true })).toBeVisible();

    await panel.getByRole("tab", { name: new RegExp(`^${t("work", "asg.tab.trail")}`) }).click();
    await expect(panel.getByText(new RegExp(t("work", "asg.ev.started")))).toBeVisible();

    await panel.getByRole("button", { name: t("work", "asg.close") }).click();
    const close = page.getByRole("dialog", { name: t("work", "asg.close.title") });
    await close.getByRole("radio", { name: t("work", "asg.close.done") }).click();
    await close.getByRole("textbox", { name: t("work", "asg.close.note") }).fill("Labels are up.");
    await close.getByRole("button", { name: t("work", "asg.close.submit") }).click();
    await expect(page.getByText(t("work", "asg.closed"), { exact: true })).toBeVisible();
    await expect(panel.getByText(t("work", "asg.status.done"), { exact: true })).toBeVisible();
    await expect(panel.getByRole("button", { name: t("work", "asg.close") })).toHaveCount(0);

    await page.getByRole("link", { name: t("work", "asg.page.back") }).click();
    await page.getByRole("tab", { name: t("work", "asg.tab.closed", { count: 1 }) }).click();
    await expect(page.getByRole("article", { name: "Label the shelves" })).toBeVisible();
    const { assignments } = (await (await api.get(`${base}/assignments?status=closed`)).json()) as {
      assignments: { title: string; outcome: string | null }[];
    };
    expect(assignments.find((each) => each.title === "Label the shelves")?.outcome).toBe("done");
  });
});
