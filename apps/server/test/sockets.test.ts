// The server's three WebSockets on one listener: the browser's real time, a paired runner and the live wiki.
// A sign-out closes the browser's and the wiki's sockets of that session at once (one session hook for both),
// and the stop closes all three and frees the port.
import { describe, expect, test } from "bun:test";
import type { RunningServer } from "../src/server";
import { COLLAB_PATH } from "../src/wiki-collab";
import { type Browser, SERVER_TEST_MS, signedIn, startTestServer, TestSocket } from "./harness";
import { seedWorkspace } from "./seed";

/** A raw socket and the promises of its open and its close code. */
function raw(url: string, headers: Record<string, string> = {}) {
  const ws = new WebSocket(url, { headers } as never);
  const opened = new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error(`socket ${url} failed to open`)));
  });
  const closed = new Promise<number>((resolve) => ws.addEventListener("close", (ev) => resolve(ev.code)));
  return { ws, opened, closed };
}

const wsBase = (srv: RunningServer) => srv.url.replace(/^http/, "ws");
const cookieOf = (browser: Browser) => [...browser.cookies].map(([k, v]) => `${k}=${v}`).join("; ");

async function threeSockets(srv: RunningServer, who: string) {
  const ana = await signedIn(srv, "Ana", `${who}@sockets.test`);
  const { workspaceId } = await seedWorkspace(srv, ana, "Sockets");
  const browser = await TestSocket.open(ana.browser, workspaceId);
  const runner = raw(`${wsBase(srv)}/api/v1/runners/connect`);
  const wiki = raw(`${wsBase(srv)}${COLLAB_PATH}?workspaceId=${encodeURIComponent(workspaceId)}`, {
    cookie: cookieOf(ana.browser),
    origin: srv.url,
  });
  await Promise.all([runner.opened, wiki.opened]);
  return { ana, browser, runner, wiki };
}

describe("the three sockets on one server", () => {
  test(
    "a sign-out closes the session's browser and wiki sockets, not the runner's",
    async () => {
      const srv = await startTestServer();
      try {
        const { ana, browser, runner, wiki } = await threeSockets(srv, "signout");
        expect((await ana.browser.json("/api/auth/sign-out", "POST", {})).status).toBe(200);
        // Cut by the session hook itself: both are closing when the sign-out answers.
        expect(await browser.closed).toBe(4401);
        expect(await wiki.closed).toBe(4401);
        expect(runner.ws.readyState).toBe(WebSocket.OPEN);
        runner.ws.close();
        await runner.closed;
      } finally {
        await srv.stop();
      }
    },
    SERVER_TEST_MS,
  );

  test(
    "the stop closes the three sockets and the port",
    async () => {
      const srv = await startTestServer();
      const { browser, runner, wiki } = await threeSockets(srv, "stop");
      await srv.stop();
      const codes = await Promise.all([browser.closed, runner.closed, wiki.closed]);
      expect(codes).toHaveLength(3);
      for (const s of [browser.ws, runner.ws, wiki.ws]) expect(s.readyState).toBe(WebSocket.CLOSED);
      await expect(fetch(`${srv.url}/api/v1/me`)).rejects.toThrow();
    },
    SERVER_TEST_MS,
  );
});
