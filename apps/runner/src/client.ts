// The runner's connection to the server. Before each connection it trades the device credential for a
// short single-use session (`POST /api/v1/runners/session`), which also returns the new credential (the
// old one stops working once the new one is used). It opens the WebSocket, authenticates in `hello` with the session,
// answers pings, reconnects with a growing wait (1 s to 60 s, ±20%) and serves the requests
// (`request`) with the ops. A rejection (`rejected`) ends it for good: invalid credential, runner removed
// or revoked, or another connection in place of this one. An old version (`outdated`) or a hint of a new version in
// `welcome`: the runner updates itself with the signed bundle and exits with `updated` to start the new one.
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { join } from "node:path";
import type { RunnerAccess } from "@vanr/contract";
import {
  type AgentRef,
  BROWSER_GUARD_FEATURE,
  type CliStates,
  connectUrl,
  HEARTBEAT_MS,
  MAX_INFLIGHT,
  opArgs,
  type RejectReason,
  RUNNER_PROTOCOL,
  type RunnerError as RunnerErrorBody,
  type RunnerFrame,
  type RunnerOp,
  type ServerFrame,
  serverFrame,
} from "@vanr/engine/runner-protocol";
import { compareVersions } from "@vanr/engine/runner-update";
import { z } from "zod";
import { Access, RunnerError } from "./access";
import type { BrowserDriver } from "./browser";
import { CdpBrowser, type CdpBrowserOptions } from "./cdp";
import { BROWSER_NO_SANDBOX_ENV, findChrome } from "./chrome";
import { CliWatch } from "./cli";
import {
  configMtime,
  RUNNER_VERSION,
  type RunnerConfig,
  readConfig,
  writeConfig,
  writePrivate,
} from "./config";
import { Harnesses } from "./harness";
import { Jobs, which } from "./jobs";
import { McpBridge, type ToolOutcome } from "./mcp";
import { execOp, listOp, type OpContext, readOp, writeOp } from "./ops";
import { assemble, Flows, HELLO_JOBS_MAX, type Masks } from "./outbound";
import { type CommandSandbox, defaultPolicyContext, openSandbox, type PolicyContext } from "./sandbox";
import { SecretStore } from "./secrets";
import { runningBundle, UpdateError, update } from "./update";

export type ExitReason = "stopped" | "updated" | RejectReason;

export interface RunnerClientOptions {
  home: string;
  /** Installed executors; without it, looks for `claude` and `codex` in PATH. */
  executors?: ("claude_code" | "codex")[];
  /** The agent's browser; without it, uses the Chrome/Chromium of this environment if it finds one. */
  browser?: BrowserDriver | null;
  /** For tests: name resolver of the browser proxy and an accepted self-signed certificate. */
  browserTest?: Pick<CdpBrowserOptions, "resolve" | "insecureTls">;
  log?: (line: string) => void;
  /** For tests: Claude Code and Codex executables (a fake in place of the real one). */
  bins?: { claude?: string; codex?: string };
  /** For tests: base wait of the backoff. */
  backoffBaseMs?: number;
  /** How to start this runner's MCP server (the harness CLI starts that command). */
  mcpCommand?: string[];
  /** Sandbox of the agent's processes; without it, opens `srt` (or the off one, if the config asks). */
  sandbox?: CommandSandbox;
  /** For tests: the updater's public key, the bundle that would be swapped and the version this runner claims. */
  updatePublicKey?: string;
  bundlePath?: string | null;
  version?: string;
}

/** A runner without an installed update asks again only after this. */
const UPDATE_RETRY_MS = 30 * 60_000;

/** How often the runner checks the Claude Code and Codex login again. */
const CLI_CHECK_MS = 10 * 60_000;

type WsLike = WebSocket;

/** `POST /api/v1/runners/session`: the session and the new credential, or the error. */
const sessionAnswer = z.object({
  session: z.string().optional(),
  credential: z.string().optional(),
  error: z.object({ code: z.string().optional(), message: z.string().optional() }).optional(),
});

