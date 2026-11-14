// Protocol of the runners' WebSocket (`/api/v1/runners/connect`). The runner authenticates in the first
// frame (`hello`); the server answers `welcome` or `rejected`. Runner tools are RPC: `request` with `op` and
// `args`, answered by `result` (and streamed `output`, when asked). Used by the server and by the runner,
// which validates every incoming frame with these schemas.
import type { BlockedReason, JobStatus, RunnerAccess, RunnerCli, RunnerSandbox } from "@vanr/contract";
import { z } from "zod";
import { browserPolicy, type ElementFacts, secretBrowserBinding } from "./browser-policy";

/**
 * 2: `hello` carries a short single-use session (`session`), obtained with the device credential at
 * `POST /api/v1/runners/session`; it also carries the sandbox state. A protocol 1 runner is rejected
 * (`outdated`) before any token check.
 */
export const RUNNER_PROTOCOL = 2;
/**
 * Runner with the browser guard (private network through the proxy, origins and sensitive sites before the
 * load, secrets bound to a site). A runner without it has no browser: the server does not send `browser.*`.
 */
export const BROWSER_GUARD_FEATURE = "browser.guard.1";
export const HEARTBEAT_MS = 25_000;
/** Cap on in-flight requests per runner; the rest waits for a slot on the server. */
export const MAX_INFLIGHT = 8;

const RUNNER_TOOLS = ["claude", "codex", "commands", "browser"] as const;
export type RunnerTool = (typeof RUNNER_TOOLS)[number];

const runnerAccess = z.object({
  /** Allowed folder and which agents may use it (empty = every agent on the runner). */
  folders: z
    .array(
      z.object({ path: z.string().min(1).max(1024), agents: z.array(z.string().min(1).max(64)).max(100) }),
    )
    .max(100),
  tools: z.object({ claude: z.boolean(), codex: z.boolean(), commands: z.boolean(), browser: z.boolean() }),
}) satisfies z.ZodType<RunnerAccess>;

/** Domain of a network list: `example.com` or `*.example.com`. */
export const DOMAIN_RE = /^(\*\.)?([a-z0-9-]+\.)+[a-z]{2,}$/;

/**
 * Network of the agent's processes on the environment: `off` no network, `allowlist` only the listed domains
 * (the workspace's and those approved for the agent), `open` everything but the denied addresses.
 */
const networkPolicy = z.object({
  mode: z.enum(["off", "allowlist", "open"]),
  domains: z.array(z.string().max(253).regex(DOMAIN_RE)).max(300),
});
export type NetworkPolicyFrame = z.infer<typeof networkPolicy>;

/** Isolation of the agent's processes on the environment. */
const sandboxStatus = z.object({
  state: z.enum(["on", "off", "unavailable"]),
  engine: z.enum(["bubblewrap", "seatbelt"]).nullable(),
  reason: z.string().max(500).nullable(),
}) satisfies z.ZodType<RunnerSandbox>;

const EXECUTORS = ["claude_code", "codex"] as const;

export const JOB_STATUSES = [
  "queued",
  "running",
  "done",
  "failed",
  "interrupted",
  "canceled",
] as const satisfies readonly JobStatus[];

const jobUsage = z.object({
  model: z.string().max(200).nullable(),
  inputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
  cachedTokens: z.number().int().min(0),
  cacheWriteTokens: z.number().int().min(0),
  /** What the executor says it would cost (Claude Code sends `total_cost_usd`); not billed here. */
  costUsd: z.number().min(0).nullable(),
});
export type JobUsage = z.infer<typeof jobUsage>;

const jobSnapshot = z.object({
  jobId: z.string().min(1).max(64),
  status: z.enum(JOB_STATUSES),
  exitCode: z.number().int().nullable(),
  result: z.string().max(20_000).nullable(),
  files: z.array(z.string().max(1024)).max(200),
  session: z.string().max(200).nullable(),
  startedAt: z.string().nullable(),
  endedAt: z.string().nullable(),
  /** Commands the executor wanted to run and the permission blocked (they become cards in the assignment). */
  denied: z.array(z.string().max(2000)).max(50).default([]),
  /** Usage Claude Code/Codex reported at the end (the pairing person's plan: tokens, no dollars here). */
  usage: jobUsage.nullable().optional(),
  /** `git diff` of the work folder against the start of the job (cut on the runner). */
  diff: z.string().max(200_000).nullable().optional(),
  /** Hosts the sandbox proxy blocked (they become domain requests). */
  blocked: z.array(z.string().max(253)).max(50).default([]),
});
export type JobSnapshot = z.infer<typeof jobSnapshot>;

