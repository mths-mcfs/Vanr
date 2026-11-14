// A page's annotations, in `page_annotations`:
//
// - Anchored comment: a person comments on a passage, kept as a quote with a little of what comes before
//   and after (TextQuoteSelector). The anchor is found again on every read; if the passage is gone from the
//   text, the comment is an "orphan" (it stays on the list, without a place). Asking an agent to act on a
//   comment goes through the asker's DM with the agent, and comes with the chat and runtime slices: until
//   then a comment with `agentId` is rejected at the entry, before anything is written.
// - Proposal: old/new changes that don't touch the page until a person accepts them. Each change is decided
//   on its own; an accepted one lands on the current text with the safe edit's rule (the passage must
//   appear exactly once). If it is gone or ambiguous, the change becomes `stale` and changes nothing. The
//   agent tool that proposes (`propose_wiki_edit`) comes with the agent tools; `createProposal` is what it
//   calls.
import type { ActorRef, WikiAnnotations, WikiComment, WikiCommentInput, WikiProposal } from "@vanr/contract";
import { can } from "@vanr/contract";
import { type Db, schema } from "@vanr/engine/db";
import { newId } from "@vanr/engine/ids";
import { applyEdits, editFailureMessage, type TextEdit } from "@vanr/engine/wiki-edit";
import { and, asc, count, eq, isNull } from "drizzle-orm";
import type { AppDeps, WorkspaceMember } from "./context";
import { conflict, forbidden, HttpError, notFound } from "./http";
import {
  type Author,
  canEditPage,
  MAX_BODY,
  memberOnly,
  pageLock,
  savePage,
  type WikiRow,
  writeTx,
} from "./wiki";
import { canReadPage, type WikiViewer } from "./wiki-access";
import { logChange } from "./wiki-changes";

const { pageAnnotations, knowledgePages } = schema;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type AnnotationRow = typeof pageAnnotations.$inferSelect;
type Anchor = NonNullable<AnnotationRow["anchor"]>;
type Hunk = AnnotationRow["hunks"][number];

const CONTEXT = 32;
export const MAX_QUOTE = 2000;
/** Changes in one proposal. */
export const MAX_HUNKS = 20;
/** Comments and replies per page: every read looks for the anchor of each one. */
export const MAX_COMMENTS = 500;
/** Occurrences of the quote checked one by one when the whole context doesn't appear. */
export const LOCATE_CANDIDATES = 500;

/** The anchor of a passage that starts at `at` in the text. */
export function anchorAt(text: string, at: number, length: number): Anchor {
  return {
    quote: text.slice(at, at + length),
    prefix: text.slice(Math.max(0, at - CONTEXT), at),
    suffix: text.slice(at + length, at + length + CONTEXT),
  };
}

/** How many characters before `end` in the text match the end of `prefix` (without copying the text). */
const tailMatch = (text: string, end: number, prefix: string) => {
  let n = 0;
  while (n < prefix.length && end - 1 - n >= 0 && text[end - 1 - n] === prefix[prefix.length - 1 - n]) n++;
  return n;
};
const headMatch = (text: string, start: number, suffix: string) => {
  let n = 0;
  while (n < suffix.length && start + n < text.length && text[start + n] === suffix[n]) n++;
  return n;
};

/**
 * Where the anchor is in the text. First the whole context (before + quote + after), in one search; if the
 * text around it changed, the occurrence of the quote whose before and after match best, looking at most at
 * `LOCATE_CANDIDATES` of them (a short quote in a long page repeats thousands of times, and this runs on
 * every read of the comments). Without the quote in the text, `null` (an orphan comment). The search is
 * literal (`indexOf`): the quote's characters are never a pattern.
 */
export function locate(
  text: string,
  anchor: Anchor,
  /** Occurrences checked (the test proves the ceiling by the count, not by the clock). */
  stats?: { checked: number },
): number | null {
  if (!anchor.quote) return null;
  const whole = text.indexOf(anchor.prefix + anchor.quote + anchor.suffix);
  if (whole !== -1) return whole + anchor.prefix.length;
  let best: { at: number; score: number } | null = null;
  let seen = 0;
  for (let at = text.indexOf(anchor.quote); at !== -1 && seen < LOCATE_CANDIDATES; seen++) {
    const score =
      tailMatch(text, at, anchor.prefix) + headMatch(text, at + anchor.quote.length, anchor.suffix);
    if (!best || score > best.score) best = { at, score };
    if (stats) stats.checked++;
    at = text.indexOf(anchor.quote, at + 1);
  }
  return best?.at ?? null;
}

