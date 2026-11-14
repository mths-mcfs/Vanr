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
import { writeOp } from "./ops";
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

test("the secret files of a command are taken back without touching a file that was there before", async () => {
  const home = mkdtempSync(join(dir, "home-"));
  const { store, add } = await storeWith(home);
  await add("CONF", "file:conf.json", "secret conf");
  await add("KEY", "file:key.pem", "secret key");
  writeFileSync(join(root, "conf.json"), "the person's own config");
  const first = await store.materialize(agent, root);
  const second = await store.materialize(agent, root);
  // The person's file is not overwritten; the new one is written once and shared by the use count.
  expect(readFileSync(join(root, "conf.json"), "utf8")).toBe("the person's own config");
  expect(readFileSync(join(root, "key.pem"), "utf8")).toBe("secret key");
  first.release();
  expect(existsSync(join(root, "key.pem"))).toBe(true);
  second.release();
  expect([existsSync(join(root, "key.pem")), readFileSync(join(root, "conf.json"), "utf8")]).toEqual([
    false,
    "the person's own config",
  ]);
  rmSync(join(root, "conf.json"));
});

test("aborted while the values are read, nothing is materialized", async () => {
  const home = mkdtempSync(join(dir, "home-"));
  const { store, add } = await storeWith(home);
  await add("TOKEN", "file:token.txt", "secret token");
  const c = new AbortController();
  const pending = store.materialize(agent, root, c.signal);
  c.abort();
  expect(
    await pending.then(
      () => "went",
      (e) => (e instanceof RunnerError ? e.code : String(e)),
    ),
  ).toBe("canceled");
  expect(existsSync(join(root, "token.txt"))).toBe(false);
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
