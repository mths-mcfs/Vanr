// Search. Every searchable piece of content becomes chunks (`search_chunks`) carrying the scope of who
// may read them; whoever saves the source calls upsert, whoever deletes or hides it calls remove (or
// upsert with the new scope). search(viewer, query) applies the permission inside the query itself (in
// Postgres, in the WHERE), never by filtering after the cut.
//
// The Postgres implementation (FTS + pg_trgm + pgvector, fused by RRF) lives in search-pg.ts and passes
// search-contract.ts. Wiki pages, database rows, issues, events, debates and messages feed it.
// memorySearch() is the reference and the test double.

import type { HasFacet, IsFacet } from "./search-query";
import { matchesText, parseText, snippetFor } from "./search-query";

export type SourceKind = "message" | "wiki" | "file" | "issue" | "debate" | "db_row" | "event";

export interface SourceRef {
  kind: SourceKind;
  id: string;
}

/** Who may read the chunk. */
export type ChunkScope =
  /** The whole workspace (people; agents too). */
  | { kind: "workspace" }
  /**
   * Whoever reads the channel (public: the workspace's people; private or DM: members). Agents only as
   * members. `also`: principals who read it even from outside the channel (debate participants).
   */
  | { kind: "channel"; channelId: string; also?: readonly string[] }
  /** Only these principals (`user:<id>` or `agent:<id>`). */
  | { kind: "private"; principals: string[] };

export interface ChunkInput {
  workspaceId: string;
  /** Position of the chunk within its source (0, 1, 2...). */
  ordinal: number;
  title: string;
  text: string;
  scope: ChunkScope;
  /** Path in the app that opens the source (`/workspace/<slug>/wiki/<page>`...). */
  url: string;
  /** Who wrote it: `user:<id>` or `agent:<id>` (`from:` and `is:agent`). */
  authorId?: string;
  updatedAt: string;
  /** When the source was created (`before:`/`after:`). Default: `updatedAt`. */
  createdAt?: string;
  /** Page of the file (PDF, slide, sheet), for the citation. */
  page?: number;
  /** Operator facets: `has:`, `is:` and who the source mentions (`user:<id>`/`agent:<id>`). */
  facets?: { has?: readonly HasFacet[]; is?: readonly IsFacet[]; mentions?: readonly string[] };
  /** Came from outside (email, webhook): from where. An agent reading the chunk raises flag A. */
  untrusted?: string;
}

/**
 * Who is searching. A person: `userId`. An agent: `agentId`. An agent searching on behalf of a person:
 * both, and the result is the intersection (what both may read).
 */
export interface Viewer {
  workspaceId: string;
  userId?: string;
  agentId?: string;
}

/** Operators already resolved to ids (the route swaps handles and channel names for ids). */
export interface SearchFilters {
  /** `from:`: the author is one of these (`user:<id>`/`agent:<id>`). */
  authors?: readonly string[];
  /** `in:`: a chunk from one of these channels. */
  channelIds?: readonly string[];
  has?: readonly HasFacet[];
  is?: readonly IsFacet[];
  /** `before:`/`after:` (YYYY-MM-DD, exclusive) on `createdAt`. */
  before?: string;
  after?: string;
  /** `@handle`: written by one of these or mentioning one of them. */
  mentions?: readonly string[];
}

export interface SearchOptions {
  kinds?: readonly SourceKind[];
  limit?: number;
  filters?: SearchFilters;
  /**
   * `typing`: the last word counts as a prefix and no outside service is called (palette, search as you
   * type). `full` (default): lexical, name and vector, fused by RRF.
   */
  mode?: "typing" | "full";
  /** `all` (default): every word. `any`: any of them (a natural-language question). */
  match?: "all" | "any";
  /** Returns the whole chunk text in `text` (ask mode sends it to the model). */
  withText?: boolean;
}

export interface SearchHit {
  source: SourceRef;
  ordinal: number;
  title: string;
  snippet: string;
  url: string;
  score: number;
  /** Channel of the chunk (`channel` scope), for the channel · author · date line. */
  channelId: string | null;
  authorId: string | null;
  createdAt: string;
  page: number | null;
  /** The chunk came from outside (`ChunkInput.untrusted`). */
  untrusted?: string;
  /** The whole chunk, only with `withText`. */
  text?: string;
}

export interface SearchIndex {
  /** Replaces every chunk of the source with the new ones (an empty list drops it from search). */
  upsert(source: SourceRef, chunks: readonly ChunkInput[]): Promise<void>;
  remove(source: SourceRef): Promise<void>;
  search(viewer: Viewer, query: string, opts?: SearchOptions): Promise<SearchHit[]>;
}

