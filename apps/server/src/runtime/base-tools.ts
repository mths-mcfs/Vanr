// Base tools: the agent reads the schema, queries and writes rows. Everything goes by the names of the
// properties and of the options (the model doesn't need to learn ids). Writing to a row that exists asks for
// the version read (`parentVersion`): if someone saved after, the row comes back with the current values and
// the agent decides again, without overwriting.
import type { ActorRef, BaseLinkedRow } from "@vanr/contract";
import { effectiveFilter, type Filter, filterSchema, type Sort } from "@vanr/engine/bases/view";
import { schema } from "@vanr/engine/db";
import { resolveProp } from "@vanr/engine/formula/index";
import { rewritePropRefs } from "@vanr/engine/formula/syntax";
import { isStorable, type PropDef, parsePropText } from "@vanr/engine/props";
import { and, desc, eq, ilike, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  cellText,
  type DatabaseRow,
  databaseById,
  linkedTitles,
  namesOf,
  type RowRow,
  rowCounts,
  type TableRow,
} from "../bases/core";
import { queryRows } from "../bases/query";
import { refreshVolatile, rewriteRows, touchDatabase } from "../bases/write";
import { HttpError } from "../http";
import { define, type ToolContext, type ToolDef, ToolInputError } from "./tools";

const { dbDatabases, dbTables, dbViews, dbRows } = schema;
/** The model's input: text with a NUL or half of a surrogate pair would reach SQL and fail in Postgres. */
const storable = <S extends z.ZodType>(input: S) =>
  input.refine(isStorable, { message: "Text with a NUL or a broken character" });
/** `define` with the input checked as storable at the boundary (the content and memory tools use it too). */
export const defineStored = <I>(def: ToolDef<I>) => define({ ...def, input: storable(def.input) });
// the same `self` and `domain` as content-tools.ts (importing from there would make a cycle with AGENT_TOOLS)
const self = (ctx: ToolContext): ActorRef => ({ type: "agent", id: ctx.agent.id });
async function domain<T>(work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (err) {
    if (err instanceof HttpError) throw new ToolInputError(err.message);
    throw err;
  }
}

const escapeLike = (s: string) => s.replace(/[%_\\]/g, "\\$&");

/** A database by its id or by its exact title (case does not matter). */
async function findBase(ctx: ToolContext, ref: string): Promise<{ base: DatabaseRow; table: TableRow }> {
  const { db } = ctx.deps;
  let base: DatabaseRow | undefined;
  if (ref.startsWith("dbs_")) base = await databaseById(db, ctx.workspaceId, ref).catch(() => undefined);
  if (!base) {
    const found = await db
      .select()
      .from(dbDatabases)
      .where(and(eq(dbDatabases.workspaceId, ctx.workspaceId), ilike(dbDatabases.title, escapeLike(ref))))
      .limit(2);
    if (found.length > 1) throw new ToolInputError(`More than one database is called "${ref}"; use its id`);
    base = found[0];
  }
  if (!base) throw new ToolInputError(`Database ${ref} not found. Use list_bases.`);
  // a linked view: the source is the first view's
  const [own] = await db.select().from(dbTables).where(eq(dbTables.databaseId, base.id)).limit(1);
  if (own) return { base, table: own };
  const [view] = await db.select().from(dbViews).where(eq(dbViews.databaseId, base.id)).limit(1);
  const [linked] = view
    ? await db
        .select()
        .from(dbTables)
        .where(and(eq(dbTables.id, view.tableId), eq(dbTables.workspaceId, ctx.workspaceId)))
    : [];
  if (!linked) throw new ToolInputError(`Database ${ref} has no rows to show`);
  return { base, table: linked };
}

function propOf(table: TableRow, ref: string): PropDef {
  const def = resolveProp(table.defs, ref);
  if (!def) throw new ToolInputError(`Unknown property "${ref}". Use read_base_schema.`);
  return def;
}

const optionId = (def: PropDef, v: unknown) =>
  typeof v === "string"
    ? (def.options?.find((o) => o.id === v || o.name.toLowerCase() === v.toLowerCase())?.id ?? v)
    : v;

