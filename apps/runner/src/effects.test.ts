import { afterAll, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
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
import { seeded } from "./testing/random";

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

// ---- one test per row of the table in SecretStore.materialize ----

/** A store whose values the test sets per agent (the read path of `materialize`), unlocked. */
async function storeOf(home: string, values: Map<string, { name: string; target: string; value: string }[]>) {
  const store = new SecretStore(home);
  await store.unlock(Buffer.alloc(32, 3).toString("base64"), "rnr_1");
  Reflect.set(store, "values", async (a: { id: string }) =>
    (values.get(a.id) ?? []).map((v) => ({ ...v, browser: null })),
  );
  return store;
}
const bob = { id: "agt_0000000087654321", handle: "bob" };

test("table: nothing at the path is created 0600 and removed at release; the same value there is adopted and removed", async () => {
  const values = new Map([[agent.id, [{ name: "KEY", target: "file:t-new.pem", value: "secret key" }]]]);
  const store = await storeOf(mkdtempSync(join(dir, "home-")), values);
  const m = await store.materialize(agent, root);
  expect([
    readFileSync(join(root, "t-new.pem"), "utf8"),
    statSync(join(root, "t-new.pem")).mode & 0o777,
  ]).toEqual(["secret key", 0o600]);
  m.release();
  expect(existsSync(join(root, "t-new.pem"))).toBe(false);
  // A leftover of a stop (a new process, the same value): adopted, then removed at release.
  writeFileSync(join(root, "t-new.pem"), "secret key", { mode: 0o600 });
  const again = await (await storeOf(mkdtempSync(join(dir, "home-")), values)).materialize(agent, root);
  again.release();
  expect(existsSync(join(root, "t-new.pem"))).toBe(false);
});

test("table: other content, a link (inside, outside, broken) or a folder at the path is left as it is and nothing runs", async () => {
  const outside = mkdtempSync(join(dir, "outside-"));
  writeFileSync(join(outside, "target.txt"), "outside the work folder");
  writeFileSync(join(root, "inside.txt"), "inside");
  const cases: [string, () => void, () => unknown][] = [
    [
      "other content",
      () => writeFileSync(join(root, "t-x"), "the person's own"),
      () => readFileSync(join(root, "t-x"), "utf8"),
    ],
    [
      "a link inside",
      () => symlinkSync(join(root, "inside.txt"), join(root, "t-x")),
      () => [kind(join(root, "t-x")), readFileSync(join(root, "inside.txt"), "utf8")],
    ],
    [
      "a link outside",
      () => symlinkSync(join(outside, "target.txt"), join(root, "t-x")),
      () => [kind(join(root, "t-x")), readFileSync(join(outside, "target.txt"), "utf8")],
    ],
    [
      "a broken link",
      () => symlinkSync(join(outside, "nowhere.txt"), join(root, "t-x")),
      () => [kind(join(root, "t-x")), existsSync(join(outside, "nowhere.txt"))],
    ],
    ["a folder", () => mkdirSync(join(root, "t-x")), () => kind(join(root, "t-x"))],
  ];
  for (const [label, put, look] of cases) {
    rmSync(join(root, "t-x"), { recursive: true, force: true });
    put();
    const before = look();
    const values = new Map([
      [
        agent.id,
        [
          { name: "KEY", target: "file:t-ok.pem", value: "ok" },
          { name: "CONF", target: "file:t-x", value: "secret conf" },
        ],
      ],
    ]);
    const why = await codeOf(
      (await storeOf(mkdtempSync(join(dir, "home-")), values)).materialize(agent, root),
    );
    expect([label, why.startsWith("not_allowed"), why.includes("CONF") && why.includes("t-x")]).toEqual([
      label,
      true,
      true,
    ]);
    // Untouched, and the secret that was fine was taken back (nothing runs).
    expect([label, look(), existsSync(join(root, "t-ok.pem"))]).toEqual([label, before, false]);
    expect(why).not.toContain("secret conf");
  }
  rmSync(join(root, "t-x"), { recursive: true, force: true });
});

test("table: a folder on the way that leads out of the work folder: nothing is written outside", async () => {
  const outside = mkdtempSync(join(dir, "outside-"));
  symlinkSync(outside, join(root, "t-out"));
  const values = new Map([
    [agent.id, [{ name: "CONF", target: "file:t-out/conf.json", value: "secret conf" }]],
  ]);
  const why = await codeOf((await storeOf(mkdtempSync(join(dir, "home-")), values)).materialize(agent, root));
  expect(why.startsWith("not_allowed")).toBe(true);
  expect(existsSync(join(outside, "conf.json"))).toBe(false);
});

test("table: the same path in use here: the same value is shared (use count), another value is rejected", async () => {
  const values = new Map([
    [agent.id, [{ name: "CONF", target: "file:t-shared", value: "secret-A" }]],
    [bob.id, [{ name: "CONF", target: "file:t-shared", value: "secret-B" }]],
  ]);
  const store = await storeOf(mkdtempSync(join(dir, "home-")), values);
  const first = await store.materialize(agent, root);
  const second = await store.materialize(agent, root);
  const why = await codeOf(store.materialize(bob, root));
  expect([why.startsWith("not_allowed"), why.includes("in use") || why.includes("using")]).toEqual([
    true,
    true,
  ]);
  expect(readFileSync(join(root, "t-shared"), "utf8")).toBe("secret-A");
  first.release();
  expect(readFileSync(join(root, "t-shared"), "utf8")).toBe("secret-A");
  second.release();
  expect(existsSync(join(root, "t-shared"))).toBe(false);
});

test("a secret changed after a stop: the old file stays and the command fails naming the path", async () => {
  writeFileSync(join(root, "t-old"), "old value", { mode: 0o600 });
  const values = new Map([[agent.id, [{ name: "TOKEN", target: "file:t-old", value: "new value" }]]]);
  const why = await codeOf((await storeOf(mkdtempSync(join(dir, "home-")), values)).materialize(agent, root));
  expect([
    why.startsWith("not_allowed"),
    why.includes("t-old"),
    readFileSync(join(root, "t-old"), "utf8"),
  ]).toEqual([true, true, "old value"]);
  rmSync(join(root, "t-old"));
});

test("property: in any sequence (materialize, release, abort, stop, new value), no file the runner did not create or adopt is touched", async () => {
  const r = seeded(17017);
  const rels = ["g-a", "g-b", "g-c"];
  const pool = ["v1", "v2", "v3"];
  const agents = [agent, bob];
  let steps = 0;
  let sequences = 0;
  let violations = 0;
  writeFileSync(join(root, "inside.txt"), "inside");
  const look = (p: string) => {
    try {
      const l = lstatSync(p);
      return l.isSymbolicLink() ? "link" : l.isFile() ? `file:${readFileSync(p, "utf8")}` : "folder";
    } catch {
      return "gone";
    }
  };
  for (let round = 0; round < 150; round++) {
    for (const rel of rels) rmSync(join(root, rel), { recursive: true, force: true });
    // Some paths are taken before anything runs: the person's file, a link, a folder.
    const foreign = new Map<string, string>();
    for (const rel of rels) {
      const k = r.int(5, "pre");
      if (k === 0) {
        writeFileSync(join(root, rel), `person ${rel}`);
        foreign.set(rel, `file:person ${rel}`);
      } else if (k === 1) {
        symlinkSync(join(root, "inside.txt"), join(root, rel));
        foreign.set(rel, "link");
      } else if (k === 2) {
        mkdirSync(join(root, rel));
        foreign.set(rel, "folder");
      }
    }
    const current = new Map(
      agents.map((a) => [
        a.id,
        rels
          .filter(() => r.int(2))
          .map((rel) => ({ name: `S_${rel}`, target: `file:${rel}`, value: r.pick(pool, "value") })),
      ]),
    );
    const home = mkdtempSync(join(dir, "home-"));
    let store = await storeOf(home, current);
    let live: { release: () => void; files: Map<string, string> }[] = [];
    // What a stopped process had in use: it may stay (left out on purpose) until adopted again.
    const leftovers = new Set<string>();
    for (let i = 0; i < 12; i++) {
      const action = r.int(5, "action");
      const a = r.pick(agents, "agent");
      if (action === 0 || action === 1) {
        const c = new AbortController();
        if (action === 1) c.abort();
        const got = await store.materialize(a, root, c.signal).then(
          (m) => m,
          () => null,
        );
        if (got) {
          // The command gets what is configured, or does not run.
          const files = new Map((current.get(a.id) ?? []).map((v) => [v.target.slice(5), v.value]));
          for (const [rel, value] of files) if (readFileSync(join(root, rel), "utf8") !== value) violations++;
          live.push({ release: got.release, files });
        }
      } else if (action === 2 && live.length) {
        live.splice(r.int(live.length), 1)[0]?.release();
      } else if (action === 3) {
        // A stop: a new process on the same folders; what the old one had in use is left as it was.
        for (const l of live) for (const rel of l.files.keys()) leftovers.add(rel);
        live = [];
        store = await storeOf(home, current);
      } else {
        const list = current.get(a.id) ?? [];
        const v = list[r.int(Math.max(list.length, 1))];
        if (v) v.value = r.pick(pool, "value");
      }
      // The person's things are as they were.
      for (const [rel, was] of foreign) if (look(join(root, rel)) !== was) violations++;
      steps++;
    }
    // Released, nothing created or adopted by the live process is left.
    for (const l of live.splice(0)) l.release();
    for (const rel of rels)
      if (!foreign.has(rel) && !leftovers.has(rel) && look(join(root, rel)) !== "gone") violations++;
    sequences++;
  }
  console.log(
    `[secrets-seq] ${sequences} sequences, ${steps} steps, ${violations} violations; actions ${JSON.stringify(r.spread("action"))}`,
  );
  expect(violations).toBe(0);
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
