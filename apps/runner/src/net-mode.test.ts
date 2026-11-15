import { describe, expect, test } from "bun:test";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import type { NetworkPolicyFrame } from "@vanr/engine/runner-protocol";
import { sandboxed } from "./ops";
import {
  type CommandSandbox,
  DENIED_RESOLVED_ADDRESSES,
  defaultPolicyContext,
  NetworkModes,
  type WrapInput,
} from "./sandbox";
import { realSandbox } from "./testing/sandbox";

// The network mode belongs to each process: nothing global carries an `open` from one process to the ones
// running next to it or after it, and in every mode a name that resolves to a private range is rejected by
// the address the proxy is about to dial.

test("an unlisted host goes through only while every live process is open, and a mode ends with its process", () => {
  const modes = new NetworkModes();
  expect(modes.unlistedAllowed()).toBe(false);
  modes.add("open-1", "open");
  expect(modes.unlistedAllowed()).toBe(true);
  // An allowlist process starts next to the open one: it is never widened by it.
  modes.add("list-1", "allowlist");
  expect(modes.unlistedAllowed()).toBe(false);
  modes.remove("list-1");
  expect(modes.unlistedAllowed()).toBe(true);
  modes.add("off-1", "off");
  expect(modes.unlistedAllowed()).toBe(false);
  modes.remove("off-1");
  // The open process ends: the next process does not inherit its mode.
  modes.remove("open-1");
  expect(modes.unlistedAllowed()).toBe(false);
  modes.add("list-2", "allowlist");
  expect(modes.unlistedAllowed()).toBe(false);
});

test("two processes started at the same time with different modes each take their own to the sandbox", async () => {
  const seen: { command: string; mode: WrapInput["mode"]; domains: string[] }[] = [];
  const sandbox: CommandSandbox = {
    status: () => ({ state: "on", engine: "bubblewrap", reason: null }),
    wrap: async (input) => {
      // Both wraps are in flight before either one is recorded.
      await new Promise((r) => setTimeout(r, input.mode === "open" ? 20 : 0));
      seen.push({ command: input.command, mode: input.mode, domains: input.domains });
      return { command: input.command, blocked: () => [], release: () => {} };
    },
    close: async () => {},
  };
  const ctx = { sandbox, policy: defaultPolicyContext("/nonexistent-runner-home") };
  const run = (command: string, network: NetworkPolicyFrame) =>
    sandboxed(ctx, { command, readable: [], writable: [], domains: network.domains, network });
  await Promise.all([
    run("open-one", { mode: "open", domains: [] }),
    run("listed-one", { mode: "allowlist", domains: ["example.com"] }),
  ]);
  await run("after", { mode: "allowlist", domains: [] });
  expect(seen.sort((a, b) => a.command.localeCompare(b.command))).toEqual([
    { command: "after", mode: "allowlist", domains: [] },
    { command: "listed-one", mode: "allowlist", domains: ["example.com"] },
    { command: "open-one", mode: "open", domains: [] },
  ]);
});

describe("real srt", async () => {
  const sandbox = await realSandbox();
  const on = sandbox.status().state === "on";

  test.if(on)(
    "the proxy rejects a name that resolves to RFC 1918, CGNAT or ULA by its resolved address",
    () => {
      const denied = SandboxManager.getConfig()?.network.deniedResolvedAddresses ?? [];
      expect(denied).toEqual(DENIED_RESOLVED_ADDRESSES);
      for (const range of ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10", "fc00::/7"])
        expect(denied).toContain(range);
    },
  );
});
