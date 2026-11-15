// Wiki pages, drafts, versions, links and properties.

import type { ActorRef } from "./common.ts";

export interface WikiPageSummary {
  /** How an agent changes the page: directly or through a proposal a person reviews. */
  agentEdits: "direct" | "propose";
  altTitles: string[];
  excerpt: string;
  folder: string;
  locked: boolean;
  pinned: boolean;
  /** Typed properties (`{ [propId]: value }`), defined by `listWikiProps`. */
  props: Record<string, unknown>;
  /** Only some people, agents or a channel's readers read it (the padlock in the tree). */
  restricted: boolean;
  slug: string;
  sourceType: "obsidian" | null;
  tags: string[];
  title: string;
  updatedAt: string;
  updatedBy: ActorRef & { actingFor?: string };
  version: number;
}

export interface WikiVersion {
  at: string;
  author: ActorRef & { actingFor?: string };
  note: string | null;
  version: number;
}

export interface WikiPage extends WikiPageSummary {
  /** Who reads it, when the page is restricted (null: the whole workspace). */
  access: WikiAccess | null;
  /** Whether the reader may change who reads it: who created the page or an admin. */
  accessEditable: boolean;
  authors: ActorRef[];
  body: string;
  /** Live draft not yet published as a version. */
  draft: WikiDraft | null;
  editable: boolean;
  history: WikiVersion[];
  inboundLinks: { slug: string; title: string }[];
  reads: { agents: string[]; last: string | null; total: number };
  /** Only on rename: pages whose [[links]] were rewritten and the ones left alone (locked). */
  relinked?: { rewritten: { slug: string; title: string }[]; skipped: { slug: string; title: string }[] };
}

export interface WikiDraft {
  dirty: boolean;
  editedAt: string | null;
  editors: ActorRef[];
  parentVersion: number;
}

export interface WikiPanel {
  inboundLinks: { count: number; slug: string; snippet: string; title: string }[];
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
  expungeAt: string;
  folder: string;
  slug: string;
  title: string;
}

/** Property definition, as the contract sees it. */
export interface WikiPropDef {
  id: string;
  groups?: { done: string[]; inProgress: string[]; todo: string[] };
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

/** Who reads a restricted page, with the names for the screen. */
export type WikiAccess =
  | { channelId: string; channelName: string | null; kind: "channel" }
  | {
      agents: { id: string; name: string | null }[];
      kind: "private";
      people: { id: string; name: string | null }[];
    };

/** The body of `setWikiPageAccess`: null gives the page back to the whole workspace. Who asks is always in `private`. */
export type WikiAccessInput =
  | null
  | { channelId: string; kind: "channel" }
  | { agentIds: string[]; kind: "private"; userIds: string[] };

/** A quoted passage (TextQuoteSelector): the text and a little of what comes before and after. */
export interface WikiAnchor {
  prefix: string;
  quote: string;
  suffix: string;
}

export interface WikiComment {
  /** The agent asked to act on the comment. */
  agentId: string | null;
  anchor: WikiAnchor | null;
  /** `orphan`: the passage is gone from the published text. */
  anchorState: "ok" | "orphan" | null;
  author: ActorRef & { actingFor?: string };
  body: string;
  createdAt: string;
  /** When the thread was resolved, and by whom (null while open). */
  handledAt: string | null;
  handledBy: ActorRef | null;
  id: string;
  /** A reply: the comment it answers (always the thread's first comment). */
  parentId: string | null;
  status: "open" | "resolved";
}

export interface WikiHunk {
  id: string;
  newStr: string;
  oldStr: string;
  status: "accepted" | "pending" | "rejected" | "stale";
}

export interface WikiProposal {
  author: ActorRef & { actingFor?: string };
  createdAt: string;
  /** When the last pending change was decided, and by whom (null while pending). */
  handledAt: string | null;
  handledBy: ActorRef | null;
  hunks: WikiHunk[];
  id: string;
  note: string;
  /** The page version the proposal read. */
  parentVersion: number;
  status: "done" | "pending";
}

export interface WikiAnnotations {
  comments: WikiComment[];
  proposals: WikiProposal[];
}

/** The body of `createWikiPageComment`. */
export interface WikiCommentInput {
  /** "Act on this comment": the agent gets the request in the commenter's DM with it. */
  agentId?: string;
  anchor?: WikiAnchor;
  body: string;
  parentId?: string;
}

/** The body of `decideWikiAnnotation`: each pending change of the proposal, accepted or rejected. */
export interface WikiDecisionInput {
  decisions: { accept: boolean; hunkId: string }[];
}

export interface WikiDecision {
  page: WikiPage;
  proposal: WikiProposal;
}

export interface WikiChange {
  action: "comment" | "create" | "move" | "proposal" | "rename" | "restore" | "trash" | "update";
  at: string;
  author: ActorRef & { actingFor?: string };
  detail: string | null;
  id: string;
  /** Null: the page is in the trash. */
  slug: string | null;
  title: string;
}

/** index.md: the pages the reader reads, by folder, each with a one-line summary. */
export interface WikiIndex {
  markdown: string;
  pages: number;
  updatedAt: string | null;
}

export type WikiCheckFinding =
  | { kind: "orphan"; page: { slug: string; title: string } }
  | {
      kind: "broken_link";
      page: { slug: string; title: string };
      state: "missing" | "trashed";
      target: string;
    }
  | {
      kind: "contradiction";
      pages: [{ slug: string; title: string }, { slug: string; title: string }];
      summary: string;
    };

export interface WikiCheckReport {
  findings: WikiCheckFinding[];
  ranAt: string | null;
  /** No Anthropic key: the contradictions were not checked by a real model. */
  testModel: boolean;
}

export interface WikiGraph {
  /** The local graph: the page at its center (null: the whole wiki). */
  center: string | null;
  edges: { from: string; to: string }[];
  nodes: { folder: string; slug: string; title: string }[];
}

export interface WikiTopRead {
  agents: string[];
  slug: string;
  title: string;
  total: number;
}
