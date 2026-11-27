// The agent's tools that run on the runner lent to it: commands, files, secrets and the browser. Each call
// becomes a request on the runner's WebSocket (RPC); the runner applies the agent's folder, the allowed
// folders and the tools turned on for that runner. A call only reaches the runner lent to this agent, paired to
// this workspace and not removed or revoked.

import type { EffectClass, RiskReason } from "@vanr/contract";
import {
  type AimedAction,
  blockMessage,
  type Consequence,
  consequenceOf,
  type ElementFacts,
  SECRET_FIELDS,
  secretBrowserBinding,
} from "@vanr/engine/browser-policy";
import { schema } from "@vanr/engine/db";
import { newId } from "@vanr/engine/ids";
import {
  type AgentRef,
  type BlockedLoad,
  type BrowserActResult,
  type BrowserInspectResult,
  type ExecResult,
  type ListResult,
  type OpArgs,
  type ReadResult,
  type RunnerOp,
  reservedSecretName,
} from "@vanr/engine/runner-protocol";
import { and, eq, gt, inArray, isNotNull } from "drizzle-orm";
import { z } from "zod";
import type { AgentRow } from "../agents";
import { assignmentGate } from "../assignments/engine";
import { contentOf, createFile, fileBytes, versionOf } from "../drive";
import { HttpError } from "../http";
import { defineStored } from "../runtime/base-tools";
import { domain, self, visibleFile } from "../runtime/content-tools";
import {
  define,
  type ToolContext,
  type ToolDef,
  ToolInputError,
  type ToolPlan,
  type ToolResult,
} from "../runtime/tools";
import { driverOf, openIntervention, policyFor, recordStep } from "./browser-guard";
import { RunnerCallError } from "./hub";
import { blockedText, networkPolicyFor, publishNetwork, recordBlocked, toNetworkRequest } from "./network";
import {
  INTERVENTION_TTL_MS,
  publishIntervention,
  publishSecret,
  SECRET_TTL_MS,
  toIntervention,
  toSecretRequest,
  waitIntervention,
} from "./requests";
import { canUseRunner, emitEnvironment, type RunnerRow } from "./runners";

const {
  agents,
  members,
  runners,
  agentEnvironments,
  secretPrompts,
  sandboxPolicies,
  browserInterventions,
  browserLogEntries,
  networkRequests,
} = schema;

const ref = (agent: Pick<AgentRow, "id" | "handle">): AgentRef => ({ id: agent.id, handle: agent.handle });

/** Bytes a file may have to go to or come from the runner through the Drive. */
const FILE_MAX = 5_000_000;
/** What the command's live output keeps (the last characters) and how often it goes to the screen. */
const LIVE_TAIL = 8000;
const LIVE_EVERY_MS = 250;
/**
 * Stdout and stderr the model gets from a command. Together they stay under TOOL_OUTPUT_MAX, so a long stdout
 * never pushes the stderr (where the error usually is) past the result's own cut.
 */
const STDOUT_MAX = 12_000;
const STDERR_MAX = 6000;

/**
 * The agent's runner now (read again: a person may have swapped it in the middle of the run). Only the runner
 * lent to this agent, paired to the run's workspace and neither removed nor revoked, and, when a person asked,
 * one that person may use: lending the runner to the agent doesn't lend it to everyone who talks to the agent.
 */
async function runnerOf(
  ctx: ToolContext,
  opts: { allowStopped?: boolean; allowOffline?: boolean } = {},
): Promise<RunnerRow> {
  const { db } = ctx.deps;
  const [a] = await db
    .select({ environmentId: agents.environmentId })
    .from(agents)
    .where(and(eq(agents.id, ctx.agent.id), eq(agents.workspaceId, ctx.workspaceId)));
  if (!a?.environmentId)
    throw new ToolInputError("You have no runner. Ask a person to lend you one in your settings.");
  const [m] = await db.select().from(runners).where(eq(runners.id, a.environmentId));
  if (!m || m.workspaceId !== ctx.workspaceId)
    throw new ToolInputError(
      "Your runner is not paired to this workspace. Ask a person to lend you another one.",
    );
  if (m.removedAt || m.revokedAt)
    throw new ToolInputError("Your runner was removed. Ask a person to lend you another one.");
  const personId = ctx.personId ?? ctx.trigger?.authorId ?? null;
  if (personId) {
    const [member] = await db
      .select({ role: members.role })
      .from(members)
      .where(and(eq(members.workspaceId, ctx.workspaceId), eq(members.userId, personId)));
    if (!member || !canUseRunner({ userId: personId, role: member.role }, m))
      throw new ToolInputError(
        "The person who asked may not use your runner, so you can't use it for them. Someone who may use it has to ask.",
      );
  }
  return ready(ctx, m, opts);
}

/** The checked runner can take a call now: the agent didn't stop it and it is connected. */
async function ready(
  ctx: ToolContext,
  m: RunnerRow,
  opts: { allowStopped?: boolean; allowOffline?: boolean } = {},
): Promise<RunnerRow> {
  if (!opts.allowStopped) {
    const [state] = await ctx.deps.db
      .select()
      .from(agentEnvironments)
      .where(eq(agentEnvironments.agentId, ctx.agent.id));
    if (state?.status === "stopped")
      throw new ToolInputError("Your runner is stopped. Call environment_start first.");
  }
  if (!opts.allowOffline && !ctx.deps.runners.isOnline(m.id))
    throw new ToolInputError(`Your runner (${m.name}) is offline. Tell the person; it reconnects by itself.`);
  return m;
}

type Readiness = { allowStopped?: boolean; allowOffline?: boolean };

/** What a runner tool's plan puts in the payload the approval's hash pins: the runner it checked, and its effect. */
const plannedOn = z.object({ runnerId: z.string().min(1), effect: z.unknown() });

/** A tool that runs on the agent's runner: its steps get the runner checked in their own phase. */
interface LentTool<I> {
  name: string;
  description: string;
  input: z.ZodType<I>;
  effect: EffectClass;
  /** How ready the runner must be for the run; by default not stopped and online. */
  readiness?: Readiness;
  plan?(ctx: ToolContext, input: I, runner: RunnerRow): Promise<ToolPlan>;
  /** `effect` is the plan's own payload (the element's fingerprint, for an aimed browser action). */
  run(ctx: ToolContext, input: I, runner: RunnerRow, effect: unknown): Promise<ToolResult | string>;
}

/**
 * The plan checks the agent's runner (see `runnerOf`), hands it to the tool's plan steps and puts its id in the
 * payload, so the approval's hash covers which runner the call is for. The run checks the runner again and stops
 * unless it is the one the payload names: a call planned (or approved) for one runner never reaches another, and
 * a run without that payload does nothing.
 */
