// Pairing a runner end to end, against the real server: a stand-in for the runner asks for a code the way
// `vanr-runner pair` does, the owner confirms it on /connect, and the runner's next poll gets its
// credential. The runner then shows in the workspace's runners and has a page of its own.
import { request } from "@playwright/test";
import { expect, test } from "./fixtures.ts";

type Start = { userCode: string; deviceCode: string; verificationUrl: string };

test("an owner pairs a runner by code, and the runner receives its credential", async ({
  page,
  t,
  server,
  seedUser,
  signIn,
}) => {
  const owner = await seedUser({ workspace: "Runner Journey" });
  // The runner has no session: it talks to the server on its own.
  const runner = await request.newContext({ baseURL: server.url });
  try {
    const started = await runner.post("/api/v1/runner-pairings", {
      data: { name: "Garage laptop", os: "linux", arch: "x64", hostname: "garage.local", version: "1.0.0" },
    });
    expect(started.ok()).toBe(true);
    const start = (await started.json()) as Start;
    const poll = async () => {
      const answer = await runner.post("/api/v1/runner-pairings/token", {
        data: { deviceCode: start.deviceCode },
      });
      return (await answer.json()) as {
        error?: string;
        token?: string;
        name?: string;
        workspace?: { id: string };
      };
    };
    expect((await poll()).error).toBe("authorization_pending");

    await signIn(owner);
    await page.goto(new URL(start.verificationUrl).pathname + new URL(start.verificationUrl).search);
    await expect(
      page.getByRole("heading", { name: t("agents", "pair.askTitle", { name: "Garage laptop" }) }),
    ).toBeVisible();
    const facts = page.getByLabel(t("agents", "pair.computer"));
    await expect(facts).toContainText("garage.local");
    await expect(facts).toContainText(start.userCode);
    // One workspace where the owner may post: it is already picked.
    const name = page.getByLabel(t("agents", "runner.name"));
    await expect(name).toHaveValue("Garage laptop");
    await name.fill("Garage");
    await page.getByRole("button", { name: t("agents", "pair.accept") }).click();
    await expect(
      page.getByRole("heading", { name: t("agents", "pair.accepted", { name: "Garage" }) }),
    ).toBeVisible();

    // The runner's next poll carries its credential and the workspace.
    const paired = await poll();
    expect(paired.token).toBeTruthy();
    expect(paired.name).toBe("Garage");
    expect(paired.workspace?.id).toBe(owner.workspace.id);

    await page.getByRole("button", { name: t("agents", "pair.openRunner") }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Garage" })).toBeVisible();
    await expect(page.getByText(t("agents", "runners.offline")).first()).toBeVisible();
    await page.getByRole("link", { name: t("agents", "runner.back") }).click();
    const list = page.getByRole("list", { name: t("agents", "runners.title") });
    await expect(list.getByRole("listitem").filter({ hasText: "Garage" })).toBeVisible();
  } finally {
    await runner.dispose();
  }
});

test("a code typed by hand that was already used is refused and can be typed again", async ({
  page,
  t,
  server,
  seedUser,
  signIn,
}) => {
  const owner = await seedUser({ workspace: "Runner Refusal" });
  const runner = await request.newContext({ baseURL: server.url });
  try {
    const started = await runner.post("/api/v1/runner-pairings", {
      data: { os: "darwin", arch: "arm64", hostname: "studio.local", version: "1.0.0" },
    });
    const start = (await started.json()) as Start;
    await signIn(owner);
    await page.goto("/connect");
    await page
      .getByLabel(t("agents", "pair.code"), { exact: true })
      .fill(` ${start.userCode.toLowerCase()} `);
    await page.getByRole("button", { name: t("agents", "pair.check") }).click();
    await expect(page.getByRole("button", { name: t("agents", "pair.deny") })).toBeVisible();
    await page.getByRole("button", { name: t("agents", "pair.deny") }).click();
    await expect(page.getByRole("heading", { name: t("agents", "pair.declined") })).toBeVisible();
    const answer = await runner.post("/api/v1/runner-pairings/token", {
      data: { deviceCode: start.deviceCode },
    });
    expect(((await answer.json()) as { error?: string }).error).toBe("access_denied");

    await page.goto(`/connect?code=${start.userCode}`);
    await expect(page.getByRole("heading", { name: t("agents", "pair.invalid") })).toBeVisible();
    await expect(page.getByLabel(t("agents", "pair.code"), { exact: true })).toHaveValue(start.userCode);
  } finally {
    await runner.dispose();
  }
});
