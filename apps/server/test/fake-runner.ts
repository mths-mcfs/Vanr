// A fake runner for the agent's runner tools: paired over HTTP through its owner's browser, it answers the
// server's requests as the test says (by default it does what it is asked and `exec` echoes the command).
import { schema } from "@vanr/engine/db";
import type { ServerFrame } from "@vanr/engine/runner-protocol";
import { eq } from "drizzle-orm";
import type { RunningServer } from "../src/server";
import { body } from "./harness";
import { connectProtocolRunner, mintSession, type ProtocolRunner } from "./protocol-runner";
import type { Person } from "./seed";

export type Request = Extract<ServerFrame, { type: "request" }>;
export type Answer = { ok: true; data: unknown } | { ok: false; error: { code: string; message: string } };
export type Answerer = (req: Request, runner: ProtocolRunner) => Answer | Promise<Answer>;

export const exec = (stdout: string, exitCode = 0): Answer => ({
  ok: true,
  data: { exitCode, stdout, stderr: "", truncated: false, timedOut: false, durationMs: 5, blocked: [] },
});

export const doing: Answerer = (req) => {
  if (req.op === "exec") return exec(`ran: ${String(req.args.command)}\n`);
  if (req.op === "job.start") return { ok: true, data: { startedAt: new Date().toISOString() } };
  if (req.op === "browser.act")
    return { ok: true, data: { ok: true, url: "https://shop.example/", title: "Shop", tabs: [] } };
  return { ok: true, data: {} };
};

/**
 * Pairs a fake runner through `owner`'s browser and connects it; the owner's switches turn on commands and
 * Claude Code (and the browser, with `browser`). Every connection goes into `open`, for the test to close.
 */
export async function pairFake(
  server: RunningServer,
  owner: Person,
  workspaceId: string,
  opts: { answer?: Answerer; browser?: boolean; open: ProtocolRunner[] },
) {
  const post = async (path: string, payload: unknown) =>
    body(
      await fetch(`${server.url}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      }),
    );
  const pairing = await post("/api/v1/runner-pairings", {
    os: "linux",
    arch: "x64",
    hostname: "fake",
    version: "0.2.0",
  });
  const confirmed = await owner.browser.json(
    `/api/v1/workspaces/${workspaceId}/runner-pairings/${pairing.userCode}/confirm`,
    "POST",
    {},
  );
  if (confirmed.status !== 200) throw new Error(`pairing not confirmed: ${confirmed.status}`);
  const token = await post("/api/v1/runner-pairings/token", { deviceCode: pairing.deviceCode });
  const paired = { runnerId: token.runnerId as string, credential: token.token as string };
  const browser = opts.browser ?? false;
  const connect = async (answer: Answerer = opts.answer ?? doing) => {
    const minted = await mintSession(server.url, paired.credential);
    if (minted.status !== 200) throw new Error(`no session: ${minted.status}`);
    paired.credential = minted.body.credential;
    let self: ProtocolRunner | null = null;
    const runner = await connectProtocolRunner(server.url, minted.body.session, {
      browser,
      answer: (req) => answer(req, self as ProtocolRunner),
    });
    self = runner;
    opts.open.push(runner);
    // The hello says what the runner has; the owner's switches say what the agents may use.
    await server.deps.db
      .update(schema.runners)
      .set({
        executors: ["claude_code"],
        access: { folders: [], tools: { claude: true, codex: false, commands: true, browser } },
      })
      .where(eq(schema.runners.id, paired.runnerId));
    return runner;
  };
  return { ...paired, runner: await connect(), connect };
}

/** The requests for `op` the server sent this runner (the ones the test didn't consume with `next`). */
export const requests = (runner: ProtocolRunner, op: string) =>
  runner.frames.filter((f): f is Request => f.type === "request" && f.op === op);
