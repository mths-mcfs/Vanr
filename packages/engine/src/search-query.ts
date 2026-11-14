// The search query: Slack-style operators, splitting text into chunks, and the snippet around the term.
// Pure (no database): the server, the in-memory reference and the front end share it.
import type { SourceKind } from "./search";
import { fold } from "./text";

/** Facets `has:` knows. The indexer tags every chunk with the ones that apply to it. */
const HAS_FACETS = ["link", "file", "image", "code", "mention"] as const;
export type HasFacet = (typeof HAS_FACETS)[number];

/** State `is:` values (the other `is:` values pick the source kind). */
const IS_FACETS = ["thread", "dm", "pinned", "agent", "mine"] as const;
export type IsFacet = (typeof IS_FACETS)[number];

/** `is:` and `type:` words that pick the source kind. */
const KIND_WORDS: Record<string, SourceKind> = {
  message: "message",
  messages: "message",
  wiki: "wiki",
  page: "wiki",
  file: "file",
  files: "file",
  issue: "issue",
  issues: "issue",
  debate: "debate",
  row: "db_row",
  event: "event",
};

/** The query as read: free text (words, phrases and exclusions) and the operators still to resolve. */
export interface ParsedQuery {
  /** Loose words (folded: no accents, lowercase). */
  terms: string[];
  /** Quoted phrases (folded). */
  phrases: string[];
  /** Words and phrases with a leading `-`. */
  exclude: string[];
  /** `from:` handles (without `@`); `me` is whoever searches. */
  from: string[];
  /** `in:` channel names (without `#`) or the `@handle` of the DM. */
  in: string[];
  has: HasFacet[];
  is: IsFacet[];
  kinds: SourceKind[];
  /** `before:`/`after:` as ISO dates (YYYY-MM-DD), exclusive as in Slack. */
  before: string | null;
  after: string | null;
  /** A loose `@handle`: a source written by the handle or mentioning it. */
  mentions: string[];
  /** Operators that could not be read (invalid date, unknown `has:`). The screen shows them. */
  warnings: string[];
}

