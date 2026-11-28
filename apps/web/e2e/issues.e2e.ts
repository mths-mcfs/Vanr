// The issues end to end, against the real server: the owner writes an issue whose list lines become its
// criteria, drags its card from "To do" to "In progress" with the mouse, carries it on to "In review"
// from the keyboard, and opens it to meet a criterion and comment. Each move is still there after a
// reload, and a second member opening the board sees the card where the owner left it.
import type { Locator, Page } from "@playwright/test";
import { expect, type Text, test } from "./fixtures.ts";

const lane = (page: Page, t: Text, stage: "todo" | "in_progress" | "reviewing") =>
  page.getByRole("region", { name: new RegExp(`^${t("work", `stage.${stage}`)},`) });

const card = (column: Locator, title: string) =>
  column.getByRole("listitem").filter({ has: column.page().getByRole("link", { name: title }) });

test.describe("the issues board", () => {
  test("write an issue, drag it, move it from the keyboard and open it", async ({
    page,
    browser,
    baseURL,
    locale,
    t,
    seedUser,
    signIn,
    apiAs,
  }) => {
    const owner = await seedUser({ workspace: "Board Journey" });
    const member = await seedUser({ joins: { by: owner } });
    const title = "Recalibrate the folding machine";
    await signIn(owner);
    await page.goto(`/workspace/${owner.workspace.id}/issues`);

    // An empty board says what belongs there; the new issue's list lines become its criteria.
    await expect(page.getByText(t("work", "tracker.empty.title"))).toBeVisible();
    await page
      .getByRole("button", { name: t("work", "tracker.new") })
      .first()
      .click();
    const dialog = page.getByRole("dialog", { name: t("work", "new.title") });
    await dialog.getByRole("textbox", { name: t("work", "new.issueTitle") }).fill(title);
    await dialog
      .getByRole("textbox", { name: t("work", "new.description") })
      .fill("The fold drifts by 2 mm.\n- Fold within 0.5 mm\n- [ ] Sample run signed off");
    await expect(
      dialog.getByText(t("work", "new.criteriaFound", { count: 2 }), { exact: false }),
    ).toBeVisible();
    await dialog.getByRole("button", { name: t("work", "new.submit") }).click();
    await expect(page.getByText(t("work", "new.created", { number: 1 }), { exact: true })).toBeVisible();
    const todo = lane(page, t, "todo");
    await expect(card(todo, title)).toBeVisible();
    await expect(
      card(todo, title).getByRole("img", { name: t("work", "criteria.progress", { done: 0, total: 2 }) }),
    ).toBeVisible();

    // The mouse: drag the card into "In progress"; the server keeps it there.
    const working = lane(page, t, "in_progress");
    await card(todo, title).dragTo(working);
    await expect(card(working, title)).toBeVisible();
    await expect(card(todo, title)).toHaveCount(0);
    await page.reload();
    await expect(card(lane(page, t, "in_progress"), title)).toBeVisible();

    // The keyboard: pick it up, carry it right, drop it in "In review".
    const grab = page.getByRole("button", { name: t("work", "board.grab", { number: 1 }) });
    await grab.focus();
    await page.keyboard.press("Space");
    await expect(
      page.getByRole("status").filter({
        hasText: t("work", "board.picked", {
          number: 1,
          column: t("work", "stage.in_progress"),
          position: 1,
          total: 1,
        }),
      }),
    ).toHaveCount(1);
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Space");
    await expect(
      page.getByRole("status").filter({
        hasText: t("work", "board.dropped", {
          number: 1,
          column: t("work", "stage.reviewing"),
          position: 1,
          total: 1,
        }),
      }),
    ).toHaveCount(1);
    const reviewing = lane(page, t, "reviewing");
    await expect(card(reviewing, title)).toBeVisible();
    const api = await apiAs(owner);
    await expect
      .poll(async () => {
        const answer = await api.get(`/api/v1/workspaces/${owner.workspace.id}/issues/seq/1`);
        return ((await answer.json()) as { status: string }).status;
      })
      .toBe("reviewing");

    // The issue: meet a criterion and comment; the activity tells both.
    await card(reviewing, title).getByRole("link", { name: title }).click();
    await expect(page.getByRole("heading", { level: 1, name: `#1 ${title}` })).toBeVisible();
    await page.getByRole("checkbox", { name: "Fold within 0.5 mm" }).click();
    const activity = page.getByRole("region", { name: t("work", "issue.activity") });
    await expect(
      activity.getByText(t("work", "event.criterion_done", { who: owner.name, text: "Fold within 0.5 mm" })),
    ).toBeVisible();
    await page
      .getByRole("textbox", { name: t("work", "issue.comment") })
      .fill("Rollers swapped, looks right.");
    await page.getByRole("button", { name: t("work", "issue.commentSend") }).click();
    await expect(activity.getByText("Rollers swapped, looks right.")).toBeVisible();
    await expect(page.getByRole("textbox", { name: t("work", "issue.comment") })).toHaveValue("");
    await expect(
      activity.getByText(
        t("work", "event.status", {
          who: owner.name,
          from: t("work", "stage.in_progress"),
          to: t("work", "stage.reviewing"),
        }),
      ),
    ).toBeVisible();

    // Someone else opening the board finds the card where the owner left it.
    const memberApi = await apiAs(member);
    const other = await browser.newContext({
      baseURL,
      locale,
      storageState: await memberApi.storageState(),
    });
    try {
      const theirs = await other.newPage();
      await theirs.goto(`/workspace/${owner.workspace.id}/issues`);
      const column = lane(theirs, t, "reviewing");
      await expect(card(column, title)).toBeVisible();
      await expect(
        card(column, title).getByRole("img", { name: t("work", "criteria.progress", { done: 1, total: 2 }) }),
      ).toBeVisible();
    } finally {
      await other.close();
    }
  });
});
