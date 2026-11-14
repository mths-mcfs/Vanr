// Closed sign-up on a new installation: the requests that may create the first user go one at a time, and
// the queue is exposed to the internet. The worst client is slow, mute, huge or gives up halfway; none of
// them may hold the sign-ups behind it, and exactly one person still gets in.
import { describe, expect, test } from "bun:test";
import net from "node:net";
import { schema } from "@vanr/engine/db";
import { count } from "drizzle-orm";
import type { RunningServer } from "../src/server";
import { Browser, SERVER_TEST_MS, startTestServer } from "./harness";

const CLOSED = { SIGNUP_OPEN: "false" };

/** A raw connection that sent the request head; the test decides what (and whether) the body is. */
async function rawRequest(server: RunningServer, head: string) {
  const socket = net.createConnection({ host: "localhost", port: server.port });
  await new Promise((r) => socket.once("connect", r));
  let received = "";
  socket.on("data", (d) => {
    received += String(d);
  });
  socket.on("error", () => {});
  socket.write(head);
  return {
    socket,
    /** The status line of the response, once it arrives (or null by the deadline). */
    async status(ms: number): Promise<number | null> {
      const until = Date.now() + ms;
      while (Date.now() < until) {
        const m = /^HTTP\/1\.1 (\d{3})/.exec(received);
        if (m) return Number(m[1]);
        await Bun.sleep(10);
      }
      return null;
    },
    received: () => received,
  };
}

const signUpHead = (server: RunningServer, length: number) =>
  `POST /api/auth/sign-up/email HTTP/1.1\r\nHost: localhost:${server.port}\r\nOrigin: ${server.url}\r\n` +
  `Content-Type: application/json\r\nContent-Length: ${length}\r\n\r\n`;

const signUpBody = (name: string, email: string) =>
  JSON.stringify({ name, email, password: "strong-password-123" });

async function users(server: RunningServer): Promise<number> {
  const [row] = await server.deps.db.select({ n: count() }).from(schema.users);
  return row?.n ?? 0;
}

/**
 * Holds Better Auth's handler for the first sign-up that reaches it, until `release`; counts who reached
 * it. A held request never creates its user (it answers 500 when released), so the test controls who did.
 */
function holdFirstSection(server: RunningServer) {
  const auth = server.deps.auth;
  const real = auth.handler.bind(auth);
  const reached: string[] = [];
  let release!: () => void;
  const released = new Promise<void>((r) => {
    release = r;
  });
  let held = false;
  auth.handler = async (req: Request) => {
    const body: unknown = await req
      .clone()
      .json()
      .catch(() => null);
    const email = typeof body === "object" && body && "email" in body ? String(body.email) : "?";
    reached.push(email);
    if (!held) {
      held = true;
      await released;
      return new Response("held", { status: 500 });
    }
    return real(req);
  };
  return { reached, release };
}

