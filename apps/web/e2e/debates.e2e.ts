// Starting a debate end to end, against the real server and its runtime with the fake model: the owner
// puts a question to two agents and a member from the debates page, in that speaking order, and finds it
// in the list with the member waited on; the member's own list puts it under what needs them, as their
// turn. The server holds the table as it was picked.
import { expect, test } from "./fixtures.ts";

test.describe("the debates", () => {
  // Opening hands round 0 to the runtime: more than the usual 30 s on a busy machine.
  test.setTimeout(90_000);

  test("a debate with two agents and a person starts and waits on the person", async ({
    page,
    t,
    seedUser,
    signIn,
    apiAs,
  }) => {
    const owner = await seedUser({ workspace: "Debate Journey" });
    const member = await seedUser({ joins: { by: owner } });
    const api = await apiAs(owner);
    const base = `/api/v1/workspaces/${owner.workspace.id}`;
    const { channels } = (await (await api.get(`${base}/channels`)).json()) as {
      channels: { id: string; isGeneral: boolean }[];
    };
    const general = channels.find((channel) => channel.isGeneral)?.id ?? "";
    const suffix = Date.now().toString(36);
    for (const name of ["Quill", "Rivet"]) {
      const made = await api.post(`${base}/agents`, {
        data: { name, handle: `${name.toLowerCase()}${suffix}`, role: "assistant", channelIds: [general] },
      });
      expect(made.ok()).toBe(true);
    }

    await signIn(owner);
    await page.goto(`/workspace/${owner.workspace.id}/debates`);
    await expect(page.getByText(t("debates", "list.empty.title"))).toBeVisible();
    await page
      .getByRole("button", { name: t("debates", "list.start") })
      .first()
      .click();
    const dialog = page.getByRole("dialog", { name: t("debates", "start.title") });
    await dialog
      .getByRole("textbox", { name: t("debates", "start.question") })
      .fill("Do we rent a second press?");
    await dialog.getByRole("checkbox", { name: "Rivet" }).click();
    await dialog.getByRole("checkbox", { name: "Quill" }).click();
    await dialog.getByRole("checkbox", { name: member.name }).click();
    await expect(
      dialog.getByRole("checkbox", { name: t("debates", "start.seat", { order: 3, name: member.name }) }),
    ).toBeVisible();
    await expect(dialog.getByText(t("debates", "start.estimate.pick"))).toHaveCount(0);
    await dialog.getByRole("button", { name: t("debates", "start.submit") }).click();
    await expect(page).toHaveURL(/\/debates\/[^/]+$/);

    await page.goto(`/workspace/${owner.workspace.id}/debates`);
    const row = page.getByRole("article", { name: "Do we rent a second press?" });
    await expect(row).toBeVisible();
    await expect(row.getByText(t("debates", "row.waitsOn", { name: member.name }))).toBeAttached();
    await expect(row.getByText(t("debates", "row.opening"))).toBeVisible();

    const { debates } = (await (await api.get(`${base}/debates`)).json()) as {
      debates: { title: string; goal: string; speakers: { type: string }[]; waitingUserIds: string[] }[];
    };
    const made = debates.find((debate) => debate.title === "Do we rent a second press?");
    expect(made?.goal).toBe("Do we rent a second press?");
    expect(made?.speakers.map((speaker) => speaker.type)).toEqual(["agent", "agent", "person"]);
    expect(made?.waitingUserIds.length).toBe(1);

    await signIn(member);
    await page.goto(`/workspace/${owner.workspace.id}/debates`);
    const needs = page.getByRole("region", { name: t("debates", "list.group.you", { count: 1 }) });
    const mine = needs.getByRole("article", { name: "Do we rent a second press?" });
    await expect(mine).toBeVisible();
    await expect(mine.getByText(t("debates", "state.yourTurn"))).toBeVisible();
  });
});
