// A mutant for CI: loaded with `bun test --preload`, it takes the conversation's admission out of the runtime
// (runtime/runtime.ts, `admit` runs its work at once), so the forced tests of runtime-durability.test.ts can be seen
// failing on their outcome without it.
import { plugin } from "bun";

const ADMISSION = /const turn = \(this\.admissions\.get\(key\) \?\? Promise\.resolve\(\)\)\.then\(work\);/g;

plugin({
  name: "drop the conversation's admission",
  setup(build) {
    build.onLoad({ filter: /\/src\/runtime\/runtime\.ts$/ }, async ({ path }) => {
      const source = await Bun.file(path).text();
      const found = source.match(ADMISSION)?.length ?? 0;
      if (found !== 1) throw new Error(`drop-admission: expected the admission once, found ${found}`);
      console.error("drop-admission: the conversation's admission is left out");
      return { contents: source.replace(ADMISSION, "const turn = work();"), loader: "ts" };
    });
  },
});
