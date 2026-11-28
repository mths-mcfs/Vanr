// The calendar and the routines end to end, against the real server and its runtime with the fake model.
// A weekly series is made from the header, shows on the same weekday a week later, and is cut from that
// occurrence on. A routine written in the page runs by hand, and its history shows the finished run with
// a way into the conversation the agent answered in.
import type { APIRequestContext, Page } from "@playwright/test";
import { expect, type Text, test } from "./fixtures.ts";

/** A day of the open week, by the label the page gives it in the browser's language. */
function dayRegion(page: Page, locale: string | undefined, at: Date) {
  const label = new Intl.DateTimeFormat(locale, { weekday: "long", day: "numeric", month: "long" }).format(
    at,
  );
  return page.getByRole("region", { name: label, exact: true });
}

async function occurrences(api: APIRequestContext, workspaceId: string, title: string, from: Date, to: Date) {
  const answer = await api.get(
    `/api/v1/workspaces/${workspaceId}/calendar?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`,
  );
  expect(answer.ok()).toBe(true);
  const { events } = (await answer.json()) as { events: { title: string; start: string }[] };
  return events.filter((event) => event.title === title).length;
}

const weekday = (t: Text, locale: string | undefined, at: Date) =>
  t("work", "cal.repeat.weekly", {
    day: new Intl.DateTimeFormat(locale, { weekday: "long", timeZone: "UTC" }).format(
      new Date(Date.UTC(2026, 10, 1 + at.getDay(), 12)),
    ),
  });

test.describe("the calendar", () => {
  test("a weekly series shows a week later, and is cut from that occurrence on", async ({
    page,
    locale,
    t,
    seedUser,
    signIn,
    apiAs,
  }) => {
    const owner = await seedUser({ workspace: "Calendar Journey" });
    const title = "Press calibration";
    const today = new Date();
    const nextWeek = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 7);
    await signIn(owner);
    await page.goto(`/workspace/${owner.workspace.id}/calendar`);

    await page.getByRole("button", { name: t("work", "calendar.new") }).click();
    const dialog = page.getByRole("dialog", { name: t("work", "cal.new.title") });
    await dialog.getByRole("textbox", { name: t("work", "cal.field.title") }).fill(title);
    await dialog.getByRole("combobox", { name: t("work", "cal.field.repeat") }).click();
    await page.getByRole("option", { name: weekday(t, locale, today) }).click();
    await dialog.getByRole("button", { name: t("work", "cal.create") }).click();
    await expect(page.getByText(t("work", "cal.created", { title }), { exact: true })).toBeVisible();
    await expect(
      dayRegion(page, locale, today).getByRole("button", { name: new RegExp(title) }),
    ).toBeVisible();

    // A week later, the same weekday has it too.
    await page.getByRole("button", { name: t("work", "calendar.next") }).click();
    const later = dayRegion(page, locale, nextWeek).getByRole("button", { name: new RegExp(title) });
    await expect(later).toBeVisible();

    // Cut the series from there on: next week's goes, this week's stays.
    await later.click();
    const open = page.getByRole("dialog", { name: title });
    await expect(open.getByText(weekday(t, locale, today))).toBeVisible();
    await open.getByRole("radio", { name: t("work", "cal.scope.following") }).click();
    await open.getByRole("button", { name: t("work", "cal.delete") }).click();
    await expect(page.getByText(t("work", "cal.deleted"), { exact: true })).toBeVisible();
    await expect(
      dayRegion(page, locale, nextWeek).getByRole("button", { name: new RegExp(title) }),
    ).toHaveCount(0);
    await page.getByRole("button", { name: t("work", "calendar.today") }).click();
    await expect(
      dayRegion(page, locale, today).getByRole("button", { name: new RegExp(title) }),
    ).toBeVisible();

    const api = await apiAs(owner);
    const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    expect(
      await occurrences(api, owner.workspace.id, title, start, new Date(start.getTime() + 86_400_000)),
    ).toBe(1);
    expect(
      await occurrences(
        api,
        owner.workspace.id,
        title,
        nextWeek,
        new Date(nextWeek.getTime() + 21 * 86_400_000),
      ),
    ).toBe(0);
  });
});

test.describe("the routines", () => {
  // The run goes through the runtime: more than the usual 30 s on a busy machine.
  test.setTimeout(90_000);

  test("a routine written here runs by hand and shows its finished run", async ({
    page,
    t,
    seedUser,
    signIn,
    apiAs,
  }) => {
    const owner = await seedUser({ workspace: "Routine Journey" });
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
    await page.goto(`/workspace/${owner.workspace.id}/routines`);

    await expect(page.getByText(t("work", "routines.empty.title"))).toBeVisible();
    await page
      .getByRole("button", { name: t("work", "routines.new") })
      .first()
      .click();
    const dialog = page.getByRole("dialog", { name: t("work", "routines.new") });
    await dialog.getByRole("textbox", { name: t("work", "routines.form.name") }).fill("Paper count");
    await dialog
      .getByRole("textbox", { name: t("work", "routines.form.instruction") })
      .fill("Count the paper left.");
    await dialog.getByRole("combobox", { name: t("work", "routines.form.trigger") }).click();
    await page.getByRole("option", { name: t("work", "routines.form.trigger.webhook") }).click();
    await dialog.getByRole("button", { name: t("work", "routines.form.create") }).click();
    await expect(
      page.getByText(t("work", "routines.form.created", { name: "Paper count" }), { exact: true }),
    ).toBeVisible();

    const routine = page.getByRole("article", { name: "Paper count" });
    await expect(routine.getByText(t("work", "routines.paused"), { exact: true })).toBeVisible();
    await routine.getByRole("button", { name: t("work", "routines.runNow") }).click();
    await expect(
      page.getByText(t("work", "routines.started", { name: "Paper count" }), { exact: true }),
    ).toBeVisible();
    const runs = routine.getByRole("list", { name: t("work", "routines.runs") });
    await expect(runs.getByText(t("work", "routines.status.ok"), { exact: true })).toBeVisible({
      timeout: 60_000,
    });
    await expect(runs.getByText(t("work", "routines.via.manual"), { exact: true })).toBeVisible();
    await expect(runs.getByRole("link", { name: t("work", "routines.run.session") })).toHaveAttribute(
      "href",
      new RegExp(`/workspace/${owner.workspace.id}/(channel|threads)/`),
    );
  });
});
