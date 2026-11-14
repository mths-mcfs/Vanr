// Closed sign-up on a new installation: the requests that may create the first user go one at a time, and
// the queue is exposed to the internet. The worst client is slow, mute, huge or gives up halfway; none of
// them may hold the sign-ups behind it, and exactly one person still gets in.
import { describe, expect, spyOn, test } from "bun:test";
import net from "node:net";
import { schema } from "@vanr/engine/db";
import { count } from "drizzle-orm";
import type { RunningServer } from "../src/server";
import { Browser, body as read, SERVER_TEST_MS, startTestServer } from "./harness";

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
    "the body limit counts what arrives: a chunked body past it, in one piece or many, gets 413; a short Content-Length reads no further",
    async () => {
      const server = await startTestServer({ env: CLOSED });
      const chunkedHead =
        `POST /api/auth/sign-up/email HTTP/1.1\r\nHost: localhost:${server.port}\r\nOrigin: ${server.url}\r\n` +
        "Content-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n";
      const chunk = (text: string) => `${text.length.toString(16)}\r\n${text}\r\n`;
      // 16 385 bytes: one past the limit, with no Content-Length to check before reading.
      const big = signUpBody("Big", "big@example.com").replace("strong-password-123", "x".repeat(16_385));
      const onePiece = await rawRequest(server, `${chunkedHead}${chunk(big)}0\r\n\r\n`);
      const manyPieces = await rawRequest(server, chunkedHead);
      for (let i = 0; i < big.length; i += 200) manyPieces.socket.write(chunk(big.slice(i, i + 200)));
      manyPieces.socket.write("0\r\n\r\n");
      // The head says 20 bytes and 20 000 follow: only the 20 declared bytes are the body.
      const lying = await rawRequest(server, `${signUpHead(server, 20)}${big}`);
      try {
        expect(await onePiece.status(5_000)).toBe(413);
        expect(await manyPieces.status(5_000)).toBe(413);
        const short = await lying.status(5_000);
        expect(short).not.toBeNull();
        expect(short).not.toBe(200);
        expect(await users(server)).toBe(0);
      } finally {
        for (const c of [onePiece, manyPieces, lying]) c.socket.destroy();
        await server.stop();
      }
    },
    SERVER_TEST_MS,
  );

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
    "with a user in the installation, a rejected sign-up and a sign-in don't wait for a held section",
    async () => {
      const server = await startTestServer({ env: CLOSED });
      try {
        expect((await new Browser(server.url).signUp("Owner", "owner@example.com")).status).toBe(200);
        const { reached, release } = holdFirstSection(server);
        const held = new Browser(server.url).signUp("Held", "held@example.com");
        while (reached.length === 0) await Bun.sleep(5);
        const started = Date.now();
        const rejected = await new Browser(server.url).signUp("Other", "other@example.com");
        const signIn = await new Browser(server.url).signIn("owner@example.com");
        expect(Date.now() - started).toBeLessThan(2_000);
        expect([rejected.status, signIn.status]).toEqual([403, 200]);
        release();
        await held;
      } finally {
        await server.stop();
      }
    },
    SERVER_TEST_MS,
  );
});

/** A clock of the test's own for the turns' deadlines: a deadline passes only when the test says so. */
function testClock() {
  const pending = new Set<() => void>();
  return {
    deadline: (_ms: number) => {
      let fire!: () => void;
      const passed = new Promise<void>((r) => {
        fire = r;
      });
      pending.add(fire);
      return { passed, cancel: () => pending.delete(fire) };
    },
    /** Every deadline running now passes. */
    pass() {
      for (const fire of [...pending]) fire();
      pending.clear();
    },
  };
}

/**
 * Holds the first creation of a user in the database (past the hook that let it in) until the test
 * succeeds it or fails it; the creations after it go through.
 */
function holdFirstUserCreation(server: RunningServer) {
  const db = server.deps.db;
  const insert = db.insert.bind(db);
  let reached!: () => void;
  const atCreation = new Promise<void>((r) => {
    reached = r;
  });
  let decide!: (ok: boolean) => void;
  const decided = new Promise<boolean>((r) => {
    decide = r;
  });
  let held = false;
  db.insert = ((table: Parameters<typeof insert>[0]) => {
    const builder = insert(table);
    if (table !== schema.users || held) return builder;
    held = true;
    const values = builder.values.bind(builder);
    builder.values = ((rows: Parameters<typeof values>[0]) => {
      const query = values(rows);
      const returning = query.returning.bind(query);
      query.returning = (() =>
        (async () => {
          reached();
          if (!(await decided)) throw new Error("the first creation failed");
          return returning();
        })()) as unknown as typeof query.returning;
      return query;
    }) as typeof builder.values;
    return builder;
  }) as typeof db.insert;
  return { atCreation, succeed: () => decide(true), fail: () => decide(false) };
}

