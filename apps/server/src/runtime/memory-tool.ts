// Memory tool: the six commands of the API's `memory_20250818` with our own handler over Postgres. The model
// sees /memories with three stores (agent, you, workspace); each file is a memory item. The workspace's store
// is read only for the agent (it changes by proposal); a write with flag A goes to the review queue; every
// write becomes an immutable version. The return texts follow the tool's docs.

import type { MemoryScope } from "@vanr/contract";
import {
  contentSha256,
  isUnder,
  MEMORY_ITEM_MAX_BYTES,
  MEMORY_ROOT,
  type MemoryPath,
  MemoryPathError,
  memoryWriteNeedsReview,
  numberLines,
  parseMemoryPath,
  rememberedPath,
  utf8Bytes,
  virtualPath,
} from "@vanr/engine/memory";
import { z } from "zod";
import {
  type Author,
  changeMemory,
  createMemory,
  itemAtPath,
  itemsUnder,
  type MemoryRow,
  rememberedItem,
  type Store,
  storeEntries,
} from "../agent-memory";
import { HttpError } from "../http";
import { queueMemoryReview } from "../memory-reviews";
import { channelNameOf } from "../messages";
import { createProposal, define, type ToolContext, ToolInputError } from "./tools";

const path = z.string().min(1).max(400);
const input = z.discriminatedUnion("command", [
  z.object({
    command: z.literal("view"),
    path,
    view_range: z.tuple([z.number().int().min(1), z.number().int().min(-1)]).optional(),
  }),
  z.object({ command: z.literal("create"), path, file_text: z.string() }),
  z.object({ command: z.literal("str_replace"), path, old_str: z.string().min(1), new_str: z.string() }),
  z.object({
    command: z.literal("insert"),
    path,
    insert_line: z.number().int().min(0),
    insert_text: z.string(),
  }),
  z.object({ command: z.literal("delete"), path }),
  z.object({ command: z.literal("rename"), old_path: path, new_path: path }),
]);
type Input = z.infer<typeof input>;

const REMEMBERED = /^remembered\/(mem_[A-Za-z0-9_-]+)\.md$/;

/**
 * The store of each scope for this run. With no person in the run (a routine, another agent) or after another
 * person joined the run's conversation, there is no `you`. Opening the person's store pins the run to them.
 */
function storeFor(ctx: ToolContext, scope: MemoryScope): Store | null {
  if (scope === "agent") return { scope: "agent", workspaceId: ctx.workspaceId, agentId: ctx.agent.id };
  if (scope === "workspace") return { scope: "workspace", workspaceId: ctx.workspaceId };
  const personId = ctx.personStore?.() ?? null;
  return personId ? { scope: "person", workspaceId: ctx.workspaceId, userId: personId } : null;
}

const missing = (p: string) => `The path ${p} does not exist. Please provide a valid path.`;

function parse(raw: string): MemoryPath {
  try {
    return parseMemoryPath(raw);
  } catch (err) {
    if (err instanceof MemoryPathError) throw new ToolInputError(`Error: ${err.message}`);
    throw err;
  }
}

/** The store and path of a file (not a folder), already checked. */
function fileTarget(ctx: ToolContext, raw: string): { store: Store; scope: MemoryScope; path: string } {
  const p = parse(raw);
  if (p.kind === "root" || p.path === "") throw new ToolInputError(`Error: ${raw} is a directory`);
  const store = storeFor(ctx, p.scope);
  if (!store) throw new ToolInputError(`Error: ${missing(raw)} No person started this run.`);
  return { store, scope: p.scope, path: p.path };
}

function readOnly(scope: MemoryScope, raw: string) {
  if (scope === "workspace")
    throw new ToolInputError(
      `Error: ${raw} is read only. ${MEMORY_ROOT}/workspace is the workspace's memory: propose a change with propose_workspace_memory_change.`,
    );
}

const pathOf = (row: { id: string; path: string | null }) => row.path ?? rememberedPath(row.id);

type Entry = { id: string; path: string | null; bytes: number };

async function findFile(ctx: ToolContext, store: Store, path: string): Promise<MemoryRow | undefined> {
  const remembered = REMEMBERED.exec(path);
  if (remembered?.[1] && store.scope === "agent") return rememberedItem(ctx.deps.db, store, remembered[1]);
  return itemAtPath(ctx.deps.db, store, path);
}

const size = (n: number) => (n < 1024 ? `${n}B` : `${(n / 1024).toFixed(1)}K`);

