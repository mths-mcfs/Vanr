// Wiki pages, drafts, versions, links and properties.

import type { ActorRef } from "./common.ts";

export interface WikiPageSummary {
  altTitles: string[];
  excerpt: string;
  folder: string;
  locked: boolean;
  pinned: boolean;
  /** Typed properties (`{ [propId]: value }`), defined by `listWikiProps`. */
  props: Record<string, unknown>;
  slug: string;
  sourceType: "obsidian" | null;
  tags: string[];
  title: string;
  updatedAt: string;
  updatedBy: ActorRef & { onBehalfOf?: string };
  version: number;
}

export interface WikiVersion {
  at: string;
  author: ActorRef & { onBehalfOf?: string };
  note: string | null;
  version: number;
}

export interface WikiPage extends WikiPageSummary {
  authors: ActorRef[];
  backlinks: { slug: string; title: string }[];
  body: string;
  canEdit: boolean;
  /** Live draft not yet published as a version. */
  draft: WikiDraft | null;
  history: WikiVersion[];
  reads: { agents: string[]; last: string | null; total: number };
  /** Only on rename: pages whose [[links]] were rewritten and the ones left alone (locked). */
  renamed?: { rewritten: { slug: string; title: string }[]; skipped: { slug: string; title: string }[] };
}

export interface WikiDraft {
  baseVersion: number;
  dirty: boolean;
  editedAt: string | null;
  editors: ActorRef[];
}

export interface WikiPanel {
  backlinks: { count: number; slug: string; snippet: string; title: string }[];
  /** Pages that mention the title (or an alternate title) without a [[link]]. */
  mentions: { slug: string; snippet: string; title: string }[];
  outgoing: {
    anchor: string | null;
    embed: boolean;
    label: string | null;
    page: { slug: string; title: string } | null;
    state: "broken_anchor" | "missing" | "ok" | "trashed";
    target: string;
  }[];
  outline: { level: number; line: number; text: string }[];
}

export interface WikiDiffLine {
  kind: "add" | "del" | "same";
  /** Changed line: segments with what changed inside it. */
  parts?: { kind: "add" | "del" | "same"; text: string }[];
  text: string;
}

export interface WikiDiff {
  from: WikiVersion & { title: string };
  /** Lines with context; `null` is a collapsed run of unchanged lines. */
  lines: (WikiDiffLine | { count: number; kind: "gap" })[];
  props: { after: string; before: string; name: string; propId: string }[];
  stats: { added: number; removed: number };
  to: WikiVersion & { title: string };
}

export interface WikiTrashedPage {
  canPurge: boolean;
  deletedAt: string;
  deletedBy: ActorRef | null;
  folder: string;
  purgeAt: string;
  slug: string;
  title: string;
}

/** Property definition, as the contract sees it. */
export interface WikiPropDef {
  id: string;
  groups?: { doing: string[]; done: string[]; todo: string[] };
  name: string;
  numberFormat?: "currency_brl" | "currency_usd" | "percent" | "plain";
  options?: { id: string; color?: string; name: string }[];
  type: string;
  withTime?: boolean;
}

export interface WikiVaultImportResult {
  attachments: number;
  created: number;
  failed: { error: string; path: string }[];
  propsCreated: string[];
  skipped: number;
}

export interface WikiAttachment {
  contentType: string | null;
  fileId: string;
  path: string;
}

export interface WikiTopRead {
  agents: string[];
  slug: string;
  title: string;
  total: number;
}
