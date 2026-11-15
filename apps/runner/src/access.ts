// What each agent may touch in this environment. A relative path stays in the agent's folder inside the
// work folder; an absolute path only counts inside a folder allowed for it. A symlink is resolved before
// deciding, and system folders can never be allowed.
import { type Dirent, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { RunnerAccess } from "@vanr/contract";
import type { AgentRef, RunnerErrorCode, RunnerTool } from "@vanr/engine/runner-protocol";

export class RunnerError extends Error {
  constructor(
    readonly code: RunnerErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export const LIMITS = { folders: 100, agentsPerFolder: 100, path: 1024 } as const;

const EXACT_REJECTED = [
  "/",
  "/Users",
  "/home",
  "/Volumes",
  "/private",
  "/var",
  "/opt",
  "/mnt",
  "/media",
  "/root",
];
const TREE_REJECTED = [
  "/System",
  "/Library",
  "/usr",
  "/bin",
  "/sbin",
  "/etc",
  "/dev",
  "/proc",
  "/sys",
  "/boot",
  "/Applications",
  "/private/etc",
  "/private/var/db",
  "/cores",
];

export const inside = (child: string, parent: string) => {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

/**
 * Escalation paths (F5-3.3-P0-04): files that another program runs or reads as configuration
 * outside the sandbox. Writing them would give the agent a command running as the person (git hook,
 * the project's MCP server, shell rc, Claude Code and Codex hooks and commands). They apply at any
 * depth, inside any folder the agent may write.
 */
const PROTECTED_FILES = [
  ".bashrc",
  ".bash_profile",
  ".bash_login",
  ".bash_logout",
  ".zshrc",
  ".zprofile",
  ".zshenv",
  ".zlogin",
  ".profile",
  ".envrc",
  ".gitconfig",
  ".gitmodules",
  ".ripgreprc",
  ".npmrc",
  ".mcp.json",
] as const;
const PROTECTED_DIRS = [".vscode", ".idea", ".claude", ".codex", ".cursor", ".husky"] as const;
/**
 * Inside `.git`: hooks and config run outside the sandbox; `config.worktree` and `commondir` lead git to
 * another config; `modules` and `worktrees` hold the `.git` of the submodules and of the other working copies
 * (with their own hooks and config). The rest (objects, refs, index) is git's normal work.
 */
const PROTECTED_GIT = ["hooks", "config", "config.worktree", "commondir", "modules", "worktrees"] as const;
/**
 * The ones the sandbox denies even when they do not exist (an empty read-only file or folder takes their place). The
 * others only when they exist: an empty `commondir` in place breaks git ("failed to read commondir").
 */
const GIT_ALWAYS = new Set<string>(["hooks", "config"]);

/**
 * Rejection reason if the path is an escalation one; `null` if it may be written. It is the same rule the
 * sandbox applies (`protectedUnder`): the file ops and the commands reject the same paths. `wholeGit` are the
 * folders the person allowed: there the whole `.git` of a repository is read-only, index and HEAD included.
 */
export function protectedPath(path: string, wholeGit: readonly string[] = []): string | null {
  const full = resolve(path);
  const parts = full.split(sep).filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i] as string;
    const last = i === parts.length - 1;
    if (last && (PROTECTED_FILES as readonly string[]).includes(part)) return part;
    // A `.git` file tells git where the repository of that folder is (submodule, worktree).
    if (last && part === ".git") return part;
    if ((PROTECTED_DIRS as readonly string[]).includes(part)) return part;
    if (part === ".git" && (PROTECTED_GIT as readonly string[]).includes(parts[i + 1] ?? ""))
      return `.git/${parts[i + 1]}`;
    if (part === ".git" && wholeGit.some((w) => inside(full, w))) return ".git";
  }
  return null;
}

/** Entries the scan reads in each writable folder before giving up on it. */
export const WALK_MAX = 100_000;
/** Package folders the manager builds without `.git`: they stay out of the scan. */
const WALK_SKIP = new Set(["node_modules", ".venv", "venv"]);

const protectedAt = (dir: string) => [
  ...PROTECTED_FILES.map((f) => join(dir, f)),
  ...PROTECTED_DIRS.map((d) => join(dir, d)),
  ...PROTECTED_GIT.filter((g) => GIT_ALWAYS.has(g) || existsSync(join(dir, ".git", g))).map((g) =>
    join(dir, ".git", g),
  ),
];

export interface ProtectedScan {
  /** Paths for the sandbox's `denyWrite`. */
  paths: string[];
  /** Folders with more than `WALK_MAX` entries: they could not be checked, so they stay read-only. */
  unchecked: string[];
}

/**
 * The same rules as a list of paths for the sandbox's `denyWrite`: at the root of each folder, the ones that
 * exist and the ones that do not exist yet; below it, at any depth, each git repository
 * found gets the same list, each `.git` file goes in whole and each protected file or folder that already
 * exists goes in too. In the `wholeGit` folders (the ones the person allowed, where their repositories
 * are) the whole `.git` stays read-only: with a writable index the agent would register a submodule
 * pointing to a `.git` of its own, and the person's `git status` would read that `.git`'s config. The count of
 * entries is per folder: filling one does not hide the others. A folder past `WALK_MAX` goes in whole (it stays
 * read-only): locking the writes is better than leaving a hook unchecked. A repository created
 * by the command itself (`git init`) is not on the list: the sandbox sets up the rules before the command runs.
 */
export function protectedUnder(
  roots: string[],
  wholeGit: readonly string[] = [],
  max = WALK_MAX,
): ProtectedScan {
  const out = new Set<string>();
  const unchecked: string[] = [];
  for (const root of roots) {
    const whole = wholeGit.some((w) => inside(root, w));
    for (const p of protectedAt(root)) out.add(p);
    const queue = [root];
    let seen = 0;
    for (let i = 0; i < queue.length; i++) {
      const dir = queue[i] as string;
      let entries: Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      seen += entries.length;
      if (seen > max) {
        unchecked.push(root);
        out.add(root);
        break;
      }
      for (const e of entries) {
        const full = join(dir, e.name);
        if (e.name === ".git") {
          if (e.isDirectory()) for (const p of protectedAt(dir)) out.add(p);
          if (!e.isDirectory() || whole) out.add(full);
        } else if ((PROTECTED_FILES as readonly string[]).includes(e.name)) out.add(full);
        else if ((PROTECTED_DIRS as readonly string[]).includes(e.name)) out.add(full);
        else if (e.isDirectory() && !e.isSymbolicLink() && !WALK_SKIP.has(e.name)) queue.push(full);
      }
    }
  }
  return { paths: [...out], unchecked };
}

/** Root, the whole home or a system folder. */
function systemFolder(p: string): "too_broad" | "system" | null {
  if (EXACT_REJECTED.includes(p) || p === resolve(homedir())) return "too_broad";
  if (TREE_REJECTED.some((t) => inside(p, t))) return "system";
  return null;
}

/**
 * A folder that cannot be allowed: root, the whole home, the system, the runner's, or one that contains the
 * work folder. Both the written and the real path count: a symlink to /etc is /etc.
 */
export function rejectedFolder(path: string, ctx: { runnerHome: string; workDir: string }): string | null {
  for (const p of new Set([resolve(path), real(path)])) {
    const system = systemFolder(p);
    if (system) return system;
    const home = resolve(ctx.runnerHome);
    if (inside(p, home) || inside(home, p)) return "runner";
    // The work folder by its written and its real path too (a work folder that is a link is its target).
    if (inside(resolve(ctx.workDir), p) || inside(real(ctx.workDir), p)) return "contains_work_dir";
  }
  return null;
}

/** Real path (follows symlinks); if it does not exist yet, resolves the part that exists. */
export function real(path: string): string {
  let cur = resolve(path);
  const rest: string[] = [];
  while (!existsSync(cur)) {
    if (lstatSync(cur, { throwIfNoEntry: false })?.isSymbolicLink())
      throw new RunnerError("not_allowed", "A broken symlink cannot be resolved");
    const parent = dirname(cur);
    if (parent === cur) break;
    rest.unshift(cur.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
    cur = parent;
  }
  return join(realpathSync(cur), ...rest);
}

export class Access {
  constructor(private readonly get: () => { access: RunnerAccess; workDir: string; paused: boolean }) {}

  get access(): RunnerAccess {
    return this.get().access;
  }

  /**
   * The agent's folder in the work folder (created the first time), by its real path: the one root every op
   * starts from (the ops on files, the secret files, the sandbox's folders, the jobs). A work folder that is a
   * link is the person's choice, and its target is the work folder; a link that leads nowhere fails here.
   */
  agentRoot(agent: AgentRef | null, workDir = this.get().workDir): string {
    if (agent && [agent.handle, agent.id].some((v) => !/^[a-zA-Z0-9_-]+$/.test(v)))
      throw new RunnerError("bad_request", "Invalid agent identity");
    const ws = resolve(workDir);
    const root = agent ? join(ws, `${agent.handle}-${agent.id.slice(-8)}`) : ws;
    if (!inside(real(root), real(ws)))
      throw new RunnerError("outside_work_dir", "Agent folder leaves the work folder");
    try {
      mkdirSync(root, { recursive: true, mode: 0o700 });
      const resolved = realpathSync(root);
      if (!inside(resolved, realpathSync(ws)))
        throw new RunnerError("outside_work_dir", "Agent folder leaves the work folder");
      return resolved;
    } catch (err) {
      const code = err instanceof Error && "code" in err ? String(err.code) : "error";
      throw new RunnerError("not_found", `The work folder is not there (${code})`);
    }
  }

  /**
   * Folders allowed for the agent, already by their real path. A folder that became a symlink to the system
   * after it was allowed stops counting.
   */
  foldersFor(agent: AgentRef | null): string[] {
    return this.access.folders
      .filter((f) => f.agents.length === 0 || (agent !== null && f.agents.includes(agent.id)))
      .map((f) => real(f.path))
      .filter((f) => !systemFolder(f));
  }

  requireTool(tool: RunnerTool): void {
    if (this.get().paused) throw new RunnerError("paused", "This environment is paused");
    if (!this.access.tools[tool])
      throw new RunnerError(
        tool === "commands" ? "exec_disabled" : "not_allowed",
        `The ${tool} tool is turned off in this environment`,
      );
  }

  requireActive(): void {
    if (this.get().paused) throw new RunnerError("paused", "This environment is paused");
  }

  /** Resolves a path the agent asked for into an allowed real path. */
  resolve(agent: AgentRef | null, path: string): string {
    if (path.length > LIMITS.path) throw new RunnerError("bad_request", "Path too long");
    const root = this.agentRoot(agent);
    if (!isAbsolute(path)) {
      const cleaned = path.replace(/^\/?workspace\//, "");
      const target = resolve(root, cleaned);
      if (!inside(target, root)) throw new RunnerError("outside_work_dir", "Path leaves the agent folder");
      const r = real(target);
      if (!inside(r, real(root)) && !this.foldersFor(agent).some((f) => inside(r, f)))
        throw new RunnerError("outside_work_dir", "Path leaves the agent folder");
      return r;
    }
    const r = real(path);
    if (inside(r, real(root))) return r;
    if (this.foldersFor(agent).some((f) => inside(r, f))) return r;
    throw new RunnerError("not_allowed", `${path} is not in a folder this agent can use`);
  }
}