/** The listing under the folder, up to `levels` levels, as in the memory tool's docs (`size\tpath`). */
function listing(scope: MemoryScope, dir: string, rows: Entry[], levels: number): string[] {
  const out = new Map<string, number>();
  const depth = dir === "" ? 0 : dir.split("/").length;
  for (const r of rows) {
    const p = pathOf(r);
    if (!isUnder(p, dir) || p === dir) continue;
    const parts = p.split("/");
    for (let level = depth + 1; level <= Math.min(parts.length, depth + levels); level++) {
      const sub = parts.slice(0, level).join("/");
      const key = level < parts.length ? `${sub}/` : sub;
      out.set(key, (out.get(key) ?? 0) + r.bytes);
    }
  }
  return [...out.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([p, n]) => `${size(n)}\t${virtualPath(scope, p.replace(/\/$/, ""))}${p.endsWith("/") ? "/" : ""}`);
}

const bytesUnder = (rows: Entry[], dir: string) =>
  rows.filter((r) => isUnder(pathOf(r), dir)).reduce((n, r) => n + r.bytes, 0);

async function view(ctx: ToolContext, raw: string, range?: [number, number]): Promise<string> {
  const p = parse(raw);
  const header = `Here're the files and directories up to 2 levels deep in ${raw}, excluding hidden items and node_modules:`;
  if (p.kind === "root") {
    const lines = [header];
    for (const scope of ["agent", "person", "workspace"] as const) {
      const store = storeFor(ctx, scope);
      if (!store) continue;
      const rows = await storeEntries(ctx.deps.db, store);
      lines.push(
        `${size(bytesUnder(rows, ""))}\t${virtualPath(scope, "")}/`,
        ...listing(scope, "", rows, 1).slice(0, 200),
      );
    }
    return lines.join("\n");
  }
  const store = storeFor(ctx, p.scope);
  if (!store) throw new ToolInputError(missing(raw));
  if (p.path !== "") {
    // The file first, by the path's index: reading a file doesn't load the whole store.
    const file = await findFile(ctx, store, p.path);
    if (file) {
      const lines = file.text.split("\n").length;
      if (range && (range[0] > lines || (range[1] !== -1 && range[1] < range[0])))
        throw new ToolInputError(
          `Error: Invalid view_range ${JSON.stringify(range)}: the file has ${lines} lines`,
        );
      return `Here's the content of ${raw} with line numbers:\n${numberLines(file.text, range)}`;
    }
  }
  const rows = await storeEntries(ctx.deps.db, store);
  if (p.path !== "" && !rows.some((r) => isUnder(pathOf(r), p.path))) throw new ToolInputError(missing(raw));
  return [
    header,
    `${size(bytesUnder(rows, p.path))}\t${raw}`,
    ...listing(p.scope, p.path, rows, 2).slice(0, 400),
  ].join("\n");
}

/** The origin of everything the tool writes: the run's person, the channel, the run and what it read from outside. */
async function originOf(ctx: ToolContext) {
  return {
    by: ctx.personId ? { type: "person" as const, id: ctx.personId } : null,
    name: ctx.trigger?.authorName ?? null,
    channel: await channelNameOf(ctx.deps.db, ctx.channel.id),
    at: ctx.deps.now().toISOString(),
    runId: ctx.runId,
    untrusted: ctx.risk.reasons.filter((r) => r.flag === "A").map((r) => r.source),
  };
}

const agentAuthor = (ctx: ToolContext): Author => ({ type: "agent", id: ctx.agent.id, runId: ctx.runId });

/**
 * The write counts now (a run without A) or becomes a review request (a run with A). Returns the text for the
 * model in both cases; in a review, it makes clear that nothing changed yet.
 */
