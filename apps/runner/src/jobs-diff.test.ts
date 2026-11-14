import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { diffMasks, gitChanges, gitSnapshot } from "./jobs";
import { maskBytes, maskSecrets } from "./secrets";
import { seeded } from "./testing/random";

// The diff a job sends to the server: a secret of several lines written to a file (not a secret file) does
// not come out line by line just because each line of the diff starts with `+`, `-` or a space.
const PEM = "-----BEGIN KEY-----\nAAAASECRETLINE1\nBBBBSECRETLINE2\nCCCCSECRETLINE3\n-----END KEY-----";
const MASKS: [string, string][] = [[PEM, "[secret:PEM]"]];
const PIECES = ["AAAASECRETLINE1", "BBBBSECRETLINE2", "CCCCSECRETLINE3", "BEGIN KEY", "END KEY"];

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" });

/** The diff of one change to notes.txt, between its `before` and `after` content. */
/** The `diff --git` lines of a diff. */
const headers = (diff: string) => diff.split("\n").filter((l) => l.startsWith("diff --git "));
/** The lines of a diff that are not header lines (from `diff --git` to the first hunk or `Binary files`). */
function body(diff: string): string[] {
  const out: string[] = [];
  let header = false;
  for (const line of diff.trimEnd().split("\n")) {
    if (line.startsWith("diff --git ")) header = true;
    else if (header && line.startsWith("@@")) header = false;
    else if (header && line.startsWith("Binary files ")) {
      header = false;
      continue;
    }
    if (!header && line) out.push(line);
  }
  return out;
}

function diffOf(before: string | null, after: string | null): string {
  return diffWith(before, after, MASKS);
}

