// The control center end to end, against the real server and its runtime with the fake model: an agent
// asks to post in another channel, the person approves it on the approvals page, undoes the queued post
// from the approval's receipt, and allows the agent to post there always, so the next post runs
// without asking.
import type { APIRequestContext } from "@playwright/test";
import { expect, type SeededMember, test } from "./fixtures.ts";

type Setup = {
  api: APIRequestContext;
  workspaceId: string;
  general: string;
  handle: string;
  post: (text: string) => Promise<void>;
};

/** A workspace with #general and #announce, and an agent of the owner's in both. */
async function agentAsking(api: APIRequestContext, owner: SeededMember): Promise<Setup> {
  const workspaceId = owner.workspace.id;
  const base = `/api/v1/workspaces/${workspaceId}`;
  const listed = await api.get(`${base}/channels`);
  expect(listed.ok()).toBe(true);
  const { channels } = (await listed.json()) as { channels: { id: string; isGeneral: boolean }[] };
  const general = channels.find((channel) => channel.isGeneral)?.id;
  if (general === undefined) throw new Error("no #general");
  const created = await api.post(`${base}/channels`, { data: { name: "announce", visibility: "public" } });
  expect(created.ok()).toBe(true);
  const announce = ((await created.json()) as { id: string }).id;
  const handle = `herald${Date.now().toString(36)}`;
  const agent = await api.post(`${base}/agents`, {
    data: { name: "Herald", handle, role: "assistant", channelIds: [general, announce] },
  });
  expect(agent.ok()).toBe(true);
  let sent = 0;
  const post = async (text: string) => {
    sent += 1;
    const directive = JSON.stringify({ channel: "#announce", text });
    const answer = await api.post(`${base}/channels/${general}/messages`, {
      data: {
        body: `@${handle} tell them [[tool:post_message ${directive}]]`,
        clientId: `control-${handle}-${sent}`,
      },
    });
    expect(answer.ok()).toBe(true);
  };
  return { api, workspaceId, general, handle, post };
}