/** What the permission needs to know about the world: public channels and members (people and agents). */
export interface AccessWorld {
  publicChannels: ReadonlySet<string>;
  /** channel → principals (`user:<id>`, `agent:<id>`). */
  members: ReadonlyMap<string, ReadonlySet<string>>;
  /** The workspace's people (`user:<id>`), for the public channel and workspace scopes. */
  workspaceMembers: ReadonlySet<string>;
}

function principalCan(world: AccessWorld, principal: string, scope: ChunkScope): boolean {
  const isAgent = principal.startsWith("agent:");
  switch (scope.kind) {
    case "workspace":
      return isAgent || world.workspaceMembers.has(principal);
    case "channel": {
      if (scope.also?.includes(principal)) return true;
      const member = world.members.get(scope.channelId)?.has(principal) ?? false;
      if (isAgent) return member;
      return member || (world.publicChannels.has(scope.channelId) && world.workspaceMembers.has(principal));
    }
    case "private":
      return scope.principals.includes(principal);
  }
}

/** The permission oracle: the contract test checks every result against it. */
export function canRead(world: AccessWorld, viewer: Viewer, workspaceId: string, scope: ChunkScope): boolean {
  if (viewer.workspaceId !== workspaceId) return false;
  if (!viewer.userId && !viewer.agentId) return false;
  if (viewer.userId && !principalCan(world, `user:${viewer.userId}`, scope)) return false;
  if (viewer.agentId && !principalCan(world, `agent:${viewer.agentId}`, scope)) return false;
  return true;
}

/** The chunk passes the operators (the reference; Postgres does the same in SQL). */
function passesFilters(c: ChunkInput, f: SearchFilters | undefined): boolean {
  if (!f) return true;
  const channelId = c.scope.kind === "channel" ? c.scope.channelId : null;
  const created = (c.createdAt ?? c.updatedAt).slice(0, 10);
  if (f.authors?.length && !(c.authorId && f.authors.includes(c.authorId))) return false;
  if (f.channelIds?.length && !(channelId && f.channelIds.includes(channelId))) return false;
  if (f.has?.some((h) => !c.facets?.has?.includes(h))) return false;
  if (f.is?.some((i) => !c.facets?.is?.includes(i))) return false;
  if (f.before && !(created < f.before)) return false;
  if (f.after && !(created > f.after)) return false;
  if (f.mentions?.length && !f.mentions.some((m) => c.authorId === m || c.facets?.mentions?.includes(m)))
    return false;
  return true;
}

/** In-memory search: every word (and phrase) of the query in the title or text, ignoring accents and case. */
export function memorySearch(world: AccessWorld): SearchIndex & { size(): number } {
  const bySource = new Map<string, { source: SourceRef; chunks: readonly ChunkInput[] }>();
  const key = (s: SourceRef) => `${s.kind}:${s.id}`;
  return {
    size: () => [...bySource.values()].reduce((n, e) => n + e.chunks.length, 0),
    async upsert(source, chunks) {
      if (chunks.length) bySource.set(key(source), { source, chunks });
      else bySource.delete(key(source));
    },
    async remove(source) {
      bySource.delete(key(source));
    },
    async search(viewer, query, opts = {}) {
      const q = parseText(query);
      const prefix = opts.mode === "typing" ? q.terms.pop() : undefined;
      if (!q.terms.length && !q.phrases.length && !prefix) return [];
      const hits: SearchHit[] = [];
      for (const { source, chunks } of bySource.values()) {
        if (opts.kinds && !opts.kinds.includes(source.kind)) continue;
        for (const c of chunks) {
          if (!canRead(world, viewer, c.workspaceId, c.scope)) continue;
          if (!passesFilters(c, opts.filters)) continue;
          if (!matchesText(q, `${c.title} ${c.text}`, prefix, opts.match)) continue;
          hits.push({
            source,
            ordinal: c.ordinal,
            title: c.title,
            snippet: snippetFor(c.text, q),
            url: c.url,
            score: 1,
            channelId: c.scope.kind === "channel" ? c.scope.channelId : null,
            authorId: c.authorId ?? null,
            createdAt: c.createdAt ?? c.updatedAt,
            page: c.page ?? null,
            ...(c.untrusted ? { untrusted: c.untrusted } : {}),
            ...(opts.withText ? { text: c.text } : {}),
          });
        }
      }
      return hits.slice(0, opts.limit ?? 20);
    },
  };
}