describe("the first user's place", () => {
  for (const first of ["succeeds", "fails"] as const) {
    test(
      `the first section outlives its deadline and then ${first}: never two first users`,
      async () => {
        const clock = testClock();
        const server = await startTestServer({
          env: CLOSED,
          signupQueue: { sectionDeadline: clock.deadline, stuckInsertMs: 100 },
        });
        const creation = holdFirstUserCreation(server);
        const logged: string[] = [];
        const stderr = spyOn(process.stderr, "write").mockImplementation((chunk) => {
          logged.push(String(chunk));
          return true;
        });
        try {
          const n = 4;
          const answers = Array.from({ length: n }, (_, i) =>
            new Browser(server.url)
              .signUp(`Person ${i}`, `p${i}@example.com`)
              .then((r) => `${r.status} retry-after=${r.headers.get("retry-after")}`),
          );
          await creation.atCreation;
          // The held section's deadline passes: the queue moves on while its creation is still pending.
          clock.pass();
          // The turns after it run to their end (their deadlines never pass), all while the held creation is
          // still pending.
          const statuses = await Promise.all(answers);
          expect(await users(server)).toBe(0);
          // The held one answered 503 at its deadline; the others were turned away while it held the place.
          expect(statuses).toEqual(Array.from({ length: n }, () => "503 retry-after=5"));
          // Past the limit, the log and the health check say that sign-up waits for the database.
          await Bun.sleep(350);
          const health = await read(await fetch(`${server.url}/api/v1/health`));
          expect(health.signup).toMatchObject({ status: "waiting_for_database" });
          const waiting = logged.filter((l) => l.includes("signup.first_user_insert_waiting"));
          expect(waiting.length).toBeGreaterThan(0);
          expect(waiting[0]).toContain("Restarting the server releases the place");
          if (first === "succeeds") creation.succeed();
          else creation.fail();
          // Its work really ends now: the place goes back (or the count is no longer zero).
          await Bun.sleep(100);
          expect(await users(server)).toBe(first === "succeeds" ? 1 : 0);
          expect((await read(await fetch(`${server.url}/api/v1/health`))).signup).toEqual({
            status: "ok",
          });
          // After it: with a first user, the next one is rejected; without one, the next one gets in.
          const after = await new Browser(server.url).signUp("After", "after@example.com");
          expect(after.status).toBe(first === "succeeds" ? 403 : 200);
          expect(await users(server)).toBe(1);
        } finally {
          stderr.mockRestore();
          creation.fail();
          await server.stop();
        }
      },
      SERVER_TEST_MS,
    );
  }

  for (const meanwhile of ["another one becomes the first user", "nobody else comes"] as const) {
    test(
      `a section still deciding past its deadline loses the place, and when it goes on it creates nobody (${meanwhile})`,
      async () => {
        const clock = testClock();
        const server = await startTestServer({
          env: CLOSED,
          signupQueue: { sectionDeadline: clock.deadline },
        });
        // The second count read is the first sign-up's hook (the first is the gate's check before the queue).
        const check = holdCountRead(server, 2);
        try {
          const late = new Browser(server.url).signUp("Late", "late@example.com");
          await check.reached;
          clock.pass();
          expect((await late).status).toBe(503);
          if (meanwhile === "another one becomes the first user") {
            expect((await new Browser(server.url).signUp("Next", "next@example.com")).status).toBe(200);
            expect(await users(server)).toBe(1);
          }
          // The late section reads its (now stale) count and reaches the hook without the place.
          check.release();
          await Bun.sleep(200);
          expect(await users(server)).toBe(meanwhile === "nobody else comes" ? 0 : 1);
          if (meanwhile === "nobody else comes") {
            expect((await new Browser(server.url).signUp("Next", "next@example.com")).status).toBe(200);
            expect(await users(server)).toBe(1);
          }
        } finally {
          check.release();
          await server.stop();
        }
      },
      SERVER_TEST_MS,
    );
  }
});

/**
 * Holds the `nth` read of the users count: it is read from the database now and handed back when the test
 * releases it (so it may be stale by then). The other reads go through.
 */
function holdCountRead(server: RunningServer, nth: number) {
  const db = server.deps.db;
  const select = db.select.bind(db);
  let reads = 0;
  let reached!: () => void;
  const atRead = new Promise<void>((r) => {
    reached = r;
  });
  let release!: () => void;
  const released = new Promise<void>((r) => {
    release = r;
  });
  db.select = ((fields: Parameters<typeof select>[0]) => {
    const query = select(fields);
    if (!fields || !("n" in fields)) return query;
    const from = query.from.bind(query);
    query.from = ((table: typeof schema.users) => {
      const built = from(table);
      if (table !== schema.users || ++reads !== nth) return built;
      return (async () => {
        const rows = await built;
        reached();
        await released;
        return rows;
      })();
    }) as unknown as typeof query.from;
    return query;
  }) as typeof db.select;
  return { reached: atRead, release };
}
