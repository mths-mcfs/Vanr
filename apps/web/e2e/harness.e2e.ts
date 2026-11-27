// The fixtures' own promises, checked where a journey would trip over them.
import { expect, test } from "./fixtures.ts";

test("signIn after a sign-out gives a session that works again", async ({
  page,
  server,
  seedUser,
  signIn,
}) => {
  const user = await seedUser({ workspace: "Harness Check" });
  await signIn(user);
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: user.workspace.name })).toBeVisible();

  // Sign the saved session out on the server, as the sign-out in the interface does.
  const revoke = await page.request.post(`${server.url}/api/auth/sign-out`, {
    headers: { origin: server.url },
    data: {},
  });
  expect(revoke.ok()).toBe(true);

  await signIn(user);
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: user.workspace.name })).toBeVisible();
});

test("seedUser joins an existing workspace with the role given, and invite opens an invitation", async ({
  server,
  seedUser,
  invite,
  apiAs,
}) => {
  const owner = await seedUser({ workspace: "Harness Team" });
  const admin = await seedUser({ joins: { by: owner, role: "admin" } });
  expect(admin.workspace).toEqual(owner.workspace);

  const api = await apiAs(owner);
  const members = await api.get(`${server.url}/api/v1/workspaces/${owner.workspace.id}/members`);
  const { members: list } = (await members.json()) as { members: { email: string; role: string }[] };
  expect(list.find((member) => member.email === admin.email)?.role).toBe("admin");

  const invitation = await invite(owner, { email: "later@people.example", role: "member" });
  expect(invitation.url).toContain(`/invite/${invitation.token}`);
  const open = await api.get(`${server.url}/api/v1/workspaces/${owner.workspace.id}/invitations`);
  const { invitations } = (await open.json()) as { invitations: { email: string | null }[] };
  expect(invitations.map((pending) => pending.email)).toContain("later@people.example");

  // The joined person is signed in as themselves.
  const theirs = await apiAs(admin);
  const me = await theirs.get(`${server.url}/api/v1/me`);
  expect(((await me.json()) as { user: { email: string } }).user.email).toBe(admin.email);
});
