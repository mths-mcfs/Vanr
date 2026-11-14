// The real Chrome of the browser attack tests (browser-network.test.ts and browser-actions.test.ts): the
// loopback test sites and their victim, the browser with the test proxy resolver, and the calls the tests
// make. Each test file starts its own sites and browser in its own beforeAll.
import { afterAll, beforeAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SecretBrowserBinding } from "@vanr/contract";
import type { BrowserPolicy } from "@vanr/engine/browser-policy";
import type {
  AgentRef,
  BlockedLoad,
  BrowserActResult,
  BrowserInspectResult,
  OpArgs,
  RunnerFrame,
} from "@vanr/engine/runner-protocol";
import type { Access } from "../access";
import { CdpBrowser } from "../cdp";
import { findChrome } from "../chrome";
import type { SecretStore, SecretValue } from "../secrets";
import { type AttackSites, SITE_IP, SITE_RANGE, startAttackSites } from "./attack-sites";

export const chrome = findChrome();
export let sites: AttackSites;
export let browser: CdpBrowser;
let n = 0;

/** Starts the sites and the browser for the test file; `secrets` is what the browser may type. */
export function useGuardBrowser(secrets: () => SecretValue[]): void {
  const home = mkdtempSync(join(tmpdir(), "guard-test-"));
  beforeAll(() => {
    sites = startAttackSites();
    for (const h of ["site.test", "other.test", "frame.test", "www.itau.com.br"]) sites.dns.set(h, [SITE_IP]);
    browser = new CdpBrowser({
      chrome: chrome ?? "",
      home,
      access: {} as Access,
      secrets: { values: async () => secrets() } as unknown as SecretStore,
      noSandbox: true,
      resolve: (h) => sites.resolve(h),
      insecureTls: true,
      onBlocked: (agentId, load) => {
        for (const w of blockWaiters.splice(0)) {
          if (w.agentId === agentId && w.match(load)) w.done(load);
          else blockWaiters.push(w);
        }
      },
    });
  });
  afterAll(async () => {
    await browser?.close();
    sites?.stop();
    rmSync(home, { recursive: true, force: true });
  });
}

/** A new agent per test: its own Chrome and profile, with no history from another test. */
export const agent = (): AgentRef => ({
  id: `agt_guardtest${String(++n).padStart(8, "0")}`,
  handle: `g${n}`,
});

export const policy = (over: Partial<BrowserPolicy> = {}): BrowserPolicy => ({
  driver: "agent",
  level: "free",
  sites: [],
  privateRanges: [SITE_RANGE],
  ...over,
});

/** Live view frames per agent. A single send for everything, like the real runner's. */
const blockWaiters: {
  agentId: string;
  match: (b: BlockedLoad) => boolean;
  done: (b: BlockedLoad) => void;
}[] = [];
/** Resolves when the runner notes a block for the agent (call it before what makes the page run into it). */
export const blockNoted = (agentId: string, match: (b: BlockedLoad) => boolean = () => true) =>
  new Promise<BlockedLoad>((done) => blockWaiters.push({ agentId, match, done }));

export const frames = new Map<string, string[]>();
export const send = (f: RunnerFrame) => {
  if (f.type === "live_view.frame") frames.set(f.agentId, [...(frames.get(f.agentId) ?? []), f.data]);
  return true;
};
export const open = (a: AgentRef, url: string, p = policy()) =>
  browser.handle("browser.open", a, { url, policy: p }, send) as Promise<BrowserActResult>;
export const act = (a: AgentRef, args: Omit<OpArgs<"browser.act">, "policy">, p = policy()) =>
  browser.handle("browser.act", a, { ...args, policy: p }, send) as Promise<BrowserActResult>;
export const inspect = (a: AgentRef, args: Omit<OpArgs<"browser.inspect">, "policy">, p = policy()) =>
  browser.handle("browser.inspect", a, { ...args, policy: p }, send) as Promise<BrowserInspectResult>;
export const failure = (p: Promise<unknown>) =>
  p.then(
    () => "passed",
    (e: Error & { code?: string }) => `${e.code}: ${e.message}`,
  );

export const binding = (
  sitesList: string[],
  field: SecretBrowserBinding["field"] = "text",
): SecretBrowserBinding => ({
  sites: sitesList,
  field,
});