const REJECT_REASONS = ["invalid_token", "revoked", "outdated", "replaced"] as const;
export type RejectReason = (typeof REJECT_REASONS)[number];

const ERROR_CODES = [
  "bad_request",
  "not_found",
  "internal",
  "paused",
  "not_allowed",
  "exec_disabled",
  "outside_workspace",
  "no_slot",
  "browser_not_running",
  "too_large",
  "timeout",
  "offline",
  "canceled",
  /** Claude Code or Codex without a subscription login (or with an API key in its place). */
  "not_logged_in",
  /** The plan hit its usage limit; it comes back on its own later. */
  "plan_limit",
  "harness_failed",
  /** No sandbox on this environment (bubblewrap or socat missing, or the system has none): nothing runs. */
  "sandbox_not_ready",
  /** A person took over the browser: the agent's action does not happen until they hand it back. */
  "person_driving",
  /** The element or page changed since the server checked the action: nothing was done. */
  "page_changed",
] as const;
export type RunnerErrorCode = (typeof ERROR_CODES)[number];

/**
 * Login of each CLI on this environment, as the runner sees it with a clean environment (no API key).
 * `subscription` is the person's plan (Claude Pro/Max, ChatGPT); `api_key` means the CLI would bill an API
 * key, and the runner does not use the CLI that way.
 */
const cliState = z.object({
  version: z.string().max(80),
  login: z.enum(["subscription", "api_key", "none", "unknown"]),
  plan: z.string().max(40).nullable(),
}) satisfies z.ZodType<RunnerCli>;
const cliStates = z.object({ claude_code: cliState.optional(), codex: cliState.optional() });
export type CliStates = z.infer<typeof cliStates>;

/**
 * Variables that switch the credential, the endpoint or the account of Claude Code and Codex. The runner
 * removes them from the environment of every process it starts: with them the CLI would bill an API key
 * instead of the plan.
 */
const BLOCKED_ENV_EXACT = [
  "AWS_BEARER_TOKEN_BEDROCK",
  "CODEX_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "AZURE_OPENAI_ENDPOINT",
];
const BLOCKED_ENV_PREFIX = ["ANTHROPIC_", "CLAUDE_CODE_USE_", "OPENAI_"];
/** Names a variable secret may not have: the ones above and those that hijack the process. */
const RESERVED_EXACT = [
  ...BLOCKED_ENV_EXACT,
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "PATH",
  "HOME",
  "NODE_OPTIONS",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "MCP_TOOL_TIMEOUT",
];
const RESERVED_PREFIX = [...BLOCKED_ENV_PREFIX, "DYLD_"];

export const blockedEnv = (name: string) =>
  BLOCKED_ENV_EXACT.includes(name) || BLOCKED_ENV_PREFIX.some((p) => name.startsWith(p));

export const reservedSecretName = (name: string) =>
  RESERVED_EXACT.includes(name) || RESERVED_PREFIX.some((p) => name.startsWith(p));

/** Caps of a `harness.turn` (the server cuts before sending). */
export const HARNESS_SYSTEM_MAX = 200_000;
export const HARNESS_PROMPT_MAX = 400_000;

/** Event of a harness turn (Claude Code/Codex) that the server relays to the chat. */
const harnessEvent = z.object({ kind: z.literal("text"), text: z.string().max(100_000) });
export type HarnessEvent = z.infer<typeof harnessEvent>;

// ---- runner → server ----

const helloFrame = z.object({
  type: z.literal("hello"),
  /** Single-use session (protocol 2). */
  session: z.string().min(16).max(200).optional(),
  /** Only protocol 1 sent the credential here; it stays in the schema so the `outdated` rejection gets through. */
  token: z.string().max(200).optional(),
  version: z.string().max(40),
  protocol: z.number().int(),
  os: z.string().max(40),
  arch: z.string().max(40),
  hostname: z.string().max(200),
  /** Folder the runner works in (`work_dir` of the runner). */
  workDir: z.string().max(1024).nullable(),
  paused: z.boolean(),
  access: runnerAccess,
  browser: z.boolean(),
  executors: z.array(z.enum(EXECUTORS)).max(4),
  cli: cliStates.default({}),
  jobs: z.array(jobSnapshot).max(200),
  sandbox: sandboxStatus.default({ state: "unavailable", engine: null, reason: null }),
  /** What this runner can do beyond the protocol (e.g. `BROWSER_GUARD_FEATURE`). */
  features: z.array(z.string().max(40)).max(50).default([]),
});
export type HelloFrame = z.infer<typeof helloFrame>;

