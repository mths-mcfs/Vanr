// Pairing with a device code: the runner asks for a code, shows the link and asks the server every
// few seconds whether someone confirmed. Once confirmed, it writes the token to the config.
import { arch, homedir, hostname, platform } from "node:os";
import { join } from "node:path";
import { PRODUCT } from "@vanr/product";
import { z } from "zod";
import { findChrome } from "./chrome";
import { normalizeServer, RUNNER_VERSION, type RunnerConfig, readConfig, writeConfig } from "./config";

export interface DeviceStart {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  expiresIn: number;
  interval: number;
}

const deviceStart = z.object({
  deviceCode: z.string(),
  userCode: z.string(),
  verificationUrl: z.string(),
  expiresIn: z.number(),
  interval: z.number(),
}) satisfies z.ZodType<DeviceStart>;

/** The server's answer while polling: the credential once someone confirmed, or the RFC 8628 error. */
const pollAnswer = z.union([
  z.object({
    token: z.string(),
    runnerId: z.string(),
    name: z.string(),
    workspace: z.object({ id: z.string(), name: z.string() }),
  }),
  z.object({ error: z.string() }),
]);

export interface PairOptions {
  server: string;
  home: string;
  name?: string;
  workDir?: string;
  /** false: paired without commands, Claude Code or Codex (`--no-exec`). */
  exec?: boolean;
  /** A new runner, even if one is already paired with this server. */
  fresh?: boolean;
  print?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  /** Reports the code as soon as it exists (the test uses it to confirm through the UI). */
  onCode?: (start: DeviceStart) => void;
}

export class PairingError extends Error {
  constructor(
    readonly code: "access_denied" | "expired_token" | "server",
    message: string,
  ) {
    super(message);
  }
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** `ABCDEF` → `ABC·DEF` (the same way the UI shows it). */
const formatCode = (code: string) => (code.length === 6 ? `${code.slice(0, 3)}·${code.slice(3)}` : code);

export async function pair(opts: PairOptions): Promise<RunnerConfig> {
  const server = normalizeServer(opts.server);
  const print = opts.print ?? ((l: string) => console.log(l));
  const sleep = opts.sleep ?? wait;
  const previous = readConfig(opts.home);
  const previousRunnerId = !opts.fresh && previous?.server === server ? previous.runnerId : undefined;
  const res = await fetch(`${server}/api/v1/runner-pairings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...(opts.name ? { name: opts.name } : {}),
      os: platform(),
      arch: arch(),
      hostname: hostname(),
      version: RUNNER_VERSION,
      ...(previousRunnerId ? { previousRunnerId } : {}),
    }),
  });
  if (!res.ok) throw new PairingError("server", `The server answered ${res.status}`);
  const started = deviceStart.safeParse(await res.json());
  if (!started.success) throw new PairingError("server", "The server sent an invalid pairing code");
  const start = started.data;
  opts.onCode?.(start);
  print(`Code: ${formatCode(start.userCode)}`);
  print(`Open ${start.verificationUrl} and confirm this environment.`);
  const deadline = Date.now() + start.expiresIn * 1000;
  let interval = start.interval * 1000;
  while (Date.now() < deadline) {
    await sleep(interval);
    let r: Response;
    try {
      r = await fetch(`${server}/api/v1/runner-pairings/token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceCode: start.deviceCode }),
      });
    } catch {
      continue;
    }
    if (r.status >= 500) continue;
    const answer = pollAnswer.safeParse(await r.json());
    if (!answer.success) continue;
    const body = answer.data;
    if ("token" in body) {
      const execOn = opts.exec !== false;
      const config: RunnerConfig = {
        server,
        runnerId: body.runnerId,
        name: body.name,
        token: body.token,
        workspaceId: body.workspace.id,
        workspaceName: body.workspace.name,
        workDir: opts.workDir ?? previous?.workDir ?? join(homedir(), PRODUCT.slug),
        access:
          previous?.runnerId === body.runnerId
            ? previous.access
            : {
                folders: [],
                tools: { claude: execOn, codex: execOn, commands: execOn, browser: execOn && !!findChrome() },
              },
        paused: false,
        maxConcurrentJobs: previous?.maxConcurrentJobs ?? 3,
        jobMaxSeconds: previous?.jobMaxSeconds ?? 4 * 3600,
        sandbox: previous?.sandbox ?? true,
        autoUpdate: previous?.autoUpdate ?? true,
      };
      writeConfig(opts.home, config);
      print(`Connected to ${body.workspace.name} as ${body.name}.`);
      return config;
    }
    if (body.error === "authorization_pending") continue;
    if (body.error === "slow_down" || r.status === 429) {
      interval += 5000;
      continue;
    }
    if (body.error === "access_denied") throw new PairingError("access_denied", "The pairing was declined");
    if (body.error === "expired_token") break;
  }
  throw new PairingError("expired_token", "The code expired before anyone confirmed it");
}
