import { describe, expect, test } from "bun:test";
import { screen, waitFor } from "@testing-library/react";
import { EXAMPLE_PASSWORD } from "../../../dev/fake-server.ts";
import { type App, renderApp, WIRES } from "../../../test/app.tsx";

const fill = async (app: App, email: string, password: string) => {
  await app.user.type(await screen.findByLabelText("Email"), email);
  await app.user.type(screen.getByLabelText("Password"), password);
};
const submit = (app: App) => app.user.click(screen.getByRole("button", { name: "Sign in" }));

// Every state of the sign-in screen, over both wires behind the same Api.
for (const wire of WIRES) {
  describe(`sign in (${wire} wire)`, () => {
    test("idle: the title, the reason and the fields", async () => {
      await renderApp({ path: "/login", wire });
      expect(await screen.findByRole("heading", { level: 1, name: "Sign in" })).toBeDefined();
      expect(screen.getByText("Use the email your workspace knows you by.")).toBeDefined();
      expect(screen.getByLabelText("Email").getAttribute("autocomplete")).toBe("username");
      expect(screen.getByLabelText("Password").getAttribute("type")).toBe("password");
      expect(document.title).toBe("Sign in | Vanr");
    });

    test("field errors: nothing is sent until the fields will do", async () => {
      const app = await renderApp({ path: "/login", wire });
      await screen.findByLabelText("Email");
      await submit(app);
      expect(screen.getByText("Enter your email.")).toBeDefined();
      expect(screen.getByText("Enter your password.")).toBeDefined();
      expect(screen.getByLabelText("Email").getAttribute("aria-invalid")).toBe("true");
      await app.user.type(screen.getByLabelText("Email"), "not-an-email");
      expect(screen.getByText("Enter a valid email address.")).toBeDefined();
      expect(app.server.calls.filter((call) => call.method === "signIn")).toEqual([]);
    });

    test("sending: the button is busy and a second press sends nothing more", async () => {
      const app = await renderApp({ path: "/login", wire });
      const held = app.server.hold("signIn");
      await fill(app, "ana@birchwood.example", EXAMPLE_PASSWORD);
      await submit(app);
      const button = screen.getByRole("button", { name: "Sign in" });
      expect(button.getAttribute("aria-busy")).toBe("true");
      await app.user.click(button);
      expect(app.server.calls.filter((call) => call.method === "signIn")).toHaveLength(1);
      held.release();
      await screen.findByRole("heading", { level: 1, name: "Birchwood Labs" });
    });

    test("server error: a wrong password says so and keeps what was typed", async () => {
      const app = await renderApp({ path: "/login", wire });
      await fill(app, "ana@birchwood.example", "not-the-password");
      await submit(app);
      expect((await screen.findByRole("alert")).textContent).toBe("That email and password don't match.");
      expect(screen.getByLabelText<HTMLInputElement>("Email").value).toBe("ana@birchwood.example");
      expect(app.address()).toBe("/login");
    });

    test("server error: no connection", async () => {
      const app = await renderApp({ path: "/login", wire });
      app.server.force("signIn", { kind: "offline" });
      await fill(app, "ana@birchwood.example", EXAMPLE_PASSWORD);
      await submit(app);
      expect((await screen.findByRole("alert")).textContent).toBe(
        "Vanr could not be reached. Check your connection and try again.",
      );
    });

    test("server error: a code without a translation shows the server's own message", async () => {
      const app = await renderApp({ path: "/login", wire });
      app.server.force("signIn", { kind: "error", status: 418, code: "teapot", message: "Short and stout" });
      await fill(app, "ana@birchwood.example", EXAMPLE_PASSWORD);
      await submit(app);
      expect((await screen.findByRole("alert")).textContent).toBe("Short and stout");
    });

    test("busy server: the wait counts down, then the retry is offered and works", async () => {
      const app = await renderApp({ path: "/login", wire });
      app.server.force("signIn", {
        kind: "error",
        status: 503,
        code: "signup_busy",
        retryAfter: 5,
        envelope: true,
      });
      await fill(app, "ana@birchwood.example", EXAMPLE_PASSWORD);
      await submit(app);
      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toContain("The server is busy");
      expect(alert.textContent).toContain("Try again in 5 seconds.");
      const retry = screen.getByRole<HTMLButtonElement>("button", { name: "Retry" });
      expect(retry.disabled).toBe(true);
      await app.advance(4000);
      expect(screen.getByRole("alert").textContent).toContain("Try again in 1 second.");
      expect(retry.disabled).toBe(true);
      await app.advance(1000);
      expect(screen.getByRole("alert").textContent).toContain("Try again now.");
      await app.user.click(screen.getByRole("button", { name: "Retry" }));
      await screen.findByRole("heading", { level: 1, name: "Birchwood Labs" });
    });

    test("success: the person lands in their first workspace", async () => {
      const app = await renderApp({ path: "/login", wire });
      await fill(app, "ana@birchwood.example", EXAMPLE_PASSWORD);
      await submit(app);
      await screen.findByRole("heading", { level: 1, name: "Birchwood Labs" });
      expect(app.address()).toBe("/workspace/workspace_birchwood");
    });
  });
}

