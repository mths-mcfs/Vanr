// YAML front matter at the edges: it comes in on import and when an external agent writes markdown, and
// goes out on export. Inside the product the body has no front matter and the properties live in `props`.
// The YAML comes from outside: YAML aliases are capped (against the "billion laughs" alias bomb), keys
// that touch the prototype are dropped and the result holds only JSON types.
import { parseDocument, stringify } from "yaml";

export type FrontmatterData = Record<string, unknown>;

const FM =
  /^﻿?---[ \t]*\r?\n(?:(?:---|\.\.\.)[ \t]*(?:\r?\n|$)|([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$))/;
const BAD_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const MAX_DEPTH = 6;

/** Only JSON values, without dangerous keys and with a depth limit. */
function clean(value: unknown, depth: number): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return Number(value);
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (depth >= MAX_DEPTH) return null;
  if (Array.isArray(value)) return value.slice(0, 500).map((v) => clean(v, depth + 1));
  if (value instanceof Map) value = Object.fromEntries([...value.entries()].map(([k, v]) => [String(k), v]));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as object).slice(0, 200)) {
      if (BAD_KEYS.has(k)) continue;
      out[k] = clean(v, depth + 1);
    }
    return out;
  }
  return null;
}

/**
 * Splits the front matter from the body. Without front matter: empty `data` and the whole text in the
 * body. Invalid YAML, or YAML that is not a map: empty `data`, `error` set and the body without the block.
 */
export function splitFrontmatter(text: string): {
  data: FrontmatterData;
  body: string;
  error: string | null;
} {
  const m = FM.exec(text);
  if (!m) return { data: {}, body: text, error: null };
  const body = text.slice(m[0].length);
  const src = m[1] === undefined ? "" : `${m[1]}\n`;
  if (!src.trim()) return { data: {}, body, error: null };
  try {
    const doc = parseDocument(src, { schema: "core", uniqueKeys: false, prettyErrors: false });
    if (doc.errors.length) return { data: {}, body, error: doc.errors[0]?.code ?? "yaml" };
    const js = clean(doc.toJS({ maxAliasCount: 50 }), 0);
    if (!js || typeof js !== "object" || Array.isArray(js)) return { data: {}, body, error: "not_a_map" };
    return { data: js as FrontmatterData, body, error: null };
  } catch (e) {
    return { data: {}, body, error: e instanceof Error && /alias/i.test(e.message) ? "alias_limit" : "yaml" };
  }
}

/** A `---` block with the YAML of the data (empty when there is no data). */
export function formatFrontmatter(data: FrontmatterData): string {
  const keys = Object.keys(data).filter((k) => data[k] !== undefined);
  if (!keys.length) return "";
  const ordered = Object.fromEntries(keys.map((k) => [k, data[k]]));
  return `---\n${stringify(ordered, { lineWidth: 0 })}---\n`;
}

const asList = (v: unknown): string[] =>
  (Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : v == null ? [] : [v])
    .map((x) => (typeof x === "string" || typeof x === "number" ? String(x).trim() : ""))
    .filter(Boolean);

/**
 * Keys the wiki understands on its own: `title`, `tags`/`tag`, `aliases`/`alias` (Obsidian's other
 * titles of a page). The rest becomes properties. Keys are compared without case, as in Obsidian.
 */
export function vaultMeta(data: FrontmatterData): {
  title: string | null;
  tags: string[];
  aliases: string[];
  rest: FrontmatterData;
} {
  let title: string | null = null;
  const tags: string[] = [];
  const aliases: string[] = [];
  const rest: FrontmatterData = {};
  for (const [key, value] of Object.entries(data)) {
    const k = key.toLowerCase();
    if (k === "title" && (typeof value === "string" || typeof value === "number"))
      title = String(value).trim() || null;
    else if (k === "tags" || k === "tag") tags.push(...asList(value).map((t) => t.replace(/^#/, "")));
    else if (k === "aliases" || k === "alias") aliases.push(...asList(value));
    else rest[key] = value;
  }
  return { title, tags, aliases, rest };
}
