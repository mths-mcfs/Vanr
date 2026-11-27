// The agents' content tools: Drive, wiki, issues, calendar, routines and debates. The agent reads only what it
// sees (the channels it is in, or what belongs to the whole workspace) and, when a person asked, also only what
// they see. What it creates or changes becomes an action that can be undone.
import type { ActorRef, IssueStage, RoutineTrigger } from "@vanr/contract";
import { schema } from "@vanr/engine/db";
import { newId } from "@vanr/engine/ids";
import { parseSchedulePhrase } from "@vanr/engine/recurrence-text";
import { applyEdits, editFailureMessage } from "@vanr/engine/wiki-edit";
import { and, asc, desc, eq, ilike, isNull, or } from "drizzle-orm";
import { z } from "zod";
import { eventsInRange, expand } from "../calendar";
import { type RuntimePort, requireRuntime, type WorkspaceMember } from "../context";
import {
  agentCanSeeDebate,
  canSeeDebate,
  debateById,
  insertPost,
  isAnonymous,
  openDebate,
  toPost,
} from "../debates";
import {
  addVersion,
  canSeeFile,
  contentOf,
  createFile,
  fileContentSchema,
  type StructuredContent,
  versionOf,
  visibleFilesSql,
} from "../drive";
import { HttpError } from "../http";
import { columnsOf, createIssue, issueByNumber, notifyComment, updateIssue } from "../issues";
import { log } from "../logger";
import { anchorOf, canSeeRoutine, nextRunFor, type RoutineRow } from "../routines";
import { createPage, MAX_BODY, pageBySlug, recordRead, savePage } from "../wiki";
import { audienceWithin, type WikiViewer } from "../wiki-access";
import { annotationsOf, MAX_HUNKS, createProposal as proposeWikiChanges } from "../wiki-annotations";
import { missingTargets } from "../wiki-links";
import { BASE_TOOLS, defineStored } from "./base-tools";
import { MEMORY_TOOLS } from "./memory-tool";
import { lineDiff, linksIn } from "./preview";
import { BUILTIN_TOOLS, type ToolContext, type ToolDef, ToolInputError } from "./tools";

const { files, issues, issueTimeline, routines, calendarProposals, members, agents, debatePosts } = schema;
const short = (s: string, n = 300) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const escapeLike = (s: string) => s.replace(/[%_\\]/g, "\\$&");
export const self = (ctx: ToolContext): ActorRef => ({ type: "agent", id: ctx.agent.id });
const requester = (ctx: ToolContext): ActorRef | null =>
  ctx.trigger ? { type: "person", id: ctx.trigger.authorId } : null;

/** A domain error (404, 409...) becomes a tool error: the model reads it and corrects itself. */
export async function domain<T>(work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (err) {
    if (err instanceof HttpError) throw new ToolInputError(err.message);
    throw err;
  }
}

/** The flow reaches the runtime's `method`: rejected before any write while the runtime isn't there. */
function needsRuntime(ctx: ToolContext, method: keyof RuntimePort) {
  try {
    requireRuntime(ctx.deps.runtime, method);
  } catch (err) {
    if (err instanceof HttpError) throw new ToolInputError(err.message);
    throw err;
  }
}

/** The agent and whoever asked (if anyone) see the file. */
export async function visibleFile(ctx: ToolContext, id: string) {
  const { db } = ctx.deps;
  const [row] = await db
    .select()
    .from(files)
    .where(and(eq(files.id, id), eq(files.workspaceId, ctx.workspaceId), isNull(files.deletedAt)));
  const who = requester(ctx);
  if (!row || !(await canSeeFile(db, row, self(ctx))) || (who && !(await canSeeFile(db, row, who))))
    throw new ToolInputError(`File ${id} not found`);
  return row;
}

function render(content: ReturnType<typeof contentOf>): string {
  switch (content.kind) {
    case "document":
      return content.markdown;
    case "table":
      return [content.columns.join(" | "), ...content.rows.map((r) => r.join(" | "))].join("\n");
    case "diff":
      return content.files.map((f) => `--- ${f.path}\n${f.patch}`).join("\n\n");
    case "diagram":
      return content.mermaid;
    case "html":
      return content.html;
    case "file":
      return content.text ?? `(binary file ${content.name}, ${content.contentType}, ${content.size} bytes)`;
  }
}

// ---- Drive ----

const listFiles = defineStored({
  name: "list_drive_files",
  description:
    "List files in the workspace's Drive that you and the person asking can see. Optional search by title.",
  effect: "K0",
  input: z.object({
    q: z.string().max(200).optional(),
    kind: z.enum(["document", "table", "diff", "diagram", "html", "file"]).optional(),
  }),
  async run(ctx, input) {
    const who = requester(ctx);
    const rows = await ctx.deps.db
      .select()
      .from(files)
      .where(
        and(
          eq(files.workspaceId, ctx.workspaceId),
          isNull(files.deletedAt),
          visibleFilesSql(self(ctx), ctx.workspaceId),
          who ? visibleFilesSql(who, ctx.workspaceId) : undefined,
          input.q ? ilike(files.title, `%${escapeLike(input.q)}%`) : undefined,
          input.kind ? eq(files.kind, input.kind) : undefined,
        ),
      )
      .orderBy(desc(files.updatedAt))
      .limit(100);
    if (rows.length === 0) return "No files found.";
    return rows
      .slice(0, 30)
      .map(
        (a) =>
          `${a.id} · ${a.kind} · "${a.title}" · v${a.version} · ${a.updatedAt.toISOString().slice(0, 10)}`,
      )
      .join("\n");
  },
});

