// Sandbox of the processes the runner starts for the agents (F5-3.3-P0-02 and P0-03): a command (`exec`),
// a job (`job.start`) and a harness (`harness.turn`) run inside `srt` (Anthropic's sandbox-runtime:
// bubblewrap on Linux, Seatbelt on macOS). The whole home becomes unreadable; only the agent's folder comes back,
// plus the folders allowed for it and what the process needs to start (binaries, the Claude Code or
// Codex login). Writes only in the agent's folders, minus the escalation paths. The runner folder (token,
// secrets) never comes back. Network only through the `srt` proxy: each process carries its list of domains, and
// what the proxy blocks comes back in the result (it becomes a new domain request on the server).
//
// `srt` is a single object per process; the file policy goes per call and the domain policy by a random id
// of each process (the proxy recognizes the process by the proxy user). With no sandbox
// available, the runner does not start the process, unless the person turned the sandbox off in this
// environment (`sandbox off` in the CLI).
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { existsSync, linkSync, mkdirSync, realpathSync, renameSync, rmSync, statSync } from "node:fs";
import { isIP } from "node:net";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import type { RunnerSandbox } from "@vanr/contract";
import type { AgentRef } from "@vanr/engine/runner-protocol";
import { PRODUCT } from "@vanr/product";
import { inside, protectedUnder, RunnerError } from "./access";
import { which } from "./jobs";

export type NetworkMode = "off" | "allowlist" | "open";
export interface FsPolicy {
  denyRead: string[];
  allowRead: string[];
  allowWrite: string[];
  denyWrite: string[];
}

export interface WrapInput {
  command: string;
  fs: FsPolicy;
  /** The process's domains (already with the CLI's, for Claude Code or Codex). */
  domains: string[];
  /** This process's network mode; it lives and ends with the process (`open` allows what is not denied). */
  mode: NetworkMode;
  signal?: AbortSignal;
}

export interface Wrapped {
  /** Line for `/bin/sh -c`. */
  command: string;
  /** Writable folders too large to check: they stayed read-only in this process. */
  unchecked?: string[];
  /** Hosts the proxy blocked while the process ran. */
  blocked(): string[];
  /** Call it when the process ends (or never gets to start). */
  release(): void;
}

export interface CommandSandbox {
  status(): RunnerSandbox;
  wrap(input: WrapInput): Promise<Wrapped>;
  close(): Promise<void>;
}

