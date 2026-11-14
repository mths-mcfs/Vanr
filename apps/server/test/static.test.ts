import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStatic } from "../src/static";

function build() {
  const base = mkdtempSync(join(tmpdir(), "static-"));
  const dist = join(base, "dist");
  mkdirSync(join(dist, "assets"), { recursive: true });
  writeFileSync(join(dist, "index.html"), "<html>app</html>");
  writeFileSync(join(dist, "assets", "app.js"), "console.log(1)");
  // A sibling folder with the same name prefix: it must not leak through the build server.
  mkdirSync(join(base, "dist-x"));
  writeFileSync(join(base, "dist-x", "secret.txt"), "secret");
  return createStatic(dist);
}

test("a build file goes out with cache; an unknown path falls back to index.html", async () => {
  const serve = build();
  const asset = await serve("/assets/app.js");
  expect([asset.status, asset.headers.get("cache-control"), await asset.text()]).toEqual([
    200,
    "public, max-age=14400",
    "console.log(1)",
  ]);
  expect(await (await serve("/workspace/x/c/y")).text()).toBe("<html>app</html>");
  expect(await (await serve("/")).text()).toBe("<html>app</html>");
});

test("a sibling folder with the same prefix and a malformed % neither leave the build nor give a 500", async () => {
  const serve = build();
  const sibling = await serve("/..%2fdist-x%2fsecret.txt");
  expect([sibling.status, await sibling.text()]).toEqual([200, "<html>app</html>"]);
  const malformed = await serve("/%E0%A4%A");
  expect([malformed.status, await malformed.text()]).toEqual([200, "<html>app</html>"]);
});