export class RunnerClient {
  private config: RunnerConfig;
  private ws: WsLike | null = null;
  private stopped = false;
  private attempt = 0;
  private hadWelcome = false;
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private poller: ReturnType<typeof setInterval> | null = null;
  private heartbeatMs = HEARTBEAT_MS;
  private mtime = 0;
  private readonly inflight = new Map<string, AbortController>();
  private exit!: (r: ExitReason) => void;
  readonly exited: Promise<ExitReason>;
  readonly access: Access;
  readonly secrets: SecretStore;
  readonly jobs: Jobs;
  readonly cli: CliWatch;
  private readonly bridge: McpBridge;
  private readonly harnesses: Harnesses;
  private readonly toolCalls = new Map<string, (out: ToolOutcome) => void>();
  private cliSent = "";
  private cliCheckedAt = 0;
  agents: { id: string; handle: string; name: string }[] = [];
  /** The masks of each agent's secrets, known since the welcome: a frame of no agent is masked with all. */
  private readonly knownMasks = new Map<string, Masks>();
  private welcomeWaiters: (() => void)[] = [];
  private readonly executors: ("claude_code" | "codex")[];
  private readonly browser: BrowserDriver | null;
  private sandbox: CommandSandbox;
  private readonly policy: PolicyContext;
  private sandboxReady: Promise<void>;
  /** A new version offered and not installed yet (it waits for the environment to have no work). */
  private pendingUpdate: string | null = null;
  private get version() {
    return this.opts.version ?? RUNNER_VERSION;
  }
  private updating = false;
  private lastUpdateTry = 0;

  constructor(private readonly opts: RunnerClientOptions) {
    const cfg = readConfig(opts.home);
    if (!cfg) throw new Error("Not paired yet");
    this.config = cfg;
    this.mtime = configMtime(opts.home);
    this.exited = new Promise((r) => {
      this.exit = r;
    });
    this.access = new Access(() => this.config);
    this.secrets = new SecretStore(opts.home);
    this.policy = defaultPolicyContext(opts.home);
    // Until the sandbox opens, nothing runs: the off one rejects `wrap` and the `unavailable` state does too.
    this.sandbox = {
      status: () => ({ state: "unavailable", engine: null, reason: "Starting" }),
      setMode: () => {},
      wrap: async () => {
        throw new RunnerError("sandbox_unavailable", "The sandbox is starting");
      },
      close: async () => {},
    };
    this.sandboxReady = this.openSandbox();
    const bins = {
      claude: opts.bins?.claude ?? which("claude") ?? "claude",
      codex: opts.bins?.codex ?? which("codex") ?? "codex",
    };
    this.executors =
      opts.executors ??
      [which("claude") ? "claude_code" : null, which("codex") ? "codex" : null].filter(
        (e): e is "claude_code" | "codex" => e !== null,
      );
    const chrome = opts.browser === undefined ? findChrome() : null;
    this.browser =
      opts.browser !== undefined
        ? opts.browser
        : chrome
          ? new CdpBrowser({
              chrome,
              home: opts.home,
              access: this.access,
              secrets: this.secrets,
              noSandbox: process.env[BROWSER_NO_SANDBOX_ENV] === "1",
              ...opts.browserTest,
            })
          : null;
    this.cli = new CliWatch({ bins, installed: this.executors });
    // Getter: the sandbox may reopen (the person turns it on or off in the CLI) without recreating jobs and harnesses.
    const client = this;
    this.jobs = new Jobs({
      home: opts.home,
      access: this.access,
      secrets: this.secrets,
      cli: this.cli,
      maxConcurrent: () => this.config.maxConcurrentJobs,
      maxSeconds: () => this.config.jobMaxSeconds,
      send: (event) => this.send(event),
      bins,
      get sandbox() {
        return client.sandbox;
      },
      policy: this.policy,
    });
    this.bridge = new McpBridge(opts.home);
    this.harnesses = new Harnesses({
      home: opts.home,
      access: this.access,
      bins,
      cli: this.cli,
      bridge: this.bridge,
      mcpCommand: opts.mcpCommand ?? [process.execPath, "mcp"],
      get sandbox() {
        return client.sandbox;
      },
      policy: this.policy,
    });
  }

  private async openSandbox(): Promise<void> {
    this.sandbox =
      this.opts.sandbox ?? (await openSandbox({ disabled: !this.config.sandbox, log: (l) => this.log(l) }));
    const s = this.sandbox.status();
    if (s.state === "unavailable") this.log(`sandbox unavailable: ${s.reason}; commands will be rejected`);
    if (s.state === "off") this.log("sandbox turned off in this environment: commands run without isolation");
  }

  private log(line: string) {
    this.opts.log?.(line);
  }

  get runnerId() {
    return this.config.runnerId;
  }

  get connected() {
    return this.hadWelcome && this.ws?.readyState === WebSocket.OPEN;
  }