const errorBody = z.object({ code: z.enum(ERROR_CODES), message: z.string().max(2000) });
export type RunnerError = z.infer<typeof errorBody>;

export const runnerFrame = z.discriminatedUnion("type", [
  helloFrame,
  z.object({ type: z.literal("pong"), at: z.number() }),
  // Two `result` frames with the same `type`: zod 4 only accepts that as a union nested on `ok`.
  z.discriminatedUnion("ok", [
    z.object({ type: z.literal("result"), id: z.string().max(64), ok: z.literal(true), data: z.unknown() }),
    z.object({ type: z.literal("result"), id: z.string().max(64), ok: z.literal(false), error: errorBody }),
  ]),
  z.object({
    type: z.literal("output"),
    id: z.string().max(64),
    stream: z.enum(["stdout", "stderr"]),
    chunk: z.string().max(1_100_000),
  }),
  z.object({
    type: z.literal("job.event"),
    jobId: z.string().max(64),
    kind: z.enum(["line", "progress", "files"]),
    line: z.string().max(4000).optional(),
    files: z.array(z.string().max(1024)).max(200).optional(),
    at: z.string(),
  }),
  z.object({ type: z.literal("job.done"), job: jobSnapshot }),
  z.object({ type: z.literal("runner.state"), paused: z.boolean() }),
  z.object({ type: z.literal("cli.changed"), cli: cliStates }),
  z.object({ type: z.literal("harness.event"), id: z.string().max(64), event: harnessEvent }),
  /** The harness called an agent tool; the server runs it and answers `harness.tool_result`. */
  z.object({
    type: z.literal("harness.tool"),
    id: z.string().max(64),
    callId: z.string().max(64),
    name: z.string().max(200),
    input: z.unknown(),
  }),
  z.object({ type: z.literal("access.changed"), access: runnerAccess }),
  /** The person turned the sandbox on or off on their own environment (`sandbox on|off`). */
  z.object({ type: z.literal("sandbox.changed"), sandbox: sandboxStatus }),
  z.object({
    type: z.literal("live_view.frame"),
    agentId: z.string().max(64),
    data: z.string().max(3_000_000),
    width: z.number().int(),
    height: z.number().int(),
    url: z.string().max(4000).optional(),
  }),
  z.object({
    type: z.literal("live_view.stream_ended"),
    agentId: z.string().max(64),
    reason: z.enum(["stopped", "closed", "error"]),
  }),
]);
export type RunnerFrame = z.infer<typeof runnerFrame>;

// ---- server → runner ----

const agentRef = z.object({ id: z.string().max(64), handle: z.string().max(64) });
export type AgentRef = z.infer<typeof agentRef>;

export const serverFrame = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("welcome"),
    runnerId: z.string(),
    name: z.string(),
    heartbeatMs: z.number().int().min(1000),
    /** Key of the secrets stored on the environment (base64, 32 bytes). It only lives in the runner's memory. */
    storeKey: z.string(),
    /** Agents that use this environment (the CLI finds the agent by handle). */
    agents: z.array(z.object({ id: z.string(), handle: z.string(), name: z.string() })).max(500),
    /** Newest version the server offers (signed); the runner checks it and updates itself. */
    update: z.object({ version: z.string().max(40) }).optional(),
  }),
  z.object({
    type: z.literal("agents"),
    agents: z.array(z.object({ id: z.string(), handle: z.string(), name: z.string() })).max(500),
  }),
  z.object({ type: z.literal("ping"), at: z.number() }),
  z.object({ type: z.literal("rejected"), reason: z.enum(REJECT_REASONS), message: z.string() }),
  z.object({
    type: z.literal("request"),
    id: z.string().max(64),
    op: z.string().max(40),
    agent: agentRef.nullable(),
    stream: z.boolean(),
    args: z.record(z.string(), z.unknown()),
  }),
  z.object({ type: z.literal("cancel"), id: z.string().max(64) }),
  z.object({ type: z.literal("job.ack"), jobId: z.string().max(64) }),
  z.object({
    type: z.literal("harness.tool_result"),
    id: z.string().max(64),
    callId: z.string().max(64),
    content: z.string().max(400_000),
    isError: z.boolean(),
  }),
]);
export type ServerFrame = z.infer<typeof serverFrame>;

