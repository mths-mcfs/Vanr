// The wiki routes as the wiki tests call them: one function per route, named by the route's operation (the
// vocabulary's client methods), over the real HTTP of a signed-in `Browser`. The typed client package comes
// with a later slice; until then this is the wiki's share of it, with the response types of @vanr/contract.
import type {
  File,
  WikiAccessInput,
  WikiAnnotations,
  WikiChange,
  WikiCheckReport,
  WikiComment,
  WikiCommentInput,
  WikiDecision,
  WikiDiff,
  WikiGraph,
  WikiIndex,
  WikiPage,
  WikiPageSummary,
  WikiPanel,
  WikiPropDef,
  WikiTopRead,
  WikiTrashedPage,
  WikiVaultImportResult,
} from "@vanr/contract";
import type { Browser } from "./harness";

/** A route's error (`{ error: { code, message, params } }`) with its status. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly params?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/** The error of a call that must fail; a call that succeeds fails the test. */
export async function apiError(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof ApiError) return err;
    throw err;
  }
  throw new Error("expected the call to fail");
}

async function ok<T>(res: Promise<Response>): Promise<T> {
  const r = await res;
  if (r.ok) return (r.status === 204 ? undefined : await r.json()) as T;
  const raw = await r.text();
  let err: { code?: string; message?: string; params?: Record<string, unknown> } = {};
  try {
    err = JSON.parse(raw).error ?? {};
  } catch {
    // not JSON: the status says it
  }
  throw new ApiError(r.status, err.code ?? `http_${r.status}`, err.message ?? raw, err.params);
}

export interface WikiPageInput {
  title: string;
  folder?: string;
  body?: string;
  tags?: string[];
  altTitles?: string[];
  props?: Record<string, unknown>;
}

const W = (workspaceId: string) => `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/wiki`;
const P = (workspaceId: string, slug: string) => `${W(workspaceId)}/pages/${encodeURIComponent(slug)}`;

