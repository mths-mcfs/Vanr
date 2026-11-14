// A boot that fails at a step undoes what came up before it, and the error thrown is the step's own. Each
// test breaks one real step (the database, the listener, the VAPID keys read after the listener) and checks
// that nothing stays open and that the next attempt in the same process starts. The single-instance lock
// and the database connections on a real Postgres are in production.test.ts.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { body as read, startTestServer } from "./harness";

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

describe("boot that fails halfway", () => {
  test("the database doesn't open: its error is the one thrown and the port is never taken", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "file"), "not a directory");
    const port = freePort();
    await expect(
      startTestServer({ env: { DATA_DIR: join(dir, "file"), PORT: String(port) } }),
    ).rejects.toMatchObject({ code: "ENOTDIR" });
    expectPortFree(port);
  }, 30_000);

  test("port in use: the listener's error is the one thrown, and the next attempt in the same process starts", async () => {
    const busy = Bun.serve({ port: 0, fetch: () => new Response("busy") });
    const port = String(busy.port);
    try {
      await expect(startTestServer({ env: { PORT: port } })).rejects.toMatchObject({ code: "EADDRINUSE" });
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
  }, 30_000);

  test("a step after the listener fails (unreadable VAPID keys): the listener is closed and the error is the step's", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "vapid.json"), "{ not json");
    const port = freePort();
    const env = { DATA_DIR: dir, PORT: String(port) };
    await expect(startTestServer({ env })).rejects.toBeInstanceOf(SyntaxError);
    await expect(fetch(`http://localhost:${port}/api/v1/health`)).rejects.toThrow();
    expectPortFree(port);
    // With the keys fixed, the same data directory (its database included) starts in the same process.
    await rm(join(dir, "vapid.json"));
    const retry = await startTestServer({ env });
    try {
      expect((await read(await fetch(`${retry.url}/api/v1/health`))).database).toBe("ok");
    } finally {
      await retry.stop();
    }
  }, 30_000);
});

describe("stop", () => {
  test("closes the listener and a second stop does nothing", async () => {
    const port = freePort();
    const server = await startTestServer({ env: { PORT: String(port) } });
    expect((await fetch(`${server.url}/api/v1/health`)).status).toBe(200);
    await server.stop();
    await expect(fetch(`http://localhost:${port}/api/v1/health`)).rejects.toThrow();
    await server.stop();
    expectPortFree(port);
  }, 30_000);
});