/** The model's filter (names) → the stored filter (property and option ids). */
function toFilter(table: TableRow, raw: unknown, depth = 0): Filter {
  if (depth > 3 || !raw || typeof raw !== "object") throw new ToolInputError("Invalid filter");
  const o = raw as Record<string, unknown>;
  if (Array.isArray(o.and)) return { and: o.and.map((f) => toFilter(table, f, depth + 1)) };
  if (Array.isArray(o.or)) return { or: o.or.map((f) => toFilter(table, f, depth + 1)) };
  if (typeof o.prop !== "string") throw new ToolInputError("Invalid filter: prop is a property name");
  const def = propOf(table, o.prop);
  let value = o.value;
  if (def.options && o.op !== "group")
    value = Array.isArray(value) ? value.map((v) => optionId(def, v)) : optionId(def, value);
  const parsed = filterSchema.safeParse({
    prop: def.id,
    op: o.op,
    ...(value === undefined ? {} : { value }),
  });
  if (!parsed.success) throw new ToolInputError(`Invalid filter on "${def.name}"`);
  return parsed.data;
}

function describeDef(def: PropDef, table: TableRow): string {
  const bits = [`- ${def.name} (${def.type}${def.id === table.titlePropId ? ", title" : ""})`];
  if (def.options?.length) bits.push(`options: ${def.options.map((o) => o.name).join(", ")}`);
  if (def.groups) {
    const name = (id: string) => def.options?.find((o) => o.id === id)?.name ?? id;
    bits.push(
      `groups: todo=[${def.groups.todo.map(name).join(", ")}] in_progress=[${def.groups.inProgress.map(name).join(", ")}] done=[${def.groups.done.map(name).join(", ")}]`,
    );
  }
  if (def.formula) {
    const byName = rewritePropRefs(
      def.formula.expression,
      (ref) => table.defs.find((d) => d.id === ref)?.name,
    );
    bits.push(`= ${byName} → ${def.formula.resultType ?? "any"}`);
  }
  if (def.relation) bits.push(`links rows of table ${def.relation.tableId} (write a list of row ids)`);
  if (def.rollup) {
    const rel = table.defs.find((d) => d.id === def.rollup?.relationPropId)?.name ?? "?";
    bits.push(`= ${def.rollup.fn} over "${rel}" → ${def.rollup.resultType ?? "any"} (read-only)`);
  }
  return bits.join(" · ");
}

const listBases = define({
  name: "list_bases",
  description: "List the workspace's databases (tables with typed properties).",
  effect: "K0",
  input: storable(z.object({ q: z.string().trim().max(200).optional() })),
  async run(ctx, input) {
    const { db } = ctx.deps;
    const where = input.q
      ? and(
          eq(dbDatabases.workspaceId, ctx.workspaceId),
          ilike(dbDatabases.title, `%${escapeLike(input.q)}%`),
        )
      : eq(dbDatabases.workspaceId, ctx.workspaceId);
    const rows = await db
      .select()
      .from(dbDatabases)
      .where(where)
      .orderBy(desc(dbDatabases.updatedAt))
      .limit(50);
    if (!rows.length) return "No databases found.";
    const tables = await db
      .select({ id: dbTables.id, databaseId: dbTables.databaseId })
      .from(dbTables)
      .where(
        inArray(
          dbTables.databaseId,
          rows.map((r) => r.id),
        ),
      );
    const counts = await rowCounts(
      db,
      tables.map((t) => t.id),
    );
    return rows
      .map((r) => {
        const n = tables
          .filter((t) => t.databaseId === r.id)
          .reduce((s, t) => s + (counts.get(t.id) ?? 0), 0);
        return `${r.id} · "${r.title}" · ${n} rows${r.kind === "linked" ? " · linked view" : ""}`;
      })
      .join("\n");
  },
});

const readBaseSchema = define({
  name: "read_base_schema",
  description:
    "Read a database's properties (name, type, options, formulas) before querying or writing rows. Pass the id or the exact title.",
  effect: "K0",
  input: storable(z.object({ base: z.string().trim().min(1).max(200) })),
  async run(ctx, input) {
    const { base, table } = await findBase(ctx, input.base);
    const views = await ctx.deps.db
      .select({ name: dbViews.name, type: dbViews.type })
      .from(dbViews)
      .where(eq(dbViews.databaseId, base.id));
    return [
      `# ${base.title} (${base.id})`,
      `Schema version ${table.schemaVersion}. Properties:`,
      ...table.defs.map((d) => describeDef(d, table)),
      `Views: ${views.map((v) => `${v.name || "Table"} (${v.type})`).join(", ")}`,
      'Filter ops: text eq|neq|contains|starts_with|empty; number eq|gt|gte|lt|lte; select/status eq|in|group; multi_select has|has_any|has_all; person has ("me" or {type,id}); date eq|before|after|between (YYYY-MM-DD or {rel:"today"}); checkbox eq.',
    ].join("\n");
  },
});