function lent<I>(def: LentTool<I>): ToolDef<I> {
  const { readiness, plan, run, ...rest } = def;
  return {
    ...rest,
    async plan(ctx, input) {
      const runner = await runnerOf(ctx, { allowStopped: true, allowOffline: true });
      const own = plan ? await plan(ctx, input, runner) : {};
      return { ...own, payload: { runnerId: runner.id, effect: own.payload ?? input } };
    },
    async run(ctx, input, planned) {
      const on = plannedOn.safeParse(planned?.payload);
      if (!on.success) throw new ToolInputError("This call was not planned for a runner; nothing was done.");
      const runner = await runnerOf(ctx, readiness);
      if (runner.id !== on.data.runnerId)
        throw new ToolInputError(
          "Your runner changed since this call was planned; nothing was done. Try again.",
        );
      return run(ctx, input, runner, on.data.effect);
    },
  };
}

const BROWSER_UNAVAILABLE = "There is no browser on this runner.";

const EXPLAIN: Partial<Record<string, string>> = {
  exec_disabled: "Commands are turned off on this runner.",
  paused: "The runner is paused by its owner.",
  no_slot: "The runner is busy with other tasks; try again later.",
  browser_not_running: BROWSER_UNAVAILABLE,
  timeout: "The runner did not answer in time.",
  offline: "The runner went offline.",
  canceled: "The request was canceled before the runner did it.",
  sandbox_not_ready:
    "The runner cannot isolate your commands (its sandbox is missing). Tell the person; the runner page says what to install.",
  person_driving: "A person has control of your browser; nothing you asked was done.",
  page_changed: "The page changed before the action; nothing was done.",
};

