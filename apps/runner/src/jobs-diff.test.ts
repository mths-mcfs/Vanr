import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diffMasks, gitChanges, gitSnapshot } from "./jobs";
import { maskSecrets } from "./secrets";

// The diff a job sends to the server: a secret of several lines written to a file (not a secret file) does
// not come out line by line just because each line of the diff starts with `+`, `-` or a space.
const PEM = "-----BEGIN KEY-----\nAAAASECRETLINE1\nBBBBSECRETLINE2\nCCCCSECRETLINE3\n-----END KEY-----";
const MASKS: [string, string][] = [[PEM, "[secret:PEM]"]];
const PIECES = ["AAAASECRETLINE1", "BBBBSECRETLINE2", "CCCCSECRETLINE3", "BEGIN KEY", "END KEY"];

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" });

/** The diff of one change to notes.txt, between its `before` and `after` content. */
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
