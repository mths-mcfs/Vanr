// The files journeys: a person uploads a file and then a new version of it, and finds a document by a
// word inside it through the search. Each one checks what the person sees, in the project's language.
import { expect, test } from "./fixtures.ts";

const text = (name: string, body: string) => ({ name, mimeType: "text/plain", buffer: Buffer.from(body) });

test("upload a file, then a new version of it", async ({ page, t, seedUser, signIn }) => {
  const user = await seedUser({ workspace: "Press Room" });
  await signIn(user);
  await page.goto(`/workspace/${user.workspace.id}/files`);
  await expect(page.getByRole("heading", { level: 1, name: t("files", "drive.title") })).toBeVisible();
  await expect(page.getByText(t("files", "drive.empty.title"))).toBeVisible();

  await page
    .getByTestId("files-upload")
    .setInputFiles(text("press-notes.txt", "Ink dries slower on coated paper."));
  const uploads = page.getByRole("list", { name: t("files", "upload.title") });
  await expect(uploads.getByText(t("files", "upload.state.done"))).toBeVisible();
  const files = page.getByRole("list", { name: t("files", "drive.list") });
  await expect(
    files.getByText(t("files", "drive.kindVersion", { kind: t("files", "kind.file"), version: 1 })),
  ).toBeVisible();

  await files.getByRole("button", { name: "press-notes.txt" }).click();
  const preview = page.getByRole("dialog", { name: "press-notes.txt" });
  await expect(preview.getByTestId("files-version")).toHaveText(
    t("files", "preview.versionOf", { shown: 1, latest: 1 }),
  );

  await preview
    .getByTestId("files-new-version")
    .setInputFiles(
      text("press-notes.txt", "Ink dries slower on coated paper. Uncoated stock dries in an hour."),
    );
  await expect(preview.getByTestId("files-version")).toHaveText(
    t("files", "preview.versionOf", { shown: 2, latest: 2 }),
  );
  const history = preview.getByRole("list", { name: t("files", "preview.history") });
  await expect(history.getByRole("listitem")).toHaveCount(2);
  await expect(
    history.getByRole("button", { name: new RegExp(t("files", "preview.versionShort", { version: 1 })) }),
  ).toBeVisible();

  // The older version is still there to read.
  await history
    .getByRole("button", { name: new RegExp(t("files", "preview.versionShort", { version: 1 })) })
    .click();
  await expect(preview.getByTestId("files-version")).toHaveText(
    t("files", "preview.versionOf", { shown: 1, latest: 2 }),
  );

  await page.keyboard.press("Escape");
  await expect(
    files.getByText(t("files", "drive.kindVersion", { kind: t("files", "kind.file"), version: 2 })),
  ).toBeVisible();
});

test("search: find a document by a word inside it and open it", async ({
  page,
  server,
  t,
  seedUser,
  signIn,
}) => {
  const user = await seedUser({ workspace: "Paper Mill" });
  await signIn(user);
  const created = await page.request.post(`/api/v1/workspaces/${user.workspace.id}/files`, {
    headers: { origin: server.url },
    data: {
      title: "Paper suppliers",
      content: { kind: "document", markdown: "We buy quillwort paper from two mills in the north." },
    },
  });
  expect(created.ok()).toBe(true);

  await page.goto(`/workspace/${user.workspace.id}`);
  await expect(page.getByRole("heading", { level: 1, name: user.workspace.name })).toBeVisible();
  // The frame's shortcut opens the search.
  await page.keyboard.press("Control+k");
  await expect(page.getByRole("heading", { level: 1, name: t("files", "search.title") })).toBeVisible();
  const field = page.getByRole("searchbox", { name: t("files", "search.field") });
  await expect(page.getByText(t("files", "search.typeMore"))).toBeVisible();

  await field.fill("quillwort");
  const results = page.getByRole("list", { name: t("files", "search.results") });
  const hit = results.getByRole("listitem").filter({ hasText: "Paper suppliers" });
  await expect(hit).toBeVisible();
  await expect(hit.getByText(t("files", "search.kind.file"), { exact: true })).toBeVisible();
  await expect(hit.locator("mark").first()).toHaveText(/quillwort/i);
  await expect(page).toHaveURL(/\/search\?q=quillwort$/);

  await field.fill("quillwort zebra");
  await expect(page.getByText(t("files", "search.none", { q: "quillwort zebra" }))).toBeVisible();
  await field.fill("quillwort");

  await hit.getByRole("link", { name: "Paper suppliers" }).click();
  const preview = page.getByRole("dialog", { name: "Paper suppliers" });
  await expect(preview.getByText(/quillwort paper from two mills/)).toBeVisible();
  await expect(page).toHaveURL(/\/files\?file=/);
});
