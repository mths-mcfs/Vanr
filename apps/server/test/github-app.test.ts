// The GitHub App installation, called as the connector routes will call it (they come with a later slice).
// GitHub is a local fake that checks the app's JWT with the app's public key, turns a user's `code` into a user
// token and lists the installations accessible to that user; nothing goes out to the network.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { schema } from "@vanr/engine/db";
import { eq } from "drizzle-orm";
import type { Starter } from "../src/integrations/connectors";
import { finishInstall, installUrl, repoRefusal, repositoriesOf } from "../src/integrations/github-app";
import type { RunningServer } from "../src/server";
import { SERVER_TEST_MS, signedIn, startTestServer } from "./harness";
import { call, ws } from "./route-calls";
import { type Person, seedWorkspace } from "./seed";

const STATE_TTL_MS = 30 * 60_000;
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const API = "https://api.github.test";

/** Installations visible to each user, including a read-only collaborator. */
const USERS: Record<string, number[]> = { "user-ana": [101], "user-bob": [101, 202], "user-eve": [909] };
const CLIENT = { id: "Iv1.vanr", secret: "app-client-secret" };

/** The fake GitHub API: every request must carry a JWT of the app, the installation token or a user token. */
function fakeGitHub() {
  const seen: { method: string; path: string; jwt: "valid" | "invalid" | "token" | "user" }[] = [];
  const installs = new Map([
    [
      "101",
      {
        id: 101,
        account: { id: 10, login: "acme", type: "Organization" },
        repository_selection: "selected",
        suspended_at: null,
      },
    ],
    [
      "202",
      {
        id: 202,
        account: { id: 22, login: "other", type: "User" },
        repository_selection: "all",
        suspended_at: null,
      },
    ],
    [
      "808",
      {
        id: 808,
        account: { id: 80, login: "leaving", type: "Organization" },
        repository_selection: "all",
        suspended_at: null,
      },
    ],
    [
      "707",
      {
        id: 707,
        account: { id: 70, login: "stuck", type: "Organization" },
        repository_selection: "all",
        suspended_at: null,
      },
    ],
    [
      "909",
      {
        id: 909,
        account: { id: 90, login: "victim-account", type: "Organization" },
        repository_selection: "all",
        suspended_at: null,
      },
    ],
  ]);
  /** A code works once and belongs to one user. */
  const codes = new Map([
    ["code-ana", "user-ana"],
    ["code-ana-2", "user-ana"],
    ["code-bob", "user-bob"],
    ["code-bob-2", "user-bob"],
    ["code-bob-3", "user-bob"],
    ["code-eve", "user-eve"],
  ]);
  const checkJwt = (auth: string | null): "valid" | "invalid" | "token" | "user" => {
    const bearer = auth?.replace(/^Bearer /, "") ?? "";
    if (bearer === "inst-token") return "token";
    if (bearer in USERS) return "user";
    const [head, body, sig] = bearer.split(".");
    if (!head || !body || !sig) return "invalid";
    const ok = createVerify("RSA-SHA256")
      .update(`${head}.${body}`)
      .verify(publicKey, Buffer.from(sig, "base64url"));
    const claims = JSON.parse(Buffer.from(body, "base64url").toString());
    return ok && claims.iss === "4242" && claims.exp - claims.iat <= 600 ? "valid" : "invalid";
  };
  /** Requests that reached another origin after a redirect (the exchange must never send its body there). */
  const elsewhere: string[] = [];
  const fn = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    if (url.origin === "https://elsewhere.test") {
      elsewhere.push(`${method} ${url.pathname} ${String(init.body ?? "")}`);
      return Response.json({ access_token: "user-ana", token_type: "bearer" });
    }
    if (url.origin === "https://github.test" && url.pathname === "/login/oauth/access_token") {
      const body = JSON.parse(String(init.body));
      seen.push({ method, path: url.pathname, jwt: "user" });
      if (body.code === "code-redirect")
        return new Response(null, {
          status: 307,
          headers: { location: "https://elsewhere.test/login/oauth/access_token" },
        });
      const user = codes.get(body.code);
      codes.delete(body.code);
      if (body.client_id !== CLIENT.id || body.client_secret !== CLIENT.secret || !user)
        return Response.json({ error: "bad_verification_code" });
      return Response.json({ access_token: user, token_type: "bearer" });
    }
    const jwt = checkJwt(new Headers(init.headers).get("authorization"));
    seen.push({ method, path: url.pathname, jwt });
    if (jwt === "invalid") return new Response("bad credentials", { status: 401 });
    const m = /^\/app\/installations\/(\d+)(\/access_tokens)?$/.exec(url.pathname);
    if (m?.[1] && jwt === "valid") {
      const install = installs.get(m[1]);
      if (!install) return new Response("not found", { status: 404 });
      if (m[2]) return Response.json({ token: "inst-token" }, { status: 201 });
      // GitHub refuses to uninstall 707.
      if (method === "DELETE") return new Response(null, { status: m[1] === "707" ? 500 : 204 });
      return Response.json(install);
    }
    if (url.pathname === "/user" && jwt === "user")
      return Response.json({
        id: new Headers(init.headers).get("authorization") === "Bearer user-bob" ? 22 : 11,
      });
    if (url.pathname.startsWith("/user/memberships/orgs/") && jwt === "user")
      return Response.json({ state: "active", role: url.pathname.endsWith("/acme") ? "admin" : "member" });
    if (url.pathname === "/user/installations" && jwt === "user") {
      const ids = USERS[new Headers(init.headers).get("authorization")?.replace(/^Bearer /, "") ?? ""] ?? [];
      return Response.json({
        total_count: ids.length,
        installations: ids.map((id) => installs.get(String(id))),
      });
    }
    if (url.pathname === "/installation/repositories" && jwt === "token")
      return Response.json({ total_count: 1, repositories: [{ full_name: "acme/site", private: true }] });
    return new Response("not found", { status: 404 });
  };
  return { fetch: Object.assign(fn, { preconnect: () => {} }) as typeof fetch, seen, elsewhere };
}

