// Workspace content: files (with versions and trash), wiki and debates.

import type { DebateClaim } from "@vanr/contract";
import { sql } from "drizzle-orm";
import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createdAt, ts, updatedAt } from "./columns";
import type { Props } from "./json";
import { workspaces } from "./workspaces";

export interface Actor {
  type: "person" | "agent";
  id: string;
}

/** Who reads a restricted page: whoever reads a channel, or a list of principals. */
export type WikiAccess = { kind: "channel"; channelId: string } | { kind: "private"; principals: string[] };

/** A quoted passage of a page (W3C TextQuoteSelector): the text and a little of what comes before and after. */
export interface WikiAnchor {
  quote: string;
  prefix: string;
  suffix: string;
  /** Where the quote started in the text the comment was made on (picks among identical contexts). */
  position?: number;
}

/** One change of a proposal, accepted or rejected on its own. */
export interface WikiHunk {
  id: string;
  oldStr: string;
  newStr: string;
  status: "pending" | "accepted" | "rejected" | "stale";
}

const workspace = () =>
  text("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" });

// ---- Files ----

export const files = pgTable(
  "files",
  {
    id: text("id").primaryKey(),
    workspaceId: workspace(),
    title: text("title").notNull(),
    kind: text("kind", { enum: ["document", "table", "diff", "diagram", "html", "file"] }).notNull(),
    /** Current version (the highest in file_versions). */
    version: integer("version").notNull().default(1),
    createdBy: jsonb("created_by").$type<Actor>().notNull(),
    updatedBy: jsonb("updated_by").$type<Actor>().notNull(),
    channelId: text("channel_id"),
    threadId: text("thread_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    /** In the trash: hidden from lists and deleted for good at `expungeAt`. */
    deletedAt: ts("deleted_at"),
    deletedBy: jsonb("deleted_by").$type<Actor>(),
    expungeAt: ts("expunge_at"),
  },
  (t) => [
    index("files_workspace_idx").on(t.workspaceId, t.updatedAt),
    index("files_purge_idx").on(t.expungeAt).where(sql`deleted_at is not null`),
  ],
);

export const fileVersions = pgTable(
  "file_versions",
  {
    fileId: text("file_id")
      .notNull()
      .references(() => files.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    /** Structured content (document, table, diff, diagram, html); null for an uploaded file. */
    content: jsonb("content").$type<Record<string, unknown>>(),
    /** Uploaded file: BlobStore key, name, type, size, and the text when it is text. */
    blobKey: text("blob_key"),
    fileName: text("file_name"),
    contentType: text("content_type"),
    size: integer("size"),
    text: text("text"),
    /** Extracted text (markdown per page: PDF page, slide, sheet) from the extraction queue. */
    pages: jsonb("pages").$type<{ page: number; markdown: string }[]>(),
    /**
     * Extraction queue for this version: `none` (no file, or a type without text), `pending`, `working`
     * (claimed at `extract_claimed_at`; back to pending if it stalls), `ready`, `failed`.
     */
    extractStatus: text("extract_status", { enum: ["none", "pending", "working", "ready", "failed"] })
      .notNull()
      .default("none"),
    extractClaimedAt: ts("extract_claimed_at"),
    extractAttempts: integer("extract_attempts").notNull().default(0),
    extractError: text("extract_error"),
    /** Type sniffed from the first bytes (what the server serves), not what the browser claimed. */
    detectedType: text("detected_type"),
    sha256: text("sha256"),
    /** Thumbnail (webp image) in the BlobStore. */
    thumbKey: text("thumb_key"),
    /** PDF preview of Office files (docx, xlsx, pptx), when a converter is configured. */
    previewKey: text("preview_key"),
    note: text("note"),
    author: jsonb("author").$type<Actor>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.fileId, t.version] }),
    index("file_versions_extract_idx")
      .on(t.extractStatus)
      .where(sql`extract_status in ('pending', 'working')`),
  ],
);

/**
 * Chunked, resumable upload: chunks go to a work file on the server's disk, in order (`received` is the
 * next expected byte); at the end the file becomes a blob and a file. An abandoned session goes away at
 * `expires_at`.
 */
