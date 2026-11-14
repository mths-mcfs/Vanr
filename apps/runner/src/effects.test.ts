import { afterAll, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sealSecret } from "@vanr/contract";
import { Access, RunnerError } from "./access";
import { Jobs } from "./jobs";
import { execOp, writeOp } from "./ops";
import { defaultPolicyContext, sandboxOff } from "./sandbox";
import { SecretStore } from "./secrets";

// What an operation leaves behind: a write keeps the file it writes into (mode, link), the secrets a command
// gets are taken back without touching a file that was there before, and an abort stops the effect.
const dir = mkdtempSync(join(tmpdir(), "runner-effects-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const agent = { id: "agt_0000000012345678", handle: "lia" };
const tools = { claude: false, codex: false, commands: true, browser: false };
const access = new Access(() => ({
  access: { folders: [], tools },
  workDir: join(dir, "ws"),
  paused: false,
}));
const root = access.agentRoot(agent);
const live = () => new AbortController().signal;
const write = (path: string, signal = live()) =>
  writeOp({ access, agent, signal, secrets: { secretFiles: () => [] } } as never, {
    path,
    content: "new",
    encoding: "utf8",
    append: false,
  });
const kind = (p: string) => {
  const l = lstatSync(p);
  return l.isSymbolicLink() ? "link" : l.isFile() ? "file" : "other";
};

test("a write goes into the file itself: its mode and a link stay, a read-only file is not replaced", () => {
  for (const mode of [0o600, 0o755]) {
    const p = join(root, `m${mode.toString(8)}.txt`);
    writeFileSync(p, "old");
    chmodSync(p, mode);
    write(`m${mode.toString(8)}.txt`);
    expect([mode.toString(8), statSync(p).mode & 0o777, readFileSync(p, "utf8")]).toEqual([
      mode.toString(8),
      mode,
      "new",
    ]);
  }
  // Read-only: the write fails and the file stays as it was (a rename would have replaced it).
  const ro = join(root, "ro.txt");
  writeFileSync(ro, "old");
  chmodSync(ro, 0o444);
  expect(() => write("ro.txt")).toThrow();
  expect([statSync(ro).mode & 0o777, readFileSync(ro, "utf8")]).toEqual([0o444, "old"]);
  // A link: the target gets the content and the link stays a link.
  writeFileSync(join(root, "target.txt"), "old");
  symlinkSync(join(root, "target.txt"), join(root, "link.txt"));
  write("link.txt");
  expect([kind(join(root, "link.txt")), readFileSync(join(root, "target.txt"), "utf8")]).toEqual([
    "link",
    "new",
  ]);
  // A new file: the usual mode (0666 less the umask).
  write("fresh.txt");
  expect(statSync(join(root, "fresh.txt")).mode & 0o777).toBe(0o666 & ~process.umask());
});

test("an aborted write writes nothing", () => {
  const c = new AbortController();
  c.abort();
  expect(() => write("aborted.txt", c.signal)).toThrow(RunnerError);
  expect(existsSync(join(root, "aborted.txt"))).toBe(false);
});

async function storeWith(home: string) {
  const store = new SecretStore(home);
  await store.unlock(Buffer.alloc(32, 3).toString("base64"), "rnr_1");
  const add = async (name: string, target: string, value: string, signal?: AbortSignal) => {
    const requestId = `sreq_${name}`;
    const { publicKey } = await store.prepare(requestId);
    const binding = { requestId, workspaceId: "workspace_1", name, target, browser: null };
    const box = await sealSecret(publicKey, value, binding);
    return store.store(agent, { requestId, workspaceId: "workspace_1", name, target, box }, signal);
  };
  return { store, add };
}

const codeOf = (p: Promise<unknown>) =>
  p.then(
    () => "went",
    (e) => (e instanceof RunnerError ? `${e.code}: ${e.message}` : String(e)),
  );

test("a path the runner did not write stops the op before it runs: the person's file stays, nothing is written", async () => {
  const home = mkdtempSync(join(dir, "home-"));
  const { store, add } = await storeWith(home);
  await add("CONF", "file:conf.json", "secret conf");
  await add("KEY", "file:key.pem", "secret key");
  writeFileSync(join(root, "conf.json"), "the person's own config");
  const why = await codeOf(store.materialize(agent, root));
  expect(why).toContain("not_allowed");
  expect(why).toContain("CONF");
  expect(why).toContain("conf.json");
  // Checked before any file is written: the other secret's file is not there either.
  expect([readFileSync(join(root, "conf.json"), "utf8"), existsSync(join(root, "key.pem"))]).toEqual([
    "the person's own config",
    false,
  ]);
  rmSync(join(root, "conf.json"));
  // A link in the path: the same, and the link and its target stay.
  writeFileSync(join(root, "elsewhere.txt"), "not a secret");
  symlinkSync(join(root, "elsewhere.txt"), join(root, "conf.json"));
  expect(await codeOf(store.materialize(agent, root))).toContain("not_allowed");
  expect([kind(join(root, "conf.json")), readFileSync(join(root, "elsewhere.txt"), "utf8")]).toEqual([
    "link",
    "not a secret",
  ]);
  rmSync(join(root, "conf.json"));
});

test("a secret file left by a stop is the runner's: removed when the store opens, or written again with the current value", async () => {
  const home = mkdtempSync(join(dir, "home-"));
  const { store, add } = await storeWith(home);
  await add("TOKEN", "file:token.txt", "value one");
  await store.materialize(agent, root);
  // The runner stops here, between writing and releasing: the file and the register keep the path.
  expect(readFileSync(join(root, "token.txt"), "utf8")).toBe("value one");
  // A new process (a new store on the same folder): the value changed meanwhile.
  const again = new SecretStore(home);
  const writeFirst = readFileSync(join(home, "secrets", "materialized.json"), "utf8");
  expect(writeFirst).toContain("token.txt");
  await again.unlock(Buffer.alloc(32, 3).toString("base64"), "rnr_1");
  // Opening the store removed the leftover.
  expect(existsSync(join(root, "token.txt"))).toBe(false);
  // Left again, and materialized without a restart in between: the current value is written over it.
  writeFileSync(join(root, "token.txt"), "value one", { mode: 0o600 });
  writeFileSync(join(home, "secrets", "materialized.json"), JSON.stringify([join(root, "token.txt")]));
  await add("TOKEN", "file:token.txt", "value two");
  // The process that stopped is gone: the one that materializes now is the new one.
  const m = await again.materialize(agent, root);
  expect(readFileSync(join(root, "token.txt"), "utf8")).toBe("value two");
  m.release();
  expect(existsSync(join(root, "token.txt"))).toBe(false);
  expect(readFileSync(join(home, "secrets", "materialized.json"), "utf8")).not.toContain("token.txt");
});

test("two commands with the same secret file share it: the use count still holds", async () => {
  const home = mkdtempSync(join(dir, "home-"));
  const { store, add } = await storeWith(home);
  await add("KEY", "file:shared.pem", "secret key");
  const first = await store.materialize(agent, root);
  const second = await store.materialize(agent, root);
  first.release();
  expect(readFileSync(join(root, "shared.pem"), "utf8")).toBe("secret key");
  second.release();
  expect(existsSync(join(root, "shared.pem"))).toBe(false);
});

test("a register that cannot be read removes nothing: in doubt, what is there is not the runner's", async () => {
  const home = mkdtempSync(join(dir, "home-"));
  const { store, add } = await storeWith(home);
  await add("TOKEN", "file:doubt.txt", "secret token");
  writeFileSync(join(root, "doubt.txt"), "someone's file");
  writeFileSync(join(home, "secrets", "materialized.json"), "{ not json");
  const again = new SecretStore(home);
  await again.unlock(Buffer.alloc(32, 3).toString("base64"), "rnr_1");
  expect(readFileSync(join(root, "doubt.txt"), "utf8")).toBe("someone's file");
  expect(await codeOf(store.materialize(agent, root))).toContain("not_allowed");
  expect(readFileSync(join(root, "doubt.txt"), "utf8")).toBe("someone's file");
  rmSync(join(root, "doubt.txt"));
});

test("aborted while the values are read, nothing is materialized", async () => {
  const home = mkdtempSync(join(dir, "home-"));
  const { store, add } = await storeWith(home);
  await add("TOKEN", "file:abort-token.txt", "secret token");
  const c = new AbortController();
  const pending = store.materialize(agent, root, c.signal);
  c.abort();
  expect(
    await pending.then(
      () => "went",
      (e) => (e instanceof RunnerError ? e.code : String(e)),
    ),
  ).toBe("canceled");
  expect(existsSync(join(root, "abort-token.txt"))).toBe(false);
});

test("a secret.store or a secret.prepare aborted while it opens and seals writes nothing", async () => {
  const home = mkdtempSync(join(dir, "home-"));
  const { store, add } = await storeWith(home);
  // store: aborted right after it starts (it is at its first await); the check before the write stops it.
  const c = new AbortController();
  const stored = add("LATE", "env", "secret late", c.signal);
  await Promise.resolve();
  c.abort();
  expect(
    await stored.then(
      () => "stored",
      (e) => (e instanceof RunnerError ? e.code : String(e)),
    ),
  ).toBe("canceled");
  expect(store.list(agent).map((s) => s.name)).toEqual([]);
  // prepare: the key of the request is not written.
  const p = new AbortController();
  const prepared = store.prepare("sreq_aborted", p.signal);
  p.abort();
  expect(
    await prepared.then(
      () => "written",
      (e) => (e instanceof RunnerError ? e.code : String(e)),
    ),
  ).toBe("canceled");
  expect(existsSync(join(home, "secrets", "pending", "sreq_aborted.json"))).toBe(false);
});

test("exec and job.start with a secret path taken by the person run nothing", async () => {
  const home = mkdtempSync(join(dir, "home-"));
  const { store, add } = await storeWith(home);
  await add("CONF", "file:taken.json", "secret conf");
  writeFileSync(join(root, "taken.json"), "the person's own");
  const marker = join(dir, "ran");
  const ctx = {
    access,
    secrets: store,
    sandbox: sandboxOff(),
    policy: defaultPolicyContext(home),
    agent,
    signal: live(),
  };
  expect(await codeOf(execOp(ctx, { command: `touch '${marker}'` }))).toContain("not_allowed");
  const jobs = new Jobs({
    home,
    access,
    secrets: store,
    cli: {} as never,
    maxConcurrent: () => 3,
    maxSeconds: () => 30,
    send: () => true,
    bins: { claude: "claude", codex: "codex" },
    sandbox: sandboxOff(),
    policy: defaultPolicyContext(home),
  });
  expect(
    await codeOf(
      jobs.start(agent, {
        jobId: "job_00000001",
        executor: "shell",
        title: "t",
        prompt: `touch '${marker}'`,
      }),
    ),
  ).toContain("not_allowed");
  expect([existsSync(marker), jobs.pending().length, readFileSync(join(root, "taken.json"), "utf8")]).toEqual(
    [false, 0, "the person's own"],
  );
  rmSync(join(root, "taken.json"));
});
