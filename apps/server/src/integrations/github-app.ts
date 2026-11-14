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

const { githubInstallations } = schema;
type InstallationRow = typeof githubInstallations.$inferSelect;
type AppConfig = NonNullable<AppDeps["config"]["integrations"]["githubApp"]>;

/** Tools of the GitHub connector that touch no repository (they pass even with a restriction). */
const REPO_FREE_TOOLS = new Set(["get_me"]);

/**
 * Repositories a GitHub tool call names: `owner` + `repo`, a full name in `repository`/`full_name`/`repo`
 * ("owner/repo") and the `repo:owner/repo` qualifiers of a search. `org:` and `user:` in a search open all
 * the owner's repositories: they become `owner/*`.
 * A search with an operator (`NOT`, `OR`, parentheses) or a negated qualifier (`-repo:`) isn't held to the
 * repositories it names (`-repo:a/b` searches all the others): it goes in as an invalid target, and the call is
 * rejected. `owner` and `repo` always join, so an extra slash (`owner: "a/b/c"`) falls into the format check.
 */
function repoTargets(args: Record<string, unknown>): string[] {
  const out = new Set<string>();
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const owner = str(args.owner);
  const repo = str(args.repo);
  if (owner && repo) out.add(`${owner}/${repo}`);
  else if (repo) out.add(repo);
  else if (owner) out.add(`${owner}/*`);
  for (const key of ["repository", "full_name", "repo_full_name", "repository_full_name"]) {
    const v = str(args[key]);
    if (v) out.add(v);
  }
  for (const key of ["q", "query"]) {
    for (const token of str(args[key]).split(/\s+/)) {
      if (!token) continue;
      if (/^(NOT|OR|AND)$/.test(token) || /[()]/.test(token) || /^-(repo|org|user):/i.test(token)) {
        out.add(`(search operator ${token})`);
        continue;
      }
      const m = /^(repo|org|user):(.+)$/i.exec(token);
      if (!m?.[2]) continue;
      out.add(m[1]?.toLowerCase() === "repo" ? m[2] : `${m[2]}/*`);
    }
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
  const targets = repoTargets(args);
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
  account: z.object({ login: z.string() }).nullable(),
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

export async function installUrl(deps: AppDeps, me: Starter, nextPath: string): Promise<string> {
  const cfg = appConfig(deps);
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
 * started and to that session; the installation is checked on GitHub's API with the app's JWT. An installation
 * belongs to a single workspace: the upsert only updates the row of the same workspace, in one statement.
 */
export async function finishInstall(
  deps: AppDeps,
  viewer: Viewer,
  query: { installation_id?: string; setup_action?: string; state?: string },
): Promise<string> {
  const taken = await takeState(deps, "github_app", query.state, viewer);
  if (!taken.row) return "/?github_app=error";
  const st = taken.row;
  const back = (p: string) => backTo(st, p);
  if (!taken.ok) return back("github_app=error");
  if (!query.installation_id || !/^\d{1,20}$/.test(query.installation_id)) return back("github_app=error");
  const cfg = appConfig(deps);
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
    log.warn("github_app.install_failed", { err });
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
    ).catch((err) => log.warn("github_app.uninstall_failed", { err, id }));
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
