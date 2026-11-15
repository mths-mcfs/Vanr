// A boot that fails at a step undoes what came up before it, and the error thrown is the step's own. Each
// test breaks one step through `steps` (the instance lock, the database, the VAPID keys read after the
// listener) or for real (the port), and checks the undo on the resource itself: the lock released, the
// database closed, the port free, the runner connections closed. The lock on a real Postgres is in
// production.test.ts.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type OpenDb, openDb } from "@vanr/engine/db";
import { sql } from "drizzle-orm";
import type { RunnerSocketData } from "../src/runners/hub";
import type { BootSteps } from "../src/server";
import { holdNextIndexWrite, body as read, SERVER_TEST_MS, signedIn, startTestServer } from "./harness";
import { seedWorkspace } from "./seed";

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "vanr-boot-"));
  dirs.push(d);
  return d;
}

/** A port that was free a moment ago. */
function freePort(): number {
  const probe = Bun.serve({ port: 0, fetch: () => new Response("probe") });
  const port = probe.port;
  probe.stop(true);
  if (port === undefined) throw new Error("no port");
  return port;
}

/** Nothing listens on the port: a new listener takes it. */
function expectPortFree(port: number) {
  const again = Bun.serve({ port, fetch: () => new Response("again") });
  expect(again.port).toBe(port);
  again.stop(true);
}

/** A database the boot can no longer use: queries on a closed PGlite reject. */
async function expectClosed(opened: OpenDb | null) {
  if (!opened) throw new Error("the database was never opened");
  const query = async () => opened.db.execute(sql`select 1`);
  await expect(query()).rejects.toThrow("Failed query");
}

/**
 * The boot's outside steps, recorded: a double of the lock's connection (the lock is taken only with a
 * Postgres URL, so the config gets one) and the real database opened on PGlite in memory.
 */
function recorded() {
  const seen = { lockHeld: false, lockReleased: false, opened: null as OpenDb | null };
  const steps: Partial<BootSteps> = {
    holdInstanceLock: async () => {
      seen.lockHeld = true;
      return {
        release: async () => {
          seen.lockReleased = true;
        },
      };
    },
    openDb: async () => {
      seen.opened = await openDb({ kind: "pglite", dataDir: null });
      return seen.opened;
    },
  };
  return { seen, steps, env: { DATABASE_URL: "postgres://lock-double.invalid/vanr" } };
}

