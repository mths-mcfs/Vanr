// The harness's held index write always opens: a test that fails inside the hold must not leave the request
// parked, where it holds the page's queue and makes the file's server.stop() wait out its hook timeout.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { RunningServer } from "../src/server";
import { holdNextIndexWrite, SERVER_TEST_MS, signedIn, startTestServer } from "./harness";
import { seedWorkspace } from "./seed";

let server: RunningServer;
let pages: string;
let browser: Awaited<ReturnType<typeof signedIn>>["browser"];

beforeAll(async () => {
  server = await startTestServer();
  const ana = await signedIn(server, "Ana", "ana@harness.test");
  const { workspaceId } = await seedWorkspace(server, ana);
  pages = `/api/v1/workspaces/${workspaceId}/wiki/pages`;
  browser = ana.browser;
}, SERVER_TEST_MS);
afterAll(() => server.stop(), SERVER_TEST_MS);

/** The response's status, or `"parked"` when it hasn't come within 2 s: a write left held never answers. */
async function statusWithin(res: Promise<Response>): Promise<number | "parked"> {
  return Promise.race([res.then((r) => r.status), Bun.sleep(2_000).then(() => "parked" as const)]);
}

const failure = new Error("an assertion inside the hold failed");

describe("holdNextIndexWrite", () => {
  test("a body that throws while the write is held lets that write go on", async () => {
    let created: Promise<Response> | undefined;
    const held = holdNextIndexWrite(server, async (hold) => {
      created = browser.json(pages, "POST", { title: "Held", body: "Held write" });
      await hold.begun;
      throw failure;
    });
    await expect(held).rejects.toBe(failure);
    if (!created) throw new Error("the body never sent the write");
    expect(await statusWithin(created)).toBe(201);
  });

  test("a body that throws before any write leaves the next write free", async () => {
    await expect(
      holdNextIndexWrite(server, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(await statusWithin(browser.json(pages, "POST", { title: "Free", body: "Free write" }))).toBe(201);
  });
});