const readFile = defineStored({
  name: "read_drive_file",
  description: "Read a Drive file (the latest version, or an older one).",
  effect: "K0",
  input: z.object({ fileId: z.string().min(1), version: z.number().int().min(1).optional() }),
  async run(ctx, input) {
    const row = await visibleFile(ctx, input.fileId);
    const v = await domain(versionOf(ctx.deps.db, row, input.version));
    return `"${row.title}" (${row.kind}, version ${v.version} of ${row.version})\n\n${short(render(contentOf(v)), 15_000)}`;
  },
});

const createFileTool = defineStored({
  name: "create_drive_file",
  description:
    "Create a document, table, diff, diagram (mermaid) or HTML page in the Drive, attached to this conversation.",
  effect: "K1",
  input: z.object({
    title: z.string().trim().min(1).max(200),
    content: fileContentSchema,
    note: z.string().max(300).optional(),
  }),
  async run(ctx, input) {
    const { row } = await domain(
      createFile(ctx.deps, {
        workspaceId: ctx.workspaceId,
        title: input.title,
        author: self(ctx),
        content: input.content,
        channelId: ctx.channel.id,
        threadId: ctx.threadId,
        note: input.note ?? null,
      }),
    );
    await ctx.recordAction({
      kind: "file_created",
      target: { type: "file", id: row.id, title: row.title },
    });
    return `Created ${row.kind} "${row.title}" (${row.id}).`;
  },
});

const updateFileTool = defineStored({
  name: "update_drive_file",
  description:
    "Save a new version of a Drive document (same kind). Read it first; pass the version you read as parentVersion.",
  effect: "K1",
  input: z.object({
    fileId: z.string().min(1),
    content: fileContentSchema,
    parentVersion: z.number().int().min(1),
    note: z.string().max(300).optional(),
    title: z.string().trim().min(1).max(200).optional(),
  }),
  // The preview shows the diff against the version read; the hash pins the version, so a change in between is rejected.
  async plan(ctx, input) {
    const row = await visibleFile(ctx, input.fileId);
    const before = render(contentOf(await versionOf(ctx.deps.db, row)));
    const after = render(input.content);
    return {
      payload: { ...input, fileId: row.id, version: row.version },
      preview: {
        title: `Update "${input.title ?? row.title}"`,
        body: after,
        links: linksIn(after),
        diff: lineDiff(before, after),
      },
      card: { params: { title: row.title } },
    };
  },
  async run(ctx, input) {
    const row = await visibleFile(ctx, input.fileId);
    const saved = await domain(
      addVersion(ctx.deps, {
        row,
        author: self(ctx),
        parentVersion: input.parentVersion,
        content: input.content as StructuredContent,
        note: input.note ?? null,
        ...(input.title ? { title: input.title } : {}),
      }),
    );
    await ctx.recordAction({
      kind: "file_updated",
      target: { type: "file", id: row.id, title: saved.row.title },
      params: { fromVersion: row.version, toVersion: saved.row.version },
    });
    return `Saved version ${saved.row.version} of "${saved.row.title}".`;
  },
});

const shareFile = defineStored({
  name: "share_drive_file",
  description:
    "Bring a Drive file into this conversation as an attachment (only if the person asking can see it).",
  effect: "K1",
  input: z.object({ fileId: z.string().min(1) }),
  async run(ctx, input) {
    const row = await visibleFile(ctx, input.fileId);
    // The card shows the file's title to everyone in this conversation: only a workspace file, or one of this
    // same channel, has that audience.
    if (row.channelId && row.channelId !== ctx.channel.id)
      throw new ToolInputError(
        `"${row.title}" belongs to another channel; this conversation's people may not all see it`,
      );
    await ctx.postCard(row.title, {
      files: [{ id: row.id, version: row.version, title: row.title, deleted: false }],
    });
    return `Shared "${row.title}" here.`;
  },
});

// ---- Wiki ----

/**
 * Who reads the wiki in the run: the agent and the person who asked, with the intersection of what both read
 * (as in the search). Without a person (a routine, another agent), only the agent.
 */
export const wikiViewer = (ctx: ToolContext): WikiViewer => ({
  workspaceId: ctx.workspaceId,
  agentId: ctx.agent.id,
  ...(ctx.personId ? { userId: ctx.personId } : ctx.trigger ? { userId: ctx.trigger.authorId } : {}),
});

const readWikiPage = defineStored({
  name: "open_wiki_page",
  description:
    "Read a whole wiki page by its slug. Its version is the parent_version for update_wiki_page and propose_wiki_edit. " +
    "Open comments on the page come after the text.",
  effect: "K0",
  input: z.object({ slug: z.string().min(1).max(120) }),
  async run(ctx, input) {
    const page = await domain(pageBySlug(ctx.deps.db, wikiViewer(ctx), input.slug));
    await recordRead(ctx.deps, page.id, self(ctx));
    const { comments, proposals } = await annotationsOf(ctx.deps.db, page);
    const open = comments.filter((c) => !c.parentId && c.status === "open");
    const pending = proposals.filter((p) => p.status === "pending").length;
    const notes = [
      page.agentEdits === "propose" ? "This page takes changes only as proposals (propose_wiki_edit)." : "",
      pending ? `${pending} proposal(s) wait for review.` : "",
      ...open.map((c) => {
        const replies = comments.filter((r) => r.parentId === c.id).length;
        const quote = c.anchor
          ? ` on "${short(c.anchor.quote, 120)}"${c.anchorState === "orphan" ? " (text gone)" : ""}`
          : "";
        return `- comment ${c.id}${quote}: ${short(c.body, 300)}${replies ? ` (${replies} replies)` : ""}`;
      }),
    ].filter(Boolean);
    const head = `# ${page.title} (version ${page.version}${page.locked ? ", locked" : ""})`;
    return `${head}\n\n${short(page.body, 15_000)}${notes.length ? `\n\n---\n${notes.join("\n")}` : ""}`;
  },
});

