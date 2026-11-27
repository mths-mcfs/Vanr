// The Drive as a person uses it: the list and its filters, uploads in parts, the preview with its
// history and versions, the trash, and changes made elsewhere showing up without a reload.
import { describe, expect, test } from "bun:test";
import { act, screen, waitFor, within } from "@testing-library/react";
import { QUERY_RETRIES } from "@vanr/client/react";
import { newServer, renderApp } from "../../../../test/app.tsx";

const PATH = "/workspace/workspace_birchwood/files";
const list = () => screen.findByRole("list", { name: "Files" });
const names = async () =>
  within(await list())
    .getAllByRole("listitem")
    .map((item) => within(item).getAllByRole("button")[0]?.textContent);
const card = async (name: string) => {
  const items = within(await list()).getAllByRole("listitem");
  const found = items.find((item) => within(item).queryByRole("button", { name }) !== null);
  if (found === undefined) throw new Error(`no file named ${name}`);
  return found;
};
const picked = (name: string, size: number, type = "text/plain") =>
  new File([new Uint8Array(size)], name, { type, lastModified: 1 });

describe("the Drive", () => {
  test("lists every file with its kind, version, maker, origin and last change", async () => {
    await renderApp({ path: PATH, signedInAs: "usr_ana" });
    await screen.findByRole("heading", { level: 1, name: "Files" });
    expect(await names()).toEqual(["field-notes.txt", "Release plan", "Budget"]);
    const notes = await card("field-notes.txt");
    expect(notes.textContent).toContain("File, version 1");
    expect(notes.textContent).toContain("Scout");
    expect(notes.textContent).toContain("#design");
    expect(notes.textContent).toContain("yesterday");
    expect((await card("Release plan")).textContent).toContain("Only in Files");
    expect(document.title).toBe("Files | Birchwood Labs | Vanr");
  });

  test("filters by who made a file and by kind, and says when nothing is left", async () => {
    const app = await renderApp({ path: PATH, signedInAs: "usr_ana" });
    await list();
    await app.user.click(screen.getByRole("button", { name: "Agents" }));
    expect(await names()).toEqual(["field-notes.txt"]);
    await app.user.click(screen.getByRole("button", { name: "Table" }));
    expect(await screen.findByText("No file matches these filters")).toBeDefined();
    await app.user.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(await names()).toEqual(["field-notes.txt", "Release plan", "Budget"]);
  });

  test("searches by name and shows the files whose text has the words", async () => {
    const app = await renderApp({ path: PATH, signedInAs: "usr_ana" });
    await list();
    await app.user.type(screen.getByRole("searchbox", { name: "Search files by name" }), "ink");
    expect(await screen.findByText("No file matches these filters")).toBeDefined();
    const inside = await screen.findByRole("region", { name: "Found inside files" });
    await app.user.click(within(inside).getByRole("button", { name: "field-notes.txt" }));
    await screen.findByRole("dialog", { name: "field-notes.txt" });
    expect(app.address()).toBe(`${PATH}?file=fil_notes`);
  });

  test("the list or the grid: the choice is kept for the next visit", async () => {
    const app = await renderApp({ path: PATH, signedInAs: "usr_ana" });
    await list();
    await app.user.click(screen.getByRole("button", { name: "List" }));
    expect(screen.getByRole("button", { name: "List" }).getAttribute("aria-pressed")).toBe("true");
    app.unmount();
    await renderApp({ path: PATH, signedInAs: "usr_ana", store: app.runtime.store });
    await list();
    expect(screen.getByRole("button", { name: "List" }).getAttribute("aria-pressed")).toBe("true");
  });

  test("loading, failed with a retry that works, and empty", async () => {
    const server = newServer();
    const held = server.hold("listFiles");
    const app = await renderApp({ path: PATH, signedInAs: "usr_ana", server });
    expect(await within(screen.getByRole("main")).findByText("Loading")).toBeDefined();
    held.release();
    await list();
    app.unmount();

    server.force("listFiles", { kind: "error", status: 500, code: "internal" }, 1 + QUERY_RETRIES);
    const again = await renderApp({ path: PATH, signedInAs: "usr_ana", server });
    const alert = await within(screen.getByRole("main")).findByRole("alert");
    expect(alert.textContent).toContain("The files could not be loaded");
    await again.user.click(within(alert).getByRole("button", { name: "Retry" }));
    await list();
    again.unmount();

    server.files.files = [];
    await renderApp({ path: PATH, signedInAs: "usr_ana", server });
    expect(await screen.findByText("No files yet")).toBeDefined();
  });

  test("uploads several files one at a time, in parts, and lists them when done", async () => {
    const server = newServer();
    server.files.partSize = 4;
    const app = await renderApp({ path: PATH, signedInAs: "usr_ana", server });
    await list();
    await app.user.upload(screen.getByTestId("files-upload"), [
      picked("press.txt", 10),
      picked("ink.txt", 3),
    ]);
    const tray = await screen.findByRole("list", { name: "Uploads" });
    await waitFor(() => expect(within(tray).getAllByText("Uploaded")).toHaveLength(2));
    expect(server.calls.filter((call) => call.method === "replaceFileUpload")).toHaveLength(4);
    await waitFor(async () => expect(await names()).toContain("press.txt"));
    expect(await names()).toContain("ink.txt");
    await app.user.click(screen.getByRole("button", { name: "Clear finished" }));
    expect(screen.queryByRole("list", { name: "Uploads" })).toBeNull();
  });

  test("a file over 1 GB is refused before anything is sent", async () => {
    const app = await renderApp({ path: PATH, signedInAs: "usr_ana" });
    await list();
    const huge = picked("huge.bin", 1);
    Object.defineProperty(huge, "size", { value: 1024 * 1024 * 1024 + 1 });
    await app.user.upload(screen.getByTestId("files-upload"), huge);
    const tray = await screen.findByRole("list", { name: "Uploads" });
    expect(within(tray).getByText("Too big")).toBeDefined();
    expect(within(tray).getByText("Files are limited to 1 GB.")).toBeDefined();
    expect(app.server.calls.some((call) => call.method === "createFileUpload")).toBe(false);
  });

  test("an upload can be paused and goes on from where it stopped", async () => {
    const server = newServer();
    server.files.partSize = 4;
    const app = await renderApp({ path: PATH, signedInAs: "usr_ana", server });
    await list();
    const held = server.hold("replaceFileUpload");
    await app.user.upload(screen.getByTestId("files-upload"), picked("long.txt", 8));
    const tray = await screen.findByRole("list", { name: "Uploads" });
    await within(tray).findByText("Uploading");
    await app.user.click(within(tray).getByRole("button", { name: "Pause long.txt" }));
    expect(within(tray).getByText("Paused")).toBeDefined();
    held.release();
    await app.user.click(within(tray).getByRole("button", { name: "Resume long.txt" }));
    await within(tray).findByText("Uploaded");
    // One session for the whole file: resuming did not start over.
    expect(server.calls.filter((call) => call.method === "createFileUpload")).toHaveLength(1);
  });

  test("a failed upload says why and can be tried again", async () => {
    const server = newServer();
    server.force("createFileUpload", { kind: "error", status: 429, code: "upload.too_many" });
    const app = await renderApp({ path: PATH, signedInAs: "usr_ana", server });
    await list();
    await app.user.upload(screen.getByTestId("files-upload"), picked("late.txt", 2));
    const tray = await screen.findByRole("list", { name: "Uploads" });
    expect(await within(tray).findByText("Finish or cancel other uploads first.")).toBeDefined();
    await app.user.click(within(tray).getByRole("button", { name: "Try late.txt again" }));
    await within(tray).findByText("Uploaded");
  });

  test("a file someone else adds shows up without a reload", async () => {
    const app = await renderApp({ path: PATH, signedInAs: "usr_ana" });
    await list();
    await waitFor(() => expect(app.server.openSockets().length).toBe(1));
    await act(async () => {
      app.server.files.files.push({
        ...structuredClone(app.server.files.files[2]),
        id: "fil_new",
        title: "Paper stock",
      } as never);
      app.server.emit("workspace_birchwood", { type: "file.created", fileId: "fil_new", channelId: null });
    });
    await waitFor(async () => expect(await names()).toContain("Paper stock"));
  });
});

