// Runners (paired hosts that run agent tools), pairing, jobs and the sandbox.

export interface RunnerAccess {
  folders: { agents: string[]; path: string }[];
  tools: { browser: boolean; claude: boolean; codex: boolean; commands: boolean };
}

export interface RunnerCli {
  login: "api_key" | "none" | "subscription" | "unknown";
  plan: string | null;
  version: string;
}

/** Isolation of the agent's processes on the runner (sandbox-runtime: bubblewrap or Seatbelt). */
export interface RunnerSandbox {
  engine: "bubblewrap" | "seatbelt" | null;
  reason: string | null;
  /** `off`: the person turned it off on their own runner; `unavailable`: bubblewrap or socat is missing. */
  state: "off" | "on" | "unavailable";
}

/** Domain an agent process tried to reach and the sandbox blocked. Once allowed, it applies to the agent. */
export interface NetworkRequest {
  id: string;
  agentId: string;
  channelId: string | null;
  /** The command or the job title that hit the block. */
  context: string;
  createdAt: string;
  decidedAt: string | null;
  deciderUserId: string | null;
  domain: string;
  messageId: string | null;
  status: "allowed" | "denied" | "pending" | "removed";
  threadId: string | null;
}

export interface Runner {
  id: string;
  access: RunnerAccess;
  agents: string[];
  arch: string;
  browser: boolean;
  /** Login of each CLI: `subscription` is the pairing person's plan (`plan`: pro, max, chatgpt...). */
  cli: {
    claude_code?: RunnerCli;
    codex?: RunnerCli;
  };
  createdAt: string;
  /** Last rotation of the runner's credential (it rotates on every connection). */
  credentialRotatedAt: string | null;
  /** Executors installed and allowed on the runner. */
  executors: ("claude_code" | "codex")[];
  hostname: string;
  lastOnlineAt: string | null;
  manageable: boolean;
  name: string;
  online: boolean;
  os: string;
  /** Name of who paired it (the id is in pairedByUserId). */
  pairedByName: string;
  pairedByUserId: string;
  paused: boolean;
  /** Revoked credential: the runner does not connect until it is paired again. */
  revokedAt: string | null;
  revokedReason: "manual" | "reuse" | null;
  runnerRelease: string;
  /** `null`: older runner that does not report isolation. */
  sandbox: RunnerSandbox | null;
  shellAllowed: boolean;
  workDir: string | null;
}

export interface RunnerPairing {
  arch: string;
  coarseLocation: string | null;
  createdAt: string;
  expiresAt: string;
  hostname: string;
  name: string;
  os: string;
  reconnect: { runnerId: string; workspaceId: string } | null;
  userCode: string;
}

export interface MoveAgentsResult {
  moved: string[];
  queued: number;
  restarted: number;
  skipped: string[];
}

export interface EnvironmentTarget {
  kind: "cloud" | "runner";
  name: string | null;
  online: boolean;
  runnerId: string | null;
}

export interface AgentEnvironment {
  lastUsedAt: string | null;
  network: "allowlist" | "off" | "open";
  status: "archived" | "none" | "running" | "stopped";
  storageGib: number;
  target: EnvironmentTarget | null;
}

export interface SandboxSettings {
  available: boolean;
  commandTimeoutSec: number;
  enabled: boolean;
  minutesPerDay: number;
  network: "allowlist" | "off" | "open";
  permittedDomains: string[];
  requireApproval: boolean;
  timeoutCeilingSec: number;
}

export interface JobOutput {
  lines: string[];
  source: "live" | "none" | "stored";
}

export type JobStatus = "canceled" | "done" | "failed" | "interrupted" | "queued" | "running";

export interface Job {
  id: string;
  agentId: string;
  assignmentId: string | null;
  branch: string | null;
  createdAt: string;
  endedAt: string | null;
  exitCode: number | null;
  files: string[];
  lastSignalAt: string | null;
  prUrl: string | null;
  resumedJobId: string | null;
  runnerId: string;
  seconds: number | null;
  startedAt: string | null;
  status: JobStatus;
  tailLine: string | null;
  threadId: string | null;
  title: string;
}