describe("sign in: where it leads", () => {
  test("someone without a workspace is asked to name one", async () => {
    const app = await renderApp({ path: "/login" });
    await fill(app, "noor@elsewhere.example", EXAMPLE_PASSWORD);
    await submit(app);
    await screen.findByRole("heading", { level: 1, name: "Name your workspace" });
    expect(app.address()).toBe("/onboarding");
  });

  test("a remembered workspace is opened instead of the first one", async () => {
    const app = await renderApp({ path: "/workspace/workspace_nightshift", signedInAs: "usr_ana" });
    await screen.findByRole("heading", { level: 1, name: "Night Shift" });
    const again = await renderApp({
      path: "/",
      server: app.server,
      signedInAs: "usr_ana",
      store: app.runtime.store,
    });
    await waitFor(() => expect(again.address()).toBe("/workspace/workspace_nightshift"));
  });

  test("an installation without accounts sends sign-in to creating the first one", async () => {
    const app = await renderApp({ path: "/login", seed: "empty" });
    await screen.findByRole("heading", { level: 1, name: "Create your account" });
    expect(app.address()).toBe("/signup");
  });

  test("someone already signed in does not see the form", async () => {
    const app = await renderApp({ path: "/login", signedInAs: "usr_ana" });
    await screen.findByRole("heading", { level: 1, name: "Birchwood Labs" });
    expect(app.address()).toBe("/workspace/workspace_birchwood");
  });

  test("the notices: signed out, session ended, password changed", async () => {
    for (const [reason, text] of [
      ["signed_out", "You signed out."],
      ["ended", "Your session ended. Sign in to pick up where you left off."],
      ["password_changed", "Password changed. Sign in with the new one."],
    ] as const) {
      const app = await renderApp({ path: `/login?reason=${reason}` });
      expect((await screen.findByRole("status")).textContent).toBe(text);
      app.unmount();
    }
  });

  test("an unknown reason in the address is ignored", async () => {
    await renderApp({ path: "/login?reason=%3Cscript%3E" });
    await screen.findByRole("heading", { level: 1, name: "Sign in" });
    expect(screen.queryByRole("status")).toBeNull();
  });

  test("the way to sign-up carries the address to return to and the email typed so far", async () => {
    const app = await renderApp({ path: "/login?redirect=%2Finvite%2Finv-open-link" });
    await app.user.type(await screen.findByLabelText("Email"), "new@elsewhere.example");
    await app.user.click(screen.getByRole("link", { name: "Create an account" }));
    await screen.findByRole("heading", { level: 1, name: "Create your account" });
    expect(app.address()).toBe("/signup?redirect=%2Finvite%2Finv-open-link&email=new%40elsewhere.example");
    expect(screen.getByLabelText<HTMLInputElement>("Email").value).toBe("new@elsewhere.example");
  });

  test("in Portuguese when the browser asks for it", async () => {
    await renderApp({ path: "/login", languages: ["pt-BR", "en"] });
    expect(await screen.findByRole("heading", { level: 1, name: "Entrar" })).toBeDefined();
    expect(screen.getByLabelText("Senha")).toBeDefined();
    expect(document.documentElement.lang).toBe("pt-BR");
  });
});