let clock = new Date("2026-11-14T12:00:00Z");
const github = fakeGitHub();
let server: RunningServer;
let ana: Starter;
let bob: Starter;
let anaPerson: Person;

beforeAll(async () => {
  server = await startTestServer({
    env: {
      GITHUB_APP_ID: "4242",
      GITHUB_APP_SLUG: "vanr-test",
      GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      GITHUB_API_URL: API,
      GITHUB_WEB_URL: "https://github.test",
      GITHUB_APP_CLIENT_ID: CLIENT.id,
      GITHUB_APP_CLIENT_SECRET: CLIENT.secret,
    },
    fetchExternal: github.fetch,
    now: () => clock,
  });
  const a = await signedIn(server, "Ana", "ana@github.test");
  anaPerson = a;
  const b = await signedIn(server, "Bob", "bob@github.test");
  const wa = await seedWorkspace(server, a, "Acme");
  const wb = await seedWorkspace(server, b, "Other");
  ana = { workspaceId: wa.workspaceId, userId: a.user.id, role: "owner", handle: "ana", sessionId: "s-ana" };
  bob = { workspaceId: wb.workspaceId, userId: b.user.id, role: "owner", handle: "bob", sessionId: "s-bob" };
}, SERVER_TEST_MS);
afterAll(() => server.stop(), SERVER_TEST_MS);

