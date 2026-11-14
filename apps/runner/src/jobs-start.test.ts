import { afterAll, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

function setup(opts: { max: number; failSecrets?: () => boolean; waitSecrets?: () => Promise<void> }) {
  const home = join(dir, `home-${++n}`);
  const done: JobEvent[] = [];
  const waiters: (() => void)[] = [];
  const tools = { claude: false, codex: false, commands: true, browser: false };
  const secrets = {
    secretFiles: () => [],
    materialize: async () => {
      await (opts.waitSecrets?.() ?? Promise.resolve());
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

test("a job canceled while it prepares runs nothing, ends as canceled and gives its slot back", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const { jobs, done, untilDone, mark } = setup({ max: 1, waitSecrets: () => gate });
  const start = jobs.start(agent, shell("job_00000001", mark));
  expect(jobs.cancel("job_00000001")).toEqual({ canceled: true });
  release();
  await start;
  await untilDone(1);
  const end = done[0];
  expect(end?.type === "job.done" && end.job.status).toBe("canceled");
  await Bun.sleep(200);
  expect(existsSync(mark)).toBe(false);
  // The slot is free again.
  await jobs.start(agent, shell("job_00000002", mark));
  await untilDone(2);
  expect(readFileSync(mark, "utf8")).toBe("ran");
});

test("sandbox failure removes the job's git snapshot", async () => {
  const { jobs } = setup({ max: 1 });
  const opts = Reflect.get(jobs, "opts");
  opts.access.access.tools.claude = true;
  opts.cli = { requireSubscription() {} };
  opts.sandbox = {
    status: () => ({ state: "on" }),
    wrap: async () => {
      throw new RunnerError("sandbox_not_ready", "no sandbox");
    },
  };
  const root = opts.access.agentRoot(agent);
  execFileSync("git", ["init", "-q"], { cwd: root });
  writeFileSync(join(root, "document.txt"), "snapshot-copy");
  await expect(
    jobs.start(agent, { jobId: "job_snapshot", executor: "claude_code", title: "t", prompt: "hi" }),
  ).rejects.toMatchObject({ code: "sandbox_not_ready" });
  expect(existsSync(join(opts.home, "jobs", "job_snapshot", "snapshot.git"))).toBe(false);
  expect(jobs.runningCount()).toBe(0);
});

test("Node survives a prompt write to a CLI that exits without reading stdin", async () => {
  const home = mkdtempSync(join(dir, "epipe-"));
  const entry = join(home, "entry.ts");
  writeFileSync(
    entry,
    `import { Jobs } from ${JSON.stringify(new URL("./jobs.ts", import.meta.url).pathname)};
import { Access } from ${JSON.stringify(new URL("./access.ts", import.meta.url).pathname)};
import { sandboxOff, defaultPolicyContext } from ${JSON.stringify(new URL("./sandbox.ts", import.meta.url).pathname)};
const home = ${JSON.stringify(home)}, done = Promise.withResolvers(); let released = false;
const jobs = new Jobs({ home, access: new Access(() => ({access:{folders:[],tools:{claude:true}}, workDir:home+'/work',paused:false})),
secrets:{secretFiles:()=>[], materialize:async()=>({env:{},masks:[],release(){released=true;}})}, cli:{requireSubscription(){}},
sandbox:sandboxOff(),policy:defaultPolicyContext(home),bins:{claude:'/bin/false'}, maxConcurrent:()=>1,maxSeconds:()=>5,
send(e){if(e.type==='job.done') done.resolve(e.job);return true;}});
await jobs.start(${JSON.stringify(agent)}, {jobId:'job_epipe',executor:'claude_code',title:'t',prompt:'漢'.repeat(100000)});
const result=await done.promise; console.log(JSON.stringify({status:result.status,released,running:jobs.runningCount()}));`,
  );
  const out = await Bun.build({ entrypoints: [entry], target: "node", format: "esm" });
  expect(out.success).toBe(true);
  const bundle = join(home, "test.mjs");
  writeFileSync(bundle, (await out.outputs[0]?.text()) ?? "");
  const result = spawnSync(Bun.which("node") ?? "node", [bundle], { encoding: "utf8", timeout: 15000 });
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ status: "failed", released: true, running: 0 });
});
