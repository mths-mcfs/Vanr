// The wiki: pages with versions, drafts, metadata, the link graph, trash, import and export.
import type * as T from "@vanr/contract";
import * as C from "../contract-schemas.ts";
import { DOWNLOAD, endpoint as e, NOTHING } from "../endpoint.ts";
import * as s from "../schema.ts";
import { WikiGraph, WikiImportResult, WikiPageVersionBody, WikiPropSchema } from "./shapes.ts";

/** Where appended text came from (the page links back to it). */
export type WikiAppendSource =
  | { kind: "message"; messageId: string; channelId: string }
  | { kind: "debate"; debateId: string }
  | { kind: "assignment"; assignmentId: string };

const Pages = s.field("pages", s.array(C.WikiPageSummary));

export const wiki = {
  listWikiPages: e("GET", "/api/v1/workspaces/:workspaceId/wiki/pages", Pages),
  getWikiSearch: e("GET", "/api/v1/workspaces/:workspaceId/wiki/search", Pages).query<{ q: string }>(),
  getWikiPage: e("GET", "/api/v1/workspaces/:workspaceId/wiki/pages/:pageId", C.WikiPage),
  createWikiPage: e("POST", "/api/v1/workspaces/:workspaceId/wiki/pages", C.WikiPage).body<{
    title: string;
    folder?: string;
    body?: string;
    tags?: string[];
    altTitles?: string[];
    props?: Record<string, unknown>;
  }>(),
  replaceWikiPage: e("PUT", "/api/v1/workspaces/:workspaceId/wiki/pages/:pageId", C.WikiPage).body<{
    body: string;
    /** The version the edit started from; a newer one fails with `page_changed`. */
    parentVersion: number;
    folder?: string;
    tags?: string[];
    note?: string;
  }>(),
  updateWikiPageMeta: e("PATCH", "/api/v1/workspaces/:workspaceId/wiki/pages/:pageId/meta", C.WikiPage).body<{
    parentVersion: number;
    props?: Record<string, unknown>;
    altTitles?: string[];
    tags?: string[];
    /** How agents change the page: directly, or only through proposals a person reviews. */
    agentEdits?: "direct" | "propose";
  }>(),
  renameWikiPage: e("POST", "/api/v1/workspaces/:workspaceId/wiki/pages/:pageId/rename", C.WikiPage).body<{
    title: string;
  }>(),
  moveWikiPage: e("POST", "/api/v1/workspaces/:workspaceId/wiki/pages/:pageId/move", C.WikiPage).body<{
    folder: string;
  }>(),
  lockWikiPage: e("POST", "/api/v1/workspaces/:workspaceId/wiki/pages/:pageId/lock", C.WikiPage).body<{
    locked: boolean;
  }>(),
  pinWikiPage: e("POST", "/api/v1/workspaces/:workspaceId/wiki/pages/:pageId/pin", C.WikiPage).body<{
    pinned: boolean;
  }>(),
  appendWikiPage: e("POST", "/api/v1/workspaces/:workspaceId/wiki/pages/:pageId/append", C.WikiPage).body<{
    text: string;
    source: WikiAppendSource;
  }>(),
  deleteWikiPage: e("DELETE", "/api/v1/workspaces/:workspaceId/wiki/pages/:pageId", NOTHING),
  getWikiPageHistory: e(
    "GET",
    "/api/v1/workspaces/:workspaceId/wiki/pages/:pageId/history",
    s.field("versions", s.array(C.WikiVersion)),
  ),
  getWikiPageVersion: e(
    "GET",
    "/api/v1/workspaces/:workspaceId/wiki/pages/:pageId/versions/:versionId",
    WikiPageVersionBody,
  ),
  restoreWikiPageVersion: e(
    "POST",
    "/api/v1/workspaces/:workspaceId/wiki/pages/:pageId/versions/:versionId/restore",
    C.WikiPage,
  ).body<{ parentVersion: number }>(),
  getWikiPageDiff: e("GET", "/api/v1/workspaces/:workspaceId/wiki/pages/:pageId/diff", C.WikiDiff).query<{
    from?: number;
    to?: number;
  }>(),
  getWikiPagePanel: e("GET", "/api/v1/workspaces/:workspaceId/wiki/pages/:pageId/panel", C.WikiPanel),
  publishWikiPageDraft: e(
    "POST",
    "/api/v1/workspaces/:workspaceId/wiki/pages/:pageId/draft/publish",
    C.WikiPage,
  ).body<{ force?: boolean }>(),
  deleteWikiPageDraft: e("DELETE", "/api/v1/workspaces/:workspaceId/wiki/pages/:pageId/draft", C.WikiPage),
  getWikiGraph: e("GET", "/api/v1/workspaces/:workspaceId/wiki/graph", WikiGraph),
  getWikiReads: e("GET", "/api/v1/workspaces/:workspaceId/wiki/reads", s.array(C.WikiTopRead)),
  getWikiTrash: e(
    "GET",
    "/api/v1/workspaces/:workspaceId/wiki/trash",
    s.field("pages", s.array(C.WikiTrashedPage)),
  ),
  restoreWikiTrash: e("POST", "/api/v1/workspaces/:workspaceId/wiki/trash/:trashId/restore", C.WikiPage),
  deleteWikiTrash: e("DELETE", "/api/v1/workspaces/:workspaceId/wiki/trash/:trashId", NOTHING),
  listWikiProps: e("GET", "/api/v1/workspaces/:workspaceId/wiki/props", WikiPropSchema),
  setWikiProps: e("PUT", "/api/v1/workspaces/:workspaceId/wiki/props", WikiPropSchema).body<{
    defs: T.WikiPropDef[];
    parentVersion: number;
  }>(),
  importWiki: e("POST", "/api/v1/workspaces/:workspaceId/wiki/import", WikiImportResult).body<{
    files: { path: string; text: string }[];
    folder?: string;
  }>(),
  importWikiVault: e(
    "POST",
    "/api/v1/workspaces/:workspaceId/wiki/import/vault",
    C.WikiVaultImportResult,
  ).form<{ file: { blob: Blob; fileName: string }; folder?: string }>(),
  exportWiki: e("GET", "/api/v1/workspaces/:workspaceId/wiki/export", DOWNLOAD),
  /** Who reads the page: null gives it back to the whole workspace. Who created it or an admin. */
  setWikiPageAccess: e("PUT", "/api/v1/workspaces/:workspaceId/wiki/pages/:pageId/access", C.WikiPage).body<{
    access: T.WikiAccessInput;
  }>(),
  /** The page's comments and proposals. */
  getWikiPageAnnotations: e(
    "GET",
    "/api/v1/workspaces/:workspaceId/wiki/pages/:pageId/annotations",
    C.WikiAnnotations,
  ),
  createWikiPageComment: e(
    "POST",
    "/api/v1/workspaces/:workspaceId/wiki/pages/:pageId/comments",
    C.WikiComment,
  ).body<T.WikiCommentInput>(),
  /** Resolves a comment thread; `reopenWikiAnnotation` opens it again. */
  resolveWikiAnnotation: e(
    "PUT",
    "/api/v1/workspaces/:workspaceId/wiki/annotations/:annotationId/resolution",
    C.WikiComment,
  ),
  reopenWikiAnnotation: e(
    "DELETE",
    "/api/v1/workspaces/:workspaceId/wiki/annotations/:annotationId/resolution",
    C.WikiComment,
  ),
  deleteWikiAnnotation: e(
    "DELETE",
    "/api/v1/workspaces/:workspaceId/wiki/annotations/:annotationId",
    NOTHING,
  ),
  /** Accepts or rejects each pending change of a proposal. */
  decideWikiAnnotation: e(
    "POST",
    "/api/v1/workspaces/:workspaceId/wiki/annotations/:annotationId/decide",
    C.WikiDecision,
  ).body<T.WikiDecisionInput>(),
  listWikiAttachments: e(
    "GET",
    "/api/v1/workspaces/:workspaceId/wiki/attachments",
    s.field("attachments", s.array(C.WikiAttachment)),
  ),
};
