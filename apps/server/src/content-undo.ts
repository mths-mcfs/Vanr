// Undo and redo of what the agent did in the content (Drive, wiki, issues, routines).
// Each side checks that nothing changed since the action; if something did, it answers `action.changed_since`.
// File and wiki versions don't go back in time: undoing writes a new version with the old content.
//
// Every undoer runs inside the undo's transaction (`deps.db` is that transaction, see `applyUndo` in control.ts)
// and locks the content's row before it compares: a person's edit that lands meanwhile waits for the undo to
// commit (and then wins), or committed first and the undo sees it and declines. Nothing a person wrote is lost.
import type { ActorRef } from "@vanr/contract";
import { schema } from "@vanr/engine/db";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { AppDeps } from "./context";
import type { ActionRow, Undoer } from "./control";
import { isUniqueViolation } from "./db-errors";
import {
  addVersion,
  canSeeFile,
  contentOf,
  type FileVersionRow,
  restoreFile,
  type StructuredContent,
  trashFile,
  versionOf,
} from "./drive";
import { forbidden, HttpError, notFound } from "./http";
import { columnsOf, type IssueChange, updateIssue } from "./issues";
import { anchorOf, nextRunFor, triggerOf } from "./routines";
import { unindex } from "./search-index";
import { refreshPage, savePage } from "./wiki";
import { canReadPage } from "./wiki-access";

const {
  reversibleActions,
  files,
  knowledgePages,
  pageAnnotations,
  pageRevisions,
  issues,
  issueTimeline,
  routines,
} = schema;

const changed = (message: string) => new HttpError(409, "action.changed_since", message);
const gone = (message: string) => new HttpError(409, "action.gone", message);
const person = (userId: string): ActorRef => ({ type: "person", id: userId });

async function setParams(deps: AppDeps, row: ActionRow, params: Record<string, unknown>) {
  await deps.db
    .update(reversibleActions)
    .set({ params: { ...row.params, ...params } })
    .where(eq(reversibleActions.id, row.id));
}

/** Versions involved: the one before, the one the agent saved and the ones undo/redo saved. */
const versionParams = z.object({
  fromVersion: z.number().int(),
  toVersion: z.number().int(),
  undoVersion: z.number().int().optional(),
  redoVersion: z.number().int().optional(),
});

// ---- Drive ----

/** The file's row, locked until the undo commits (a person's save meanwhile waits for it). */
async function lockedFile(deps: AppDeps, id: string, workspaceId: string) {
  const [file] = await deps.db
    .select()
    .from(files)
    .where(and(eq(files.id, id), eq(files.workspaceId, workspaceId)))
    .for("no key update");
  if (!file) throw gone("The file no longer exists");
  return file;
}

/** Whoever undoes must see the file (a file of a channel they don't read is not theirs to change). */
async function seenFile(deps: AppDeps, row: ActionRow, actorUserId: string) {
  const file = await lockedFile(deps, row.target.id, row.workspaceId);
  if (!(await canSeeFile(deps.db, file, person(actorUserId)))) throw forbidden("You can't see this file");
  return file;
}

/** A version's content in the shape addVersion takes. */
async function payloadOf(deps: AppDeps, v: FileVersionRow) {
  const content = contentOf(v);
  if (content.kind !== "file") return { content: content satisfies StructuredContent };
  const blob = v.blobKey ? await deps.blobs.open(v.blobKey) : null;
  if (!blob) throw gone("That version's file no longer exists");
  return {
    file: {
      blob: blob.body,
      sha256: v.sha256 ?? undefined,
      fileName: content.name,
      contentType: content.contentType,
    },
  };
}

async function copyVersion(deps: AppDeps, row: ActionRow, actorUserId: string, expect: number, from: number) {
  const file = await seenFile(deps, row, actorUserId);
  if (file.deletedAt) throw gone("The file is in the trash");
  if (file.version !== expect) throw changed("Someone saved a newer version");
  const saved = await addVersion(deps, {
    row: file,
    author: person(actorUserId),
    parentVersion: file.version,
    note: `restored version ${from}`,
    ...(await payloadOf(deps, await versionOf(deps.db, file, from))),
  });
  return saved.row.version;
}

// ---- Wiki ----

const propActor = z.object({ type: z.enum(["person", "agent"]), id: z.string() });
const propValue = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.string()),
  z.object({ start: z.string(), end: z.string().optional() }),
  propActor,
  z.array(propActor),
  z.null(),
]);