function toComment(row: AnnotationRow, body: string): WikiComment {
  return {
    id: row.id,
    parentId: row.parentId,
    author: row.author,
    body: row.body,
    anchor: row.anchor ?? null,
    anchorState: row.anchor ? (locate(body, row.anchor) === null ? "orphan" : "ok") : null,
    status: row.status === "resolved" ? "resolved" : "open",
    agentId: row.agentId,
    handledBy: row.handledBy ?? null,
    handledAt: row.handledAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

function toProposal(row: AnnotationRow): WikiProposal {
  return {
    id: row.id,
    author: row.author,
    note: row.body,
    parentVersion: row.parentVersion ?? 0,
    hunks: row.hunks,
    status: row.status === "done" ? "done" : "pending",
    handledBy: row.handledBy ?? null,
    handledAt: row.handledAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** The page's comments (anchors found on the published text) and proposals, oldest first. */
export async function annotationsOf(db: Db, page: WikiRow): Promise<WikiAnnotations> {
  const rows = await db
    .select()
    .from(pageAnnotations)
    .where(eq(pageAnnotations.pageId, page.id))
    .orderBy(asc(pageAnnotations.createdAt), asc(pageAnnotations.id));
  return {
    comments: rows.filter((r) => r.kind === "comment").map((r) => toComment(r, page.body)),
    proposals: rows.filter((r) => r.kind === "proposal").map(toProposal),
  };
}

/** An annotation of the workspace whose page (outside the trash) the reader reads; the rest is 404. */
export async function annotationFor(
  db: Db,
  viewer: WikiViewer,
  id: string,
): Promise<{ row: AnnotationRow; page: WikiRow }> {
  const [hit] = await db
    .select({ row: pageAnnotations, page: knowledgePages })
    .from(pageAnnotations)
    .innerJoin(knowledgePages, eq(knowledgePages.id, pageAnnotations.pageId))
    .where(
      and(
        eq(pageAnnotations.id, id),
        eq(pageAnnotations.workspaceId, viewer.workspaceId),
        isNull(knowledgePages.deletedAt),
      ),
    );
  if (!hit || !(await canReadPage(db, viewer, hit.page))) throw notFound("Comment not found");
  return hit;
}

/**
 * The annotation's row read for a decision: locked until the transaction ends, so two decisions on the same
 * proposal take turns and the second one decides on what the first wrote. A mutable seam: the Postgres race
 * test swaps it for an unlocked read (VANR_TEST_WIKI_ANNOTATIONS_UNLOCKED).
 */
export const annotationLock = {
  row: async (tx: Tx, id: string): Promise<AnnotationRow | null> => {
    const [row] = await tx.select().from(pageAnnotations).where(eq(pageAnnotations.id, id)).for("update");
    return row ?? null;
  },
};

const agentNotAvailable = () =>
  new HttpError(503, "not_available", "Asking an agent to act on a comment is not available yet", {
    feature: "wiki_comment_agent",
  });

/**
 * A new comment (or reply). The count and the insert run in one transaction on the page's row, locked: two
 * comments that land together on a page one short of the ceiling don't both get in.
 */
export async function createComment(
  deps: AppDeps,
  me: WorkspaceMember,
  page: WikiRow,
  input: WikiCommentInput,
): Promise<WikiComment> {
  // Asking an agent needs the DM and the runtime (the chat and runtime slices): rejected before any read
  // or write, so a comment never exists without the request it promised.
  if (input.agentId !== undefined) throw agentNotAvailable();
  const author: ActorRef = { type: "person", id: me.userId };
  const at = deps.now();
  const row = await writeTx(deps.db, async (tx) => {
    const locked = await pageLock.row(tx, page.id);
    if (!locked || locked.deletedAt) throw notFound("Page not found");
    await memberOnly(author)(tx, locked);
    let root: AnnotationRow | null = null;
    if (input.parentId) {
      const [parent] = await tx
        .select()
        .from(pageAnnotations)
        .where(and(eq(pageAnnotations.id, input.parentId), eq(pageAnnotations.pageId, page.id)));
      if (parent?.kind !== "comment") throw notFound("Comment not found");
      // A reply to a reply hangs on the thread's first comment.
      const [top] = parent.parentId
        ? await tx.select().from(pageAnnotations).where(eq(pageAnnotations.id, parent.parentId))
        : [parent];
      root = top ?? parent;
    }
    const [n] = await tx
      .select({ n: count() })
      .from(pageAnnotations)
      .where(and(eq(pageAnnotations.pageId, page.id), eq(pageAnnotations.kind, "comment")));
    if ((n?.n ?? 0) >= MAX_COMMENTS)
      throw new HttpError(
        409,
        "wiki.comment.too_many",
        "This page has too many comments; resolve or delete some",
        {
          max: MAX_COMMENTS,
        },
      );
    const [created] = await tx
      .insert(pageAnnotations)
      .values({
        id: newId("ann"),
        workspaceId: locked.workspaceId,
        pageId: page.id,
        kind: "comment",
        parentId: root?.id ?? null,
        author,
        body: input.body,
        anchor: root ? null : (input.anchor ?? null),
        status: "open",
        createdAt: at,
        updatedAt: at,
      })
      .returning();
    if (!created) throw new Error("comment insert failed");
    // A reply on a resolved thread opens it again.
    if (root?.status === "resolved")
      await tx
        .update(pageAnnotations)
        .set({ status: "open", handledBy: null, handledAt: null, updatedAt: at })
        .where(eq(pageAnnotations.id, root.id));
    await logChange(tx, { page: locked, action: "comment", author, at });
    return created;
  });
  return toComment(row, page.body);
}

/** Resolves (or opens again) a thread: who started it or who can edit the page. */
export async function resolveComment(
  deps: AppDeps,
  me: WorkspaceMember,
  id: string,
  resolved: boolean,
): Promise<WikiComment> {
  const { row, page } = await annotationFor(deps.db, { workspaceId: me.workspaceId, userId: me.userId }, id);
  if (row.kind !== "comment" || row.parentId) throw notFound("Comment not found");
  const mine = row.author.type === "person" && row.author.id === me.userId;
  if (!mine && !canEditPage(page, me)) throw forbidden("Only who commented or an editor can resolve");
  const at = deps.now();
  const [saved] = await deps.db
    .update(pageAnnotations)
    .set(
      resolved
        ? { status: "resolved", handledBy: { type: "person", id: me.userId }, handledAt: at, updatedAt: at }
        : { status: "open", handledBy: null, handledAt: null, updatedAt: at },
    )
    .where(eq(pageAnnotations.id, row.id))
    .returning();
  if (!saved) throw notFound("Comment not found");
  return toComment(saved, page.body);
}

/** Deletes a comment: who wrote it or an admin. Deleting the thread's first comment takes its replies along. */
export async function deleteComment(deps: AppDeps, me: WorkspaceMember, id: string): Promise<void> {
  const { row } = await annotationFor(deps.db, { workspaceId: me.workspaceId, userId: me.userId }, id);
  if (row.kind !== "comment") throw notFound("Comment not found");
  const mine = row.author.type === "person" && row.author.id === me.userId;
  if (!mine && !can(me.role, "configure")) throw forbidden("Only who wrote it or an admin can delete it");
  await deps.db.transaction(async (tx) => {
    await tx.delete(pageAnnotations).where(eq(pageAnnotations.parentId, row.id));
    await tx.delete(pageAnnotations).where(eq(pageAnnotations.id, row.id));
  });
}

/**
 * A proposal (what the agent tool `propose_wiki_edit` calls). Each change must hold on its own on the
 * current text (appear exactly once); the whole proposal is rejected if one doesn't, for the agent to fix.
 */
export async function createProposal(
  deps: AppDeps,
  input: {
    page: WikiRow;
    author: Author;
    parentVersion: number;
    edits: TextEdit[];
    note: string;
  },
): Promise<{ row: AnnotationRow; warnings: string[] }> {
  const { page } = input;
  if (input.edits.length === 0 || input.edits.length > MAX_HUNKS)
    throw new HttpError(400, "wiki.proposal.invalid", `A proposal has from 1 to ${MAX_HUNKS} changes`, {
      max: MAX_HUNKS,
    });
  if (page.locked) throw new HttpError(403, "wiki.page_locked", "This page is locked");
  const warnings: string[] = [];
  if (input.parentVersion !== page.version)
    warnings.push(
      `The page changed since version ${input.parentVersion} (now ${page.version}); the changes were checked against the latest text.`,
    );
  for (const [index, edit] of input.edits.entries()) {
    const out = applyEdits(page.body, [{ oldStr: edit.oldStr, newStr: edit.newStr }]);
    if (!out.ok) throw new HttpError(400, "wiki.proposal.invalid", editFailureMessage({ ...out, index }));
  }
  const at = deps.now();
  const hunks: Hunk[] = input.edits.map((e, i) => ({
    id: `h${i + 1}`,
    oldStr: e.oldStr,
    newStr: e.newStr,
    status: "pending",
  }));
  const row = await writeTx(deps.db, async (tx) => {
    const [created] = await tx
      .insert(pageAnnotations)
      .values({
        id: newId("ann"),
        workspaceId: page.workspaceId,
        pageId: page.id,
        kind: "proposal",
        author: input.author,
        body: input.note,
        hunks,
        parentVersion: page.version,
        status: "pending",
        createdAt: at,
        updatedAt: at,
      })
      .returning();
    if (!created) throw new Error("proposal insert failed");
    await logChange(tx, {
      page,
      action: "proposal",
      author: input.author,
      at,
      detail: `${hunks.length} changes`,
    });
    return created;
  });
  return { row, warnings };
}

/**
 * A person's decision on changes of a proposal. The accepted ones land on the current text, in order, in a
 * single version (author: the proposal's author, acting for whoever accepted), through `savePage`: the same
 * path an edit through the route takes, so the live editors merge it with what they are typing. A change
 * whose passage is gone or became ambiguous becomes `stale`. The page's row and then the annotation's are
 * locked in one transaction: two decisions on the same change apply it once, and a decision that lands
 * while the page is saved decides on the text that save left.
 */
export async function decideProposal(
  deps: AppDeps,
  me: WorkspaceMember,
  id: string,
  decisions: readonly { hunkId: string; accept: boolean }[],
): Promise<{ proposal: WikiProposal; page: WikiRow }> {
  const { row, page } = await annotationFor(deps.db, { workspaceId: me.workspaceId, userId: me.userId }, id);
  if (row.kind !== "proposal") throw notFound("Proposal not found");
  if (!canEditPage(page, me)) throw forbidden("Only who can edit the page decides on proposals");
  if (new Set(decisions.map((d) => d.hunkId)).size !== decisions.length)
    throw new HttpError(400, "wiki.proposal.repeated", "Each change can be decided once");
  const person: ActorRef = { type: "person", id: me.userId };
  const decided: { row?: AnnotationRow } = {};
  const saved = await savePage(deps, {
    row: page,
    author: { type: row.author.type, id: row.author.id, actingFor: me.userId },
    // The author is the proposal's: who decides is checked as the writer (inTx) and for the lock.
    attributionOnly: true,
    canBypassLock: can(me.role, "configure"),
    lockBypassBy: [person],
    inTx: memberOnly(person),
    note: `proposal ${row.id}`,
    bodyFor: async (tx, current) => {
      const ann = await annotationLock.row(tx, row.id);
      if (!ann || ann.pageId !== current.id) throw notFound("Proposal not found");
      const pending = new Map(ann.hunks.filter((h) => h.status === "pending").map((h) => [h.id, h]));
      let body = current.body;
      const status = new Map<string, Hunk["status"]>();
      for (const d of decisions) {
        const hunk = pending.get(d.hunkId);
        if (!hunk) throw conflict("wiki.proposal.decided", "This change was already decided");
        if (!d.accept) {
          status.set(hunk.id, "rejected");
          continue;
        }
        const out = applyEdits(body, [{ oldStr: hunk.oldStr, newStr: hunk.newStr }]);
        if (out.ok) {
          body = out.text;
          status.set(hunk.id, "accepted");
        } else status.set(hunk.id, "stale");
      }
      if (body.length > MAX_BODY) throw new HttpError(400, "wiki.too_large", "The page would be too long");
      const hunks = ann.hunks.map((h) => ({ ...h, status: status.get(h.id) ?? h.status }));
      const done = hunks.every((h) => h.status !== "pending");
      const at = deps.now();
      const [updated] = await tx
        .update(pageAnnotations)
        .set({
          hunks,
          status: done ? "done" : "pending",
          updatedAt: at,
          ...(done ? { handledBy: person, handledAt: at } : {}),
        })
        .where(eq(pageAnnotations.id, ann.id))
        .returning();
      if (!updated) throw notFound("Proposal not found");
      decided.row = updated;
      const accepted = [...status.values()].filter((s) => s === "accepted").length;
      await logChange(tx, {
        page: current,
        action: "proposal",
        author: person,
        at,
        detail: `${accepted} of ${decisions.length} accepted`,
      });
      return body === current.body ? null : body;
    },
  });
  if (!decided.row) throw notFound("Proposal not found");
  return { proposal: toProposal(decided.row), page: saved };
}
