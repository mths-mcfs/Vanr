// The interface languages and how one is picked: the stored choice, else the first of the
// browser's languages that the web speaks, else English.
import { z } from "zod";
import { type KeyValueStore, readStored, STORAGE_KEYS, writeStored } from "../platform/storage.ts";

export const LOCALES = ["en", "pt-BR"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";

const LocaleSchema = z.enum(LOCALES);

/** The supported locale a browser language tag maps to: any `pt` is pt-BR, any `en` is en. */
export function matchLocale(tag: string): Locale | undefined {
  const language = tag.trim().toLowerCase().split("-")[0];
  if (language === "pt") return "pt-BR";
  if (language === "en") return "en";
  return undefined;
}

export function detectLocale(input: { store: KeyValueStore; languages: readonly string[] }): Locale {
  const stored = readStored(input.store, STORAGE_KEYS.locale, LocaleSchema);
  if (stored !== undefined) return stored;
  for (const tag of input.languages) {
    const match = matchLocale(tag);
    if (match !== undefined) return match;
  }
  return DEFAULT_LOCALE;
}

export function rememberLocale(store: KeyValueStore, locale: Locale): void {
  writeStored(store, STORAGE_KEYS.locale, locale);
}
