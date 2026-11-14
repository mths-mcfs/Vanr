import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Access } from "./access";
import { execOp, listOp, type OpContext, readOp } from "./ops";
import { defaultPolicyContext, sandboxOff } from "./sandbox";
import type { SecretStore } from "./secrets";

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
