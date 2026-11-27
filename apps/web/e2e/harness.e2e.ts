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