export const uploadSessions = pgTable(
  "upload_sessions",
  {
    id: text("id").primaryKey(),
    workspaceId: workspace(),
    userId: text("user_id").notNull(),
    /** New version of an existing file; null creates a new file. */
    fileId: text("file_id"),
    parentVersion: integer("parent_version"),
    channelId: text("channel_id"),
    threadId: text("thread_id"),
    title: text("title"),
    note: text("note"),
    fileName: text("file_name").notNull(),
    contentType: text("content_type").notNull(),
    size: integer("size").notNull(),
    received: integer("received").notNull().default(0),
    /** sha256 computed by the browser (optional); completion checks it. */
    sha256: text("sha256"),
    status: text("status", { enum: ["open", "completing", "done"] })
      .notNull()
      .default("open"),
    /** Completed: the file and the version (repeating "complete" returns the same ones). */
    resultFileId: text("result_file_id"),
    resultVersion: integer("result_version"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    expiresAt: ts("expires_at").notNull(),
  },
  (t) => [index("upload_sessions_expires_idx").on(t.expiresAt)],
);

// ---- Wiki ----

export const knowledgePages = pgTable(
  "knowledge_pages",
  {
    id: text("id").primaryKey(),
    workspaceId: workspace(),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    folder: text("folder").notNull().default(""),
    tags: jsonb("tags").$type<string[]>().notNull().default([]),
    body: text("body").notNull().default(""),
    version: integer("version").notNull().default(1),
    pinned: boolean("pinned").notNull().default(false),
    /** Locked: only admins edit (agents do not). */
    locked: boolean("locked").notNull().default(false),
    sourceType: text("source_type", { enum: ["obsidian"] }),
    updatedBy: jsonb("updated_by").$type<Actor & { actingFor?: string }>().notNull(),
    /** Typed properties: `{ [propId]: value }`, defined in wiki_prop_schemas. */
    props: jsonb("props").$type<Props>().notNull().default({}),
    /** Other titles of the page: they also resolve [[links]]. */
    aliases: jsonb("aliases").$type<string[]>().notNull().default([]),
    /**
     * Who reads it. Null: the whole workspace. `channel`: whoever reads the channel (an agent only as a
     * member). `private`: only these (`user:<id>` and `agent:<id>`). It holds everywhere: lists, search,
     * links, graph, the live editor and agents.
     */
    access: jsonb("access").$type<WikiAccess>(),
    /** How an agent changes the page: directly or through a proposal a person reviews. */
    agentEdits: text("agent_edits", { enum: ["direct", "propose"] })
      .notNull()
      .default("direct"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    /** In the trash: hidden from lists, links and search; deleted for good at `expungeAt`. */
    deletedAt: ts("deleted_at"),
    deletedBy: jsonb("deleted_by").$type<Actor>(),
    expungeAt: ts("expunge_at"),
  },
  (t) => [
    uniqueIndex("knowledge_pages_slug_uq").on(t.workspaceId, t.slug),
    index("knowledge_pages_workspace_idx").on(t.workspaceId),
    index("knowledge_pages_purge_idx").on(t.expungeAt).where(sql`deleted_at is not null`),
  ],
);

export const pageRevisions = pgTable(
  "page_revisions",
  {
    pageId: text("page_id")
      .notNull()
      .references(() => knowledgePages.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    /** Properties at this version (restoring brings back body, title and properties). */
    props: jsonb("props").$type<Props>(),
    author: jsonb("author").$type<Actor & { actingFor?: string }>().notNull(),
    note: text("note"),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.pageId, t.version] })],
);

/**
 * [[ ]] links of each page, extracted on save: backlinks, graph, mentions and renames without reading every
 * page. A null `targetId` is a link to a page that does not exist (yet).
 */
export const pageLinks = pgTable(
  "page_links",
  {
    sourceId: text("source_id")
      .notNull()
      .references(() => knowledgePages.id, { onDelete: "cascade" }),
    ordinal: integer("ordinal").notNull(),
    workspaceId: workspace(),
    targetId: text("target_id").references(() => knowledgePages.id, { onDelete: "set null" }),
    /** Target as written in the text (without anchor and label). */
    targetText: text("target_text").notNull(),
    /** `slugify` of the target: finds the link when a new page gets that slug (`[[Foo_Bar]]` → `foo-bar`). */
    targetSlug: text("target_slug").notNull().default(""),
    anchor: text("anchor"),
    linkText: text("link_text"),
    embed: boolean("embed").notNull().default(false),
  },
  (t) => [
    primaryKey({ columns: [t.sourceId, t.ordinal] }),
    index("page_links_target_idx").on(t.targetId),
    index("page_links_workspace_idx").on(t.workspaceId),
    index("page_links_workspace_slug_idx").on(t.workspaceId, t.targetSlug),
  ],
);

/** Property definitions for the workspace's pages, one list per workspace. */
export const wikiPropSchemas = pgTable("wiki_prop_schemas", {
  workspaceId: text("workspace_id")
    .primaryKey()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  defs: jsonb("defs").$type<unknown[]>().notNull().default([]),
  version: integer("version").notNull().default(1),
  updatedAt: updatedAt(),
});