const stateOf = (url: string) => new URL(url).searchParams.get("state") ?? "";
const viewer = (s: Starter) => ({ userId: s.userId, sessionId: s.sessionId });
const install = (s: Starter, state: string, id = "101", code?: string) =>
  finishInstall(server.deps, viewer(s), {
    installation_id: id,
    setup_action: "install",
    state,
    code: code ?? `code-${s.handle}`,
  });

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
      expect(await install(bob, state, "202", "code-bob-2")).toBe("/b?github_app=installed");
      state = stateOf(await installUrl(server.deps, bob, "/b"));
      clock = new Date(clock.getTime() + STATE_TTL_MS);
      expect(await install(bob, state, "202", "code-bob-3")).toBe("/b?github_app=error");
    },
    SERVER_TEST_MS,
  );

  test(
    "only someone who controls the installation can link it: no code, a bad code or someone else's installation keeps nothing",
    async () => {
      const rowsOf = async (id: string) =>
        server.deps.db.select().from(schema.githubInstallations).where(eq(schema.githubInstallations.id, id));
      const appCalls = () => github.seen.filter((c) => c.path.startsWith("/app/installations/909")).length;
      for (const code of [undefined, "", "code-unknown", "code-eve"]) {
        const state = stateOf(await installUrl(server.deps, ana, "/back"));
        const back = await finishInstall(server.deps, viewer(ana), {
          installation_id: "909",
          setup_action: "install",
          state,
          ...(code === undefined ? {} : { code }),
        });
        expect([code, back]).toEqual([code, "/back?github_app=unverified"]);
      }
      expect(await rowsOf("909")).toEqual([]);
      // Never even read with the app's JWT: nothing about the victim's installation reached the workspace.
      expect(appCalls()).toBe(0);
      expect((await repositoriesOf(server.deps, ana.workspaceId)).accounts.map((a) => a.login)).toEqual([
        "acme",
      ]);
    },
    SERVER_TEST_MS,
  );

  test(
    "a redirected code exchange fails and its body, with the client secret, never reaches the second origin",
    async () => {
      const state = stateOf(await installUrl(server.deps, ana, "/back"));
      expect(await install(ana, state, "101", "code-redirect")).toBe("/back?github_app=unverified");
      expect(github.elsewhere).toEqual([]);
    },
    SERVER_TEST_MS,
  );

  test(
    "without the App's OAuth client the installation doesn't start",
    async () => {
      const cfg = server.deps.config;
      const app = cfg.integrations.githubApp;
      if (!app) throw new Error("the App is configured in this test");
      const deps = {
        ...server.deps,
        config: { ...cfg, integrations: { ...cfg.integrations, githubApp: { ...app, oauthClient: null } } },
      };
      await expect(installUrl(deps, ana, "/back")).rejects.toMatchObject({
        code: "github_app.not_configured",
      });
    },
    SERVER_TEST_MS,
  );

  test(
    "removing an install says whether GitHub uninstalled the app; it leaves the workspace either way",
    async () => {
      const ids = ["808", "707", "606"];
      await server.deps.db.insert(schema.githubInstallations).values(
        ids.map((id) => ({
          id,
          workspaceId: ana.workspaceId,
          createdBy: ana.userId,
          accountUsername: `account-${id}`,
          suspended: false,
          repoScope: "all" as const,
        })),
      );
      const remove = (id: string) =>
        call(anaPerson, "DELETE", `${ws(ana.workspaceId)}/github-app/installations/${id}`);
      // 808 uninstalls, 707 GitHub refuses, 606 GitHub no longer knows (it is gone there already).
      const answers = [];
      for (const id of ids) {
        const res = await remove(id);
        answers.push([id, res.status, res.body]);
      }
      expect(answers).toEqual([
        ["808", 200, { uninstalledOnGitHub: true }],
        ["707", 200, { uninstalledOnGitHub: false }],
        ["606", 200, { uninstalledOnGitHub: true }],
      ]);
      const left = await server.deps.db
        .select({ id: schema.githubInstallations.id })
        .from(schema.githubInstallations)
        .where(eq(schema.githubInstallations.workspaceId, ana.workspaceId));
      expect(left.map((r) => r.id).filter((id) => ids.includes(id))).toEqual([]);
    },
    SERVER_TEST_MS,
  );

  test("a restricted agent only reaches the repositories it names", () => {
    const allowed = ["acme/site", "tools/*"];
    expect(repoRefusal([], "search_code", { q: "x" })).toBeNull();
    expect(repoRefusal(allowed, "get_me", {})).toBeNull();
    expect(repoRefusal(allowed, "get_file_contents", { owner: "Acme", repo: "Site" })).toBeNull();
    expect(repoRefusal(allowed, "get_file_contents", { owner: "tools", repo: "cli" })).toBeNull();
    expect(repoRefusal(allowed, "search_code", { query: "repo:acme/site TODO" })).toBeNull();
    expect(repoRefusal(allowed, "search_code", { query: "TODO" })).toContain("Name one");
    expect(repoRefusal(allowed, "get_file_contents", { owner: "acme", repo: "secret" })).toContain(
      "acme/secret",
    );
    expect(repoRefusal(allowed, "search_code", { query: "-repo:acme/site TODO" })).toContain(
      "search operator",
    );
    expect(repoRefusal(allowed, "search_code", { query: "org:acme TODO" })).toContain("acme/*");
    expect(repoRefusal(allowed, "get_file_contents", { owner: "acme/site", repo: "x" })).toContain(
      "acme/site/x",
    );
    expect(repoRefusal(allowed, "search_code", { query: "TOPSECRET", repo: "acme/site" })).not.toBeNull();
    expect(
      repoRefusal(allowed, "issue_write", {
        owner: "acme",
        repo: "site",
        parent_owner: "victim",
        parent_repo: "private",
        parent_issue_number: 1,
      }),
    ).toContain("victim/private");
    expect(repoRefusal(allowed, "fork_repository", { owner: "acme", repo: "site" })).not.toBeNull();
  });

  test("restricted issue reads only permit methods confined to the named repository", () => {
    const args = { owner: "acme", repo: "site", issue_number: 1 };
    for (const method of ["get", "get_sub_issues", "get_parent"])
      expect(repoRefusal(["acme/site"], "issue_read", { ...args, method })).not.toBeNull();
    for (const method of ["get_comments", "get_labels"])
      expect(repoRefusal(["acme/site"], "issue_read", { ...args, method })).toBeNull();
    expect(repoRefusal([], "issue_read", { ...args, method: "get_parent" })).toBeNull();
  });
});
