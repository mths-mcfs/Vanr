// Search on Postgres: `search_chunks` with FTS (portuguese + simple), pg_trgm on the title and, when the
// database has pgvector, a halfvec(1024) vector with HNSW. All three legs carry the permission in the
// WHERE (the channels the viewer reads right now, computed in the query) and only then are fused by RRF.
// Passes search-contract.ts on PGlite (no vector) and on a real Postgres (with vector).
import { createHash } from "node:crypto";
import { type SQL, sql } from "drizzle-orm";
import type { Db } from "./db";
import { EMBED_DIMS, type Embedder } from "./embeddings";
import type {
  AccessWorld,
  ChunkInput,
  SearchFilters,
  SearchHit,
  SearchIndex,
  SearchOptions,
  SourceKind,
  SourceRef,
  Viewer,
} from "./search";
import { parseText, snippetFor, type TextQuery, words } from "./search-query";
import { fold } from "./text";

/** What the permission needs to know about the world, asked at query time. */
export interface SearchAccess {
  /**
   * Channels the principal (`user:<id>` or `agent:<id>`) reads right now in the workspace. A person:
   * the public ones and the ones they belong to (private channels and DMs). An agent: only the ones it
   * belongs to. `null`: not in the workspace.
   */
  readable(workspaceId: string, principal: string): Promise<readonly string[] | null>;
  /** Public channel right now: only workspace and public channel chunks go to the vector (an outside service). */
  isPublicChannel(channelId: string): Promise<boolean>;
}

/** The contract test's world as a `SearchAccess` (the same one the `canRead` oracle reads). */
export function worldAccess(world: AccessWorld): SearchAccess {
  return {
    async readable(_workspaceId, principal) {
      const isAgent = principal.startsWith("agent:");
      if (!isAgent && !world.workspaceMembers.has(principal)) return null;
      const out: string[] = [];
      for (const [channelId, members] of world.members) {
        if (members.has(principal) || (!isAgent && world.publicChannels.has(channelId))) out.push(channelId);
      }
      return out;
    },
    async isPublicChannel(channelId) {
      return world.publicChannels.has(channelId);
    },
  };
}

interface PgSearchOptions {
  access: SearchAccess;
  embedder?: Embedder | null;
  /** Called with the tokens of every embedder call (the server records them in the ledger). */
  onEmbed?: (e: {
    workspaceId: string;
    model: string;
    tokens: number;
    kind: "document" | "query";
  }) => Promise<void> | void;
  now?: () => Date;
}

/** Candidates per leg before the fusion. */
const LEG_LIMIT = 150;
/** RRF constant (Cormack et al.): 60 is the usual value in the literature. */
const RRF_K = 60;
/** Vector work stuck for longer than this goes back to the queue (a process that died). */
const EMBED_STALE_MS = 10 * 60_000;

// biome-ignore lint/suspicious/noExplicitAny: the row shape is the one of the SELECT right below
type Row = Record<string, any>;

/** postgres-js returns the list; PGlite, `{ rows }`. */
function rowsOf(result: unknown): Row[] {
  if (Array.isArray(result)) return result as Row[];
  return ((result as { rows?: Row[] }).rows ?? []) as Row[];
}

/** A chunk's identity across reindexes: `search_chunks_source_uq`. */
const chunkKey = (r: Row) => `${r.source_kind}:${r.ordinal}:${r.source_id}`;

const hashText = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 32);

/** Postgres text cannot hold NUL: a stored value never has one, so text loses it before it is stored. */
const NUL = "\u0000";
const storable = (s: string) => s.replaceAll(NUL, "");

/**
 * A text[] literal. An element with NUL (a filter id typed in the query) cannot equal any stored value,
 * so it is left out instead of failing the whole statement.
 */
const textArray = (xs: readonly string[]) =>
  sql`${`{${xs
    .filter((x) => !x.includes(NUL))
    .map((x) => `"${x.replace(/(["\\])/g, "\\$1")}"`)
    .join(",")}}`}::text[]`;