function diffWith(before: string | null, after: string | null, masks: [string, string][]): string {
  const dir = mkdtempSync(join(tmpdir(), "runner-diff-"));
  try {
    git(dir, "init", "-q");
    writeFileSync(join(dir, "README.md"), "base\n");
    if (before !== null) writeFileSync(join(dir, "notes.txt"), before);
    git(dir, "add", ".");
    git(dir, "commit", "-qm", "base");
    const store = join(mkdtempSync(join(tmpdir(), "runner-diff-store-")), "snapshot.git");
    const base = gitSnapshot(dir, store) as string;
    if (after === null) rmSync(join(dir, "notes.txt"));
    else writeFileSync(join(dir, "notes.txt"), after);
    return gitChanges(dir, store, base, [], masks).diff ?? "";
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test.each([
  ["added to a file", "intro\n", `intro\n${PEM}\n`],
  ["removed from a file", `intro\n${PEM}\n`, "intro\n"],
  [
    "changed in one of its lines",
    `intro\n${PEM}\n`,
    `intro\n${PEM.replace("BBBBSECRETLINE2", "ZZZZNEWLINE")}\n`,
  ],
  ["with a changed line next to it", `intro\n${PEM}\nend\n`, `other intro\n${PEM}\nother end\n`],
  ["in a new file", null, `${PEM}\n`],
  ["in a deleted file", `${PEM}\n`, null],
])("a multi-line key %s is masked in the diff", (_case, before, after) => {
  const diff = diffOf(before, after);
  expect(diff).toContain("notes.txt");
  for (const piece of PIECES) expect([piece, diff.includes(piece)]).toEqual([piece, false]);
  expect(diff).toContain("[secret:PEM]");
});

test("property: the diff sent is the diff between the masked old file and the masked new one", () => {
  const masks: [string, string][] = [
    ["ab\ncd", "[secret:SHORT]"],
    [PEM, "[secret:PEM]"],
    ["tok_abc123", "[secret:TOKEN]"],
  ];
  const pieces = [
    "ab\ncd",
    "ab\n",
    "cd\n",
    `${PEM}\n`,
    "tok_abc123 ",
    "line\n",
    "other\n",
    "x",
    "\n",
    "ab",
    "cd",
  ];
  let seed = 11;
  const rand = (n: number) => {
    seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
    return seed % n;
  };
  const file = () =>
    rand(8) === 0 ? null : Array.from({ length: rand(10) }, () => pieces[rand(pieces.length)] ?? "").join("");
  const mask = (t: string | null) => (t === null ? null : maskSecrets(t, diffMasks(masks)));
  let cases = 0;
  for (let round = 0; round < 120; round++) {
    const before = file();
    const after = file();
    if (before === after) continue;
    // The oracle: plain git on the masked files.
    const dir = mkdtempSync(join(tmpdir(), "runner-diff-oracle-"));
    git(dir, "init", "-q");
    writeFileSync(join(dir, "README.md"), "base\n");
    const maskedOld = mask(before);
    const maskedNew = mask(after);
    if (maskedOld !== null) writeFileSync(join(dir, "notes.txt"), maskedOld);
    git(dir, "add", ".");
    git(dir, "commit", "-qm", "base");
    if (maskedNew === null) rmSync(join(dir, "notes.txt"));
    else writeFileSync(join(dir, "notes.txt"), maskedNew);
    git(dir, "add", "-A");
    const expected = git(
      dir,
      "diff",
      "--cached",
      "--no-color",
      "--no-ext-diff",
      "--no-textconv",
      "--no-renames",
    );
    rmSync(dir, { recursive: true, force: true });
    const got = diffWith(before, after, masks);
    expect([before, after, got]).toEqual([before, after, expected.trim() ? expected : ""]);
    cases++;
  }
  expect(cases).toBeGreaterThan(80);
}, 60_000);

test("property: every changed file is in the diff, whatever its name, and the diff is that of the masked files", () => {
  const masks: [string, string][] = [
    ["TOKEN-0042", "[secret:T]"],
    ["ab\ncd", "[secret:M]"],
  ];
  const names = [
    "é.txt",
    " lead",
    "trail ",
    "new\nline",
    "TOKEN-0042.txt",
    "dir/sub é",
    "plain.txt",
    'q"uote',
    "bell\x07key",
    "tab\tname",
  ];
  const contents = [
    "TOKEN-0042\n",
    "ab\ncd\n",
    "x\nab\ncd",
    "plain\n",
    "",
    "\0bin TOKEN-0042 \0",
    "ab\ncx\n",
  ];
  const r = seeded(9001);
  let cases = 0;
  for (let round = 0; round < 60; round++) {
    const before = new Map<string, string>();
    const after = new Map<string, string>();
    for (const name of names) {
      if (r.int(2, "before")) before.set(name, r.pick(contents, "content"));
      if (r.int(2, "after"))
        after.set(name, r.int(3) ? r.pick(contents, "content") : (before.get(name) ?? "same\n"));
    }
    const write = (dir: string, files: Map<string, string>, mask: boolean) => {
      for (const [name, body] of files) {
        mkdirSync(dirname(join(dir, name)), { recursive: true });
        writeFileSync(join(dir, name), mask ? maskBytes(Buffer.from(body), diffMasks(masks)) : body);
      }
    };
    // The job's folder, raw.
    const dir = mkdtempSync(join(tmpdir(), "runner-diff-names-"));
    git(dir, "init", "-q");
    write(dir, before, false);
    const store = join(mkdtempSync(join(tmpdir(), "runner-diff-names-store-")), "snapshot.git");
    const base = gitSnapshot(dir, store) as string;
    for (const name of before.keys()) rmSync(join(dir, name), { force: true });
    write(dir, after, false);
    const got = gitChanges(dir, store, base, [], masks);
    // The oracle: plain git on the masked files, with the names in the header lines masked.
    const oracle = mkdtempSync(join(tmpdir(), "runner-diff-names-oracle-"));
    git(oracle, "init", "-q");
    writeFileSync(join(oracle, ".keep"), "");
    write(oracle, before, true);
    git(oracle, "add", "-A");
    git(oracle, "commit", "-qm", "base");
    for (const name of before.keys()) rmSync(join(oracle, name), { force: true });
    write(oracle, after, true);
    git(oracle, "add", "-A");
    const expected = git(
      oracle,
      "-c",
      "core.quotePath=false",
      "diff",
      "--cached",
      "--no-color",
      "--no-ext-diff",
      "--no-textconv",
      "--no-renames",
    );
    const changed = names.filter((n) => before.get(n) !== after.get(n)).map((n) => maskSecrets(n, masks));
    expect([...got.files].sort()).toEqual(changed.sort());
    // The content lines are git's on the masked files; the header lines are the runner's, one block per file
    // of git's diff, in its order, with the masked name (a control character as \xNN), never git's quoting.
    const order = git(oracle, "diff", "--cached", "--name-only", "-z", "--no-renames")
      .split("\0")
      .filter(Boolean);
    const shown = (n: string) =>
      [...maskSecrets(n, masks)]
        .map((c) =>
          c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127
            ? `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`
            : c,
        )
        .join("");
    expect(headers(got.diff ?? "")).toEqual(order.map((n) => `diff --git a/${shown(n)} b/${shown(n)}`));
    expect(body(got.diff ?? "")).toEqual(body(expected));
    expect((got.diff ?? "").includes('"a/')).toBe(false);
    for (const leak of ["TOKEN-0042", "ab\ncd"]) expect((got.diff ?? "").includes(leak)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
    rmSync(oracle, { recursive: true, force: true });
    cases++;
  }
  console.log(
    `[diff] ${cases} rounds of ${names.length} names; contents ${JSON.stringify(r.spread("content"))}`,
  );
  expect(Math.min(...r.spread("content"))).toBeGreaterThan(30);
}, 120_000);
