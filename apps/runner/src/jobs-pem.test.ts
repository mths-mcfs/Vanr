import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Access } from "./access";
import type { CliWatch } from "./cli";
import { type JobEvent, Jobs } from "./jobs";
import { defaultPolicyContext, sandboxOff } from "./sandbox";
import type { SecretStore } from "./secrets";

// A job's output with a multi-line secret (a PEM key) that arrives in pieces: no line of it goes out.
const PEM = "-----BEGIN KEY-----\nAAAASECRETLINE1\nBBBBSECRETLINE2\n-----END KEY-----";
const MASKS: [string, string][] = [[PEM, "[secret:PEM]"]];
const dir = mkdtempSync(join(tmpdir(), "runner-jobs-pem-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("a shell job that prints a PEM key in pieces sends no line of it, in events, result or log", async () => {
  const home = join(dir, "home");
  const events: JobEvent[] = [];
  let finished: () => void = () => {};
  const done = new Promise<void>((r) => {
    finished = r;
  });
  const tools = { claude: false, codex: false, commands: true, browser: false };
  const jobs = new Jobs({
    home,
    access: new Access(() => ({ access: { folders: [], tools }, workDir: join(home, "ws"), paused: false })),
    secrets: {
      secretFiles: () => [],
      materialize: async () => ({ env: {}, masks: MASKS, release: () => {} }),
    } as unknown as SecretStore,
    cli: {} as CliWatch,
    maxConcurrent: () => 1,
    maxSeconds: () => 30,
    send: (e) => {
      events.push(e);
      if (e.type === "job.done") finished();
      return true;
    },
    bins: { claude: "claude", codex: "codex" },
    sandbox: sandboxOff(),
    policy: defaultPolicyContext(home),
  });
  const script = join(dir, "pem.ts");
  // The key in three pieces, each one cut in the middle of a line, with pauses so they arrive apart.
  writeFileSync(
    script,
    `const pem = ${JSON.stringify(PEM)};
const parts = [pem.slice(0, 25), pem.slice(25, 45), pem.slice(45)];
for (const p of parts) { process.stdout.write(p); await Bun.sleep(150); }
process.stdout.write("\\nafter\\n");
`,
  );
  await jobs.start(
    { id: "agt_0000000012345678", handle: "lia" },
    {
      jobId: "job_00000001",
      executor: "shell",
      title: "t",
      prompt: `'${process.execPath}' '${script}'`,
    },
  );
  await done;
  const log = readFileSync(join(home, "jobs", "job_00000001", "output.log"), "utf8");
  const sent = JSON.stringify(events);
  for (const piece of ["BEGIN KEY", "SECRETLINE1", "SECRETLINE2", "END KEY"]) {
    expect([piece, sent.includes(piece), log.includes(piece)]).toEqual([piece, false, false]);
  }
  expect(log).toContain("[secret:PEM]");
  expect(log).toContain("after");
});
