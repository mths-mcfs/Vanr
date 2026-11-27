// The inbox end to end: a real mention reaches the person, who reads it and snoozes (mutes) it, and
// a channel muted in the preferences stays muted.
import type { APIRequestContext } from "@playwright/test";
import { expect, type SeededMember, test } from "./fixtures.ts";

/** The workspace's #general channel, as the person sees it. */
async function generalOf(api: APIRequestContext, workspaceId: string): Promise<string> {
  const answer = await api.get(`/api/v1/workspaces/${workspaceId}/channels`);
  expect(answer.ok()).toBe(true);
  const { channels } = (await answer.json()) as { channels: { id: string; isGeneral: boolean }[] };
  const general = channels.find((channel) => channel.isGeneral);
  if (general === undefined) throw new Error("no #general");
  return general.id;
}

/** The handle others type to mention this person here. */
async function handleOf(api: APIRequestContext, person: SeededMember): Promise<string> {
  const answer = await api.get(`/api/v1/workspaces/${person.workspace.id}/members`);
  expect(answer.ok()).toBe(true);
  const { members } = (await answer.json()) as { members: { email: string; handle: string }[] };
  const found = members.find((member) => member.email === person.email);
  if (found === undefined) throw new Error("not a member");
  return found.handle;
}

test("a mention arrives in the inbox; opening it reads it and snoozing it mutes it", async ({
  page,
  t,
  seedUser,
  signIn,
  apiAs,
}) => {
  const owner = await seedUser({ workspace: "Inbox Journey" });
  const colleague = await seedUser({ joins: { by: owner } });
  const api = await apiAs(colleague);
  const general = await generalOf(api, owner.workspace.id);
  const posted = await api.post(`/api/v1/workspaces/${owner.workspace.id}/channels/${general}/messages`, {
    data: { body: `@${await handleOf(api, owner)} the proofs are ready`, clientId: `journey-${Date.now()}` },
  });
  expect(posted.ok()).toBe(true);

  await signIn(owner);
  const inbox = `/workspace/${owner.workspace.id}/notifications`;
  await page.goto(inbox);
  const headline = t("inbox", "kind.mentionIn", { who: colleague.name, label: "#general" });
  const unread = page.getByRole("button", { name: `${t("inbox", "unreadMark")} ${headline}` });
  await expect(unread).toBeVisible();
  await expect(page.getByText("the proofs are ready")).toBeVisible();

  // Opening it goes to the channel and marks it read.
  await unread.click();
  await expect(page).toHaveURL(new RegExp(`/workspace/${owner.workspace.id}/channel/${general}$`));
  await page.goto(inbox);
  const read = page.getByRole("button", { name: headline, exact: true });
  await expect(read).toBeVisible();
  await expect(page.getByText(t("inbox", "allRead"))).toBeVisible();

  // Snoozing hides it until then.
  const row = page.getByRole("listitem").filter({ has: read });
  await row.getByRole("button", { name: t("inbox", "snooze") }).click();
  await page.getByRole("menuitem", { name: t("inbox", "snoozeFor.hour") }).click();
  await expect(read).toHaveCount(0);
  await expect(page.getByText(t("inbox", "empty.action_needed.title"))).toBeVisible();
  await page.reload();
  await expect(page.getByText(t("inbox", "empty.action_needed.title"))).toBeVisible();
});

test("a channel muted in the preferences stays muted", async ({ page, t, seedUser, signIn }) => {
  const owner = await seedUser({ workspace: "Mute Journey" });
  await signIn(owner);
  await page.goto(`/workspace/${owner.workspace.id}/notifications/settings`);
  await expect(page.getByText(t("inbox", "prefs.mutedNone"))).toBeVisible();
  await page.getByRole("combobox", { name: t("inbox", "prefs.mute") }).click();
  await page.getByRole("option", { name: "#general" }).click();
  await page.getByRole("button", { name: t("inbox", "prefs.save") }).click();
  await expect(page.getByText(t("inbox", "prefs.saved"), { exact: true })).toBeVisible();

  await page.reload();
  const muted = page.getByRole("list", { name: t("inbox", "prefs.muted") });
  await expect(muted.getByText("#general")).toBeVisible();
  await expect(
    page.getByRole("button", { name: t("inbox", "prefs.unmute", { channel: "#general" }) }),
  ).toBeVisible();
});