// ---- ops ----

export const opArgs = {
  exec: z.object({
    command: z.string().min(1).max(20_000),
    cwd: z.string().max(1024).optional(),
    timeoutSeconds: z.number().int().min(1).max(3600).optional(),
    /** Without it, no network. */
    network: networkPolicy.optional(),
  }),
  read: z.object({
    path: z.string().min(1).max(1024),
    maxBytes: z.number().int().min(1).max(5_000_000).optional(),
  }),
  write: z.object({
    path: z.string().min(1).max(1024),
    content: z.string().max(7_000_000),
    encoding: z.enum(["utf8", "base64"]).default("utf8"),
    append: z.boolean().default(false),
  }),
  list: z.object({ path: z.string().min(1).max(1024) }),
  "job.start": z.object({
    jobId: z.string().min(1).max(64),
    executor: z.enum(["claude_code", "codex", "shell"]),
    title: z.string().max(200),
    prompt: z.string().max(100_000),
    cwd: z.string().max(1024).optional(),
    model: z.string().max(100).optional(),
    session: z.string().max(200).optional(),
    timeoutSeconds: z.number().int().min(10).max(86_400).optional(),
    /** Commands allowed without asking (the assignment's rules, e.g. `npm test *`). */
    allow: z.array(z.string().min(1).max(300)).max(100).optional(),
    network: networkPolicy.optional(),
  }),
  /**
   * One agent turn thought by this environment's Claude Code or Codex, with the subscription login of the
   * person who paired it. The agent's tools reach the CLI through a local MCP server and run on the server
   * (`harness.tool`), with the same permissions and approvals as the model through the API.
   */
  "harness.turn": z.object({
    runId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
    executor: z.enum(EXECUTORS),
    model: z
      .string()
      .regex(/^[A-Za-z0-9._:-]{1,100}$/)
      .optional(),
    system: z.string().max(HARNESS_SYSTEM_MAX),
    prompt: z.string().min(1).max(HARNESS_PROMPT_MAX),
    tools: z
      .array(
        z.object({
          name: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
          description: z.string().max(10_000),
          inputSchema: z.record(z.string(), z.unknown()),
        }),
      )
      .max(300),
    timeoutSeconds: z.number().int().min(10).max(86_400).optional(),
    /** The harness only reaches its own CLI's domains; the workspace's `open` mode allows the rest. */
    network: networkPolicy.optional(),
  }),
  "job.status": z.object({ jobId: z.string().min(1).max(64) }),
  "job.cancel": z.object({ jobId: z.string().min(1).max(64) }),
  "job.output": z.object({
    jobId: z.string().min(1).max(64),
    tail: z.number().int().min(1).max(2000).optional(),
  }),
  "secret.prepare": z.object({ requestId: z.string().min(1).max(64) }),
  "secret.store": z.object({
    requestId: z.string().min(1).max(64),
    workspaceId: z.string().min(1).max(64),
    name: z.string().min(1).max(100),
    target: z.union([z.literal("env"), z.string().regex(/^file:.{1,300}$/)]),
    box: z.object({ v: z.literal(1), epk: z.string(), iv: z.string(), ct: z.string() }),
    /** Sites and field where the browser may type the secret; null = never in the browser. */
    browser: secretBrowserBinding.nullable().default(null),
  }),
  "secret.list": z.object({}),
  "secret.remove": z.object({ name: z.string().min(1).max(100) }),
  "access.reduce": z.union([
    z.object({
      removeFolder: z.object({ path: z.string().min(1).max(1024), agentId: z.string().max(64).optional() }),
    }),
    z.object({ disableTool: z.enum(RUNNER_TOOLS) }),
  ]),
  "browser.open": z.object({ url: z.string().min(1).max(4000), policy: browserPolicy }),
  "browser.act": z.object({
    action: z.enum([
      "back",
      "tabs",
      "read",
      "click",
      "fill",
      "select",
      "check",
      "press",
      "scroll",
      "wait",
      "screenshot",
      "type_secret",
      "upload",
    ]),
    selector: z.string().max(2000).optional(),
    text: z.string().max(20_000).optional(),
    key: z.string().max(40).optional(),
    dy: z.number().optional(),
    ms: z.number().int().min(0).max(30_000).optional(),
    name: z.string().max(100).optional(),
    /** `tabs`: the tab that becomes active. `upload`: the file path goes in `text`. */
    index: z.number().int().min(0).max(50).optional(),
    /**
     * Click, key, upload, check and select: the `fingerprint` that `browser.inspect` returned when the server
     * classified the action. If the page or the element changed, the runner does not act (`page_changed`).
     */
    expect: z.string().max(100).optional(),
    policy: browserPolicy,
  }),
  /**
   * The element a click, upload, check or select (`selector`) or a key (the focus) would hit, without acting:
   * the server classifies the action before the gate. It does not open the browser nor consume what was blocked.
   */
  "browser.inspect": z.object({
    action: z.enum(["click", "press", "upload", "check", "select"]),
    selector: z.string().max(2000).optional(),
    policy: browserPolicy,
  }),
  /** `agent`: the runner rejects it if a person is in control. Without `driver`, it was a person. */
  "browser.close": z.object({ driver: z.literal("agent").optional() }),
  "live_view.start": z.object({ fps: z.number().int().min(1).max(15), policy: browserPolicy }),
  "live_view.stop": z.object({}),
  /** Valid only with the runner knowing (through `browser.policy`) that a person drives. */
  "live_view.input": z.object({
    events: z.array(z.record(z.string(), z.unknown())).max(100),
  }),
  /** A new policy without an action: the person took over or handed back, or someone changed the agent's sites. */
  "browser.policy": z.object({ policy: browserPolicy }),
} as const;

