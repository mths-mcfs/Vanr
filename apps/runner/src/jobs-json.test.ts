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

function run(masks: [string, string][], lines: unknown[]) {
  const home = mkdtempSync(join(dir, "home-"));
  const tools = { claude: true, codex: false, commands: true, browser: false };
  const access = new Access(() => ({
    access: { folders: [], tools },
    workDir: join(home, "ws"),
    paused: false,
  }));
  execFileSync("git", ["init", "-q"], { cwd: access.agentRoot(agent) });
  const out = join(home, "out.jsonl");
  writeFileSync(out, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  const claude = join(home, "claude");
  writeFileSync(claude, `#!/bin/sh\ncat > /dev/null\ncat '${out}'\n`);
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
