// The end-to-end journeys: the web build in Chromium against the real server, one server with its own
// in-memory PGlite per Playwright worker (see e2e/server.ts). Run with `bun run e2e` from apps/web.
//
// Every journey runs once per interface language, so the text it reads comes from that language's
// catalog (e2e/fixtures.ts) and a key missing in one language fails here as well as in the parity test.
import { defineConfig, devices } from "@playwright/test";

const ci = process.env.CI !== undefined;

export default defineConfig({
  testDir: "e2e",
  // `*.e2e.ts`, so the web's `bun test` (which also takes `*.spec.ts`) never picks a journey up.
  testMatch: "**/*.e2e.ts",
  globalSetup: "./e2e/global-setup.ts",
  outputDir: "test-results",
  fullyParallel: true,
  forbidOnly: ci,
  // A journey that only passes on a second try is a failure: no retries anywhere.
  retries: 0,
  workers: 2,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: ci
    ? [["list"], ["html", { open: "never", outputFolder: "playwright-report" }], ["github"]]
    : [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  use: {
    ...devices["Desktop Chrome"],
    // CI keeps the trace of every journey, passed or failed; locally only the failed ones.
    trace: ci ? "on" : "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "en", use: { locale: "en-US" } },
    { name: "pt-BR", use: { locale: "pt-BR" } },
  ],
});