const vectorLiteral = (v: readonly number[]) => `[${v.map((x) => (Number.isFinite(x) ? x : 0)).join(",")}]`;

/**
 * The query's tsquery: each word (stemmed or exact) and each phrase (exact), all of them (`all`) or any
 * (`any`, for a natural-language question), and no exclusion.
 */
function tsQuery(q: TextQuery, prefix: string | undefined, match: "all" | "any"): SQL | null {
  const parts: SQL[] = [];
  for (const t of q.terms)
    parts.push(sql`(plainto_tsquery('portuguese', ${t}) || plainto_tsquery('simple', ${t}))`);
  for (const p of q.phrases) parts.push(sql`phraseto_tsquery('simple', ${p})`);
  // The prefix is only letters and digits (parseText guarantees it): safe inside to_tsquery.
  if (prefix) parts.push(sql`to_tsquery('simple', ${`${prefix}:*`})`);
  if (!parts.length) return null;
  return sql`(${sql.join(parts, match === "any" ? sql` || ` : sql` && `)})`;
}

/** A/D hold one exact sequence; B/C hold stems and must not invent phrase adjacencies. */
const phraseMatch = (phrase: string) =>
  sql`(ts_filter(c.tsv, '{A,D}') @@ phraseto_tsquery('simple', ${phrase}))`;

/** Exclusions apply to every leg; quoted phrases keep stop words and exact positions. */
function excluded(q: TextQuery): SQL | null {
  if (!q.exclude.length) return null;
  return sql`(${sql.join(
    q.exclude.map((e) =>
      e.includes(" ")
        ? phraseMatch(e)
        : sql`(c.tsv @@ (plainto_tsquery('portuguese', ${e}) || plainto_tsquery('simple', ${e})))`,
    ),
    sql` or `,
  )})`;
}

export class PgSearchIndex implements SearchIndex {
  private vector: boolean | null = null;

  constructor(
    private readonly db: Db,
    private readonly opts: PgSearchOptions,
  ) {}

  /** The same index over another connection (the transaction of whoever saves or hides the source). */
  withDb(db: Db): PgSearchIndex {
    const other = new PgSearchIndex(db, this.opts);
    other.vector = this.vector;
    return other;
  }

  private now() {
    return this.opts.now?.() ?? new Date();
  }

  /**
   * Turns the vector on when the database ships pgvector: the column, the partial HNSW index and the
   * queue. Idempotent. A database without the extension is lexical only; any other failure is an error.
   */
  async ensureVector(): Promise<boolean> {
    if (this.vector !== null) return this.vector;
    const available = rowsOf(
      await this.db.execute(sql`select 1 from pg_available_extensions where name = 'vector'`),
    );
    if (!available.length) {
      this.vector = false;
      return false;
    }
    await this.db.execute(sql`create extension if not exists vector`);
    await this.db.execute(
      sql.raw(`alter table search_chunks add column if not exists embedding halfvec(${EMBED_DIMS})`),
    );
    await this.db.execute(
      sql.raw(
        "create index if not exists search_chunks_embedding_idx on search_chunks using hnsw (embedding halfvec_cosine_ops) where embedding is not null",
      ),
    );
    this.vector = true;
    return true;
  }

  /** The vector is on (a database with pgvector and an embedder). */
  async vectorOn(): Promise<boolean> {
    return !!this.opts.embedder && (await this.ensureVector());
  }

  private async eligible(c: ChunkInput): Promise<boolean> {
    if (!this.opts.embedder) return false;
    if (c.scope.kind === "workspace") return true;
    if (c.scope.kind === "channel") return this.opts.access.isPublicChannel(c.scope.channelId);
    return false;
  }

