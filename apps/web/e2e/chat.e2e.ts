// Chat end to end, against the real server and its runtime with the fake model: a person messages an
// agent and watches the reply stream in with the tool it used, opens what that tool returned, approves
// an agent's post from the card in the conversation and withdraws the post from its receipt once it
// went out, and a private channel stays out of sight for someone who is not in it.
import type { APIRequestContext } from "@playwright/test";
import { expect, type SeededMember, test } from "./fixtures.ts";

type Channels = { general: string; announce: string };

async function channelsOf(api: APIRequestContext, owner: SeededMember): Promise<Channels> {
  const base = `/api/v1/workspaces/${owner.workspace.id}`;
  const listed = await api.get(`${base}/channels`);
  expect(listed.ok()).toBe(true);
  const { channels } = (await listed.json()) as { channels: { id: string; isGeneral: boolean }[] };
  const general = channels.find((channel) => channel.isGeneral)?.id;
  if (general === undefined) throw new Error("no #general");
  const created = await api.post(`${base}/channels`, { data: { name: "announce", visibility: "public" } });
  expect(created.ok()).toBe(true);
  return { general, announce: ((await created.json()) as { id: string }).id };
}

/** An agent of the owner's in the channels given. */
async function agentIn(api: APIRequestContext, owner: SeededMember, name: string, channelIds: string[]) {
  const handle = `${name.toLowerCase()}${Date.now().toString(36)}`;
  const created = await api.post(`/api/v1/workspaces/${owner.workspace.id}/agents`, {
    data: { name, handle, role: "assistant", channelIds },
  });
  expect(created.ok()).toBe(true);
  return { id: ((await created.json()) as { id: string }).id, handle, name };
}