/** A runner error for the model, with the runner's code (the browser log tells a refusal from a failure). */
class RunnerToolError extends ToolInputError {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

async function onRunner<O extends RunnerOp, T>(
  ctx: ToolContext,
  op: O,
  args: OpArgs<O>,
  opts: { timeoutMs?: number; stream?: boolean; runner: RunnerRow },
): Promise<{ runner: RunnerRow; data: T }> {
  const { runner } = opts;
  let out = "";
  let last = 0;
  try {
    const data = await ctx.deps.runners.call<O, T>(runner.id, op, args, {
      agent: ref(ctx.agent),
      signal: ctx.signal,
      timeoutMs: opts.timeoutMs,
      ...(opts.stream
        ? {
            onOutput: (_s, chunk) => {
              out = (out + chunk).slice(-LIVE_TAIL);
              const now = ctx.deps.now().getTime();
              if (now - last < LIVE_EVERY_MS) return;
              last = now;
              ctx.toolOutput(out);
            },
          }
        : {}),
    });
    await touch(ctx);
    return { runner, data };
  } catch (err) {
    if (err instanceof RunnerCallError) {
      const known = EXPLAIN[err.code];
      // A refusal by the browser rule: the runner's message already says what to do.
      const text =
        err.code === "not_allowed"
          ? err.message
          : known
            ? `${known} (${err.message})`
            : `${err.code}: ${err.message}`;
      throw new RunnerToolError(text, err.code);
    }
    throw err;
  }
}

/** What the runner answers to a `write`. */
interface WriteResult {
  path: string;
  bytes: number;
}

async function touch(ctx: ToolContext) {
  await ctx.deps.db
    .update(agentEnvironments)
    .set({ lastUsedAt: ctx.deps.now() })
    .where(eq(agentEnvironments.agentId, ctx.agent.id));
}

const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max)}\n[… cut ${text.length - max} chars]` : text;

function execText(r: ExecResult): string {
  const parts = [`exit code: ${r.timedOut ? "timeout" : r.exitCode}`];
  if (r.stdout) parts.push(`stdout:\n${clip(r.stdout, STDOUT_MAX)}`);
  if (r.stderr) parts.push(`stderr:\n${clip(r.stderr, STDERR_MAX)}`);
  if (r.truncated) parts.push("(output truncated on the runner)");
  return parts.join("\n");
}

/** The agent has a secret delivered on the runner (a variable or a file the commands read). */
async function hasSecrets(ctx: ToolContext): Promise<boolean> {
  const [row] = await ctx.deps.db
    .select({ id: secretPrompts.id })
    .from(secretPrompts)
    .where(and(eq(secretPrompts.agentId, ctx.agent.id), eq(secretPrompts.status, "delivered")))
    .limit(1);
  return !!row;
}

async function sandboxOf(ctx: ToolContext) {
  const [s] = await ctx.deps.db
    .select()
    .from(sandboxPolicies)
    .where(eq(sandboxPolicies.workspaceId, ctx.workspaceId));
  return s;
}

/** An assignment's gate said no or failed: an error for the model, never an unhandled throw. */
async function gated(ctx: ToolContext, tool: string, command: string) {
  try {
    await assignmentGate(ctx, tool, command);
  } catch (err) {
    if (err instanceof HttpError) throw new ToolInputError(err.message);
    throw err;
  }
}

const executeCode = defineStored(
  lent({
    name: "execute_code",
    description:
      "Run a shell command on your runner, in your own folder (or a folder the owner allowed). Use it to run scripts, tests, git, package managers. Secrets you have are available as environment variables or files.",
    effect: "K2",
    input: z.object({
      command: z.string().trim().min(1).max(20_000),
      cwd: z.string().max(1024).optional(),
      timeoutSeconds: z.number().int().min(1).max(3600).optional(),
    }),
    async plan(ctx, input, checked) {
      const runner = await ready(ctx, checked);
      // Commands the owner turned off stop here, before anyone is asked to approve one.
      if (!runner.access.tools.commands) throw new ToolInputError(EXPLAIN.exec_disabled as string);
      const s = await sandboxOf(ctx);
      return {
        // The command reaches the network: it counts as acting outside (C). With a delivered secret, it raises B.
        destination: { kind: "external", allowed: true, target: "environment" },
        raises: (await hasSecrets(ctx))
          ? [{ flag: "B", source: "execute_code with the agent's secrets" }]
          : [],
        // The command's output can carry content from the network (curl, git clone): it raises A for the next calls.
        reads: [{ flag: "A", source: "execute_code output" }],
        ...(s?.requireApproval ? { policy: "ask" as const } : {}),
        // "Always allow" covers this exact command, in this folder.
        rule: {
          key: `execute_code:${input.cwd ?? ""}:${input.command}`,
          label: input.command.length > 200 ? `${input.command.slice(0, 200)}…` : input.command,
        },
        preview: { title: "Run a command on the runner", body: input.command },
        card: {
          scope: "environment:execute_code",
          title: "Run a command on the runner",
          params: { command: input.command, cwd: input.cwd ?? null },
        },
      };
    },
    // The runner is checked before the assignment asks anyone: a command for a runner it can't reach never waits.
    async run(ctx, input, runner) {
      // The owner turned commands off on this runner: stopped here too, so nothing waits on a person for it.
      if (!runner.access.tools.commands) throw new ToolInputError(EXPLAIN.exec_disabled as string);
      // In an assignment, its autonomy decides whether the command goes on its own or waits for a person.
      await gated(ctx, "execute_code", input.command);
      // The workspace's maximum time (Settings › Runners) is the command's default and its ceiling.
      const limit = (await sandboxOf(ctx))?.commandTimeoutSec ?? 120;
      const timeoutSeconds = Math.min(input.timeoutSeconds ?? limit, limit);
      const network = await networkPolicyFor(ctx.deps, ctx.workspaceId, ctx.agent.id);
      const { data } = await onRunner<"exec", ExecResult>(
        ctx,
        "exec",
        { command: input.command, cwd: input.cwd, timeoutSeconds, network },
        // Read again after the gate: the person may have taken the runner away while the command waited.
        { timeoutMs: (timeoutSeconds + 15) * 1000, stream: true, runner: await sameRunner(ctx, runner) },
      );
      const blocked = data.blocked?.length ? await askForDomains(ctx, data.blocked, input.command) : "";
      return {
        content: blocked ? `${execText(data)}\n\n${blocked}` : execText(data),
        isError: data.exitCode !== 0,
      };
    },
  }),
);

/** The agent's runner is still the one checked before a wait. */
async function sameRunner(ctx: ToolContext, before: RunnerRow): Promise<RunnerRow> {
  const now = await runnerOf(ctx);
  if (now.id !== before.id)
    throw new ToolInputError("Your runner changed while the command waited; nothing was run. Try again.");
  return now;
}

/** Hosts the proxy blocked become domain requests, each with a card in the conversation. */
async function askForDomains(ctx: ToolContext, hosts: string[], command: string): Promise<string> {
  const outcome = await recordBlocked(ctx.deps, {
    workspaceId: ctx.workspaceId,
    agentId: ctx.agent.id,
    hosts,
    context: command,
    channelId: ctx.channel.id,
    threadId: ctx.threadId,
    runId: ctx.runId,
  });
  for (const row of outcome.fresh) {
    const card = await ctx.postCard(row.domain, { networkRequest: toNetworkRequest(row) });
    const [withCard] = await ctx.deps.db
      .update(networkRequests)
      .set({ messageId: card.id })
      .where(eq(networkRequests.id, row.id))
      .returning();
    await publishNetwork(ctx.deps, withCard ?? row, "network.requested");
  }
  return blockedText(outcome);
}

const readFile = define(
  lent({
    name: "read_file",
    description:
      "Read a text file from your runner (relative to your folder, or an absolute path the owner allowed).",
    effect: "K0",
    input: z.object({ path: z.string().trim().min(1).max(1024) }),
    // A file on the runner may have come from outside (a download, a clone): its content raises A.
    async plan(_ctx, input) {
      return { reads: [{ flag: "A", source: `read_file ${input.path}` }] };
    },
    async run(ctx, input, runner) {
      const { data } = await onRunner<"read", ReadResult>(
        ctx,
        "read",
        { path: input.path, maxBytes: 200_000 },
        { runner },
      );
      if (data.encoding === "base64") return `${data.path} is a binary file (${data.size} bytes).`;
      return `${data.path} (${data.size} bytes${data.truncated ? ", cut" : ""})\n\n${data.content}`;
    },
  }),
);

const writeFile = define(
  lent({
    name: "write_file",
    description: "Write a text file on your runner (creates folders). Set append to add to the end.",
    effect: "K1",
    input: z.object({
      path: z.string().trim().min(1).max(1024),
      content: z.string().max(2_000_000),
      append: z.boolean().optional(),
    }),
    async run(ctx, input, runner) {
      const { data } = await onRunner<"write", WriteResult>(
        ctx,
        "write",
        { path: input.path, content: input.content, encoding: "utf8", append: input.append ?? false },
        { runner },
      );
      return `Wrote ${data.path} (${data.bytes} bytes).`;
    },
  }),
);

const listFiles = define(
  lent({
    name: "list_files",
    description: "List a folder on your runner. Default: your own folder.",
    effect: "K0",
    input: z.object({ path: z.string().trim().max(1024).default(".") }),
    async run(ctx, input, runner) {
      const { data } = await onRunner<"list", ListResult>(
        ctx,
        "list",
        { path: input.path || "." },
        { runner },
      );
      if (data.entries.length === 0) return `${data.path} is empty.`;
      const lines = data.entries.map(
        (e) => `${e.kind === "dir" ? `${e.name}/` : e.name}${e.kind === "file" ? ` (${e.size} B)` : ""}`,
      );
      return `${data.path}\n${lines.join("\n")}${data.truncated ? "\n[… more entries]" : ""}`;
    },
  }),
);

const exportFile = defineStored(
  lent({
    name: "export_file",
    description: "Save a file from your runner into the Drive (attached to this conversation).",
    effect: "K1",
    input: z.object({
      path: z.string().trim().min(1).max(1024),
      title: z.string().trim().max(200).optional(),
    }),
    async run(ctx, input, runner) {
      const { data } = await onRunner<"read", ReadResult>(
        ctx,
        "read",
        { path: input.path, maxBytes: FILE_MAX },
        { runner },
      );
      if (data.truncated) throw new ToolInputError("The file is larger than 5 MB.");
      const bytes =
        data.encoding === "base64"
          ? Buffer.from(data.content, "base64")
          : new TextEncoder().encode(data.content);
      const fileName = data.path.split("/").pop() || "file";
      const { row } = await domain(
        createFile(ctx.deps, {
          workspaceId: ctx.workspaceId,
          title: input.title || fileName,
          author: self(ctx),
          file: {
            bytes: new Uint8Array(bytes),
            fileName,
            contentType:
              data.encoding === "base64" ? "application/octet-stream" : "text/plain; charset=utf-8",
          },
          channelId: ctx.channel.id,
          threadId: ctx.threadId,
        }),
      );
      await ctx.recordAction({
        kind: "file_created",
        target: { type: "file", id: row.id, title: row.title },
      });
      return `Saved ${data.path} to the Drive as "${row.title}" (${row.id}).`;
    },
  }),
);

const importFile = define(
  lent({
    name: "import_file",
    description: "Copy a Drive file (by file id) to your runner.",
    effect: "K1",
    input: z.object({ fileId: z.string().min(1).max(64), path: z.string().trim().min(1).max(1024) }),
    async run(ctx, input, runner) {
      // The agent and whoever asked both see the file: nobody copies to the runner a file they can't open.
      const row = await visibleFile(ctx, input.fileId);
      const v = await domain(versionOf(ctx.deps.db, row));
      if ((v.size ?? 0) > FILE_MAX) throw new ToolInputError("The file is larger than 5 MB.");
      const blob = await fileBytes(ctx.deps, v);
      const structured = contentOf(v);
      const text =
        "text" in structured && typeof structured.text === "string"
          ? structured.text
          : JSON.stringify(structured, null, 2);
      const bytes = blob ? blob.bytes : new TextEncoder().encode(text);
      if (bytes.length > FILE_MAX) throw new ToolInputError("The file is larger than 5 MB.");
      const { data } = await onRunner<"write", WriteResult>(
        ctx,
        "write",
        {
          path: input.path,
          content: Buffer.from(bytes).toString("base64"),
          encoding: "base64",
          append: false,
        },
        { runner },
      );
      return `Copied "${row.title}" to ${data.path} (${data.bytes} bytes).`;
    },
  }),
);

const environmentStatus = define(
  lent({
    name: "environment_status",
    description: "See which runner you use, whether it is online and what it allows.",
    effect: "K0",
    input: z.object({}),
    readiness: { allowStopped: true, allowOffline: true },
    // Everything below reads the runner the run checked.
    async run(ctx, _input, m) {
      const [state] = await ctx.deps.db
        .select({ status: agentEnvironments.status })
        .from(agentEnvironments)
        .where(eq(agentEnvironments.agentId, ctx.agent.id));
      const online = ctx.deps.runners.isOnline(m.id);
      const tools = Object.entries(m.access.tools)
        .filter(([, on]) => on)
        .map(([t]) => t);
      return [
        `Runner: ${m.name} (${m.os}/${m.arch}), ${online ? "online" : "offline"}, ${state?.status ?? "stopped"}${m.paused ? ", paused" : ""}.`,
        m.workDir ? `Your folder is inside ${m.workDir}.` : "",
        `Allowed: ${tools.join(", ") || "nothing"}.`,
        m.access.folders.length ? `Extra folders: ${m.access.folders.map((f) => f.path).join(", ")}.` : "",
      ]
        .filter(Boolean)
        .join("\n");
    },
  }),
);

const setEnvironment = (status: "running" | "stopped") =>
  define(
    lent({
      name: status === "running" ? "environment_start" : "environment_stop",
      description:
        status === "running"
          ? "Start using your runner again after it was stopped."
          : "Stop using your runner (commands and the browser stop working until environment_start).",
      effect: "K1",
      input: z.object({}),
      readiness: { allowStopped: true },
      async run(ctx) {
        await ctx.deps.db
          .insert(agentEnvironments)
          .values({ agentId: ctx.agent.id, workspaceId: ctx.workspaceId, status, lastUsedAt: ctx.deps.now() })
          .onConflictDoUpdate({
            target: agentEnvironments.agentId,
            set: { status, updatedAt: ctx.deps.now() },
          });
        await emitEnvironment(ctx.deps, ctx.workspaceId, ctx.agent.id);
        return status === "running" ? "Your runner is ready." : "Your runner is stopped.";
      },
    }),
  );

const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;

const requestSecret = defineStored(
  lent({
    name: "request_secret",
    description:
      "Ask a person for a credential (API key, password, token). The value goes sealed from their browser straight to your runner; you never see it. Once delivered, it is available to your commands as an environment variable with this name, or as a file. For a website login, pass sites (where it may be typed) and field instead: then it is only typed with browser_type_secret on those sites, in that kind of field, and never reaches your commands. Stop and wait for the person after asking.",
    effect: "K1",
    input: z
      .object({
        name: z.string().trim().regex(SECRET_NAME, "Use UPPER_SNAKE_CASE, like GITHUB_TOKEN"),
        purpose: z.string().trim().min(1).max(500),
        file: z
          .string()
          .trim()
          .max(300)
          .optional()
          .describe("Relative path to write it as a file instead of an env var"),
        sites: secretBrowserBinding.shape.sites
          .optional()
          .describe(
            "Browser secret: the only sites where it may be typed, like example.com or *.example.com",
          ),
        field: z
          .enum(SECRET_FIELDS)
          .optional()
          .describe(
            "Browser secret: password field, or a one-line text field (user name, code). Default password",
          ),
      })
      .refine((v) => !(v.sites && v.file), {
        message: "A browser secret is typed on a site, not written to a file",
        path: ["file"],
      })
      .refine((v) => !!v.sites || !v.field, { message: "field needs sites", path: ["field"] })
      // A Claude or OpenAI API key as a variable would make the CLI bill the API instead of the plan.
      .refine((v) => !!v.file || !reservedSecretName(v.name), {
        message: "This name is reserved on runners (API keys and system variables); pick another one",
        path: ["name"],
      })
      .refine((v) => !v.file || (!v.file.startsWith("/") && !v.file.split("/").includes("..")), {
        message: "file must be a path inside your folder, like .config/key.json",
        path: ["file"],
      }),
    async plan(_ctx, input) {
      return { raises: [{ flag: "B", source: `request_secret ${input.name}` }] };
    },
    async run(ctx, input, runner) {
      const requestId = newId("sr");
      const { data } = await onRunner<"secret.prepare", { publicKey: string }>(
        ctx,
        "secret.prepare",
        { requestId },
        { runner },
      );
      const now = ctx.deps.now();
      const [row] = await ctx.deps.db
        .insert(secretPrompts)
        .values({
          id: requestId,
          workspaceId: ctx.workspaceId,
          agentId: ctx.agent.id,
          runnerId: runner.id,
          name: input.name,
          purpose: input.purpose,
          target: input.file ? "file" : "env",
          filePath: input.file ?? null,
          targetUserId: ctx.trigger?.authorId ?? null,
          publicKey: data.publicKey,
          browser: input.sites
            ? { sites: [...new Set(input.sites)], field: input.field ?? "password" }
            : null,
          channelId: ctx.channel.id,
          threadId: ctx.threadId,
          runId: ctx.runId,
          createdAt: now,
          expiresAt: new Date(now.getTime() + SECRET_TTL_MS),
        })
        .returning();
      if (!row) throw new Error("secret request insert failed");
      const card = await ctx.postCard(input.purpose, { secretRequest: toSecretRequest(row) });
      const [withCard] = await ctx.deps.db
        .update(secretPrompts)
        .set({ messageId: card.id })
        .where(eq(secretPrompts.id, row.id))
        .returning();
      await publishSecret(ctx.deps, withCard ?? row, "secret_request.created");
      const use = input.sites
        ? `you can type it with browser_type_secret on ${input.sites.join(", ")} (it does not reach your commands)`
        : `your commands get it as ${input.file ? `the file ${input.file}` : `$${input.name}`}`;
      return `Asked for ${input.name}. A card is in the conversation; when someone delivers it, ${use}. Tell the person why you need it and stop here until they deliver it.`;
    },
  }),
);

const ENVIRONMENT_TOOLS: readonly ToolDef<unknown>[] = [
  executeCode,
  readFile,
  writeFile,
  listFiles,
  exportFile,
  importFile,
  environmentStatus,
  setEnvironment("running"),
  setEnvironment("stopped"),
  requestSecret,
];

// ---- browser ----
//
// The origin rule (list, level, sensitive sites, private network) holds on the runner before every load and
// every action; here it is built (browser-guard.ts) and goes with each operation, always with the agent
// driving. With a person in control, the tool waits for them to hand back and doesn't do the action asked
// before: the page may have changed. Each step goes to the log, with the page's thumbnail.

function pageText(r: BrowserActResult): string {
  const list = (bs: BlockedLoad[]) =>
    bs.map((b) => `- ${blockMessage(b.reason, hostOf(b.url), b.detail)}`).join("\n");
  const own = r.blocked?.filter((b) => !b.before) ?? [];
  const before = r.blocked?.filter((b) => b.before) ?? [];
  const blocked = [
    own.length > 0 && !r.text?.startsWith("Blocked before loading")
      ? `Blocked before loading:\n${list(own)}`
      : "",
    before.length > 0 ? `Since your last step, the page tried to load and was blocked:\n${list(before)}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  // The runner answers the dialogs on its own (otherwise the page stops): the agent learns what they said.
  const dialogs =
    r.dialogs && r.dialogs.length > 0
      ? `The page opened dialogs (alert accepted, confirm and prompt canceled):\n${r.dialogs.map((d) => `- ${d.type}${d.message ? `: ${JSON.stringify(d.message)}` : ""}`).join("\n")}`
      : "";
  return [`${r.title || "(no title)"} — ${r.url}`, r.text ?? "", blocked, dialogs]
    .filter(Boolean)
    .join("\n\n");
}

