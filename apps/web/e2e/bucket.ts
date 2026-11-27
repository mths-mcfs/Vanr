// An S3-compatible bucket for the storage journeys: the server's own test double, in a Bun child
// process (see bucket-main.ts). The E2E server reaches it on 127.0.0.1 over plain HTTP, which a
// self-hosted, non-production server allows.
import { spawn } from "node:child_process";
import { join } from "node:path";

const ENTRY = join(import.meta.dirname, "bucket-main.ts");
const START_MS = 15_000;

export interface Bucket {
  /** The endpoint to type in the storage form, e.g. `http://127.0.0.1:41234`. */
  readonly endpoint: string;
  readonly name: string;
  stop(): Promise<void>;
}

export async function startBucket(): Promise<Bucket> {
  const child = spawn("bun", [ENTRY], { stdio: ["ignore", "pipe", "inherit"] });
  const first = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`the bucket did not start in ${START_MS} ms`)), START_MS);
    let text = "";
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`the bucket exited before it started (${code})`));
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      text += chunk.toString("utf8");
      const line = text.split("\n")[0];
      if (text.includes("\n") && line !== undefined) {
        clearTimeout(timer);
        resolve(line);
      }
    });
  });
  const { endpoint, bucket } = JSON.parse(first) as { endpoint: string; bucket: string };
  return {
    endpoint,
    name: bucket,
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill("SIGTERM");
      await exited;
    },
  };
}