describe("the Drive's uploads, past the happy path", () => {
  test("a file picked again after a reload goes on with its session, and a finished one is not made twice", async () => {
    const server = newServer();
    server.files.partSize = 4;
    const first = await renderApp({ path: PATH, signedInAs: "usr_ana", server });
    await list();
    const held = server.hold("completeFileUpload");
    const file = picked("again.txt", 8);
    await first.user.upload(screen.getByTestId("files-upload"), file);
    await waitFor(() =>
      expect(server.calls.filter((call) => call.method === "replaceFileUpload")).toHaveLength(2),
    );
    // The completion reaches the server, but the page goes away before its answer.
    first.unmount();
    held.release();
    await waitFor(() => expect(server.files.uploads[0]?.status).toBe("done"));
    const count = server.files.files.length;
    const again = await renderApp({ path: PATH, signedInAs: "usr_ana", server, store: first.runtime.store });
    await list();
    await again.user.upload(screen.getByTestId("files-upload"), file);
    await within(await screen.findByRole("list", { name: "Uploads" })).findByText("Uploaded");
    expect(server.calls.filter((call) => call.method === "createFileUpload")).toHaveLength(1);
    expect(server.files.files).toHaveLength(count);
  });

  test("clearing a failed upload also closes its session on the server", async () => {
    const server = newServer();
    server.files.partSize = 4;
    server.force("replaceFileUpload", { kind: "error", status: 400, code: "upload.empty_part" });
    const app = await renderApp({ path: PATH, signedInAs: "usr_ana", server });
    await list();
    await app.user.upload(screen.getByTestId("files-upload"), picked("broken.txt", 8));
    const tray = await screen.findByRole("list", { name: "Uploads" });
    await within(tray).findByText("Failed");
    expect(server.files.uploads).toHaveLength(1);
    await app.user.click(screen.getByRole("button", { name: "Clear finished" }));
    await waitFor(() => expect(server.files.uploads).toHaveLength(0));
  });
});
