// Databases. A database (`db_databases`, id `dbs_`) is the container with a title, views and a
// placement (standalone, embedded in a wiki page or linked to another database); the data source
// (`db_tables`, id `dbt_`) holds the property schema and the rows. Today each database has one source;
// keeping the ids apart means adding a second source later needs no migration.

import type { BasePropDef, BaseViewConfig } from "@vanr/contract";
import { sql } from "drizzle-orm";
import { index, integer, jsonb, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { createdAt, ts, updatedAt } from "./columns";
import type { Actor } from "./content";
import type { Props } from "./json";
import { workspaces } from "./workspaces";

const workspace = () =>
  text("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" });

export const dbDatabases = pgTable(
  "db_databases",
  {
    id: text("id").primaryKey(),
    workspaceId: workspace(),
    title: text("title").notNull(),
    icon: text("icon"),
    /** `database` has its own source; `linked` only shows views of other databases' sources. */
    kind: text("kind", { enum: ["database", "linked"] })
      .notNull()
      .default("database"),
    /** Wiki page the database is embedded in (inline); null = standalone database. */
    pageId: text("page_id"),
    /** File table the database was migrated from, so it is not migrated twice. */
    sourceFileId: text("source_file_id"),
    createdBy: jsonb("created_by").$type<Actor>().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("db_databases_workspace_idx").on(t.workspaceId, t.updatedAt),
    uniqueIndex("db_databases_file_uq").on(t.workspaceId, t.sourceFileId),
  ],
);

export const dbTables = pgTable(
  "db_tables",
  {
    id: text("id").primaryKey(),
    workspaceId: workspace(),
    databaseId: text("database_id")
      .notNull()
      .references(() => dbDatabases.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** Property schema. */
    defs: jsonb("defs").$type<BasePropDef[]>().notNull().default([]),
    /** Text property used as the row title. */
    titlePropId: text("title_prop_id").notNull(),
    /** Bumped on every schema write: writers send the version they read (409 if it changed). */
    schemaVersion: integer("schema_version").notNull().default(1),
    /** Bumped when a formula or a type changes: a row with a lower `calc_version` needs recalculation. */
    calcVersion: integer("calc_version").notNull().default(1),
    /** Last version the recalculation finished applying to every row. */
    calcDoneVersion: integer("calc_done_version").notNull().default(1),
    /** Day (UTC) of the last recalculation of formulas that use now()/today(). */
    calcDay: text("calc_day"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("db_tables_database_idx").on(t.databaseId),
    index("db_tables_pending_idx").on(t.workspaceId).where(sql`calc_done_version < calc_version`),
  ],
);

export const dbRows = pgTable(
  "db_rows",
  {
    id: text("id").primaryKey(),
    workspaceId: workspace(),
    tableId: text("table_id")
      .notNull()
      .references(() => dbTables.id, { onDelete: "cascade" }),
    /** Fractional key (manual order); compare with `COLLATE "C"`. */
    position: text("position").notNull(),
    /** Values by property id. */
    props: jsonb("props").$type<Props>().notNull().default({}),
    /** Formula results by property id; an error is `{ err }`. */
    computed: jsonb("computed").$type<Record<string, unknown>>().notNull().default({}),
    /** Body of the row's page (markdown); null until someone writes it. */
    body: text("body"),
    /** Row version: bumped on every write. */
    version: integer("version").notNull().default(1),
    /** Schema version `computed` was calculated with. */
    calcVersion: integer("calc_version").notNull().default(1),
    createdBy: jsonb("created_by").$type<Actor>().notNull(),
    editedBy: jsonb("edited_by").$type<Actor>().notNull(),
    createdAt: createdAt(),
    editedAt: ts("edited_at").notNull().defaultNow(),
  },
  (t) => [
    index("db_rows_table_pos_idx").on(t.tableId, sql`${t.position} collate "C"`, t.id),
    index("db_rows_props_gin").using("gin", t.props.op("jsonb_path_ops")),
    index("db_rows_calc_idx").on(t.tableId, t.calcVersion),
  ],
);

export const dbViews = pgTable(
  "db_views",
  {
    id: text("id").primaryKey(),
    workspaceId: workspace(),
    /** Database whose view tab this is. */
    databaseId: text("database_id")
      .notNull()
      .references(() => dbDatabases.id, { onDelete: "cascade" }),
    /** Source the view shows (the database's own, or another's in a linked view). */
    tableId: text("table_id")
      .notNull()
      .references(() => dbTables.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    type: text("type", {
      enum: ["table", "board", "list", "gallery", "calendar", "timeline", "chart", "form"],
    }).notNull(),
    position: text("position").notNull(),
    config: jsonb("config").$type<BaseViewConfig>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("db_views_database_idx").on(t.databaseId), index("db_views_table_idx").on(t.tableId)],
);