const actingFor = (ctx: ToolContext) => ({
  ...self(ctx),
  ...(ctx.trigger ? { actingFor: ctx.trigger.authorId } : {}),
});

const createWikiPage = defineStored({
  name: "add_wiki_page",
  description: "Create a wiki page when someone asks for it. Use [[Page title]] to link other pages.",
  effect: "K1",
  input: z.object({
    title: z.string().trim().min(1).max(200),
    body: z.string().max(200_000),
    folder: z.string().max(200).optional(),
    tags: z.array(z.string().max(40)).max(20).optional(),
  }),
  async run(ctx, input) {
    const row = await domain(
      createPage(ctx.deps, { workspaceId: ctx.workspaceId, ...input, author: actingFor(ctx) }),
    );
    await ctx.recordAction({
      kind: "wiki_written",
      target: { type: "wiki", id: row.id, slug: row.slug, title: row.title },
    });
    return `Created wiki page "${row.title}" (${row.slug}).`;
  },
});

const updateWikiInput = z
  .object({
    slug: z.string().min(1).max(120),
    parent_version: z.number().int().min(1),
    mode: z.enum(["edit", "append", "replace"]).default("edit"),
    edits: z
      .array(
        z.object({
          old_str: z.string().min(1).max(50_000),
          new_str: z.string().max(200_000),
          replace_all: z.boolean().optional(),
        }),
      )
      .min(1)
      .max(20)
      .optional(),
    text: z.string().min(1).max(200_000).optional(),
    note: z.string().max(300).optional(),
  })
  .refine((v) => (v.mode === "edit" ? !!v.edits : !!v.text), {
    message: 'mode "edit" needs edits; "append" and "replace" need text',
  });

/** The page's new body, the text added and the warnings: the plan (preview and hash) and the run use the same. */
async function wikiUpdate(ctx: ToolContext, input: z.infer<typeof updateWikiInput>) {
  const row = await domain(pageBySlug(ctx.deps.db, wikiViewer(ctx), input.slug));
  if (row.agentEdits === "propose")
    throw new ToolInputError(
      `"${row.title}" takes changes only as proposals: call propose_wiki_edit with the same edits (old_str/new_str).`,
    );
  const warnings: string[] = [];
  const stale = row.version !== input.parent_version;
  if (stale && input.mode === "replace")
    throw new ToolInputError(
      `"${row.title}" changed since version ${input.parent_version} (now ${row.version}). Read it again; replacing the whole body would erase that change.`,
    );
  if (stale)
    warnings.push(
      `The page changed since version ${input.parent_version} (now ${row.version}); your change was applied to the latest text. Read it again to check.`,
    );
  let body: string;
  let added: string;
  if (input.mode === "edit") {
    const edits = (input.edits ?? []).map((e) => ({
      oldStr: e.old_str,
      newStr: e.new_str,
      replaceAll: e.replace_all,
    }));
    const out = applyEdits(row.body, edits);
    if (!out.ok)
      throw new ToolInputError(
        `${editFailureMessage(out)}${stale ? ` The page changed since version ${input.parent_version} (now ${row.version}).` : ""}`,
      );
    body = out.text;
    added = edits.map((e) => e.newStr).join("\n");
  } else {
    const text = input.text ?? "";
    body = input.mode === "append" ? `${row.body.replace(/\s+$/, "")}\n\n${text}` : text;
    added = text;
    if (input.mode === "replace" && body.length < row.body.length / 2)
      warnings.push(
        `The new body is less than half the size of the old one (${body.length} vs ${row.body.length} characters).`,
      );
  }
  if (body.length > MAX_BODY) throw new ToolInputError(`The page would pass ${MAX_BODY} characters`);
  return { row, body, added, warnings };
}

// A safe edit: the agent says which version it read the page at (`parent_version`) and swaps quoted passages
// (`old_str`/`new_str`) instead of sending the whole body. If the page changed since the read, a swap by
// passage still lands in the right place (with a warning); replacing the whole body is rejected.
const updateWikiPage = defineStored({
  name: "update_wiki_page",
  description:
    "Change a wiki page when someone asks. Read it first and pass its version as parent_version. " +
    'Prefer mode "edit" with edits [{old_str, new_str}]: each old_str must match the current text exactly once ' +
    '(or set replace_all). "append" adds a section at the end; "replace" swaps the whole body and only works ' +
    "if nobody saved since parent_version. Locked pages can't be changed by agents.",
  effect: "K1",
  input: updateWikiInput,
  // The preview and the hash use the same new body the run saves (`wikiUpdate`).
  async plan(ctx, input) {
    const { row, body, added } = await wikiUpdate(ctx, input);
    return {
      payload: { pageId: row.id, version: row.version, body },
      preview: {
        title: `Update wiki "${row.title}"`,
        body,
        links: linksIn(added),
        diff: lineDiff(row.body, body),
      },
      card: { params: { title: row.title } },
      editable: input.mode === "edit" ? [] : ["text"],
    };
  },
  async run(ctx, input) {
    const { row, body, added, warnings } = await wikiUpdate(ctx, input);
    for (const t of await missingTargets(ctx.deps.db, ctx.workspaceId, added, wikiViewer(ctx)))
      warnings.push(`[[${t}]] does not match any page (it will show as a link to a new page).`);
    const saved = await domain(
      savePage(ctx.deps, {
        row,
        author: actingFor(ctx),
        canBypassLock: false,
        parentVersion: row.version,
        body,
        note: input.note ?? null,
      }),
    );
    await ctx.recordAction({
      kind: "wiki_updated",
      target: { type: "wiki", id: row.id, slug: row.slug, title: row.title },
      params: { fromVersion: row.version, toVersion: saved.version },
    });
    const head = `Saved version ${saved.version} of "${row.title}".`;
    return warnings.length ? `${head}\nWarnings:\n${warnings.map((w) => `- ${w}`).join("\n")}` : head;
  },
});

