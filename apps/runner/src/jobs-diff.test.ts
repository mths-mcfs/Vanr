import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitChanges, gitSnapshot } from "./jobs";

// The diff a job sends to the server: a secret of several lines written to a file (not a secret file) does
// not come out line by line just because each line of the diff starts with `+`, `-` or a space.
const PEM = "-----BEGIN KEY-----\nAAAASECRETLINE1\nBBBBSECRETLINE2\nCCCCSECRETLINE3\n-----END KEY-----";
const MASKS: [string, string][] = [[PEM, "[secret:PEM]"]];
const PIECES = ["AAAASECRETLINE1", "BBBBSECRETLINE2", "CCCCSECRETLINE3", "BEGIN KEY", "END KEY"];

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" });

/** The diff of one change to notes.txt, between its `before` and `after` content. */
function diffOf(before: string | null, after: string | null): string {
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
    return gitChanges(dir, store, base, [], MASKS).diff ?? "";
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
