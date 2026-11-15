import { afterAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  known?: () => [string, string][],
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
    knownMasks: () => known?.() ?? [],
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

test("the lines of a job are one flow: a secret of two lines split between two events goes out in neither", async () => {
  let jobs: Jobs | undefined;
  const say = (text: string) => ({ type: "assistant", message: { content: [{ type: "text", text }] } });
  const events = await run(
    [["first half\nsecond half", "[secret:M]"]],
    [
      say("before"),
      say("first half"),
      say("second half"),
      say("after"),
      { type: "result", result: "ok", session_id: "s1" },
    ],
    (j) => {
      jobs = j;
    },
  );
  const log = jobs?.output("job_00000001", 200).lines ?? [];
  expect(log).toEqual(["before", "[secret:M]", "after"]);
  const sent = JSON.stringify(events);
  expect(sent.includes("first half") || sent.includes("second half")).toBe(false);
  // The last line goes before the job.done.
  const last = events.findLastIndex((e) => e.type === "job.event");
  expect(last).toBeLessThan(events.findIndex((e) => e.type === "job.done"));
});

test("a secret the runner learns while a job runs masks the job's lines and its end from then on", async () => {
  let known: [string, string][] = [];
  let jobs: Jobs | undefined;
  const say = (text: string) => ({ type: "assistant", message: { content: [{ type: "text", text }] } });
  // The double of the CLI says when it started and writes its output only when the test lets it: no timer.
  const gate = join(mkdtempSync(join(dir, "gate-")), "gate");
  const pending = run(
    [],
    [say("the token is NEW-SECRET-77"), { type: "result", result: "done NEW-SECRET-77", session_id: "s1" }],
    (j) => {
      jobs = j;
    },
    undefined,
    `touch '${gate}.ready'\nwhile [ ! -f '${gate}.go' ]; do sleep 0.01; done\n`,
    () => known,
  );
  await until(() => existsSync(`${gate}.ready`));
  // The person gives the secret while the job runs (the welcome of a reconnection, a secret.store).
  known = [["NEW-SECRET-77", "[secret:N]"]];
  writeFileSync(`${gate}.go`, "");
  const events = await pending;
  expect(JSON.stringify(events)).not.toContain("NEW-SECRET-77");
  expect(jobs?.output("job_00000001", 200).lines).toEqual(["the token is [secret:N]"]);
  const done = events.find((e) => e.type === "job.done");
  expect(done?.type === "job.done" && done.job.result).toBe("done [secret:N]");
});

/** Waits for a condition the code under test makes true (a file its double writes), not for a time. */
async function until(condition: () => boolean) {
  while (!condition()) await Bun.sleep(5);
}
