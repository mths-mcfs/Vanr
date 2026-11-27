// The installation's GitHub App: the workspace installs the app on a GitHub account and the agents work in the
// repositories the app sees (the runners' git proxy uses the installation token).
// Without GITHUB_APP_* in the config, `installable` is false and nothing here runs.
import { createSign } from "node:crypto";
import type { GitHubAppInstallation, GitHubRepositories } from "@vanr/contract";
import { schema } from "@vanr/engine/db";
import { PRODUCT } from "@vanr/product";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { AppDeps } from "../context";
import { HttpError, notFound } from "../http";
import { log } from "../logger";
import { backTo, type Starter, saveState, takeState, type Viewer } from "./connectors";
import { outsideText } from "./outside-text";

const { githubInstallations } = schema;
type InstallationRow = typeof githubInstallations.$inferSelect;
type AppConfig = NonNullable<AppDeps["config"]["integrations"]["githubApp"]>;

/** Tools of the GitHub connector that touch no repository (they pass even with a restriction). */
const REPO_FREE_TOOLS = new Set(["get_me"]);

// These tools consume owner/repo directly. Unknown tools and implicit destinations are refused.
const REPO_TOOLS = new Set([
  "get_file_contents",
  "get_commit",
  "list_commits",
  "list_branches",
  "create_branch",
  "list_tags",
  "get_tag",
  "list_releases",
  "get_latest_release",
  "get_release_by_tag",
  "list_pull_requests",
  "pull_request_read",
  "issue_read",
  "issue_write",
  "add_issue_comment",
  "create_or_update_file",
  "push_files",
  "delete_file",
]);
const SEARCH_TOOLS = new Set(["search_code", "search_issues", "search_pull_requests"]);
const repoArgs = z.object({ owner: z.string().min(1), repo: z.string().min(1) });

