// Undo and redo of what an agent wrote in a database (upsert_base_rows). Before touching anything, it checks
// every row: if someone edited one after the agent, nothing changes (`action.changed_since`). Undo deletes the
// rows created and gives the edited ones their values from before; redo writes again.
import type { ActorRef } from "@vanr/contract";
import { schema } from "@vanr/engine/db";
import type { Props } from "@vanr/engine/props";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { AppDeps } from "../context";
import type { ActionRow, Undoer } from "../forward-types";
import { HttpError } from "../http";
import type { TableRow, Tx } from "./core";
import { rewriteRows } from "./write";

const { reversibleActions, dbTables, dbRows } = schema;

const changed = (message: string) => new HttpError(409, "action.changed_since", message);
const person = (userId: string): ActorRef => ({ type: "person", id: userId });

// The action's params are read back from the database: each value is checked against the stored shape.
const actorSchema = z.object({ type: z.enum(["person", "agent"]), id: z.string() });
const propsSchema = z.record(
  z.string(),
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.array(z.string()),
    z.object({ start: z.string(), end: z.string().optional() }),
    actorSchema,
    z.array(actorSchema),
    z.null(),
  ]),
);
const params = z.object({
  tableId: z.string(),
  created: z.array(z.string()),
  updated: z.array(
    z.object({ id: z.string(), before: propsSchema, after: propsSchema, version: z.number().int() }),
  ),
  /** Rows created that the undo deleted (the redo creates them again). */
  removed: z.array(z.object({ props: propsSchema, body: z.string().nullable() })).optional(),
});
type Params = z.infer<typeof params>;

async function tableOf(deps: AppDeps, row: ActionRow): Promise<{ p: Params; table: TableRow }> {
  const p = params.parse(row.params);
  const [table] = await deps.db
    .select()
    .from(dbTables)
    .where(and(eq(dbTables.id, p.tableId), eq(dbTables.workspaceId, row.workspaceId)));
  if (!table) throw new HttpError(409, "action.gone", "The database no longer exists");
  return { p, table };
}

/** The write that leaves the row with exactly `target` (whatever is left over becomes null). */
function replaceWith(table: TableRow, current: Props, target: Props): Record<string, unknown> {
  const writable = new Set(table.defs.map((d) => d.id));
  const out: Record<string, unknown> = {};
  for (const k of new Set([...Object.keys(current), ...Object.keys(target)])) {
    if (!writable.has(k)) {
      if (k in target) throw changed("The database's properties changed");
      continue;
    }
    if (JSON.stringify(current[k]) !== JSON.stringify(target[k])) out[k] = target[k] ?? null;
  }
  return out;
}

/** Checks the edited rows (all at the expected version) before writing any of them. */
async function checkUpdated(tx: Tx, table: TableRow, updated: Params["updated"]) {
  if (!updated.length) return new Map<string, Props>();
  const rows = await tx
    .select({ id: dbRows.id, version: dbRows.version, props: dbRows.props })
    .from(dbRows)
    .where(
      and(
        eq(dbRows.tableId, table.id),
        inArray(
          dbRows.id,
          updated.map((u) => u.id),
        ),
      ),
    )
    .for("update");
  for (const u of updated) {
    const now = rows.find((r) => r.id === u.id);
    if (!now || now.version !== u.version) throw changed("Someone changed a row after the agent");
  }
  return new Map(rows.map((r) => [r.id, r.props]));
}

/** A value from before that the current schema rejects (a deleted option, a changed type) is also "changed since". */
function asChanged(err: unknown): never {
  if (err instanceof HttpError && err.code === "base.invalid_props")
    throw changed("The database's properties changed after the agent");
  throw err;
}

type Ops = Parameters<Parameters<typeof rewriteRows>[3]>[0];

/** Takes the edited rows back to `side`; returns the new versions (the next undo or redo checks them). */
async function rewrite(ops: Ops, updated: Params["updated"], side: "before" | "after") {
  const current = await checkUpdated(ops.tx, ops.table, updated);
  const out: Params["updated"] = [];
  for (const u of updated) {
    const write = replaceWith(ops.table, current.get(u.id) ?? {}, u[side]);
    const saved = await ops.update(u.id, { props: write, parentVersion: u.version }).catch(asChanged);
    out.push({ ...u, version: saved.version });
  }
  return out;
}

async function setParams(tx: Tx, row: ActionRow, next: Partial<Params>) {
  await tx
    .update(reversibleActions)
    .set({ params: { ...row.params, ...next } })
    .where(eq(reversibleActions.id, row.id));
}

// Undo and redo run in a single transaction (the rows and the action's params): either everything goes back,
// or nothing changes. One transaction per row would leave the first row reverted for good when the second fails.
export const BASE_UNDOERS: Record<"base_rows_upserted", Undoer> = {
  base_rows_upserted: {
    async undo(deps, row, actorUserId) {
      const { p, table } = await tableOf(deps, row);
      await rewriteRows(deps, table, person(actorUserId), async (ops) => {
        const made = p.created.length
          ? await ops.tx
              .select()
              .from(dbRows)
              .where(and(eq(dbRows.tableId, table.id), inArray(dbRows.id, p.created)))
              .for("update")
          : [];
        if (made.some((r) => r.version > 1)) throw changed("Someone edited a row the agent created");
        const updated = await rewrite(ops, p.updated, "before");
        await ops.remove(made.map((r) => r.id));
        await setParams(ops.tx, row, {
          updated,
          created: [],
          removed: made.map((r) => ({ props: r.props, body: r.body })),
        });
      });
    },
    async redo(deps, row, actorUserId) {
      const { p, table } = await tableOf(deps, row);
      await rewriteRows(deps, table, person(actorUserId), async (ops) => {
        const updated = await rewrite(ops, p.updated, "after");
        const created: string[] = [];
        for (const r of p.removed ?? []) {
          const made = await ops
            .create({ props: r.props, ...(r.body ? { body: r.body } : {}) })
            .catch(asChanged);
          created.push(made.id);
        }
        await setParams(ops.tx, row, { updated, created, removed: [] });
      });
    },
  },
};
