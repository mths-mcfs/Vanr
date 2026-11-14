// Reads the structure of the `public` schema from the system catalog: tables, columns, constraints,
// indexes, sequences, triggers, functions and extensions. Tests compare it against a recorded
// fixture to prove that the migrations produce exactly the expected database.

/** Runs a query and returns its rows. Works over PGlite and postgres.js alike. */
export type CatalogQuery = (text: string) => Promise<Record<string, unknown>[]>;

export interface CatalogColumn {
  table: string;
  name: string;
  type: string;
  notNull: boolean;
  default: string | null;
}

export interface CatalogConstraint {
  table: string;
  name: string;
  type: string;
  definition: string;
}

export interface CatalogIndex {
  table: string;
  name: string;
  definition: string;
}

export interface CatalogTrigger {
  table: string;
  name: string;
  definition: string;
}

export interface CatalogFunction {
  name: string;
  definition: string;
}

export interface Catalog {
  extensions: string[];
  tables: string[];
  columns: CatalogColumn[];
  constraints: CatalogConstraint[];
  indexes: CatalogIndex[];
  sequences: string[];
  triggers: CatalogTrigger[];
  functions: CatalogFunction[];
}

const QUERIES = {
  extensions: `select extname as name from pg_extension where extname <> 'plpgsql'`,
  tables: `select c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'`,
  columns: `select c.relname as table, a.attname as name, format_type(a.atttypid, a.atttypmod) as type,
      a.attnotnull as not_null, pg_get_expr(d.adbin, d.adrelid) as default
    from pg_attribute a
    join pg_class c on c.oid = a.attrelid
    join pg_namespace n on n.oid = c.relnamespace
    left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
    where n.nspname = 'public' and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped`,
  constraints: `select c.relname as table, k.conname as name, k.contype::text as type,
      pg_get_constraintdef(k.oid) as definition
    from pg_constraint k
    join pg_class c on c.oid = k.conrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'`,
  indexes: `select tablename as table, indexname as name, indexdef as definition
    from pg_indexes where schemaname = 'public'`,
  sequences: `select sequencename as name from pg_sequences where schemaname = 'public'`,
  triggers: `select c.relname as table, t.tgname as name, pg_get_triggerdef(t.oid) as definition
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and not t.tgisinternal`,
  // Functions that an extension owns (pg_trgm puts its own in `public`) are not ours.
  functions: `select p.proname as name, pg_get_functiondef(p.oid) as definition
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass
        and d.objid = p.oid and d.deptype = 'e')`,
} as const;

function str(row: Record<string, unknown>, key: string): string {
  const v = row[key];
  if (typeof v !== "string") throw new Error(`catalog: expected text in "${key}", got ${typeof v}`);
  return v;
}

function strOrNull(row: Record<string, unknown>, key: string): string | null {
  const v = row[key];
  return v === null || v === undefined ? null : str(row, key);
}

function bool(row: Record<string, unknown>, key: string): boolean {
  const v = row[key];
  if (typeof v !== "boolean") throw new Error(`catalog: expected boolean in "${key}", got ${typeof v}`);
  return v;
}

const byKey =
  <T>(key: (x: T) => string) =>
  (a: T, b: T) => {
    const ka = key(a);
    const kb = key(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  };

/** The catalog in a stable order, so two catalogs compare with a deep equality. */
export async function readCatalog(query: CatalogQuery): Promise<Catalog> {
  const names = async (text: string) => (await query(text)).map((r) => str(r, "name")).sort();
  return {
    extensions: await names(QUERIES.extensions),
    tables: await names(QUERIES.tables),
    columns: (await query(QUERIES.columns))
      .map((r) => ({
        table: str(r, "table"),
        name: str(r, "name"),
        type: str(r, "type"),
        notNull: bool(r, "not_null"),
        default: strOrNull(r, "default"),
      }))
      .sort(byKey((c) => `${c.table}.${c.name}`)),
    constraints: (await query(QUERIES.constraints))
      .map((r) => ({
        table: str(r, "table"),
        name: str(r, "name"),
        type: str(r, "type"),
        definition: str(r, "definition"),
      }))
      .sort(byKey((c) => `${c.table}.${c.name}`)),
    indexes: (await query(QUERIES.indexes))
      .map((r) => ({ table: str(r, "table"), name: str(r, "name"), definition: str(r, "definition") }))
      .sort(byKey((c) => `${c.table}.${c.name}`)),
    sequences: await names(QUERIES.sequences),
    triggers: (await query(QUERIES.triggers))
      .map((r) => ({ table: str(r, "table"), name: str(r, "name"), definition: str(r, "definition") }))
      .sort(byKey((c) => `${c.table}.${c.name}`)),
    functions: (await query(QUERIES.functions))
      .map((r) => ({ name: str(r, "name"), definition: str(r, "definition") }))
      .sort(byKey((c) => c.name)),
  };
}
