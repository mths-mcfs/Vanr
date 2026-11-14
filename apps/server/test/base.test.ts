import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunningServer } from "../src/server";
import { Browser, body as read, startTestServer } from "./harness";

let server: RunningServer;
beforeAll(async () => {
  server = await startTestServer();
});
afterAll(async () => {
  await server.stop();
});

describe("base server", () => {
  test("/api/v1/health declares the edition and the database", async () => {
    const res = await fetch(`${server.url}/api/v1/health`);
    expect(res.status).toBe(200);
    expect(await read(res)).toEqual({
      status: "ok",
      version: "0.1.0",
      edition: "selfhost",
      database: "ok",
      modules: [],
    });
  });

  test("without a session, /api/v1/me returns 401 in the envelope", async () => {
    const res = await fetch(`${server.url}/api/v1/me`);
    expect(res.status).toBe(401);
    expect(await read(res)).toEqual({ error: { code: "unauthorized", message: "Sign in to continue" } });
  });

  test("Better Auth answers in its own format", async () => {
    const b = new Browser(server.url);
    const session = await b.fetch("/api/auth/get-session");
    expect(session.status).toBe(200);
    expect(await read(session)).toBeNull();
    const ok = await b.fetch("/api/auth/ok");
    expect(await read(ok)).toEqual({ ok: true });
    const bad = await b.signIn("nobody@example.com", "wrong-123");
    expect(bad.status).toBe(401);
    expect(await read(bad)).toMatchObject({ code: "INVALID_EMAIL_OR_PASSWORD" });
  });

  test("auth config: firstRun until the first sign-up; no social providers without their variables", async () => {
    const before = await read(await fetch(`${server.url}/api/v1/auth/config`));
    expect(before).toEqual({
      socialProviders: { google: false, github: false, apple: false },
      signupOpen: true,
      firstRun: true,
    });
    const b = new Browser(server.url);
    expect((await b.signUp("Ada", "ada@example.com")).status).toBe(200);
    const after = await read(await fetch(`${server.url}/api/v1/auth/config`));
    expect(after.firstRun).toBe(false);
  });

  test("sign-up, cookie session, /me and sign-out", async () => {
    const b = new Browser(server.url);
    expect((await b.signUp("Grace", "grace@example.com")).status).toBe(200);
    const me = await b.fetch("/api/v1/me");
    expect(me.status).toBe(200);
    const body = await read(me);
    expect(body.user).toMatchObject({ name: "Grace", email: "grace@example.com" });
    expect(body.workspaces).toEqual([]);
    expect([...b.cookies.keys()].some((k) => k.includes("session_token"))).toBe(true);

    await b.json("/api/auth/sign-out", "POST", {});
    expect((await b.fetch("/api/v1/me")).status).toBe(401);

    expect((await b.signIn("grace@example.com")).status).toBe(200);
    expect((await b.fetch("/api/v1/me")).status).toBe(200);
  });

  test("sign-up sends the verification email through the development adapter", async () => {
    const b = new Browser(server.url);
    await b.signUp("Linus", "linus@example.com");
    const mail = server.mailer.sent().find((m) => m.to === "linus@example.com" && m.kind === "verify");
    expect(mail?.link).toContain("/api/auth/verify-email");
  });

  test("writes are JSON only (415 for a form)", async () => {
    const res = await fetch(`${server.url}/api/v1/waitlist`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "email=a@b.com",
    });
    expect(res.status).toBe(415);
    expect((await read(res)).error.code).toBe("unsupported_media_type");
  });

  test("an API route that doesn't exist returns 404 route_not_found", async () => {
    const res = await fetch(`${server.url}/api/v1/does-not-exist`);
    expect(res.status).toBe(404);
    expect((await read(res)).error.code).toBe("route_not_found");
  });

  test("waitlist: join and confirm through the email's link", async () => {
    const b = new Browser(server.url);
    const join1 = await b.json("/api/v1/waitlist", "POST", { email: "Queue@Example.com" });
    expect(await read(join1)).toEqual({ ok: true });
    const mail = server.mailer.sent().find((m) => m.kind === "waitlist" && m.to === "queue@example.com");
    const token = new URL(mail?.link ?? "http://x").searchParams.get("confirm");
    expect(token).toBeTruthy();
    const confirm = await b.json("/api/v1/waitlist/confirm", "POST", { token });
    expect(await read(confirm)).toEqual({ ok: true });
    const missing = await b.json("/api/v1/waitlist/confirm", "POST", { token: "x".repeat(20) });
    expect(missing.status).toBe(404);
  });
});

describe("closed sign-up", () => {
  test("the first user gets in (new installation); the second gets 403", async () => {
    const closed = await startTestServer({ env: { SIGNUP_OPEN: "false" } });
    try {
      const cfg = await read(await fetch(`${closed.url}/api/v1/auth/config`));
      expect(cfg).toMatchObject({ signupOpen: false, firstRun: true });
      const first = new Browser(closed.url);
      expect((await first.signUp("Owner", "owner@example.com")).status).toBe(200);
      const second = new Browser(closed.url);
      const res = await second.signUp("Other", "other@example.com");
      expect(res.status).toBe(403);
      expect(await read(res)).toMatchObject({ code: "SIGNUP_CLOSED" });
    } finally {
      await closed.stop();
    }
  }, 30_000);
});

describe("SPA fallback", () => {
  test("index.html on any path outside the API; /assets cached for 4 h", async () => {
    const dist = await mkdtemp(join(tmpdir(), "dist-"));
    await mkdir(join(dist, "assets"));
    await writeFile(join(dist, "index.html"), "<!doctype html><title>spa</title>");
    await writeFile(join(dist, "assets", "app-123.js"), "console.log(1)");
    const s = await startTestServer({ env: { WEB_DIST: dist } });
    try {
      for (const path of ["/", "/login", "/workspace/abc/c/def"]) {
        const res = await fetch(`${s.url}${path}`);
        expect(res.status).toBe(200);
        expect(await res.text()).toContain("<title>spa</title>");
      }
      const asset = await fetch(`${s.url}/assets/app-123.js`);
      expect(asset.headers.get("cache-control")).toBe("public, max-age=14400");
      const traversal = await fetch(`${s.url}/assets/..%2f..%2fetc%2fpasswd`);
      expect(await traversal.text()).toContain("<title>spa</title>");
    } finally {
      await s.stop();
    }
  }, 30_000);
});