const hostOf = (url: string) => {
  try {
    return new URL(url.includes("://") ? url : `http://${url}`).host;
  } catch {
    return url;
  }
};

/** With a person driving, waits for them to hand back; the action asked before does not happen. */
async function waitForPerson(ctx: ToolContext): Promise<void> {
  const open = await openIntervention(ctx.deps.db, ctx.agent.id, ctx.deps.now());
  if (open?.status !== "active") return;
  const reread = async () => {
    const [row] = await ctx.deps.db
      .select()
      .from(browserInterventions)
      .where(eq(browserInterventions.id, open.id));
    return row;
  };
  const done = await waitIntervention(open.id, ctx.signal, reread);
  if (!done) throw new ToolInputError("The run stopped while a person had control of your browser.");
  throw new ToolInputError(
    `A person took control of your browser and gave it back${done.note ? ` (note: ${done.note})` : ""}. The page may have changed; nothing you asked was done. Call browser_read before acting again.`,
  );
}

function browserOf(runner: RunnerRow): RunnerRow {
  if (!runner.browser || !runner.access.tools.browser) throw new ToolInputError(BROWSER_UNAVAILABLE);
  return runner;
}

/** Tells the checked runner the policy again (who drives now), so a hand-back that didn't reach it does. */
async function repush(ctx: ToolContext, runner: RunnerRow) {
  const policy = await policyFor(
    ctx.deps,
    ctx.agent.id,
    runner.id,
    await driverOf(ctx.deps.db, ctx.agent.id, ctx.deps.now()),
  );
  await onRunner(ctx, "browser.policy", { policy }, { runner, timeoutMs: 10_000 }).catch(() => {});
}