const proposeWikiEdit = defineStored({
  name: "propose_wiki_edit",
  description:
    "Propose changes to a wiki page without changing it: a person accepts or rejects each change. " +
    "Read the page first and pass its version as parent_version. Each edit's old_str must match the current text exactly once.",
  effect: "K1",
  input: z.object({
    slug: z.string().min(1).max(120),
    parent_version: z.number().int().min(1),
    edits: z
      .array(z.object({ old_str: z.string().min(1).max(50_000), new_str: z.string().max(200_000) }))
      .min(1)
      .max(MAX_HUNKS),
    note: z.string().max(500).default(""),
  }),
  async run(ctx, input) {
    const page = await domain(pageBySlug(ctx.deps.db, wikiViewer(ctx), input.slug));
    const edits = input.edits.map((e) => ({ oldStr: e.old_str, newStr: e.new_str }));
    // Accepting every change must still fit the page's cap.
    const all = applyEdits(page.body, edits);
    if (all.ok && all.text.length > MAX_BODY)
      throw new ToolInputError(`The page would pass ${MAX_BODY} characters`);
    const { row, warnings } = await domain(
      proposeWikiChanges(ctx.deps, {
        page,
        author: actingFor(ctx),
        parentVersion: input.parent_version,
        edits,
        note: input.note,
      }),
    );
    const head = `Proposed ${row.hunks.length} change(s) to "${page.title}" (proposal ${row.id}). A person reviews each one on the page.`;
    return warnings.length ? `${head}\nWarnings:\n${warnings.map((w) => `- ${w}`).join("\n")}` : head;
  },
});

const linkToWiki = defineStored({
  name: "link_to_wiki",
  description:
    "Link one wiki page to another (adds a [[link]] at the end of the first page) when someone asks.",
  effect: "K1",
  input: z.object({ from: z.string().min(1).max(120), to: z.string().min(1).max(120) }),
  async run(ctx, input) {
    const from = await domain(pageBySlug(ctx.deps.db, wikiViewer(ctx), input.from));
    const to = await domain(pageBySlug(ctx.deps.db, wikiViewer(ctx), input.to));
    if (from.agentEdits === "propose")
      throw new ToolInputError(`"${from.title}" takes changes only as proposals: use propose_wiki_edit.`);
    if (from.body.includes(`[[${to.title}]]`) || from.body.includes(`[[${to.slug}]]`))
      return "Already linked.";
    // The link writes the target's title where the first page's readers see it.
    if (!audienceWithin(from.access, to.access))
      throw new ToolInputError(
        `Not everyone who reads "${from.title}" can read the page you want to link; ask a person to link it`,
      );
    const body = `${from.body.replace(/\s+$/, "")}\n\nSee also: [[${to.title}]]`;
    if (body.length > MAX_BODY) throw new ToolInputError(`The page would pass ${MAX_BODY} characters`);
    const saved = await domain(
      savePage(ctx.deps, {
        row: from,
        author: actingFor(ctx),
        canBypassLock: false,
        body,
        note: `link to ${to.slug}`,
      }),
    );
    await ctx.recordAction({
      kind: "wiki_updated",
      target: { type: "wiki", id: from.id, slug: from.slug, title: from.title },
      params: { fromVersion: from.version, toVersion: saved.version },
    });
    return `Linked "${from.title}" to "${to.title}".`;
  },
});

// ---- Issues ----

const listIssues = defineStored({
  name: "list_issues",
  description: "List the workspace's issues (tasks), optionally searching by text, or open one by number.",
  effect: "K0",
  input: z.object({ q: z.string().max(200).optional(), number: z.number().int().min(1).optional() }),
  async run(ctx, input) {
    const { db } = ctx.deps;
    const cols = new Map((await columnsOf(db, ctx.workspaceId)).map((c) => [c.id, c.stage]));
    if (input.number) {
      const i = await domain(issueByNumber(db, ctx.workspaceId, input.number));
      const crit = i.criteria.map((c) => `- [${c.done ? "x" : " "}] ${c.text}`).join("\n");
      return `#${i.number} ${i.title} · ${cols.get(i.columnId)} · priority ${i.priority}\n\n${i.description}\n${crit}`.trim();
    }
    const like = input.q ? `%${escapeLike(input.q)}%` : null;
    const rows = await db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.workspaceId, ctx.workspaceId),
          like ? or(ilike(issues.title, like), ilike(issues.description, like)) : undefined,
        ),
      )
      .orderBy(desc(issues.updatedAt))
      .limit(40);
    if (rows.length === 0) return "No issues found.";
    return rows.map((i) => `#${i.number} ${i.title} · ${cols.get(i.columnId)}`).join("\n");
  },
});

