#!/usr/bin/env node
// Runner CLI. It becomes a single file (`bun build --target=node`) that runs on Node 22+ or on Bun.
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { PRODUCT } from "@vanr/product";
import { z } from "zod";
import { rejectedFolder } from "./access";
import { RunnerClient } from "./client";
import { configPath, RUNNER_VERSION, readConfig, runnerHome, writeConfig } from "./config";
import { runMcpStdio } from "./mcp";
import { PairingError, pair } from "./pair";
import { openSandbox } from "./sandbox";
import { rollbackUpdate, runningBundle, UpdateError, update } from "./update";

const BIN = PRODUCT.runnerName;

/** `agents.json`, written by the runner from the server's `welcome` and `agents` frames. */
const knownAgents = z.array(z.object({ id: z.string(), handle: z.string() }));

const HELP = `${BIN} ${RUNNER_VERSION}

  ${BIN} pair --server <url> [--name <name>] [--dir <folder>] [--no-exec] [--new]
  ${BIN} start
  ${BIN} status
  ${BIN} folders list | allow <path> [--agent <handle>] | remove <path> [--agent <handle>]
  ${BIN} tools list | enable <claude|codex|commands|browser> | disable <tool>
  ${BIN} pause | resume
  ${BIN} sandbox [status | on | off]
  ${BIN} update [--rollback]
  ${BIN} version
`;

/** How to start this same runner again (Claude Code and Codex start `<runner> mcp`). */
function selfCommand(sub: string): string[] {
  const script = process.argv[1];
  return script && /\.(m?js|ts)$/.test(script)
    ? [process.execPath, resolve(script), sub]
    : [process.execPath, sub];
}

/**
 * Exit codes: 0 ok, 1 error, 2 invalid credential or runner removed, 3 outdated runner, 75
 * updated (the service starts it again, already on the new bundle, when `execve` does not exist).
 */
const EXIT = { invalid_token: 2, revoked: 2, outdated: 3, replaced: 0, stopped: 0, updated: 75 } as const;

/** Replaces this process with the new bundle (same runtime, same arguments). */
function restartInPlace(): number {
  const bundle = runningBundle();
  const execve = (process as { execve?: (file: string, args: string[], env: NodeJS.ProcessEnv) => never })
    .execve;
  if (!bundle || typeof execve !== "function") return EXIT.updated;
  execve(process.execPath, [process.execPath, bundle, ...process.argv.slice(2)], process.env);
  return EXIT.updated;
}

function flag(args: string[], name: string): string | undefined {
  const i = args.findIndex((a) => a === name || a.startsWith(`${name}=`));
  if (i < 0) return undefined;
  const a = args[i] as string;
  return a.includes("=") ? a.slice(a.indexOf("=") + 1) : args[i + 1];
}

const has = (args: string[], name: string) => args.includes(name);

function need<T>(v: T | null | undefined, msg: string): T {
  if (v === null || v === undefined) {
    console.error(msg);
    process.exit(1);
  }
  return v;
}