/** What the page had when the undo deleted it (to redo with the same id and slug). */
const deletedPage = z.object({
  slug: z.string(),
  title: z.string(),
  folder: z.string(),
  tags: z.array(z.string()),
  body: z.string(),
  aliases: z.array(z.string()).default([]),
  props: z.record(z.string(), propValue).default({}),
  // Who reads it and how agents change it: a restricted page comes back restricted, never public.
  access: z
    .union([
      z.object({ kind: z.literal("private"), principals: z.array(z.string()) }),
      z.object({ kind: z.literal("channel"), channelId: z.string() }),
    ])
    .nullable()
    .default(null),
  agentEdits: z.enum(["direct", "propose"]).default("direct"),
  // Who created it (the first version's author, with the person an agent acted for): who may change who
  // reads it is the same before the undo and after the redo.
  author: z
    .object({ type: z.enum(["person", "agent"]), id: z.string(), actingFor: z.string().optional() })
    .optional(),
  createdAt: z.string(),
});

/**
 * The page's row, locked until the undo commits. FOR NO KEY UPDATE like the wiki's own writes (wiki.ts
 * `pageLock`); the undo of a creation takes FOR UPDATE, the delete's lock.
 */
async function lockedPage(
  deps: AppDeps,
  row: ActionRow,
  actorUserId: string,
  strength: "no key update" | "update",
) {
  const [page] = await deps.db
    .select()
    .from(knowledgePages)
    .where(and(eq(knowledgePages.id, row.target.id), eq(knowledgePages.workspaceId, row.workspaceId)))
    .for(strength);
  // Read on the locked row: a page restricted away from the person answers like one that doesn't exist.
  if (page && !(await canReadPage(deps.db, { workspaceId: row.workspaceId, userId: actorUserId }, page)))
    throw notFound("Page not found");
  if (!page || page.deletedAt) throw gone("The page no longer exists");
  return page;
}

async function copyPageVersion(
  deps: AppDeps,
  row: ActionRow,
  actorUserId: string,
  expect: number,
  from: number,
) {
  const page = await lockedPage(deps, row, actorUserId, "no key update");
  if (page.version !== expect) throw changed("Someone saved a newer version");
  const [old] = await deps.db
    .select()
    .from(pageRevisions)
    .where(and(eq(pageRevisions.pageId, page.id), eq(pageRevisions.version, from)));
  if (!old) throw gone("That version no longer exists");
  // savePage checks again, in this transaction, that the person still writes here and that the page isn't locked.
  const saved = await savePage(deps, {
    row: page,
    author: person(actorUserId),
    canBypassLock: false,
    parentVersion: expect,
    body: old.body,
    title: old.title,
    // A revision from before properties were kept has none: the page keeps the ones it has.
    props: old.props ?? undefined,
    note: `restored version ${from}`,
  });
  return saved.version;
}

// ---- Issues ----

/**
 * The issue's row, locked until the undo commits. A change that moves the issue takes the board's lock first,
 * the same advisory lock and the same order as `updateIssue` (issues.ts): the board, then the issue.
 */
async function lockedIssue(deps: AppDeps, row: ActionRow, movesColumn: boolean) {
  if (movesColumn)
    await deps.db.execute(sql`select pg_advisory_xact_lock(hashtext(${`issue-board:${row.workspaceId}`}))`);
  const [issue] = await deps.db
    .select()
    .from(issues)
    .where(and(eq(issues.id, row.target.id), eq(issues.workspaceId, row.workspaceId)))
    .for("no key update");
  if (!issue) throw gone("The issue no longer exists");
  return issue;
}

const issueChange = z.object({
  columnId: z.string().optional(),
  priority: z.enum(["none", "low", "medium", "high", "urgent"]).optional(),
  title: z.string().optional(),
  pullRequests: z.array(z.string()).optional(),
});
type IssueFields = z.infer<typeof issueChange>;
const issueParams = z.object({ previous: issueChange, change: issueChange });
const ISSUE_KEYS = ["columnId", "priority", "title", "pullRequests"] as const;

/** The keys the agent's change set. */
const keysOf = (change: IssueFields) => ISSUE_KEYS.filter((k) => change[k] !== undefined);

/** Whether the issue still has each field of `keys` as `want` says. */
function matches(issue: typeof issues.$inferSelect, want: IssueFields, keys: readonly (keyof IssueFields)[]) {
  return keys.every((k) => JSON.stringify(issue[k]) === JSON.stringify(want[k]));
}

function pick(from: IssueFields, keys: readonly (keyof IssueFields)[]): IssueChange {
  const out: IssueChange = {};
  for (const k of keys) {
    if (k === "columnId" && from.columnId !== undefined) out.columnId = from.columnId;
    if (k === "priority" && from.priority !== undefined) out.priority = from.priority;
    if (k === "title" && from.title !== undefined) out.title = from.title;
    if (k === "pullRequests" && from.pullRequests !== undefined) out.pullRequests = from.pullRequests;
  }
  return out;
}

