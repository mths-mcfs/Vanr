// The workspace's search through the index: lexical + name + vector, with the searcher's permission in the
// WHERE of each leg. Operators (`from:`, `in:`, `has:`, `is:`, `before:`, `after:`, quotes, `-`, `@handle`)
// become filters with ids. Also the Cmd+K palette (channels, people, agents and content, as you type) and
// "ask" mode (an answer with numbered sources).
import type { SearchHit as ApiHit, PaletteResult, SearchKind } from "@vanr/contract";
import { type Db, schema } from "@vanr/engine/db";
import type { SearchHit, SourceKind, Viewer } from "@vanr/engine/search";
import { parseQuery, textOf } from "@vanr/engine/search-query";
import { fold } from "@vanr/engine/text";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { z } from "zod";
import type { AppDeps, AppEnv, WorkspaceMember } from "../context";
import { readJson, readQuery } from "../http";
import { askSources } from "../search-ask";
import { resolveFilters } from "../search-index";
import { requireMember, WORKSPACE } from "../workspace-scope";

const { channels, channelMemberships, members, users, agents } = schema;
const KINDS = [
  "message",
  "file",
  "wiki",
  "issue",
  "debate",
  "db_row",
  "event",
] as const satisfies readonly SearchKind[];

/** The channels the person reads: the workspace's public ones and the ones they belong to (private and DMs). */
export async function readableChannelIds(db: Db, me: WorkspaceMember): Promise<string[]> {
  const rows = await db
    .selectDistinct({ id: channels.id })
    .from(channels)
    .leftJoin(
      channelMemberships,
      and(
        eq(channelMemberships.channelId, channels.id),
        eq(channelMemberships.memberType, "person"),
        eq(channelMemberships.memberId, me.userId),
      ),
    )
    .where(
      and(
        eq(channels.workspaceId, me.workspaceId),
        or(
          and(eq(channels.kind, "channel"), eq(channels.visibility, "public")),
          sql`${channelMemberships.memberId} is not null`,
        ),
      ),
    );
  return rows.map((r) => r.id);
}

