// The settings frame and the shell's General, Profile and Storage sections, against the fake server.
// Ana owns Birchwood, Jonas is an admin there and Íris a member.
import { describe, expect, test } from "bun:test";
import { act, screen, waitFor, within } from "@testing-library/react";
import { QUERY_RETRIES } from "@vanr/client/react";
import { FAKE_BUCKET_HOST } from "../../../dev/fake-server.ts";
import { newServer, renderApp } from "../../../test/app.tsx";

const at = (section: string) => `/workspace/workspace_birchwood/settings/${section}`;
const sections = () =>
  within(screen.getByRole("navigation", { name: "Sections" }))
    .getAllByRole("link")
    .map((link) => link.textContent);
const section = () => screen.getByRole("region", { name: "General" });

describe("the settings frame", () => {
  test("an admin sees every section, a member only the ones they may open", async () => {
    await renderApp({ path: at("general"), signedInAs: "usr_jonas" });
    await screen.findByRole("heading", { level: 2, name: "General" });
    expect(sections()).toContain("Storage");
  });

  test("a member does not get Storage in the list, and its address says why", async () => {
    await renderApp({ path: at("general"), signedInAs: "usr_iris" });
    await screen.findByRole("heading", { level: 2, name: "General" });
    expect(sections()).toEqual(["General", "Profile", "Members", "Runners"]);
  });

  test("a member who opens Storage by its address sees it is for admins, and no form", async () => {
    const app = await renderApp({ path: at("storage"), signedInAs: "usr_iris" });
    expect(await screen.findByText("This section is for admins")).toBeDefined();
    expect(screen.queryByRole("radiogroup") === null).toBe(true);
    expect(app.server.calls.some((call) => call.method === "getStorage")).toBe(false);
  });
});