/**
 * Live page session (Yjs): the shared draft. `state` is the full Yjs update in base64; `parentVersion` is
 * the page version the draft started from; `dirty` says whether there are edits not yet published as a
 * version.
 */
export const wikiPageDocs = pgTable("wiki_page_docs", {
  pageId: text("page_id")
    .primaryKey()
    .references(() => knowledgePages.id, { onDelete: "cascade" }),
  state: text("state").notNull(),
  parentVersion: integer("parent_version").notNull(),
  dirty: boolean("dirty").notNull().default(false),
  /** Who edited the draft since the last version (they become authors of the published version). */
  editors: jsonb("editors").$type<Actor[]>().notNull().default([]),
  /** Last edit to the draft (auto-publish waits for 5 minutes of quiet). */
  editedAt: ts("edited_at"),
  updatedAt: updatedAt(),
});

/** Attachments of an imported vault: vault path → file (to resolve ![[x.png]]). */
export const wikiAttachments = pgTable(
  "wiki_attachments",
  {
    workspaceId: workspace(),
    /** Path in the vault, as imported (`attachments/diagram.png`). */
    path: text("path").notNull(),
    /** Lowercased path: the lookup key. */
    pathKey: text("path_key").notNull(),
    fileId: text("file_id")
      .notNull()
      .references(() => files.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.pathKey] })],
);

/**
 * A page's annotations: a comment anchored on a passage (replies in `parentId`) and a proposal, whose
 * changes are accepted or rejected one by one. A comment may ask an agent to act on it (`agentId`,
 * with the request's message in `messageId`).
 */
