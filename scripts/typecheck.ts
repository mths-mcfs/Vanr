// Runs tsc on every project in the monorepo that has a tsconfig.json, in parallel,
// and exits non-zero if any of them fails.
import { dirname, join } from "node:path";

const PATTERNS = ["apps/*/tsconfig.json", "packages/*/tsconfig.json", "scripts/tsconfig.json"];

/** Project directories under `root` that have a tsconfig.json, relative to `root` and sorted. */
export async function findProjects(root: string): Promise<string[]> {
  const projects: string[] = [];
  for (const pattern of PATTERNS) {
    for await (const file of new Bun.Glob(pattern).scan({ cwd: root })) {
      projects.push(dirname(file));
    }
  }
  return projects.sort();
}

async function main(): Promise<void> {
  const root = dirname(import.meta.dir);
  const tsc = join(root, "node_modules", ".bin", "tsc");
  const projects = await findProjects(root);

  if (projects.length === 0) {
    console.error("typecheck: no projects found");
    process.exit(1);
  }

  const results = await Promise.all(
    projects.map(async (dir) => {
      const proc = Bun.spawn([tsc, "-p", join(root, dir)], { stdout: "pipe", stderr: "pipe" });
      const [out, err, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { dir, code, out: (out + err).trim() };
    }),
  );

  let failed = 0;
  for (const r of results) {
    console.log(`${r.code === 0 ? "ok  " : "FAIL"} ${r.dir}`);
    if (r.code !== 0) {
      failed++;
      console.log(r.out);
    }
  }
  if (failed > 0) {
    console.error(`typecheck: ${failed} of ${results.length} project(s) failed`);
    process.exit(1);
  }
  console.log(`typecheck: ${results.length} project(s) ok`);
}

if (import.meta.main) await main();
