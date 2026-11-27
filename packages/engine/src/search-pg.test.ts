// The search contract against the real implementation: the same contract test (fuzz without leaks,
// recall, removing/going private, the agent ∩ person intersection) on PGlite (no vector) and on a real
// Postgres (with pgvector and the fake embedder), plus what only SQL has: operators, vector and queue.
// The real Postgres runs only where a disposable one is available (the CI `postgres` job starts one);
// each index gets a database of its own, so the tests never see each other's rows.
import { afterAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import { z } from "zod";
import { type OpenDb, openDb } from "./db";
import { fakeEmbedder } from "./embeddings";
import type { AccessWorld, ChunkInput, SourceRef, Viewer } from "./search";
import { searchContract } from "./search-contract";
import { PgSearchIndex, worldAccess } from "./search-pg";

const url = process.env.VANR_TEST_POSTGRES_URL;

/** PGlite returns `{ rows }`. */
const StateRows = z.array(z.object({ source_id: z.string(), embed_state: z.string() }));

const opened: OpenDb[] = [];
afterAll(async () => {
  for (const o of opened) await o.close();
});

let shared: Promise<OpenDb> | null = null;

/**
 * An empty `search_chunks` on PGlite. Opening and migrating takes ~2 s, so the tests (which run one at a
 * time) share one in-memory database and each starts from an emptied table with the ids reset, as a new
 * database would have.
 */
async function pglite() {
  shared ??= openDb({ kind: "pglite", dataDir: null }).then((o) => {
    opened.push(o);
    return o;
  });
  const { db } = await shared;
  await db.execute(sql`truncate search_chunks restart identity`);
  return db;
}

let databases = 0;

/** A new, empty database on the server of `VANR_TEST_POSTGRES_URL`, with the migrations applied. */
async function realPostgres() {
  const admin = postgres(url ?? "", { max: 1, onnotice: () => {} });
  const name = `search_${process.pid}_${Date.now().toString(36)}_${databases++}`;
  try {
    await admin.unsafe(`create database "${name}"`);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const target = new URL(url ?? "");
  target.pathname = `/${name}`;
  const o = await openDb({ kind: "postgres", url: target.toString() });
  opened.push(o);
  return o.db;
}

searchContract(
  "PGlite (lexical only)",
  async (world) => new PgSearchIndex(await pglite(), { access: worldAccess(world) }),
);

if (url)
  searchContract("real Postgres (lexical + vector)", async (world) => {
    const index = new PgSearchIndex(await realPostgres(), {
      access: worldAccess(world),
      embedder: fakeEmbedder(),
    });
    expect(await index.vectorOn()).toBe(true);
    // Every contract insert goes through the queue before searching: the vector must honor the permission too.
    const upsert = index.upsert.bind(index);
    index.upsert = async (s, c) => {
      await upsert(s, c);
      while ((await index.embedPending(256)) > 0);
    };
    return index;
  });

const world: AccessWorld = {
  publicChannels: new Set(["pub"]),
  members: new Map([
    ["pub", new Set(["user:u1", "agent:a1"])],
    ["priv", new Set(["user:u1"])],
  ]),
  workspaceMembers: new Set(["user:u1", "user:u2"]),
};

const chunk = (over: Partial<ChunkInput> & Pick<ChunkInput, "text">): ChunkInput => ({
  workspaceId: "o",
  ordinal: 0,
  title: "Nota",
  scope: { kind: "channel", channelId: "pub" },
  url: "/x",
  updatedAt: "2026-10-10T12:00:00Z",
  ...over,
});

describe("search in SQL: beyond the contract", () => {
  test.each(["channel", "workspace"])(
    "revoking %s access during a search hides its content",
    async (kind) => {
      const db = await pglite();
      const changing = {
        publicChannels: new Set(["pub"]),
        members: new Map([["pub", new Set<string>()]]),
        workspaceMembers: new Set(["user:u2"]),
      } satisfies AccessWorld;
      const access = worldAccess(changing);
      const captured = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      let reads = 0;
      const index = new PgSearchIndex(db, {
        access: {
          ...access,
          async readable(workspaceId, principal) {
            const channels = await access.readable(workspaceId, principal);
            if (++reads === 1) {
              captured.resolve();
              await resume.promise;
            }
            return channels;
          },
        },
      });
      await index.upsert({ kind: "wiki", id: "secret" }, [chunk({ text: "orçamento confidencial" })]);
      const pending = index.search({ workspaceId: "o", userId: "u2" }, "orcamento", { withText: true });
      await captured.promise;
      if (kind === "channel") {
        changing.publicChannels.delete("pub");
        await index.channelVisibility("pub", false);
      } else changing.workspaceMembers.delete("user:u2");
      resume.resolve();
      expect(await pending).toEqual([]);
    },
  );

  test.each(url ? ["PGlite", "real Postgres"] : ["PGlite"])(
    "a reindex of the source during a search still returns it (%s)",
    async (backend) => {
      const real = backend === "real Postgres";
      const access = worldAccess(world);
      const src: SourceRef = { kind: "file", id: "harbor" };
      const version = [chunk({ text: "harbor expansion roadmap", scope: { kind: "workspace" } })];
      let reads = 0;
      const db = real ? await realPostgres() : await pglite();
      const index: PgSearchIndex = new PgSearchIndex(db, {
        ...(real ? { embedder: fakeEmbedder() } : {}),
        access: {
          ...access,
          // The second read is the permission check after the legs: the backfill replays the file right then.
          async readable(workspaceId, principal) {
            if (++reads === 2) await index.upsert(src, version);
            return access.readable(workspaceId, principal);
          },
        },
      });
      await index.upsert(src, version);
      if (real) expect(await index.embedPending()).toBe(1);
      const hits = await index.search({ workspaceId: "o", userId: "u1" }, "harbor");
      expect(reads).toBe(2);
      expect(hits.map((h) => h.source.id)).toEqual(["harbor"]);
    },
  );

  test.each(["support@example.com", "https://example.com/path", "version 1.2.3"])(
    "the body is searchable with the same tokenization as the query: %s",
    async (text) => {
      const index = new PgSearchIndex(await pglite(), { access: worldAccess(world) });
      await index.upsert({ kind: "wiki", id: "tokens" }, [chunk({ text })]);
      const viewer = { workspaceId: "o", userId: "u1" };
      expect((await index.search(viewer, text)).map((h) => h.source.id)).toEqual(["tokens"]);
    },
  );

  test("phrases do not join dictionary copies, including exclusions", async () => {
    const index = new PgSearchIndex(await pglite(), { access: worldAccess(world) });
    const source: SourceRef = { kind: "wiki", id: "positions" };
    await index.upsert(source, [chunk({ text: "hotel eco" })]);
    const viewer = { workspaceId: "o", userId: "u1" };
    const ids = async (query: string) => (await index.search(viewer, query)).map((h) => h.source.id);
    expect(await ids('"hotel eco"')).toEqual(["positions"]);
    expect(await ids('"eco hotel"')).toEqual([]);
    expect(await ids('hotel -"eco hotel"')).toEqual(["positions"]);
  });

  test("excluding a phrase keeps its stop words", async () => {
    const index = new PgSearchIndex(await pglite(), { access: worldAccess(world) });
    await index.upsert({ kind: "wiki", id: "stopwords" }, [chunk({ text: "março aprovado" })]);
    const viewer = { workspaceId: "o", userId: "u1" };
    expect((await index.search(viewer, 'aprovado -"de marco"')).map((h) => h.source.id)).toEqual([
      "stopwords",
    ]);
    expect(await index.search(viewer, 'aprovado -"marco aprovado"')).toEqual([]);
  });

  test("a similar title cannot supply a reversed phrase", async () => {
    const index = new PgSearchIndex(await pglite(), { access: worldAccess(world) });
    await index.upsert({ kind: "wiki", id: "title" }, [chunk({ title: "Orçamento aprovado", text: "Alfa" })]);
    const viewer = { workspaceId: "o", userId: "u1" };
    expect((await index.search(viewer, '"orcamento aprovado"')).map((h) => h.source.id)).toEqual(["title"]);
    expect(await index.search(viewer, '"aprovado orcamento"')).toEqual([]);
  });

  test("Portuguese stemming, accents, quotes and exclusion", async () => {
    const index = new PgSearchIndex(await pglite(), { access: worldAccess(world) });
    await index.upsert({ kind: "wiki", id: "w1" }, [
      chunk({ title: "Relatórios", text: "Os orçamentos aprovados de março" }),
    ]);
    await index.upsert({ kind: "wiki", id: "w2" }, [
      chunk({ title: "Outro", text: "orçamento reprovado em abril" }),
    ]);
    const u1: Viewer = { workspaceId: "o", userId: "u1" };
    const ids = async (q: string) => (await index.search(u1, q)).map((h) => h.source.id).sort();
    expect(await ids("orcamento")).toEqual(["w1", "w2"]);
    expect(await ids("relatorio")).toEqual(["w1"]);
    expect(await ids('"orcamentos aprovados"')).toEqual(["w1"]);
    expect(await ids('"aprovados orcamentos"')).toEqual([]);
    expect(await ids("orcamento -abril")).toEqual(["w1"]);
    expect(await ids('orcamento -"de marco"')).toEqual(["w2"]);
  });

  test("operators in SQL: from, in, has, is, before, after, mention", async () => {
    const index = new PgSearchIndex(await pglite(), { access: worldAccess(world) });
    const put = (id: string, c: Partial<ChunkInput>) =>
      index.upsert({ kind: "message", id }, [chunk({ text: "deploy hoje", ...c })]);
    await put("m1", { authorId: "user:u1", createdAt: "2026-10-01T10:00:00Z", facets: { has: ["link"] } });
    await put("m2", {
      authorId: "agent:a1",
      createdAt: "2026-10-05T10:00:00Z",
      facets: { is: ["agent"], mentions: ["user:u2"] },
    });
    await put("m3", {
      authorId: "user:u1",
      scope: { kind: "channel", channelId: "priv" },
      createdAt: "2026-10-09T10:00:00Z",
    });
    const u1: Viewer = { workspaceId: "o", userId: "u1" };
    const ids = async (filters: object) =>
      (await index.search(u1, "deploy", { filters })).map((h) => h.source.id).sort();
    expect(await ids({ authors: ["user:u1"] })).toEqual(["m1", "m3"]);
    expect(await ids({ channelIds: ["priv"] })).toEqual(["m3"]);
    expect(await ids({ has: ["link"] })).toEqual(["m1"]);
    expect(await ids({ is: ["agent"] })).toEqual(["m2"]);
    expect(await ids({ before: "2026-10-05" })).toEqual(["m1"]);
    expect(await ids({ after: "2026-10-05" })).toEqual(["m3"]);
    expect(await ids({ after: "2026-10-01", before: "2026-10-09" })).toEqual(["m2"]);
    expect(await ids({ mentions: ["user:u2"] })).toEqual(["m2"]);
    // A filter opens nothing: u2 does not read the private channel, not even with `in:` pointing at it.
    expect(
      (
        await index.search({ workspaceId: "o", userId: "u2" }, "deploy", {
          filters: { channelIds: ["priv"] },
        })
      ).length,
    ).toBe(0);
  });

  test("while typing, the last word counts as a prefix; a name with a typo is found by trigram", async () => {
    const index = new PgSearchIndex(await pglite(), { access: worldAccess(world) });
    await index.upsert({ kind: "file", id: "f1" }, [
      chunk({ title: "Planejamento trimestral.pdf", text: "orçamentação anual" }),
    ]);
    const u1: Viewer = { workspaceId: "o", userId: "u1" };
    expect((await index.search(u1, "orcamen", { mode: "typing" })).map((h) => h.source.id)).toEqual(["f1"]);
    expect((await index.search(u1, "orcamen")).map((h) => h.source.id)).toEqual([]);
    expect((await index.search(u1, "planejamneto trimestral")).map((h) => h.source.id)).toEqual(["f1"]);
  });

  test("a NUL character, which Postgres text cannot hold, breaks neither a filter nor an indexed chunk", async () => {
    const index = new PgSearchIndex(await pglite(), { access: worldAccess(world) });
    await index.upsert({ kind: "message", id: "n1" }, [
      chunk({ title: "No\u0000ta", text: "deploy\u0000 hoje" }),
    ]);
    const u1: Viewer = { workspaceId: "o", userId: "u1" };
    expect((await index.search(u1, "deploy")).map((h) => h.source.id)).toEqual(["n1"]);
    const filtered = await index.search(u1, "deploy", {
      filters: { channelIds: ["pub", "x\u0000"], authors: [] },
    });
    expect(filtered.map((h) => h.source.id)).toEqual(["n1"]);
    expect(await index.search(u1, "deploy", { filters: { channelIds: ["\u0000"] } })).toEqual([]);
  });

  test("without pgvector the index stays lexical, and the queue, visibility and purge statements run", async () => {
    const db = await pglite();
    const embedder = fakeEmbedder();
    const index = new PgSearchIndex(db, { access: worldAccess(world), embedder });
    expect(await index.ensureVector()).toBe(false);
    expect(await index.vectorOn()).toBe(false);
    const states = async () => {
      const result = await db.execute(
        sql`select source_id, embed_state from search_chunks order by source_id`,
      );
      return StateRows.parse(typeof result === "object" && result ? Reflect.get(result, "rows") : result).map(
        (r) => [r.source_id, r.embed_state],
      );
    };
    await index.withDb(db).upsert({ kind: "wiki", id: "v1" }, [chunk({ text: "observabilidade" })]);
    await index.upsert({ kind: "message", id: "p1" }, [
      chunk({ text: "observabilidade secreta", scope: { kind: "channel", channelId: "priv" } }),
    ]);
    // A public channel queues the chunk for the vector; a private one never does.
    expect(await states()).toEqual([
      ["p1", "none"],
      ["v1", "pending"],
    ]);
    expect(await index.embedPending()).toBe(0);
    expect(embedder.calls).toBe(0);
    await index.channelVisibility("pub", false);
    expect(await states()).toEqual([
      ["p1", "none"],
      ["v1", "none"],
    ]);
    await index.channelVisibility("pub", true);
    expect(await states()).toEqual([
      ["p1", "none"],
      ["v1", "pending"],
    ]);
    await index.purgeWorkspace("other");
    expect((await states()).length).toBe(2);
    await index.purgeWorkspace("o");
    expect(await states()).toEqual([]);
  });
});

describe.skipIf(!url)("search on a real Postgres", () => {
  test("concurrent replacements of an existing source stay complete", async () => {
    const db = await realPostgres();
    const index = new PgSearchIndex(db, { access: worldAccess(world) });
    const source: SourceRef = { kind: "wiki", id: "concurrent" };
    const viewer = { workspaceId: "o", userId: "u1" };
    const version = (text: string) => [chunk({ text }), chunk({ text, ordinal: 1 })];
    await index.upsert(source, version("versao inicial"));
    // Warm both connections so startup does not serialize the replacements.
    await Promise.all([db.execute(sql`select 1`), db.execute(sql`select 1`)]);
    const results = await Promise.allSettled([
      index.upsert(source, version("versao alfa")),
      index.upsert(source, version("versao beta")),
    ]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
    const hits = await index.search(viewer, "versao", { withText: true });
    expect(hits.map((h) => h.ordinal).sort()).toEqual([0, 1]);
    expect(new Set(hits.map((h) => h.text)).size).toBe(1);
  });

  test("the vector leg honors explicit phrases with all and any matching", async () => {
    const index = new PgSearchIndex(await realPostgres(), {
      access: worldAccess(world),
      embedder: fakeEmbedder(),
    });
    await index.upsert({ kind: "wiki", id: "vector-phrase" }, [chunk({ text: "arquivo de receitas" })]);
    expect(await index.embedPending()).toBe(1);
    const viewer = { workspaceId: "o", userId: "u1" };
    expect(await index.search(viewer, '"frasenula frasenula"')).toEqual([]);
    expect(
      (await index.search(viewer, 'arquivo "frasenula frasenula"', { match: "any" })).map((h) => h.source.id),
    ).toEqual(["vector-phrase"]);
  });

  test.each([false, true])(
    "the queue revalidates privacy between workspace calls (stale upsert: %s)",
    async (staleUpsert) => {
      const db = await realPostgres();
      const channels = new Set(["first", "second"]);
      const access = worldAccess({
        publicChannels: channels,
        members: new Map(),
        workspaceMembers: new Set(),
      });
      const started = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      const checked = Promise.withResolvers<void>();
      const resumeUpsert = Promise.withResolvers<void>();
      let holdEligibility = false;
      const deliveries: string[][] = [];
      const fake = fakeEmbedder();
      const index = new PgSearchIndex(db, {
        access: {
          ...access,
          async isPublicChannel(channelId) {
            const answer = await access.isPublicChannel(channelId);
            if (holdEligibility) {
              holdEligibility = false;
              checked.resolve();
              await resumeUpsert.promise;
            }
            return answer;
          },
        },
        embedder: {
          model: fake.model,
          async embed(texts, kind) {
            deliveries.push([...texts]);
            if (deliveries.length === 1) {
              started.resolve();
              await resume.promise;
            }
            return fake.embed(texts, kind);
          },
        },
      });
      const second: SourceRef = { kind: "wiki", id: "second" };
      const confidential = chunk({
        workspaceId: "w2",
        text: "CONFIDENTIAL DOCUMENT",
        scope: { kind: "channel", channelId: "second" },
      });
      await index.upsert({ kind: "wiki", id: "first" }, [
        chunk({ workspaceId: "w1", text: "public document", scope: { kind: "channel", channelId: "first" } }),
      ]);
      await index.upsert(second, [confidential]);
      const pending = index.embedPending();
      await started.promise;
      let saving: Promise<void> | undefined;
      if (staleUpsert) {
        holdEligibility = true;
        saving = index.upsert(second, [confidential]);
        await checked.promise;
      }
      channels.delete("second");
      await index.channelVisibility("second", false);
      resumeUpsert.resolve();
      await saving;
      resume.resolve();
      await pending;
      // A stale upsert may have queued a new row outside the original batch.
      await index.embedPending();
      expect(deliveries).toEqual([["Nota\npublic document"]]);
    },
  );

  test("vector: finds by similar shape, leaves the index when the channel turns private and never enters if private", async () => {
    const access = worldAccess(world);
    const embedder = fakeEmbedder();
    const index = new PgSearchIndex(await realPostgres(), { access, embedder });
    const src: SourceRef = { kind: "wiki", id: "v1" };
    await index.upsert(src, [
      chunk({ title: "Arquitetura", text: "infraestrutura de observabilidade distribuída" }),
    ]);
    await index.upsert({ kind: "message", id: "p1" }, [
      chunk({ text: "observabilidade secreta", scope: { kind: "channel", channelId: "priv" } }),
    ]);
    await index.upsert({ kind: "message", id: "p2" }, [
      chunk({ text: "observabilidade minha", scope: { kind: "private", principals: ["user:u1"] } }),
    ]);
    expect(await index.embedPending()).toBe(1);
    const u1: Viewer = { workspaceId: "o", userId: "u1" };
    // "observabilidad infraestrutur" does not match lexically (not even by stem), but the vector finds it.
    const hits = await index.search(u1, "observabilidad infraestrutur");
    expect(hits.map((h) => h.source.id)).toEqual(["v1"]);
    // Editing without changing the text does not send it to the embedder again.
    const before = embedder.calls;
    await index.upsert(src, [
      chunk({ title: "Arquitetura", text: "infraestrutura de observabilidade distribuída" }),
    ]);
    expect(await index.embedPending()).toBe(0);
    expect(embedder.calls).toBe(before);
    // The channel turns private: the vector leaves at once.
    await index.channelVisibility("pub", false);
    expect(await index.search(u1, "observabilidad infraestrutur")).toEqual([]);
  });

  test("vector queue: two instances at once never claim the same chunk", async () => {
    const db = await realPostgres();
    const embedder = fakeEmbedder();
    const a = new PgSearchIndex(db, { access: worldAccess(world), embedder });
    const b = new PgSearchIndex(db, { access: worldAccess(world), embedder });
    for (let i = 0; i < 40; i++)
      await a.upsert({ kind: "message", id: `q${i}` }, [chunk({ text: `item ${i} da fila` })]);
    const [x, y] = await Promise.all([a.embedPending(30), b.embedPending(30)]);
    expect((x ?? 0) + (y ?? 0)).toBe(40);
    expect(await a.embedPending()).toBe(0);
  });
});
