// The client as the web builds it: where a 401 is noticed, and what the client's own checks look
// like from a screen's side.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type FetchLike, isApiError } from "@vanr/client";
import { createFetchTransport, createWebApi } from "./index.ts";

function api(answer: (url: string) => Response) {
  const urls: string[] = [];
  let unauthorized = 0;
  const fetch: FetchLike = async (url) => {
    urls.push(url);
    return answer(url);
  };
  const web = createWebApi(createFetchTransport({ fetch }), { onUnauthorized: () => unauthorized++ });
  return { web, urls, unauthorized: () => unauthorized };
}

const envelope = (status: number, code: string) =>
  Response.json({ error: { code, message: code } }, { status });

async function failure(run: () => Promise<unknown>) {
  try {
    await run();
  } catch (cause) {
    if (isApiError(cause)) return cause;
    throw cause;
  }
  throw new Error("the call did not fail");
}

describe("the session rule", () => {
  test("a 401 from an operation of the server's table reports it, and the call still rejects", async () => {
    const { web, unauthorized } = api(() => envelope(401, "unauthorized"));
    const error = await failure(() => web.client.api.getOverview({ workspaceId: "workspace_birchwood" }));
    expect(error.status).toBe(401);
    expect(error.code).toBe("unauthorized");
    expect(unauthorized()).toBe(1);
  });

  test("asking who is signed in answers nobody on a 401, through the same road", async () => {
    const { web, unauthorized } = api(() => envelope(401, "unauthorized"));
    expect(await web.client.api.getMe()).toBeNull();
    // Reported here too; with no session open, the gate has nothing to end.
    expect(unauthorized()).toBe(1);
  });

  test("a 401 from signing in or from an email link is an ordinary error", async () => {
    const { web, unauthorized } = api(() => Response.json({ code: "INVALID_TOKEN" }, { status: 401 }));
    const signIn = await failure(() => web.auth.signIn({ body: { email: "a@b.example", password: "x" } }));
    expect(signIn.rawCode).toBe("invalid_token");
    await failure(() => web.auth.verifyEmail({ query: { token: "spent" } }));
    expect(unauthorized()).toBe(0);
  });

  test("other failures are not the session's business", async () => {
    const { web, unauthorized } = api(() => envelope(403, "forbidden"));
    await failure(() => web.client.api.getOverview({ workspaceId: "workspace_birchwood" }));
    expect(unauthorized()).toBe(0);
  });
});

describe("what the client checks before a screen sees anything", () => {
  test("an answer outside the contract is rejected as an invalid response", async () => {
    const { web } = api(() => Response.json({ people: "many" }));
    const error = await failure(() => web.client.api.getOverview({ workspaceId: "workspace_birchwood" }));
    expect(error.code).toBe("invalid_response");
  });

  test("fields the contract does not have never reach the screen", async () => {
    const { web } = api(() =>
      Response.json({ people: 4, agents: 3, myApprovalQueue: 2, budgetSpentPct: 38, internalNote: "x" }),
    );
    expect(await web.client.api.getOverview({ workspaceId: "workspace_birchwood" })).toEqual({
      people: 4,
      agents: 3,
      myApprovalQueue: 2,
      budgetSpentPct: 38,
    });
  });

  test("an empty path parameter is refused before any request leaves", async () => {
    const { web, urls } = api(() => Response.json({}));
    const error = await failure(() => web.client.api.getOverview({ workspaceId: "" }));
    expect(error.code).toBe("invalid_request");
    expect(urls).toHaveLength(0);
  });
});

function sources(folder: string): string[] {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe("what the app's own code never does", () => {
  const root = join(import.meta.dir, "..");
  const files = sources(root).map((path) => ({
    path: path.slice(root.length + 1),
    // Comments may name what the code must not do.
    code: readFileSync(path, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, ""),
  }));
  const offenders = (pattern: RegExp, allowed: string[] = []) =>
    files.filter((file) => pattern.test(file.code) && !allowed.includes(file.path)).map((file) => file.path);

  test("there is code to look at", () => {
    expect(files.length).toBeGreaterThan(40);
  });

  test("the test doubles stay out: no import of the client's testing entry or of dev/", () => {
    expect(offenders(/@vanr\/client\/testing|\/dev\/fake-server|\/dev\/serve/)).toEqual([]);
  });

  test("only the wire calls fetch", () => {
    expect(offenders(/\bfetch\(/, ["api/wire.ts", "api/auth.ts"])).toEqual([]);
    // auth.ts calls the wire's fetch, never the browser's.
    expect(offenders(/globalThis\.fetch|window\.fetch/, ["api/wire.ts"])).toEqual([]);
  });

  test("nothing opens a socket: the connection is the client's", () => {
    expect(offenders(/new WebSocket\(/)).toEqual([]);
  });

  test("no area declares a path of the server's API", () => {
    expect(offenders(/["'`]\/api\/v1\//)).toEqual([]);
    expect(offenders(/["'`]\/api\/auth\//, ["api/auth.ts"])).toEqual([]);
  });

  test("nothing but the session looks at a 401", () => {
    expect(offenders(/\b401\b/, ["api/web-api.ts"])).toEqual([]);
  });
});
