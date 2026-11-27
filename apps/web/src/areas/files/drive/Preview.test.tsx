// A file open over the Drive: its content and history, older versions, a new version uploaded in parts,
// a document edited while someone else saved, the trash and the restore.
import { describe, expect, test } from "bun:test";
import { act, screen, waitFor, within } from "@testing-library/react";
import { newServer, renderApp } from "../../../../test/app.tsx";

const PATH = "/workspace/workspace_birchwood/files";
const dialog = (name: string) => screen.findByRole("dialog", { name });

describe("a file's preview", () => {
  test("shows the content, the version, who made it and the history; an older version opens by its number", async () => {
    const app = await renderApp({ path: `${PATH}?file=fil_plan`, signedInAs: "usr_ana" });
    const open = await dialog("Release plan");
    expect(within(open).getByText(/Ship the press calendar in March/)).toBeDefined();
    expect(within(open).getByTestId("files-version").textContent).toBe("Version 2 of 2");
    expect(within(open).getByRole("complementary", { name: "About this file" }).textContent).toContain(
      "Made byAna Beatriz Souza, 6 days ago",
    );
    const history = within(open).getByRole("list", { name: "History" });
    expect(
      within(history)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual([
      "Version 2Ana Beatriz Souza, 2 days agoMoved to March",
      "Version 1Ana Beatriz Souza, 6 days ago",
    ]);
    await app.user.click(within(history).getByRole("button", { name: /^Version 1/ }));
    await waitFor(() => expect(within(open).getByTestId("files-version").textContent).toBe("Version 1 of 2"));
    expect(app.address()).toBe(`${PATH}?file=fil_plan&v=1`);
    expect(within(open).queryByRole("button", { name: "Edit" })).toBeNull();
    await app.user.click(within(open).getByRole("button", { name: "Show the latest version" }));
    await waitFor(() => expect(within(open).getByTestId("files-version").textContent).toBe("Version 2 of 2"));
  });

  test("a new version of an uploaded file goes up in parts and becomes the one shown", async () => {
    const server = newServer();
    server.files.partSize = 4;
    const app = await renderApp({ path: `${PATH}?file=fil_notes`, signedInAs: "usr_ana", server });
    const open = await dialog("field-notes.txt");
    expect(within(open).getByText("Ink drying times by paper weight.")).toBeDefined();
    await app.user.upload(
      within(open).getByTestId("files-new-version"),
      new File([new Uint8Array(9)], "field-notes.txt", { type: "text/plain" }),
    );
    await waitFor(() => expect(within(open).getByTestId("files-version").textContent).toBe("Version 2 of 2"));
    expect(within(within(open).getByRole("list", { name: "History" })).getAllByRole("listitem")).toHaveLength(
      2,
    );
    expect(server.calls.filter((call) => call.method === "replaceFileUpload")).toHaveLength(3);
    const start = server.calls.find((call) => call.method === "createFileUpload");
    expect(start?.params).toMatchObject({ fileId: "fil_notes", parentVersion: 1 });
  });

  test("editing a document someone saved meanwhile: the text stays and can be saved over theirs or dropped", async () => {
    const server = newServer();
    const app = await renderApp({ path: `${PATH}?file=fil_plan`, signedInAs: "usr_ana", server });
    const open = await dialog("Release plan");
    await app.user.click(within(open).getByRole("button", { name: "Edit" }));
    const field = within(open).getByRole("textbox", { name: "Document text" });
    await app.user.clear(field);
    await app.user.type(field, "Mine");
    // Jonas saves version 3 while Ana edits.
    const plan = server.files.files.find((file) => file.id === "fil_plan");
    plan?.versions.push({
      version: 3,
      content: { kind: "document", markdown: "Theirs" },
      author: { type: "person", id: "usr_jonas" },
      createdAt: new Date().toISOString(),
      note: null,
    });
    await app.user.click(within(open).getByRole("button", { name: "Save" }));
    const warning = await within(open).findByRole("alert");
    expect(warning.textContent).toContain("saved version 3 while you were editing");
    expect((within(open).getByRole("textbox", { name: "Document text" }) as HTMLTextAreaElement).value).toBe(
      "Mine",
    );
    await app.user.click(within(open).getByRole("button", { name: "Save over version 3" }));
    await waitFor(() => expect(within(open).getByTestId("files-version").textContent).toBe("Version 4 of 4"));
    expect(within(open).getByText("Mine")).toBeDefined();
  });

  test("moving a file to the trash closes the preview, and its author restores it from there", async () => {
    const app = await renderApp({ path: `${PATH}?file=fil_plan`, signedInAs: "usr_ana" });
    const open = await dialog("Release plan");
    await app.user.click(within(open).getByRole("button", { name: "Move to trash" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(app.address()).toBe(PATH);
    await waitFor(() =>
      expect(within(screen.getByRole("list", { name: "Files" })).queryByText("Release plan")).toBeNull(),
    );
    await app.user.click(screen.getByRole("button", { name: "Trash" }));
    const trash = await screen.findByRole("list", { name: "Deleted files" });
    const row = within(trash).getByText("Release plan").closest("li");
    expect(row?.textContent).toContain("30 days left");
    await app.user.click(within(trash).getByRole("button", { name: "Restore Release plan" }));
    await waitFor(() => expect(within(trash).queryByText("Release plan")).toBeNull());
    await app.user.click(screen.getByRole("button", { name: "Back to files" }));
    expect(
      await within(await screen.findByRole("list", { name: "Files" })).findByText("Release plan"),
    ).toBeDefined();
  });

  test("a file deleted while it is open says it is no longer there", async () => {
    const app = await renderApp({ path: `${PATH}?file=fil_budget`, signedInAs: "usr_ana" });
    const open = await dialog("Budget");
    expect(within(open).getByRole("columnheader", { name: "Cost" })).toBeDefined();
    await waitFor(() => expect(app.server.openSockets().length).toBe(1));
    await act(async () => {
      const budget = app.server.files.files.find((file) => file.id === "fil_budget");
      if (budget) budget.deletedAt = new Date().toISOString();
      app.server.emit("workspace_birchwood", { type: "file.deleted", fileId: "fil_budget", channelId: null });
    });
    expect(await screen.findByText("This file was deleted or is no longer available to you.")).toBeDefined();
  });
});

describe("the trash", () => {
  test("days left before each file is gone, and who may restore it", async () => {
    await renderApp({ path: `${PATH}?trash=1`, signedInAs: "usr_iris" });
    await screen.findByRole("heading", { level: 1, name: "Trash" });
    const trash = await screen.findByRole("list", { name: "Deleted files" });
    const old = within(trash).getByText("Old flyer").closest("li");
    expect(old?.textContent).toContain("2 days left");
    expect(old?.textContent).toContain("Its author or an admin can restore it");
    const mine = within(trash).getByText("Draft poster").closest("li");
    expect(mine?.textContent).toContain("29 days left");
    expect(within(trash).getByRole("button", { name: "Restore Draft poster" })).toBeDefined();
  });

  test("an admin may restore anyone's file; an empty trash says what it is for", async () => {
    const server = newServer();
    const app = await renderApp({ path: `${PATH}?trash=1`, signedInAs: "usr_jonas", server });
    const trash = await screen.findByRole("list", { name: "Deleted files" });
    expect(within(trash).getAllByRole("button", { name: /^Restore / })).toHaveLength(2);
    app.unmount();
    for (const file of server.files.files) file.deletedAt = null;
    await renderApp({ path: `${PATH}?trash=1`, signedInAs: "usr_jonas", server });
    expect(await screen.findByText("The trash is empty")).toBeDefined();
  });
});