export type RunnerOp = keyof typeof opArgs;
export type OpArgs<O extends RunnerOp> = z.input<(typeof opArgs)[O]>;

// ---- results ----

export interface ExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
  durationMs: number;
  /** Hosts the sandbox proxy blocked during the command. */
  blocked: string[];
}

export interface ReadResult {
  path: string;
  content: string;
  encoding: "utf8" | "base64";
  size: number;
  truncated: boolean;
}

export interface ListResult {
  path: string;
  entries: { name: string; kind: "file" | "dir" | "link" | "other"; size: number }[];
  truncated: boolean;
}

export interface StoredSecretInfo {
  name: string;
  target: "env" | "file";
  updatedAt: string;
}

export interface HarnessTurnResult {
  text: string;
  usage: { inputTokens: number; outputTokens: number; cachedTokens: number };
  model: string | null;
}

/** A load blocked during the action: by the origin rule (before it leaves) or by the network proxy. */
export interface BlockedLoad {
  url: string;
  reason: BlockedReason;
  /** Category of the sensitive site, or the kind of address the proxy blocked. */
  detail?: string;
  /** Blocked between the previous answer and this action (a timer or a background request of the page), not by it. */
  before?: boolean;
}

export interface BrowserActResult {
  ok: boolean;
  url: string;
  title: string;
  text?: string;
  tabs?: { url: string; title: string; active: boolean }[];
  screenshot?: string;
  /** What was blocked since the last answer to the agent; what came before this action carries `before`. */
  blocked?: BlockedLoad[];
  /** Dialogs the page opened, already answered by the runner (alert accepted, confirm and prompt canceled). */
  dialogs?: { type: string; message: string }[];
  /** JPEG thumbnail (base64) of the page after the action, for the per-step log; none on a sensitive site. */
  shot?: string;
}

export interface BrowserInspectResult {
  /** Page the agent is on (for a sensitive site, only the origin). */
  url: string;
  /** The origin rule lets the agent do this action on this page. */
  allowed: boolean;
  /** null: nothing at the selector or the focus, or a page the agent may not read. */
  element: ElementFacts | null;
  /** Fingerprint of the page and the element, which comes back in the action's `expect`. */
  fingerprint: string;
}

/** Builds the WebSocket address from the configured server (http → ws, https → wss). */
export function connectUrl(server: string): string {
  const u = new URL(server);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.pathname = `${u.pathname.replace(/\/+$/, "")}/api/v1/runners/connect`;
  u.search = "";
  u.hash = "";
  return u.toString();
}