describe("general settings", () => {
  test("a member reads them but cannot change them", async () => {
    await renderApp({ path: at("general"), signedInAs: "usr_iris" });
    const name = await screen.findByLabelText("Name");
    expect((name as HTMLInputElement).value).toBe("Birchwood Labs");
    expect((name as HTMLInputElement).readOnly).toBe(true);
    expect(screen.getByText("Only admins can change these settings.")).toBeDefined();
    expect(screen.getByRole("switch", { name: /Approval reviewer/ }).hasAttribute("disabled")).toBe(true);
    expect(screen.queryByRole("button", { name: "Save" }) === null).toBe(true);
  });

  test("an admin renames the workspace; the frame follows", async () => {
    const app = await renderApp({ path: at("general"), signedInAs: "usr_jonas" });
    const name = await screen.findByLabelText("Name");
    await app.user.clear(name);
    await app.user.type(name, "Birchwood Press");
    await app.user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Workspace settings saved.")).toBeDefined();
    expect(app.server.settings.get("workspace_birchwood")?.name).toBe("Birchwood Press");
    expect(await screen.findByRole("button", { name: "Birchwood Press, workspace menu" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Save" }) === null).toBe(true);
  });

  test("an empty name or an unknown time zone is caught before saving", async () => {
    const app = await renderApp({ path: at("general"), signedInAs: "usr_jonas" });
    await app.user.clear(await screen.findByLabelText("Name"));
    expect(screen.getByText("The workspace needs a name.")).toBeDefined();
    await app.user.type(screen.getByLabelText("Name"), "Birchwood");
    const zone = screen.getByLabelText("Time zone");
    await app.user.clear(zone);
    await app.user.type(zone, "Mars/Olympus");
    expect(screen.getByText(/not a time zone this browser knows/)).toBeDefined();
    expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true);
    await app.user.click(screen.getByRole("button", { name: "Discard changes" }));
    expect((screen.getByLabelText("Time zone") as HTMLInputElement).value).toBe("Europe/Lisbon");
  });

  test("an edit made while Save is on its way stays a draft", async () => {
    const server = newServer();
    const held = server.hold("updateSettings");
    const app = await renderApp({ path: at("general"), signedInAs: "usr_jonas", server });
    const name = await screen.findByLabelText("Name");
    await app.user.type(name, " Press");
    await app.user.click(screen.getByRole("button", { name: "Save" }));
    await app.user.type(screen.getByLabelText("Time zone"), "x");
    held.release();
    await screen.findByText("Workspace settings saved.");
    expect((screen.getByLabelText("Time zone") as HTMLInputElement).value).toBe("Europe/Lisbonx");
  });

  test("a draft never follows the person to another workspace", async () => {
    const app = await renderApp({ path: at("general"), signedInAs: "usr_jonas" });
    await app.user.type(await screen.findByLabelText("Name"), " Draft");
    await act(() => app.runtime.router.navigate({ to: "/workspace/workspace_nightshift/settings/general" }));
    await waitFor(() =>
      expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Night Shift"),
    );
    expect(screen.queryByRole("button", { name: "Save" }) === null).toBe(true);
  });

  test("the approval reviewer is turned on at once", async () => {
    const app = await renderApp({ path: at("general"), signedInAs: "usr_jonas" });
    await app.user.click(await screen.findByRole("switch", { name: /Approval reviewer/ }));
    expect(await screen.findByText("The approval reviewer is on.")).toBeDefined();
    expect(app.server.settings.get("workspace_birchwood")?.approvalReviewer).toBe(true);
  });

  test("failed: what could not be loaded and a retry that works", async () => {
    const server = newServer();
    server.force("getSettings", { kind: "error", status: 500, code: "internal" }, 1 + QUERY_RETRIES);
    const app = await renderApp({ path: at("general"), signedInAs: "usr_jonas", server });
    const alert = await within(section()).findByRole("alert");
    expect(alert.textContent).toContain("The workspace settings could not be loaded");
    await app.user.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(await screen.findByLabelText("Name")).toBeDefined();
  });

  test("loading: the section says it is busy", async () => {
    const server = newServer();
    const held = server.hold("getSettings");
    await renderApp({ path: at("general"), signedInAs: "usr_jonas", server });
    expect(await within(section()).findByText("Loading")).toBeDefined();
    held.release();
    await screen.findByLabelText("Name");
  });
});

describe("the profile", () => {
  test("changes the name and the handle; a taken handle is refused", async () => {
    const app = await renderApp({ path: at("profile"), signedInAs: "usr_iris" });
    const handle = await screen.findByLabelText("Handle");
    await app.user.clear(handle);
    await app.user.type(handle, "jonas");
    await app.user.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toContain("@jonas is already taken here.");
    await app.user.clear(handle);
    await app.user.type(handle, "iris-v");
    await app.user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Profile saved.")).toBeDefined();
    expect(
      app.server.state.members.find((m) => m.userId === "usr_iris" && m.workspaceId === "workspace_birchwood")
        ?.handle,
    ).toBe("iris-v");
  });

  test("a handle out of the rules is caught before saving", async () => {
    const app = await renderApp({ path: at("profile"), signedInAs: "usr_iris" });
    const handle = await screen.findByLabelText("Handle");
    await app.user.clear(handle);
    await app.user.type(handle, "-x");
    expect(screen.getByText(/Use 2 to 32 lowercase letters/)).toBeDefined();
    expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true);
  });
});

describe("storage", () => {
  const fill = async (app: Awaited<ReturnType<typeof renderApp>>, endpoint: string) => {
    await app.user.click(await screen.findByRole("radio", { name: /In an S3-compatible bucket/ }));
    await app.user.type(screen.getByLabelText(/Endpoint/), endpoint);
    await app.user.type(screen.getByLabelText("Region"), "auto");
    await app.user.type(screen.getByLabelText(/Bucket/), "birchwood-files");
    await app.user.type(screen.getByLabelText("Access key ID"), "AKIAEXAMPLE1234");
    await app.user.type(screen.getByLabelText("Secret access key"), "secret-example-5678");
  };

  test("an admin tests a bucket, saves it, and starts copying the files already here", async () => {
    const app = await renderApp({ path: at("storage"), signedInAs: "usr_jonas" });
    expect((await screen.findByRole("radio", { name: /On this server/ })).getAttribute("aria-checked")).toBe(
      "true",
    );
    await fill(app, `https://${FAKE_BUCKET_HOST}`);
    await app.user.click(screen.getByRole("button", { name: "Test the bucket" }));
    expect(await screen.findByText("The bucket passed the test")).toBeDefined();
    expect(within(screen.getByRole("list", { name: "Test steps" })).getAllByRole("listitem")).toHaveLength(4);
    await app.user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("New files now go to the bucket.")).toBeDefined();
    expect(app.server.storage.get("workspace_birchwood")?.config.kind).toBe("s3");
    expect(await screen.findByText(/Saved keys: …1234 and …5678/)).toBeDefined();
    await app.user.click(screen.getByRole("button", { name: "Copy files to the bucket" }));
    expect(await screen.findByText("Copying: 0 of 12 files.")).toBeDefined();
  });

  test("a bucket that fails the test shows the step and the provider's words, and is not saved", async () => {
    const app = await renderApp({ path: at("storage"), signedInAs: "usr_jonas" });
    await fill(app, "https://elsewhere.example");
    await app.user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("The bucket did not pass the test")).toBeDefined();
    expect(screen.getByText("Write: failed")).toBeDefined();
    expect(screen.getByText(/AccessDenied/)).toBeDefined();
    expect(app.server.storage.get("workspace_birchwood")?.config.kind).toBe("builtin");
  });

  test("a save the bucket refuses speaks over an earlier test that passed", async () => {
    const app = await renderApp({ path: at("storage"), signedInAs: "usr_jonas" });
    await fill(app, `https://${FAKE_BUCKET_HOST}`);
    await app.user.click(screen.getByRole("button", { name: "Test the bucket" }));
    await screen.findByText("The bucket passed the test");
    app.server.force("setStorage", {
      kind: "error",
      status: 400,
      code: "storage.bucket_check_failed",
      message: "The bucket did not pass the test",
    });
    await app.user.click(screen.getByRole("button", { name: "Save" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("The storage was not saved");
    expect(alert.textContent).toContain("The bucket did not pass the test.");
    expect(screen.queryByText("The bucket passed the test") === null).toBe(true);
  });

  test("changing the form drops the last test, and one key alone is not enough", async () => {
    const app = await renderApp({ path: at("storage"), signedInAs: "usr_jonas" });
    await fill(app, `https://${FAKE_BUCKET_HOST}`);
    await app.user.click(screen.getByRole("button", { name: "Test the bucket" }));
    await screen.findByText("The bucket passed the test");
    await app.user.clear(screen.getByLabelText("Secret access key"));
    expect(screen.queryByText("The bucket passed the test") === null).toBe(true);
    expect(screen.getByRole("button", { name: "Test the bucket" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true);
  });

  test("failed to load: a retry that works", async () => {
    const server = newServer();
    server.force("getStorage", { kind: "error", status: 500, code: "internal" }, 1 + QUERY_RETRIES);
    const app = await renderApp({ path: at("storage"), signedInAs: "usr_jonas", server });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("The storage settings could not be loaded");
    await app.user.click(within(alert).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByRole("radiogroup")).toBeDefined());
  });
});
