// Bases: CSV in and out, and turning a Drive table into a database.
import type { ActorRef } from "@vanr/contract";
import { CsvError, inferColumns, matchHeader, parseCsv, toCsv, uniqueNames } from "@vanr/engine/bases/csv";
import { effectiveFilter, type ViewConfig } from "@vanr/engine/bases/view";
import { schema } from "@vanr/engine/db";
import { applyProps, multiNames, type PropDef, type Props, parsePropText } from "@vanr/engine/props";
import { and, eq, isNull } from "drizzle-orm";
import { channelInWorkspace } from "../channels";
import type { AppDeps } from "../context";
import { isUniqueViolation } from "../db-errors";
import { canSeeFile, contentOf, versionOf } from "../drive";
import { forbidden, HttpError, notFound } from "../http";
import {
  cellText,
  type DatabaseRow,
  databaseById,
  linkedTitles,
  namesOf,
  type TableRow,
  type ViewRow,
} from "./core";
import { queryRows } from "./query";
import { createDatabase, importRows, newOptionId, newPropId, refreshVolatile, scheduleRecalc } from "./write";

const { dbDatabases, files } = schema;

function csvError(err: unknown): never {
  if (err instanceof CsvError)
    throw new HttpError(400, `base.csv_${err.code}`, "Can't read this CSV", err.detail);
  throw err;
}

const OPTION_TYPES = new Set(["select", "multi_select", "status"]);

/** Options missing from the selects (a new name in the CSV becomes an option). */
function addMissingOptions(defs: PropDef[], cols: (PropDef | null)[], rows: string[][]): PropDef[] {
  const extra = new Map<string, Set<string>>();
  cols.forEach((def, i) => {
    if (!def || !OPTION_TYPES.has(def.type)) return;
    const known = new Set((def.options ?? []).map((o) => o.name.toLowerCase()));
    for (const r of rows) {
      const cell = (r[i] ?? "").trim();
      if (!cell) continue;
      const names = def.type === "multi_select" ? multiNames(cell) : [cell];
      for (const n of names) {
        if (!n || known.has(n.toLowerCase())) continue;
        const set = extra.get(def.id) ?? new Set<string>();
        if ((def.options?.length ?? 0) + set.size < 200) set.add(n.slice(0, 100));
        extra.set(def.id, set);
      }
    }
  });
  return defs.map((d) => {
    const add = extra.get(d.id);
    if (!add?.size) return d;
    const options = [...(d.options ?? []), ...[...add].map((name) => ({ id: newOptionId(), name }))];
    return {
      ...d,
      options,
      ...(d.type === "status" && d.groups
        ? {
            groups: {
              ...d.groups,
              todo: [...d.groups.todo, ...options.slice(d.options?.length ?? 0).map((o) => o.id)],
            },
          }
        : {}),
    };
  });
}

/** Cells → values by the schema; a cell that doesn't convert is skipped (counted in `skipped`). */
function rowsToProps(defs: readonly PropDef[], cols: (PropDef | null)[], rows: string[][]) {
  let skipped = 0;
  const out: Props[] = rows.map((r) => {
    const props: Props = {};
    cols.forEach((col, i) => {
      if (!col) return;
      const def = defs.find((d) => d.id === col.id) as PropDef;
      const text = r[i] ?? "";
      if (!text.trim()) return;
      const value = parsePropText(def, text);
      const ok = value === undefined ? null : applyProps([def], {}, { [def.id]: value });
      if (ok?.ok && ok.props[def.id] !== undefined) props[def.id] = ok.props[def.id] as Props[string];
      else skipped++;
    });
    return props;
  });
  return { props: out, skipped };
}

/** Imports a CSV into a source: matches the header by name, creates the missing columns and appends the rows. */
export async function importCsv(deps: AppDeps, table: TableRow, csv: string, actor: ActorRef) {
  let parsed: string[][];
  try {
    parsed = parseCsv(csv);
  } catch (err) {
    csvError(err);
  }
  const [header = [], ...rows] = parsed;
  const matched = matchHeader(header, table.defs);
  const missing = header.map((h, i) => (matched[i] ? null : { i, name: h.trim() })).filter((x) => x !== null);
  const inferred = inferColumns(header, rows, newOptionId);
  const names = uniqueNames(
    missing.map((m) => m.name || `Column ${m.i + 1}`),
    table.defs.map((d) => d.name),
  );
  const added: PropDef[] = missing.map((m, k) => {
    const col = inferred[m.i];
    return {
      id: newPropId(),
      name: names[k] as string,
      type: m.i === 0 ? "text" : (col?.type ?? "text"),
      ...(col?.options && m.i !== 0 ? { options: col.options } : {}),
    };
  });
  const cols = header.map((_, i) => matched[i] ?? added[missing.findIndex((m) => m.i === i)] ?? null);
  const defs = addMissingOptions([...table.defs, ...added], cols, rows);
  let skipped = 0;
  const done = await importRows(deps, table, {
    defs: JSON.stringify(defs) !== JSON.stringify(table.defs) ? defs : null,
    rows: (fresh) => {
      const out = rowsToProps(fresh.defs, cols, rows);
      skipped = out.skipped;
      return out.props;
    },
    actor,
  });
  return { created: done.created, skipped, addedProps: added.map((d) => d.id), table: done.table };
}