const createIssueTool = defineStored({
  name: "create_issue",
  description: "Create an issue (task) with acceptance criteria. Assign it to yourself to work on it.",
  effect: "K1",
  input: z.object({
    title: z.string().trim().min(1).max(300),
    description: z.string().max(20_000).optional(),
    criteria: z.array(z.string().trim().min(1).max(500)).max(20).optional(),
    priority: z.enum(["none", "low", "medium", "high", "urgent"]).optional(),
    assignToMe: z.boolean().optional(),
  }),
  async run(ctx, input) {
    const row = await domain(
      createIssue(ctx.deps, {
        workspaceId: ctx.workspaceId,
        title: input.title,
        description: input.description,
        criteria: input.criteria,
        priority: input.priority,
        assignee: input.assignToMe ? self(ctx) : null,
        channelId: ctx.channel.id,
        source: { kind: "agent", id: ctx.agent.id },
        author: self(ctx),
      }),
    );
    await ctx.recordAction({
      kind: "issue_opened",
      target: { type: "issue", id: row.id, number: row.number, title: row.title },
      params: { columnId: row.columnId },
    });
    return `Created issue #${row.number}.`;
  },
});

const STAGES = ["todo", "in_progress", "reviewing", "canceled"] as const satisfies readonly IssueStage[];

const updateIssueTool = defineStored({
  name: "update_issue",
  description:
    "Update an issue: move it to todo, in_progress, reviewing or canceled (only a person marks it done), change priority or title, or link a pull request URL.",
  effect: "K1",
  input: z.object({
    number: z.number().int().min(1),
    status: z.enum(STAGES).optional(),
    priority: z.enum(["none", "low", "medium", "high", "urgent"]).optional(),
    title: z.string().trim().min(1).max(300).optional(),
    // http(s) only: the link becomes an href on the issue, and z.url() alone accepts javascript: and data:.
    pullRequest: z
      .url({ protocol: /^https?$/ })
      .max(500)
      .optional(),
  }),
  async run(ctx, input) {
    const { db } = ctx.deps;
    const row = await domain(issueByNumber(db, ctx.workspaceId, input.number));
    const cols = await columnsOf(db, ctx.workspaceId);
    const current = cols.find((c) => c.id === row.columnId);
    const column =
      input.status && current?.stage !== input.status
        ? cols.find((c) => c.stage === input.status)
        : undefined;
    const change = {
      ...(column ? { columnId: column.id } : {}),
      ...(input.priority ? { priority: input.priority } : {}),
      ...(input.title ? { title: input.title } : {}),
      ...(input.pullRequest && !row.pullRequests.includes(input.pullRequest)
        ? { pullRequests: [...row.pullRequests, input.pullRequest] }
        : {}),
    };
    if (Object.keys(change).length === 0) return "Nothing to change.";
    const previous = {
      columnId: row.columnId,
      priority: row.priority,
      title: row.title,
      pullRequests: row.pullRequests,
    };
    await domain(updateIssue(ctx.deps, row, change, self(ctx)));
    await ctx.recordAction({
      kind: "issue_edited",
      target: { type: "issue", id: row.id, number: row.number, title: row.title },
      params: { previous, change },
    });
    return `Updated issue #${row.number}.`;
  },
});

const commentIssue = defineStored({
  name: "comment_issue",
  description: "Comment on an issue (progress, blockers, what you found).",
  effect: "K1",
  input: z.object({ number: z.number().int().min(1), text: z.string().trim().min(1).max(20_000) }),
  async run(ctx, input) {
    const { db } = ctx.deps;
    const row = await domain(issueByNumber(db, ctx.workspaceId, input.number));
    // The comment and its receipt commit together; the notification goes after, and its failure doesn't undo them.
    const act = await db.transaction(async (tx) => {
      const [saved] = await tx
        .insert(issueTimeline)
        .values({
          id: newId("iact"),
          issueId: row.id,
          kind: "comment",
          text: input.text,
          author: self(ctx),
          createdAt: ctx.deps.now(),
        })
        .returning();
      if (!saved) throw new Error("comment insert failed");
      await ctx.recordAction(
        {
          kind: "issue_commented",
          target: { type: "issue", id: row.id, number: row.number, title: row.title },
          params: { activityId: saved.id },
        },
        tx,
      );
      return saved;
    });
    await notifyComment(ctx.deps, row, self(ctx), input.text).catch((err: unknown) =>
      log.warn("tool.comment_notify_failed", { issueId: row.id, activityId: act.id, err }),
    );
    return `Commented on #${row.number}.`;
  },
});

// ---- Calendar ----

/** Whoever asked, as a member (to see their calendar). */
async function asRequester(ctx: ToolContext): Promise<WorkspaceMember> {
  if (!ctx.trigger) throw new ToolInputError("Nobody asked: there's no calendar to look at");
  const [m] = await ctx.deps.db
    .select()
    .from(members)
    .where(and(eq(members.workspaceId, ctx.workspaceId), eq(members.userId, ctx.trigger.authorId)));
  if (!m) throw new ToolInputError("Requester is not a member");
  return { workspaceId: ctx.workspaceId, userId: m.userId, role: m.role, handle: m.handle };
}