describe("boot that fails halfway", () => {
  test(
    "the lock can't be taken: its error is thrown and nothing after it starts",
    async () => {
      const { seen, steps, env } = recorded();
      const original = new Error("lock held elsewhere");
      const port = freePort();
      await expect(
        startTestServer({
          env: { ...env, PORT: String(port) },
          steps: { ...steps, holdInstanceLock: () => Promise.reject(original) },
        }),
      ).rejects.toBe(original);
      expect(seen.opened).toBeNull();
      expectPortFree(port);
    },
    SERVER_TEST_MS,
  );

  test(
    "the database doesn't open: the lock is released and the database's error is thrown",
    async () => {
      const { seen, steps, env } = recorded();
      const original = new Error("migration failed");
      const port = freePort();
      await expect(
        startTestServer({
          env: { ...env, PORT: String(port) },
          steps: { ...steps, openDb: () => Promise.reject(original) },
        }),
      ).rejects.toBe(original);
      expect([seen.lockHeld, seen.lockReleased]).toEqual([true, true]);
      expectPortFree(port);
    },
    SERVER_TEST_MS,
  );

  test(
    "a database that can't be created on disk: its own error (ENOTDIR) is the one thrown",
    async () => {
      const dir = await tempDir();
      await writeFile(join(dir, "file"), "not a directory");
      const port = freePort();
      await expect(
        startTestServer({ env: { DATA_DIR: join(dir, "file"), PORT: String(port) } }),
      ).rejects.toMatchObject({ code: "ENOTDIR" });
      expectPortFree(port);
    },
    SERVER_TEST_MS,
  );

  test(
    "port in use: the lock is released, the database closed, the listener's error thrown, and the next attempt starts",
    async () => {
      const { seen, steps, env } = recorded();
      const busy = Bun.serve({ port: 0, fetch: () => new Response("busy") });
      const port = String(busy.port);
      try {
        await expect(startTestServer({ env: { ...env, PORT: port }, steps })).rejects.toMatchObject({
          code: "EADDRINUSE",
        });
        expect(seen.lockReleased).toBe(true);
        await expectClosed(seen.opened);
        expect(await (await fetch(`http://localhost:${port}/`)).text()).toBe("busy");
        busy.stop(true);
        const retry = await startTestServer({ env: { PORT: port } });
        try {
          expect((await read(await fetch(`${retry.url}/api/v1/health`))).database).toBe("ok");
        } finally {
          await retry.stop();
        }
      } finally {
        busy.stop(true);
      }
    },
    SERVER_TEST_MS,
  );

  test(
    "a step after the listener fails (the VAPID keys): lock released, database closed, port free, the step's error",
    async () => {
      const { seen, steps, env } = recorded();
      const original = new SyntaxError("vapid.json is not JSON");
      const port = freePort();
      await expect(
        startTestServer({
          env: { ...env, PORT: String(port) },
          steps: { ...steps, loadVapid: () => Promise.reject(original) },
        }),
      ).rejects.toBe(original);
      expect(seen.lockReleased).toBe(true);
      await expectClosed(seen.opened);
      await expect(fetch(`http://localhost:${port}/api/v1/health`)).rejects.toThrow();
      expectPortFree(port);
    },
    SERVER_TEST_MS,
  );

  test(
    "unreadable VAPID keys on disk: the parse error is thrown, and with the file gone the same data directory starts",
    async () => {
      const dir = await tempDir();
      await writeFile(join(dir, "vapid.json"), "{ not json");
      const port = freePort();
      const env = { DATA_DIR: dir, PORT: String(port) };
      await expect(startTestServer({ env })).rejects.toBeInstanceOf(SyntaxError);
      expectPortFree(port);
      await rm(join(dir, "vapid.json"));
      const retry = await startTestServer({ env });
      try {
        expect((await read(await fetch(`${retry.url}/api/v1/health`))).database).toBe("ok");
      } finally {
        await retry.stop();
      }
    },
    SERVER_TEST_MS,
  );

  test(
    "an undo that fails doesn't replace the original error, and the undos after it still run",
    async () => {
      const { seen, steps, env } = recorded();
      const busy = Bun.serve({ port: 0, fetch: () => new Response("busy") });
      try {
        await expect(
          startTestServer({
            env: { ...env, PORT: String(busy.port) },
            steps: {
              ...steps,
              holdInstanceLock: async () => ({ release: () => Promise.reject(new Error("unlock failed")) }),
            },
          }),
        ).rejects.toMatchObject({ code: "EADDRINUSE" });
        await expectClosed(seen.opened);
      } finally {
        busy.stop(true);
      }
    },
    SERVER_TEST_MS,
  );
});

describe("while it boots", () => {
  test(
    "a request that arrives before the app is mounted gets 503, and 200 once the boot ends",
    async () => {
      const port = freePort();
      let release!: () => void;
      const held = new Promise<void>((r) => {
        release = r;
      });
      let reached!: () => void;
      const atVapid = new Promise<void>((r) => {
        reached = r;
      });
      const booting = startTestServer({
        env: { PORT: String(port) },
        steps: {
          loadVapid: async (config) => {
            reached();
            await held;
            const { loadVapid } = await import("../src/push");
            return loadVapid(config);
          },
        },
      });
      await atVapid;
      const early = await fetch(`http://localhost:${port}/api/v1/health`);
      expect([early.status, await early.text()]).toEqual([503, "starting"]);
      release();
      const server = await booting;
      try {
        expect((await fetch(`${server.url}/api/v1/health`)).status).toBe(200);
      } finally {
        await server.stop();
      }
    },
    SERVER_TEST_MS,
  );
});

