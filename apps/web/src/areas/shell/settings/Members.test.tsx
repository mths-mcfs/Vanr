// Members and invitations. Ana owns Birchwood, Jonas is an admin there, Íris and Tomás are members.
import { describe, expect, test } from "bun:test";
import { act, screen, within } from "@testing-library/react";
import { chooseOption, newServer, renderApp } from "../../../../test/app.tsx";
import { parseEmails } from "./Members.tsx";

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
    expect(screen.queryByRole("form", { name: "Invite someone" }) === null).toBe(true);
    expect(screen.queryByRole("combobox") === null).toBe(true);
    expect(screen.queryByRole("button", { name: /^Remove/ }) === null).toBe(true);
    expect(screen.queryByText("Open invitations") === null).toBe(true);
  });

  test("an admin changes a member's role; owners and themselves stay as they are", async () => {
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas" });
    await screen.findByRole("list", { name: "Members" });
    expect(within(row("Ana Beatriz Souza") as HTMLElement).queryByRole("combobox")).toBeNull();
    expect(within(row("Jonas Lind") as HTMLElement).queryByRole("combobox")).toBeNull();
    const role = screen.getByRole("combobox", { name: "Change Tomás Eriksen's role" });
    expect(role.textContent).toBe("Member");
    await chooseOption(app, role, "Admin");
    expect(await screen.findByText("Tomás Eriksen is now Admin.")).toBeDefined();
    expect(roleOf(app.server, "usr_tomas")).toBe("admin");
    // An admin can't give the owner role.
    const iris = screen.getByRole("combobox", { name: "Change Íris Valença's role" });
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
    await chooseOption(
      app,
      await screen.findByRole("combobox", { name: "Change Jonas Lind's role" }),
      "Owner",
    );
    expect(await screen.findByText("Jonas Lind is now Owner.")).toBeDefined();
    expect(roleOf(app.server, "usr_jonas")).toBe("owner");
  });

  test("a refused role change says why and leaves the role as it was", async () => {
    const server = newServer();
    server.force("updateMember", { kind: "error", status: 403, code: "forbidden" });
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas", server });
    await chooseOption(
      app,
      await screen.findByRole("combobox", { name: "Change Íris Valença's role" }),
      "Admin",
    );
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
  test("an admin invites several addresses at once; each one counts once, and each says what happened", async () => {
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas" });
    const form = await screen.findByRole("form", { name: "Invite someone" });
    await app.user.type(
      within(form).getByLabelText("Emails"),
      "pia@birchwood.example, IRIS@birchwood.example;pia@birchwood.example  not-an-address",
    );
    await chooseOption(app, within(form).getByRole("combobox", { name: "Role" }), "Admin");
    await app.user.click(within(form).getByRole("button", { name: "Send 3 invitations" }));
    const results = await screen.findByRole("list", { name: "Invitations" });
    expect(
      within(results)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual([
      expect.stringMatching(/^pia@birchwood\.example: invitation sent ?https:\/\/vanr\.test\/invite\/inv_/),
      "iris@birchwood.example: already a member",
      "not-an-address: not an email address",
    ]);
    expect(screen.getByText("1 invitation sent")).toBeDefined();
    const bulk = app.server.calls.filter((call) => call.method === "createInvitationBulk");
    expect(bulk).toHaveLength(1);
    expect(bulk[0]?.params.emails).toEqual([
      "pia@birchwood.example",
      "iris@birchwood.example",
      "not-an-address",
    ]);
    const pending = await screen.findByRole("list", { name: "Open invitations" });
    const invited = within(pending)
      .getAllByRole("listitem")
      .find((item) => item.textContent?.includes("pia@birchwood.example"));
    expect(invited?.textContent).toContain("Admin");
    expect((within(form).getByLabelText("Emails") as HTMLInputElement).value).toBe("");
  });

  test("addresses typed while a round is sending stay for the next one", async () => {
    const server = newServer();
    const held = server.hold("createInvitationBulk");
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas", server });
    const field = await screen.findByLabelText("Emails");
    await app.user.type(field, "pia@birchwood.example");
    await app.user.click(screen.getByRole("button", { name: "Send invitation" }));
    await app.user.type(field, " rui@birchwood.example");
    held.release();
    await screen.findByRole("list", { name: "Invitations" });
    expect((field as HTMLInputElement).value).toBe("pia@birchwood.example rui@birchwood.example");
  });

  test("more than 100 addresses are refused before anything is sent", async () => {
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas" });
    const field = await screen.findByLabelText("Emails");
    const many = Array.from({ length: 101 }, (_, n) => `p${n}@x.example`).join(" ");
    await app.user.click(field);
    await app.user.paste(many);
    expect(screen.getByText("That is more than 100 addresses. Send them in smaller groups.")).toBeDefined();
    expect(screen.getByRole("button", { name: "Send 101 invitations" }).hasAttribute("disabled")).toBe(true);
    expect(app.server.calls.some((call) => call.method === "createInvitationBulk")).toBe(false);
  });

  test("addresses split on spaces, commas and semicolons, each once and lowercased", () => {
    expect(parseEmails(" A@x.example,b@x.example;; a@X.example\n c@x.example ")).toEqual([
      "a@x.example",
      "b@x.example",
      "c@x.example",
    ]);
    expect(parseEmails(" , ; ")).toEqual([]);
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

  test("an admin sees no way to withdraw an invitation to be an owner; an owner does", async () => {
    const owners = newServer();
    const sample = owners.invitations.find((invitation) => invitation.token === "inv-mel-pending");
    if (sample === undefined) throw new Error("no sample");
    owners.invitations.push({
      ...sample,
      token: "inv-owner",
      email: "boss@birchwood.example",
      role: "owner",
    });
    await renderApp({ path: PATH, signedInAs: "usr_jonas", server: owners });
    await screen.findByRole("list", { name: "Open invitations" });
    expect(screen.getByText("boss@birchwood.example")).toBeDefined();
    expect(
      screen.queryByRole("button", { name: "Withdraw the invitation for boss@birchwood.example" }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "Withdraw the invitation for mel@birchwood.example" }),
    ).toBeDefined();
  });

  test("loading: the open invitations say they are on their way", async () => {
    const server = newServer();
    const held = server.hold("listInvitations");
    await renderApp({ path: PATH, signedInAs: "usr_jonas", server });
    await screen.findByRole("list", { name: "Members" });
    expect(within(screen.getByRole("region", { name: "Members" })).getAllByText("Loading").length).toBe(1);
    held.release();
    await screen.findByRole("list", { name: "Open invitations" });
  });

  test("the open invitations failing to load does not hide the members", async () => {
    const server = newServer();
    server.force("listInvitations", { kind: "error", status: 403, code: "forbidden" });
    await renderApp({ path: PATH, signedInAs: "usr_jonas", server });
    expect(await screen.findByText("The open invitations could not be loaded")).toBeDefined();
    expect(screen.getByRole("list", { name: "Members" })).toBeDefined();
  });
});
