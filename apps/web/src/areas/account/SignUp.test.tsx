import { describe, expect, test } from "bun:test";
import { screen } from "@testing-library/react";
import { type App, newServer, renderApp } from "../../../test/app.tsx";
import { invitationTokenIn } from "../../session/redirect.ts";
import { emailProblem, newPasswordProblem, PASSWORD_MAX, PASSWORD_MIN } from "./shared.tsx";

const fill = async (app: App, fields: { name?: string; email?: string; password?: string }) => {
  await screen.findByLabelText("Your name");
  if (fields.name !== undefined) await app.user.type(screen.getByLabelText("Your name"), fields.name);
  if (fields.email !== undefined) await app.user.type(screen.getByLabelText("Email"), fields.email);
  if (fields.password !== undefined) await app.user.type(screen.getByLabelText("Password"), fields.password);
};
const submit = (app: App) => app.user.click(screen.getByRole("button", { name: "Create my account" }));
const signUps = (app: App) => app.server.calls.filter((call) => call.method === "signUp");
const NEW = { name: "Mel Okafor", email: "mel@elsewhere.example", password: "tar-and-birch" };

describe("create account", () => {
  test("idle, open sign-up: the reason says what an account is", async () => {
    await renderApp({ path: "/signup" });
    await screen.findByRole("heading", { level: 1, name: "Create your account" });
    expect(screen.getByText("One account works in every workspace you join.")).toBeDefined();
    expect(screen.getByText("8 characters or more.")).toBeDefined();
  });

  test("idle, first run: the reason says this account owns the installation", async () => {
    await renderApp({ path: "/signup", seed: "empty" });
    expect(
      await screen.findByText("You are the first one here. This account will own the installation."),
    ).toBeDefined();
  });

  test("field errors: each field says what is missing and nothing is sent", async () => {
    const app = await renderApp({ path: "/signup" });
    await fill(app, { password: "seven77" });
    await submit(app);
    expect(screen.getByText("Enter your name.")).toBeDefined();
    expect(screen.getByText("Enter your email.")).toBeDefined();
    expect(screen.getByText("Use at least 8 characters.")).toBeDefined();
    // The error says the rule, so the hint steps aside instead of saying it twice.
    expect(screen.queryByText("8 characters or more.")).toBeNull();
    expect(signUps(app)).toEqual([]);
    await app.user.type(screen.getByLabelText("Password"), "7");
    expect(screen.queryByText("Use at least 8 characters.")).toBeNull();
    expect(screen.getByText("8 characters or more.")).toBeDefined();
  });

  test("sending: the button is busy until the server answers", async () => {
    const app = await renderApp({ path: "/signup" });
    const held = app.server.hold("signUp");
    await fill(app, NEW);
    await submit(app);
    expect(screen.getByRole("button", { name: "Create my account" }).getAttribute("aria-busy")).toBe("true");
    await submit(app);
    expect(signUps(app)).toHaveLength(1);
    held.release();
    await screen.findByRole("heading", { level: 1, name: "Name your workspace" });
  });

  test("server error: the email already has an account", async () => {
    const app = await renderApp({ path: "/signup" });
    await fill(app, { ...NEW, email: "ana@birchwood.example" });
    await submit(app);
    expect((await screen.findByRole("alert")).textContent).toBe(
      "There is already an account with this email. Sign in instead.",
    );
  });

  test("server error: sign-up closed while the form was open", async () => {
    const app = await renderApp({ path: "/signup" });
    await fill(app, NEW);
    app.server.signupOpen = false;
    await submit(app);
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Sign-up is by invitation here. Ask a workspace admin for one.",
    );
  });

  test.each([
    ["the queue's answer", { envelope: true, code: "signup_busy" }],
    ["the sign-in service's answer", { envelope: false, code: "signup_busy" }],
  ])(
    "busy server (%s): 503 with Retry-After counts down, then lets the person retry",
    async (_name, shape) => {
      const app = await renderApp({ path: "/signup", seed: "empty" });
      app.server.force("signUp", { kind: "error", status: 503, retryAfter: 5, ...shape });
      await fill(app, NEW);
      await submit(app);
      expect((await screen.findByRole("alert")).textContent).toContain(
        "Another sign-up is creating the first account. Try again in 5 seconds.",
      );
      expect(screen.getByRole<HTMLButtonElement>("button", { name: "Retry" }).disabled).toBe(true);
      await app.advance(5000);
      await app.user.click(screen.getByRole("button", { name: "Retry" }));
      await screen.findByRole("heading", { level: 1, name: "Name your workspace" });
      expect(signUps(app)).toHaveLength(2);
    },
  );

  test("success: the first account goes on to name its workspace", async () => {
    const app = await renderApp({ path: "/signup", seed: "empty" });
    await fill(app, NEW);
    await submit(app);
    await screen.findByRole("heading", { level: 1, name: "Name your workspace" });
    expect(app.address()).toBe("/onboarding");
    expect(app.server.mail.at(-1)).toMatchObject({ to: NEW.email, kind: "verify" });
    expect(signUps(app)[0]?.params).toMatchObject({ callbackURL: "https://vanr.test/verify-email" });
  });

  test("an invitation lookup failure offers retry instead of the waitlist", async () => {
    const server = newServer("closed");
    server.force("getInvitation", { kind: "offline" });
    const app = await renderApp({ path: "/signup?redirect=%2Finvite%2Finv-mel-pending", server });
    await screen.findByRole("alert");
    expect(screen.queryByRole("button", { name: "Join the waitlist" })).toBeNull();
    await app.user.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByLabelText("Your name");
    expect(screen.getByLabelText<HTMLInputElement>("Email").value).toBe("mel@birchwood.example");
    app.unmount();
    await renderApp({ path: "/signup?redirect=%2Finvite%2Finv-used", server });
    await screen.findByRole("heading", { level: 1, name: "This invitation was already used" });
    expect(screen.getByRole("link", { name: "Sign in" }).getAttribute("href")).toBe("/login");
  });

  test("closed sign-up without an invitation offers the waitlist: every state", async () => {
    const app = await renderApp({ path: "/signup", seed: "closed" });
    await screen.findByRole("heading", { level: 1, name: "Sign-up is by invitation" });
    const join = () => app.user.click(screen.getByRole("button", { name: "Join the waitlist" }));
    await join();
    expect(screen.getByText("Enter your email.")).toBeDefined();
    await app.user.type(screen.getByLabelText("Email"), "curious@elsewhere.example");
    app.server.force("createWaitlist", { kind: "error", status: 500, code: "internal" });
    await join();
    expect((await screen.findByRole("alert")).textContent).toBe("The server ran into a problem. Try again.");
    const held = app.server.hold("createWaitlist");
    await join();
    expect(screen.getByRole("button", { name: "Join the waitlist" }).getAttribute("aria-busy")).toBe("true");
    held.release();
    await screen.findByRole("heading", { level: 1, name: "You are on the list" });
    expect(
      screen.getByText("We sent a link to curious@elsewhere.example. Open it to confirm your place."),
    ).toBeDefined();
    expect(app.server.calls.at(-1)?.params).toEqual({ email: "curious@elsewhere.example", locale: "en" });
  });

  test("closed sign-up with an invitation keeps the form, names the workspace and fills the email", async () => {
    const app = await renderApp({
      path: "/signup?redirect=%2Finvite%2Finv-mel-pending",
      seed: "closed",
    });
    expect(
      await screen.findByText("You were invited to Birchwood Labs. Create an account to join."),
    ).toBeDefined();
    expect(screen.getByLabelText<HTMLInputElement>("Email").value).toBe("mel@birchwood.example");
    await fill(app, { name: "Mel Okafor", password: "tar-and-birch" });
    await submit(app);
    await screen.findByRole("heading", { level: 1, name: "You are invited to Birchwood Labs" });
    await app.user.click(screen.getByRole("button", { name: "Accept invitation" }));
    await screen.findByRole("heading", { level: 1, name: "Birchwood Labs" });
    expect(app.address()).toBe("/workspace/workspace_birchwood");
  });
});

