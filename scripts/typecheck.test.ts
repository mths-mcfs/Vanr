import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findProjects } from "./typecheck.ts";

describe("findProjects", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "vanr typecheck "));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function project(dir: string, withTsconfig = true): Promise<void> {
    await mkdir(join(root, dir), { recursive: true });
    if (withTsconfig) await writeFile(join(root, dir, "tsconfig.json"), "{}");
  }

  test("finds apps, packages and scripts in a path with spaces, skipping dirs without tsconfig.json", async () => {
    expect(root).toContain(" ");
    await project("packages/ui");
    await project("apps/web");
    await project("apps/server");
    await project("apps/docs", false);
    await project("scripts");
    await project("other/tool");

    expect(await findProjects(root)).toEqual(["apps/server", "apps/web", "packages/ui", "scripts"]);
  });

  test("returns nothing when no project has a tsconfig.json", async () => {
    await project("apps/web", false);
    expect(await findProjects(root)).toEqual([]);
  });
});