/** The free text back, in the format `search()` reads (words, "phrases" and -exclusions). */
export function textOf(q: Pick<ParsedQuery, "terms" | "phrases" | "exclude">): string {
  const quote = (s: string) => (s.includes(" ") ? `"${s}"` : s);
  return [...q.terms, ...q.phrases.map((p) => `"${p}"`), ...q.exclude.map((e) => `-${quote(e)}`)].join(" ");
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A calendar date that Postgres and `after:` (+1 day) can take: year 0 and 9999 used to be a 500. */
function isoDate(v: string): string | null {
  if (!DATE_RE.test(v) || v < "0001-01-01" || v > "9998-12-31") return null;
  const d = new Date(`${v}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v ? null : v;
}

/** Splits into pieces, honoring quotes: `a "b c" -"d e" from:x` → a, "b c", -"d e", from:x. */
function tokens(input: string): string[] {
  const out: string[] = [];
  const re = /(-?)"([^"]*)"?|(\S+)/g;
  for (let m = re.exec(input); m; m = re.exec(input)) {
    if (m[3] !== undefined) out.push(m[3]);
    else out.push(`${m[1]}"${m[2]}"`);
  }
  return out;
}

/** Only letters and digits: what becomes a lexeme. Everything else separates words. */
export function words(text: string): string[] {
  return fold(text).match(/[\p{L}\p{N}]+/gu) ?? [];
}

const MAX_PARTS = 32;

export function parseQuery(input: string): ParsedQuery {
  const q: ParsedQuery = {
    terms: [],
    phrases: [],
    exclude: [],
    from: [],
    in: [],
    has: [],
    is: [],
    kinds: [],
    before: null,
    after: null,
    mentions: [],
    warnings: [],
  };
  for (const tok of tokens(input.slice(0, 500)).slice(0, MAX_PARTS)) {
    const neg = tok.startsWith("-") && tok.length > 1;
    const body = neg ? tok.slice(1) : tok;
    if (body.startsWith('"')) {
      const phrase = words(body.slice(1, -1)).join(" ");
      if (!phrase) continue;
      if (neg) q.exclude.push(phrase);
      else if (phrase.includes(" ")) q.phrases.push(phrase);
      else q.terms.push(phrase);
      continue;
    }
    const op = /^([a-z]+):(.+)$/i.exec(body);
    if (op && !neg) {
      const name = (op[1] as string).toLowerCase();
      const value = (op[2] as string).trim();
      const v = fold(value);
      if (name === "from") {
        q.from.push(v.replace(/^@/, ""));
        continue;
      }
      if (name === "in") {
        q.in.push(v.replace(/^#/, ""));
        continue;
      }
      if (name === "has") {
        if ((HAS_FACETS as readonly string[]).includes(v)) q.has.push(v as HasFacet);
        else q.warnings.push(`has:${value}`);
        continue;
      }
      if (name === "is" || name === "type") {
        const kind = KIND_WORDS[v];
        if (kind) q.kinds.push(kind);
        else if (name === "is" && (IS_FACETS as readonly string[]).includes(v)) q.is.push(v as IsFacet);
        else q.warnings.push(`${name}:${value}`);
        continue;
      }
      if (name === "before" || name === "after") {
        const d = isoDate(value);
        if (d) q[name] = d;
        else q.warnings.push(`${name}:${value}`);
        continue;
      }
      // An unknown operator (the `http:` of a URL, `note:x`) is text.
    }
    if (!neg && /^@[\p{L}\p{N}_-]{2,32}$/u.test(body)) {
      q.mentions.push(fold(body.slice(1)));
      continue;
    }
    const ws = words(body);
    if (!ws.length) continue;
    if (neg) q.exclude.push(ws.join(" "));
    else q.terms.push(...ws);
  }
  q.terms = [...new Set(q.terms)];
  q.kinds = [...new Set(q.kinds)];
  return q;
}

/** Only the free text (no operators): what `SearchIndex.search` receives as the query. */
export interface TextQuery {
  terms: string[];
  phrases: string[];
  exclude: string[];
}

export function parseText(input: string): TextQuery {
  const { terms, phrases, exclude } = parseQuery(input);
  return { terms, phrases, exclude };
}

/**
 * The chunk matches the query (the in-memory reference uses this; Postgres does it in SQL): every word
 * and phrase as whole words, no exclusion, and `prefix` as the start of some word.
 */
export function matchesText(
  q: TextQuery,
  haystack: string,
  prefix?: string,
  match: "all" | "any" = "all",
): boolean {
  if (!q.terms.length && !q.phrases.length && !prefix) return false;
  const ws = words(haystack);
  const hay = ` ${ws.join(" ")} `;
  const has = (w: string) => hay.includes(` ${w} `);
  if (q.exclude.some(has)) return false;
  const wanted = [...q.terms, ...q.phrases].map(has);
  const pre = prefix ? [ws.some((w) => w.startsWith(prefix))] : [];
  const all = [...wanted, ...pre];
  return match === "any" ? all.some(Boolean) : all.every(Boolean);
}

// ---- Chunks ----

/** Target size of a chunk (~800 tokens of Portuguese). */
const CHUNK_CHARS = 3000;
const CHUNK_OVERLAP = 200;
/** A source never becomes more chunks than this (a 2 MB file gives ~700). */
export const MAX_CHUNKS = 1000;

export interface TextPart {
  text: string;
  /** Page (PDF, slide, spreadsheet), when the source has one. */
  page?: number;
}

/**
 * Splits into chunks of up to `CHUNK_CHARS`, cutting at a paragraph, then a sentence, then a space,
 * with a little overlap. Every page becomes at least one chunk of its own (the citation points at the page).
 */
export function chunkText(parts: readonly TextPart[], max = CHUNK_CHARS): TextPart[] {
  const out: TextPart[] = [];
  for (const part of parts) {
    const text = part.text.replace(/\r\n?/g, "\n").trim();
    let at = 0;
    while (at < text.length && out.length < MAX_CHUNKS) {
      let end = Math.min(text.length, at + max);
      if (end < text.length) {
        const window = text.slice(at, end);
        const cut = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf(". "), window.lastIndexOf("\n"));
        const space = window.lastIndexOf(" ");
        const best = cut > max / 2 ? cut + 1 : space > max / 2 ? space : -1;
        if (best > 0) end = at + best;
      }
      const piece = text.slice(at, end).trim();
      if (piece) out.push(part.page === undefined ? { text: piece } : { text: piece, page: part.page });
      if (end >= text.length) break;
      at = Math.max(at + 1, end - CHUNK_OVERLAP);
      // Start again at the beginning of a word.
      const sp = text.indexOf(" ", at);
      if (sp > 0 && sp < end) at = sp + 1;
    }
  }
  return out;
}

/** A snippet of up to `size` characters around the first query word that appears in the text. */
export function snippetFor(text: string, q: TextQuery, size = 200): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= size) return flat;
  const folded = fold(flat);
  let at = -1;
  for (const w of [...q.phrases, ...q.terms]) {
    const re = new RegExp(`(^|[^\\p{L}\\p{N}])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "u");
    const m = re.exec(folded);
    if (m) {
      const i = m.index + (m[1] as string).length;
      if (at < 0 || i < at) at = i;
    }
  }
  if (at < 0) at = 0;
  // The position is in the folded text; `mapIndex` brings it back to the original (NFD changes the length).
  const start = Math.max(0, mapIndex(flat, at) - Math.floor(size / 3));
  const cut = flat.slice(start, start + size);
  return `${start > 0 ? "…" : ""}${cut}${start + size < flat.length ? "…" : ""}`;
}

/** Position in the original text that matches position `i` of the folded text. */
function mapIndex(original: string, i: number): number {
  let folded = 0;
  for (let k = 0; k < original.length; k++) {
    if (folded >= i) return k;
    folded += fold(original[k] as string).length;
  }
  return original.length;
}

/** `has:` facets of a markdown text (link, code, mention). File and image come from the source. */
export function textFacets(text: string): HasFacet[] {
  const out = new Set<HasFacet>();
  if (/https?:\/\/\S+/i.test(text)) out.add("link");
  if (/```|`[^`\n]+`/.test(text)) out.add("code");
  if (/(^|\s)@[\p{L}\p{N}_-]{2,32}/u.test(text)) out.add("mention");
  return [...out];
}