function rowLine(
  table: TableRow,
  row: RowRow,
  names: Awaited<ReturnType<typeof namesOf>>,
  linked: Record<string, BaseLinkedRow> = {},
) {
  const values: Record<string, string> = {};
  for (const def of table.defs) {
    // a relation: the title and the id of each linked row (the id is what the agent writes back)
    const ids = def.type === "relation" ? row.props[def.id] : undefined;
    const text = Array.isArray(ids)
      ? ids
          .filter((id) => linked[String(id)])
          .map((id) => `${linked[String(id)]?.title} [${id}]`)
          .join(", ")
      : cellText(def, row, names);
    if (text) values[def.name] = text.length > 500 ? `${text.slice(0, 499)}…` : text;
  }
  return JSON.stringify({ id: row.id, parentVersion: row.version, values });
}

const queryBase = define({
  name: "query_base",
  description:
    'Query rows of a database. Filter by property and option names, e.g. {"and":[{"prop":"Status","op":"eq","value":"Done"},{"prop":"Due","op":"before","value":{"rel":"today"}}]}. Each row comes with its parentVersion (pass it back to upsert_base_rows).',
  effect: "K0",
  input: storable(
    z.object({
      base: z.string().trim().min(1).max(200),
      view: z.string().max(100).optional(),
      filter: z.unknown().optional(),
      sorts: z
        .array(z.object({ prop: z.string().max(100), dir: z.enum(["asc", "desc"]).default("asc") }))
        .max(5)
        .optional(),
      search: z.string().max(200).optional(),
      limit: z.number().int().min(1).max(100).default(25),
      cursor: z.string().max(20).optional(),
    }),
  ),
  async run(ctx, input) {
    const found = await findBase(ctx, input.base);
    const table = await refreshVolatile(ctx.deps, found.table);
    let filter: Filter | null = input.filter === undefined ? null : toFilter(table, input.filter);
    let sorts: Sort[] | undefined = input.sorts?.map((s) => ({ prop: propOf(table, s.prop).id, dir: s.dir }));
    if (input.view) {
      const views = await ctx.deps.db.select().from(dbViews).where(eq(dbViews.databaseId, found.base.id));
      const view = views.find(
        (v) => v.id === input.view || v.name.toLowerCase() === input.view?.toLowerCase(),
      );
      if (!view || view.tableId !== table.id) throw new ToolInputError(`View "${input.view}" not found`);
      filter = effectiveFilter(view.config, table.defs, filter);
      sorts ??= view.config.sorts;
    }
    const page = await domain(
      queryRows(
        ctx.deps.db,
        table,
        { filter, sorts, search: input.search, limit: input.limit, cursor: input.cursor ?? null },
        { now: ctx.deps.now().getTime(), me: self(ctx) },
      ),
    );
    const names = await namesOf(ctx.deps.db, ctx.workspaceId);
    const linked = await linkedTitles(ctx.deps.db, table, page.rows);
    const head = `${page.total} rows match${page.nextCursor ? ` (next cursor: ${page.nextCursor})` : ""}.`;
    return [head, ...page.rows.map((r) => rowLine(table, r, names, linked))].join("\n");
  },
});

/** The value the model sent → the stored value: text becomes the property's type (an option by its name). */
function toValue(def: PropDef, v: unknown): unknown {
  if (v === null) return null;
  if (def.type === "text" || def.type === "url") {
    if (typeof v === "string") return v;
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    throw new ToolInputError(`"${def.name}" takes text`);
  }
  if (def.type === "relation" && typeof v === "string")
    return v
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
  if (typeof v === "string") {
    if (def.type === "file" || def.type === "person") return v;
    const parsed = parsePropText(def, v);
    if (parsed === undefined) throw new ToolInputError(`"${v}" is not a valid ${def.type} for "${def.name}"`);
    return parsed;
  }
  if (def.type === "multi_select" && Array.isArray(v)) return v.map((x) => optionId(def, x));
  return v;
}

function toWrite(table: TableRow, values: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(values)) {
    const def = propOf(table, key);
    out[def.id] = toValue(def, v);
  }
  return out;
}