type BrowserOp = "browser.open" | "browser.act" | "browser.close";

const personDriving = (err: unknown) => err instanceof RunnerToolError && err.code === "person_driving";

/**
 * A browser operation with the agent's policy, recorded in the log (it worked, failed or was blocked). The
 * runner turns it down if, for it, a person drives: either they took over between the check here and the operation
 * (then it waits for them to hand back), or the notice that they handed back didn't reach it (then, with
 * nobody in control, it tells it again and tries once more).
 */
async function browserCall<O extends BrowserOp>(
  ctx: ToolContext,
  checked: RunnerRow,
  tool: string,
  input: Record<string, unknown>,
  op: O,
  args: Omit<OpArgs<O>, "policy" | "driver">,
  timeoutMs = 45_000,
): Promise<BrowserActResult> {
  const runner = browserOf(checked);
  let r: BrowserActResult | null = null;
  let failure: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    await waitForPerson(ctx);
    if (attempt > 0) await repush(ctx, runner);
    const full =
      op === "browser.close"
        ? { ...args, driver: "agent" }
        : { ...args, policy: await policyFor(ctx.deps, ctx.agent.id, runner.id, "agent") };
    try {
      r = (await onRunner<O, BrowserActResult>(ctx, op, full as OpArgs<O>, { timeoutMs, runner })).data;
      failure = null;
      break;
    } catch (err) {
      failure = err;
      if (!personDriving(err)) break;
    }
  }
  const blocked = r?.blocked ?? [];
  // What the page tried before the action stays in the log, but doesn't make this action a blocked step.
  const own = blocked.filter((b) => !b.before);
  await recordStep(ctx.deps, {
    workspaceId: ctx.workspaceId,
    agentId: ctx.agent.id,
    runnerId: runner.id,
    runId: ctx.runId,
    channelId: ctx.channel.id,
    tool,
    action: input,
    url: r?.url ?? ("url" in args && typeof args.url === "string" ? args.url : null),
    outcome: failure
      ? failure instanceof RunnerToolError && (failure.code === "not_allowed" || personDriving(failure))
        ? "blocked"
        : "error"
      : own.length > 0 || r?.ok === false
        ? "blocked"
        : "ok",
    message: failure instanceof Error ? failure.message : own.length > 0 ? (r?.text ?? null) : null,
    blocked,
    ...(r?.shot ? { shot: r.shot } : {}),
  });
  if (failure) throw failure;
  if (!r) throw new ToolInputError("The runner gave no answer.");
  return r;
}

const target = z
  .string()
  .trim()
  .min(1)
  .max(2000)
  .describe("Element number from browser_read (like 12) or a CSS selector");

/**
 * The class of the browser actions: reading the page is K0 and raises A; clicking, pressing a key and uploading
 * act on the site (K2, C); filling stays on the page until a click (K1). Every action returns the page's text,
 * so the result raises A for the next calls (`reads`): the browser may have stayed open on an outside site since
 * another run. Whoever acts outside also raises B if the browser already had a session (`sessionRisk`), and a
 * click, Enter and upload go through the element check (`aimedPlan`).
 */
type BrowserKind = "read" | "act" | "fill";
const BROWSER_EFFECT = { read: "K0", act: "K2", fill: "K1" } as const;

