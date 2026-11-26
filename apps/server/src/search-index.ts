// Search on the server: the index in Postgres, the access read from the database and what becomes a chunk.
//
// Each source is reindexed by reading its state from the database (`reindex`), in a transaction that locks
// the source's row (`FOR SHARE`). Whoever hides the source (retracting a message, the trash, deleting a
// page) takes the chunks out in the same transaction as the write (`unindex`). So no execution order
// leaves retracted text in the search: a backfill that read before waits for the lock and reads again.
import type { ActorRef } from "@vanr/contract";
import { type Db, schema } from "@vanr/engine/db";
import { type Embedder, fakeEmbedder, voyageEmbedder } from "@vanr/engine/embeddings";
import type { ChunkInput, SearchFilters, SourceKind, SourceRef } from "@vanr/engine/search";
import { PgSearchIndex, type SearchAccess } from "@vanr/engine/search-pg";
import {
  chunkText,
  type HasFacet,
  type IsFacet,
  type ParsedQuery,
  type TextPart,
  textFacets,
} from "@vanr/engine/search-query";
import { fold } from "@vanr/engine/text";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { type Names, namesOf, type RowRow, rowChunks, type TableRow } from "./bases/core";
import type { Config } from "./config";
import type { AppDeps } from "./context";
import { contentOf } from "./drive";
import { log } from "./logger";
import { wikiChunks } from "./wiki-search";

const {
  channels,
  channelMemberships,
  members,
  agents,
  messages,
  knowledgePages,
  files,
  fileVersions,
  issues,
  debates,
  debatePosts,
  dbRows,
  dbTables,
  searchChunks,
} = schema;

/**
 * The sources the server indexes. Each one's producer comes in with its area: files with the Drive (here),
 * messages with the chat (S6), wiki pages with the wiki (S4), issues (S4), debates (S3) and the rows of the
 * bases (bases/write.ts).
 */
export type IndexedKind = Extract<SourceKind, "message" | "wiki" | "file" | "issue" | "debate" | "db_row">;

export const actorKey = (a: ActorRef | { type: "person" | "agent"; id: string }) =>
  `${a.type === "person" ? "user" : "agent"}:${a.id}`;

/** The access in the database: the same as `readableChannelsSql` (person) and the agent's channels, without archived ones. */
export function dbAccess(db: Db): SearchAccess {
  return {
    async readable(workspaceId, principal) {
      const [type, id] = principal.split(":") as [string, string];
      if (type === "user") {
        const [m] = await db
          .select({ id: members.userId })
          .from(members)
          .where(and(eq(members.workspaceId, workspaceId), eq(members.userId, id)));
        if (!m) return null;
        const rows = await db.execute(sql`
          select c.id from ${channels} c
          where c.workspace_id = ${workspaceId}
            and ((c.kind = 'channel' and c.visibility = 'public')
              or exists (select 1 from ${channelMemberships} cm
                where cm.channel_id = c.id and cm.member_type = 'person' and cm.member_id = ${id}))`);
        return rowsOf(rows).map((r) => String(r.id));
      }
      if (type === "agent") {
        const [a] = await db
          .select({ id: agents.id })
          .from(agents)
          .where(and(eq(agents.workspaceId, workspaceId), eq(agents.id, id)));
        if (!a) return null;
        // An agent: only where it is a member, and an archived channel is left out.
        const rows = await db.execute(sql`
          select c.id from ${channels} c join ${channelMemberships} cm on cm.channel_id = c.id
          where c.workspace_id = ${workspaceId} and c.archived_at is null
            and cm.member_type = 'agent' and cm.member_id = ${id}`);
        return rowsOf(rows).map((r) => String(r.id));
      }
      return null;
    },
    async isPublicChannel(channelId) {
      const [c] = await db
        .select({ kind: channels.kind, visibility: channels.visibility })
        .from(channels)
        .where(eq(channels.id, channelId));
      return c?.kind === "channel" && c.visibility === "public";
    },
  };
}

