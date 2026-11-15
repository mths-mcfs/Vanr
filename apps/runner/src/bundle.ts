// Runner bundle: a single .mjs file that runs on Node 22+ or on Bun. The server ships it through
// install.sh with its sha256; `bun run build` writes it to dist/ so the server does not build it in production.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PRODUCT } from "@vanr/product";

export const BUNDLE_NAME = `${PRODUCT.runnerName}.mjs`;

export async function bundleRunner(): Promise<Uint8Array> {
  const entry = new URL("./main.ts", import.meta.url).pathname;
  const out = await Bun.build({ entrypoints: [entry], target: "node", format: "esm", minify: false });
  if (!out.success || !out.outputs[0]) throw new Error(`runner build failed: ${out.logs.join("\n")}`);
  let text = await out.outputs[0].text();
  if (!text.startsWith("#!")) text = `#!/usr/bin/env node\n${text}`;
  return new TextEncoder().encode(text);
}

if (import.meta.main) {
  const dir = new URL("../dist/", import.meta.url).pathname;
  mkdirSync(dir, { recursive: true });
  const bytes = await bundleRunner();
  writeFileSync(join(dir, BUNDLE_NAME), bytes);
  console.log(`dist/${BUNDLE_NAME} (${bytes.byteLength} bytes)`);
}
