import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Access } from "./access";
import { execOp, listOp, type OpContext, readOp } from "./ops";
import { defaultPolicyContext, sandboxOff } from "./sandbox";
import { maskBytes, type SecretStore } from "./secrets";
import { seeded } from "./testing/random";

// The mask of a command's output is the last barrier before the model: a secret cut between two pieces of
// the stream, or by the cap of the captured output, never shows up, not even in part.
const dir = mkdtempSync(join(tmpdir(), "runner-ops-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const SECRET = "abcdEFGH";
const emit = join(dir, "emit.ts");
writeFileSync(
  emit,
  `if (process.argv[2] === "pieces") {
  process.stdout.write("abcd");
  setTimeout(() => process.stdout.write("EFGH"), 250);
} else {
  process.stdout.write("x".repeat(999_996) + "abcdEFGH" + "y".repeat(2_000_000));
}
`,
);

function ctx(streamed: string[]): OpContext {
  const tools = { claude: false, codex: false, commands: true, browser: false };
  const store = {
    materialize: async () => ({
      env: {},
      masks: [[SECRET, "[secret:S]"]] as [string, string][],
      release: () => {},
    }),
    masks: async () => [[SECRET, "[secret:S]"]],
    secretFiles: () => [],
  } as unknown as SecretStore;
  return {
    access: new Access(() => ({ access: { folders: [], tools }, workDir: join(dir, "ws"), paused: false })),
    secrets: store,
    sandbox: sandboxOff(),
    policy: defaultPolicyContext(join(dir, "home")),
    agent: { id: "agt_0000000012345678", handle: "lia" },
    signal: new AbortController().signal,
    onOutput: (_stream, chunk) => streamed.push(chunk),
  };
}

test("a secret split between two pieces of the stream does not go out in either", async () => {
  const streamed: string[] = [];
  const r = await execOp(ctx(streamed), { command: `'${process.execPath}' '${emit}' pieces` });
  expect(streamed.length).toBeGreaterThan(0);
  expect(streamed.join("")).toBe("[secret:S]");
  for (const piece of streamed) expect(piece).not.toContain("abcd");
  expect(r.stdout).toBe("[secret:S]");
});

test("a secret across the cap of the captured output is masked before the cut, not half shown", async () => {
  const r = await execOp(ctx([]), { command: `'${process.execPath}' '${emit}' cut` });
  expect(r.truncated).toBe(true);
  expect(r.stdout).not.toContain("abcd");
  expect(r.stdout).not.toContain("EFGH");
  expect(r.stdout.startsWith("x".repeat(1000))).toBe(true);
  expect(r.stdout.endsWith("y".repeat(1000))).toBe(true);
}, 30_000);

test("a file the agent reads, holding a secret's value, comes back masked, also when the read cuts it", async () => {
  const c = ctx([]);
  const root = c.access.agentRoot(c.agent);
  writeFileSync(join(root, "notes.txt"), `token=${SECRET}\n`);
  const whole = await readOp(c, { path: "notes.txt" });
  expect(whole.content).toBe("token=[secret:S]\n");
  // The cut falls inside the secret: no part of it shows.
  const cut = await readOp(c, { path: "notes.txt", maxBytes: 9 });
  expect(cut.content).not.toContain("abc");
  expect(cut.truncated).toBe(true);
});

test("a file name that carries a secret's value is masked in the listing", async () => {
  const c = ctx([]);
  const root = c.access.agentRoot(c.agent);
  writeFileSync(join(root, `${SECRET}.txt`), "x");
  const names = (await listOp(c, { path: "." })).entries.map((e) => e.name);
  expect(names).toContain("[secret:S].txt");
  expect(names.join(" ")).not.toContain(SECRET);
});

test("a read that would come back as base64 (a NUL byte, a cut inside a character) is masked in its bytes", async () => {
  const c = ctx([]);
  const root = c.access.agentRoot(c.agent);
  writeFileSync(join(root, "nul.bin"), `\0${SECRET}`);
  const nul = await readOp(c, { path: "nul.bin" });
  expect(nul.encoding).toBe("base64");
  expect(Buffer.from(nul.content, "base64").toString("utf8")).toBe("\0[secret:S]");
  writeFileSync(join(root, "cut.txt"), `${SECRET}é`);
  const cut = await readOp(c, { path: "cut.txt", maxBytes: 9 });
  const bytes = cut.encoding === "base64" ? Buffer.from(cut.content, "base64") : Buffer.from(cut.content);
  expect(bytes.toString("latin1")).not.toContain("abcd");
});

test("property: a read returns the start of the masked whole file, in UTF-8, UTF-16LE, UTF-16BE and Latin-1", async () => {
  const c = ctx([]);
  const secrets: [string, string][] = [
    [SECRET, "[secret:S]"],
    ["café-key", "[secret:C]"],
    ["two\nlines", "[secret:L]"],
  ];
  const store = c.secrets as unknown as { masks: () => Promise<[string, string][]> };
  store.masks = async () => secrets;
  const root = c.access.agentRoot(c.agent);
  const r = seeded(777);
  const encode = (text: string, how: number) =>
    how === 0
      ? Buffer.from(text, "utf8")
      : how === 1
        ? Buffer.from(text, "utf16le")
        : how === 2
          ? Buffer.from(text, "utf16le").swap16()
          : Buffer.from(text, "latin1");
  const words = [SECRET, "café-key", "two\nlines", "two\r\nlines", "x", "é", "\0", "abcd", "café"];
  let cases = 0;
  for (let round = 0; round < 800; round++) {
    const parts: Buffer[] = [];
    for (let i = 0, n = 1 + r.int(8); i < n; i++)
      parts.push(encode(r.pick(words, "word"), r.int(4, "encoding")));
    const file = Buffer.concat(parts);
    writeFileSync(join(root, "p.dat"), file);
    const maxBytes = 1 + r.int(file.byteLength + 8, "cut");
    const got = await readOp(c, { path: "p.dat", maxBytes });
    const bytes =
      got.encoding === "base64" ? Buffer.from(got.content, "base64") : Buffer.from(got.content, "utf8");
    const whole = maskBytes(file, secrets);
    const expected = whole.subarray(0, maxBytes);
    if (got.encoding === "base64") expect(bytes.equals(expected)).toBe(true);
    else expect(got.content).toBe(expected.toString("utf8"));
    expect(got.truncated).toBe(whole.byteLength > maxBytes);
    // No secret, whole, in any of the four encodings.
    for (const [v] of secrets)
      for (let how = 0; how < 4; how++) {
        const form = encode(v, how);
        if (how === 3 && Buffer.from(form.toString("latin1"), "latin1").toString("latin1") !== v) continue;
        expect([v, how, bytes.includes(form)]).toEqual([v, how, false]);
      }
    cases++;
  }
  console.log(
    `[read] ${cases} files; encodings ${JSON.stringify(r.spread("encoding"))}; words ${JSON.stringify(r.spread("word"))}`,
  );
  expect(Math.min(...r.spread("encoding"))).toBeGreaterThan(500);
});

test("a cut right after a masked secret never shows the start of the next one (16 characters, twice, every cut)", async () => {
  const c = ctx([]);
  const secret = "abcdefghijklmnop";
  (c.secrets as unknown as { masks: () => Promise<[string, string][]> }).masks = async () => [
    [secret, "[secret:S]"],
  ];
  const root = c.access.agentRoot(c.agent);
  writeFileSync(join(root, "twice"), secret.repeat(2));
  for (let maxBytes = 1; maxBytes < 64; maxBytes++) {
    const r = await readOp(c, { path: "twice", maxBytes });
    expect([maxBytes, r.content]).toEqual([maxBytes, "[secret:S][secret:S]".slice(0, maxBytes)]);
  }
});
