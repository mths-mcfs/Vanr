// Single writer of the agents' instructions and memory. Every path that changes an instruction or a
// memory item goes through here and records an immutable version: who, when, run and reason. Going
// back to a version means recording another one with its text. Nothing here deletes or edits a version.
import { type Db, schema } from "@vanr/engine/db";
import { newId } from "@vanr/engine/ids";
import {
  contentSha256,
  MEMORY_ITEM_MAX_BYTES,
  MEMORY_STORE_MAX_ITEMS,
  utf8Bytes,
  virtualPath,
} from "@vanr/engine/memory";
import { and, count, desc, eq, inArray, isNotNull, isNull, max, or, type SQL, sql } from "drizzle-orm";
import { isUniqueViolation } from "./db-errors";
import { conflict, HttpError, notFound } from "./http";

const { agents, memories, memoryVersions, instructionVersions } = schema;

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type MemoryRow = typeof memories.$inferSelect;
export type MemoryVersionRow = typeof memoryVersions.$inferSelect;
export type InstructionVersionRow = typeof instructionVersions.$inferSelect;

/** Who made the change. An agent carries the run, which goes into the version. */
export type Author =
  | { type: "person"; id: string }
  | { type: "agent"; id: string; runId: string | null }
  | { type: "system" };

const authorCols = (a: Author) => ({
  authorKind: a.type,
  authorId: a.type === "system" ? null : a.id,
});

// ---- instructions ----

type InstructionSource = InstructionVersionRow["source"];

async function nextInstructionSeq(tx: Tx, agentId: string): Promise<number> {
  const [row] = await tx
    .select({ seq: max(instructionVersions.seq) })
    .from(instructionVersions)
    .where(eq(instructionVersions.agentId, agentId));
  return (row?.seq ?? 0) + 1;
}

/** First version of a new agent (the text it was created with). */
export async function initialInstructions(
  db: Db,
  at: Date,
  agent: { id: string; workspaceId: string; instructions: string },
  author: Author,
): Promise<void> {
  await db.insert(instructionVersions).values({
    id: newId("ins"),
    workspaceId: agent.workspaceId,
    agentId: agent.id,
    seq: 1,
    text: agent.instructions,
    ...authorCols(author),
    reason: "",
    source: "create",
    createdAt: at,
  });
}

interface InstructionWrite {
  agentId: string;
  text: string;
  author: Author;
  reason: string;
  source: Exclude<InstructionSource, "initial" | "create">;
  /** Only replaces when the current text is this one (proposal, undo, redo). */
  expected?: string;
  proposalId?: string | null;
  restoredFromSeq?: number | null;
}

/**
 * Replaces the instructions and records the version, in a transaction with the agent locked (two writes
 * at once never take the same number). Returns null when `expected` doesn't match the current text. A text
 * equal to the current one records no version (`changed: false`).
 */
export async function writeInstructions(
  db: Db,
  at: Date,
  w: InstructionWrite,
): Promise<{ changed: boolean; version: InstructionVersionRow | null } | null> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        id: agents.id,
        workspaceId: agents.workspaceId,
        instructions: agents.instructions,
        archivedAt: agents.archivedAt,
      })
      .from(agents)
      .where(eq(agents.id, w.agentId))
      .for("update");
    if (!row) throw notFound("Agent not found");
    // Every write of the instructions comes here (edit, restore, an accepted proposal): an archived agent's stay.
    if (row.archivedAt) throw conflict("agent.archived", "This agent was archived");
    if (w.expected !== undefined && row.instructions !== w.expected) return null;
    if (row.instructions === w.text) return { changed: false, version: null };
    let seq = await nextInstructionSeq(tx, row.id);
    // An agent from before the history: the starting version keeps the text that was already there.
    if (seq === 1) {
      await tx.insert(instructionVersions).values({
        id: newId("ins"),
        workspaceId: row.workspaceId,
        agentId: row.id,
        seq: 1,
        text: row.instructions,
        authorKind: "system",
        authorId: null,
        source: "initial",
        createdAt: at,
      });
      seq = 2;
    }
    await tx.update(agents).set({ instructions: w.text, updatedAt: at }).where(eq(agents.id, row.id));
    const [version] = await tx
      .insert(instructionVersions)
      .values({
        id: newId("ins"),
        workspaceId: row.workspaceId,
        agentId: row.id,
        seq,
        text: w.text,
        ...authorCols(w.author),
        reason: w.reason,
        source: w.source,
        proposalId: w.proposalId ?? null,
        restoredFromSeq: w.restoredFromSeq ?? null,
        createdAt: at,
      })
      .returning();
    return { changed: true, version: version ?? null };
  });
}

