import { describe, expect, test } from "bun:test";
import { screen } from "@testing-library/react";
import { EXAMPLE_PASSWORD } from "../../../dev/fake-server.ts";
import { newServer, renderApp, WIRES } from "../../../test/app.tsx";

const facts = () => {
  const list = screen.getByRole("heading", { level: 1 }).closest("main")?.querySelector("dl");
  if (!list) throw new Error("no invitation facts on screen");
  return [...list.querySelectorAll("div")].map((row) => [
    row.querySelector("dt")?.textContent,
    row.querySelector("dd")?.textContent,
  ]);
};

for (const wire of WIRES) {
  describe(`invitation (${wire} wire)`, () => {
    test("loading, then what the invitation is", async () => {
      const server = newServer();
      const held = server.hold("getInvitation");
      await renderApp({ path: "/invite/inv-mel-pending", server, wire });
      await screen.findByRole("heading", { level: 1, name: "Loading the invitation" });
      held.release();
      await screen.findByRole("heading", { level: 1, name: "You are invited to Birchwood Labs" });
      expect(facts()).toEqual([
        ["Role", "Member"],
        ["Invited by", "Ana Beatriz Souza"],
        ["For", "mel@birchwood.example"],
        ["Valid until", "November 21, 2026"],
      ]);
    });

    test("a visitor signs in with the invited email and comes back to accept", async () => {
      const app = await renderApp({ path: "/invite/inv-open-link", wire });
      await screen.findByText("Sign in or create an account to join.");
      await app.user.click(screen.getByRole("button", { name: "Sign in to accept" }));
      await screen.findByRole("heading", { level: 1, name: "Sign in" });
      expect(app.address()).toBe("/login?redirect=%2Finvite%2Finv-open-link");
      await app.user.type(screen.getByLabelText("Email"), "noor@elsewhere.example");
      await app.user.type(screen.getByLabelText("Password"), EXAMPLE_PASSWORD);
      await app.user.click(screen.getByRole("button", { name: "Sign in" }));
      await screen.findByText("You are signed in as noor@elsewhere.example.");
      await app.user.click(screen.getByRole("button", { name: "Accept invitation" }));
      await screen.findByRole("heading", { level: 1, name: "Birchwood Labs" });
      expect(app.address()).toBe("/workspace/workspace_birchwood");
    });

    test("an email invitation tells a visitor which email to use and carries it along", async () => {
      await renderApp({ path: "/invite/inv-mel-pending", wire });
      await screen.findByText("Sign in or create an account with mel@birchwood.example to join.");
      expect(screen.getByRole("link", { name: "Create an account" }).getAttribute("href")).toBe(
        "/signup?redirect=%2Finvite%2Finv-mel-pending&email=mel%40birchwood.example",
      );
    });

    test("accepting: busy, then a server error that can be retried", async () => {
      const app = await renderApp({ path: "/invite/inv-open-link", signedInAs: "usr_noor", wire });
      const accept = await screen.findByRole("button", { name: "Accept invitation" });
      app.server.force("acceptInvitation", { kind: "error", status: 500, code: "internal" });
      await app.user.click(accept);
      expect((await screen.findByRole("alert")).textContent).toBe(
        "The server ran into a problem. Try again.",
      );
      const held = app.server.hold("acceptInvitation");
      await app.user.click(accept);
      expect(accept.getAttribute("aria-busy")).toBe("true");
      held.release();
      await screen.findByRole("heading", { level: 1, name: "Birchwood Labs" });
    });

    test("signed in with another email: the way out is switching account", async () => {
      const app = await renderApp({ path: "/invite/inv-mel-pending", signedInAs: "usr_noor", wire });
      await screen.findByText(
        "This invitation is for mel@birchwood.example. You are signed in as noor@elsewhere.example.",
      );
      expect(screen.queryByRole("button", { name: "Accept invitation" })).toBeNull();
      await app.user.click(screen.getByRole("button", { name: "Sign out and switch account" }));
      await screen.findByRole("heading", { level: 1, name: "Sign in" });
      expect(app.address()).toBe("/login?redirect=%2Finvite%2Finv-mel-pending&email=mel%40birchwood.example");
      expect(screen.getByLabelText<HTMLInputElement>("Email").value).toBe("mel@birchwood.example");
    });

    test("already a member: open the workspace", async () => {
      const app = await renderApp({ path: "/invite/inv-open-link", signedInAs: "usr_ana", wire });
      await screen.findByText("You are already a member of Birchwood Labs.");
      await app.user.click(screen.getByRole("button", { name: "Open Birchwood Labs" }));
      await screen.findByRole("heading", { level: 1, name: "Birchwood Labs" });
    });

    test("expired: ask for a new one, once", async () => {
      const app = await renderApp({ path: "/invite/inv-expired", wire });
      await screen.findByRole("heading", { level: 1, name: "This invitation has expired" });
      await app.user.click(screen.getByRole("button", { name: "Ask for a new one" }));
      expect((await screen.findByRole("status")).textContent).toBe("We told the person who invited you.");
      expect(screen.queryByRole("button", { name: "Ask for a new one" })).toBeNull();
      expect(
        app.server.state.invitations.find((invitation) => invitation.token === "inv-expired")?.requestedNew,
      ).toBe(true);
    });

    test("an unknown token is treated like an expired invitation", async () => {
      await renderApp({ path: "/invite/no-such-invitation", wire });
      await screen.findByRole("heading", { level: 1, name: "This invitation has expired" });
    });

    test("already used: no asking for another, only the way to sign in", async () => {
      await renderApp({ path: "/invite/inv-used", wire });
      await screen.findByRole("heading", { level: 1, name: "This invitation was already used" });
      expect(screen.queryByRole("button", { name: "Ask for a new one" })).toBeNull();
      expect(screen.getByRole("link", { name: "Sign in" })).toBeDefined();
    });

    test("it expires between the preview and the click", async () => {
      const app = await renderApp({ path: "/invite/inv-open-link", signedInAs: "usr_noor", wire });
      const accept = await screen.findByRole("button", { name: "Accept invitation" });
      const invitation = app.server.state.invitations.find(
        (candidate) => candidate.token === "inv-open-link",
      );
      if (invitation) invitation.status = "revoked";
      await app.user.click(accept);
      await screen.findByRole("heading", { level: 1, name: "This invitation has expired" });
    });

    test("a network failure is not an expired invitation: it can be retried", async () => {
      const server = newServer();
      server.force("getInvitation", { kind: "offline" });
      const again = await renderApp({ path: "/invite/inv-mel-pending", server, wire });
      await screen.findByRole("heading", { level: 1, name: "The invitation could not be loaded" });
      expect(screen.getByRole("alert").textContent).toBe(
        "Vanr could not be reached. Check your connection and try again.",
      );
      expect(screen.queryByRole("button", { name: "Ask for a new one" })).toBeNull();
      await again.user.click(screen.getByRole("button", { name: "Try again" }));
      await screen.findByRole("heading", { level: 1, name: "You are invited to Birchwood Labs" });
    });

    test("in Portuguese: the role, the date and the next step", async () => {
      await renderApp({ path: "/invite/inv-mel-pending", languages: ["pt-BR"], wire });
      await screen.findByRole("heading", { level: 1, name: "Você recebeu um convite para Birchwood Labs" });
      expect(facts()).toEqual([
        ["Papel", "Membro"],
        ["Convite de", "Ana Beatriz Souza"],
        ["Para", "mel@birchwood.example"],
        ["Vale até", "21 de novembro de 2026"],
      ]);
      expect(screen.getByRole("button", { name: "Entrar para aceitar" })).toBeDefined();
    });
  });
}
