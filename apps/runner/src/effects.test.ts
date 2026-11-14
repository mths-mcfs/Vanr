import { afterAll, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sealSecret } from "@vanr/contract";
import { Access, RunnerError } from "./access";
import { Jobs } from "./jobs";
import { execOp, writeOp } from "./ops";
import { serialize } from "./outbound";
import { defaultPolicyContext, sandboxOff } from "./sandbox";
import { type FileId, maskBytes, SecretStore, StreamMasker, sameId } from "./secrets";
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

test("table: nothing at the path is created 0600 and removed at release; a pre-existing equal file is retained", async () => {
  const values = new Map([[agent.id, [{ name: "KEY", target: "file:t-new.pem", value: "secret key" }]]]);
  const store = await storeOf(mkdtempSync(join(dir, "home-")), values);
  const m = await store.materialize(agent, root);
  expect([
    readFileSync(join(root, "t-new.pem"), "utf8"),
    statSync(join(root, "t-new.pem")).mode & 0o777,
  ]).toEqual(["secret key", 0o600]);
  m.release();
  expect(existsSync(join(root, "t-new.pem"))).toBe(false);
  // Equal content does not establish ownership for removal.
  writeFileSync(join(root, "t-new.pem"), "secret key", { mode: 0o600 });
  const again = await (await storeOf(mkdtempSync(join(dir, "home-")), values)).materialize(agent, root);
  again.release();
  expect(readFileSync(join(root, "t-new.pem"), "utf8")).toBe("secret key");
  rmSync(join(root, "t-new.pem"));
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

const mkfifo = (p: string) => {
  if (Bun.spawnSync(["mkfifo", p]).exitCode !== 0) throw new Error("mkfifo");
};
const socketAt = async (p: string) => {
  const server = createServer();
  await new Promise<void>((done) => server.listen(p, done));
  return server;
};

test("table: a FIFO or a socket at the path is rejected at once, never waited on or read", async () => {
  const values = new Map([[agent.id, [{ name: "CONF", target: "file:t-special", value: "secret conf" }]]]);
  rmSync(join(root, "t-special"), { force: true });
  mkfifo(join(root, "t-special"));
  const started = Date.now();
  const fifo = await codeOf(
    (await storeOf(mkdtempSync(join(dir, "home-")), values)).materialize(agent, root),
  );
  expect([
    fifo.startsWith("not_allowed"),
    lstatSync(join(root, "t-special")).isFIFO(),
    Date.now() - started < 2000,
  ]).toEqual([true, true, true]);
  rmSync(join(root, "t-special"));
  // A device cannot be made without root here; a socket is the other kind of special file a user can make.
  const server = await socketAt(join(root, "t-special"));
  try {
    const sock = await codeOf(
      (await storeOf(mkdtempSync(join(dir, "home-")), values)).materialize(agent, root),
    );
    expect([sock.startsWith("not_allowed"), lstatSync(join(root, "t-special")).isSocket()]).toEqual([
      true,
      true,
    ]);
  } finally {
    server.close();
    rmSync(join(root, "t-special"), { force: true });
  }
}, 5_000);

test("table: a FIFO is never adopted, not even for an empty value, and opening it never blocks (in a child, with a deadline)", () => {
  const work = mkdtempSync(join(dir, "fifo-"));
  mkfifo(join(work, "conf"));
  const script = join(work, "check.ts");
  writeFileSync(
    script,
    `import { SecretStore } from ${JSON.stringify(join(import.meta.dir, "secrets.ts"))};
const s = new SecretStore(${JSON.stringify(join(work, "home"))});
await s.unlock(Buffer.alloc(32, 3).toString("base64"), "rnr_1");
Reflect.set(s, "values", async () => [{ name: "EMPTY", target: "file:conf", value: "", browser: null }]);
const out = await s.materialize({ id: "agt_0000000012345678", handle: "lia" }, ${JSON.stringify(work)}).then(() => "adopted", (e) => e.code);
console.log(out);`,
  );
  const child = Bun.spawnSync([process.execPath, script], { timeout: 3000, stdout: "pipe", stderr: "pipe" });
  // Not adopted (the empty value matches a FIFO's size 0) and not hung on the open.
  expect([child.exitCode, child.stdout.toString().trim()]).toEqual([0, "not_allowed"]);
  expect(lstatSync(join(work, "conf")).isFIFO()).toBe(true);
}, 10_000);

test("table: the same path in use, changed by the agent meanwhile: the second command fails instead of getting it", async () => {
  const values = new Map([[agent.id, [{ name: "CONF", target: "file:t-swapped", value: "secret-A" }]]]);
  const store = await storeOf(mkdtempSync(join(dir, "home-")), values);
  const first = await store.materialize(agent, root);
  rmSync(join(root, "t-swapped"));
  writeFileSync(join(root, "t-swapped"), "the agent's own");
  const why = await codeOf(store.materialize(agent, root));
  expect([why.startsWith("not_allowed"), readFileSync(join(root, "t-swapped"), "utf8")]).toEqual([
    true,
    "the agent's own",
  ]);
  first.release();
  expect(readFileSync(join(root, "t-swapped"), "utf8")).toBe("the agent's own");
  rmSync(join(root, "t-swapped"));
});

test("table: a target outside the work folder fails before anything runs (not silently without the value)", async () => {
  const values = new Map([[agent.id, [{ name: "CONF", target: "file:../t-outside", value: "secret conf" }]]]);
  const why = await codeOf((await storeOf(mkdtempSync(join(dir, "home-")), values)).materialize(agent, root));
  expect([why.startsWith("not_allowed"), existsSync(join(root, "..", "t-outside"))]).toEqual([true, false]);
});

test("table: a folder on the way that is a link or a file: nothing is created anywhere, inside or out", async () => {
  const outside = mkdtempSync(join(dir, "outside-"));
  symlinkSync(outside, join(root, "t-hop"));
  writeFileSync(join(root, "t-file"), "a file, not a folder");
  for (const target of ["file:t-hop/new/deep/conf", "file:t-file/conf", "file:t-new/t-hop2/conf"]) {
    const values = new Map([[agent.id, [{ name: "CONF", target, value: "secret conf" }]]]);
    const why = await codeOf(
      (await storeOf(mkdtempSync(join(dir, "home-")), values)).materialize(agent, root),
    );
    if (target.startsWith("file:t-new")) {
      // No link on the way: the missing folders are created one by one and the file goes in.
      expect(why).toBe("went");
      continue;
    }
    expect([target, why.startsWith("not_allowed")]).toEqual([target, true]);
  }
  expect([existsSync(join(outside, "new")), readFileSync(join(root, "t-file"), "utf8")]).toEqual([
    false,
    "a file, not a folder",
  ]);
  rmSync(join(root, "t-new"), { recursive: true, force: true });
});

test("release: what the agent put in place of the file during the command is left; the other files still go", async () => {
  const values = new Map([
    [
      agent.id,
      [
        { name: "A", target: "file:t-r1", value: "secret one" },
        { name: "B", target: "file:t-r2", value: "secret two" },
        { name: "C", target: "file:t-r3", value: "secret three" },
      ],
    ],
  ]);
  const logs: string[] = [];
  const store = new SecretStore(mkdtempSync(join(dir, "home-")), (l) => logs.push(l));
  await store.unlock(Buffer.alloc(32, 3).toString("base64"), "rnr_1");
  Reflect.set(store, "values", async (a: { id: string }) =>
    (values.get(a.id) ?? []).map((v) => ({ ...v, browser: null })),
  );
  const m = await store.materialize(agent, root);
  // During the command: the first becomes a folder, the second a file of the person (the same inode back).
  rmSync(join(root, "t-r1"));
  mkdirSync(join(root, "t-r1"));
  rmSync(join(root, "t-r2"));
  writeFileSync(join(root, "t-r2"), "the person's own");
  m.release();
  expect([
    kind(join(root, "t-r1")),
    readFileSync(join(root, "t-r2"), "utf8"),
    existsSync(join(root, "t-r3")),
  ]).toEqual(["other", "the person's own", false]);
  expect(logs.join("\n")).toContain("t-r2");
  for (const v of ["secret one", "secret two", "secret three"]) expect(logs.join("\n")).not.toContain(v);
  rmSync(join(root, "t-r1"), { recursive: true });
  rmSync(join(root, "t-r2"));
});

test("release: a file that cannot be removed now does not keep the others, is logged and removed at the next release", async () => {
  const values = new Map([
    [
      agent.id,
      [
        { name: "A", target: "file:t-ro/conf", value: "secret one" },
        { name: "B", target: "file:t-after", value: "secret two" },
      ],
    ],
  ]);
  const logs: string[] = [];
  const store = new SecretStore(mkdtempSync(join(dir, "home-")), (l) => logs.push(l));
  await store.unlock(Buffer.alloc(32, 3).toString("base64"), "rnr_1");
  Reflect.set(store, "values", async (a: { id: string }) =>
    (values.get(a.id) ?? []).map((v) => ({ ...v, browser: null })),
  );
  const m = await store.materialize(agent, root);
  chmodSync(join(root, "t-ro"), 0o500);
  m.release();
  // The one that failed does not keep the next from going.
  expect([
    existsSync(join(root, "t-ro", "conf")),
    existsSync(join(root, "t-after")),
    logs.some((l) => l.includes("tries again")),
  ]).toEqual([true, false, true]);
  chmodSync(join(root, "t-ro"), 0o700);
  // The next release (of any op) tries it again.
  (await store.materialize(bob, root)).release();
  expect(existsSync(join(root, "t-ro", "conf"))).toBe(false);
  rmSync(join(root, "t-ro"), { recursive: true });
});

test("property: the agent changes what is at a path at any point between the runner's look and act: the invariants hold and nothing hangs", async () => {
  const r = seeded(18018);
  const rels = ["s-a", "s-b", "s-c"];
  const kinds = ["file", "link", "folder", "fifo", "nothing"] as const;
  let sequences = 0;
  let steps = 0;
  let violations = 0;
  let hung = 0;
  const look = (p: string) => {
    try {
      const l = lstatSync(p);
      return l.isSymbolicLink()
        ? "link"
        : l.isFile()
          ? `file:${readFileSync(p, "utf8")}`
          : l.isFIFO()
            ? "fifo"
            : "folder";
    } catch {
      return "gone";
    }
  };
  writeFileSync(join(root, "inside.txt"), "inside");
  // What the agent put at each path (a swap), which the runner must leave as it is.
  const foreign = new Map<string, string>();
  const swap = (path: string) => {
    if (r.int(3, "swap?") !== 0) return;
    const rel = path.slice(root.length + 1);
    rmSync(path, { recursive: true, force: true });
    const k = r.pick(kinds, "kind");
    if (k === "file") writeFileSync(path, `agent ${rel}`);
    else if (k === "link") symlinkSync(join(root, "inside.txt"), path);
    else if (k === "folder") mkdirSync(path);
    else if (k === "fifo") mkfifo(path);
    foreign.set(rel, look(path));
  };
  for (let round = 0; round < 80; round++) {
    for (const rel of rels) rmSync(join(root, rel), { recursive: true, force: true });
    foreign.clear();
    const values = new Map(
      [agent, bob].map((a) => [
        a.id,
        rels
          .filter(() => r.int(2))
          .map((rel) => ({ name: `S_${rel}`, target: `file:${rel}`, value: r.pick(["v1", "v2"], "value") })),
      ]),
    );
    const home = mkdtempSync(join(dir, "home-"));
    const store = new SecretStore(home, () => {}, {
      beforeCreate: swap,
      beforeLook: swap,
      beforeRemove: swap,
    });
    await store.unlock(Buffer.alloc(32, 3).toString("base64"), "rnr_1");
    Reflect.set(store, "values", async (a: { id: string }) =>
      (values.get(a.id) ?? []).map((v) => ({ ...v, browser: null })),
    );
    const live: { release: () => void; files: Map<string, string> }[] = [];
    for (let i = 0; i < 10; i++) {
      const started = Date.now();
      const a = r.pick([agent, bob], "agent");
      const action = r.int(3, "action");
      if (action === 0) {
        const got = await store.materialize(a, root).then(
          (m) => m,
          () => null,
        );
        if (got) {
          const files = new Map((values.get(a.id) ?? []).map((v) => [v.target.slice(5), v.value]));
          // The command gets what is configured, or does not run.
          for (const [rel, value] of files) if (look(join(root, rel)) !== `file:${value}`) violations++;
          live.push({ release: got.release, files });
        }
      } else if (action === 1 && live.length) live.splice(r.int(live.length), 1)[0]?.release();
      else for (const rel of rels) if (r.int(4) === 0) swap(join(root, rel));
      // What the agent put is as it put it (unless the runner was right to take it: it never is).
      for (const [rel, was] of foreign)
        if (look(join(root, rel)) !== was && !live.some((l) => l.files.has(rel))) violations++;
      if (Date.now() - started > 2000) hung++;
      steps++;
    }
    for (const l of live.splice(0)) l.release();
    // Released: nothing of the runner is left; what is there is the agent's.
    for (const rel of rels) {
      const now = look(join(root, rel));
      if (now !== "gone" && foreign.get(rel) !== now) violations++;
    }
    sequences++;
  }
  for (const rel of rels) rmSync(join(root, rel), { recursive: true, force: true });
  console.log(
    `[secrets-swap] ${sequences} sequences, ${steps} steps, ${violations} violations, ${hung} hung; kinds ${JSON.stringify(r.spread("kind"))}`,
  );
  expect([violations, hung]).toEqual([0, 0]);
}, 60_000);

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

// ---- round 11: short writes, failed checks, the root by its real path, masked logs ----

/** Runs `code` (importing the store) in a child under `ulimit -f 1` (1 KiB files), with a deadline. */
function underFileLimit(code: string): string {
  const work = mkdtempSync(join(dir, "limit-"));
  const script = join(work, "run.ts");
  writeFileSync(
    script,
    `import { SecretStore } from ${JSON.stringify(join(import.meta.dir, "secrets.ts"))};
import { writeOp } from ${JSON.stringify(join(import.meta.dir, "ops.ts"))};
import { Access } from ${JSON.stringify(join(import.meta.dir, "access.ts"))};
import { existsSync, statSync } from "node:fs";
const work = ${JSON.stringify(work)};
${code}`,
  );
  const child = Bun.spawnSync(["bash", "-c", `ulimit -f 1; exec "${process.execPath}" "${script}"`], {
    timeout: 10_000,
    stdout: "pipe",
    stderr: "pipe",
  });
  return child.stdout.toString().trim();
}

test("a secret file that cannot be written whole fails before anything runs and leaves no partial file", () => {
  const out = underFileLimit(`const s = new SecretStore(work + "/home");
await s.unlock(Buffer.alloc(32, 3).toString("base64"), "rnr_1");
Reflect.set(s, "values", async () => [{ name: "BIG", target: "file:big.pem", value: "x".repeat(4096), browser: null }]);
const out = await s.materialize({ id: "agt_0000000012345678", handle: "lia" }, work).then(() => "went", (e) => e.code + "|" + e.message);
console.log(JSON.stringify({ out, left: existsSync(work + "/big.pem") }));`);
  const parsed = JSON.parse(out);
  expect(parsed.left).toBe(false);
  expect(parsed.out).toContain("internal|");
  expect(parsed.out).toContain("big.pem");
});

test("a write of the file ops that is cut by a limit is an error, never a success", () => {
  const out =
    underFileLimit(`const access = new Access(() => ({ access: { folders: [], tools: { claude: false, codex: false, commands: true, browser: false } }, workDir: work + "/ws", paused: false }));
const ctx = { access, agent: null, signal: new AbortController().signal, secrets: { secretFiles: () => [] } };
let out = "went";
try { writeOp(ctx, { path: "big.txt", content: "y".repeat(4096), encoding: "utf8", append: false }); } catch (e) { out = e.code + "|" + e.message; }
console.log(out);`);
  expect(out).toContain("internal|");
  expect(out).toContain("could not be written whole");
});

test("release: a check that fails (no access) keeps the file for a new try, logged once; the next release removes it", async () => {
  const values = new Map([[agent.id, [{ name: "A", target: "file:t-noaccess/conf", value: "secret one" }]]]);
  const logs: string[] = [];
  const store = new SecretStore(mkdtempSync(join(dir, "home-")), (l) => logs.push(l));
  await store.unlock(Buffer.alloc(32, 3).toString("base64"), "rnr_1");
  Reflect.set(store, "values", async (a: { id: string }) =>
    (values.get(a.id) ?? []).map((v) => ({ ...v, browser: null })),
  );
  const m = await store.materialize(agent, root);
  chmodSync(join(root, "t-noaccess"), 0);
  m.release();
  (await store.materialize(bob, root)).release();
  chmodSync(join(root, "t-noaccess"), 0o700);
  expect([
    existsSync(join(root, "t-noaccess", "conf")),
    logs.filter((l) => l.includes("t-noaccess")).length,
  ]).toEqual([true, 1]);
  (await store.materialize(bob, root)).release();
  expect(existsSync(join(root, "t-noaccess", "conf"))).toBe(false);
  rmSync(join(root, "t-noaccess"), { recursive: true });
});

test("release: past the cap of files waiting for a new try, a new one stays and is logged once", async () => {
  const values = new Map([[agent.id, [{ name: "A", target: "file:t-cap/conf", value: "secret one" }]]]);
  const logs: string[] = [];
  const store = new SecretStore(mkdtempSync(join(dir, "home-")), (l) => logs.push(l));
  await store.unlock(Buffer.alloc(32, 3).toString("base64"), "rnr_1");
  Reflect.set(store, "values", async (a: { id: string }) =>
    (values.get(a.id) ?? []).map((v) => ({ ...v, browser: null })),
  );
  // 1000 files already waiting, under a folder the runner cannot look into now: they stay in the list.
  mkdirSync(join(root, "t-cap-locked"));
  const waiting = Reflect.get(store, "toRemove") as Map<string, unknown>;
  for (let i = 0; i < 1000; i++)
    waiting.set(join(root, "t-cap-locked", `f-${i}`), {
      id: { dev: 0n, ino: 0n, birth: 0n },
      name: "X",
      rel: "x",
      masks: [],
    });
  chmodSync(join(root, "t-cap-locked"), 0);
  const m = await store.materialize(agent, root);
  chmodSync(join(root, "t-cap"), 0);
  try {
    m.release();
  } finally {
    chmodSync(join(root, "t-cap"), 0o700);
    chmodSync(join(root, "t-cap-locked"), 0o700);
  }
  expect([waiting.size, logs.filter((l) => l.includes("already wait: it stays")).length]).toEqual([1000, 1]);
  expect(existsSync(join(root, "t-cap", "conf"))).toBe(true);
  rmSync(join(root, "t-cap"), { recursive: true });
  rmSync(join(root, "t-cap-locked"), { recursive: true });
});

test("the root by its real path: a work folder that is a link works (the file goes in its target); a broken or missing one fails", async () => {
  const target = mkdtempSync(join(dir, "real-root-"));
  const linked = join(dir, `linked-root-${Date.now()}`);
  symlinkSync(target, linked);
  const values = new Map([[agent.id, [{ name: "CONF", target: "file:conf", value: "secret conf" }]]]);
  const store = await storeOf(mkdtempSync(join(dir, "home-")), values);
  const m = await store.materialize(agent, linked);
  expect(readFileSync(join(target, "conf"), "utf8")).toBe("secret conf");
  m.release();
  expect(existsSync(join(target, "conf"))).toBe(false);
  const broken = join(dir, `broken-root-${Date.now()}`);
  symlinkSync(join(dir, "nowhere"), broken);
  expect((await codeOf(store.materialize(agent, broken))).startsWith("not_found")).toBe(true);
  expect((await codeOf(store.materialize(agent, join(dir, "missing-root")))).startsWith("not_found")).toBe(
    true,
  );
  // The ops' root is the same real path.
  const access2 = new Access(() => ({ access: { folders: [], tools }, workDir: linked, paused: false }));
  expect(access2.agentRoot(null)).toBe(realpathSync(target));
});

test("the log of a release names the secret and the path in the work folder, masked, never the absolute path", async () => {
  const values = new Map([
    [agent.id, [{ name: "TOKEN", target: "file:SECRET-IN-PATH/conf", value: "SECRET-IN-PATH" }]],
  ]);
  const logs: string[] = [];
  const store = new SecretStore(mkdtempSync(join(dir, "home-")), (l) => logs.push(l));
  await store.unlock(Buffer.alloc(32, 3).toString("base64"), "rnr_1");
  Reflect.set(store, "values", async (a: { id: string }) =>
    (values.get(a.id) ?? []).map((v) => ({ ...v, browser: null })),
  );
  const m = await store.materialize(agent, root);
  rmSync(join(root, "SECRET-IN-PATH", "conf"));
  mkdirSync(join(root, "SECRET-IN-PATH", "conf"));
  m.release();
  expect(logs.length).toBe(1);
  expect([logs[0]?.includes("SECRET-IN-PATH"), logs[0]?.includes(root), logs[0]?.includes("TOKEN")]).toEqual([
    false,
    false,
    true,
  ]);
  rmSync(join(root, "SECRET-IN-PATH"), { recursive: true });
});

test("what is at the path is read without following a link, and a file longer than the value is other content", async () => {
  // A link to a file that holds exactly the value: still a link, not adopted.
  writeFileSync(join(root, "t-same.txt"), "secret conf");
  symlinkSync(join(root, "t-same.txt"), join(root, "t-linkv"));
  // A file that starts with the value and goes on: not the value.
  writeFileSync(join(root, "t-longer"), "secret confAND MORE");
  for (const rel of ["t-linkv", "t-longer"]) {
    const values = new Map([[agent.id, [{ name: "CONF", target: `file:${rel}`, value: "secret conf" }]]]);
    const why = await codeOf(
      (await storeOf(mkdtempSync(join(dir, "home-")), values)).materialize(agent, root),
    );
    expect([rel, why.startsWith("not_allowed")]).toEqual([rel, true]);
  }
  expect([kind(join(root, "t-linkv")), readFileSync(join(root, "t-longer"), "utf8")]).toEqual([
    "link",
    "secret confAND MORE",
  ]);
  for (const f of ["t-same.txt", "t-linkv", "t-longer"]) rmSync(join(root, f));
});

test("the identity is device, inode and birth: each one alone tells two files apart", () => {
  const a: FileId = { dev: 1n, ino: 2n, birth: 3n };
  expect([
    sameId(a, { ...a }),
    sameId(a, { ...a, dev: 9n }),
    sameId(a, { ...a, ino: 9n }),
    sameId(a, { ...a, birth: 9n }),
  ]).toEqual([true, false, false, false]);
});

test("concurrent sealed deliveries retain both secrets", async () => {
  const { store, add } = await storeWith(mkdtempSync(join(dir, "home-")));
  const seal = Reflect.get(store, "seal").bind(store);
  const gate = Promise.withResolvers<void>();
  let sealed = 0;
  Reflect.set(store, "seal", async (value: string, aad: string) => {
    const entry = await seal(value, aad);
    if (!aad.startsWith("pending|")) {
      if (++sealed === 2) gate.resolve();
      await gate.promise;
    }
    return entry;
  });
  await Promise.all([add("FIRST", "env", "a"), add("SECOND", "env", "abc")]);
  expect(
    store
      .list(agent)
      .map((s) => s.name)
      .sort(),
  ).toEqual(["FIRST", "SECOND"]);
  expect(await store.masks(agent)).toContainEqual(["abc", "[secret:SECOND]"]);
  expect(await store.masks(agent)).toContainEqual(["a", "[secret:FIRST]"]);
});

test("a link appearing after write authorization is never followed", () => {
  const target = join(dir, "late-link-target");
  const signal = new AbortController().signal;
  Object.defineProperty(signal, "aborted", {
    get() {
      symlinkSync(target, join(root, "late-link"));
      return false;
    },
  });
  expect(() => write("late-link", signal)).toThrow();
  expect(existsSync(target)).toBe(false);
});

test.each(["q", "zz", "abc"])(
  "stored short secret %s is masked in results, streams and bytes",
  async (value) => {
    const { store, add } = await storeWith(mkdtempSync(join(dir, "home-")));
    await add("PIN", "env", value);
    const masks = await store.masks(agent);
    const text = `PIN=${value}`;
    const stream = new StreamMasker(masks);
    expect(stream.push(text) + stream.end()).toBe("PIN=[secret:PIN]");
    expect(maskBytes(Buffer.from(text), masks).toString()).toBe("PIN=[secret:PIN]");
    expect(
      JSON.parse(
        serialize({ type: "result", id: "short", ok: true, data: { content: text } }, masks) ?? "null",
      ).data.content,
    ).toBe("PIN=[secret:PIN]");
  },
);