// ---- memory ----

/** One of the three stores. */
export type Store =
  | { scope: "agent"; workspaceId: string; agentId: string }
  | { scope: "person"; workspaceId: string; userId: string }
  | { scope: "workspace"; workspaceId: string };

export function storeWhere(store: Store): SQL {
  switch (store.scope) {
    case "agent":
      return and(eq(memories.scope, "agent"), eq(memories.agentId, store.agentId)) as SQL;
    case "person":
      return and(
        eq(memories.scope, "person"),
        eq(memories.workspaceId, store.workspaceId),
        eq(memories.ownerUserId, store.userId),
      ) as SQL;
    case "workspace":
      return and(eq(memories.scope, "workspace"), eq(memories.workspaceId, store.workspaceId)) as SQL;
    default: {
      const _never: never = store;
      return _never;
    }
  }
}

function storeOf(row: Pick<MemoryRow, "scope" | "workspaceId" | "agentId" | "ownerUserId">): Store {
  if (row.scope === "person")
    return { scope: "person", workspaceId: row.workspaceId, userId: row.ownerUserId ?? "" };
  if (row.scope === "workspace") return { scope: "workspace", workspaceId: row.workspaceId };
  return { scope: "agent", workspaceId: row.workspaceId, agentId: row.agentId ?? "" };
}

const memoryTooBig = () =>
  new HttpError(413, "memory.too_big", `A memory holds up to ${MEMORY_ITEM_MAX_BYTES} bytes`);
const memoryExists = (path: string) => conflict("memory.exists", `The file ${path} already exists`, { path });
const memoryChanged = () => conflict("memory.changed", "The memory changed since you opened it", {});

interface VersionMeta {
  author: Author;
  reason?: string;
  approvedByUserId?: string | null;
  restoredFromSeq?: number | null;
}

async function insertVersion(
  tx: Tx,
  row: MemoryRow,
  op: MemoryVersionRow["op"],
  meta: VersionMeta,
  seq: number,
  at: Date,
): Promise<void> {
  await tx.insert(memoryVersions).values({
    id: newId("mv"),
    workspaceId: row.workspaceId,
    memoryId: row.id,
    seq,
    op,
    text: row.text,
    path: row.path,
    archived: row.archived,
    sha256: contentSha256(row.text),
    ...authorCols(meta.author),
    runId: meta.author.type === "agent" ? meta.author.runId : null,
    reason: meta.reason ?? "",
    approvedByUserId: meta.approvedByUserId ?? null,
    restoredFromSeq: meta.restoredFromSeq ?? null,
    createdAt: at,
  });
}

type NewMemory = Omit<typeof memories.$inferInsert, "id" | "createdAt" | "updatedAt"> & {
  origin: NonNullable<(typeof memories.$inferInsert)["origin"]>;
};

const storeKey = (store: Store) =>
  store.scope === "agent"
    ? `memory:agent:${store.agentId}`
    : store.scope === "person"
      ? `memory:person:${store.workspaceId}:${store.userId}`
      : `memory:workspace:${store.workspaceId}`;

/**
 * Is there room for one more active item in the store? Locks the store until the end of the transaction
 * (`pg_advisory_xact_lock`); otherwise two creations at once count the same number and both pass the cap.
 */
