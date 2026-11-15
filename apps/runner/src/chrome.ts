// Where the agent's browser comes from: the system's Chrome or a Chromium Playwright downloaded.
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { PRODUCT } from "@vanr/product";
import { which } from "./jobs";

/** `1` starts Chrome without its sandbox (Ubuntu 23.10+ with Playwright's Chromium, containers). */
export const BROWSER_NO_SANDBOX_ENV = `${PRODUCT.slug.toUpperCase()}_BROWSER_NO_SANDBOX`;

/** The system's Chrome, or the Chromium Playwright downloaded. */
export function findChrome(): string | null {
  const env = process.env.CHROME_PATH;
  if (env && existsSync(env)) return env;
  for (const name of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "chrome"]) {
    const p = which(name);
    if (p) return p;
  }
  for (const app of [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ])
    if (existsSync(app)) return app;
  for (const cache of [
    join(homedir(), ".cache/ms-playwright"),
    join(homedir(), "Library/Caches/ms-playwright"),
  ]) {
    if (!existsSync(cache)) continue;
    const dirs = readdirSync(cache)
      .filter((d) => /^chromium-\d+$/.test(d))
      .sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]));
    for (const d of dirs)
      for (const rel of [
        "chrome-linux64/chrome",
        "chrome-linux/chrome",
        "chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium",
        "chrome-mac/Chromium.app/Contents/MacOS/Chromium",
      ]) {
        const p = join(cache, d, rel);
        if (existsSync(p)) return p;
      }
  }
  return null;
}