describe("the waitlist link", () => {
  test("confirms the place", async () => {
    const app = await renderApp({ path: "/?confirm=waitlist-token-patient" });
    await screen.findByRole("heading", { level: 1, name: "Your place is confirmed" });
    expect(app.server.waitlist[0]?.confirmed).toBe(true);
  });

  test("a link that does not match says so and offers the way back in", async () => {
    await renderApp({ path: "/?confirm=waitlist-token-nobody" });
    await screen.findByRole("heading", { level: 1, name: "This confirmation link did not work" });
    expect(screen.getByRole("link", { name: "Join the waitlist" }).getAttribute("href")).toBe("/signup");
  });
});

describe("the field rules", () => {
  test("the password limits are the sign-in service's", () => {
    expect([PASSWORD_MIN, PASSWORD_MAX]).toEqual([8, 128]);
    expect(newPasswordProblem("")).toBe("validation.passwordRequired");
    expect(newPasswordProblem("a".repeat(PASSWORD_MIN - 1))).toBe("validation.passwordShort");
    expect(newPasswordProblem("a".repeat(PASSWORD_MIN))).toBeUndefined();
    expect(newPasswordProblem("a".repeat(PASSWORD_MAX))).toBeUndefined();
    expect(newPasswordProblem("a".repeat(PASSWORD_MAX + 1))).toBe("validation.passwordLong");
  });

  test("an email needs a name, an @ and a domain with a dot", () => {
    expect(emailProblem("  ")).toBe("validation.emailRequired");
    for (const bad of ["ana", "ana@", "@birchwood.example", "ana@birchwood", "ana maria@birchwood.example"]) {
      expect(emailProblem(bad), bad).toBe("validation.emailInvalid");
    }
    expect(emailProblem(" ana@birchwood.example ")).toBeUndefined();
  });

  test("a return address with a broken escape counts as none: the form opens as for anyone", async () => {
    const app = await renderApp({ path: "/signup?redirect=%2Finvite%2F%25" });
    await screen.findByLabelText("Password");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Create your account");
    expect(app.server.calls.some((call) => call.method === "getInvitation")).toBe(false);
  });

  test("the invitation token is only read from an address inside the web", () => {
    expect(invitationTokenIn("/invite/inv-mel-pending")).toBe("inv-mel-pending");
    expect(invitationTokenIn("/invite/a%2Bb?x=1")).toBe("a+b");
    for (const other of [
      undefined,
      "/onboarding",
      "https://evil.example/invite/x",
      "//evil.example/invite/x",
      // An escape that is not one, and a token that cannot be one.
      "/invite/%",
      "/invite/%E0%A4%A",
      "/invite/%20",
      42,
    ]) {
      expect(invitationTokenIn(other), String(other)).toBeUndefined();
    }
  });
});
