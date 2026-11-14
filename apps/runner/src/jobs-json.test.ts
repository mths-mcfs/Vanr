import { afterAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Access } from "./access";
import type { CliWatch } from "./cli";
import { type JobEvent, Jobs } from "./jobs";
import { defaultPolicyContext, sandboxOff } from "./sandbox";
import type { SecretStore } from "./secrets";

// Claude Code writes its output as JSON lines. A secret with a line break, quotes or a backslash shows up
// escaped inside a JSON string (`\n`, `\"`, `\\`); what the runner sends must not hold it in any form, and
// what the runner decides (an API key in place of the plan) must not change because a secret equals a word
// of the protocol.
const dir = mkdtempSync(join(tmpdir(), "runner-jobs-json-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const agent = { id: "agt_0000000012345678", handle: "lia" };

function run(
  masks: [string, string][],
  lines: unknown[],
  seen?: (jobs: Jobs) => void,
  raw?: string,
  before = "",
) {
  const home = mkdtempSync(join(dir, "home-"));
  const tools = { claude: true, codex: false, commands: true, browser: false };
  const access = new Access(() => ({
    access: { folders: [], tools },
    workDir: join(home, "ws"),
    paused: false,
  }));
  execFileSync("git", ["init", "-q"], { cwd: access.agentRoot(agent) });
  const out = join(home, "out.jsonl");
  writeFileSync(out, raw ?? `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  const claude = join(home, "claude");
  writeFileSync(claude, `#!/bin/sh\ncat > /dev/null\n${before}cat '${out}'\n`);
  chmodSync(claude, 0o755);
  const events: JobEvent[] = [];
  let finished: () => void = () => {};
  const done = new Promise<void>((r) => {
    finished = r;
  });
  const jobs = new Jobs({
    home,
    access,
    secrets: {
      secretFiles: () => [],
      materialize: async () => ({ env: {}, masks, release: () => {} }),
    } as unknown as SecretStore,
    cli: { requireSubscription: () => ({}) } as unknown as CliWatch,
    maxConcurrent: () => 1,
    maxSeconds: () => 30,
    send: (e) => {
      events.push(e);
      if (e.type === "job.done") finished();
      return true;
    },
    bins: { claude, codex: "codex" },
    sandbox: sandboxOff(),
    policy: defaultPolicyContext(home),
  });
  seen?.(jobs);
  return jobs
    .start(agent, { jobId: "job_00000001", executor: "claude_code", title: "t", prompt: "go" })
    .then(() => done)
    .then(() => events);
}

test("a secret with a line break, quotes or a backslash, escaped in the JSON, does not reach the server", async () => {
  const secrets = ['ab"cd-0001', "back\\slash-0002", "line one\nline two"];
  const masks = secrets.map((v, i): [string, string] => [v, `[secret:S${i}]`]);
  const events = await run(masks, [
    { type: "assistant", message: { content: secrets.map((text) => ({ type: "text", text })) } },
    { type: "result", result: `done ${secrets.join(" ")}`, session_id: "s1" },
  ]);
  const sent = JSON.stringify(events);
  for (const v of secrets) {
    expect([v, sent.includes(JSON.stringify(v).slice(1, -1))]).toEqual([v, false]);
    for (const part of v.split("\n")) expect([part, sent.includes(part)]).toEqual([part, false]);
  }
  expect(sent).toContain("[secret:S2]");
});

test("a secret equal to a word of the protocol does not hide an API key from the runner", async () => {
  const lines = [{ type: "system", subtype: "init", apiKeySource: "environment" }];
  for (const masks of [[], [["system", "[secret:TOKEN]"]]] as [string, string][][]) {
    const events = await run(masks, lines);
    const done = events.at(-1);
    if (done?.type !== "job.done") throw new Error("expected job.done");
    expect(done.job.status).toBe("failed");
    expect(done.job.result).toContain("would use environment instead of your plan");
  }
});

test("an event nested a hundred thousand times does not blow the stack: the job ends, job.done goes, the slot is free", async () => {
  let jobs: Jobs | undefined;
  const deep = `${"[".repeat(100_000)}"x"${"]".repeat(100_000)}`;
  const raw = `{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":${deep}}]}}\n{"type":"result","result":"ok","session_id":"s1"}\n`;
  const events = await run([["abcd-0001", "[secret:S]"]], [], (j) => (jobs = j), raw);
  const done = events.find((e) => e.type === "job.done");
  expect(done?.type === "job.done" && ["done", "failed"].includes(done.job.status)).toBe(true);
  expect(jobs?.runningCount()).toBe(0);
});

test("any exception while handling a job's output ends the job as failed, sends job.done and frees the slot", async () => {
  let jobs: Jobs | undefined;
  // The CLI turns the job's output log into a folder: the handler throws (EISDIR) on the first line.
  const events = await run(
    [["abcd-0001", "[secret:S]"]],
    [{ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } }],
    (j) => {
      jobs = j;
    },
    undefined,
    `LOG="$(dirname "$0")/jobs/job_00000001/output.log"; rm -f "$LOG"; mkdir "$LOG"\n`,
  );
  const done = events.find((e) => e.type === "job.done");
  expect(done?.type === "job.done" && [done.job.status, done.job.result?.slice(0, 27)]).toEqual([
    "failed",
    "The runner stopped this job",
  ]);
  expect(jobs?.runningCount()).toBe(0);
});