async function write(
  ctx: ToolContext,
  store: Store,
  op: "create" | "update" | "archive" | "rename",
  args: { current?: MemoryRow; path: string; newPath?: string; text: string; done: string },
): Promise<string> {
  if (store.scope === "workspace") throw new ToolInputError("Error: read only");
  if (utf8Bytes(args.text) > MEMORY_ITEM_MAX_BYTES)
    throw new ToolInputError(`Error: a memory file holds up to ${MEMORY_ITEM_MAX_BYTES} bytes`);
  if (memoryWriteNeedsReview(ctx.risk)) {
    const sources = ctx.risk.reasons.filter((r) => r.flag === "A");
    await queueMemoryReview(ctx.deps, {
      workspaceId: ctx.workspaceId,
      agentId: ctx.agent.id,
      runId: ctx.runId,
      scope: store.scope,
      ownerUserId: store.scope === "person" ? store.userId : null,
      op,
      memoryId: args.current?.id ?? null,
      path: args.current ? args.current.path : args.path,
      newPath: args.newPath ?? null,
      text: args.text,
      baseSha256: args.current ? contentSha256(args.current.text) : null,
      reasons: sources,
      origin: await originOf(ctx),
      tool: "memory",
    });
    return `Not saved yet: this run read content from outside (${sources
      .map((s) => s.source)
      .slice(0, 3)
      .join(
        "; ",
      )}), so this memory change waits for a person to review it. It is not in your memory until approved; don't rely on it.`;
  }
  const at = ctx.deps.now();
  const meta = { author: agentAuthor(ctx), reason: "memory tool" };
  try {
    if (op === "create") {
      const row = await createMemory(
        ctx.deps.db,
        at,
        {
          workspaceId: ctx.workspaceId,
          agentId: ctx.agent.id,
          scope: store.scope,
          ownerUserId: store.scope === "person" ? store.userId : null,
          path: args.path,
          text: args.text,
          source: "memory_tool",
          origin: await originOf(ctx),
        },
        meta,
      );
      // Undo by the receipt only in the agent's store: the receipt stays in the channel, and the name of a
      // person's file is not for everyone (they undo it by the versions, on their page).
      if (store.scope === "agent")
        await ctx.recordAction({
          kind: "memory_recorded",
          target: { type: "memory", id: row.id, title: args.path },
        });
    } else if (args.current) {
      const change =
        op === "archive"
          ? { archived: true }
          : op === "rename"
            ? { path: args.newPath ?? null }
            : { text: args.text };
      await changeMemory(ctx.deps.db, at, args.current.id, change, {
        ...meta,
        op,
        expectedSha256: contentSha256(args.current.text),
        store,
      });
    }
  } catch (err) {
    if (err instanceof HttpError && err.code === "memory.exists")
      throw new ToolInputError(`Error: File ${args.newPath ?? args.path} already exists`);
    if (err instanceof HttpError) throw new ToolInputError(`Error: ${err.message}`);
    throw err;
  }
  return args.done;
}

async function existing(ctx: ToolContext, raw: string) {
  const t = fileTarget(ctx, raw);
  readOnly(t.scope, raw);
  const current = await findFile(ctx, t.store, t.path);
  if (!current) throw new ToolInputError(`Error: The path ${raw} does not exist`);
  return { ...t, current };
}

