import { expect, test } from "./fixtures.ts";

const OUT =
  "/tmp/claude-1000/-home-matheus-Work-reposit-rios-home/137184a2-e624-4fc6-a6ed-c44cbc468474/scratchpad/shots";
test("shots", async ({ page, server, seedUser, signIn }, info) => {
  test.skip(info.project.name !== "en");
  await page.setViewportSize({ width: 1280, height: 800 });
  const user = await seedUser({ workspace: "Press Room" });
  await signIn(user);
  const ws = user.workspace.id;
  const post = (path: string, data: unknown) =>
    page.request.post(`/api/v1/workspaces/${ws}${path}`, { headers: { origin: server.url }, data });
  await post("/files", {
    title: "Release plan",
    content: { kind: "document", markdown: "# Plan\nShip the press calendar in March." },
  });
  await post("/files", {
    title: "Paper stock",
    content: {
      kind: "table",
      columns: ["Item", "Cost"],
      rows: [
        ["Paper", "120"],
        ["Ink", "80"],
      ],
    },
  });
  await page.goto(`/workspace/${ws}/files`);
  await page
    .getByTestId("files-upload")
    .setInputFiles({
      name: "field-notes.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Ink drying times by paper weight."),
    });
  await expect(page.getByText("Uploaded")).toBeVisible();
  await page.screenshot({ path: `${OUT}/drive-grid.png`, fullPage: true });
  await page.getByRole("button", { name: "List" }).click();
  await page.screenshot({ path: `${OUT}/drive-list.png`, fullPage: true });
  await page.getByRole("button", { name: "Release plan" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.screenshot({ path: `${OUT}/preview.png` });
  await page.goto(`/workspace/${ws}/search?q=ink`);
  await expect(page.getByRole("list", { name: "Results" })).toBeVisible();
  await page.getByRole("button", { name: "Search operators" }).click();
  await page.screenshot({ path: `${OUT}/search.png`, fullPage: true });
  await page.goto(`/workspace/${ws}/bases`);
  await page.getByRole("button", { name: "New base" }).first().click();
  await page.getByRole("dialog").getByRole("textbox").fill("Tasks");
  await page.getByRole("button", { name: "Create base" }).click();
  await page.getByRole("button", { name: "New property" }).click();
  const d = page.getByRole("dialog", { name: "New property" });
  await d.getByRole("textbox", { name: "Name" }).fill("Status");
  await d.getByRole("combobox", { name: "Type" }).selectOption({ label: "Status" });
  await page.screenshot({ path: `${OUT}/property.png` });
  await d.getByRole("button", { name: "Save property" }).click();
  for (const name of ["Wash", "Dry", "Fold"]) {
    await page.getByRole("button", { name: "New row" }).click();
    const tt = page.getByRole("textbox", { name: "Name of Untitled" });
    await tt.fill(name);
    await tt.press("Enter");
    await expect(page.getByRole("textbox", { name: `Name of ${name}` })).toBeVisible();
  }
  await page.getByRole("combobox", { name: "Status of Dry" }).selectOption({ label: "Done" });
  await page.getByRole("combobox", { name: "Status of Fold" }).selectOption({ label: "In progress" });
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/base-grid.png`, fullPage: true });
  await page.getByRole("button", { name: "New view" }).click();
  await page.getByRole("button", { name: "Board" }).click();
  await expect(page.getByRole("region", { name: "Board" })).toBeVisible();
  await page.screenshot({ path: `${OUT}/base-board.png`, fullPage: true });
  await page.getByRole("button", { name: "Wash" }).click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/row-panel.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/workspace/${ws}/files`);
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT}/drive-phone.png`, fullPage: true });
});
