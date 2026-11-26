import { describe, expect, test } from "bun:test";
import { screen } from "@testing-library/react";
import { type App, renderApp } from "../../../test/app.tsx";

const resets = (app: App) => app.server.mail.filter((mail) => mail.kind === "reset");

describe("forgot password", () => {
  const send = (app: App) => app.user.click(screen.getByRole("button", { name: "Send reset link" }));

  test("idle and field error", async () => {
    const app = await renderApp({ path: "/forgot-password" });
    await screen.findByRole("heading", { level: 1, name: "Reset your password" });
    await send(app);
    expect(screen.getByText("Enter your email.")).toBeDefined();
    expect(app.server.calls.filter((call) => call.method === "requestPasswordReset")).toEqual([]);
  });

  test("sending, then success: the link is sent to where the web can finish the reset", async () => {
    const app = await renderApp({ path: "/forgot-password?email=ana%40birchwood.example" });
    const held = app.server.hold("requestPasswordReset");
    await screen.findByLabelText("Email");
    await send(app);
    expect(screen.getByRole("button", { name: "Send reset link" }).getAttribute("aria-busy")).toBe("true");
    held.release();
    await screen.findByRole("heading", { level: 1, name: "Look in your inbox" });
    expect(
      screen.getByText("If an account uses ana@birchwood.example, the link is on its way."),
    ).toBeDefined();
    expect(app.server.calls.at(-1)?.params).toEqual({
      email: "ana@birchwood.example",
      redirectTo: "https://vanr.test/reset-password",
    });
    expect(resets(app)).toHaveLength(1);
  });

  test("success looks the same for an email without an account", async () => {
    const app = await renderApp({ path: "/forgot-password" });
    await app.user.type(await screen.findByLabelText("Email"), "nobody@elsewhere.example");
    await send(app);
    await screen.findByRole("heading", { level: 1, name: "Look in your inbox" });
    expect(resets(app)).toEqual([]);
  });

  test("server error", async () => {
    const app = await renderApp({ path: "/forgot-password" });
    app.server.force("requestPasswordReset", { kind: "offline" });
    await app.user.type(await screen.findByLabelText("Email"), "ana@birchwood.example");
    await send(app);
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Vanr could not be reached. Check your connection and try again.",
    );
  });
});

describe("reset password", () => {
  const set = (app: App) => app.user.click(screen.getByRole("button", { name: "Set new password" }));
  const withLink = async () => {
    const app = await renderApp({ path: "/forgot-password?email=ana%40birchwood.example" });
    await app.user.click(await screen.findByRole("button", { name: "Send reset link" }));
    await screen.findByRole("heading", { level: 1, name: "Look in your inbox" });
    const token = resets(app)[0]?.token ?? "";
    app.unmount();
    return renderApp({ path: `/reset-password?token=${token}`, server: app.server });
  };

  test("field error, sending, success: the new password signs in and the old one does not", async () => {
    const app = await withLink();
    await screen.findByRole("heading", { level: 1, name: "Choose a new password" });
    await app.user.type(screen.getByLabelText("New password"), "short");
    await set(app);
    expect(screen.getByText("Use at least 8 characters.")).toBeDefined();
    await app.user.type(screen.getByLabelText("New password"), "er-and-better");
    const held = app.server.hold("resetPassword");
    await set(app);
    expect(screen.getByRole("button", { name: "Set new password" }).getAttribute("aria-busy")).toBe("true");
    held.release();
    expect((await screen.findByRole("status")).textContent).toBe(
      "Password changed. Sign in with the new one.",
    );
    expect(app.address()).toBe("/login?reason=password_changed");
    await app.user.type(screen.getByLabelText("Email"), "ana@birchwood.example");
    await app.user.type(screen.getByLabelText("Password"), "birch-and-tar");
    await app.user.click(screen.getByRole("button", { name: "Sign in" }));
    expect((await screen.findByRole("alert")).textContent).toBe("That email and password don't match.");
    await app.user.clear(screen.getByLabelText("Password"));
    await app.user.type(screen.getByLabelText("Password"), "shorter-and-better");
    await app.user.click(screen.getByRole("button", { name: "Sign in" }));
    await screen.findByRole("heading", { level: 1, name: "Birchwood Labs" });
  });

  test("server error: the server is down", async () => {
    const app = await withLink();
    app.server.force("resetPassword", { kind: "error", status: 500, code: "internal" });
    await app.user.type(await screen.findByLabelText("New password"), "long-enough-now");
    await set(app);
    expect((await screen.findByRole("alert")).textContent).toBe("The server ran into a problem. Try again.");
  });

  test("a link that was already used says so and offers a new one", async () => {
    const app = await renderApp({ path: "/reset-password?token=reset-spent" });
    await app.user.type(await screen.findByLabelText("New password"), "long-enough-now");
    await set(app);
    await screen.findByRole("heading", { level: 1, name: "This reset link has expired" });
    expect(screen.getByRole("link", { name: "Send a new link" }).getAttribute("href")).toBe(
      "/forgot-password",
    );
  });

  test.each([
    "/reset-password",
    "/reset-password?error=INVALID_TOKEN",
    "/reset-password?token=x&error=INVALID_TOKEN",
  ])("an address without a usable token shows the expired screen: %s", async (path) => {
    await renderApp({ path });
    await screen.findByRole("heading", { level: 1, name: "This reset link has expired" });
    expect(screen.queryByLabelText("New password")).toBeNull();
  });

  test("a numeric token is sent as the text it is", async () => {
    const app = await renderApp({ path: "/reset-password?token=0012345" });
    await app.user.type(await screen.findByLabelText("New password"), "long-enough-now");
    await set(app);
    await screen.findByRole("heading", { level: 1, name: "This reset link has expired" });
    expect(app.server.calls.at(-1)?.params).toEqual({ token: "0012345", newPassword: "long-enough-now" });
  });
});

