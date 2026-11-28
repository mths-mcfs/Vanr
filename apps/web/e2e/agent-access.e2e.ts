// An agent's per-channel rules, against the real server: a member sees the rules of the channels they
// read, never those of a private channel they are not in, while someone in that channel sees both.
import { expect, test } from "./fixtures.ts";

test("a member never sees an agent's rule for a private channel they are not in", async ({
  page,
  t,
  seedUser,
  signIn,
  apiAs,
}) => {
  const owner = await seedUser({ workspace: "Access Journey" });
  const member = await seedUser({ joins: { by: owner } });
  const api = await apiAs(owner);
  const workspaceId = owner.workspace.id;
  const channels = (await (await api.get(`/api/v1/workspaces/${workspaceId}/channels`)).json()) as {
    channels: { id: string; isGeneral: boolean }[];
  };
  const general = channels.channels.find((channel) => channel.isGeneral);
  if (general === undefined) throw new Error("the workspace has no #general");
  const created = await api.post(`/api/v1/workspaces/${workspaceId}/channels`, {
    data: { name: "payroll", visibility: "private" },
  });
  expect(created.ok()).toBe(true);
  const payroll = (await created.json()) as { id: string };
  const agent = await api.post(`/api/v1/workspaces/${workspaceId}/agents`, {
    data: {
      name: "Ledger Keeper",
      handle: "ledger-keeper",
      role: "finance",
      channelIds: [general.id, payroll.id],
    },
  });
  expect(agent.ok()).toBe(true);
  const { id: agentId } = (await agent.json()) as { id: string };
  const rules = await api.put(`/api/v1/workspaces/${workspaceId}/agents/${agentId}/identity/channels`, {
    data: {
      channels: [
        { channelId: general.id, connectionId: "*", level: "read" },
        { channelId: payroll.id, connectionId: "*", level: "off" },
      ],
    },
  });
  expect(rules.ok()).toBe(true);

  await signIn(member);
  await page.goto(`/workspace/${workspaceId}/agents/${agentId}?tab=access`);
  const list = page.getByRole("list", { name: t("agents", "access.rules") });
  await expect(list.getByRole("listitem")).toHaveCount(1);
  await expect(list).toContainText("#general");
  await expect(list).toContainText(t("agents", "access.level.read"));
  await expect(page.getByText("payroll")).toHaveCount(0);
  await expect(page.getByRole("form", { name: t("agents", "access.addRule") })).toHaveCount(0);

  await signIn(owner);
  await page.reload();
  await expect(list.getByRole("listitem")).toHaveCount(2);
  await expect(list).toContainText("#payroll");
  await expect(list).toContainText(t("agents", "access.level.off"));
});