async function ensureRoom(tx: Tx, store: Store) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${storeKey(store)}))`);
  const [n] = await tx
    .select({ n: count() })
    .from(memories)
    .where(and(storeWhere(store), eq(memories.archived, false)));
  if ((n?.n ?? 0) >= MEMORY_STORE_MAX_ITEMS)
    throw conflict("memory.store_full", `A memory store holds up to ${MEMORY_STORE_MAX_ITEMS} items`);
}

/** Creates an item (with its origin, required) and version 1. */
export async function createMemory(
  db: Db,
  at: Date,
  values: NewMemory,
  meta: VersionMeta,
): Promise<MemoryRow> {
  if (utf8Bytes(values.text) > MEMORY_ITEM_MAX_BYTES) throw memoryTooBig();
  const store = storeOf({
    scope: values.scope ?? "agent",
    workspaceId: values.workspaceId,
    agentId: values.agentId ?? null,
    ownerUserId: values.ownerUserId ?? null,
  });
  try {
    return await db.transaction(async (tx) => {
      await ensureRoom(tx, store);
      const [row] = await tx
        .insert(memories)
        .values({ ...values, id: newId("mem"), createdAt: at, updatedAt: at })
        .returning();
      if (!row) throw new Error("memory insert returned nothing");
      await insertVersion(tx, row, "create", meta, 1, at);
      return row;
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw memoryExists(values.path ?? "");
    throw err;
  }
}

interface MemoryChange {
  text?: string;
  path?: string | null;
  archived?: boolean;
  textBefore?: string | null;
  editorUserId?: string | null;
  verified?: boolean;
  pinned?: boolean;
  untrustedSource?: boolean;
  replaces?: string | null;
}

/**
 * Changes an item and records the version. `expectedSha256` is the precondition against a concurrent
 * write: the current text must have that hash (otherwise `memory.changed`). `expectArchived` checks the
 * state before (undo of `memory_recorded`). An item from before the history gets the starting version.
 */
export async function changeMemory(
  db: Db,
  at: Date,
  id: string,
  change: MemoryChange,
  meta: VersionMeta & {
    op: MemoryVersionRow["op"];
    expectedSha256?: string;
    expectArchived?: boolean;
    /**
     * The path the caller saw (a move in between changes another file than the one it meant). `null`: it had no
     * path (a remembered note) and must still have none; omitted: not checked.
     */
    expectedPath?: string | null;
    /** Only the right store (the agent's tool doesn't change an item of another store). */
    store?: Store;
  },
): Promise<MemoryRow> {
  if (change.text !== undefined && utf8Bytes(change.text) > MEMORY_ITEM_MAX_BYTES) throw memoryTooBig();
  try {
    return await db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(memories)
        .where(and(eq(memories.id, id), meta.store ? storeWhere(meta.store) : undefined))
        .for("update");
      if (!row) throw notFound("Memory not found");
      if (meta.expectedSha256 !== undefined && contentSha256(row.text) !== meta.expectedSha256)
        throw memoryChanged();
      if (meta.expectArchived !== undefined && row.archived !== meta.expectArchived) throw memoryChanged();
      if (meta.expectedPath !== undefined && row.path !== meta.expectedPath) throw memoryChanged();
      // Coming back from the archive (unarchive, restore, redo) also takes a place in the store.
      if (row.archived && change.archived === false) await ensureRoom(tx, storeOf(row));
      const [last] = await tx
        .select({ seq: max(memoryVersions.seq) })
        .from(memoryVersions)
        .where(eq(memoryVersions.memoryId, row.id));
      let seq = (last?.seq ?? 0) + 1;
      if (seq === 1) {
        await insertVersion(tx, row, "initial", { author: { type: "system" } }, 1, row.updatedAt);
        seq = 2;
      }
      const [next] = await tx
        .update(memories)
        .set({ ...change, updatedAt: at })
        .where(eq(memories.id, row.id))
        .returning();
      if (!next) throw notFound("Memory not found");
      // Pinning is not a content change: it doesn't become a version.
      const content =
        next.text !== row.text ||
        next.path !== row.path ||
        next.archived !== row.archived ||
        meta.op === "restore";
      if (content) await insertVersion(tx, next, meta.op, meta, seq, at);
      return next;
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw memoryExists(change.path ?? "");
    throw err;
  }
}

export async function memoryVersionsOf(db: Db, memoryId: string): Promise<MemoryVersionRow[]> {
  return db
    .select()
    .from(memoryVersions)
    .where(eq(memoryVersions.memoryId, memoryId))
    .orderBy(memoryVersions.seq);
}

/** Restore = write again: the chosen version comes back as a new version (text, path and archived). */
export async function restoreMemory(
  db: Db,
  at: Date,
  memoryId: string,
  versionId: string,
  author: Author,
  reason: string,
): Promise<MemoryRow> {
  const [v] = await db
    .select()
    .from(memoryVersions)
    .where(and(eq(memoryVersions.id, versionId), eq(memoryVersions.memoryId, memoryId)));
  if (!v) throw notFound("Version not found");
  return changeMemory(
    db,
    at,
    memoryId,
    { text: v.text, path: v.path, archived: v.archived },
    { op: "restore", author, reason, restoredFromSeq: v.seq },
  );
}

/** Active items of the store without the text: path (null for a short note) and size, to list folders. */
export async function storeEntries(
  db: Db,
  store: Store,
): Promise<{ id: string; path: string | null; bytes: number }[]> {
  const rows = await db
    .select({ id: memories.id, path: memories.path, bytes: sql<number>`octet_length(${memories.text})` })
    .from(memories)
    .where(and(storeWhere(store), eq(memories.archived, false)))
    .orderBy(memories.path, memories.createdAt);
  return rows.map((r) => ({ ...r, bytes: Number(r.bytes) }));
}

/** Active items with a path inside the folder (an empty `dir` doesn't do: deleting the whole store doesn't exist). */
export async function itemsUnder(db: Db, store: Store, dir: string): Promise<MemoryRow[]> {
  return db
    .select()
    .from(memories)
    .where(
      and(
        storeWhere(store),
        eq(memories.archived, false),
        or(eq(memories.path, dir), sql`starts_with(${memories.path}, ${`${dir}/`})`),
      ),
    )
    .orderBy(memories.path);
}

export async function itemAtPath(db: Db, store: Store, path: string): Promise<MemoryRow | undefined> {
  const [row] = await db
    .select()
    .from(memories)
    .where(and(storeWhere(store), eq(memories.archived, false), eq(memories.path, path)));
  return row;
}

/** Short note from `remember` by id (in the tree, `remembered/<id>.md`). */
export async function rememberedItem(db: Db, store: Store, id: string): Promise<MemoryRow | undefined> {
  const [row] = await db
    .select()
    .from(memories)
    .where(and(storeWhere(store), eq(memories.archived, false), eq(memories.id, id), isNull(memories.path)));
  return row;
}

const FILES_IN_PROMPT = 50;

/**
 * Memory files the run sees, for the list in the prompt: the ones in the agent's store and in the
 * workspace's (up to 50 per store, with the size) and how many are in the store of the person who started
 * the run.
 */
async function memoryFilesFor(
  db: Db,
  run: { workspaceId: string; agentId: string; personId: string | null },
): Promise<string[]> {
  const stores: Store[] = [
    { scope: "agent", workspaceId: run.workspaceId, agentId: run.agentId },
    ...(run.personId
      ? [{ scope: "person", workspaceId: run.workspaceId, userId: run.personId } as const]
      : []),
    { scope: "workspace", workspaceId: run.workspaceId },
  ];
  const out: string[] = [];
  for (const store of stores) {
    if (store.scope === "person") {
      // Only the count: the name of a file about the person already says something about them, and the prompt
      // stays in the context even if someone else joins the conversation. Reading through the memory tool ties the run to them.
      const [row] = await db
        .select({ n: sql<number>`count(*)` })
        .from(memories)
        .where(and(storeWhere(store), eq(memories.archived, false), isNotNull(memories.path)));
      const n = Number(row?.n ?? 0);
      if (n > 0)
        out.push(`- ${virtualPath("person", "")}/: ${n} file(s) about the person who asked you (use view)`);
      continue;
    }
    const rows = await db
      .select({ path: memories.path, bytes: sql<number>`octet_length(${memories.text})` })
      .from(memories)
      .where(and(storeWhere(store), eq(memories.archived, false), isNotNull(memories.path)))
      .orderBy(memories.path)
      .limit(FILES_IN_PROMPT + 1);
    for (const r of rows.slice(0, FILES_IN_PROMPT))
      out.push(`- ${virtualPath(store.scope, r.path ?? "")} (${Number(r.bytes)} bytes)`);
    if (rows.length > FILES_IN_PROMPT) out.push(`- … more in ${virtualPath(store.scope, "")} (use view)`);
  }
  return out;
}

const MEMORY_LIMIT = 30;

/**
 * The memory part of the prompt: the short notes in the agent's store (up to 30, pinned and most used
 * first; the ones from an untrusted source marked) and the list of files in the stores the run sees.
 * The body of the files comes on demand through the memory tool.
 */
export async function memoryPrompt(
  db: Db,
  at: Date,
  run: { workspaceId: string; agentId: string; personId: string | null },
): Promise<string> {
  const mems = await db
    .select()
    .from(memories)
    .where(
      and(
        eq(memories.agentId, run.agentId),
        eq(memories.scope, "agent"),
        eq(memories.archived, false),
        isNull(memories.path),
      ),
    )
    .orderBy(desc(memories.pinned), desc(memories.uses), desc(memories.updatedAt))
    .limit(MEMORY_LIMIT);
  if (mems.length)
    await db
      .update(memories)
      .set({ uses: sql`${memories.uses} + 1`, lastUsedAt: at })
      .where(
        inArray(
          memories.id,
          mems.map((m) => m.id),
        ),
      );
  const files = await memoryFilesFor(db, run);
  const parts = [
    mems.length
      ? `# What you remember\n${mems
          .map(
            (m) =>
              `- [${m.id}] (${m.kind}${m.pinned ? ", pinned" : ""}${m.untrustedSource ? ", from an untrusted source" : ""}) ${m.text}`,
          )
          .join("\n")}`
      : "",
    files.length
      ? `# Memory files (read them with the memory tool; /memories/workspace is read only)\n${files.join("\n")}`
      : "",
  ];
  return parts.filter(Boolean).join("\n\n");
}