describe("stop", () => {
  test(
    "closes the listener, the database and the runner connections; a second stop does nothing",
    async () => {
      const { seen, steps, env } = recorded();
      const port = freePort();
      const server = await startTestServer({ env: { ...env, PORT: String(port) }, steps });
      // A runner connected to the server's hub, through a socket server of its own.
      const sockets = Bun.serve<RunnerSocketData>({
        port: 0,
        fetch: (req, srv) =>
          srv.upgrade(req, {
            data: {
              kind: "runner",
              runnerId: "r1",
              workspaceId: "w1",
              lastFrameAt: 0,
              helloTimer: null,
              pingTimer: null,
              closed: false,
            },
          })
            ? undefined
            : new Response("upgrade", { status: 426 }),
        websocket: {
          open: (ws) => {
            server.deps.runners.register("r1", ws);
          },
          message() {},
        },
      });
      try {
        const runner = new WebSocket(`ws://localhost:${sockets.port}/`);
        const closed = new Promise<number>((r) => runner.addEventListener("close", (ev) => r(ev.code)));
        while (!server.deps.runners.isOnline("r1")) await Bun.sleep(2);
        expect((await fetch(`${server.url}/api/v1/health`)).status).toBe(200);
        await server.stop();
        expect(await closed).toBe(1001);
        expect(server.deps.runners.online()).toEqual([]);
        expect(seen.lockReleased).toBe(true);
        await expectClosed(seen.opened);
        await expect(fetch(`http://localhost:${port}/api/v1/health`)).rejects.toThrow();
        await server.stop();
        expectPortFree(port);
      } finally {
        sockets.stop(true);
      }
    },
    SERVER_TEST_MS,
  );

  test(
    "two stops at once share the shutdown: after either one, the database is closed",
    async () => {
      const { seen, steps, env } = recorded();
      const server = await startTestServer({ env, steps });
      const first = server.stop();
      const second = server.stop();
      expect(second).toBe(first);
      await second;
      await expectClosed(seen.opened);
      expect(server.stop()).toBe(first);
    },
    SERVER_TEST_MS,
  );

  test(
    "waits for an admitted request before closing the wiki and the database, and admits no new one",
    async () => {
      const server = await startTestServer();
      const ana = await signedIn(server, "Ana", "in-flight@boot.test");
      const { workspaceId } = await seedWorkspace(server, ana);
      const held = holdNextIndexWrite(server);
      const pages = `/api/v1/workspaces/${workspaceId}/wiki/pages`;
      const created = ana.browser.json(pages, "POST", { title: "In flight", body: "Pending index" });
      await held.begun;
      let stopped = false;
      const stopping = server.stop().then(() => {
        stopped = true;
      });
      expect((await ana.browser.fetch(pages)).status).toBe(503);
      await Bun.sleep(100);
      expect(stopped).toBe(false);
      held.release();
      const res = await created;
      expect(res.status).toBe(201);
      expect((await read(res)).title).toBe("In flight");
      await stopping;
    },
    SERVER_TEST_MS,
  );

  test(
    "a shutdown that fails gives every stop the same error",
    async () => {
      const { steps, env } = recorded();
      const failure = new Error("unlock failed");
      const server = await startTestServer({
        env,
        steps: { ...steps, holdInstanceLock: async () => ({ release: () => Promise.reject(failure) }) },
      });
      const first = server.stop();
      const second = server.stop();
      await expect(first).rejects.toBe(failure);
      await expect(second).rejects.toBe(failure);
      await expect(server.stop()).rejects.toBe(failure);
    },
    SERVER_TEST_MS,
  );
});