  /** For tests and for the CLI: resolves when the server accepts the connection. */
  ready(): Promise<void> {
    if (this.connected) return Promise.resolve();
    return new Promise((r) => this.welcomeWaiters.push(r));
  }

  start(): void {
    this.poller = setInterval(() => {
      this.reloadConfig();
      this.recheckCli();
      if (this.pendingUpdate) void this.tryUpdate();
    }, 1000);
    void this.sandboxReady.then(() => this.connect());
  }

  async stop(reason: ExitReason = "stopped"): Promise<void> {
    this.stopped = true;
    if (this.poller) clearInterval(this.poller);
    if (this.retry) clearTimeout(this.retry);
    if (this.watchdog) clearTimeout(this.watchdog);
    for (const c of this.inflight.values()) c.abort();
    this.jobs.stopAll();
    this.harnesses.close();
    this.bridge.close();
    await this.browser?.close().catch(() => {});
    this.secrets.lock();
    this.ws?.close(1000, "stopped");
    this.exit(reason);
  }

  /**
   * The one way out to the server: the frame is assembled in outbound.ts (every string masked with `masks`
   * and the secrets of every agent, cut to the schema, validated); a frame that cannot be made valid goes in
   * its minimal form, or not at all.
   */
  private send(frame: RunnerFrame, masks: Masks = []): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    const out = assemble(frame, [...masks, ...this.allMasks()]);
    if (!out) {
      this.log(`did not send an invalid ${frame.type} frame`);
      return false;
    }
    this.ws.send(JSON.stringify(out));
    return true;
  }

  private retryLater() {
    if (this.stopped) return;
    if (this.hadWelcome) this.attempt = 0;
    const base = this.opts.backoffBaseMs ?? 1000;
    const delay = Math.min(base * 2 ** this.attempt, 60_000) * (0.8 + Math.random() * 0.4);
    this.attempt += 1;
    this.log(`disconnected; trying again in ${Math.round(delay / 1000)} s`);
    this.retry = setTimeout(() => this.connect(), delay);
  }

  /** Final rejection: stops trying and exits with the reason. */
  private rejected(reason: RejectReason, message: string) {
    this.log(`the server rejected this runner: ${message}`);
    if (reason === "outdated") {
      // Old version: tries the signed update; without it, exits asking to install again.
      void this.tryUpdate(true).then((updated) => {
        if (!updated) this.finish(reason);
      });
      return;
    }
    this.finish(reason);
  }

  private finish(reason: RejectReason) {
    this.ws?.close(1000, "rejected");
    void this.stop(reason);
  }

  /**
   * Trades the device credential for a single-use session. The answer carries the new credential,
   * written before the session is used: if the write fails, the old one still works on the next try.
   */
  private async openSession(): Promise<{ session: string } | { reject: RejectReason; message: string }> {
    const res = await fetch(`${this.config.server}/api/v1/runners/session`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.config.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        runnerId: this.config.runnerId,
        protocol: RUNNER_PROTOCOL,
        version: this.version,
      }),
    });
    const body = sessionAnswer.safeParse(await res.json().catch(() => ({}))).data ?? {};
    const code = body.error?.code ?? "";
    const message = body.error?.message ?? `The server answered ${res.status}`;
    if (res.status === 426) return { reject: "outdated", message };
    if (res.status === 401) return { reject: "invalid_token", message };
    if (res.status === 403 || code === "runner.revoked") return { reject: "revoked", message };
    if (!res.ok || !body.session || !body.credential) throw new Error(message);
    this.saveConfig({ ...this.config, token: body.credential });
    return { session: body.session };
  }

  private connect() {
    if (this.stopped) return;
    this.openSession().then(
      (out) => {
        if (this.stopped) return;
        if ("reject" in out) return this.rejected(out.reject, out.message);
        this.openSocket(out.session);
      },
      (err) => {
        this.log(`could not open a session: ${err instanceof Error ? err.message : String(err)}`);
        this.retryLater();
      },
    );
  }

  private openSocket(session: string) {
    if (this.stopped) return;
    const url = connectUrl(this.config.server);
    const ws = new WebSocket(url);
    this.ws = ws;
    this.hadWelcome = false;
    this.armWatchdog();
    ws.onopen = () => {
      const cli = this.cli.states(true);
      this.cliSent = JSON.stringify(cli);
      this.cliCheckedAt = Date.now();
      this.send({
        type: "hello",
        session,
        version: this.version,
        protocol: RUNNER_PROTOCOL,
        os: process.platform,
        arch: process.arch,
        hostname: hostname(),
        workDir: this.config.workDir,
        paused: this.config.paused,
        access: this.config.access,
        browser: !!this.browser,
        executors: this.executors,
        cli,
        // The rest of the pending jobs goes as job.done after the welcome (redeliver), in the journal's order.
        jobs: this.helloJobs(),
        sandbox: this.sandbox.status(),
        features: this.browser ? [BROWSER_GUARD_FEATURE] : [],
      });
    };
    ws.onmessage = (ev) => {
      this.armWatchdog();
      let frame: ServerFrame;
      try {
        frame = serverFrame.parse(JSON.parse(String(ev.data)));
      } catch {
        this.log("ignored a frame the runner does not understand");
        return;
      }
      void this.onFrame(frame);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.secrets.lock();
      this.knownMasks.clear();
      for (const c of this.inflight.values()) c.abort();
      this.failToolCalls();
      if (this.watchdog) clearTimeout(this.watchdog);
      if (this.stopped) return;
      this.retryLater();
    };
    ws.onerror = () => {
      // the close comes right after
    };
  }

  private armWatchdog() {
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => {
      this.log("no word from the server; reconnecting");
      this.ws?.close(4000, "watchdog");
    }, this.heartbeatMs * 2);
  }

  private async onFrame(frame: ServerFrame) {
    switch (frame.type) {
      case "welcome":
        this.heartbeatMs = frame.heartbeatMs;
        this.saveAgents(frame.agents);
        await this.secrets.unlock(frame.storeKey, frame.runnerId);
        await this.refreshMasks();
        this.hadWelcome = true;
        if (frame.name !== this.config.name) this.saveConfig({ ...this.config, name: frame.name });
        this.log(`connected as ${frame.name}`);
        this.jobs.redeliver();
        for (const w of this.welcomeWaiters.splice(0)) w();
        if (frame.update && this.config.autoUpdate && newer(frame.update.version, this.version)) {
          this.pendingUpdate = frame.update.version;
          void this.tryUpdate();
        }
        return;
      case "agents":
        this.saveAgents(frame.agents);
        await this.refreshMasks();
        return;
      case "ping":
        this.send({ type: "pong", at: frame.at });
        return;
      case "rejected":
        this.stopped = true;
        this.rejected(frame.reason, frame.message);
        return;
      case "cancel":
        this.inflight.get(frame.id)?.abort();
        return;
      case "job.ack":
        this.jobs.ack(frame.jobId);
        return;
      case "harness.tool_result": {
        const done = this.toolCalls.get(frame.callId);
        this.toolCalls.delete(frame.callId);
        done?.({ content: frame.content, isError: frame.isError });
        return;
      }
      case "request":
        await this.onRequest(frame);
        return;
    }
  }

  private fail(id: string, error: RunnerErrorBody, masks: Masks = []) {
    this.send({ type: "result", id, ok: false, error }, masks);
  }

  private async onRequest(frame: Extract<ServerFrame, { type: "request" }>) {
    const { id, op } = frame;
    if (!(op in opArgs)) return this.fail(id, { code: "bad_request", message: `Unknown op ${op}` });
    if (this.inflight.has(id))
      return this.fail(id, { code: "bad_request", message: "Request id already in use" });
    if (this.inflight.size >= MAX_INFLIGHT) return this.fail(id, { code: "internal", message: "busy" });
    const schema = opArgs[op as RunnerOp];
    const parsed = schema.safeParse(frame.args);
    if (!parsed.success)
      return this.fail(id, { code: "bad_request", message: parsed.error.issues[0]?.message ?? "" });
    const controller = new AbortController();
    this.inflight.set(id, controller);
    // The agent's secrets, for every frame this request sends.
    const masks = frame.agent ? await this.secrets.masks(frame.agent).catch(() => []) : [];
    // The pieces of one text (a command's output, a harness turn's text) go through one flow each.
    const flows = new Flows([...masks, ...this.allMasks()]);
    const piece = (key: string, text: string) => flows.push(key, text);
    const flush = () => {
      for (const key of flows.keys()) {
        const tail = flows.end(key);
        if (!tail) continue;
        if (key === "text")
          this.send({ type: "harness.event", id, event: { kind: "text", text: tail } }, masks);
        else if (key === "stdout" || key === "stderr")
          this.send({ type: "output", id, stream: key, chunk: tail }, masks);
      }
    };
    const ctx: OpContext = {
      access: this.access,
      secrets: this.secrets,
      sandbox: this.sandbox,
      policy: this.policy,
      agent: frame.agent,
      signal: controller.signal,
      ...(frame.stream
        ? {
            onOutput: (stream, chunk) => {
              const safe = piece(stream, chunk);
              if (safe) this.send({ type: "output", id, stream, chunk: safe }, masks);
            },
          }
        : {}),
    };
    try {
      const data =
        op === "harness.turn"
          ? await this.harnesses.turn(this.needAgent(ctx.agent), parsed.data as never, {
              signal: controller.signal,
              emit: (event) => {
                const text = piece("text", event.text);
                if (text) this.send({ type: "harness.event", id, event: { ...event, text } }, masks);
              },
              callTool: (name, input) => this.callTool(id, name, input, masks),
            })
          : await this.run(op as RunnerOp, parsed.data, ctx, masks);
      flush();
      this.send({ type: "result", id, ok: true, data }, masks);
      if (op === "secret.store" || op === "secret.remove") await this.refreshMasks();
    } catch (err) {
      flush();
      if (err instanceof RunnerError) this.fail(id, { code: err.code, message: err.message }, masks);
      else
        this.fail(id, { code: "internal", message: err instanceof Error ? err.message : String(err) }, masks);
    } finally {
      this.inflight.delete(id);
    }
  }

  /** An agent tool asked for by the harness: it runs on the server, which returns `harness.tool_result`. */
  private callTool(id: string, name: string, input: unknown, masks: Masks): Promise<ToolOutcome> {
    const callId = randomUUID();
    return new Promise((resolve) => {
      this.toolCalls.set(callId, resolve);
      if (!this.send({ type: "harness.tool", id, callId, name, input }, masks)) {
        this.toolCalls.delete(callId);
        resolve({ content: "The server is not reachable right now", isError: true });
      }
    });
  }

  private failToolCalls() {
    for (const done of this.toolCalls.values())
      done({ content: "The connection to the server dropped", isError: true });
    this.toolCalls.clear();
  }

  /** The Claude Code/Codex login changed (logged in, logged out, switched to an API key): tells the server. */
  private recheckCli() {
    if (!this.connected || Date.now() - this.cliCheckedAt < CLI_CHECK_MS) return;
    this.cliCheckedAt = Date.now();
    const cli: CliStates = this.cli.states(true);
    const json = JSON.stringify(cli);
    if (json === this.cliSent) return;
    this.cliSent = json;
    this.send({ type: "cli.changed", cli });
  }

  private needAgent(agent: AgentRef | null): AgentRef {
    if (!agent) throw new RunnerError("bad_request", "This op needs an agent");
    return agent;
  }

  // biome-ignore lint/suspicious/noExplicitAny: each op validates its own args with the schema before getting here
  private async run(op: RunnerOp, args: any, ctx: OpContext, masks: Masks): Promise<unknown> {
    switch (op) {
      case "exec":
        return execOp(ctx, args);
      case "read":
        return readOp(ctx, args);
      case "write":
        return writeOp(ctx, args);
      case "list":
        return listOp(ctx, args);
      case "job.start":
        return this.jobs.start(this.needAgent(ctx.agent), args);
      case "job.status":
        return this.jobs.status(args.jobId);
      case "job.cancel":
        return this.jobs.cancel(args.jobId);
      case "job.output":
        return this.jobs.output(args.jobId, args.tail);
      case "secret.prepare":
        this.needAgent(ctx.agent);
        return this.secrets.prepare(args.requestId);
      case "secret.store":
        return this.secrets.store(this.needAgent(ctx.agent), args);
      case "secret.list":
        return { secrets: this.secrets.list(this.needAgent(ctx.agent)) };
      case "secret.remove":
        return this.secrets.remove(this.needAgent(ctx.agent), args.name);
      case "access.reduce":
        return { access: this.reduceAccess(args) };
      case "harness.turn":
        throw new RunnerError("bad_request", "harness.turn is handled before run()");
      case "browser.open":
      case "browser.act":
      case "browser.inspect":
      case "browser.close":
      case "live_view.start":
      case "live_view.stop":
      case "browser.policy":
      case "live_view.input": {
        const driver = this.browser;
        if (!driver) throw new RunnerError("browser_unavailable", "No browser in this environment");
        this.access.requireTool("browser");
        return driver.handle(op, this.needAgent(ctx.agent), args, (frame) => this.send(frame, masks));
      }
    }
  }

  /** The running jobs first (only the hello reports them), then the ended ones, up to the hello's limit. */
  private helloJobs() {
    const pending = this.jobs.pending();
    const running = pending.filter((j) => j.status === "running");
    return [...running, ...pending.filter((j) => j.status !== "running")].slice(0, HELLO_JOBS_MAX);
  }

  /** The masks of every known agent's secrets, refreshed at the welcome and when a secret changes. */
  private async refreshMasks() {
    this.knownMasks.clear();
    for (const agent of this.agents) {
      const masks = await this.secrets.masks(agent).catch((): Masks => []);
      if (masks.length) this.knownMasks.set(agent.id, masks);
    }
  }

  private allMasks(): Masks {
    return [...this.knownMasks.values()].flat();
  }

  private saveAgents(agents: { id: string; handle: string; name: string }[]) {
    this.agents = agents;
    writePrivate(join(this.opts.home, "agents.json"), JSON.stringify(agents));
  }

  private saveConfig(next: RunnerConfig) {
    this.config = next;
    writeConfig(this.opts.home, next);
    this.mtime = configMtime(this.opts.home);
  }

  /** The server only reduces (removing a folder or an agent, turning a tool off); allowing happens here in the environment. */
  private reduceAccess(
    input:
      | { removeFolder: { path: string; agentId?: string } }
      | { disableTool: keyof RunnerAccess["tools"] },
  ): RunnerAccess {
    const access = structuredClone(this.config.access);
    if ("disableTool" in input) access.tools[input.disableTool] = false;
    else {
      const { path, agentId } = input.removeFolder;
      access.folders = access.folders.flatMap((f) => {
        if (f.path !== path) return [f];
        if (!agentId) return [];
        const agents = f.agents.filter((a) => a !== agentId);
        // A folder for everyone (empty list) does not become "for no one": without the agent, the folder goes.
        return f.agents.length === 0 || agents.length === 0 ? [] : [{ ...f, agents }];
      });
    }
    this.saveConfig({ ...this.config, access });
    this.send({ type: "access.changed", access });
    return access;
  }

  /** The CLI (`folders`, `tools`, `pause`) changes the config on disk; the runner notices and tells the server. */
  private reloadConfig() {
    const m = configMtime(this.opts.home);
    if (m === this.mtime) return;
    this.mtime = m;
    const next = readConfig(this.opts.home);
    if (!next) return;
    const prev = this.config;
    this.config = next;
    if (JSON.stringify(prev.access) !== JSON.stringify(next.access))
      this.send({ type: "access.changed", access: next.access });
    if (prev.paused !== next.paused) this.send({ type: "runner.state", paused: next.paused });
    if (prev.sandbox !== next.sandbox && !this.opts.sandbox)
      void openSandbox({ disabled: !next.sandbox, log: (l) => this.log(l) }).then((sandbox) => {
        this.sandbox = sandbox;
        this.send({ type: "sandbox.changed", sandbox: sandbox.status() });
      });
  }

  /** No job, harness or request running: the bundle can be swapped and the runner restarted. */
  private idle(): boolean {
    return this.inflight.size === 0 && this.jobs.runningCount() === 0;
  }

  /**
   * Installs the offered version, if the signature and the version check out. `now`: the server rejected this
   * version, so it does not wait for the environment to be free (no work is coming anyway).
   */
  private async tryUpdate(now = false): Promise<boolean> {
    if (this.updating || (!now && !this.idle())) return false;
    if (!now && Date.now() - this.lastUpdateTry < UPDATE_RETRY_MS) return false;
    this.updating = true;
    this.lastUpdateTry = Date.now();
    try {
      const version = await update({
        server: this.config.server,
        bundlePath: this.opts.bundlePath !== undefined ? this.opts.bundlePath : runningBundle(),
        current: this.version,
        ...(this.opts.updatePublicKey ? { publicKey: this.opts.updatePublicKey } : {}),
      });
      this.pendingUpdate = null;
      if (!version) return false;
      this.log(`updated to ${version}; restarting`);
      await this.stop("updated");
      return true;
    } catch (err) {
      this.pendingUpdate = null;
      this.log(
        `update rejected: ${err instanceof UpdateError ? `${err.code}: ${err.message}` : String(err)}`,
      );
      return false;
    } finally {
      this.updating = false;
    }
  }
}

const newer = (version: string, current: string) => {
  try {
    return compareVersions(version, current) > 0;
  } catch {
    return false;
  }
};