const savedComment = z.object({
  text: z.string(),
  author: z.object({ type: z.enum(["person", "agent"]), id: z.string() }),
  createdAt: z.string(),
});

export const CONTENT_UNDOERS: Record<
  | "file_created"
  | "file_updated"
  | "wiki_written"
  | "wiki_updated"
  | "issue_opened"
  | "issue_edited"
  | "issue_commented"
  | "routine_scheduled",
  Undoer
> = {
  file_created: {
    async undo(deps, row, actorUserId) {
      const file = await seenFile(deps, row, actorUserId);
      if (file.deletedAt) throw changed("The file is already in the trash");
      if (file.version > 1) throw changed("Someone saved a newer version");
      await trashFile(deps, file, person(actorUserId));
    },
    async redo(deps, row, actorUserId) {
      const file = await seenFile(deps, row, actorUserId);
      if (!file.deletedAt) throw changed("The file is not in the trash");
      await restoreFile(deps, file);
    },
  },
  file_updated: {
    async undo(deps, row, actorUserId) {
      const p = versionParams.parse(row.params);
      const undoVersion = await copyVersion(
        deps,
        row,
        actorUserId,
        p.redoVersion ?? p.toVersion,
        p.fromVersion,
      );
      await setParams(deps, row, { undoVersion });
    },
    async redo(deps, row, actorUserId) {
      const p = versionParams.parse(row.params);
      if (p.undoVersion === undefined) throw changed("Nothing to redo");
      const redoVersion = await copyVersion(deps, row, actorUserId, p.undoVersion, p.toVersion);
      await setParams(deps, row, { redoVersion });
    },
  },
  wiki_written: {
    async undo(deps, row, actorUserId) {
      const page = await lockedPage(deps, row, actorUserId, "update");
      if (page.version !== 1) throw changed("Someone edited the page");
      if (page.locked) throw new HttpError(403, "wiki.page_locked", "This page is locked");
      // Comments and proposals don't change the version, and the delete would take them along (the
      // cascade) with no way back through redo: a page someone annotated stays.
      const [annotated] = await deps.db
        .select({ id: pageAnnotations.id })
        .from(pageAnnotations)
        .where(eq(pageAnnotations.pageId, page.id))
        .limit(1);
      if (annotated) throw changed("Someone commented on the page");
      const [first] = await deps.db
        .select({ author: pageRevisions.author })
        .from(pageRevisions)
        .where(and(eq(pageRevisions.pageId, page.id), eq(pageRevisions.version, 1)));
      const deleted: z.input<typeof deletedPage> = {
        slug: page.slug,
        title: page.title,
        folder: page.folder,
        tags: page.tags,
        body: page.body,
        aliases: page.aliases,
        props: page.props,
        access: page.access ?? null,
        agentEdits: page.agentEdits,
        author: first?.author,
        createdAt: page.createdAt.toISOString(),
      };
      // Deleted for good (versions, links and draft go by the cascade) and out of the search in the same commit.
      await deps.db.delete(knowledgePages).where(eq(knowledgePages.id, page.id));
      await unindex(deps.db, deps, { kind: "wiki", id: page.id });
      await setParams(deps, row, { deleted });
      // The open editors close once the delete is committed.
      return (after) => after.wikiLive.pageClosed(page);
    },
    async redo(deps, row, actorUserId) {
      const saved = deletedPage.safeParse(row.params.deleted);
      if (!saved.success) throw changed("Nothing to redo");
      const p = saved.data;
      // The page comes back with the audience it had: whoever no longer reads it can't bring it back.
      const viewer = { workspaceId: row.workspaceId, userId: actorUserId };
      if (!(await canReadPage(deps.db, viewer, { workspaceId: row.workspaceId, access: p.access })))
        throw notFound("Page not found");
      const author = p.author ?? { type: "agent" as const, id: row.agentId };
      const at = deps.now();
      try {
        await deps.db.transaction(async (tx) => {
          await tx.insert(knowledgePages).values({
            id: row.target.id,
            workspaceId: row.workspaceId,
            slug: p.slug,
            title: p.title,
            folder: p.folder,
            tags: p.tags,
            body: p.body,
            aliases: p.aliases,
            props: p.props,
            access: p.access,
            agentEdits: p.agentEdits,
            version: 1,
            updatedBy: author,
            createdAt: new Date(p.createdAt),
            updatedAt: at,
          });
          await tx.insert(pageRevisions).values({
            pageId: row.target.id,
            version: 1,
            title: p.title,
            body: p.body,
            props: p.props,
            author,
            createdAt: at,
          });
        });
      } catch (err) {
        if (isUniqueViolation(err)) throw changed("Another page took this address");
        throw err;
      }
      await refreshPage(deps, row.target.id);
    },
  },
  wiki_updated: {
    async undo(deps, row, actorUserId) {
      const p = versionParams.parse(row.params);
      const undoVersion = await copyPageVersion(
        deps,
        row,
        actorUserId,
        p.redoVersion ?? p.toVersion,
        p.fromVersion,
      );
      await setParams(deps, row, { undoVersion });
    },
    async redo(deps, row, actorUserId) {
      const p = versionParams.parse(row.params);
      if (p.undoVersion === undefined) throw changed("Nothing to redo");
      const redoVersion = await copyPageVersion(deps, row, actorUserId, p.undoVersion, p.toVersion);
      await setParams(deps, row, { redoVersion });
    },
  },
  issue_opened: {
    // An issue doesn't vanish (its number stays): undo cancels it, redo puts it back in its first column.
    async undo(deps, row, actorUserId) {
      const issue = await lockedIssue(deps, row, true);
      const { columnId } = z.object({ columnId: z.string() }).parse(row.params);
      if (issue.columnId !== columnId) throw changed("Someone moved the issue");
      const canceled = (await columnsOf(deps.db, issue.workspaceId)).find((c) => c.stage === "canceled");
      if (!canceled) throw changed("There's no canceled column");
      await updateIssue(deps, issue, { columnId: canceled.id }, person(actorUserId));
    },
    async redo(deps, row, actorUserId) {
      const issue = await lockedIssue(deps, row, true);
      const { columnId } = z.object({ columnId: z.string() }).parse(row.params);
      const cols = await columnsOf(deps.db, issue.workspaceId);
      if (cols.find((c) => c.id === issue.columnId)?.stage !== "canceled")
        throw changed("Someone moved the issue");
      const back = cols.find((c) => c.id === columnId) ?? cols.find((c) => c.stage === "todo");
      if (!back) throw changed("The original column no longer exists");
      await updateIssue(deps, issue, { columnId: back.id }, person(actorUserId));
    },
  },
  issue_edited: {
    async undo(deps, row, actorUserId) {
      const { previous, change } = issueParams.parse(row.params);
      const keys = keysOf(change);
      const issue = await lockedIssue(deps, row, keys.includes("columnId"));
      if (!matches(issue, change, keys)) throw changed("Someone changed the issue");
      await updateIssue(deps, issue, pick(previous, keys), person(actorUserId));
    },
    async redo(deps, row, actorUserId) {
      const { previous, change } = issueParams.parse(row.params);
      const keys = keysOf(change);
      const issue = await lockedIssue(deps, row, keys.includes("columnId"));
      if (!matches(issue, previous, keys)) throw changed("Someone changed the issue");
      await updateIssue(deps, issue, pick(change, keys), person(actorUserId));
    },
  },
  issue_commented: {
    async undo(deps, row) {
      const { activityId } = z.object({ activityId: z.string() }).parse(row.params);
      const [act] = await deps.db
        .delete(issueTimeline)
        .where(and(eq(issueTimeline.id, activityId), eq(issueTimeline.issueId, row.target.id)))
        .returning();
      if (!act) throw gone("The comment no longer exists");
      await setParams(deps, row, {
        comment: { text: act.text, author: act.author, createdAt: act.createdAt.toISOString() },
      });
    },
    async redo(deps, row) {
      const { activityId } = z.object({ activityId: z.string() }).parse(row.params);
      const saved = savedComment.safeParse(row.params.comment);
      if (!saved.success) throw changed("Nothing to redo");
      await lockedIssue(deps, row, false);
      await deps.db.insert(issueTimeline).values({
        id: activityId,
        issueId: row.target.id,
        kind: "comment",
        text: saved.data.text,
        author: saved.data.author,
        createdAt: new Date(saved.data.createdAt),
      });
    },
  },
  routine_scheduled: {
    // Undo pauses the routine (its run history stays).
    async undo(deps, row) {
      const done = await deps.db
        .update(routines)
        .set({ active: false, nextFireAt: null })
        .where(
          and(
            eq(routines.id, row.target.id),
            eq(routines.workspaceId, row.workspaceId),
            eq(routines.active, true),
          ),
        )
        .returning({ id: routines.id });
      if (done.length === 0) throw changed("The routine is already paused or gone");
    },
    async redo(deps, row) {
      const [r] = await deps.db
        .select()
        .from(routines)
        .where(and(eq(routines.id, row.target.id), eq(routines.workspaceId, row.workspaceId)))
        .for("no key update");
      if (!r) throw gone("The routine no longer exists");
      if (r.active) throw changed("The routine is already active");
      const nextFireAt = nextRunFor(triggerOf(r), deps.now(), anchorOf(r));
      if (!nextFireAt) throw changed("The routine has no future run");
      await deps.db.update(routines).set({ active: true, nextFireAt }).where(eq(routines.id, r.id));
    },
  },
};