const pageRead = (name: string) => [{ flag: "A" as const, source: `${name} (web page)` }];

const browserPlan =
  (kind: BrowserKind, name: string) =>
  async <I>(ctx: ToolContext, _input: I, runner: RunnerRow): Promise<ToolPlan> => {
    if (kind === "read") return { raises: pageRead(name) };
    if (kind === "act")
      return {
        destination: { kind: "external", allowed: true, target: "browser" },
        raises: await sessionRisk(ctx, browserOf(runner).id),
        reads: pageRead(name),
      };
    return { reads: pageRead(name) };
  };

/**
 * Rule of two: this runner's browser already had a session, because a person took over (they may have signed
 * into an account) or the agent typed a secret in it. The profile stays from one run to the next, so it raises
 * B on every run that acts outside with it.
 */
async function sessionRisk(ctx: ToolContext, runnerId: string): Promise<RiskReason[]> {
  const { db } = ctx.deps;
  const [took] = await db
    .select({ id: browserInterventions.id })
    .from(browserInterventions)
    .where(
      and(
        eq(browserInterventions.agentId, ctx.agent.id),
        eq(browserInterventions.runnerId, runnerId),
        isNotNull(browserInterventions.controllingUserId),
      ),
    )
    .limit(1);
  if (took) return [{ flag: "B", source: "browser session (a person had control)" }];
  const [typed] = await db
    .select({ id: browserLogEntries.id })
    .from(browserLogEntries)
    .where(
      and(
        eq(browserLogEntries.agentId, ctx.agent.id),
        eq(browserLogEntries.runnerId, runnerId),
        eq(browserLogEntries.tool, "browser_type_secret"),
        eq(browserLogEntries.outcome, "ok"),
      ),
    )
    .limit(1);
  return typed ? [{ flag: "B", source: "browser session (a secret was typed)" }] : [];
}

/** What a click, a key, an upload, a check or a choice will hit. */
interface Aim {
  action: AimedAction;
  selector?: string;
  key?: string;
  file?: string;
  option?: string;
  checked?: boolean;
}

/** A key that can act as a click or a submit; the others (Tab, arrows) skip the check. */
const aimed = (a: Aim) => {
  if (a.action !== "press") return true;
  // A combination ends in the key that acts (Control+Enter submits like Enter), as consequenceOf reads it.
  const key = a.key?.split("+").at(-1);
  return key === "Enter" || key === " " || key === "Space";
};

/** Asks the runner, without acting, what the action will hit. It stays out of the log: nothing happened. */
async function inspect(ctx: ToolContext, runner: RunnerRow, a: Aim): Promise<BrowserInspectResult> {
  for (let attempt = 0; ; attempt++) {
    await waitForPerson(ctx);
    if (attempt > 0) await repush(ctx, runner);
    const policy = await policyFor(ctx.deps, ctx.agent.id, runner.id, "agent");
    try {
      return (
        await onRunner<"browser.inspect", BrowserInspectResult>(
          ctx,
          "browser.inspect",
          { action: a.action, selector: a.selector, policy },
          { runner },
        )
      ).data;
    } catch (err) {
      if (attempt > 0 || !personDriving(err)) throw err;
    }
  }
}

/** The card's title in English (the screen translates it by `approvals.titles.<tool>`). */
function aimTitle(a: Aim, what: string, site: string): string {
  const w = `"${clipLine(what)}"`;
  switch (a.action) {
    case "click":
      return `Click ${w} on ${site}`;
    case "press":
      return `Press ${a.key} on ${w} on ${site}`;
    case "upload":
      return `Upload ${w} to ${site}`;
    case "check":
      return `${a.checked === false ? "Uncheck" : "Check"} ${w} on ${site}`;
    case "select":
      return `Choose "${clipLine(a.option ?? "")}" in ${w} on ${site}`;
  }
}

/**
 * The plan of a click, a key and an upload: the runner says what the action will hit, and the element's fingerprint
 * goes in the payload, which the run sends as `expect`: the runner doesn't act if the page changed since; what can't be taken back
 * (buying, publishing, deleting, sending a form, sending a file) goes up to K3 and always asks a person. The
 * destination is the page's origin. The payload (page, element and fingerprint) is what the approval's hash
 * pins: if the page changes before the person approves, the plan made again doesn't match and nothing runs. An
 * action the origin rule doesn't allow (read only, sensitive) goes on without going up: the runner turns it down and
 * the log keeps it.
 */
async function aimedPlan(ctx: ToolContext, name: string, checked: RunnerRow, a: Aim): Promise<ToolPlan> {
  // The element check talks to the runner: only one that can take a call now (not stopped, online).
  const runner = browserOf(await ready(ctx, checked));
  const plan: ToolPlan = {
    destination: { kind: "external", allowed: true, target: "browser" },
    raises: await sessionRisk(ctx, runner.id),
    reads: pageRead(name),
  };
  if (!aimed(a)) return plan;
  const r = await inspect(ctx, runner, a);
  const site = hostOf(r.url);
  const el = r.element;
  const what =
    a.action === "upload" ? (a.file ?? "") : el?.label || el?.tag || a.selector || "the focused element";
  const title = aimTitle(a, what, site);
  const consequence = r.allowed ? consequenceOf(el, a.action, a.key ?? a.option) : null;
  return {
    ...plan,
    destination: { kind: "external", allowed: true, target: site },
    ...(consequence ? { effect: "K3" as const } : {}),
    payload: { tool: name, ...a, url: r.url, element: el, fingerprint: r.fingerprint },
    preview: { title, body: aimBody(r.url, el, a, consequence), links: [r.url] },
    card: {
      scope: `browser:${a.action}`,
      title,
      params: {
        label: clipLine(what),
        site,
        key: a.key ?? null,
        file: a.file ?? null,
        option: a.option ?? null,
      },
    },
  };
}

const clipLine = (s: string) => (s.length > 80 ? `${s.slice(0, 79)}…` : s);

const WHY: Record<Consequence, string> = {
  purchase: "it looks like a purchase or payment",
  publish: "it looks like publishing or posting",
  delete: "it looks like deleting or canceling something",
  send: "it looks like sending or confirming something",
  submit: "it sends a form",
  upload: "it sends a file from the runner to the site",
};

/** What the person sees on the card: the page, the element and what it does. */
function aimBody(url: string, el: ElementFacts | null, a: Aim, consequence: Consequence | null): string {
  const lines = [`Page: ${url}`];
  if (el) lines.push(`Element: ${el.tag}${el.type ? ` (${el.type})` : ""} "${el.label}"`);
  if (a.action === "press") lines.push(`Key: ${a.key}`);
  if (a.action === "select") lines.push(`Option: ${a.option}`);
  if (a.action === "check") lines.push(a.checked === false ? "Uncheck" : "Check");
  if (a.file) lines.push(`File: ${a.file}`);
  if (el?.form) lines.push(`Form: ${el.form.method.toUpperCase()} ${el.form.action}`);
  if (el?.href) lines.push(`Link: ${el.href}`);
  if (consequence) lines.push(`A person approves because ${WHY[consequence]}.`);
  return lines.join("\n");
}

