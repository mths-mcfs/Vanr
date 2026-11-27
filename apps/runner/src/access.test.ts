import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunnerAccess } from "@vanr/contract";
import { Access, rejectedFolder } from "./access";

const dir = mkdtempSync(join(tmpdir(), "runner-access-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const ctx = { runnerHome: join(dir, "home"), workDir: join(dir, "ws") };
const agent = { id: "agt_0000000012345678", handle: "lia" };

function accessWith(folders: string[]) {
  const access = {
    folders: folders.map((path) => ({ path, agents: [] })),
    tools: { files: true, commands: true, browser: true },
  } as unknown as RunnerAccess;
  return new Access(() => ({ access, workDir: ctx.workDir, paused: false }));
}

test("a symlink to a system folder cannot be allowed", () => {
  const link = join(dir, "link-etc");
  symlinkSync("/etc", link);
  expect(rejectedFolder("/etc", ctx)).toBe("system");
  expect(rejectedFolder(link, ctx)).toBe("system");
  const home = join(dir, "link-home");
  symlinkSync(ctx.runnerHome, home);
  mkdirSync(ctx.runnerHome, { recursive: true });
  expect(rejectedFolder(home, ctx)).toBe("runner");
});

test("a plain folder and a symlink to a plain folder are valid; swapping the folder for a symlink to the system later opens nothing", () => {
  const docs = join(dir, "docs");
  mkdirSync(docs);
  writeFileSync(join(docs, "a.txt"), "a");
  const viaLink = join(dir, "link-docs");
  symlinkSync(docs, viaLink);
  expect(rejectedFolder(docs, ctx)).toBeNull();
  expect(rejectedFolder(viaLink, ctx)).toBeNull();
  expect(accessWith([viaLink]).resolve(agent, join(docs, "a.txt"))).toBe(join(docs, "a.txt"));

  // Allowed while it was a plain folder; later it became a symlink to /etc.
  const swapped = join(dir, "swapped");
  mkdirSync(swapped);
  const access = accessWith([swapped]);
  rmSync(swapped, { recursive: true });
  symlinkSync("/etc", swapped);
  expect(() => access.resolve(agent, "/etc/passwd")).toThrow(/not in a folder/);
  expect(() => access.resolve(agent, join(swapped, "passwd"))).toThrow(/not in a folder/);
});

test("agent identities and symlink roots cannot escape the work folder", () => {
  const access = accessWith([]);
  for (const bad of [
    { ...agent, handle: "../outside" },
    { ...agent, id: "../../12345678" },
  ])
    expect(() => access.agentRoot(bad)).toThrow();
  const outside = join(dir, "outside");
  mkdirSync(outside);
  symlinkSync(outside, join(ctx.workDir, "escape-12345678"));
  expect(() => access.agentRoot({ ...agent, handle: "escape" })).toThrow();
});

test("a broken symlink is rejected before authorizing a write", () => {
  const access = accessWith([]);
  const root = access.agentRoot(agent);
  const target = join(dir, ".bashrc");
  symlinkSync(target, join(root, "dangling"));
  expect(() => access.resolve(agent, "dangling")).toThrow();
  expect(existsSync(target)).toBe(false);
});