const listEvents = defineStored({
  name: "list_events",
  description: "List calendar events of the person asking between two dates (default: the next 7 days).",
  effect: "K0",
  input: z.object({
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
  }),
  async run(ctx, input) {
    const me = await asRequester(ctx);
    const from = input.from ? new Date(input.from) : ctx.deps.now();
    const to = input.to ? new Date(input.to) : new Date(from.getTime() + 7 * 86_400_000);
    const events = (await eventsInRange(ctx.deps.db, me, from, to)).flatMap((r) => expand(r, from, to));
    if (events.length === 0) return "No events.";
    return events
      .sort((a, b) => a.start.localeCompare(b.start))
      .slice(0, 50)
      .map((e) => `${e.start} → ${e.end} · ${e.title}${e.location ? ` · ${e.location}` : ""}`)
      .join("\n");
  },
});

async function personIds(ctx: ToolContext, handles: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const h of handles) {
    const handle = h.replace(/^@/, "").toLowerCase();
    const [m] = await ctx.deps.db
      .select({ id: members.userId })
      .from(members)
      .where(and(eq(members.workspaceId, ctx.workspaceId), eq(members.handle, handle)));
    if (!m) throw new ToolInputError(`Nobody with handle @${handle}`);
    out.push(m.id);
  }
  return out;
}

const findFreeTime = defineStored({
  name: "find_available_time",
  description:
    "Find times when the person asking and the given people (by @handle) are all free, on weekdays between 9:00 and 18:00 UTC, in the next days.",
  effect: "K0",
  input: z.object({
    handles: z.array(z.string()).max(10).default([]),
    durationMinutes: z.number().int().min(15).max(480).default(30),
    days: z.number().int().min(1).max(14).default(5),
  }),
  async run(ctx, input) {
    const me = await asRequester(ctx);
    const people = [me.userId, ...(await personIds(ctx, input.handles))];
    const from = ctx.deps.now();
    const to = new Date(from.getTime() + input.days * 86_400_000);
    const busy: [number, number][] = [];
    for (const userId of people) {
      const view = { ...me, userId };
      for (const r of await eventsInRange(ctx.deps.db, view, from, to))
        for (const e of expand(r, from, to)) busy.push([Date.parse(e.start), Date.parse(e.end)]);
    }
    const slots: string[] = [];
    const step = 30 * 60_000;
    const len = input.durationMinutes * 60_000;
    let t = Math.ceil(from.getTime() / step) * step;
    while (t + len <= to.getTime() && slots.length < 8) {
      const d = new Date(t);
      const day = d.getUTCDay();
      const minutes = d.getUTCHours() * 60 + d.getUTCMinutes();
      const inHours = day >= 1 && day <= 5 && minutes >= 9 * 60 && minutes + input.durationMinutes <= 18 * 60;
      if (inHours && !busy.some(([s, e]) => s < t + len && e > t)) {
        slots.push(`${d.toISOString()} → ${new Date(t + len).toISOString()}`);
        t += 2 * 60 * 60_000; // spreads the suggestions
      } else t += step;
    }
    return slots.length ? slots.join("\n") : "No common free time found.";
  },
});

const proposeEvent = defineStored({
  name: "propose_calendar_event",
  description:
    "Suggest a calendar event. The person who asked confirms it in the calendar before it's created.",
  effect: "K1",
  input: z.object({
    title: z.string().trim().min(1).max(200),
    start: z.iso.datetime({ offset: true }),
    end: z.iso.datetime({ offset: true }),
    handles: z.array(z.string()).max(20).default([]),
    note: z.string().max(1000).optional(),
  }),
  async run(ctx, input) {
    const me = await asRequester(ctx);
    if (new Date(input.end) <= new Date(input.start))
      throw new ToolInputError("The event must end after it starts");
    const people = [...new Set([me.userId, ...(await personIds(ctx, input.handles))])];
    const [row] = await ctx.deps.db
      .insert(calendarProposals)
      .values({
        id: newId("prop"),
        workspaceId: ctx.workspaceId,
        agentId: ctx.agent.id,
        title: input.title,
        start: new Date(input.start),
        end: new Date(input.end),
        participants: people.map((id) => ({ type: "person" as const, id })),
        note: input.note ?? null,
        createdAt: ctx.deps.now(),
      })
      .returning();
    return `Proposed "${input.title}" (${row?.id}). ${ctx.trigger?.authorName ?? "The person"} confirms it in the calendar.`;
  },
});

// ---- Routines ----

const createRoutineTool = defineStored({
  name: "schedule_routine",
  description:
    'Create a recurring routine for yourself in this conversation, from a schedule phrase like "every weekday at 9am" or "every monday at 10am". Runs on behalf of the person asking.',
  effect: "K1",
  input: z.object({
    name: z.string().trim().max(120).optional(),
    prompt: z.string().trim().min(1).max(10_000),
    schedule: z.string().trim().min(1).max(200),
    timezone: z.string().max(64).default("UTC"),
  }),
  async run(ctx, input) {
    const me = await asRequester(ctx);
    const parsed = parseSchedulePhrase(input.schedule, input.timezone, ctx.deps.now());
    if (!parsed.ok) throw new ToolInputError(`Couldn't understand the schedule (${parsed.code})`);
    const trigger: RoutineTrigger =
      parsed.kind === "once"
        ? { kind: "once", at: parsed.at.toISOString(), timezone: input.timezone }
        : { kind: "schedule", rule: parsed.rule };
    const target =
      ctx.channel.kind === "dm"
        ? { kind: "dm" as const }
        : { kind: "channel" as const, channelId: ctx.channel.id };
    const [row] = await ctx.deps.db
      .insert(routines)
      .values({
        id: newId("rtn"),
        workspaceId: ctx.workspaceId,
        name: input.name || short(input.prompt.split("\n")[0] ?? "Routine", 60),
        prompt: input.prompt,
        agentId: ctx.agent.id,
        target,
        trigger,
        active: true,
        nextFireAt: nextRunFor(trigger, ctx.deps.now()),
        createdBy: me.userId,
        createdAt: ctx.deps.now(),
      })
      .returning();
    if (!row) throw new Error("routine insert failed");
    await ctx.recordAction({
      kind: "routine_scheduled",
      target: { type: "routine", id: row.id, title: row.name },
    });
    return `Created routine "${row.name}"; next run ${row.nextFireAt?.toISOString() ?? "—"}.`;
  },
});

