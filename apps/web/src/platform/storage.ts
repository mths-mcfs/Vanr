// The browser's storage, read through a schema and never trusted. Storage can be blocked (private
// mode, a policy): then nothing is remembered and nothing breaks.
import type { z } from "zod";

export type KeyValueStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** Every key the web writes, in one place. */
export const STORAGE_KEYS = {
  locale: "vanr.locale",
  theme: "vanr.theme",
  sidebar: "vanr.sidebar",
  lastWorkspace: "vanr.lastWorkspace",
  drafts: "vanr.drafts",
  /** Files: grid or list. */
  filesView: "vanr.files.view",
  /** Files: the upload session of each file being sent, so a reload can go on from where it stopped. */
  uploads: "vanr.files.uploads",
} as const;

/** A store that keeps values for the life of the page: the fallback when the browser's is blocked. */
export function memoryStore(): KeyValueStore {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
  };
}

/** The browser store, or a memory one when it is missing or blocked. */
export function browserStore(kind: "localStorage" | "sessionStorage"): KeyValueStore {
  try {
    const store = globalThis[kind];
    const probe = "vanr.probe";
    store.setItem(probe, "1");
    store.removeItem(probe);
    return store;
  } catch {
    return memoryStore();
  }
}

/** The stored value when it parses as JSON and matches the schema; undefined otherwise. */
export function readStored<T>(store: KeyValueStore, key: string, schema: z.ZodType<T>): T | undefined {
  let text: string | null;
  try {
    text = store.getItem(key);
  } catch {
    return undefined;
  }
  if (text === null) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  const parsed = schema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

export function writeStored(store: KeyValueStore, key: string, value: unknown): void {
  try {
    if (value === undefined) store.removeItem(key);
    else store.setItem(key, JSON.stringify(value));
  } catch {
    // Blocked or full: the choice simply lasts for this page.
  }
}
