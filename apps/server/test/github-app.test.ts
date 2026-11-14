// The GitHub App installation, called as the connector routes will call it (they come with a later slice).
// GitHub is a local fake that checks the app's JWT with the app's public key; nothing goes out to the network.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { schema } from "@vanr/engine/db";
import { eq } from "drizzle-orm";
import type { Starter } from "../src/integrations/connectors";
import { finishInstall, installUrl, repoRefusal, repositoriesOf } from "../src/integrations/github-app";
import type { RunningServer } from "../src/server";
import { SERVER_TEST_MS, signedIn, startTestServer } from "./harness";
import { seedWorkspace } from "./seed";

const STATE_TTL_MS = 30 * 60_000;
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const API = "https://api.github.test";

/** The fake GitHub API: every request must carry a JWT of the app (or the installation token). */
function fakeGitHub() {
  const seen: { method: string; path: string; jwt: "valid" | "invalid" | "token" }[] = [];
  const installs = new Map([
    ["101", { id: 101, account: { login: "acme" }, repository_selection: "selected", suspended_at: null }],
    ["202", { id: 202, account: { login: "other" }, repository_selection: "all", suspended_at: null }],
  ]);
  const checkJwt = (auth: string | null): "valid" | "invalid" | "token" => {
    const bearer = auth?.replace(/^Bearer /, "") ?? "";
    if (bearer === "inst-token") return "token";
    const [head, body, sig] = bearer.split(".");
    if (!head || !body || !sig) return "invalid";
    const ok = createVerify("RSA-SHA256")
      .update(`${head}.${body}`)
      .verify(publicKey, Buffer.from(sig, "base64url"));
    const claims = JSON.parse(Buffer.from(body, "base64url").toString());
    return ok && claims.iss === "4242" && claims.exp - claims.iat <= 600 ? "valid" : "invalid";
  };
  const fn = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    const jwt = checkJwt(new Headers(init.headers).get("authorization"));
    seen.push({ method, path: url.pathname, jwt });
    if (jwt === "invalid") return new Response("bad credentials", { status: 401 });
    const m = /^\/app\/installations\/(\d+)(\/access_tokens)?$/.exec(url.pathname);
    if (m?.[1] && jwt === "valid") {
      const install = installs.get(m[1]);
      if (!install) return new Response("not found", { status: 404 });
      if (m[2]) return Response.json({ token: "inst-token" }, { status: 201 });
      if (method === "DELETE") return new Response(null, { status: 204 });
      return Response.json(install);
    }
    if (url.pathname === "/installation/repositories" && jwt === "token")
      return Response.json({ total_count: 1, repositories: [{ full_name: "acme/site", private: true }] });
    return new Response("not found", { status: 404 });
  };
  return { fetch: Object.assign(fn, { preconnect: () => {} }) as typeof fetch, seen };
}

let clock = new Date("2026-11-14T12:00:00Z");
const github = fakeGitHub();
let server: RunningServer;
let ana: Starter;
let bob: Starter;

beforeAll(async () => {
  server = await startTestServer({
    env: {
      GITHUB_APP_ID: "4242",
      GITHUB_APP_SLUG: "vanr-test",
      GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      GITHUB_API_URL: API,
      GITHUB_WEB_URL: "https://github.test",
    },
    fetchExternal: github.fetch,
    now: () => clock,
  });
  const a = await signedIn(server, "Ana", "ana@github.test");
  const b = await signedIn(server, "Bob", "bob@github.test");
  const wa = await seedWorkspace(server, a, "Acme");
  const wb = await seedWorkspace(server, b, "Other");
  ana = { workspaceId: wa.workspaceId, userId: a.user.id, role: "owner", handle: "ana", sessionId: "s-ana" };
  bob = { workspaceId: wb.workspaceId, userId: b.user.id, role: "owner", handle: "bob", sessionId: "s-bob" };
}, SERVER_TEST_MS);
afterAll(() => server.stop(), SERVER_TEST_MS);

const stateOf = (url: string) => new URL(url).searchParams.get("state") ?? "";
const viewer = (s: Starter) => ({ userId: s.userId, sessionId: s.sessionId });
const install = (s: Starter, state: string, id = "101") =>
  finishInstall(server.deps, viewer(s), { installation_id: id, setup_action: "install", state });

