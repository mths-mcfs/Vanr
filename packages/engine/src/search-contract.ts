// Search contract test. Every SearchIndex implementation runs it: the in-memory one (search.test.ts)
// and the Postgres one (search-pg.test.ts). The fuzz builds a random world (public and private channels,
// people, agents, DMs, chunks) and checks that no result leaks to someone who cannot read it.
import { describe, expect, test } from "bun:test";
import type {
  AccessWorld,
  ChunkInput,
  ChunkScope,
  SearchIndex,
  SourceKind,
  SourceRef,
  Viewer,
} from "./search";
import { canRead } from "./search";

/** Deterministic generator (mulberry32): the same seed replays the failing case. */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = [
  "alfa",
  "bravo",
  "carta",
  "delta",
  "eco",
  "faca",
  "golfe",
  "hotel",
  "índio",
  "julieta",
  "quilo",
  "lima",
];
const KINDS: SourceKind[] = ["message", "wiki", "file", "issue", "debate", "db_row", "event"];

interface FuzzWorld {
  world: AccessWorld;
  workspaceId: string;
  users: string[];
  agents: string[];
  channels: string[];
  chunks: { source: SourceRef; chunk: ChunkInput }[];
}

function buildWorld(seed: number): FuzzWorld {
  const r = rng(seed);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)] as T;
  const workspaceId = "workspace_a";
  const users = ["u1", "u2", "u3", "u4", "u5"];
  const agents = ["a1", "a2"];
  const channels = ["c1", "c2", "c3", "c4", "c5", "dm1"];
  const publicChannels = new Set(channels.filter((c) => c !== "dm1" && r() < 0.5));
  const members = new Map<string, Set<string>>();
  for (const c of channels) {
    const set = new Set<string>();
    for (const u of users) if (r() < 0.4) set.add(`user:${u}`);
    for (const a of agents) if (r() < 0.4) set.add(`agent:${a}`);
    members.set(c, set);
  }
  const world: AccessWorld = {
    publicChannels,
    members,
    workspaceMembers: new Set(users.map((u) => `user:${u}`)),
  };
  const chunks: FuzzWorld["chunks"] = [];
  for (let i = 0; i < 300; i++) {
    const roll = r();
    const scope: ChunkScope =
      roll < 0.15
        ? { kind: "workspace" }
        : roll < 0.85
          ? r() < 0.15
            ? {
                kind: "channel",
                channelId: pick(channels),
                also: [`user:${pick(users)}`, `agent:${pick(agents)}`],
              }
            : { kind: "channel", channelId: pick(channels) }
          : {
              kind: "private",
              principals: [`user:${pick(users)}`, ...(r() < 0.5 ? [`agent:${pick(agents)}`] : [])],
            };
    // 5% of the chunks belong to another workspace: they must never show up.
    const chunkWorkspace = r() < 0.05 ? "workspace_b" : workspaceId;
    const text = Array.from({ length: 6 }, () => pick(WORDS)).join(" ");
    chunks.push({
      source: { kind: pick(KINDS), id: `s${i}` },
      chunk: {
        workspaceId: chunkWorkspace,
        ordinal: 0,
        title: `doc ${i}`,
        text,
        scope,
        url: `/x/${i}`,
        updatedAt: "2026-10-22T00:00:00Z",
      },
    });
  }
  return { world, workspaceId, users, agents, channels, chunks };
}

function randomViewer(fw: FuzzWorld, r: () => number): Viewer {
  const roll = r();
  const user = fw.users[Math.floor(r() * fw.users.length)];
  const agent = fw.agents[Math.floor(r() * fw.agents.length)];
  const workspaceId = r() < 0.05 ? "workspace_b" : fw.workspaceId;
  if (roll < 0.45) return { workspaceId, userId: user };
  if (roll < 0.7) return { workspaceId, agentId: agent };
  return { workspaceId, userId: user, agentId: agent };
}