/** The agent's routines the person asking may see; with no person (a routine's own run), all of them. */
async function seenRoutines(ctx: ToolContext, rows: RoutineRow[]): Promise<RoutineRow[]> {
  if (!ctx.trigger) return rows;
  const me = await asRequester(ctx);
  const out: RoutineRow[] = [];
  for (const r of rows) if (await canSeeRoutine(ctx.deps, me, r)) out.push(r);
  return out;
}

const listRoutinesTool = defineStored({
  name: "list_routines",
  description: "List your routines.",
  effect: "K0",
  input: z.object({}),
  async run(ctx) {
    const all = await ctx.deps.db
      .select()
      .from(routines)
      .where(and(eq(routines.workspaceId, ctx.workspaceId), eq(routines.agentId, ctx.agent.id)))
      .orderBy(asc(routines.createdAt));
    const rows = await seenRoutines(ctx, all);
    if (rows.length === 0) return "You have no routines.";
    return rows
      .map(
        (r) =>
          `${r.id} · "${r.name}" · ${r.active ? "active" : "paused"} · next ${r.nextFireAt?.toISOString() ?? "—"}`,
      )
      .join("\n");
  },
});

const updateRoutineTool = defineStored({
  name: "update_routine",
  description: "Change one of your routines: instructions, schedule phrase, or pause/resume.",
  effect: "K1",
  input: z.object({
    routineId: z.string().min(1),
    prompt: z.string().trim().min(1).max(10_000).optional(),
    schedule: z.string().trim().min(1).max(200).optional(),
    timezone: z.string().max(64).default("UTC"),
    active: z.boolean().optional(),
  }),
  async run(ctx, input) {
    const { db } = ctx.deps;
    const [found] = await db
      .select()
      .from(routines)
      .where(
        and(
          eq(routines.id, input.routineId),
          eq(routines.workspaceId, ctx.workspaceId),
          eq(routines.agentId, ctx.agent.id),
        ),
      );
    if (!found || !(await seenRoutines(ctx, [found])).length)
      throw new ToolInputError(`Routine ${input.routineId} not found`);
    // Only the instructions: nothing else is written, so a pause in between stays a pause.
    if (input.schedule === undefined && input.active === undefined) {
      if (!input.prompt) return "Nothing to change.";
      await db.update(routines).set({ prompt: input.prompt }).where(eq(routines.id, found.id));
      return `Updated routine "${found.name}".`;
    }
    const parsed = input.schedule
      ? parseSchedulePhrase(input.schedule, input.timezone, ctx.deps.now())
      : null;
    if (parsed && !parsed.ok) throw new ToolInputError(`Couldn't understand the schedule (${parsed.code})`);
    // The state, the schedule and the next run come from the row as it is under the lock, not from the read.
    const row = await db.transaction(async (tx) => {
      const [locked] = await tx.select().from(routines).where(eq(routines.id, found.id)).for("update");
      if (!locked || JSON.stringify(locked.target) !== JSON.stringify(found.target))
        throw new ToolInputError(`Routine ${input.routineId} changed; list your routines again`);
      const trigger: RoutineTrigger = !parsed?.ok
        ? (locked.trigger as RoutineTrigger)
        : parsed.kind === "once"
          ? { kind: "once", at: parsed.at.toISOString(), timezone: input.timezone }
          : { kind: "schedule", rule: parsed.rule };
      const active = input.active ?? locked.active;
      const now = ctx.deps.now();
      // A new schedule starts the series again; without a change, it follows the series from before.
      const anchor = input.schedule ? now : anchorOf(locked);
      const nextFireAt = active ? nextRunFor(trigger, now, anchor) : null;
      // On without a next time (a "once" that passed, a series that ended) it would never run.
      if (active && !nextFireAt && (trigger.kind === "schedule" || trigger.kind === "once"))
        throw new ToolInputError("That routine has no future run: give it a new schedule to turn it on");
      await tx
        .update(routines)
        .set({
          ...(input.prompt ? { prompt: input.prompt } : {}),
          trigger,
          active,
          nextFireAt,
          ...(input.schedule ? { scheduleFrom: anchor } : {}),
          ...(active && !locked.active ? { pausedReason: null } : {}),
        })
        .where(eq(routines.id, locked.id));
      return locked;
    });
    return `Updated routine "${row.name}".`;
  },
});

// ---- Debates ----

async function agentIdsByHandle(ctx: ToolContext, handles: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const h of handles) {
    const handle = h.replace(/^@/, "").toLowerCase();
    const [a] = await ctx.deps.db
      .select({ id: agents.id })
      .from(agents)
      .where(
        and(eq(agents.workspaceId, ctx.workspaceId), eq(agents.handle, handle), isNull(agents.archivedAt)),
      );
    if (!a) throw new ToolInputError(`No agent @${handle}`);
    out.push(a.id);
  }
  return out;
}