async function runMemory(ctx: ToolContext, inp: Input): Promise<string> {
  switch (inp.command) {
    case "view":
      return view(ctx, inp.path, inp.view_range);
    case "create": {
      const t = fileTarget(ctx, inp.path);
      readOnly(t.scope, inp.path);
      if (t.path.startsWith("remembered/"))
        throw new ToolInputError(
          "Error: remembered/ holds the notes saved with remember; pick another folder",
        );
      if (await findFile(ctx, t.store, t.path))
        throw new ToolInputError(`Error: File ${inp.path} already exists`);
      return write(ctx, t.store, "create", {
        path: t.path,
        text: inp.file_text,
        done: `File created successfully at: ${inp.path}`,
      });
    }
    case "str_replace": {
      const t = await existing(ctx, inp.path);
      const hits = t.current.text.split(inp.old_str).length - 1;
      if (hits === 0)
        throw new ToolInputError(
          `No replacement was performed, old_str \`${inp.old_str}\` did not appear verbatim in ${inp.path}.`,
        );
      if (hits > 1)
        throw new ToolInputError(
          `No replacement was performed. Multiple occurrences of old_str \`${inp.old_str}\` in ${inp.path}. Please ensure it is unique.`,
        );
      return write(ctx, t.store, "update", {
        current: t.current,
        path: t.path,
        text: t.current.text.replace(inp.old_str, () => inp.new_str),
        done: "The memory file has been edited.",
      });
    }
    case "insert": {
      const t = await existing(ctx, inp.path);
      const lines = t.current.text.split("\n");
      if (inp.insert_line > lines.length)
        throw new ToolInputError(
          `Error: Invalid insert_line ${inp.insert_line}: the file has ${lines.length} lines`,
        );
      lines.splice(inp.insert_line, 0, ...inp.insert_text.replace(/\n$/, "").split("\n"));
      return write(ctx, t.store, "update", {
        current: t.current,
        path: t.path,
        text: lines.join("\n"),
        done: `The file ${inp.path} has been edited.`,
      });
    }
    case "delete": {
      const p = parse(inp.path);
      if (p.kind === "root" || p.path === "") throw new ToolInputError(`Error: ${inp.path} can't be deleted`);
      readOnly(p.scope, inp.path);
      const store = storeFor(ctx, p.scope);
      if (!store) throw new ToolInputError(`Error: The path ${inp.path} does not exist`);
      if (p.scope === "agent" && p.path === "remembered")
        throw new ToolInputError(
          `Error: delete remembered memories one at a time (${MEMORY_ROOT}/agent/remembered/<id>.md)`,
        );
      const file = await findFile(ctx, store, p.path);
      const targets = file ? [file] : await itemsUnder(ctx.deps.db, store, p.path);
      if (targets.length === 0) throw new ToolInputError(`Error: The path ${inp.path} does not exist`);
      const out: string[] = [];
      for (const current of targets) {
        out.push(
          await write(ctx, store, "archive", {
            current,
            path: pathOf(current),
            text: current.text,
            done: `Successfully deleted ${inp.path}`,
          }),
        );
      }
      return [...new Set(out)].join("\n");
    }
    case "rename": {
      const from = await existing(ctx, inp.old_path);
      const to = fileTarget(ctx, inp.new_path);
      readOnly(to.scope, inp.new_path);
      if (to.scope !== from.scope)
        throw new ToolInputError(
          "Error: a file can't move between /memories/agent, /memories/you and /memories/workspace",
        );
      if (to.path.startsWith("remembered/"))
        throw new ToolInputError(
          "Error: remembered/ holds the notes saved with remember; pick another folder",
        );
      if (await findFile(ctx, to.store, to.path))
        throw new ToolInputError(`Error: The destination ${inp.new_path} already exists`);
      return write(ctx, from.store, "rename", {
        current: from.current,
        path: from.path,
        newPath: to.path,
        text: from.current.text,
        done: `Successfully renamed ${inp.old_path} to ${inp.new_path}`,
      });
    }
    default: {
      const _never: never = inp;
      return _never;
    }
  }
}

export const memoryTool = define<Input>({
  name: "memory",
  description:
    "Your memory directory at /memories: /memories/agent (yours), /memories/you (about the person who asked; private to them) and /memories/workspace (the workspace's, read only). Commands: view, create, str_replace, insert, delete, rename.",
  builtin: "memory_20250818",
  effect: "K1",
  input,
  async plan(_ctx, inp) {
    return inp.command === "view"
      ? { effect: "K0", destination: { kind: "none" } }
      : { destination: { kind: "none" } };
  },
  run: runMemory,
});

/**
 * The workspace's memory is read only for the agent: changing one of its files is a proposal, and a person
 * with `manage_agents` accepts or rejects it, like the instructions and the workspace's context.
 */
export const proposeWorkspaceMemory = define({
  name: "propose_workspace_memory_change",
  description:
    "Propose a new version of a file in /memories/workspace (the workspace's memory, which you can only read), or a new file. Give the full new text. A person reviews it. Write the title in the language of the conversation.",
  effect: "K1",
  input: z.object({
    path: z.string().min(1).max(400),
    text: z.string().min(1).max(MEMORY_ITEM_MAX_BYTES),
    title: z.string().trim().min(1).max(120),
    why: z.string().trim().min(1).max(2000),
    evidence: z.string().trim().max(2000).default(""),
  }),
  async run(ctx, inp) {
    const p = parse(inp.path);
    if (p.kind !== "store" || p.scope !== "workspace" || p.path === "")
      throw new ToolInputError("Error: propose changes only to files in /memories/workspace");
    if (p.path.startsWith("remembered/")) throw new ToolInputError("Error: pick another folder");
    const current = await itemAtPath(
      ctx.deps.db,
      { scope: "workspace", workspaceId: ctx.workspaceId },
      p.path,
    );
    return createProposal(ctx, {
      kind: "workspace_memory",
      path: p.path,
      before: current?.text ?? "",
      after: inp.text,
      title: inp.title,
      why: inp.why,
      evidence: inp.evidence,
    });
  },
});

export const MEMORY_TOOLS = [memoryTool, proposeWorkspaceMemory] as const;
