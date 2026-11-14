import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Access, RunnerError } from "./access";
import type { CliWatch } from "./cli";
import { type JobEvent, Jobs } from "./jobs";
import { defaultPolicyContext, sandboxOff } from "./sandbox";
import type { SecretStore } from "./secrets";

// Two `job.start` arriving in the same tick: the id and the slot are taken before the first await, so the
// job runs once and the cap is never exceeded; a start that fails gives both back.
const dir = mkdtempSync(join(tmpdir(), "runner-jobs-start-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const agent = { id: "agt_0000000012345678", handle: "lia" };
let n = 0;

function setup(opts: { max: number; failSecrets?: () => boolean }) {
  const home = join(dir, `home-${++n}`);
  const done: JobEvent[] = [];
  const waiters: (() => void)[] = [];
  const tools = { claude: false, codex: false, commands: true, browser: false };
  const secrets = {
    secretFiles: () => [],
    materialize: async () => {
      await Promise.resolve();
      if (opts.failSecrets?.()) throw new RunnerError("internal", "Secrets are locked");
      return { env: {}, masks: [], release: () => {} };
    },
  } as unknown as SecretStore;
  const jobs = new Jobs({
    home,
    access: new Access(() => ({ access: { folders: [], tools }, workDir: join(home, "ws"), paused: false })),
    secrets,
    cli: {} as CliWatch,
    maxConcurrent: () => opts.max,
    maxSeconds: () => 30,
    send: (e) => {
      if (e.type === "job.done") {
        done.push(e);
        for (const w of waiters.splice(0)) w();
      }
      return true;
    },
    bins: { claude: "claude", codex: "codex" },
    sandbox: sandboxOff(),
    policy: defaultPolicyContext(home),
  });
  const untilDone = (count: number) =>
    new Promise<void>((resolve) => {
      const check = () => (done.length >= count ? resolve() : waiters.push(check));
      check();
    });
  return { jobs, done, untilDone, mark: join(home, "ran") };
}

const shell = (jobId: string, mark: string, prompt = `printf ran >> '${mark}'`) => ({
  jobId,
  executor: "shell" as const,
  title: "t",
  prompt,
});
const reason = (r: PromiseSettledResult<unknown>) =>
  r.status === "rejected" && r.reason instanceof RunnerError
    ? `${r.reason.code}: ${r.reason.message}`
    : r.status;

test("two starts with the same id in the same tick run the job once; the second gets the repeated-id error", async () => {
  const { jobs, untilDone, mark } = setup({ max: 3 });
  const results = await Promise.allSettled([
    jobs.start(agent, shell("job_00000001", mark)),
    jobs.start(agent, shell("job_00000001", mark)),
  ]);
  expect(results.map(reason)).toEqual(["fulfilled", "bad_request: Job id already used"]);
  await untilDone(1);
  await Bun.sleep(200);
  expect(readFileSync(mark, "utf8")).toBe("ran");
});

test("two starts of different jobs in the same tick never pass the cap", async () => {
  const { jobs, untilDone, mark } = setup({ max: 1 });
  const results = await Promise.allSettled([
    jobs.start(agent, shell("job_00000001", mark)),
    jobs.start(agent, shell("job_00000002", mark)),
  ]);
  expect(results.map(reason)).toEqual([
    "fulfilled",
    "no_slot: This environment is already running its maximum of jobs",
  ]);
  await untilDone(1);
  // The slot is free again once the job ended.
  await jobs.start(agent, shell("job_00000003", mark));
  await untilDone(2);
  expect(readFileSync(mark, "utf8")).toBe("ranran");
});

test("a start that fails while preparing gives the id and the slot back", async () => {
  let fail = true;
  const { jobs, untilDone, mark } = setup({ max: 1, failSecrets: () => fail });
  const failed = await Promise.allSettled([jobs.start(agent, shell("job_00000001", mark))]);
  expect(failed.map(reason)).toEqual(["internal: Secrets are locked"]);
  fail = false;
  await jobs.start(agent, shell("job_00000001", mark));
  await untilDone(1);
  expect(readFileSync(mark, "utf8")).toBe("ran");
});