export function searchContract(
  name: string,
  make: (world: AccessWorld) => Promise<SearchIndex> | SearchIndex,
) {
  describe(`search: ${name}`, () => {
    for (const seed of [1, 2, 3]) {
      test(`fuzz without leaks (seed ${seed}): every result passes the oracle`, async () => {
        const fw = buildWorld(seed);
        const index = await make(fw.world);
        for (const { source, chunk } of fw.chunks) await index.upsert(source, [chunk]);
        const byKey = new Map(fw.chunks.map((c) => [`${c.source.kind}:${c.source.id}`, c.chunk]));
        const r = rng(seed * 7919);
        const leaks: string[] = [];
        let found = 0;
        for (let q = 0; q < 200; q++) {
          const viewer = randomViewer(fw, r);
          const query = WORDS[Math.floor(r() * WORDS.length)] as string;
          const hits = await index.search(viewer, query, { limit: 500 });
          found += hits.length;
          for (const h of hits) {
            const c = byKey.get(`${h.source.kind}:${h.source.id}`);
            if (!c || !canRead(fw.world, viewer, c.workspaceId, c.scope))
              leaks.push(`${JSON.stringify(viewer)} saw ${h.source.kind}:${h.source.id}`);
          }
        }
        expect(leaks).toEqual([]);
        // The fuzz only counts if search returns something: with no results, "nothing leaked" is empty.
        expect(found).toBeGreaterThan(100);
        // 200 queries plus loading the world: 4 to 10 s on a real Postgres, twice that on a busy runner.
      }, 120_000);
    }

    test("basic recall: a readable chunk with the word shows up", async () => {
      const fw = buildWorld(4);
      const index = await make(fw.world);
      for (const { source, chunk } of fw.chunks) await index.upsert(source, [chunk]);
      const viewer: Viewer = { workspaceId: fw.workspaceId, userId: "u1" };
      const expected = fw.chunks.filter(
        (c) =>
          c.chunk.text.split(" ").includes("delta") &&
          canRead(fw.world, viewer, c.chunk.workspaceId, c.chunk.scope),
      );
      const hits = await index.search(viewer, "delta", { limit: 500 });
      const got = new Set(hits.map((h) => h.source.id));
      expect(expected.filter((c) => !got.has(c.source.id)).map((c) => c.source.id)).toEqual([]);
    });

    test("removing, deleting and going private drop the chunk at once", async () => {
      const world: AccessWorld = {
        publicChannels: new Set(["pub"]),
        members: new Map([["pub", new Set(["user:u1"])]]),
        workspaceMembers: new Set(["user:u1", "user:u2"]),
      };
      const index = await make(world);
      const src: SourceRef = { kind: "wiki", id: "w1" };
      const chunk = (scope: ChunkScope): ChunkInput => ({
        workspaceId: "o",
        ordinal: 0,
        title: "Plano",
        text: "orçamento secreto",
        scope,
        url: "/w1",
        updatedAt: "2026-10-22T00:00:00Z",
      });
      const u2: Viewer = { workspaceId: "o", userId: "u2" };
      await index.upsert(src, [chunk({ kind: "channel", channelId: "pub" })]);
      expect((await index.search(u2, "orcamento")).length).toBe(1);
      await index.upsert(src, [chunk({ kind: "private", principals: ["user:u1"] })]);
      expect((await index.search(u2, "orcamento")).length).toBe(0);
      expect((await index.search({ workspaceId: "o", userId: "u1" }, "orcamento")).length).toBe(1);
      await index.remove(src);
      expect((await index.search({ workspaceId: "o", userId: "u1" }, "orcamento")).length).toBe(0);
      await index.upsert(src, [chunk({ kind: "workspace" })]);
      await index.upsert(src, []);
      expect((await index.search(u2, "orcamento")).length).toBe(0);
    });

    test("an agent searching for a person sees only the intersection", async () => {
      const world: AccessWorld = {
        publicChannels: new Set(),
        members: new Map([
          ["priv", new Set(["user:u1"])],
          ["bot", new Set(["agent:a1", "user:u2"])],
        ]),
        workspaceMembers: new Set(["user:u1", "user:u2"]),
      };
      const index = await make(world);
      const mk = (id: string, channelId: string): [SourceRef, ChunkInput[]] => [
        { kind: "message", id },
        [
          {
            workspaceId: "o",
            ordinal: 0,
            title: id,
            text: "relatório",
            scope: { kind: "channel", channelId },
            url: `/${id}`,
            updatedAt: "2026-10-22T00:00:00Z",
          },
        ],
      ];
      await index.upsert(...mk("m_priv", "priv"));
      await index.upsert(...mk("m_bot", "bot"));
      const ids = async (v: Viewer) => (await index.search(v, "relatorio")).map((h) => h.source.id).sort();
      expect(await ids({ workspaceId: "o", agentId: "a1" })).toEqual(["m_bot"]);
      expect(await ids({ workspaceId: "o", userId: "u1" })).toEqual(["m_priv"]);
      expect(await ids({ workspaceId: "o", userId: "u1", agentId: "a1" })).toEqual([]);
      expect(await ids({ workspaceId: "o", userId: "u2", agentId: "a1" })).toEqual(["m_bot"]);
    });
  });
}