function v4Private(ip: string): boolean {
  const [a = 0, b = 0] = ip.split(".").map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

/** The 8 16-bit groups of an IPv6 (accepts `::` and an IPv4 at the end). */
function v6Groups(ip: string): number[] | null {
  let text = ip.toLowerCase().replace(/%.*$/, "");
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(text)?.[1];
  if (v4) {
    const [a = 0, b = 0, c = 0, d = 0] = v4.split(".").map(Number);
    text = `${text.slice(0, -v4.length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = "", tail] = text.split("::");
  const part = (s: string) => (s ? s.split(":").map((g) => Number.parseInt(g, 16)) : []);
  const left = part(head);
  const right = tail === undefined ? [] : part(tail);
  const zeros = 8 - left.length - right.length;
  if (tail === undefined ? zeros !== 0 : zeros < 0) return null;
  const groups = [...left, ...Array<number>(zeros).fill(0), ...right];
  return groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

const v4Of = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;

/**
 * Loopback, private network, link-local, multicast. For IPv6 the embedded IPv4 counts too (mapped,
 * compatible, NAT64 `64:ff9b::/96` and 6to4 `2002::/16`), and an IPv6 that cannot be read counts as private.
 */
export function privateIp(ip: string): boolean {
  if (isIP(ip) === 4) return v4Private(ip);
  const g = v6Groups(ip);
  if (!g) return true;
  const [g0 = 0, g1 = 0, g2 = 0, , , g5 = 0, g6 = 0, g7 = 0] = g;
  const zeroTo = (n: number) => g.slice(0, n).every((x) => x === 0);
  if (zeroTo(5) && g5 === 0xffff) return v4Private(v4Of(g6, g7));
  if (zeroTo(6)) return true;
  if (g0 === 0x64 && g1 === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return v4Private(v4Of(g6, g7));
  if (g0 === 0x2002) return v4Private(v4Of(g1, g2));
  return (g0 & 0xfe00) === 0xfc00 || (g0 & 0xffc0) === 0xfe80 || (g0 & 0xff00) === 0xff00;
}

/**
 * A target on the person's own network: `localhost`, or a name that resolves to loopback or a private network
 * (including the forms the resolver accepts, like `2130706433` for 127.0.0.1). Not even the workspace's open network
 * gets there: those would be the Docker, databases and development servers of the host. A name that does not resolve
 * stays out too. It resolves here and the proxy resolves again when connecting: a DNS that changes its answer
 * between the two gets through.
 */
export async function privateDestination(host: string): Promise<boolean> {
  const bare = host
    .replace(/^\[|\]$/g, "")
    .toLowerCase()
    .replace(/\.$/, "");
  if (bare === "localhost" || bare.endsWith(".localhost")) return true;
  try {
    const ips = (await lookup(bare, { all: true })).map((a) => a.address);
    return ips.length === 0 || ips.some(privateIp);
  } catch {
    return true;
  }
}

/** Addresses not even the open network reaches: cloud metadata. */
const DENIED_DOMAINS = ["169.254.169.254", "metadata.google.internal", "metadata.goog"];

/**
 * Private ranges a name may not resolve to, in any mode: RFC 1918, CGNAT and IPv6 ULA. The proxy checks the
 * address it is about to dial (the same one, with no second lookup), so an allowed name whose DNS points at
 * the person's network does not get there. Loopback, link-local, multicast and the host's own addresses are
 * denied by the sandbox itself.
 */
export const DENIED_RESOLVED_ADDRESSES = [
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "100.64.0.0/10",
  "fc00::/7",
];

/**
 * The network mode of each live process, by its sandbox id. The proxy asks about a host that no list allowed
 * without saying which process the connection belongs to, so an unlisted host is allowed only while every
 * live process is in `open` mode: a process in `allowlist` or `off` is never widened by an open one running
 * next to it, and a mode ends with its process (nothing carries over to the next one).
 */
export class NetworkModes {
  private readonly live = new Map<string, NetworkMode>();
  add(id: string, mode: NetworkMode): void {
    this.live.set(id, mode);
  }
  remove(id: string): void {
    this.live.delete(id);
  }
  /** Whether a host that no list allowed may go through. */
  unlistedAllowed(): boolean {
    if (this.live.size === 0) return false;
    for (const mode of this.live.values()) if (mode !== "open") return false;
    return true;
  }
}

/** Domains the CLI itself uses to think (the plan login and the API). */
export const CLI_DOMAINS: Record<"claude_code" | "codex", string[]> = {
  claude_code: [
    "api.anthropic.com",
    "*.anthropic.com",
    "claude.ai",
    "*.claude.ai",
    "claude.com",
    "*.claude.com",
  ],
  codex: ["chatgpt.com", "*.chatgpt.com", "openai.com", "*.openai.com"],
};

/** Known Unix sockets outside the home: the user bus, Docker, X11, key agents. */
const SOCKET_DIRS = (uid: number) => [
  `/run/user/${uid}`,
  "/var/run/docker.sock",
  "/run/docker.sock",
  "/run/dbus",
  "/var/run/dbus",
  "/run/snapd.socket",
  "/run/snapd-snap.socket",
  "/tmp/.X11-unix",
  "/tmp/.ICE-unix",
];

/** Path parts that never come back for reading, not even in PATH. */
const SENSITIVE = [".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker", ".password-store", ".netrc"];

/** Variables that point to sockets or agents of the person's session; they leave the process environment. */
export const SESSION_ENV = [
  "SSH_AUTH_SOCK",
  "SSH_AGENT_PID",
  "GPG_AGENT_INFO",
  "DBUS_SESSION_BUS_ADDRESS",
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XAUTHORITY",
  "XDG_RUNTIME_DIR",
  "DOCKER_HOST",
];

const HOME_ROOTS = ["/home", "/Users", "/root", "/var/root"];

export interface PolicyContext {
  /** Home of whoever runs the runner. */
  home: string;
  runnerHome: string;
  uid: number;
  /** The runner's PATH (its folders inside the home come back for reading, minus the sensitive ones). */
  path: string;
  /** The person's CLI folders when they moved them (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`); else under the home. */
  cliDirs?: Partial<Record<"claude_code" | "codex", string>>;
}

export const defaultPolicyContext = (runnerHome: string): PolicyContext => {
  const cliDirs: Partial<Record<"claude_code" | "codex", string>> = {};
  if (process.env.CLAUDE_CONFIG_DIR) cliDirs.claude_code = resolve(process.env.CLAUDE_CONFIG_DIR);
  if (process.env.CODEX_HOME) cliDirs.codex = resolve(process.env.CODEX_HOME);
  return {
    home: homedir(),
    runnerHome,
    uid: typeof process.getuid === "function" ? process.getuid() : 0,
    path: process.env.PATH ?? "",
    cliDirs,
  };
};

const existing = (paths: string[]) => [...new Set(paths.map((p) => resolve(p)))].filter((p) => existsSync(p));

function realOrSelf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

const sensitive = (p: string) => p.split("/").some((part) => SENSITIVE.includes(part));

/** PATH folders inside the home that may come back for reading (the person's binaries: nvm, bun, cargo). */
export function pathDirsInHome(ctx: PolicyContext): string[] {
  return ctx.path
    .split(delimiter)
    .filter(Boolean)
    .map((d) => realOrSelf(resolve(d)))
    .filter(
      (d) =>
        inside(d, ctx.home) &&
        d !== resolve(ctx.home) &&
        !inside(d, ctx.runnerHome) &&
        !inside(ctx.runnerHome, d) &&
        !sensitive(d),
    );
}

/** Claude Code folder with the conversations of a cwd (`/a/b.c` becomes `-a-b-c`). */
export const claudeProjectDir = (home: string, cwd: string) =>
  join(home, ".claude", "projects", resolve(cwd).replace(/[^a-zA-Z0-9]/g, "-"));

/**
 * What a CLI (Claude Code, Codex) needs to read and write to start with the login of whoever paired.
 * `ownCwd` is the process cwd when the folder belongs to the agent (its own in the work folder, the harness
 * work folder): only then the conversations folder of that cwd opens, for `--resume`. In a folder allowed by the
 * person, the conversations folder of the same path is theirs (with the memory that enters their sessions) and
 * stays closed; the agent's conversation there does not outlive the process. `ensure` are folders that must
 * exist before starting (the sandbox does not mount a path that does not exist).
 */
export function cliPaths(
  executor: "claude_code" | "codex",
  ctx: PolicyContext,
  bin: string | null,
  ownCwd: string | null,
): { read: string[]; write: string[]; denyRead: string[]; denyWrite: string[]; ensure: string[] } {
  const binDir = bin ? dirname(realOrSelf(bin)) : null;
  const read = binDir && !inside(binDir, ctx.runnerHome) ? [binDir] : [];
  if (executor === "claude_code") {
    const dir = join(ctx.home, ".claude");
    const own = ownCwd ? [claudeProjectDir(ctx.home, ownCwd)] : [];
    return {
      // `~/.claude.json` holds the person's MCP servers, which their Claude Code starts without asking:
      // the agent's process only reads it (Claude Code carries on without being able to save its state there).
      read: [...read, join(ctx.home, ".claude.json"), ...own],
      write: [dir, ...own],
      // What belongs to the person: conversations and memory of the other projects (the memory enters the context of
      // their sessions), history, shell environment, copies of files and of `.claude.json`.
      denyRead: [
        "projects",
        "history.jsonl",
        "sessions",
        "session-env",
        "shell-snapshots",
        "file-history",
        "paste-cache",
        "todos",
        "backups",
      ].map((f) => join(dir, f)),
      // Configuration the person's Claude Code runs later, outside any sandbox.
      denyWrite: [
        "settings.json",
        "settings.local.json",
        "hooks",
        "commands",
        "agents",
        "skills",
        "plugins",
        "output-styles",
        "CLAUDE.md",
        "keybindings.json",
      ].map((f) => join(dir, f)),
      ensure: existsSync(dir) ? own : [],
    };
  }
  const dir = join(ctx.home, ".codex");
  return {
    read,
    write: [dir],
    denyRead: [],
    denyWrite: ["config.toml", "AGENTS.md", "rules", "prompts", "skills", "hooks.json"].map((f) =>
      join(dir, f),
    ),
    ensure: [],
  };
}

/**
 * Where each CLI keeps the person's login, and the variable that moves its whole state (sessions, history,
 * memories, state databases, configuration) to another folder: Claude Code's `CLAUDE_CONFIG_DIR` and Codex's
 * `CODEX_HOME` (`codex exec --help`: "auth still uses CODEX_HOME").
 */
const CLI_STATE = {
  claude_code: { dir: ".claude", login: ".credentials.json", env: "CLAUDE_CONFIG_DIR", folder: "claude" },
  codex: { dir: ".codex", login: "auth.json", env: "CODEX_HOME", folder: "codex" },
} as const;

/** The person's own folder of a CLI. */
export const personalCliDir = (executor: "claude_code" | "codex", ctx: PolicyContext) =>
  ctx.cliDirs?.[executor] ?? join(ctx.home, CLI_STATE[executor].dir);

/**
 * The agent's own state of a CLI, in the runner folder: one per agent and CLI, so one agent neither reads
 * nor resumes another's sessions, and none of them sees the person's.
 */
export function agentCliStateDir(ctx: PolicyContext, agent: AgentRef, executor: "claude_code" | "codex") {
  if ([agent.handle, agent.id].some((v) => !/^[a-zA-Z0-9_-]+$/.test(v)))
    throw new RunnerError("bad_request", "Invalid agent identity");
  return join(
    resolve(ctx.runnerHome),
    "cli",
    `${agent.handle}-${agent.id.slice(-8)}`,
    CLI_STATE[executor].folder,
  );
}

/** Live sessions per login link: the link goes away with the last one. */
const loginUsers = new Map<string, number>();

/**
 * Puts the person's login file at `dest` as a hard link (the same file, not a copy), replacing what was there
 * by rename. The sandbox mounts that name read-only: the session reads the login and can neither write,
 * replace nor remove it, and the person's own file never opens to it.
 */
function linkLogin(source: string, dest: string): void {
  const tmp = `${dest}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    linkSync(source, tmp);
    renameSync(tmp, dest);
  } catch (err) {
    rmSync(tmp, { force: true });
    const code = err instanceof Error && "code" in err ? String(err.code) : "error";
    throw new RunnerError(
      "not_logged_in",
      code === "EXDEV"
        ? "The CLI login and the runner folder are on different disks, so agent sessions cannot read the login"
        : `The CLI login could not be opened for agent sessions (${code})`,
    );
  }
  loginUsers.set(dest, (loginUsers.get(dest) ?? 0) + 1);
}

function unlinkLogin(dest: string): void {
  const left = (loginUsers.get(dest) ?? 1) - 1;
  if (left > 0) {
    loginUsers.set(dest, left);
    return;
  }
  loginUsers.delete(dest);
  rmSync(dest, { force: true });
}

export interface AgentCli {
  /**
   * `own`: the agent's state in the runner folder, with the person's login read-only. `personal`: the login
   * is not in a file (the system keychain), so the CLI keeps reading the person's folder under `cliPaths`.
   */
  kind: "own" | "personal";
  read: string[];
  write: string[];
  denyRead: string[];
  denyWrite: string[];
  ensure: string[];
  /** Folders inside the runner folder the process writes (the agent's CLI state). */
  innerWrite: string[];
  /** Variables that point the CLI at its state. */
  env: Record<string, string>;
  /** Call it when the process ends (or never starts). */
  release(): void;
}

/**
 * What a CLI run by an agent opens in the sandbox. Its sessions, history, memories, state databases and
 * configuration live in the agent's own state (`agentCliStateDir`), where a session is also resumed from; the
 * person's CLI folder is not mounted at all, not even for reading. The person's login enters that state alone
 * and read-only, at the name the CLI looks for: a session never writes nor removes it, and if the CLI needs to
 * renew it the session ends asking the person to sign in again on this computer. Where the login is not a file
 * (the macOS keychain, a system keyring), the current rules stay (`cliPaths`).
 */
export function agentCli(
  executor: "claude_code" | "codex",
  ctx: PolicyContext,
  bin: string | null,
  agent: AgentRef,
  ownCwd: string | null,
  /** Without the sandbox (turned off by the person) the CLI runs as before, in the person's folder. */
  sandboxOn: boolean,
): AgentCli {
  const spec = CLI_STATE[executor];
  let source: string | null = null;
  if (sandboxOn)
    try {
      const real = realpathSync(join(personalCliDir(executor, ctx), spec.login));
      if (statSync(real).isFile()) source = real;
    } catch {
      source = null;
    }
  if (!source)
    return {
      kind: "personal",
      ...cliPaths(executor, ctx, bin, ownCwd),
      innerWrite: [],
      env: {},
      release: () => {},
    };
  const binDir = bin ? dirname(realOrSelf(bin)) : null;
  const state = agentCliStateDir(ctx, agent, executor);
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const login = join(state, spec.login);
  linkLogin(source, login);
  let released = false;
  return {
    kind: "own",
    read: binDir && !inside(binDir, ctx.runnerHome) ? [binDir] : [],
    write: [],
    denyRead: [],
    denyWrite: [login],
    ensure: [],
    innerWrite: [state],
    env: { [spec.env]: state },
    release: () => {
      if (released) return;
      released = true;
      unlinkLogin(login);
    },
  };
}

/**
 * File policy of an agent process. `readable` and `writable` are the agent's folders (and the
 * process's extra ones); everything under the home and the runner folder become unreadable, the session sockets
 * too, and the escalation paths become unwritable.
 */
export function fsPolicy(
  ctx: PolicyContext,
  input: {
    readable: string[];
    writable: string[];
    /** Folders allowed by the person: the `.git` of the repositories in them stays wholly read-only. */
    liberated?: string[];
    denyRead?: string[];
    denyWrite?: string[];
    /** Parts of the runner folder the harness uses (the turn folder, the MCP socket, the bundle). */
    runnerInner?: { read: string[]; write: string[] };
  },
): FsPolicy & { unchecked: string[] } {
  const runner = resolve(ctx.runnerHome);
  const keepOut = (p: string) => !inside(resolve(p), runner);
  const secretsOfRunner = runnerSecrets(runner);
  const inner = (p: string) => {
    const r = resolve(p);
    // Never the whole runner folder, nor anything that contains the token or the secrets.
    if (r === runner || !inside(r, runner) || secretsOfRunner.some((s) => inside(s, r)))
      throw new RunnerError("internal", `Refusing to open ${r} to an agent process`);
    return r;
  };
  const innerRead = (input.runnerInner?.read ?? []).map(inner);
  const innerWrite = (input.runnerInner?.write ?? []).map(inner);
  const writable = [...input.writable.filter(keepOut), ...innerWrite];
  const readable = [...input.readable.filter(keepOut), ...innerRead, ...writable, ...pathDirsInHome(ctx)];
  const scan = protectedUnder(input.writable.filter(keepOut), input.liberated ?? []);
  return {
    denyRead: existing([...HOME_ROOTS, ctx.home, runner, ...SOCKET_DIRS(ctx.uid), ...(input.denyRead ?? [])]),
    allowRead: [...new Set(readable.map((p) => resolve(p)))],
    allowWrite: [...new Set(writable.map((p) => resolve(p)))],
    denyWrite: [...new Set([...scan.paths, ...(input.denyWrite ?? []), ...secretsOfRunner])],
    unchecked: scan.unchecked,
  };
}

/** What, in the runner folder, never opens to an agent process. */
const runnerSecrets = (runner: string) =>
  ["config.json", "secrets", "jobs", "agents.json", "bin"].map((f) => join(runner, f));

/** Hosts in a proxy violation record (`deny network-outbound host:port (reason)`). */
export function blockedHost(line: string): string | null {
  const m = /^deny network-outbound (\S+):(\d+) /.exec(line);
  if (!m) return null;
  const host = (m[1] as string).replace(/^\[|\]$/g, "").toLowerCase();
  return host.length <= 253 ? host : null;
}

const SOCAT_ENV = `${PRODUCT.slug.toUpperCase()}_RUNNER_SOCAT`;
const BWRAP_ENV = `${PRODUCT.slug.toUpperCase()}_RUNNER_BWRAP`;

type SrtModule = typeof import("@anthropic-ai/sandbox-runtime");

export interface SandboxOptions {
  disabled: boolean;
  socatPath?: string | null;
  bwrapPath?: string | null;
  log?: (line: string) => void;
}

/** `srt` is one per process: every runner of this process (several, in the tests) uses the same one. */
let shared: Promise<SrtSandbox> | null = null;

/** Sandbox turned off by the person: runs as before, without isolation. */
export const sandboxOff = (): CommandSandbox => ({
  status: () => ({ state: "off", engine: null, reason: "Turned off in this environment" }),
  wrap: async () => {
    throw new RunnerError("sandbox_not_ready", "The sandbox is turned off");
  },
  close: async () => {},
});

/** The sandbox of this environment: turned off by the person, or the process's `srt`. */
export async function openSandbox(opts: SandboxOptions): Promise<CommandSandbox> {
  if (opts.disabled) return sandboxOff();
  shared ??= SrtSandbox.create(opts);
  return shared;
}

/** The real `srt`. */
class SrtSandbox implements CommandSandbox {
  private constructor(
    private readonly srt: SrtModule | null,
    private readonly state: RunnerSandbox,
    /** What the sandbox itself runs inside (the socat of the proxy bridge), if it is in the home. */
    private readonly ownRead: string[] = [],
  ) {}

  /** The mode of each live process (the proxy callback reads it). */
  readonly modes = new NetworkModes();

  static async create(opts: SandboxOptions): Promise<SrtSandbox> {
    const off = (state: "off" | "unavailable", reason: string) =>
      new SrtSandbox(null, { state, engine: null, reason });
    if (opts.disabled) return off("off", "Turned off in this environment");
    const linux = process.platform === "linux";
    if (!linux && process.platform !== "darwin")
      return off("unavailable", `No sandbox for ${process.platform} yet`);
    const socat = linux ? (opts.socatPath ?? process.env[SOCAT_ENV] ?? which("socat")) : null;
    const bwrap = linux ? (opts.bwrapPath ?? process.env[BWRAP_ENV] ?? which("bwrap")) : null;
    if (linux && !bwrap) return off("unavailable", "Install bubblewrap (bwrap) to run commands in a sandbox");
    if (linux && !socat) return off("unavailable", "Install socat to run commands in a sandbox");
    const failed = (err: unknown) =>
      off("unavailable", `The sandbox did not start: ${err instanceof Error ? err.message : String(err)}`);
    let srt: SrtModule;
    try {
      srt = await import("@anthropic-ai/sandbox-runtime");
    } catch (err) {
      return failed(err);
    }
    const sandbox = new SrtSandbox(
      srt,
      { state: "on", engine: linux ? "bubblewrap" : "seatbelt", reason: null },
      socat ? [dirname(realOrSelf(socat))] : [],
    );
    try {
      await srt.SandboxManager.initialize(
        {
          network: {
            allowedDomains: [],
            deniedDomains: DENIED_DOMAINS,
            deniedResolvedAddresses: DENIED_RESOLVED_ADDRESSES,
            // The harness talks to the runner over a Unix socket (MCP) and the option applies to the whole process:
            // the seccomp socket filter stays off and the session sockets leave by path.
            allowAllUnixSockets: true,
          },
          filesystem: { denyRead: [], allowRead: [], allowWrite: [], denyWrite: [] },
          ...(socat ? { socatPath: socat } : {}),
          ...(bwrap ? { bwrapPath: bwrap } : {}),
        },
        // No list decided: the workspace's open network allows it, except the person's own network; the rest
        // is denied and recorded.
        async ({ host }) => {
          if (!sandbox.modes.unlistedAllowed())
            return { allow: false, reason: "host is not on the allow list" };
          if (await privateDestination(host)) return { allow: false, reason: "private or loopback address" };
          return true;
        },
      );
      await sandbox.probe();
    } catch (err) {
      await srt.SandboxManager.reset().catch(() => {});
      return failed(err);
    }
    opts.log?.(`sandbox on (${sandbox.state.engine})`);
    return sandbox;
  }

  /** A `true` inside the sandbox: bubblewrap may exist and not start (AppArmor, namespaces). */
  private async probe(): Promise<void> {
    const w = await this.wrap({
      command: "true",
      fs: { denyRead: [], allowRead: [], allowWrite: [], denyWrite: [] },
      domains: [],
      mode: "off",
    });
    try {
      const r = await new Promise<{ code: number | null; err: string }>((done) => {
        const child = spawn("/bin/sh", ["-c", w.command], { stdio: ["ignore", "ignore", "pipe"] });
        let err = "";
        child.stderr.setEncoding("utf8").on("data", (s: string) => {
          err = (err + s).slice(-500);
        });
        const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
        child.on("error", (e) => {
          err = e.message;
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          done({ code, err });
        });
      });
      if (r.code !== 0) throw new Error(r.err.trim() || `exit ${r.code}`);
    } finally {
      w.release();
    }
  }

  status(): RunnerSandbox {
    return this.state;
  }

  async wrap(input: WrapInput): Promise<Wrapped> {
    const srt = this.srt;
    if (!srt)
      throw new RunnerError("sandbox_not_ready", this.state.reason ?? "No sandbox in this environment");
    const id = randomBytes(16).toString("base64url");
    const manager = srt.SandboxManager;
    manager.registerCommandNetworkLists(id, { allowedDomains: input.domains });
    this.modes.add(id, input.mode);
    let command: string;
    try {
      command = await manager.wrapWithSandbox(
        input.command,
        undefined,
        { filesystem: { ...input.fs, allowRead: [...input.fs.allowRead, ...this.ownRead] } },
        input.signal,
        { commandId: id, commandText: input.command.slice(0, 2000) },
      );
    } catch (err) {
      manager.unregisterCommandNetworkLists(id);
      this.modes.remove(id);
      throw new RunnerError("sandbox_not_ready", err instanceof Error ? err.message : String(err));
    }
    let released = false;
    return {
      command,
      blocked: () => [
        ...new Set(
          manager
            .getSandboxViolationStore()
            .getViolationsForCommand(id)
            .map((v) => blockedHost(v.line))
            .filter((h): h is string => !!h),
        ),
      ],
      release: () => {
        if (released) return;
        released = true;
        manager.unregisterCommandNetworkLists(id);
        this.modes.remove(id);
        manager.cleanupAfterCommand();
      },
    };
  }

  /** `srt` belongs to the whole process: it closes with it (the proxy and the socat bridges). */
  async close(): Promise<void> {}
}

/** Sandbox turned off (`sandbox off`) or without `srt`: `wrap` rejects, unless it is turned off. */
export const isolated = (s: RunnerSandbox) => s.state === "on";

/** Joins a command and its arguments into a shell line (each part in single quotes). */
export const shellLine = (cmd: string, args: string[]) =>
  [cmd, ...args].map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(" ");