// biome-ignore lint/suspicious/noExplicitAny: a raw row of db.execute
function rowsOf(result: unknown): Record<string, any>[] {
  if (Array.isArray(result)) return result;
  return (result as { rows?: Record<string, unknown>[] }).rows ?? [];
}

/** The embedder from the configuration: Voyage with a key, the fake one only when asked for (tests, dev). */
export function embedderFor(config: Config, fetchImpl?: typeof fetch): Embedder | null {
  const e = config.search.embedder;
  if (e.kind === "voyage") return voyageEmbedder({ apiKey: e.apiKey, fetch: fetchImpl });
  if (e.kind === "fake") return fakeEmbedder();
  return null;
}

/** Transaction copies keep pgvector state and read permissions on that same connection. */
class ServerSearchIndex extends PgSearchIndex {
  constructor(
    db: Db,
    private readonly options: ConstructorParameters<typeof PgSearchIndex>[1],
  ) {
    super(db, options);
  }

  override withDb(db: Db): PgSearchIndex {
    const state = super.withDb(db);
    const index = new PgSearchIndex(db, { ...this.options, access: dbAccess(db) });
    index.ensureVector = () => state.ensureVector();
    return index;
  }
}

/** The server's index. Embeddings go into the ledger as `search`, paid by the platform. */
export function createSearchIndex(
  deps: Pick<AppDeps, "db" | "config" | "ledger" | "now">,
  fetchImpl?: typeof fetch,
) {
  return new ServerSearchIndex(deps.db, {
    access: dbAccess(deps.db),
    embedder: embedderFor(deps.config, fetchImpl),
    now: deps.now,
    onEmbed: async (e) => {
      await deps.ledger.record(
        {
          workspaceId: e.workspaceId,
          agentId: null,
          userId: null,
          runId: null,
          source: "search",
          model: e.model,
          usage: { inputTokens: e.tokens, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
          at: deps.now(),
        },
        [],
      );
    },
  });
}

/** Handle -> `user:<id>`/`agent:<id>` in the workspace (people and agents share the handle space). */
async function principalsByHandle(db: Db, workspaceId: string, handles: string[]): Promise<string[]> {
  if (!handles.length) return [];
  const people = await db
    .select({ id: members.userId, handle: members.handle })
    .from(members)
    .where(eq(members.workspaceId, workspaceId));
  const bots = await db
    .select({ id: agents.id, handle: agents.handle })
    .from(agents)
    .where(and(eq(agents.workspaceId, workspaceId), isNull(agents.archivedAt)));
  const out: string[] = [];
  for (const h of handles) {
    for (const p of people) if (fold(p.handle) === h) out.push(`user:${p.id}`);
    for (const a of bots) if (fold(a.handle) === h) out.push(`agent:${a.id}`);
  }
  return out;
}

/** With nobody (or no channel) by that name, the filter can't turn into "no filter". */
const NOBODY = "none:";

/**
 * Operators to filters with ids, for whoever searches (`self`: `user:<id>` or `agent:<id>`). `in:` takes a
 * channel name or an `@handle` (the DM with the person or the agent). The permission stays in the index:
 * an `in:` for a channel the searcher doesn't read opens nothing.
 */
export async function resolveFilters(
  db: Db,
  workspaceId: string,
  self: string,
  q: ParsedQuery,
): Promise<SearchFilters> {
  const f: {
    authors?: string[];
    channelIds?: string[];
    has?: ParsedQuery["has"];
    is?: ParsedQuery["is"];
    before?: string;
    after?: string;
    mentions?: string[];
  } = {};
  if (q.from.length) {
    const ids = await principalsByHandle(
      db,
      workspaceId,
      q.from.filter((h) => h !== "me"),
    );
    if (q.from.includes("me")) ids.push(self);
    f.authors = ids.length ? ids : [NOBODY];
  }
  // `is:mine` is "written by me" and adds to `from:` as an AND (by Beto and mine at once = nothing).
  if (q.is.includes("mine")) f.authors = !f.authors ? [self] : f.authors.includes(self) ? [self] : [NOBODY];
  const is = q.is.filter((x) => x !== "mine");
  if (is.length) f.is = is;
  if (q.has.length) f.has = q.has;
  if (q.before) f.before = q.before;
  if (q.after) f.after = q.after;
  if (q.mentions.length) {
    const ids = await principalsByHandle(db, workspaceId, q.mentions);
    f.mentions = ids.length ? ids : [NOBODY];
  }
  if (q.in.length) {
    const ids: string[] = [];
    const named = q.in.filter((x) => !x.startsWith("@"));
    if (named.length) {
      const rows = await db
        .select({ id: channels.id, name: channels.name })
        .from(channels)
        .where(and(eq(channels.workspaceId, workspaceId), eq(channels.kind, "channel")));
      for (const r of rows) if (named.includes(fold(r.name))) ids.push(r.id);
    }
    const [selfType, selfId] = self.split(":") as [string, string];
    for (const p of await principalsByHandle(
      db,
      workspaceId,
      q.in.filter((x) => x.startsWith("@")).map((x) => x.slice(1)),
    )) {
      const [type, id] = p.split(":") as [string, string];
      // The DM between the searcher and the handle: both are members.
      const rows = rowsOf(
        await db.execute(sql`
          select c.id from ${channels} c
          where c.workspace_id = ${workspaceId} and c.kind = 'dm'
            and exists (select 1 from ${channelMemberships} a where a.channel_id = c.id
              and a.member_type = ${type === "user" ? "person" : "agent"} and a.member_id = ${id})
            and exists (select 1 from ${channelMemberships} b where b.channel_id = c.id
              and b.member_type = ${selfType === "user" ? "person" : "agent"} and b.member_id = ${selfId})`),
      );
      for (const r of rows) ids.push(String(r.id));
    }
    f.channelIds = ids.length ? ids : [NOBODY];
  }
  return f;
}

// ---- What becomes a chunk ----

function chunksOf(
  base: Omit<ChunkInput, "ordinal" | "text" | "page">,
  parts: readonly TextPart[],
): ChunkInput[] {
  const pieces = chunkText(parts.filter((p) => p.text.trim()));
  // A source without text (a binary file, an empty page) is still found by its title.
  if (!pieces.length) return [{ ...base, ordinal: 0, text: "" }];
  return pieces.map((p, i) => ({ ...base, ordinal: i, text: p.text, ...(p.page ? { page: p.page } : {}) }));
}

const unique = <T>(xs: T[]) => [...new Set(xs)];

/** A file's search text: the structured content, the file's text or the extracted pages. */
export function fileParts(version: typeof fileVersions.$inferSelect): TextPart[] {
  const content = contentOf(version);
  switch (content.kind) {
    case "document":
      return [{ text: content.markdown }];
    case "table":
      return [{ text: [content.columns.join(" | "), ...content.rows.map((r) => r.join(" | "))].join("\n") }];
    case "diff":
      return [{ text: content.files.map((f) => `${f.path}\n${f.patch}`).join("\n\n") }];
    case "diagram":
      return [{ text: content.mermaid }];
    case "html":
      return [
        {
          text: content.html
            .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ")
            .replace(/<[^>]+>/g, " "),
        },
      ];
    case "file": {
      const pages = version.pages;
      if (pages?.length) return pages.map((p) => ({ text: p.markdown, page: p.page }));
      return content.text ? [{ text: content.text }] : [];
    }
  }
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Reads the locked source and returns its chunks (empty: it leaves the search). */
async function build(tx: Tx, ref: { kind: IndexedKind; id: string }): Promise<ChunkInput[]> {
  switch (ref.kind) {
    case "message": {
      const [m] = await tx.select().from(messages).where(eq(messages.id, ref.id)).for("share");
      if (!m) return [];
      const meta = m.meta as { retracted?: unknown; files?: { title?: string }[]; untrusted?: unknown };
      if (meta.retracted) return [];
      const [ch] = await tx.select().from(channels).where(eq(channels.id, m.channelId));
      if (!ch) return [];
      const attached = (meta.files ?? []).map((a) => a.title ?? "").filter(Boolean);
      const text = [m.body, ...attached].join("\n");
      if (!text.trim()) return [];
      const mentions = [
        ...m.mentionedUserIds.map((id) => `user:${id}`),
        ...m.agentMentionIds.map((id) => `agent:${id}`),
      ];
      const has: HasFacet[] = unique([
        ...textFacets(m.body),
        ...(attached.length ? (["file"] as const) : []),
      ]);
      const is: IsFacet[] = [];
      if (m.threadId) is.push("thread");
      if (ch.kind === "dm") is.push("dm");
      if (m.authorKind === "agent") is.push("agent");
      const created = m.createdAt.toISOString();
      return chunksOf(
        {
          workspaceId: m.workspaceId,
          title: ch.kind === "dm" ? "DM" : `#${ch.name}`,
          scope: { kind: "channel", channelId: ch.id },
          url: m.threadId
            ? `/workspace/${m.workspaceId}/threads/${m.threadId}`
            : `/workspace/${m.workspaceId}/c/${ch.id}`,
          authorId: actorKey({ type: m.authorKind, id: m.authorId }),
          updatedAt: created,
          createdAt: created,
          facets: { has, is, mentions: unique(mentions) },
          ...(typeof meta.untrusted === "string" && meta.untrusted ? { untrusted: meta.untrusted } : {}),
        },
        [{ text }],
      );
    }
    case "wiki": {
      const [page] = await tx.select().from(knowledgePages).where(eq(knowledgePages.id, ref.id)).for("share");
      // A page in the trash stays out of the search (whoever trashes it takes it out in the same commit;
      // here the reindex doesn't bring it back).
      if (!page || page.deletedAt) return [];
      const base: Omit<ChunkInput, "ordinal" | "text"> = {
        workspaceId: page.workspaceId,
        title: page.title,
        scope: { kind: "workspace" },
        url: `/workspace/${page.workspaceId}/wiki/${page.slug}`,
        authorId: actorKey(page.updatedBy),
        updatedAt: page.updatedAt.toISOString(),
        createdAt: page.createdAt.toISOString(),
        facets: { has: textFacets(page.body), is: page.pinned ? ["pinned"] : [] },
      };
      // Chunks per section, without splitting a code block (wiki-search.ts).
      return wikiChunks(page).map((c) => ({ ...base, ordinal: c.ordinal, text: c.text }));
    }
    case "file": {
      const [row] = await tx.select().from(files).where(eq(files.id, ref.id)).for("share");
      if (!row || row.deletedAt) return [];
      const [v] = await tx
        .select()
        .from(fileVersions)
        .where(and(eq(fileVersions.fileId, row.id), eq(fileVersions.version, row.version)));
      if (!v) return [];
      const parts = fileParts(v);
      const has: HasFacet[] = [];
      if (row.kind === "file") has.push("file");
      if (v.contentType?.startsWith("image/")) has.push("image");
      for (const p of parts) has.push(...textFacets(p.text));
      return chunksOf(
        {
          workspaceId: row.workspaceId,
          title: row.title,
          scope: row.channelId ? { kind: "channel", channelId: row.channelId } : { kind: "workspace" },
          url: `/workspace/${row.workspaceId}/drive?file=${row.id}`,
          authorId: actorKey(row.createdBy),
          updatedAt: row.updatedAt.toISOString(),
          createdAt: row.createdAt.toISOString(),
          facets: { has: unique(has), is: row.createdBy.type === "agent" ? ["agent"] : [] },
        },
        parts,
      );
    }
    case "issue": {
      const [row] = await tx.select().from(issues).where(eq(issues.id, ref.id)).for("share");
      if (!row) return [];
      const text = [row.description, ...row.criteria.map((c) => `- ${c.text}`)].join("\n");
      return chunksOf(
        {
          workspaceId: row.workspaceId,
          title: `#${row.number} ${row.title}`,
          // Issues belong to the whole workspace today (the list and the screen don't look at the channel).
          scope: { kind: "workspace" },
          url: `/workspace/${row.workspaceId}/issues/${row.number}`,
          authorId: actorKey(row.createdBy),
          updatedAt: row.updatedAt.toISOString(),
          createdAt: row.createdAt.toISOString(),
          facets: { has: textFacets(text), is: row.createdBy.type === "agent" ? ["agent"] : [] },
        },
        [{ text }],
      );
    }
    case "debate": {
      const [row] = await tx.select().from(debates).where(eq(debates.id, ref.id)).for("share");
      if (!row) return [];
      const posts = await tx
        .select({ body: debatePosts.body })
        .from(debatePosts)
        // A turn hidden until the round ends (a blind round) only goes in when it opens: before that, not
        // even the search shows it.
        .where(and(eq(debatePosts.debateId, row.id), eq(debatePosts.hiddenUntilRoundEnd, false)))
        .orderBy(debatePosts.createdAt);
      const synthesis = row.synthesis ? JSON.stringify(row.synthesis) : "";
      const text = [row.goal, synthesis, ...posts.map((p) => p.body)].filter(Boolean).join("\n\n");
      // The same rule as the debate's visibility: without a channel, the workspace; with a channel, whoever
      // reads it and whoever takes part (asks, leads, opened it, was called; the agents at the table).
      const also = unique([
        ...[
          row.requesterUserId,
          row.leadUserId,
          row.createdBy.type === "person" ? row.createdBy.id : null,
          ...row.userIds,
        ]
          .filter((x): x is string => !!x)
          .map((id) => `user:${id}`),
        ...row.agentIds.map((id) => `agent:${id}`),
      ]);
      return chunksOf(
        {
          workspaceId: row.workspaceId,
          title: row.title,
          scope: row.channelId ? { kind: "channel", channelId: row.channelId, also } : { kind: "workspace" },
          url: `/workspace/${row.workspaceId}/debates/${row.id}`,
          authorId: actorKey(row.createdBy),
          updatedAt: row.updatedAt.toISOString(),
          createdAt: row.createdAt.toISOString(),
          facets: { has: textFacets(text) },
          ...(typeof row.origin?.untrusted === "string" && row.origin.untrusted
            ? { untrusted: row.origin.untrusted }
            : {}),
        },
        [{ text }],
      );
    }
    case "db_row": {
      const [row] = await tx.select().from(dbRows).where(eq(dbRows.id, ref.id)).for("share");
      return row ? baseRowChunks(tx, row, new Map(), new Map()) : [];
    }
  }
}

/**
 * Reindexes the source from the database (idempotent: calling it twice gives the same). An error in the index
 * doesn't bring down whoever saved: it stays in the log and the boot's backfill completes what was missing.
 */
export async function reindex(deps: Pick<AppDeps, "db" | "search">, ref: { kind: IndexedKind; id: string }) {
  try {
    await deps.db.transaction(async (tx) => {
      const chunks = await build(tx, ref);
      await deps.search.withDb(tx).upsert(ref, chunks);
    });
  } catch (err) {
    log.error("search.reindex_failed", { kind: ref.kind, id: ref.id, err });
  }
}

/** A base row's chunks; the source and the workspace's names are read once per batch. */
async function baseRowChunks(
  tx: Tx,
  row: RowRow,
  tables: Map<string, TableRow | null>,
  names: Map<string, Names>,
): Promise<ChunkInput[]> {
  if (!tables.has(row.tableId)) {
    const [table] = await tx.select().from(dbTables).where(eq(dbTables.id, row.tableId));
    tables.set(row.tableId, table ?? null);
  }
  const table = tables.get(row.tableId);
  if (!table) return [];
  let n = names.get(row.workspaceId);
  if (!n) {
    n = await namesOf(tx, row.workspaceId);
    names.set(row.workspaceId, n);
  }
  return rowChunks(table, row, n);
}

const ROW_BATCH = 200;

/**
 * Reindexes many rows of the bases (an import, a recalculation) the way `reindex` does one source: the rows
 * locked and read back in the transaction that writes their chunks, one transaction per batch.
 */
export async function reindexRows(deps: Pick<AppDeps, "db" | "search">, rowIds: readonly string[]) {
  for (let i = 0; i < rowIds.length; i += ROW_BATCH) {
    const ids = rowIds.slice(i, i + ROW_BATCH);
    try {
      await deps.db.transaction(async (tx) => {
        const rows = await tx.select().from(dbRows).where(inArray(dbRows.id, ids)).for("share");
        const byId = new Map(rows.map((r) => [r.id, r]));
        const tables = new Map<string, TableRow | null>();
        const names = new Map<string, Names>();
        const index = deps.search.withDb(tx);
        for (const id of ids) {
          const row = byId.get(id);
          await index.upsert({ kind: "db_row", id }, row ? await baseRowChunks(tx, row, tables, names) : []);
        }
      });
    } catch (err) {
      log.error("search.reindex_failed", { kind: "db_row", id: ids[0], count: ids.length, err });
    }
  }
}

/** Takes many sources of one kind out of the search, inside the transaction that deletes them. */
export async function unindexMany(tx: Db | Tx, kind: IndexedKind, ids: readonly string[]) {
  for (let i = 0; i < ids.length; i += 5_000) {
    await tx
      .delete(searchChunks)
      .where(and(eq(searchChunks.sourceKind, kind), inArray(searchChunks.sourceId, ids.slice(i, i + 5_000))));
  }
}

/** Takes the source out of the search inside the transaction of whoever hides or deletes it (same commit). */
export async function unindex(tx: Db, deps: Pick<AppDeps, "search">, ref: SourceRef) {
  await deps.search.withDb(tx).remove(ref);
}

/**
 * Replays live files, including stale chunks left by failed version or extraction indexing, and recovers
 * missing base rows.
 */
export async function backfillSearch(deps: Pick<AppDeps, "db" | "search">, batch = 500): Promise<number> {
  let after = "";
  let n = 0;
  for (;;) {
    const rows = await deps.db
      .select({ id: files.id })
      .from(files)
      .where(and(isNull(files.deletedAt), sql`${files.id} > ${after}`))
      .orderBy(files.id)
      .limit(batch);
    if (!rows.length) break;
    for (const { id } of rows) {
      await reindex(deps, { kind: "file", id });
      after = id;
      n++;
    }
  }
  const query = sql`select t.id from db_rows t
    where not exists (select 1 from search_chunks c where c.source_kind = 'db_row' and c.source_id = t.id)
    limit ${batch}`;
  // A row that makes no chunk comes back as "missing": seen once, it stops.
  const seen = new Set<string>();
  for (;;) {
    const ids = rowsOf(await deps.db.execute(query))
      .map((r) => String(r.id))
      .filter((id) => !seen.has(id));
    if (!ids.length) break;
    for (const id of ids) {
      seen.add(id);
      await reindex(deps, { kind: "db_row", id });
    }
    n += ids.length;
  }
  return n;
}

/** Tick: the vector queue. */
export async function searchTick(deps: Pick<AppDeps, "search">): Promise<number> {
  try {
    return await deps.search.embedPending();
  } catch (err) {
    log.error("search.embed_failed", { err });
    return 0;
  }
}