export async function main(argv: string[]): Promise<number> {
  const [cmd = "help", ...args] = argv;
  const home = runnerHome();
  switch (cmd) {
    case "version":
      console.log(RUNNER_VERSION);
      return 0;
    case "pair": {
      const server = need(flag(args, "--server") ?? readConfig(home)?.server, "Missing --server");
      try {
        await pair({
          server,
          home,
          name: flag(args, "--name"),
          workDir: flag(args, "--dir") ? resolve(flag(args, "--dir") as string) : undefined,
          exec: !has(args, "--no-exec"),
          fresh: has(args, "--new"),
        });
        return 0;
      } catch (err) {
        console.error(err instanceof PairingError ? err.message : String(err));
        return 1;
      }
    }
    case "start": {
      need(readConfig(home), `Not paired yet. Run: ${BIN} pair --server <url>`);
      const client = new RunnerClient({
        home,
        mcpCommand: selfCommand("mcp"),
        log: (l) => console.log(`[${new Date().toISOString()}] ${l}`),
      });
      const onSignal = () => void client.stop();
      process.on("SIGINT", onSignal);
      process.on("SIGTERM", onSignal);
      client.start();
      const reason = await client.exited;
      return reason === "updated" ? restartInPlace() : EXIT[reason];
    }
    case "update": {
      const bundlePath = runningBundle();
      if (has(args, "--rollback")) {
        const ok = rollbackUpdate(bundlePath);
        console.log(ok ? "Rolled back to the previous version." : "There is no previous version here.");
        return ok ? 0 : 1;
      }
      const cfg = need(readConfig(home), "Not paired.");
      try {
        const version = await update({ server: cfg.server, bundlePath });
        console.log(version ? `Updated to ${version}. Restart the runner.` : `Already on ${RUNNER_VERSION}.`);
        return 0;
      } catch (err) {
        console.error(
          err instanceof UpdateError ? `Update rejected (${err.code}): ${err.message}` : String(err),
        );
        return 1;
      }
    }
    case "sandbox": {
      const cfg = need(readConfig(home), "Not paired.");
      const [sub = "status"] = args;
      if (sub === "on" || sub === "off") {
        writeConfig(home, { ...cfg, sandbox: sub === "on" });
        console.log(
          sub === "on"
            ? "Sandbox on: agent commands run isolated."
            : "Sandbox off: agent commands run as you, with access to your files and network.",
        );
        return 0;
      }
      const s = (await openSandbox({ disabled: !cfg.sandbox })).status();
      console.log(`${s.state}${s.engine ? ` (${s.engine})` : ""}${s.reason ? `: ${s.reason}` : ""}`);
      return 0;
    }
    case "mcp":
      // MCP server that Claude Code/Codex starts during a harness turn (not for manual use).
      return runMcpStdio();
    case "status": {
      const cfg = readConfig(home);
      if (!cfg) {
        console.log("Not paired.");
        return 0;
      }
      const { token: _t, ...rest } = cfg;
      console.log(JSON.stringify({ version: RUNNER_VERSION, config: configPath(home), ...rest }, null, 2));
      return 0;
    }
    case "pause":
    case "resume": {
      const cfg = need(readConfig(home), "Not paired.");
      writeConfig(home, { ...cfg, paused: cmd === "pause" });
      console.log(cmd === "pause" ? "Paused." : "Running.");
      return 0;
    }
    case "folders": {
      const cfg = need(readConfig(home), "Not paired.");
      const [sub = "list", path] = args;
      if (sub === "list") {
        for (const f of cfg.access.folders)
          console.log(`${f.path}  ${f.agents.length ? f.agents.join(", ") : "(all agents)"}`);
        return 0;
      }
      const target = resolve(need(path, "Missing path"));
      const agentHandle = flag(args, "--agent");
      // The CLI knows the agents from the list the server sent last time (agents.json).
      const known = existsSync(join(home, "agents.json"))
        ? knownAgents.parse(JSON.parse(readFileSync(join(home, "agents.json"), "utf8")))
        : [];
      const agentId = agentHandle
        ? (known.find((a) => a.handle === agentHandle.replace(/^@/, ""))?.id ??
          need<string>(
            known.some((a) => a.id === agentHandle) ? agentHandle : null,
            `Unknown agent ${agentHandle}`,
          ))
        : undefined;
      if (sub === "allow") {
        const why = rejectedFolder(target, { runnerHome: home, workDir: cfg.workDir });
        if (why) {
          console.error(`This folder can't be shared (${why}).`);
          return 1;
        }
        if (!existsSync(target)) {
          console.error("Folder does not exist.");
          return 1;
        }
        const folders = cfg.access.folders.filter((f) => f.path !== target);
        const current = cfg.access.folders.find((f) => f.path === target);
        const agents = agentId ? [...new Set([...(current?.agents ?? []), agentId])] : [];
        if (folders.length >= 100) {
          console.error("Too many folders (100).");
          return 1;
        }
        writeConfig(home, {
          ...cfg,
          access: { ...cfg.access, folders: [...folders, { path: target, agents }] },
        });
        console.log(`Allowed ${target}${agentId ? ` for ${agentId}` : " for all agents"}.`);
        return 0;
      }
      if (sub === "remove") {
        const folders = cfg.access.folders.flatMap((f) => {
          if (f.path !== target) return [f];
          if (!agentId) return [];
          const agents = f.agents.filter((a) => a !== agentId);
          return agents.length ? [{ ...f, agents }] : [];
        });
        writeConfig(home, { ...cfg, access: { ...cfg.access, folders } });
        console.log(`Removed ${target}.`);
        return 0;
      }
      console.error(HELP);
      return 1;
    }
    case "tools": {
      const cfg = need(readConfig(home), "Not paired.");
      const [sub = "list", tool] = args;
      if (sub === "list") {
        for (const [k, v] of Object.entries(cfg.access.tools)) console.log(`${k}: ${v ? "on" : "off"}`);
        return 0;
      }
      if ((sub === "enable" || sub === "disable") && tool && tool in cfg.access.tools) {
        const tools = { ...cfg.access.tools, [tool]: sub === "enable" };
        writeConfig(home, { ...cfg, access: { ...cfg.access, tools } });
        console.log(`${tool}: ${sub === "enable" ? "on" : "off"}`);
        return 0;
      }
      console.error(HELP);
      return 1;
    }
    default:
      console.log(HELP);
      return cmd === "help" || cmd === "--help" || cmd === "-h" ? 0 : 1;
  }
}

if (import.meta.main || process.argv[1]?.endsWith(".mjs")) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
