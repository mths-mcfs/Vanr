// One real Vanr server for the journeys: its own process, a free port, a fresh in-memory PGlite and a
// temporary folder (mail files, signed-in states) that goes away with it. It serves the web build too,
// as in production, so the browser, the API and the real-time socket share one origin.
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SERVER_ENTRY = join(import.meta.dirname, "../../server/src/index.ts");
const BOOT_MS = 60_000;
const STOP_MS = 10_000;

export interface RunningServer {
  /** Where the browser opens the app, e.g. `http://127.0.0.1:41234`. */
  readonly url: string;
  /** The server's working folder; mail lands in `.data/mail`. Removed on stop. */
  readonly dir: string;
  stop(): Promise<void>;
}

/** A port nothing listened on a moment ago. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => {
        if (address !== null && typeof address === "object") resolve(address.port);
        else reject(new Error("no port"));
      });
    });
  });
}

/** Resolves once the server logs `server.started`; rejects if it exits or takes too long. */
function started(child: ChildProcess, onLine: (line: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    let rest = "";
    const timer = setTimeout(() => reject(new Error(`the server did not start in ${BOOT_MS} ms`)), BOOT_MS);
    const done = (error?: Error) => {
      clearTimeout(timer);
      child.off("close", exited);
      if (error === undefined) resolve();
      else reject(error);
    };
    const exited = (code: number | null, signal: NodeJS.Signals | null) => {
      if (rest !== "") onLine(rest);
      done(new Error(`the server exited before it started (${code ?? signal})`));
    };
    // `close`, not `exit`: it comes after stderr has drained, so an EADDRINUSE line is never missed.
    child.once("close", exited);
    child.stderr?.on("data", (chunk: Buffer) => {
      const lines = (rest + chunk.toString("utf8")).split("\n");
      rest = lines.pop() ?? "";
      for (const line of lines) {
        onLine(line);
        if (line.includes('"msg":"server.started"')) done();
      }
    });
  });
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), STOP_MS);
  await exited;
  clearTimeout(timer);
}

/** The child could not take its port: another process bound it after `freePort` let it go. */
class PortTaken extends Error {}

const BOOT_ATTEMPTS = 3;

/**
 * Boots the server and waits until it answers. Its stdout and stderr go to `logPath`, which the
 * caller keeps with the run's artifacts. The port is free when picked but not held until the child
 * binds it, so a port taken in between is retried on a new one.
 */
export async function startServer({
  webDist,
  logPath,
}: {
  webDist: string;
  logPath: string;
}): Promise<RunningServer> {
  const dir = await mkdtemp(join(tmpdir(), "vanr-e2e-server-"));
  const log = createWriteStream(logPath);
  try {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await boot({ dir, webDist, log });
      } catch (error) {
        if (!(error instanceof PortTaken) || attempt === BOOT_ATTEMPTS) throw error;
        log.write(`# ${error.message}; trying another port\n`);
      }
    }
  } catch (error) {
    log.end();
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}

async function boot({
  dir,
  webDist,
  log,
}: {
  dir: string;
  webDist: string;
  log: ReturnType<typeof createWriteStream>;
}): Promise<RunningServer> {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const child = spawn("bun", [SERVER_ENTRY], {
    // The working folder is the temporary one: what the server writes next to itself lands there.
    cwd: dir,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      PORT: String(port),
      PUBLIC_URL: url,
      TRUSTED_ORIGINS: url,
      // PGlite in memory and blobs in memory: nothing survives the process, nothing is shared.
      DATA_DIR: "memory",
      WEB_DIST: webDist,
      BETTER_AUTH_SECRET: randomBytes(24).toString("base64url"),
      SIGNUP_OPEN: "true",
      MAIL_PROVIDER: "file",
      MODEL_PROVIDER: "fake",
      SEARCH_EMBEDDER: "off",
    },
  });
  child.stdout?.pipe(log, { end: false });
  let portTaken = false;
  try {
    await started(child, (line) => {
      if (line.includes("EADDRINUSE")) portTaken = true;
      log.write(`${line}\n`);
    });
  } catch (error) {
    await stopChild(child);
    if (portTaken) throw new PortTaken(`port ${port} was taken before the server bound it`);
    throw error;
  }
  return {
    url,
    dir,
    async stop() {
      await stopChild(child);
      log.end();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