test.describe("chat", () => {
  // A run that streams slowly, and a post that waits out the send queue: more than the usual 30 s.
  test.setTimeout(120_000);

  test("message an agent, watch the reply stream in, and open the result of the tool it used", async ({
    page,
    t,
    seedUser,
    signIn,
    apiAs,
  }) => {
    const owner = await seedUser({ workspace: "Chat Journey" });
    const api = await apiAs(owner);
    const { general } = await channelsOf(api, owner);
    const agent = await agentIn(api, owner, "Kiln", [general]);

    await signIn(owner);
    await page.goto(`/workspace/${owner.workspace.id}/dm/agent/${agent.id}`);
    await expect(page.getByRole("heading", { name: "Kiln" })).toBeVisible();
    const field = page.getByRole("textbox", { name: t("chat", "composer.hintDm") });
    await field.fill('[[slow:500]] note this [[tool:remember {"text":"Kiln B runs hot"}]]');
    await expect(page.getByText(t("chat", "composer.answering", { count: 1, agents: "Kiln" }))).toBeVisible();
    await field.press("Enter");
    await expect(field).toHaveValue("");

    // While it works: the agent lit, its first words streaming, then the tool it called.
    const run = page.getByRole("region", { name: t("chat", "run.label", { agent: "Kiln" }) });
    await expect(run).toBeVisible({ timeout: 30_000 });
    // The words themselves, as they stream: not the note they turn into once the tool is called.
    await expect(run.getByTestId("run-text")).toContainText(/save to memory/i);
    const steps = run.getByRole("list", { name: t("chat", "run.steps", { agent: "Kiln" }) });
    await expect(steps.getByRole("button", { name: /remember/ })).toBeVisible({ timeout: 30_000 });

    // The answer takes the run's place and says what the tool did.
    const log = page.getByRole("log", { name: t("chat", "history.label") });
    const answer = log.getByRole("article").filter({ hasText: "Saved to memory: Kiln B runs hot" });
    await expect(answer).toBeVisible({ timeout: 30_000 });
    await expect(run).toHaveCount(0);

    // The steps behind it open on demand, with what the tool returned.
    await answer.getByRole("button", { name: t("chat", "steps.show", { count: 1 }) }).click();
    const saved = answer.getByRole("list", { name: t("chat", "steps.label") });
    await saved.getByRole("button", { name: /remember/ }).click();
    await expect(saved.getByRole("region", { name: t("chat", "step.output") })).not.toBeEmpty();

    // After a reload it is all still there: it came from the server.
    await page.reload();
    await expect(log.getByText("Saved to memory: Kiln B runs hot")).toBeVisible();
    await expect(log.getByText(/note this/)).toBeVisible();
  });

  test("approve an agent's post from the card in the conversation, then withdraw it from its receipt", async ({
    page,
    t,
    seedUser,
    signIn,
    apiAs,
  }) => {
    const owner = await seedUser({ workspace: "Chat Approve Journey" });
    const member = await seedUser({ joins: { by: owner } });
    const api = await apiAs(owner);
    const { general, announce } = await channelsOf(api, owner);
    const agent = await agentIn(api, owner, "Herald", [general, announce]);
    // The member reads #announce too, to see the post go and then go away.
    await (await apiAs(member)).post(`/api/v1/workspaces/${owner.workspace.id}/channels/${announce}/join`);

    await signIn(owner);
    await page.goto(`/workspace/${owner.workspace.id}/channel/${general}`);
    const field = page.getByRole("textbox", {
      name: t("chat", "composer.hintChannel", { channel: "general" }),
    });
    const directive = JSON.stringify({ channel: "#announce", text: "Glaze firing moved to Friday." });
    await field.fill(`@${agent.handle} tell them [[tool:post_message ${directive}]]`);
    await field.press("Enter");

    // The request lands in the conversation as the control center's card, and is approved there.
    const card = page.getByRole("article", {
      name: t("control", "title.post_message", { channel: "#announce" }),
    });
    await expect(card).toBeVisible({ timeout: 30_000 });
    await card.getByRole("button", { name: t("control", "allow.send") }).click();
    await expect(
      card.getByText(
        t("control", "card.decidedBy", { status: t("control", "status.approved"), name: owner.name }),
      ),
    ).toBeVisible();

    // The answer carries the receipt; once the post went out, undo withdraws it.
    const log = page.getByRole("log", { name: t("chat", "history.label") });
    const answer = log.getByRole("article").filter({ hasText: "Posted in the channel" }).last();
    const receipt = answer.getByRole("region", { name: t("control", "receipt.label") });
    await expect(receipt.getByText(t("control", "kind.message_posted", { title: "#announce" }))).toBeVisible({
      timeout: 60_000,
    });
    await receipt.getByRole("button", { name: t("control", "receipt.undo") }).click();
    await expect(receipt.getByText(t("control", "receipt.undone", { name: owner.name }))).toBeVisible();

    // In #announce the post is withdrawn, for the owner and for the member alike.
    const withdrawn = t("chat", "post.withdrawn", { name: owner.name });
    await page.goto(`/workspace/${owner.workspace.id}/channel/${announce}`);
    await expect(page.getByText(withdrawn)).toBeVisible();
    await expect(page.getByText("Glaze firing moved to Friday.")).toHaveCount(0);
    await signIn(member);
    await page.reload();
    await expect(page.getByText(withdrawn)).toBeVisible();
    await expect(page.getByText("Glaze firing moved to Friday.")).toHaveCount(0);
  });

  test("a private channel stays out of sight for someone who is not in it", async ({
    page,
    t,
    seedUser,
    signIn,
    apiAs,
  }) => {
    const owner = await seedUser({ workspace: "Chat Private Journey" });
    const insider = await seedUser({ joins: { by: owner } });
    const outsider = await seedUser({ joins: { by: owner } });
    const api = await apiAs(owner);
    const base = `/api/v1/workspaces/${owner.workspace.id}`;
    const created = await api.post(`${base}/channels`, { data: { name: "payroll", visibility: "private" } });
    expect(created.ok()).toBe(true);
    const payroll = ((await created.json()) as { id: string }).id;
    const listed = await api.get(`${base}/members`);
    const { members } = (await listed.json()) as { members: { userId: string; email: string }[] };
    const insiderId = members.find((entry) => entry.email === insider.email)?.userId;
    expect(
      (await api.post(`${base}/channels/${payroll}/members`, { data: { userId: insiderId } })).ok(),
    ).toBe(true);
    expect(
      (
        await api.post(`${base}/channels/${payroll}/messages`, {
          data: { body: "Bonuses go out on the 30th.", clientId: `payroll-${Date.now()}` },
        })
      ).ok(),
    ).toBe(true);

    // Someone in it sees it in the sidebar, marked private and unread, and reads it.
    await signIn(insider);
    await page.goto(`/workspace/${owner.workspace.id}`);
    const sidebar = page.getByRole("complementary");
    const link = sidebar.getByRole("link", { name: /payroll/ });
    await expect(link).toBeVisible();
    await expect(link).toContainText(t("chat", "room.private"));
    await expect(link).toContainText(t("chat", "side.unread", { count: 1 }));
    await link.click();
    await expect(page.getByText("Bonuses go out on the 30th.")).toBeVisible();
    await expect(link).not.toContainText(t("chat", "side.unread", { count: 1 }));

    // Someone outside it sees no name, no count, and its address answers like no channel at all.
    await signIn(outsider);
    await page.goto(`/workspace/${owner.workspace.id}`);
    await expect(sidebar.getByRole("link", { name: /general/ })).toBeVisible();
    await expect(sidebar.getByText("payroll")).toHaveCount(0);
    await page.goto(`/workspace/${owner.workspace.id}/channel/${payroll}`);
    await expect(page.getByText(t("chat", "missing.title"))).toBeVisible();
    await expect(page.getByText("Bonuses go out on the 30th.")).toHaveCount(0);
    await expect(page.getByText("payroll")).toHaveCount(0);
  });

  test("calling an agent that isn't in the channel tells the author why", async ({
    page,
    t,
    seedUser,
    signIn,
    apiAs,
  }) => {
    const owner = await seedUser({ workspace: "Chat Absent Journey" });
    const api = await apiAs(owner);
    const { general, announce } = await channelsOf(api, owner);
    // The agent lives in #general only; the author calls it from #announce.
    const agent = await agentIn(api, owner, "Quill", [general]);
    await signIn(owner);
    await page.goto(`/workspace/${owner.workspace.id}/channel/${announce}`);
    const field = page.getByRole("textbox", {
      name: t("chat", "composer.hintChannel", { channel: "announce" }),
    });
    await field.fill(`@${agent.handle} can you check this?`);
    await field.press("Enter");
    await expect(page.getByText(t("chat", "blocked.not_in_channel", { agent: "Quill" }))).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText("not_in_channel")).toHaveCount(0);
  });
});