const openDebateTool = defineStored({
  name: "open_debate",
  description:
    "Propose a debate between agents (by @handle) about a goal. Each agent answers blind first; extra challenge rounds (`rounds`, 0 = just vote) run only while they disagree. By default it posts a suggestion the person accepts; use open: true only when the person explicitly asked to start it now.",
  effect: "K1",
  input: z.object({
    title: z.string().trim().min(1).max(200),
    goal: z.string().trim().min(1).max(4000),
    agents: z.array(z.string()).min(1).max(8),
    rounds: z.number().int().min(0).max(10).optional(),
    open: z.boolean().default(false),
  }),
  async run(ctx, input) {
    const agentIds = [...new Set([...(await agentIdsByHandle(ctx, input.agents))])];
    if (!input.open) {
      await ctx.postCard(input.title, {
        debateSuggestion: {
          title: input.title,
          goal: input.goal,
          agentIds,
          state: "pending",
          debateId: null,
        },
      });
      return "Posted the suggestion; the person can open it.";
    }
    // The agents' turns are model calls: without the runtime nothing is written, not even the debate.
    needsRuntime(ctx, "complete");
    const debate = await domain(
      openDebate(ctx.deps, {
        workspaceId: ctx.workspaceId,
        title: input.title,
        goal: input.goal,
        agentIds,
        roundLimit: input.rounds,
        createdBy: self(ctx),
        requesterUserId: ctx.trigger?.authorId ?? null,
        channelId: ctx.channel.id,
        origin: { kind: "manual", agentId: ctx.agent.id },
      }),
    );
    await ctx.postCard(debate.title, { debate: { debateId: debate.id, title: debate.title } });
    return `Opened debate ${debate.id}.`;
  },
});

/** A debate the agent and whoever asked see; otherwise "it doesn't exist", as on the screen. */
async function debateFor(ctx: ToolContext, debateId: string) {
  const { db } = ctx.deps;
  const debate = await domain(debateById(db, ctx.workspaceId, debateId));
  const who = requester(ctx);
  if (
    !(await agentCanSeeDebate(db, debate, ctx.agent.id)) ||
    (who && !(await canSeeDebate(db, debate, who.id)))
  )
    throw new ToolInputError("Debate not found");
  return debate;
}

const readDebate = defineStored({
  name: "read_debate",
  description: "Read a debate: its goal, status and what each participant said.",
  effect: "K0",
  input: z.object({ debateId: z.string().min(1) }),
  async run(ctx, input) {
    const { db } = ctx.deps;
    const debate = await debateFor(ctx, input.debateId);
    // The turns of the round in progress stay hidden; while the debate is open, an agent's turn shows only its
    // pseudonym (not even the agent itself knows who is who: the blind round holds here too).
    const posts = await db
      .select()
      .from(debatePosts)
      .where(and(eq(debatePosts.debateId, debate.id), eq(debatePosts.hiddenUntilRoundEnd, false)))
      .orderBy(asc(debatePosts.createdAt), asc(debatePosts.id));
    const lines = posts
      .map((p) => toPost(p, debate))
      .map((p) => {
        const who = p.author ? `${p.author.type}:${p.author.id}` : `participant ${p.pseudonym ?? "?"}`;
        const answer = p.claimData ? ` [answer: ${p.claimData.answer}]` : "";
        return `[round ${p.round}] ${who}${answer}: ${short(p.body, 1500)}`;
      });
    return `# ${debate.title} (${debate.status}, round ${debate.round}/${debate.roundLimit})\nGoal: ${debate.goal}\n\n${lines.join("\n\n") || "(no posts yet)"}`;
  },
});

const postInDebate = defineStored({
  name: "post_in_debate",
  description:
    "Add a contribution to a debate you are a speaker at, outside the rounds. Not available while the debate runs its blind, anonymous rounds.",
  effect: "K1",
  input: z.object({ debateId: z.string().min(1), body: z.string().trim().min(1).max(20_000) }),
  async run(ctx, input) {
    const debate = await debateFor(ctx, input.debateId);
    if (debate.status === "done" || debate.status === "canceled")
      throw new ToolInputError("This debate is closed");
    // A post outside the turn belongs to who is at the table; the other agents don't join the debate this way.
    if (!debate.agentIds.includes(ctx.agent.id))
      throw new ToolInputError("You are not at this debate's table; ask whoever opened it to add you");
    // While the debate is open, the posts are anonymous and by round: a signed post outside the turn would
    // break the blind round and tell who is who.
    if (isAnonymous(debate))
      throw new ToolInputError("This debate is in blind rounds; give your position when the round asks you");
    const post = await domain(
      insertPost(ctx.deps, debate, {
        author: self(ctx),
        kind: "free",
        round: debate.round,
        body: input.body,
      }),
    );
    return `Posted in "${debate.title}" (${post.id}).`;
  },
});

export const CONTENT_TOOLS: readonly ToolDef<unknown>[] = [
  listFiles,
  readFile,
  createFileTool,
  updateFileTool,
  shareFile,
  readWikiPage,
  createWikiPage,
  updateWikiPage,
  proposeWikiEdit,
  linkToWiki,
  listIssues,
  createIssueTool,
  updateIssueTool,
  commentIssue,
  listEvents,
  findFreeTime,
  proposeEvent,
  createRoutineTool,
  listRoutinesTool,
  updateRoutineTool,
  openDebateTool,
  readDebate,
  postInDebate,
];

/** Everything the agent can call. */
export const AGENT_TOOLS: readonly ToolDef<unknown>[] = [
  ...BUILTIN_TOOLS,
  ...MEMORY_TOOLS,
  ...CONTENT_TOOLS,
  ...BASE_TOOLS,
];
