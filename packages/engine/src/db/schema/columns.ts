import { timestamp } from "drizzle-orm/pg-core";

/** Timestamp with time zone, returned as a Date (ISO 8601 in JSON). */
export const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
export const createdAt = () => ts("created_at").notNull().defaultNow();
export const updatedAt = () => ts("updated_at").notNull().defaultNow();
