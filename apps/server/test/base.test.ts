import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { schema } from "@vanr/engine/db";
import { sha256Hex } from "@vanr/engine/ids";
import { count, eq } from "drizzle-orm";
import { importLegacyPlan, planOf, writePlan } from "../src/assignments/plan";
import { consumeSession, mintSession, newCredential } from "../src/runners/credentials";
import type { RunningServer } from "../src/server";
import { Browser, body as read, SERVER_TEST_MS, startTestServer } from "./harness";

let server: RunningServer;
let clock = new Date();
const runnerFields = { workspaceId: "module-w", name: "R", pairedByUserId: "u", storeKey: "k" };
beforeAll(async () => {
  server = await startTestServer({ now: () => clock });
  await server.deps.db.insert(schema.workspaces).values({ id: "module-w", name: "W" });
}, SERVER_TEST_MS);
afterAll(async () => {
  await server.stop();
}, SERVER_TEST_MS);

describe("base server", () => {
  test("waitlist bounds recipient resends and the installation's public email burst", async () => {
    const b = new Browser(server.url);
    const join = async (email: string) =>
      expect(await read(await b.json("/api/v1/waitlist", "POST", { email }))).toEqual({ ok: true });
    const sent = () => server.mailer.sent().filter((m) => m.kind === "waitlist");
    const before = sent().length;
    for (let i = 0; i < 20; i++) await join(i % 2 ? "Burst@Example.com" : "burst@example.com");
    expect(sent().length - before).toBe(1);
    for (let i = 0; i < 25; i++) await join(`burst-${i}@example.com`);
    expect(sent().length - before).toBe(20);
    clock = new Date(clock.getTime() + 15 * 60_000);
    await join("burst@example.com");
    expect(sent().length - before).toBe(21);
  });

  test("runner rotation permits lost-response retries but rejects overlapping, superseded and inactive sessions", async () => {
    const db = server.deps.db;
    const credential = newCredential();
    await db.insert(schema.runners).values({ ...runnerFields, id: "r", tokenHash: sha256Hex(credential) });
    const results = await Promise.allSettled([
      mintSession(server.deps, credential),
      mintSession(server.deps, credential),
    ]);
    const minted = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
    expect(minted).toHaveLength(1);
    const retry = await mintSession(server.deps, credential);
    expect(await consumeSession(server.deps, minted[0]?.session ?? "missing")).toBeNull();
    expect(await consumeSession(server.deps, retry.session)).toMatchObject({ id: "r" });
    expect(await consumeSession(server.deps, retry.session)).toBeNull();
    const next = await mintSession(server.deps, retry.credential);
    expect(next).toHaveProperty("session");
    for (const inactive of ["revokedAt", "removedAt"] as const) {
      await db
        .update(schema.runners)
        .set({ revokedAt: null, removedAt: null, [inactive]: clock })
        .where(eq(schema.runners.id, "r"));
      expect(await consumeSession(server.deps, next.session)).toBeNull();
    }
  });

  test("legacy plan import preserves every status without changing new agent item policy", async () => {
    const db = server.deps.db;
    await db.insert(schema.agents).values({
      id: "plan-a",
      workspaceId: "module-w",
      name: "A",
      handle: "a",
      model: "m",
      ownerUserId: "u",
      appearance: { color: "blue", eyes: "dot", adornment: "none" },
    });
    const items = (["todo", "doing", "blocked_on_you", "done", "dropped"] as const).map((status) => ({
      id: status,
      title: status,
      status,
    }));
    const [assignment] = await db
      .insert(schema.assignments)
      .values({
        id: "plan",
        workspaceId: "module-w",
        title: "Plan",
        goal: "Goal",
        agentId: "plan-a",
        channelId: "c",
        threadId: "t",
        ownerId: "u",
        plan: { version: 0, items },
      })
      .returning();
    if (!assignment) throw new Error("no assignment");
    expect(await importLegacyPlan(server.deps, assignment)).toBe(true);
    expect((await planOf(server.deps, assignment.id)).map((i) => i.status)).toEqual(
      items.map((i) => i.status),
    );
    const written = await writePlan(server.deps, assignment.id, {
      author: { type: "agent", id: "plan-a" },
      mode: "agent",
      items: [{ id: "new", title: "New", status: "dropped" }],
    });
    expect(written.items.find((i) => i.id === "new")?.status).toBe("todo");
  });

  test("/api/v1/health declares the edition and the database", async () => {
    const res = await fetch(`${server.url}/api/v1/health`);
    expect(res.status).toBe(200);
    expect(await read(res)).toEqual({
      status: "ok",
      version: "0.1.0",
      edition: "selfhost",
      database: "ok",
      modules: [],
      signup: { status: "ok" },
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
    clock = new Date(clock.getTime() + 60_000);
    const barrier = holdReads(server, 5, schema.waitlist);
    const joined = await Promise.all(
      Array.from({ length: 5 }, () => b.json("/api/v1/waitlist", "POST", { email: "Queue@Example.com" })),
    );
    barrier.restore();
    expect(barrier.timedOut).toBe(false);
    expect(joined.map((r) => r.status)).toEqual(Array(5).fill(200));
    const mails = server.mailer.sent().filter((m) => m.kind === "waitlist" && m.to === "queue@example.com");
    expect(mails).toHaveLength(1);
    const mail = mails[0];
    const token = new URL(mail?.link ?? "http://x").searchParams.get("confirm");
    expect(token).toBeTruthy();
    const confirm = await b.json("/api/v1/waitlist/confirm", "POST", { token });
    expect(await read(confirm)).toEqual({ ok: true });
    const missing = await b.json("/api/v1/waitlist/confirm", "POST", { token: "x".repeat(20) });
    expect(missing.status).toBe(404);
  });
});

describe("closed sign-up", () => {
  test(
    "the first user gets in (new installation); the second gets 403",
    async () => {
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
    },
    SERVER_TEST_MS,
  );

  test(
    "simultaneous sign-ups on a new installation: exactly one gets in",
    async () => {
      const closed = await startTestServer({ env: { SIGNUP_OPEN: "false" } });
      try {
        const n = 5;
        const barrier = holdReads(closed, n);
        const results = await Promise.all(
          Array.from({ length: n }, (_, i) =>
            new Browser(closed.url).signUp(`Person ${i}`, `p${i}@example.com`),
          ),
        );
        expect(barrier.timedOut).toBe(false);
        expect(results.map((r) => r.status).sort()).toEqual([200, 403, 403, 403, 403]);
        const [users] = await closed.deps.db.select({ n: count() }).from(schema.users);
        expect(users?.n).toBe(1);
      } finally {
        await closed.stop();
      }
    },
    SERVER_TEST_MS,
  );
});

/**
 * Holds the first `n` reads until all arrived, forcing overlapping sign-ups or waitlist joins.
 * Later reads pass through. A timeout fails the test instead of accepting an unforced schedule.
 */
function holdReads(
  server: RunningServer,
  n: number,
  table: typeof schema.users | typeof schema.waitlist = schema.users,
) {
  const db = server.deps.db;
  const select = db.select.bind(db);
  const barrier = {
    timedOut: false,
    restore: () => {
      db.select = select;
    },
  };
  let arrived = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const deadline = setTimeout(() => {
    barrier.timedOut = true;
    release();
  }, 5_000);
  db.select = ((fields: Parameters<typeof select>[0]) => {
    const query = select(fields);
    if (table === schema.users && (!fields || !("n" in fields))) return query;
    const from = query.from.bind(query);
    query.from = ((source: typeof table) => {
      const built = from(source);
      if (source !== table || arrived >= n) return built;
      arrived++;
      const execute = built.execute.bind(built);
      built.execute = async (...args) => {
        const rows = await execute(...args);
        if (arrived === n) {
          clearTimeout(deadline);
          release();
        }
        await gate;
        return rows;
      };
      return built;
    }) as unknown as typeof query.from;
    return query;
  }) as typeof db.select;
  return barrier;
}

describe("SPA fallback", () => {
  test(
    "index.html on any path outside the API; /assets cached for 4 h",
    async () => {
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
    },
    SERVER_TEST_MS,
  );
});