describe("GitHub App installation", () => {
  test(
    "installs into the workspace that started it, once; the app's JWT is the one GitHub checks",
    async () => {
      const url = await installUrl(server.deps, ana, "/back");
      expect(url.startsWith("https://github.test/apps/vanr-test/installations/new?state=")).toBe(true);
      const state = stateOf(url);
      expect(await install(ana, state)).toBe("/back?github_app=installed");
      expect(github.seen.at(-1)).toEqual({ method: "GET", path: "/app/installations/101", jwt: "valid" });
      const [row] = await server.deps.db
        .select()
        .from(schema.githubInstallations)
        .where(eq(schema.githubInstallations.id, "101"));
      expect(row).toMatchObject({
        workspaceId: ana.workspaceId,
        accountUsername: "acme",
        repoScope: "selected",
      });
      // The same callback again: the state is spent.
      const calls = github.seen.length;
      expect(await install(ana, state)).toBe("/?github_app=error");
      expect(github.seen.length).toBe(calls);
      expect(await repositoriesOf(server.deps, ana.workspaceId)).toEqual({
        connected: true,
        accounts: [{ login: "acme", repositories: [{ fullName: "acme/site", private: true }] }],
      });
    },
    SERVER_TEST_MS,
  );

  test(
    "an installation of another workspace stays there: the second one gets `taken`",
    async () => {
      const state = stateOf(await installUrl(server.deps, bob, "/b"));
      expect(await install(bob, state)).toBe("/b?github_app=taken");
      const [row] = await server.deps.db
        .select()
        .from(schema.githubInstallations)
        .where(eq(schema.githubInstallations.id, "101"));
      expect(row?.workspaceId).toBe(ana.workspaceId);
    },
    SERVER_TEST_MS,
  );

  test(
    "another session, another person, a bad installation id or an expired state don't install",
    async () => {
      const calls = github.seen.length;
      let state = stateOf(await installUrl(server.deps, bob, "/b"));
      expect(await install({ ...bob, sessionId: "s-other" }, state, "202")).toBe("/b?github_app=error");
      state = stateOf(await installUrl(server.deps, bob, "/b"));
      expect(await install(ana, state, "202")).toBe("/b?github_app=error");
      state = stateOf(await installUrl(server.deps, bob, "/b"));
      expect(await install(bob, state, "202/../101")).toBe("/b?github_app=error");
      expect(github.seen.length).toBe(calls);

      state = stateOf(await installUrl(server.deps, bob, "/b"));
      clock = new Date(clock.getTime() + STATE_TTL_MS - 1);
      expect(await install(bob, state, "202")).toBe("/b?github_app=installed");
      state = stateOf(await installUrl(server.deps, bob, "/b"));
      clock = new Date(clock.getTime() + STATE_TTL_MS);
      expect(await install(bob, state, "202")).toBe("/b?github_app=error");
    },
    SERVER_TEST_MS,
  );

  test("a restricted agent only reaches the repositories it names", () => {
    const allowed = ["acme/site", "tools/*"];
    expect(repoRefusal([], "search_code", { q: "x" })).toBeNull();
    expect(repoRefusal(allowed, "get_me", {})).toBeNull();
    expect(repoRefusal(allowed, "get_file", { owner: "Acme", repo: "Site" })).toBeNull();
    expect(repoRefusal(allowed, "get_file", { repository: "tools/cli" })).toBeNull();
    expect(repoRefusal(allowed, "search_code", { q: "repo:acme/site TODO" })).toBeNull();
    expect(repoRefusal(allowed, "search_code", { q: "TODO" })).toContain("Name one");
    expect(repoRefusal(allowed, "get_file", { owner: "acme", repo: "secret" })).toContain("acme/secret");
    expect(repoRefusal(allowed, "search_code", { q: "-repo:acme/site TODO" })).toContain("search operator");
    expect(repoRefusal(allowed, "search_code", { q: "org:acme TODO" })).toContain("acme/*");
    expect(repoRefusal(allowed, "get_file", { owner: "acme/site", repo: "x" })).toContain("acme/site/x");
  });
});