  async upsert(source: SourceRef, chunks: readonly ChunkInput[]): Promise<void> {
    const vector = await this.vectorOn();
    const prepared = await Promise.all(
      chunks.map(async (raw) => {
        const c = { ...raw, title: storable(raw.title), text: storable(raw.text) };
        return { c, hash: hashText(`${c.title}\n${c.text}`), embed: await this.eligible(c) };
      }),
    );
    await this.db.transaction(async (tx) => {
      // Coordinate complete replacements, even when the source has no rows yet.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`${source.kind}:${source.id}`}, 0))`,
      );
      // The vector of an unchanged chunk (same hash) stays: editing a page does not send it all again.
      const keep = new Map<string, string>();
      if (vector) {
        const old = rowsOf(
          await tx.execute(sql`
            select text_hash, embedding::text as embedding from search_chunks
            where source_kind = ${source.kind} and source_id = ${source.id} and embed_state = 'done'`),
        );
        for (const r of old) if (r.embedding) keep.set(r.text_hash, r.embedding);
      }
      await tx.execute(
        sql`delete from search_chunks where source_kind = ${source.kind} and source_id = ${source.id}`,
      );
      for (const { c, hash, embed } of prepared) {
        const titleFold = fold(c.title);
        const titleWords = words(c.title).join(" ");
        const textWords = words(c.text).join(" ");
        const kept = embed && vector ? keep.get(hash) : undefined;
        const state = !embed ? "none" : kept ? "done" : "pending";
        const created = new Date(c.createdAt ?? c.updatedAt);
        await tx.execute(sql`
          insert into search_chunks (workspace_id, source_kind, source_id, ordinal, title, title_fold, text, tsv, url,
            scope_kind, channel_id, principals, author_id, page, has, is_facets, mentions, untrusted, created_at, updated_at,
            embed_state, text_hash${vector ? sql`, embedding` : sql``})
          values (${c.workspaceId}, ${source.kind}, ${source.id}, ${c.ordinal}, ${c.title}, ${titleFold}, ${c.text},
            setweight(to_tsvector('simple', ${titleWords}), 'A') || to_tsvector('simple', ${textWords})
              || setweight(to_tsvector('portuguese', ${titleWords}), 'B') || setweight(to_tsvector('portuguese', ${textWords}), 'C'),
            ${c.url}, ${c.scope.kind}, ${c.scope.kind === "channel" ? c.scope.channelId : null},
            ${textArray(c.scope.kind === "private" ? c.scope.principals : c.scope.kind === "channel" ? (c.scope.also ?? []) : [])}, ${c.authorId ?? null}, ${c.page ?? null},
            ${textArray(c.facets?.has ?? [])}, ${textArray(c.facets?.is ?? [])}, ${textArray(c.facets?.mentions ?? [])},
            ${c.untrusted ?? null}, ${created.toISOString()}, ${new Date(c.updatedAt).toISOString()}, ${state}, ${hash}
            ${vector ? sql`, ${kept ?? null}::halfvec` : sql``})`);
      }
    });
  }

  async remove(source: SourceRef): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`${source.kind}:${source.id}`}, 0))`,
      );
      await tx.execute(
        sql`delete from search_chunks where source_kind = ${source.kind} and source_id = ${source.id}`,
      );
    });
  }

  /** Deletes everything of the workspace (workspace deleted). */
  async purgeWorkspace(workspaceId: string): Promise<void> {
    await this.db.execute(sql`delete from search_chunks where workspace_id = ${workspaceId}`);
  }

  /**
   * A channel changed visibility. The permission already lives in the query; this only changes the
   * vector: a channel that turns private loses its vectors at once (and leaves the queue), a channel
   * that turns public joins the queue.
   */
  async channelVisibility(channelId: string, isPublic: boolean): Promise<void> {
    if (isPublic) {
      if (!this.opts.embedder) return;
      await this.db.execute(sql`
        update search_chunks set embed_state = 'pending'
        where channel_id = ${channelId} and scope_kind = 'channel' and embed_state = 'none'`);
      return;
    }
    const vector = await this.ensureVector();
    await this.db.execute(sql`
      update search_chunks set embed_state = 'none'${vector ? sql`, embedding = null` : sql``}
      where channel_id = ${channelId} and scope_kind = 'channel'`);
  }

  /**
   * The vector queue (a tick): claims up to `batch` pending chunks with SKIP LOCKED (two instances never
   * claim the same one), calls the embedder and writes only if the text is still the same. Returns how
   * many it wrote.
   */
  async embedPending(batch = 64): Promise<number> {
    const embedder = this.opts.embedder;
    if (!embedder || !(await this.ensureVector())) return 0;
    const now = this.now();
    const stale = new Date(now.getTime() - EMBED_STALE_MS).toISOString();
    const picked = rowsOf(
      await this.db.execute(sql`
        update search_chunks set embed_state = 'working', embed_claimed_at = ${now.toISOString()}
        where id in (
          select id from search_chunks
          where embed_state = 'pending' or (embed_state = 'working' and embed_claimed_at < ${stale})
          order by id limit ${batch} for update skip locked)
        returning id, workspace_id, scope_kind, channel_id`),
    );
    if (!picked.length) return 0;
    // One call per workspace: the cost goes to the ledger of whoever owns the text.
    const byWorkspace = new Map<string, Row[]>();
    for (const r of picked) byWorkspace.set(r.workspace_id, [...(byWorkspace.get(r.workspace_id) ?? []), r]);
    let n = 0;
    for (const [workspaceId, claims] of byWorkspace) {
      // Another workspace's provider call may have waited while these chunks were removed or hidden.
      const allowed = await Promise.all(
        claims.map((r) =>
          r.scope_kind === "workspace"
            ? true
            : r.scope_kind === "channel"
              ? this.opts.access.isPublicChannel(r.channel_id)
              : false,
        ),
      );
      const eligible = claims.filter((_, i) => allowed[i]);
      const discarded = claims.filter((_, i) => !allowed[i]);
      if (discarded.length)
        await this.db.execute(sql`
        update search_chunks set embed_state = 'none', embed_claimed_at = null
        where id in (${sql.join(
          discarded.map((r) => sql`${r.id}`),
          sql`, `,
        )}) and embed_state = 'working'`);
      if (!eligible.length) continue;
      const rows = rowsOf(
        await this.db.execute(sql`
        select id, title, text, text_hash from search_chunks
        where id in (${sql.join(
          eligible.map((r) => sql`${r.id}`),
          sql`, `,
        )}) and embed_state = 'working'`),
      );
      if (!rows.length) continue;
      let result: Awaited<ReturnType<Embedder["embed"]>>;
      try {
        result = await embedder.embed(
          rows.map((r) => `${r.title}\n${r.text}`),
          "document",
        );
      } catch (err) {
        // Puts back in the queue what was not written yet (what was written is `done` and stays).
        await this.db.execute(sql`
          update search_chunks set embed_state = 'pending', embed_claimed_at = null
          where id in (${sql.join(
            picked.map((r) => sql`${r.id}`),
            sql`, `,
          )}) and embed_state = 'working'`);
        throw err;
      }
      await this.opts.onEmbed?.({
        workspaceId,
        model: embedder.model,
        tokens: result.tokens,
        kind: "document",
      });
      for (const [i, r] of rows.entries()) {
        const v = result.vectors[i];
        if (!v) continue;
        const done = rowsOf(
          await this.db.execute(sql`
            update search_chunks set embedding = ${vectorLiteral(v)}::halfvec, embed_state = 'done', embed_claimed_at = null
            where id = ${r.id} and text_hash = ${r.text_hash} and embed_state = 'working'
            returning id`),
        );
        n += done.length;
      }
    }
    return n;
  }

  /** The permission in the WHERE: what the person reads AND what the agent reads (intersection). `null`: nothing. */
  private async permission(viewer: Viewer): Promise<SQL | null> {
    if (!viewer.userId && !viewer.agentId) return null;
    const parts: SQL[] = [sql`c.workspace_id = ${viewer.workspaceId}`];
    for (const principal of [
      viewer.userId ? `user:${viewer.userId}` : null,
      viewer.agentId ? `agent:${viewer.agentId}` : null,
    ]) {
      if (!principal) continue;
      const channels = await this.opts.access.readable(viewer.workspaceId, principal);
      if (!channels) return null;
      parts.push(sql`(c.scope_kind = 'workspace'
        or (c.scope_kind = 'channel' and c.channel_id = any(${textArray(channels)}))
        or (c.scope_kind in ('channel', 'private') and ${principal} = any(c.principals)))`);
    }
    return sql.join(parts, sql` and `);
  }

  private filters(kinds: readonly SourceKind[] | undefined, f: SearchFilters | undefined): SQL[] {
    const out: SQL[] = [];
    if (kinds?.length) out.push(sql`c.source_kind = any(${textArray(kinds)})`);
    if (!f) return out;
    if (f.authors?.length) out.push(sql`c.author_id = any(${textArray(f.authors)})`);
    if (f.channelIds?.length) out.push(sql`c.channel_id = any(${textArray(f.channelIds)})`);
    if (f.has?.length) out.push(sql`c.has @> ${textArray(f.has)}`);
    if (f.is?.length) out.push(sql`c.is_facets @> ${textArray(f.is)}`);
    if (f.before) out.push(sql`c.created_at < ${new Date(`${f.before}T00:00:00Z`).toISOString()}`);
    if (f.after)
      out.push(
        sql`c.created_at >= ${new Date(Date.parse(`${f.after}T00:00:00Z`) + 86_400_000).toISOString()}`,
      );
    if (f.mentions?.length)
      out.push(sql`(c.author_id = any(${textArray(f.mentions)}) or c.mentions && ${textArray(f.mentions)})`);
    return out;
  }

  async search(viewer: Viewer, query: string, opts: SearchOptions = {}): Promise<SearchHit[]> {
    const q = parseText(query);
    const prefix = opts.mode === "typing" ? q.terms.pop() : undefined;
    const match = opts.match ?? "all";
    const tsq = tsQuery(q, prefix, match);
    if (!tsq) return [];
    const perm = await this.permission(viewer);
    if (!perm) return [];
    const terms = tsQuery({ ...q, phrases: [] }, prefix, match);
    const phrases = q.phrases.map(phraseMatch);
    const join = match === "any" ? sql` or ` : sql` and `;
    const lexicalMatch = sql`(${sql.join([...(terms ? [sql`c.tsv @@ ${terms}`] : []), ...phrases], join)})`;
    // With `any`, a free term can match approximately. A phrase-only query still needs a real phrase.
    const requirePhrases = phrases.length && (match === "all" || !terms);
    const excl = excluded(q);
    const where = sql.join(
      [
        perm,
        ...this.filters(opts.kinds, opts.filters),
        ...(requirePhrases ? [sql`(${sql.join(phrases, join)})`] : []),
        ...(excl ? [sql`not ${excl}`] : []),
      ],
      sql` and `,
    );
    const limit = Math.max(1, Math.min(opts.limit ?? 20, 500));
    const legLimit = Math.max(LEG_LIMIT, limit);

    // A leg names a chunk by its source and ordinal, not by `id`: a reindex between two statements (the
    // backfill replays every live file each tick) deletes and inserts the rows, so the ids a leg read are
    // gone by the final read while the source still has the chunk.
    const legs: Row[][] = [];
    const lexical = rowsOf(
      await this.db.execute(sql`
        select c.id, c.source_kind, c.source_id, c.ordinal from search_chunks c, (select ${tsq} as q) tq
        where ${where} and c.tsv @@ tq.q and ${lexicalMatch}
        order by ts_rank_cd(c.tsv, tq.q, 32) desc, c.created_at desc
        limit ${legLimit}`),
    );
    legs.push(lexical);

    // Name: a title close to the whole query (a typo, a file name).
    const name = [...q.terms, ...q.phrases, ...(prefix ? [prefix] : [])].join(" ");
    if (name.length >= 3) {
      const byName = rowsOf(
        await this.db.execute(sql`
          select c.id, c.source_kind, c.source_id, c.ordinal from search_chunks c
          where ${where} and ${name} <% c.title_fold and c.ordinal = 0
          order by word_similarity(${name}, c.title_fold) desc
          limit ${Math.min(legLimit, 50)}`),
      );
      legs.push(byName);
    }

    if (opts.mode !== "typing" && (await this.vectorOn()) && this.opts.embedder) {
      const text = [...q.terms, ...q.phrases].join(" ");
      if (text) {
        const { vectors, tokens } = await this.opts.embedder.embed([text], "query");
        await this.opts.onEmbed?.({
          workspaceId: viewer.workspaceId,
          model: this.opts.embedder.model,
          tokens,
          kind: "query",
        });
        const v = vectors[0];
        if (v) {
          const byVector = await this.db.transaction(async (tx) => {
            // With a filter, HNSW alone returns few rows (ef_search 40 and 10% readable gives ~4): the
            // iterative scan keeps walking the graph until enough rows pass the WHERE.
            await tx.execute(sql`set local hnsw.iterative_scan = relaxed_order`);
            await tx.execute(sql`set local hnsw.ef_search = 100`);
            return rowsOf(
              await tx.execute(sql`
                select c.id, c.source_kind, c.source_id, c.ordinal from search_chunks c
                where ${where} and c.embedding is not null
                order by c.embedding <=> ${vectorLiteral(v)}::halfvec
                limit ${Math.min(legLimit, 100)}`),
            );
          });
          legs.push(byVector);
        }
      }
    }

    // RRF: each leg votes 1/(60 + position); whoever shows up in more than one rises. A tie goes to the
    // smaller id, the older chunk.
    const fused = new Map<string, { row: Row; id: number; score: number }>();
    for (const leg of legs)
      leg.forEach((row, i) => {
        const vote = 1 / (RRF_K + i + 1);
        const seen = fused.get(chunkKey(row));
        if (seen) seen.score += vote;
        else fused.set(chunkKey(row), { row, id: Number(row.id), score: vote });
      });
    const top = [...fused.values()].sort((a, b) => b.score - a.score || a.id - b.id).slice(0, limit);
    if (!top.length) return [];
    const currentPerm = await this.permission(viewer);
    if (!currentPerm) return [];
    const rows = rowsOf(
      await this.db.execute(sql`
        select c.id, c.source_kind, c.source_id, c.ordinal, c.title, c.text, c.url, c.channel_id, c.author_id,
          c.created_at, c.page, c.untrusted
        from search_chunks c
        where (c.source_kind, c.source_id, c.ordinal) in (${sql.join(
          top.map(
            ({ row }) => sql`(${row.source_kind}::text, ${row.source_id}::text, ${row.ordinal}::integer)`,
          ),
          sql`, `,
        )}) and ${currentPerm}`),
    );
    const byKey = new Map(rows.map((r) => [chunkKey(r), r]));
    const hits: SearchHit[] = [];
    for (const { row, score: s } of top) {
      const r = byKey.get(chunkKey(row));
      if (!r) continue;
      hits.push({
        source: { kind: r.source_kind as SourceKind, id: r.source_id },
        ordinal: r.ordinal,
        title: r.title,
        snippet: snippetFor(r.text, prefix ? { ...q, terms: [...q.terms, prefix] } : q),
        url: r.url,
        score: s,
        channelId: r.channel_id ?? null,
        authorId: r.author_id ?? null,
        createdAt: new Date(r.created_at).toISOString(),
        page: r.page ?? null,
        ...(r.untrusted ? { untrusted: r.untrusted } : {}),
        ...(opts.withText ? { text: r.text } : {}),
      });
    }
    return hits;
  }
}