export const pageAnnotations = pgTable(
  "page_annotations",
  {
    id: text("id").primaryKey(),
    workspaceId: workspace(),
    pageId: text("page_id")
      .notNull()
      .references(() => knowledgePages.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["comment", "proposal"] }).notNull(),
    /** A reply: the comment it answers (comments only). */
    parentId: text("parent_id"),
    author: jsonb("author").$type<Actor & { actingFor?: string }>().notNull(),
    /** A comment: its text. A proposal: the agent's note. */
    body: text("body").notNull().default(""),
    anchor: jsonb("anchor").$type<WikiAnchor>(),
    hunks: jsonb("hunks").$type<WikiHunk[]>().notNull().default([]),
    /** The page version the proposal's changes were checked against (the latest when it was made). */
    parentVersion: integer("parent_version"),
    /** A comment: `open` or `resolved`. A proposal: `pending` until no change is pending, then `done`. */
    status: text("status", { enum: ["open", "resolved", "pending", "done"] }).notNull(),
    /** "Act on this comment": the agent asked and the request's message. */
    agentId: text("agent_id"),
    messageId: text("message_id"),
    /** Who resolved the thread or decided the proposal's last change, and when. */
    handledBy: jsonb("handled_by").$type<Actor>(),
    handledAt: ts("handled_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("page_annotations_page_idx").on(t.pageId, t.createdAt)],
);

/**
 * What happened in the wiki, in order. Reading joins it with the page and hides what the reader doesn't
 * read; a page deleted for good leaves its rows without `pageId` (and out of every reading).
 */
export const wikiChangeLog = pgTable(
  "wiki_change_log",
  {
    id: text("id").primaryKey(),
    workspaceId: workspace(),
    pageId: text("page_id").references(() => knowledgePages.id, { onDelete: "set null" }),
    action: text("action", {
      enum: ["create", "update", "rename", "move", "trash", "restore", "proposal", "comment"],
    }).notNull(),
    title: text("title").notNull(),
    author: jsonb("author").$type<Actor & { actingFor?: string }>().notNull(),
    /** The saved version (update), the old title (rename), the new folder (move). */
    detail: text("detail"),
    at: ts("at").notNull().defaultNow(),
  },
  (t) => [index("wiki_change_log_workspace_at_idx").on(t.workspaceId, t.at)],
);

/**
 * The workspace's last wiki check: the contradictions a model found between linked pages (orphans and
 * broken links are computed when read, for the reader). `checked` holds the pairs already asked.
 */
export const wikiChecks = pgTable("wiki_checks", {
  workspaceId: text("workspace_id")
    .primaryKey()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  findings: jsonb("findings").$type<unknown[]>().notNull().default([]),
  /** Pairs of pages the model already checked (key = ids and versions): never paid twice. */
  checked: jsonb("checked").$type<Record<string, string>>().notNull().default({}),
  testModel: boolean("test_model").notNull().default(false),
  ranAt: ts("ran_at").notNull(),
});

/** Reads per reader (agent or person): how many and when the last one was. */
export const wikiPageViews = pgTable(
  "wiki_page_views",
  {
    pageId: text("page_id")
      .notNull()
      .references(() => knowledgePages.id, { onDelete: "cascade" }),
    readerType: text("reader_type", { enum: ["person", "agent"] }).notNull(),
    readerId: text("reader_id").notNull(),
    count: integer("count").notNull().default(0),
    lastAt: ts("last_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.pageId, t.readerType, t.readerId] })],
);

// ---- Debates ----

export const debates = pgTable(
  "debates",
  {
    id: text("id").primaryKey(),
    workspaceId: workspace(),
    title: text("title").notNull(),
    goal: text("goal").notNull(),
    status: text("status", { enum: ["open", "stalled", "done", "canceled"] })
      .notNull()
      .default("open"),
    phase: text("phase", { enum: ["debating", "human_turn", "concluding"] }),
    round: integer("round").notNull().default(1),
    roundLimit: integer("round_limit").notNull().default(3),
    format: text("format", { enum: ["decision", "plan"] })
      .notNull()
      .default("decision"),
    deadline: ts("deadline"),
    createdBy: jsonb("created_by").$type<Actor>().notNull(),
    requesterUserId: text("requester_user_id"),
    leadUserId: text("lead_user_id"),
    agentIds: jsonb("agent_ids").$type<string[]>().notNull().default([]),
    userIds: jsonb("user_ids").$type<string[]>().notNull().default([]),
    /**
     * Speaking order in each round: agents and the people who took a speaker slot (the rest only comment).
     */
    speakers: jsonb("speakers").$type<Actor[]>().notNull().default([]),
    leadAgentId: text("lead_agent_id"),
    /** Who still speaks in this round, in order. */
    pendingSpeakers: jsonb("pending_speakers").$type<Actor[]>().notNull().default([]),
    /** `synthesis`: the lead stalled writing the synthesis (absent: an agent's turn in a round). */
    stallInfo: jsonb("stall_info").$type<{
      agentId: string;
      round: number;
      reason: string;
      synthesis?: true;
    }>(),
    channelId: text("channel_id"),
    origin: jsonb("origin").$type<Record<string, unknown>>(),
    synthesis: jsonb("synthesis").$type<Record<string, unknown>>(),
    issueIds: jsonb("issue_ids").$type<string[]>().notNull().default([]),
    /** Answer options (empty = free answer); the majority is grouped by option. */
    options: jsonb("options").$type<string[]>().notNull().default([]),
    /** Each agent's pseudonym (A, B...), drawn on open; identities show only when the debate closes. */
    pseudonyms: jsonb("pseudonyms").$type<Record<string, string>>().notNull().default({}),
    /**
     * Debate cap: % of the monthly budget of the cheapest agent at the table, and the USD amount at
     * opening.
     */
    spendCapPercent: doublePrecision("spend_cap_percent"),
    spendCapUsd: doublePrecision("spend_cap_usd"),
    /** Why the debate ended (unanimous, no_change, max_rounds, budget, deadline, concluded). */
    endReason: text("end_reason"),
    /** Verdict accepted or reverted by the moderator. */
    verdictState: jsonb("verdict_state").$type<{
      state: "accepted" | "reverted";
      acceptedAt: string;
      endorsedBy: string;
      revertedAt?: string;
      revertedBy?: string;
    }>(),
    /** Blind reads: synthesis against a single agent's answer, in an order drawn per person. */
    blindReviews: jsonb("blind_reviews")
      .$type<
        { userId: string; debateFirst: boolean; pick: "debate" | "single" | "tie" | null; at: string }[]
      >()
      .notNull()
      .default([]),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("debates_workspace_idx").on(t.workspaceId, t.updatedAt)],
);

export const debatePosts = pgTable(
  "debate_posts",
  {
    id: text("id").primaryKey(),
    debateId: text("debate_id")
      .notNull()
      .references(() => debates.id, { onDelete: "cascade" }),
    author: jsonb("author").$type<Actor>().notNull(),
    kind: text("kind", {
      enum: ["turn", "free", "speaker", "comment", "synthesis", "out_of_budget"],
    }).notNull(),
    round: integer("round").notNull(),
    body: text("body").notNull(),
    /** Claim of the turn (answer, key, confidence, reason, evidence, whether it changed). */
    claimData: jsonb("claim_data").$type<DebateClaim>(),
    /** Turn of the round in progress: nobody reads it until the round closes (blind, parallel rounds). */
    hiddenUntilRoundEnd: boolean("hidden_until_round_end").notNull().default(false),
    replyTo: text("reply_to"),
    wantsExtraRound: boolean("wants_extra_round").notNull().default(false),
    runId: text("run_id"),
    meta: jsonb("meta").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index("debate_posts_topic_idx").on(t.debateId, t.createdAt)],
);
