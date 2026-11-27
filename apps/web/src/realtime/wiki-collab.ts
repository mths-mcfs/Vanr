// Where a wiki page's live document connects. Each open page has its own socket to the server's
// Hocuspocus (Yjs) endpoint, apart from the workspace's real-time connection: the session cookie
// signs it in, as it does the other one.
import { wikiCollabUrl as collabUrl } from "@vanr/client";
import type { SocketSource } from "./connection.ts";

/** The socket address of a workspace's live wiki pages. */
export function wikiCollabUrl(source: SocketSource, workspaceId: string): string {
  return collabUrl(source.baseUrl, workspaceId);
}

/** The document name the server gives a page: one live document per page. */
export const wikiDocumentName = (workspaceId: string, slug: string) => `wiki/${workspaceId}/${slug}`;

/** Close codes the server ends a live page's socket with. */
export const WIKI_CLOSE = {
  sessionEnded: 4401,
  revoked: 4403,
  readOnly: 4409,
  outOfSync: 4412,
  tooLarge: 4413,
} as const;
