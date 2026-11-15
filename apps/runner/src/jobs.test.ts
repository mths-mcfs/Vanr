import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clipMiddle, DIFF_MAX, gitChanges, gitSnapshot, parseExecutorLine } from "./jobs";

// End of a job (T11 P0-07): the runner sends the files that changed, the diff and the usage the executor
// reported. Without it the job's `files` always came out empty and the assignment had no proof of what changed.

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" });

/** The runner's repository for the snapshots (it stays outside the agent's folder). */
const store = () => join(mkdtempSync(join(tmpdir(), "runner-store-")), "snapshot.git");

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "runner-git-"));
  git(dir, "init", "-q");
  return dir;
}

describe("end of a job: files, diff and usage", () => {
  test("changed and new files, without the ignored ones, and the diff against the start of the job", () => {
    const dir = repo();
    writeFileSync(join(dir, "a.txt"), "one\n");
    writeFileSync(join(dir, ".gitignore"), "secret.env\n");
    git(dir, "add", ".");
    git(dir, "commit", "-qm", "base");
    // A change and a new file that already existed before the job do not count as the job's.
    writeFileSync(join(dir, "a.txt"), "one\nbefore\n");
    writeFileSync(join(dir, "already-here.md"), "from the system\n");
    git(dir, "add", "a.txt");
    const staged = git(dir, "diff", "--cached", "--name-only");
    const snaps = store();
    const base = gitSnapshot(dir, snaps);
    expect(base).toMatch(/^[0-9a-f]{40}$/);
    writeFileSync(join(dir, "a.txt"), "one\nbefore\nafter\n");
    writeFileSync(join(dir, "new.ts"), "export const x = 1\n");
    writeFileSync(join(dir, "secret.env"), "TOKEN=x\n");
    const out = gitChanges(dir, snaps, base as string);
    expect(out.files.sort()).toEqual(["a.txt", "new.ts"]);
    expect(out.diff).toContain("+after");
    expect(out.diff).toContain("+export const x = 1");
    expect(out.diff).not.toContain("+before");
    expect(out.diff).not.toContain("from the system");
    expect(out.diff).not.toContain("TOKEN");
    // The index of whoever uses the folder stays as it was.
    expect(git(dir, "diff", "--cached", "--name-only")).toBe(staged);
  });

  test("a repository without a commit uses the empty tree; outside git there is no base", () => {
    const dir = repo();
    const snaps = store();
    const base = gitSnapshot(dir, snaps);
    expect(base).toBe("4b825dc642cb6eb9a060e54bf8d69288fbee4904");
    writeFileSync(join(dir, "x.md"), "hi\n");
    expect(gitChanges(dir, snaps, base as string).files).toEqual(["x.md"]);
    expect(gitSnapshot(mkdtempSync(join(tmpdir(), "runner-nogit-")), store())).toBeNull();
  });

  test("attack: a nested repository with fsmonitor runs nothing on the runner (the snapshot is outside the sandbox)", () => {
    const dir = repo();
    writeFileSync(join(dir, "a.md"), "hi\n");
    git(dir, "add", ".");
    git(dir, "commit", "-qm", "base");
    const snaps = store();
    const base = gitSnapshot(dir, snaps) as string;
    // During the job: a new repository inside the folder, with a command in fsmonitor, registered in the
    // folder's index (the agent writes to its own .git).
    const marker = join(mkdtempSync(join(tmpdir(), "runner-mark-")), "ran");
    const sub = join(dir, "sub");
    mkdirSync(sub);
    git(sub, "init", "-q");
    writeFileSync(join(sub, "f"), "x\n");
    git(sub, "add", ".");
    git(sub, "commit", "-qm", "s");
    git(sub, "config", "core.fsmonitor", `touch ${marker}; false`);
    git(dir, "config", "core.fsmonitor", `touch ${marker}; false`);
    git(dir, "add", "sub");
    writeFileSync(join(dir, "a.md"), "hi\nchanged\n");
    rmSync(marker, { force: true }); // the test's own `git add sub` already ran the fsmonitor
    const out = gitChanges(dir, snaps, base);
    // The nested repository is not opened (that would be running git in it); the plain change next to it shows up.
    expect(out.files).toEqual(["a.md"]);
    expect(existsSync(marker)).toBe(false);
    // The snapshot's objects go to the runner's repository, not to the folder's .git.
    const blob = execFileSync("git", ["hash-object", "--stdin"], { input: "hi\n", encoding: "utf8" }).trim();
    expect(
      execFileSync("git", ["--git-dir", snaps, "cat-file", "-t", blob], { encoding: "utf8" }).trim(),
    ).toBe("blob");
  });

  test("attack: a secret file enters neither the snapshot nor the diff, not even with another job of the agent running", () => {
    const dir = repo();
    writeFileSync(join(dir, "a.md"), "hi\n");
    git(dir, "add", ".");
    git(dir, "commit", "-qm", "base");
    // Another job of the same agent already wrote the secret; this one ends after it goes away.
    mkdirSync(join(dir, "creds"));
    const secret = join(dir, "creds", "to[k]en *");
    writeFileSync(secret, "ab1\n");
    const snaps = store();
    const base = gitSnapshot(dir, snaps, [secret]) as string;
    rmSync(secret);
    writeFileSync(join(dir, "a.md"), "hi\nchanged\n");
    const out = gitChanges(dir, snaps, base, [secret]);
    expect(out.files).toEqual(["a.md"]);
    expect(out.diff).not.toContain("ab1");
    const blob = execFileSync("git", ["hash-object", "--stdin"], { input: "ab1\n", encoding: "utf8" }).trim();
    for (const gitDir of [snaps, join(dir, ".git")])
      expect(() =>
        execFileSync("git", ["--git-dir", gitDir, "cat-file", "-e", blob], { stdio: "ignore" }),
      ).toThrow();
  });

  test("a large diff arrives cut in the middle, with the start and the end", () => {
    const big = `${"a".repeat(DIFF_MAX)}END`;
    const cut = clipMiddle(`START${big}`, DIFF_MAX);
    expect(cut.length).toBeLessThanOrEqual(DIFF_MAX + 60);
    expect(cut.startsWith("START")).toBe(true);
    expect(cut.endsWith("END")).toBe(true);
  });

  test("usage of Claude Code (result) and of Codex (per turn)", () => {
    const claude = parseExecutorLine(
      "claude_code",
      JSON.stringify({
        type: "result",
        result: "ok",
        session_id: "s1",
        total_cost_usd: 0.0123,
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          cache_read_input_tokens: 5,
          cache_creation_input_tokens: 3,
        },
        modelUsage: { "claude-sonnet-5-5": {} },
      }),
    );
    expect(claude.usage).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      cachedTokens: 5,
      cacheWriteTokens: 3,
      costUsd: 0.0123,
    });
    expect(claude.model).toBe("claude-sonnet-5-5");
    const codex = parseExecutorLine(
      "codex",
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 7, cached_input_tokens: 2, output_tokens: 4 },
      }),
    );
    expect(codex.usage).toEqual({
      inputTokens: 7,
      outputTokens: 4,
      cachedTokens: 2,
      cacheWriteTokens: 0,
      costUsd: null,
    });
    // An odd number does not become negative usage.
    const odd = parseExecutorLine(
      "claude_code",
      JSON.stringify({ type: "result", result: "", usage: { input_tokens: -5, output_tokens: "x" } }),
    );
    expect(odd.usage?.inputTokens).toBe(0);
    expect(odd.usage?.outputTokens).toBe(0);
  });
});