test.describe("the control center", () => {
  // The run asks, waits for the decision and carries it out: more than the usual 30 s on a busy machine.
  test.setTimeout(90_000);

  test("approve an agent's post, then undo it from the receipt before it goes out", async ({
    page,
    t,
    seedUser,
    signIn,
    apiAs,
  }) => {
    const owner = await seedUser({ workspace: "Control Journey" });
    const { post } = await agentAsking(await apiAs(owner), owner);
    await post("The press is back online.");

    await signIn(owner);
    await page.goto(`/workspace/${owner.workspace.id}/approvals`);
    const card = page.getByRole("article", {
      name: t("control", "title.post_message", { channel: "#announce" }),
    });
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card.getByText("The press is back online.")).toBeVisible();
    await expect(
      card.getByRole("img", { name: t("control", "effect.scale", { label: t("control", "effect.K2") }) }),
    ).toBeVisible();

    // Approve: the card says who approved, and the run carries it out.
    await card.getByRole("button", { name: t("control", "allow.send") }).click();
    await expect(
      card.getByText(
        t("control", "card.decidedBy", { status: t("control", "status.approved"), name: owner.name }),
      ),
    ).toBeVisible();
    await expect(card.getByText(t("control", "result.done"))).toBeVisible({ timeout: 30_000 });

    // Undo: the post waits in the send queue, and undoing it there cancels it.
    const receipt = card.getByRole("region", { name: t("control", "receipt.label") });
    await expect(
      receipt.getByText(t("control", "queued.message_posted", { title: "#announce" })),
    ).toBeVisible({
      timeout: 30_000,
    });
    await expect(receipt.getByRole("timer")).toBeVisible();
    await receipt.getByRole("button", { name: t("control", "receipt.undo") }).click();
    await expect(receipt.getByText(t("control", "receipt.canceled", { name: owner.name }))).toBeVisible();
    await expect(receipt.getByRole("button", { name: t("control", "receipt.undo") })).toHaveCount(0);

    // After a reload the decision and the cancel are still there: they came from the server.
    await page.reload();
    await page.getByRole("tab", { name: t("control", "filter.decided") }).click();
    const decided = page.getByRole("article", {
      name: t("control", "title.post_message", { channel: "#announce" }),
    });
    await expect(
      decided
        .getByRole("region", { name: t("control", "receipt.label") })
        .getByText(t("control", "receipt.canceled", { name: owner.name })),
    ).toBeVisible();
  });

  test("always allow: the rule shows in the panel and the next post does not ask", async ({
    page,
    t,
    seedUser,
    signIn,
    apiAs,
  }) => {
    const owner = await seedUser({ workspace: "Always Allow Journey" });
    const { api, workspaceId, general, post } = await agentAsking(await apiAs(owner), owner);
    await post("Proofs are on the table.");

    await signIn(owner);
    await page.goto(`/workspace/${workspaceId}/approvals`);
    const rules = page.getByRole("region", { name: t("control", "rules.title") });
    await expect(rules.getByText(t("control", "rules.empty"))).toBeVisible();
    const card = page.getByRole("article", {
      name: t("control", "title.post_message", { channel: "#announce" }),
    });
    await expect(card).toBeVisible({ timeout: 30_000 });
    await card.getByRole("checkbox", { name: new RegExp(t("control", "remember.label")) }).click();
    await card.getByRole("button", { name: t("control", "allow.send") }).click();
    await expect(page.getByText(t("control", "toast.remembered"), { exact: true })).toBeVisible();
    const list = page.getByRole("list", { name: t("control", "rules.list") });
    await expect(list.getByText(t("control", "rule.post_message", { label: "#announce" }))).toBeVisible();
    await expect(list.getByText("Herald")).toBeVisible();

    // The next post in #announce runs without asking: no new request, and the rule counts a use.
    await post("Second batch is ready.");
    await expect
      .poll(
        async () => {
          const answer = await api.get(`/api/v1/workspaces/${workspaceId}/approval-rules`);
          const { rules: live } = (await answer.json()) as { rules: { uses: number }[] };
          return live[0]?.uses ?? 0;
        },
        { timeout: 30_000 },
      )
      .toBe(1);
    const pending = await api.get(`/api/v1/workspaces/${workspaceId}/approvals?status=pending`);
    expect(((await pending.json()) as { approvals: unknown[] }).approvals).toEqual([]);
    // And the post went to the send queue: the run's answer carries its receipt, like the approved one.
    await expect
      .poll(
        async () => {
          const answer = await api.get(`/api/v1/workspaces/${workspaceId}/channels/${general}/messages`);
          const { messages } = (await answer.json()) as {
            messages: { actions: { kind: string; target: { type: string } }[] }[];
          };
          return messages
            .flatMap((message) => message.actions)
            .filter((action) => action.target.type === "outbox").length;
        },
        { timeout: 30_000 },
      )
      .toBe(2);
    await page.reload();
    await expect(page.getByText(t("control", "approvals.nonePending"))).toBeVisible();
    await expect(list.getByText(t("control", "rules.uses", { count: 1 }))).toBeVisible();
  });

  test("a member sees the request and who decides it, without the decision", async ({
    page,
    t,
    seedUser,
    signIn,
    apiAs,
  }) => {
    const owner = await seedUser({ workspace: "Member View Journey" });
    const member = await seedUser({ joins: { by: owner } });
    const { post } = await agentAsking(await apiAs(owner), owner);
    await post("Closing early today.");

    await signIn(member);
    await page.goto(`/workspace/${owner.workspace.id}/approvals`);
    const card = page.getByRole("article", {
      name: t("control", "title.post_message", { channel: "#announce" }),
    });
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card.getByText(t("control", "card.waitingFor", { name: owner.name }))).toBeVisible();
    await expect(card.getByRole("button", { name: t("control", "allow.send") })).toHaveCount(0);
    await expect(card.getByRole("checkbox")).toHaveCount(0);
  });
});