function repoTargets(tool: string, args: Record<string, unknown>): string[] {
  // Issue details also enrich the response with parent and closing-PR references from other repositories.
  if (tool === "issue_read" && args.method !== "get_comments" && args.method !== "get_labels")
    return ["(issue relations may cross repositories)"];
  if (REPO_TOOLS.has(tool)) {
    const parsed = repoArgs.safeParse(args);
    if (!parsed.success) return [];
    const out = [`${parsed.data.owner}/${parsed.data.repo}`];
    if (tool === "issue_write" && (args.parent_owner !== undefined || args.parent_repo !== undefined)) {
      const parent = repoArgs.safeParse({ owner: args.parent_owner, repo: args.parent_repo });
      out.push(parent.success ? `${parent.data.owner}/${parent.data.repo}` : "(invalid parent repository)");
    }
    return out;
  }
  if (!SEARCH_TOOLS.has(tool) || typeof args.query !== "string") return [];
  const out = new Set<string>();
  // Quoted or boolean expressions can turn a qualifier into text or widen its scope.
  if (/[()"\\]/.test(args.query)) return ["(search operator)"];
  for (const token of args.query.split(/\s+/)) {
    if (/^(NOT|OR|AND)$/.test(token) || /^-(repo|org|user):/i.test(token)) {
      out.add(`(search operator ${token})`);
      continue;
    }
    const m = /^(repo|org|user):(.+)$/i.exec(token);
    if (m?.[2]) out.add(m[1]?.toLowerCase() === "repo" ? m[2] : `${m[2]}/*`);
  }
  return [...out];
}

/**
 * The agent's repository restriction applied to a call of the GitHub connector. With an empty list, everything
 * passes. With a list, the call has to name only allowed repositories; a call that names none (a loose search,
 * listing the owner's) is rejected, because it would reach the others.
 * Returns the reason for the rejection or null.
 */
export function repoRefusal(
  patterns: readonly string[],
  tool: string,
  args: Record<string, unknown>,
): string | null {
  if (patterns.length === 0 || REPO_FREE_TOOLS.has(tool)) return null;
  const allowed = patterns.join(", ");
  const targets = repoTargets(tool, args);
  if (targets.length === 0)
    return `This agent can only use these GitHub repositories: ${allowed}. Name one (owner and repo).`;
  const blocked = targets.filter((t) => !isRepoPattern(t) || !repoAllowed(patterns, t));
  if (blocked.length) return `This agent can't use ${blocked.join(", ")} on GitHub. Allowed: ${allowed}.`;
  return null;
}

const STATE_TTL_MS = 30 * 60_000;
const REPO = /^[A-Za-z0-9_.-]{1,100}\/([A-Za-z0-9_.-]{1,100}|\*)$/;

export const isRepoPattern = (s: string) => REPO.test(s);

export const toInstallation = (row: InstallationRow): GitHubAppInstallation => ({
  id: row.id,
  accountUsername: row.accountUsername,
  suspended: row.suspended,
  repoScope: row.repoScope,
});

function appConfig(deps: AppDeps): AppConfig {
  const cfg = deps.config.integrations.githubApp;
  if (!cfg)
    throw new HttpError(400, "github_app.not_configured", "The GitHub App is not set up on this server");
  return cfg;
}

const b64url = (v: string | Buffer) => Buffer.from(v).toString("base64url");

/** The app's JWT (RS256, 9 minutes; GitHub accepts up to 10). */
function appJwt(cfg: { appId: string; privateKey: string }, now: Date): string {
  const iat = Math.floor(now.getTime() / 1000) - 60;
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const body = b64url(JSON.stringify({ iat, exp: iat + 600, iss: cfg.appId }));
  const signature = createSign("RSA-SHA256").update(`${head}.${body}`).sign(cfg.privateKey);
  return `${head}.${body}.${b64url(signature)}`;
}

async function githubJson<T>(
  deps: AppDeps,
  cfg: AppConfig,
  path: string,
  init: { method?: string; token: string },
  parse: z.ZodType<T>,
): Promise<T> {
  let res: Response;
  try {
    res = await deps.fetchExternal(`${cfg.apiUrl}${path}`, {
      method: init.method ?? "GET",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${init.token}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": PRODUCT.slug,
      },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new HttpError(502, "github.unreachable", "Could not reach GitHub");
  }
  if (res.status === 404) throw notFound("GitHub installation not found");
  if (!res.ok) throw new HttpError(502, "github.error", `GitHub answered ${res.status}`);
  if (res.status === 204) return parse.parse(undefined);
  const parsed = parse.safeParse(await res.json().catch(() => null));
  if (!parsed.success) throw new HttpError(502, "github.error", "Unexpected answer from GitHub");
  return parsed.data;
}

const installationInfo = z.object({
  id: z.number(),
  account: z
    .object({ id: z.number().int(), login: z.string(), type: z.enum(["User", "Organization"]) })
    .nullable(),
  repository_selection: z.enum(["all", "selected"]),
  suspended_at: z.string().nullable().optional(),
});

/** Installation token (1 hour). */
async function installationToken(deps: AppDeps, installationId: string): Promise<string> {
  const cfg = appConfig(deps);
  const out = await githubJson(
    deps,
    cfg,
    `/app/installations/${encodeURIComponent(installationId)}/access_tokens`,
    { method: "POST", token: appJwt(cfg, deps.now()) },
    z.object({ token: z.string() }),
  );
  return out.token;
}

export async function installations(deps: AppDeps, workspaceId: string): Promise<InstallationRow[]> {
  return deps.db
    .select()
    .from(githubInstallations)
    .where(eq(githubInstallations.workspaceId, workspaceId))
    .orderBy(githubInstallations.createdAt);
}

/** The App's OAuth client, without which an installation can't be verified (and so not started). */
function oauthClientOf(cfg: AppConfig) {
  if (!cfg.oauthClient)
    throw new HttpError(400, "github_app.not_configured", "The GitHub App is not set up on this server");
  return cfg.oauthClient;
}

const userToken = z.object({ access_token: z.string().min(1) });
const userInstallations = z.object({
  total_count: z.number().int().min(0),
  installations: z.array(installationInfo),
});

/**
 * Proves the person who came back controls the installation: the `code` GitHub sends with the installation
 * becomes a user token. Visibility alone is insufficient: require the personal account owner or an active
 * organization owner. The token is only used here and then dropped.
 */
async function controlsInstallation(
  deps: AppDeps,
  cfg: AppConfig,
  code: string,
  installationId: number,
): Promise<boolean> {
  const client = oauthClientOf(cfg);
  let token: string;
  try {
    const res = await deps.fetchExternal(`${cfg.webUrl}/login/oauth/access_token`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json", "user-agent": PRODUCT.slug },
      body: JSON.stringify({ client_id: client.clientId, client_secret: client.clientSecret, code }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return false;
    const parsed = userToken.safeParse(await res.json().catch(() => null));
    if (!parsed.success) return false;
    token = parsed.data.access_token;
  } catch {
    return false;
  }
  for (let page = 1; page <= 10; page++) {
    const out = await githubJson(
      deps,
      cfg,
      `/user/installations?per_page=100&page=${page}`,
      { token },
      userInstallations,
    ).catch(() => null);
    if (!out) return false;
    const installation = out.installations.find((i) => i.id === installationId);
    if (installation) {
      const account = installation.account;
      if (!account) return false;
      if (account.type === "User") {
        const user = await githubJson(
          deps,
          cfg,
          "/user",
          { token },
          z.object({ id: z.number().int() }),
        ).catch(() => null);
        return user?.id === account.id;
      }
      const membership = await githubJson(
        deps,
        cfg,
        `/user/memberships/orgs/${encodeURIComponent(account.login)}`,
        { token },
        z.object({ state: z.string(), role: z.string() }),
      ).catch(() => null);
      return membership?.state === "active" && membership.role === "admin";
    }
    if (page * 100 >= out.total_count || out.installations.length < 100) return false;
  }
  return false;
}

export async function installUrl(deps: AppDeps, me: Starter, nextPath: string): Promise<string> {
  const cfg = appConfig(deps);
  oauthClientOf(cfg);
  const state = await saveState(deps, me, {
    kind: "github_app",
    targetId: null,
    nextPath,
    ttlMs: STATE_TTL_MS,
  });
  return `${cfg.webUrl}/apps/${encodeURIComponent(cfg.slug)}/installations/new?state=${state}`;
}

/**
 * The return from the installation (the app's Setup URL). The state binds it to the workspace, to whoever
 * started and to that session. Ownership of the account or organization is checked before reading with the
 * app's JWT. Without that proof nothing is kept (`github_app=unverified`). An installation belongs to a single workspace: the upsert only updates the
 * row of the same workspace, in one statement.
 */
export async function finishInstall(
  deps: AppDeps,
  viewer: Viewer,
  query: { installation_id?: string; setup_action?: string; state?: string; code?: string },
): Promise<string> {
  const taken = await takeState(deps, "github_app", query.state, viewer);
  if (!taken.row) return "/?github_app=error";
  const st = taken.row;
  const back = (p: string) => backTo(st, p);
  if (!taken.ok) return back("github_app=error");
  if (!query.installation_id || !/^\d{1,20}$/.test(query.installation_id)) return back("github_app=error");
  const cfg = appConfig(deps);
  const installationId = Number(query.installation_id);
  if (!cfg.oauthClient || !query.code || !(await controlsInstallation(deps, cfg, query.code, installationId)))
    return back("github_app=unverified");
  try {
    const info = await githubJson(
      deps,
      cfg,
      `/app/installations/${query.installation_id}`,
      { token: appJwt(cfg, deps.now()) },
      installationInfo,
    );
    const values = {
      accountUsername: info.account?.login ?? "",
      suspended: !!info.suspended_at,
      repoScope: info.repository_selection,
    };
    const saved = await deps.db
      .insert(githubInstallations)
      .values({ id: String(info.id), workspaceId: st.workspaceId, createdBy: viewer.userId, ...values })
      .onConflictDoUpdate({
        target: githubInstallations.id,
        set: values,
        setWhere: eq(githubInstallations.workspaceId, st.workspaceId),
      })
      .returning({ id: githubInstallations.id });
    if (saved.length === 0) return back("github_app=taken");
  } catch (err) {
    log.warn("github_app.install_failed", { error: outsideText(err, [cfg.oauthClient?.clientSecret]) });
    return back("github_app=error");
  }
  return back("github_app=installed");
}

/** Uninstalls on GitHub (best effort) and takes it out of the workspace. */
export async function removeInstallation(deps: AppDeps, workspaceId: string, id: string) {
  const [row] = await deps.db
    .select()
    .from(githubInstallations)
    .where(and(eq(githubInstallations.workspaceId, workspaceId), eq(githubInstallations.id, id)));
  if (!row) throw notFound("Installation not found");
  const cfg = deps.config.integrations.githubApp;
  if (cfg) {
    await githubJson(
      deps,
      cfg,
      `/app/installations/${encodeURIComponent(id)}`,
      { method: "DELETE", token: appJwt(cfg, deps.now()) },
      z.unknown(),
    ).catch((err) => log.warn("github_app.uninstall_failed", { error: outsideText(err, []), id }));
  }
  await deps.db
    .delete(githubInstallations)
    .where(and(eq(githubInstallations.workspaceId, workspaceId), eq(githubInstallations.id, id)));
}

const repoPage = z.object({
  total_count: z.number(),
  repositories: z.array(z.object({ full_name: z.string(), private: z.boolean() })),
});

/** Repositories of each installation (up to 500 per account). */
export async function repositoriesOf(deps: AppDeps, workspaceId: string): Promise<GitHubRepositories> {
  const rows = await installations(deps, workspaceId);
  const cfg = deps.config.integrations.githubApp;
  if (!cfg || rows.length === 0) return { connected: false, accounts: [] };
  const accounts: GitHubRepositories["accounts"] = [];
  for (const row of rows) {
    if (row.suspended) {
      accounts.push({ login: row.accountUsername, repositories: [] });
      continue;
    }
    const token = await installationToken(deps, row.id);
    const repositories: { fullName: string; private: boolean }[] = [];
    for (let page = 1; page <= 5; page++) {
      const out = await githubJson(
        deps,
        cfg,
        `/installation/repositories?per_page=100&page=${page}`,
        { token },
        repoPage,
      );
      repositories.push(...out.repositories.map((r) => ({ fullName: r.full_name, private: r.private })));
      if (repositories.length >= out.total_count || out.repositories.length < 100) break;
    }
    accounts.push({ login: row.accountUsername, repositories });
  }
  return { connected: true, accounts };
}

/** Is the repository `owner/repo` allowed for the agent? An empty list allows all. */
function repoAllowed(patterns: readonly string[], fullName: string): boolean {
  if (patterns.length === 0) return true;
  const [owner] = fullName.toLowerCase().split("/");
  return patterns.some((p) => {
    const lower = p.toLowerCase();
    return lower === fullName.toLowerCase() || lower === `${owner}/*`;
  });
}
