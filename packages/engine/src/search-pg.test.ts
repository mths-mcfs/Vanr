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
