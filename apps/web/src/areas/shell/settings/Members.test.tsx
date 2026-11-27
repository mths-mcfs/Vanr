// Members and invitations. Ana owns Birchwood, Jonas is an admin there, Íris and Tomás are members.
import { describe, expect, test } from "bun:test";
import { act, screen, within } from "@testing-library/react";
import { chooseOption, newServer, renderApp } from "../../../../test/app.tsx";

const PATH = "/workspace/workspace_birchwood/settings/members";
const people = () => screen.getByRole("list", { name: "Members" });
const row = (name: string) =>
  within(people())
    .getAllByRole("listitem")
    .find((item) => item.textContent?.includes(name)) ?? null;
const roleOf = (server: ReturnType<typeof newServer>, userId: string) =>
  server.state.members.find((m) => m.workspaceId === "workspace_birchwood" && m.userId === userId)?.role;

describe("members", () => {
  test("a member sees who is here and their roles, and nothing to change", async () => {
    await renderApp({ path: PATH, signedInAs: "usr_iris" });
    expect(await screen.findByRole("heading", { level: 3, name: "4 members" })).toBeDefined();
    expect(row("Jonas Lind")?.textContent).toContain("@jonas · jonas@birchwood.example");
    expect(row("Jonas Lind")?.textContent).toContain("Admin");
    expect(screen.queryByRole("form", { name: "Invite someone" })).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Remove/ })).toBeNull();
    expect(screen.queryByText("Open invitations")).toBeNull();
  });

  test("an admin changes a member's role; owners and themselves stay as they are", async () => {
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas" });
    await screen.findByRole("list", { name: "Members" });
    expect(within(row("Ana Beatriz Souza") as HTMLElement).queryByRole("combobox")).toBeNull();
    expect(within(row("Jonas Lind") as HTMLElement).queryByRole("combobox")).toBeNull();
    const role = screen.getByRole("combobox", { name: "Role of Tomás Eriksen" });
    expect(role.textContent).toBe("Member");
    await chooseOption(app, role, "Admin");
    expect(await screen.findByText("Tomás Eriksen is now Admin.")).toBeDefined();
    expect(roleOf(app.server, "usr_tomas")).toBe("admin");
    // An admin can't give the owner role.
    const iris = screen.getByRole("combobox", { name: "Role of Íris Valença" });
    await act(async () => {
      iris.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    expect((await screen.findAllByRole("option")).map((option) => option.textContent)).toEqual([
      "Member",
      "Admin",
    ]);
  });

  test("an owner may make someone an owner", async () => {
    const app = await renderApp({ path: PATH, signedInAs: "usr_ana" });
    await chooseOption(app, await screen.findByRole("combobox", { name: "Role of Jonas Lind" }), "Owner");
    expect(await screen.findByText("Jonas Lind is now Owner.")).toBeDefined();
    expect(roleOf(app.server, "usr_jonas")).toBe("owner");
  });

  test("a refused role change says why and leaves the role as it was", async () => {
    const server = newServer();
    server.force("updateMember", { kind: "error", status: 403, code: "forbidden" });
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas", server });
    await chooseOption(app, await screen.findByRole("combobox", { name: "Role of Íris Valença" }), "Admin");
    expect(await screen.findByText("You don't have permission to do that.")).toBeDefined();
    expect(roleOf(server, "usr_iris")).toBe("member");
  });

  test("removing someone asks first", async () => {
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas" });
    await app.user.click(await screen.findByRole("button", { name: "Remove Tomás Eriksen" }));
    const dialog = await screen.findByRole("alertdialog", {
      name: "Remove Tomás Eriksen from the workspace?",
    });
    await app.user.click(within(dialog).getByRole("button", { name: "Keep them" }));
    expect(roleOf(app.server, "usr_tomas")).toBe("member");
    await app.user.click(screen.getByRole("button", { name: "Remove Tomás Eriksen" }));
    await app.user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Remove" }),
    );
    expect(await screen.findByText("Tomás Eriksen was removed.")).toBeDefined();
    expect(roleOf(app.server, "usr_tomas")).toBeUndefined();
    expect(await screen.findByRole("heading", { level: 3, name: "3 members" })).toBeDefined();
  });
});

describe("invitations", () => {
  test("an admin invites by email, gets the link and sees the invitation open", async () => {
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas" });
    const form = await screen.findByRole("form", { name: "Invite someone" });
    await app.user.type(within(form).getByLabelText("Email"), "pia@birchwood.example");
    await chooseOption(app, within(form).getByRole("combobox", { name: "Role" }), "Admin");
    await app.user.click(within(form).getByRole("button", { name: "Send invitation" }));
    expect(await screen.findByText("Invitation link for pia@birchwood.example")).toBeDefined();
    expect(screen.getByText(/^https:\/\/vanr\.test\/invite\/inv_/)).toBeDefined();
    const pending = await screen.findByRole("list", { name: "Open invitations" });
    const invited = within(pending)
      .getAllByRole("listitem")
      .find((item) => item.textContent?.includes("pia@birchwood.example"));
    expect(invited?.textContent).toContain("Admin");
    expect((within(form).getByLabelText("Email") as HTMLInputElement).value).toBe("");
  });

  test("inviting someone already here is refused with the reason", async () => {
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas" });
    const form = await screen.findByRole("form", { name: "Invite someone" });
    await app.user.type(within(form).getByLabelText("Email"), "iris@birchwood.example");
    await app.user.click(within(form).getByRole("button", { name: "Send invitation" }));
    expect((await screen.findByRole("alert")).textContent).toContain("This person is already a member.");
  });

  test("an open invitation can be withdrawn", async () => {
    const app = await renderApp({ path: PATH, signedInAs: "usr_ana" });
    const pending = await screen.findByRole("list", { name: "Open invitations" });
    expect(
      within(pending)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual([
      expect.stringContaining("mel@birchwood.example"),
      expect.stringContaining("Anyone with the link"),
    ]);
    await app.user.click(
      screen.getByRole("button", { name: "Withdraw the invitation for mel@birchwood.example" }),
    );
    expect(await screen.findByText("The invitation for mel@birchwood.example was withdrawn.")).toBeDefined();
    expect(app.server.invitations.find((i) => i.token === "inv-mel-pending")?.status).toBe("revoked");
  });

  test("the open invitations failing to load does not hide the members", async () => {
    const server = newServer();
    server.force("listInvitations", { kind: "error", status: 403, code: "forbidden" });
    await renderApp({ path: PATH, signedInAs: "usr_jonas", server });
    expect(await screen.findByText("The open invitations could not be loaded")).toBeDefined();
    expect(screen.getByRole("list", { name: "Members" })).toBeDefined();
  });
});