const browserTool = <S extends z.ZodType<Record<string, unknown>>>(
  name: string,
  description: string,
  input: S,
  toArgs: (i: z.infer<S>) => Omit<OpArgs<"browser.act">, "policy">,
  kind: BrowserKind = "act",
  aim?: (i: z.infer<S>) => Aim,
) =>
  define(
    lent({
      name,
      description,
      effect: BROWSER_EFFECT[kind],
      plan: aim
        ? (ctx, i, runner) => aimedPlan(ctx, name, runner, aim(i as z.infer<S>))
        : browserPlan(kind, name),
      input,
      async run(ctx, i, runner, effect) {
        const args = toArgs(i as z.infer<S>);
        // Without the plan's fingerprint: "" never matches and the runner doesn't act.
        const fingerprint = (effect as { fingerprint?: unknown } | null)?.fingerprint;
        const expect =
          aim && aimed(aim(i as z.infer<S>))
            ? { expect: typeof fingerprint === "string" ? fingerprint : "" }
            : {};
        const r = await browserCall(ctx, runner, name, i as Record<string, unknown>, "browser.act", {
          ...args,
          ...expect,
        });
        return pageText(r);
      },
    }),
  );

const normalizeUrl = (url: string) => (/^https?:\/\//i.test(url) ? url : `https://${url}`);

const browserNavigate = define(
  lent({
    name: "browser_navigate",
    description:
      "Open a web page in your browser (on your runner). Then use browser_read to see it. Some sites are read-only for you, and banks, e-mail, health and government login sites only open with a person driving: use browser_ask_person for those.",
    effect: "K0",
    // Opening a URL is a request outside: the address can carry data (C). The site list holds at run time.
    async plan(ctx, input, runner) {
      return {
        destination: { kind: "external", allowed: true, target: normalizeUrl(input.url) },
        raises: await sessionRisk(ctx, browserOf(runner).id),
        reads: pageRead("browser_navigate"),
      };
    },
    input: z.object({ url: z.string().trim().min(1).max(4000) }),
    async run(ctx, input, runner) {
      const r = await browserCall(
        ctx,
        runner,
        "browser_navigate",
        input,
        "browser.open",
        { url: normalizeUrl(input.url) },
        60_000,
      );
      return r.ok === false ? { content: pageText(r), isError: true } : pageText(r);
    },
  }),
);

const browserScreenshot = define(
  lent({
    name: "browser_screenshot",
    description: "Take a screenshot of the page and save it to the Drive (attached to this conversation).",
    effect: "K1",
    input: z.object({}),
    async run(ctx, input, runner) {
      const r = await browserCall(ctx, runner, "browser_screenshot", input, "browser.act", {
        action: "screenshot",
      });
      if (!r.screenshot) throw new ToolInputError("The browser did not return a screenshot.");
      const { row } = await domain(
        createFile(ctx.deps, {
          workspaceId: ctx.workspaceId,
          title: `Screenshot — ${r.title || r.url}`.slice(0, 200),
          author: self(ctx),
          file: {
            bytes: new Uint8Array(Buffer.from(r.screenshot, "base64")),
            fileName: "screenshot.jpg",
            contentType: "image/jpeg",
          },
          channelId: ctx.channel.id,
          threadId: ctx.threadId,
        }),
      );
      return `Screenshot of ${r.url} saved to the Drive (${row.id}).`;
    },
  }),
);

const browserAskPerson = defineStored(
  lent({
    name: "browser_ask_person",
    description:
      "Ask a person to do something in your browser that you must not do yourself: sign in, solve a captcha, confirm a payment, or use a sensitive site (bank, e-mail, health, government login). They take control from the live view and give it back. Waits until they finish.",
    effect: "K1",
    input: z.object({
      kind: z.enum(["login", "captcha", "confirm", "other"]),
      instructions: z.string().trim().min(1).max(1000),
    }),
    async plan(_ctx, input) {
      // After the person's login, the agent's browser has a session: B.
      return input.kind === "login" ? { raises: [{ flag: "B", source: "browser_ask_person login" }] } : {};
    },
    async run(ctx, input, checked) {
      const runner = browserOf(checked);
      const page = await browserCall(ctx, runner, "browser_list_tabs", {}, "browser.act", {
        action: "tabs",
      }).catch(() => null);
      const now = ctx.deps.now();
      const id = newId("bi");
      // At most one open request per agent: the check and the insert run under the agent's row lock, so two
      // calls at once make one card.
      const row = await ctx.deps.db.transaction(async (tx) => {
        await tx.select({ id: agents.id }).from(agents).where(eq(agents.id, ctx.agent.id)).for("update");
        const [open] = await tx
          .select({ id: browserInterventions.id })
          .from(browserInterventions)
          .where(
            and(
              eq(browserInterventions.agentId, ctx.agent.id),
              inArray(browserInterventions.status, ["pending", "active"]),
              gt(browserInterventions.expiresAt, now),
            ),
          );
        if (open) return null;
        const [inserted] = await tx
          .insert(browserInterventions)
          .values({
            id,
            workspaceId: ctx.workspaceId,
            agentId: ctx.agent.id,
            runnerId: runner.id,
            kind: input.kind,
            instructions: input.instructions,
            url: page?.url ?? null,
            targetUserId: ctx.trigger?.authorId ?? null,
            channelId: ctx.channel.id,
            threadId: ctx.threadId,
            runId: ctx.runId,
            createdAt: now,
            expiresAt: new Date(now.getTime() + INTERVENTION_TTL_MS),
          })
          .returning();
        return inserted ?? null;
      });
      if (!row) throw new ToolInputError("You already asked a person; wait for that request first.");
      // Without its card nobody can take the request, and it would block the agent's next ones until it expires. Only
      // a request nobody answered yet is canceled: a person who already took or finished it keeps what they did.
      const card = await ctx
        .postCard(input.instructions, { browserIntervention: { id } })
        .catch(async (err: unknown) => {
          await ctx.deps.db
            .update(browserInterventions)
            .set({ status: "canceled", handledAt: ctx.deps.now() })
            .where(and(eq(browserInterventions.id, id), eq(browserInterventions.status, "pending")));
          throw err;
        });
      const [withCard] = await ctx.deps.db
        .update(browserInterventions)
        .set({ messageId: card.id })
        .where(eq(browserInterventions.id, id))
        .returning();
      const waiting = waitIntervention(id, ctx.signal);
      await publishIntervention(ctx.deps, withCard ?? row);
      const done = await waiting;
      if (!done) return { content: "The run stopped before the person finished.", isError: true };
      const h = toIntervention(done);
      if (h.status === "done") {
        // A sensitive page: the runner returns only the notice, without the text (the agent reads no bank nor e-mail).
        // After the wait the runner is checked again, and the page is read only from the runner the call was for.
        const now = await runnerOf(ctx).catch(() => null);
        const after =
          now?.id === runner.id
            ? await browserCall(ctx, now, "browser_read", {}, "browser.act", { action: "read" }).catch(
                () => null,
              )
            : null;
        const finished = `The person finished${h.note ? `: ${h.note}` : ""}.`;
        // The page's text comes from outside, like browser_read's: it raises A for the next calls.
        return after
          ? { content: `${finished}\n\n${pageText(after)}`, reads: pageRead("browser_ask_person") }
          : finished;
      }
      return {
        content: `The person did not finish (${h.status})${h.note ? `: ${h.note}` : ""}.`,
        isError: true,
      };
    },
  }),
);

const browserClose = define(
  lent({
    name: "browser_close",
    description: "Close your browser.",
    effect: "K0",
    input: z.object({}),
    async run(ctx, input, runner) {
      // Goes through the person in control and into the log like the other browser tools.
      await browserCall(ctx, runner, "browser_close", input, "browser.close", {});
      return "Browser closed.";
    },
  }),
);

export const BROWSER_TOOLS: readonly ToolDef<unknown>[] = [
  browserNavigate,
  browserTool(
    "browser_back",
    "Go back to the previous page.",
    z.object({}),
    () => ({ action: "back" }),
    "read",
  ),
  define(
    lent({
      name: "browser_list_tabs",
      description: "List the open tabs; pass index to switch to one.",
      effect: "K0",
      plan: browserPlan("read", "browser_list_tabs"),
      input: z.object({ index: z.number().int().min(0).max(50).optional() }),
      async run(ctx, input, runner) {
        const r = await browserCall(ctx, runner, "browser_list_tabs", input, "browser.act", {
          action: "tabs",
          index: input.index,
        });
        return (
          (r.tabs ?? [])
            .map((t, i) => `${t.active ? "*" : " "} [${i}] ${t.title || "(no title)"} — ${t.url}`)
            .join("\n") || "No tabs."
        );
      },
    }),
  ),
  browserTool(
    "browser_read",
    "Read the page: visible text and the numbered elements you can click or fill.",
    z.object({}),
    () => ({ action: "read" }),
    "read",
  ),
  browserTool(
    "browser_click",
    "Click an element. Buying, paying, publishing, deleting and sending a form wait for a person to approve.",
    z.object({ target }),
    (i) => ({ action: "click", selector: i.target }),
    "act",
    (i) => ({ action: "click", selector: i.target }),
  ),
  browserTool(
    "browser_fill",
    "Type text into a field (replaces what is there). Never type passwords: use browser_type_secret.",
    z.object({ target, text: z.string().max(20_000) }),
    (i) => ({ action: "fill", selector: i.target, text: i.text }),
    "fill",
  ),
  // Choosing and checking count as acting on the site: the page often saves at once (a settings switch, an
  // `onchange` that submits the form).
  browserTool(
    "browser_select",
    "Pick an option in a dropdown, by its visible text or value.",
    z.object({ target, option: z.string().max(500) }),
    (i) => ({ action: "select", selector: i.target, text: i.option }),
    "act",
    (i) => ({ action: "select", selector: i.target, option: i.option }),
  ),
  browserTool(
    "browser_check",
    "Check or uncheck a checkbox or radio.",
    z.object({ target, checked: z.boolean().default(true) }),
    (i) => ({ action: "check", selector: i.target, text: i.checked ? "true" : "false" }),
    "act",
    (i) => ({ action: "check", selector: i.target, checked: i.checked }),
  ),
  browserTool(
    "browser_press",
    "Press a key (Enter, Tab, Escape, ArrowDown, Backspace…) in the focused element.",
    z.object({ key: z.string().trim().min(1).max(40) }),
    (i) => ({ action: "press", key: i.key }),
    "act",
    (i) => ({ action: "press", key: i.key }),
  ),
  browserTool(
    "browser_scroll",
    "Scroll the page (positive goes down).",
    z.object({ pixels: z.number().int().min(-20_000).max(20_000).default(800) }),
    (i) => ({ action: "scroll", dy: i.pixels }),
    "read",
  ),
  browserTool(
    "browser_upload",
    "Attach a file from your runner to a file field. A person approves it first.",
    z.object({ target, path: z.string().trim().min(1).max(1024) }),
    (i) => ({ action: "upload", selector: i.target, text: i.path }),
    "act",
    (i) => ({ action: "upload", selector: i.target, file: i.path }),
  ),
  define(
    lent({
      name: "browser_type_secret",
      description: "Type one of your secrets (by name) into a field without seeing it, like a password.",
      effect: "K1",
      input: z.object({ target, name: z.string().trim().regex(SECRET_NAME) }),
      async plan(_ctx, input) {
        return {
          raises: [{ flag: "B", source: `browser_type_secret ${input.name}` }],
          reads: pageRead("browser_type_secret"),
        };
      },
      async run(ctx, input, runner) {
        const r = await browserCall(ctx, runner, "browser_type_secret", input, "browser.act", {
          action: "type_secret",
          selector: input.target,
          name: input.name,
        });
        return pageText(r);
      },
    }),
  ),
  browserTool(
    "browser_wait",
    "Wait until some text shows up on the page, or for a number of milliseconds.",
    z.object({ text: z.string().max(500).optional(), ms: z.number().int().min(0).max(30_000).default(2000) }),
    (i) => ({ action: "wait", ...(i.text ? { text: i.text } : {}), ms: i.ms }),
    "read",
  ),
  browserScreenshot,
  browserAskPerson,
  browserClose,
];

/**
 * The runner tools for this agent: only with a runner lent to it, paired to its workspace and neither removed
 * nor revoked. The browser ones only when that runner has a browser the owner turned on.
 */
export async function environmentToolsFor(ctx: {
  deps: ToolContext["deps"];
  agent: AgentRow;
}): Promise<ToolDef<unknown>[]> {
  if (!ctx.agent.environmentId) return [];
  const [m] = await ctx.deps.db
    .select()
    .from(runners)
    .where(and(eq(runners.id, ctx.agent.environmentId), eq(runners.workspaceId, ctx.agent.workspaceId)));
  if (!m || m.removedAt || m.revokedAt) return [];
  const tools = [...ENVIRONMENT_TOOLS];
  if (m.browser && m.access.tools.browser) tools.push(...BROWSER_TOOLS);
  return tools;
}