/** A new database from a CSV: inferred types, the first column is the title. */
export async function createFromCsv(
  deps: AppDeps,
  workspaceId: string,
  title: string,
  csv: string,
  actor: ActorRef,
) {
  let parsed: string[][];
  try {
    parsed = parseCsv(csv);
  } catch (err) {
    csvError(err);
  }
  const [header = [], ...rows] = parsed;
  return createWithRows(deps, { workspaceId, title, header, rows, actor });
}

async function createWithRows(
  deps: AppDeps,
  input: {
    workspaceId: string;
    title: string;
    header: string[];
    rows: string[][];
    actor: ActorRef;
    sourceFileId?: string;
  },
): Promise<DatabaseRow> {
  const cols = inferColumns(input.header, input.rows, newOptionId);
  const names = uniqueNames(cols.map((c) => c.name));
  const defs: PropDef[] = cols.map((c, i) => ({
    id: newPropId(),
    name: names[i] as string,
    type: c.type,
    ...(c.options ? { options: c.options } : {}),
  }));
  if (!defs.length) defs.push({ id: newPropId(), name: "Name", type: "text" });
  // the database, its rows and its source in a single transaction: a failure halfway leaves no half database
  return createDatabase(deps, {
    workspaceId: input.workspaceId,
    title: input.title,
    actor: input.actor,
    defs,
    titlePropId: (defs[0] as PropDef).id,
    rows: rowsToProps(defs, defs, input.rows).props,
    ...(input.sourceFileId ? { sourceFileId: input.sourceFileId } : {}),
  });
}

/** The source's CSV: in the order, the filter and the columns of the view, if there is one. */
export async function exportCsv(deps: AppDeps, table: TableRow, view: ViewRow | null, me: ActorRef) {
  table = await refreshVolatile(deps, table);
  if (table.calcDoneVersion < table.calcVersion) await scheduleRecalc(deps, table.id);
  const cfg: ViewConfig = view?.config ?? {};
  const hidden = new Set((cfg.columns ?? []).filter((c) => c.hidden).map((c) => c.prop));
  const ordered = (cfg.columns ?? []).map((c) => c.prop);
  const defs = [
    ...ordered.map((id) => table.defs.find((d) => d.id === id)).filter((d): d is PropDef => Boolean(d)),
    ...table.defs.filter((d) => !ordered.includes(d.id)),
  ].filter((d) => !hidden.has(d.id) || d.id === table.titlePropId);
  const title = defs.find((d) => d.id === table.titlePropId);
  const cols = title ? [title, ...defs.filter((d) => d !== title)] : defs;
  const names = await namesOf(deps.db, table.workspaceId);
  const lines: string[][] = [cols.map((d) => d.name)];
  const filter = effectiveFilter(cfg, table.defs);
  let cursor: string | null = null;
  do {
    const page = await queryRows(
      deps.db,
      table,
      { filter, sorts: cfg.sorts, limit: 500, cursor },
      { now: deps.now().getTime(), me },
    );
    // a relation goes out as the titles of the linked rows (an id says nothing in a spreadsheet)
    const linked = await linkedTitles(deps.db, table, page.rows);
    for (const r of page.rows) lines.push(cols.map((d) => cellText(d, r, names, linked)));
    cursor = page.nextCursor;
  } while (cursor);
  const [db] = await deps.db
    .select({ title: dbDatabases.title })
    .from(dbDatabases)
    .where(eq(dbDatabases.id, table.databaseId));
  const base =
    (db?.title ?? "database")
      .replace(/[^\p{L}\p{N} _-]+/gu, "")
      .trim()
      .slice(0, 80) || "database";
  return { fileName: `${base}.csv`, csv: toCsv(lines) };
}

/**
 * A Drive table → a database. Only from a table the whole workspace reads (no channel, or a public channel):
 * the database belongs to the whole workspace, so bringing a table from a private channel or a DM would leak
 * its content. Running it again returns the same database.
 */
export async function databaseFromFile(deps: AppDeps, workspaceId: string, fileId: string, actor: ActorRef) {
  const { db } = deps;
  const [file] = await db
    .select()
    .from(files)
    .where(and(eq(files.id, fileId), eq(files.workspaceId, workspaceId), isNull(files.deletedAt)));
  if (!file || !(await canSeeFile(db, file, actor))) throw notFound("File not found");
  if (file.kind !== "table")
    throw new HttpError(400, "base.not_a_table", "Only Drive tables become databases");
  if (file.channelId) {
    const channel = await channelInWorkspace(db, workspaceId, file.channelId);
    if (channel?.kind !== "channel" || channel.visibility !== "public") {
      throw forbidden("Tables from private channels and DMs can't become workspace-wide databases");
    }
  }
  const [existing] = await db
    .select()
    .from(dbDatabases)
    .where(and(eq(dbDatabases.workspaceId, workspaceId), eq(dbDatabases.sourceFileId, file.id)));
  if (existing) return existing;
  const content = contentOf(await versionOf(db, file));
  if (content.kind !== "table")
    throw new HttpError(400, "base.not_a_table", "Only Drive tables become databases");
  // The database, its rows and its source go in together. Two conversions at the same time: the unique index
  // on the source brings the second transaction down whole, and it returns the first one.
  try {
    const created = await createWithRows(deps, {
      workspaceId,
      title: file.title,
      header: content.columns,
      rows: content.rows,
      actor,
      sourceFileId: file.id,
    });
    return databaseById(db, workspaceId, created.id);
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const [winner] = await db
      .select()
      .from(dbDatabases)
      .where(and(eq(dbDatabases.workspaceId, workspaceId), eq(dbDatabases.sourceFileId, file.id)));
    if (!winner) throw err;
    return winner;
  }
}