describe("closed sign-up queue", () => {
  test(
    "a slow body, a mute client and a huge body hold nobody; the sign-ups behind them answer and exactly one gets in",
    async () => {
      const server = await startTestServer({ env: CLOSED, signupQueue: { bodyMs: 1_000 } });
      const slow = await rawRequest(server, `${signUpHead(server, 1_000)}{`);
      const tick = setInterval(() => slow.socket.write(" "), 100);
      const mute = await rawRequest(server, signUpHead(server, 200));
      const huge = await rawRequest(server, signUpHead(server, 50_000_000));
      try {
        const started = Date.now();
        const results = await Promise.all(
          Array.from({ length: 5 }, (_, i) =>
            new Browser(server.url).signUp(`Person ${i}`, `p${i}@example.com`),
          ),
        );
        expect(Date.now() - started).toBeLessThan(5_000);
        expect(results.map((r) => r.status).sort()).toEqual([200, 403, 403, 403, 403]);
        expect(await users(server)).toBe(1);
        expect(await huge.status(1_000)).toBe(413);
        expect(await slow.status(2_000)).toBe(408);
        expect(await mute.status(2_000)).toBe(408);
      } finally {
        clearInterval(tick);
        for (const c of [slow, mute, huge]) c.socket.destroy();
        await server.stop();
      }
    },
    SERVER_TEST_MS,
  );

  test(
    "a client that gives up while waiting leaves the queue without running",
    async () => {
      const server = await startTestServer({ env: CLOSED });
      const { reached, release } = holdFirstSection(server);
      try {
        const first = new Browser(server.url).signUp("First", "first@example.com");
        while (reached.length === 0) await Bun.sleep(5);
        const body = signUpBody("Quitter", "quitter@example.com");
        const quitter = await rawRequest(server, `${signUpHead(server, body.length)}${body}`);
        await Bun.sleep(150);
        quitter.socket.destroy();
        await Bun.sleep(100);
        release();
        expect((await first).status).toBe(500);
        const after = await new Browser(server.url).signUp("Later", "later@example.com");
        expect(after.status).toBe(200);
        expect(reached).toEqual(["first@example.com", "later@example.com"]);
      } finally {
        release();
        await server.stop();
      }
    },
    SERVER_TEST_MS,
  );

  test(
    "waiting past the deadline answers 503 with Retry-After",
    async () => {
      const server = await startTestServer({ env: CLOSED, signupQueue: { waitMs: 300, sectionMs: 10_000 } });
      const { reached, release } = holdFirstSection(server);
      try {
        const first = new Browser(server.url).signUp("First", "first@example.com");
        while (reached.length === 0) await Bun.sleep(5);
        const started = Date.now();
        const waiting = await new Browser(server.url).signUp("Second", "second@example.com");
        expect(Date.now() - started).toBeLessThan(2_000);
        expect(waiting.status).toBe(503);
        expect(Number(waiting.headers.get("retry-after"))).toBeGreaterThan(0);
        expect(reached).toEqual(["first@example.com"]);
        release();
        await first;
      } finally {
        release();
        await server.stop();
      }
    },
    SERVER_TEST_MS,
  );

  test(
    "a section past its deadline frees the queue for the next one",
    async () => {
      const server = await startTestServer({
        env: CLOSED,
        signupQueue: { sectionMs: 3_000, waitMs: 10_000 },
      });
      const { reached, release } = holdFirstSection(server);
      try {
        const first = new Browser(server.url).signUp("Stuck", "stuck@example.com");
        while (reached.length === 0) await Bun.sleep(5);
        const next = await new Browser(server.url).signUp("Next", "next@example.com");
        expect(next.status).toBe(200);
        expect((await first).status).toBe(503);
        expect(await users(server)).toBe(1);
      } finally {
        release();
        await server.stop();
      }
    },
    SERVER_TEST_MS,
  );

  test(
    "the queue has a maximum size: past it the request answers 503 at once",
    async () => {
      const server = await startTestServer({ env: CLOSED, signupQueue: { maxWaiting: 1, waitMs: 10_000 } });
      const { reached, release } = holdFirstSection(server);
      try {
        const first = new Browser(server.url).signUp("First", "first@example.com");
        while (reached.length === 0) await Bun.sleep(5);
        const second = new Browser(server.url).signUp("Second", "second@example.com");
        await Bun.sleep(100);
        const started = Date.now();
        const third = await new Browser(server.url).signUp("Third", "third@example.com");
        expect(Date.now() - started).toBeLessThan(1_000);
        expect(third.status).toBe(503);
        expect(third.headers.get("retry-after")).toBeTruthy();
        release();
        await first;
        expect((await second).status).toBe(200);
      } finally {
        release();
        await server.stop();
      }
    },
    SERVER_TEST_MS,
  );

  test(
    "with a user in the installation, a refused sign-up and a sign-in don't wait for a held section",
    async () => {
      const server = await startTestServer({ env: CLOSED });
      try {
        expect((await new Browser(server.url).signUp("Owner", "owner@example.com")).status).toBe(200);
        const { reached, release } = holdFirstSection(server);
        const held = new Browser(server.url).signUp("Held", "held@example.com");
        while (reached.length === 0) await Bun.sleep(5);
        const started = Date.now();
        const refused = await new Browser(server.url).signUp("Other", "other@example.com");
        const signIn = await new Browser(server.url).signIn("owner@example.com");
        expect(Date.now() - started).toBeLessThan(2_000);
        expect([refused.status, signIn.status]).toEqual([403, 200]);
        release();
        await held;
      } finally {
        await server.stop();
      }
    },
    SERVER_TEST_MS,
  );
});