export function wikiApi(b: Browser) {
  const json = <T>(path: string, method: string, data?: unknown) => ok<T>(b.json(path, method, data));
  return {
    listWikiPages: async (ws: string) =>
      (await json<{ pages: WikiPageSummary[] }>(`${W(ws)}/pages`, "GET")).pages,
    getWikiPage: (ws: string, slug: string) => json<WikiPage>(P(ws, slug), "GET"),
    getWikiSearch: async (ws: string, q: string) =>
      (await json<{ pages: WikiPageSummary[] }>(`${W(ws)}/search?q=${encodeURIComponent(q)}`, "GET")).pages,
    createWikiPage: (ws: string, input: WikiPageInput) => json<WikiPage>(`${W(ws)}/pages`, "POST", input),
    replaceWikiPage: (
      ws: string,
      slug: string,
      input: { body: string; parentVersion: number; folder?: string; tags?: string[]; note?: string },
    ) => json<WikiPage>(P(ws, slug), "PUT", input),
    renameWikiPage: (ws: string, slug: string, title: string) =>
      json<WikiPage>(`${P(ws, slug)}/rename`, "POST", { title }),
    getWikiGraph: (ws: string, q: { pageId?: string; depth?: number } = {}) => {
      const qs = new URLSearchParams(
        Object.entries(q).map(([k, v]): [string, string] => [k, String(v)]),
      ).toString();
      return json<WikiGraph>(`${W(ws)}/graph${qs ? `?${qs}` : ""}`, "GET");
    },
    moveWikiPage: (ws: string, slug: string, folder: string) =>
      json<WikiPage>(`${P(ws, slug)}/move`, "POST", { folder }),
    lockWikiPage: (ws: string, slug: string, locked: boolean) =>
      json<WikiPage>(`${P(ws, slug)}/lock`, "POST", { locked }),
    pinWikiPage: (ws: string, slug: string, pinned: boolean) =>
      json<WikiPage>(`${P(ws, slug)}/pin`, "POST", { pinned }),
    deleteWikiPage: (ws: string, slug: string) => json<void>(P(ws, slug), "DELETE"),
    getWikiReads: (ws: string) => json<WikiTopRead[]>(`${W(ws)}/reads`, "GET"),
    importWiki: (ws: string, input: { files: { path: string; text: string }[]; folder?: string }) =>
      json<{ created: number; skipped: number; failed: { path: string; error: string }[] }>(
        `${W(ws)}/import`,
        "POST",
        input,
      ),
    updateWikiPageMeta: (
      ws: string,
      slug: string,
      input: {
        parentVersion: number;
        props?: Record<string, unknown>;
        altTitles?: string[];
        tags?: string[];
        agentEdits?: "direct" | "propose";
      },
    ) => json<WikiPage>(`${P(ws, slug)}/meta`, "PATCH", input),
    getWikiPageDiff: (ws: string, slug: string, q: { from?: number; to?: number } = {}) => {
      const qs = new URLSearchParams(
        Object.entries(q).map(([k, v]): [string, string] => [k, String(v)]),
      ).toString();
      return json<WikiDiff>(`${P(ws, slug)}/diff${qs ? `?${qs}` : ""}`, "GET");
    },
    restoreWikiPageVersion: (ws: string, slug: string, version: number, parentVersion: number) =>
      json<WikiPage>(`${P(ws, slug)}/versions/${version}/restore`, "POST", { parentVersion }),
    getWikiPagePanel: (ws: string, slug: string) => json<WikiPanel>(`${P(ws, slug)}/panel`, "GET"),
    publishWikiPageDraft: (ws: string, slug: string, force?: boolean) =>
      json<WikiPage>(`${P(ws, slug)}/draft/publish`, "POST", force === undefined ? {} : { force }),
    deleteWikiPageDraft: (ws: string, slug: string) => json<WikiPage>(`${P(ws, slug)}/draft`, "DELETE"),
    getWikiTrash: async (ws: string) =>
      (await json<{ pages: WikiTrashedPage[] }>(`${W(ws)}/trash`, "GET")).pages,
    restoreWikiTrash: (ws: string, slug: string) =>
      json<WikiPage>(`${W(ws)}/trash/${encodeURIComponent(slug)}/restore`, "POST"),
    deleteWikiTrash: (ws: string, slug: string) =>
      json<void>(`${W(ws)}/trash/${encodeURIComponent(slug)}`, "DELETE"),
    listWikiProps: (ws: string) => json<{ defs: WikiPropDef[]; version: number }>(`${W(ws)}/props`, "GET"),
    setWikiProps: (ws: string, defs: WikiPropDef[], parentVersion: number) =>
      json<{ defs: WikiPropDef[]; version: number }>(`${W(ws)}/props`, "PUT", { defs, parentVersion }),
    importWikiVault: (ws: string, input: { file: Blob; fileName: string; folder?: string }) => {
      const form = new FormData();
      form.set("file", new globalThis.File([input.file], input.fileName, { type: "application/zip" }));
      if (input.folder !== undefined) form.set("folder", input.folder);
      return ok<WikiVaultImportResult>(b.fetch(`${W(ws)}/import/vault`, { method: "POST", body: form }));
    },
    exportWiki: async (ws: string) => {
      const res = await b.fetch(`${W(ws)}/export`);
      if (!res.ok) await ok(Promise.resolve(res));
      return res;
    },
    listWikiAttachments: async (ws: string) =>
      (
        await json<{ attachments: { path: string; fileId: string; contentType: string | null }[] }>(
          `${W(ws)}/attachments`,
          "GET",
        )
      ).attachments,
    setWikiPageAccess: (ws: string, slug: string, access: WikiAccessInput) =>
      json<WikiPage>(`${P(ws, slug)}/access`, "PUT", { access }),
    listWikiPageAnnotations: (ws: string, slug: string) =>
      json<WikiAnnotations>(`${P(ws, slug)}/annotations`, "GET"),
    createWikiPageComment: (ws: string, slug: string, input: WikiCommentInput) =>
      json<WikiComment>(`${P(ws, slug)}/comments`, "POST", input),
    setWikiAnnotationResolution: (ws: string, id: string) =>
      json<WikiComment>(`${W(ws)}/annotations/${encodeURIComponent(id)}/resolution`, "PUT"),
    deleteWikiAnnotationResolution: (ws: string, id: string) =>
      json<WikiComment>(`${W(ws)}/annotations/${encodeURIComponent(id)}/resolution`, "DELETE"),
    deleteWikiAnnotation: (ws: string, id: string) =>
      json<void>(`${W(ws)}/annotations/${encodeURIComponent(id)}`, "DELETE"),
    decideWikiAnnotation: (ws: string, id: string, decisions: { hunkId: string; accept: boolean }[]) =>
      json<WikiDecision>(`${W(ws)}/annotations/${encodeURIComponent(id)}/decide`, "POST", { decisions }),
    getWikiIndex: (ws: string) => json<WikiIndex>(`${W(ws)}/index`, "GET"),
    listWikiChanges: async (ws: string, q: { before?: string; limit?: number } = {}) => {
      const qs = new URLSearchParams(
        Object.entries(q).flatMap(([k, v]): [string, string][] => (v === undefined ? [] : [[k, String(v)]])),
      ).toString();
      return (await json<{ changes: WikiChange[] }>(`${W(ws)}/changes${qs ? `?${qs}` : ""}`, "GET")).changes;
    },
    getWikiChecks: (ws: string) => json<WikiCheckReport>(`${W(ws)}/checks`, "GET"),
    createWikiCheck: (ws: string) => json<WikiCheckReport>(`${W(ws)}/checks`, "POST"),
    /** The Drive's file list (where the vault's attachments go). */
    listFiles: async (ws: string) =>
      (await ok<{ files: File[] }>(b.fetch(`/api/v1/workspaces/${encodeURIComponent(ws)}/files`))).files,
  };
}