const upsertRow = z.object({
  id: z.string().max(100).optional(),
  parentVersion: z.number().int().min(1).optional(),
  values: z.record(z.string().max(100), z.unknown()),
});

const NOTHING_SAVED = "Nothing was saved: fix this and send the whole batch again.";

const upsertBaseRows = define({
  name: "upsert_base_rows",
  description:
    "Create or change rows of a database when someone asks. Rows without id are created. To change a row, pass its id and the parentVersion you read (query_base); if someone saved it after, you get the current values back and nothing is overwritten. The batch saves whole or not at all. Values by property name; select/status by option name; null clears.",
  effect: "K1",
  input: storable(
    z.object({ base: z.string().trim().min(1).max(200), rows: z.array(upsertRow).min(1).max(50) }),
  ),
  async run(ctx, input) {
    const { base, table } = await findBase(ctx, input.base);
    const names = await namesOf(ctx.deps.db, ctx.workspaceId);
    // Every row is checked before anything is written: one wrong row leaves the whole batch out.
    const problems: string[] = [];
    const planned: { n: number; id?: string; parentVersion?: number; props: Record<string, unknown> }[] = [];
    for (const [i, r] of input.rows.entries()) {
      try {
        const props = toWrite(table, r.values);
        if (r.id && r.parentVersion === undefined)
          problems.push(`#${i + 1} ${r.id}: pass the parentVersion you read with query_base`);
        else planned.push({ n: i + 1, id: r.id, parentVersion: r.parentVersion, props });
      } catch (err) {
        if (!(err instanceof ToolInputError)) throw err;
        problems.push(`#${i + 1} not saved: ${err.message}`);
      }
    }
    if (problems.length) return { content: [...problems, NOTHING_SAVED].join("\n"), isError: true };
    const created: string[] = [];
    const updated: { id: string; before: RowRow["props"]; after: RowRow["props"]; version: number }[] = [];
    const lines: string[] = [];
    let at: (typeof planned)[number] | undefined;
    try {
      // The rows and the receipt in one transaction: all of it or none, and an undo that covers exactly it.
      await rewriteRows(ctx.deps, table, self(ctx), async (ops) => {
        for (const p of planned) {
          at = p;
          if (!p.id) {
            const row = await ops.create({ props: p.props });
            created.push(row.id);
            lines.push(`#${p.n} created ${row.id} (parentVersion 1)`);
            continue;
          }
          const [prev] = await ops.tx
            .select({ props: dbRows.props })
            .from(dbRows)
            .where(and(eq(dbRows.id, p.id), eq(dbRows.tableId, ops.table.id)));
          const row = await ops.update(p.id, { props: p.props, parentVersion: p.parentVersion });
          // the same row twice in the call is one entry (the first one's before, the last one's version): the
          // undo checks one version per row
          const again = updated.find((u) => u.id === row.id);
          if (again) Object.assign(again, { after: row.props, version: row.version });
          else
            updated.push({ id: row.id, before: prev?.props ?? {}, after: row.props, version: row.version });
          lines.push(`#${p.n} updated ${row.id} (parentVersion ${row.version})`);
        }
        await ctx.recordAction(
          {
            kind: "base_rows_upserted",
            target: { type: "base", id: base.id, title: base.title },
            params: { tableId: table.id, created, updated },
          },
          ops.tx,
        );
      });
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      const n = at?.n ?? 1;
      if (err.code === "base.row_conflict") {
        const [current] = await ctx.deps.db
          .select()
          .from(dbRows)
          .where(and(eq(dbRows.id, at?.id ?? ""), eq(dbRows.tableId, table.id)));
        const now = current ? rowLine(table, current, names) : "deleted";
        return {
          content: `#${n} conflict: someone saved ${at?.id} after you read it. Now: ${now}\n${NOTHING_SAVED}`,
          isError: true,
        };
      }
      const detail = err.params ? ` ${JSON.stringify(err.params).slice(0, 300)}` : "";
      return { content: `#${n} not saved: ${err.message}${detail}\n${NOTHING_SAVED}`, isError: true };
    }
    await touchDatabase(ctx.deps.db, base.id, ctx.deps.now());
    return lines.join("\n");
  },
});

export const BASE_TOOLS: readonly ToolDef<unknown>[] = [listBases, readBaseSchema, queryBase, upsertBaseRows];