/** The API's format: the id each screen uses (the wiki's slug, the issue's number, the message's thread). */
export function toApiHit(h: SearchHit): ApiHit {
  const last = (re: RegExp) => re.exec(h.url)?.[1] ?? null;
  const sourceId =
    h.source.kind === "wiki"
      ? (last(/\/wiki\/([^/?#]+)/) ?? h.source.id)
      : h.source.kind === "issue"
        ? (last(/\/issues\/(\d+)/) ?? h.source.id)
        : h.source.id;
  return {
    kind: h.source.kind,
    sourceId: decodeURIComponent(sourceId),
    title: h.title,
    snippet: h.snippet,
    channelIds: h.channelId ? [h.channelId] : [],
    threadId: h.source.kind === "message" ? last(/\/threads\/([^/?#]+)/) : null,
    createdAt: h.createdAt,
    url: h.url,
    page: h.page,
    authorId: h.authorId,
    score: h.score,
  };
}

/** One result per source (the best chunk), in the fusion's order. */
export function onePerSource(hits: SearchHit[], limit: number): SearchHit[] {
  const seen = new Set<string>();
  const out: SearchHit[] = [];
  for (const h of hits) {
    const k = `${h.source.kind}:${h.source.id}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(h);
    if (out.length >= limit) break;
  }
  return out;
}

/** Reads the query with operators and searches as the person (what they read, nothing beyond it). */
export async function searchAs(
  deps: AppDeps,
  me: WorkspaceMember,
  raw: string,
  opts: {
    kinds?: readonly SourceKind[];
    limit: number;
    mode?: "typing" | "full";
    match?: "all" | "any";
    withText?: boolean;
    perSource?: boolean;
  },
): Promise<SearchHit[]> {
  const q = parseQuery(raw);
  const text = textOf(q);
  if (!text.trim()) return [];
  const kinds = q.kinds.length ? q.kinds.filter((k) => !opts.kinds || opts.kinds.includes(k)) : opts.kinds;
  if (kinds && !kinds.length) return [];
  const viewer: Viewer = { workspaceId: me.workspaceId, userId: me.userId };
  const filters = await resolveFilters(deps.db, me.workspaceId, `user:${me.userId}`, q);
  const perSource = opts.perSource ?? true;
  const hits = await deps.search.search(viewer, text, {
    kinds,
    filters,
    limit: perSource ? Math.min(opts.limit * 3, 300) : opts.limit,
    mode: opts.mode,
    match: opts.match,
    withText: opts.withText,
  });
  return perSource ? onePerSource(hits, opts.limit) : hits;
}

export function registerSearch(app: Hono<AppEnv>) {
  app.get(`${WORKSPACE}/search`, async (c) => {
    const me = requireMember(c);
    const input = readQuery(
      c,
      z.object({
        q: z.string().trim().max(500).default(""),
        kinds: z.string().max(100).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(20),
      }),
    );
    if (input.q.length < 2) return c.json({ hits: [] });
    const kinds = input.kinds
      ?.split(",")
      .map((k) => k.trim())
      .filter((k): k is SearchKind => (KINDS as readonly string[]).includes(k));
    const hits = await searchAs(c.get("deps"), me, input.q, { kinds, limit: input.limit });
    return c.json({ hits: hits.map(toApiHit) });
  });

  // Cmd+K: as you type, without an outside service. `#` only channels, `@` only people and agents; no
  // prefix, everything.
  app.get(`${WORKSPACE}/search/palette`, async (c) => {
    const me = requireMember(c);
    const { db } = c.get("deps");
    const { q: raw } = readQuery(c, z.object({ q: z.string().trim().max(200).default("") }));
    const prefix = raw[0] === "#" || raw[0] === "@" ? raw[0] : null;
    const term = fold(prefix ? raw.slice(1) : raw).trim();
    const out: PaletteResult = { channels: [], people: [], agents: [], hits: [] };
    if (!term) return c.json(out);
    const like = `%${term.replace(/[%_\\]/g, "\\$&")}%`;
    if (prefix !== "@") {
      const readable = await readableChannelIds(db, me);
      if (readable.length) {
        const rows = await db
          .select({
            id: channels.id,
            name: channels.name,
            kind: channels.kind,
            visibility: channels.visibility,
          })
          .from(channels)
          .where(
            and(
              eq(channels.workspaceId, me.workspaceId),
              eq(channels.kind, "channel"),
              isNull(channels.archivedAt),
              sql`${channels.id} = any(${`{${readable.map((id) => `"${id}"`).join(",")}}`}::text[])`,
              sql`(${channels.name} ilike ${like} or word_similarity(${term}, ${channels.name}) > 0.4)`,
            ),
          )
          .orderBy(sql`word_similarity(${term}, ${channels.name}) desc`, channels.name)
          .limit(8);
        out.channels = rows;
      }
    }
    if (prefix !== "#") {
      out.people = await db
        .select({ userId: members.userId, name: users.name, handle: members.handle })
        .from(members)
        .innerJoin(users, eq(users.id, members.userId))
        .where(
          and(
            eq(members.workspaceId, me.workspaceId),
            sql`(${members.handle} ilike ${like} or ${users.name} ilike ${like} or word_similarity(${term}, lower(${users.name})) > 0.4)`,
          ),
        )
        .orderBy(users.name)
        .limit(6);
      out.agents = await db
        .select({ id: agents.id, name: agents.name, handle: agents.handle })
        .from(agents)
        .where(
          and(
            eq(agents.workspaceId, me.workspaceId),
            isNull(agents.archivedAt),
            sql`(${agents.handle} ilike ${like} or ${agents.name} ilike ${like} or word_similarity(${term}, lower(${agents.name})) > 0.4)`,
          ),
        )
        .orderBy(agents.name)
        .limit(6);
    }
    if (!prefix && term.length >= 2) {
      const hits = await searchAs(c.get("deps"), me, raw, { limit: 8, mode: "typing" });
      out.hits = hits.map(toApiHit);
    }
    return c.json(out);
  });

  app.post(`${WORKSPACE}/search/ask`, async (c) => {
    const me = requireMember(c);
    const { q } = await readJson(c, z.object({ q: z.string().trim().min(2).max(500) }).strict());
    return c.json(await askSources(c.get("deps"), me, q));
  });
}
