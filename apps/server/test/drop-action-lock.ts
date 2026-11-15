// A mutant for CI: loaded with `bun test --preload`, it leaves out only the undo's lock on the action's row
// (control.ts, `applyUndo`), so the postgres job can see the forced undo-twice test fail without that one lock.
import { plugin } from "bun";

const LOCK = /(eq\(reversibleActions\.workspaceId, row\.workspaceId\)\)\)\s*)\.for\("update"\)/g;

plugin({
  name: "drop the undo's action lock",
  setup(build) {
    build.onLoad({ filter: /\/src\/control\.ts$/ }, async ({ path }) => {
      const source = await Bun.file(path).text();
      const found = source.match(LOCK)?.length ?? 0;
      if (found !== 1) throw new Error(`drop-action-lock: expected the action's lock once, found ${found}`);
      console.error("drop-action-lock: the undo's action lock is left out");
      return { contents: source.replace(LOCK, "$1"), loader: "ts" };
    });
  },
});
