// Search: all searchable content becomes chunks scoped to who may read them. Permission is
// computed at query time (channels the reader can read now), so a channel made private disappears at once.
// The vector column (`embedding halfvec(1024)`) is not declared here: it is added at boot, only when Postgres
// has pgvector. Without it, search is lexical and by name only.
import { sql } from "drizzle-orm";
import { bigserial, customType, index, integer, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { ts } from "./columns";

const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" });

export const searchChunks = pgTable(
  "search_chunks",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    /** No FK: the index is derived, and the workspace's rows go away with the workspace purge. */
    workspaceId: text("workspace_id").notNull(),
    sourceKind: text("source_kind").notNull(),
    sourceId: text("source_id").notNull(),
    ordinal: integer("ordinal").notNull(),
    title: text("title").notNull(),
    /** Folded title (no accents, lowercase): `pg_trgm` finds names with typos. */
    titleFold: text("title_fold").notNull(),
    text: text("text").notNull(),
    /** portuguese (stemmed) + simple (exact word), from the folded title (weight A) and text. */
    tsv: tsvector("tsv").notNull(),
    url: text("url").notNull(),
    /**
     * Scope: `org`, `channel` (with `channel_id`; `principals` also read from outside) or `private`
     * (`principals` only).
     */
    scopeKind: text("scope_kind", { enum: ["workspace", "channel", "private"] }).notNull(),
    channelId: text("channel_id"),
    principals: text("principals").array().notNull().default(sql`'{}'::text[]`),
    /** `user:<id>` or `agent:<id>`. */
    authorId: text("author_id"),
    page: integer("page"),
    has: text("has").array().notNull().default(sql`'{}'::text[]`),
    isFacets: text("is_facets").array().notNull().default(sql`'{}'::text[]`),
    mentions: text("mentions").array().notNull().default(sql`'{}'::text[]`),
    /** Where the outside text came from (email, webhook); null = written in the workspace. */
    untrusted: text("untrusted"),
    createdAt: ts("created_at").notNull(),
    updatedAt: ts("updated_at").notNull(),
    /**
     * Vector queue: `none` (never sent out: private, DM, private channel), `pending`, `working`, `done`.
     * The text hash avoids storing a vector for text that has since changed.
     */
    embedState: text("embed_state", { enum: ["none", "pending", "working", "done"] })
      .notNull()
      .default("none"),
    embedClaimedAt: ts("embed_claimed_at"),
    textHash: text("text_hash").notNull(),
  },
  (t) => [
    uniqueIndex("search_chunks_source_uq").on(t.sourceKind, t.sourceId, t.ordinal),
    index("search_chunks_workspace_idx").on(t.workspaceId, t.createdAt),
    index("search_chunks_tsv_idx").using("gin", t.tsv),
    index("search_chunks_title_trgm_idx").using("gin", sql`${t.titleFold} gin_trgm_ops`),
    index("search_chunks_channel_idx").on(t.channelId),
    index("search_chunks_embed_idx").on(t.embedState).where(sql`embed_state in ('pending', 'working')`),
  ],
);