describe("verify email", () => {
  const signUp = async () => {
    const app = await renderApp({ path: "/signup" });
    await app.user.type(await screen.findByLabelText("Your name"), "Mel Okafor");
    await app.user.type(screen.getByLabelText("Email"), "mel@elsewhere.example");
    await app.user.type(screen.getByLabelText("Password"), "tar-and-birch");
    await app.user.click(screen.getByRole("button", { name: "Create my account" }));
    await screen.findByRole("heading", { level: 1, name: "Name your workspace" });
    app.unmount();
    return app;
  };

  test("working, then confirmed", async () => {
    const first = await signUp();
    const token = first.server.mail.find((mail) => mail.kind === "verify")?.token ?? "";
    const held = first.server.hold("verifyEmail");
    const app = await renderApp({ path: `/verify-email?token=${token}`, server: first.server });
    await screen.findByRole("heading", { level: 1, name: "Confirming your email" });
    held.release();
    await screen.findByRole("heading", { level: 1, name: "Email confirmed" });
    expect(app.server.emailVerified(app.server.state.users.at(-1)?.email ?? "")).toBe(true);
  });

  test("a spent link, signed in: a new one can be sent, to the web's own address", async () => {
    const first = await signUp();
    const app = await renderApp({
      path: "/verify-email?token=verify-spent",
      server: first.server,
      jar: first.jar,
    });
    await screen.findByRole("heading", { level: 1, name: "This link did not work" });
    await app.user.click(await screen.findByRole("button", { name: "Send a new link" }));
    expect((await screen.findByRole("status")).textContent).toBe(
      "A new link is on its way to mel@elsewhere.example.",
    );
    expect(app.server.calls.at(-1)?.params).toEqual({
      email: "mel@elsewhere.example",
      callbackURL: "https://vanr.test/verify-email",
    });
    // The spent link's 401 was not taken for the end of the session.
    expect(app.address()).toBe("/verify-email?token=verify-spent");
  });

  test("a spent link, signed out: the way to a new one goes through signing in", async () => {
    await renderApp({ path: "/verify-email?error=invalid_token" });
    await screen.findByRole("heading", { level: 1, name: "This link did not work" });
    expect(screen.getByRole("link", { name: "Sign in to get a new link" }).getAttribute("href")).toBe(
      "/login?redirect=%2Fverify-email%3Ferror%3Dexpired",
    );
  });

  test("arriving after the server confirmed the link", async () => {
    await renderApp({ path: "/verify-email" });
    await screen.findByRole("heading", { level: 1, name: "Email confirmed" });
  });
});

describe("a link whose token cannot be one", () => {
  test("reset password: the expired-link screen, and nothing is sent", async () => {
    const app = await renderApp({ path: "/reset-password?token=a%20b" });
    await screen.findByRole("heading", { level: 1, name: "This reset link has expired" });
    expect(screen.queryByLabelText("New password")).toBeNull();
    expect(app.server.calls.some((call) => call.method === "resetPassword")).toBe(false);
  });

  test("verify email: the failed-link screen, and nothing is sent", async () => {
    const app = await renderApp({ path: `/verify-email?token=${"a".repeat(513)}` });
    await screen.findByRole("heading", { level: 1, name: "This link did not work" });
    expect(app.server.calls.some((call) => call.method === "verifyEmail")).toBe(false);
  });

  test("waitlist confirmation: the failed-link screen, and nothing is sent", async () => {
    const app = await renderApp({ path: "/?confirm=a%09b" });
    await screen.findByRole("heading", { level: 1, name: "This confirmation link did not work" });
    expect(app.server.calls.some((call) => call.method === "confirmWaitlist")).toBe(false);
  });

  test.each(["/reset-password?token=%", "/verify-email?token=%E0%A4%A", "/?confirm=%ZZ"])(
    "a broken escape in the query does not break the screen: %s",
    async (path) => {
      await renderApp({ path });
      expect((await screen.findByRole("heading", { level: 1 })).textContent).not.toBe("");
      expect(screen.queryByText("This screen stopped working")).toBeNull();
    },
  );
});
