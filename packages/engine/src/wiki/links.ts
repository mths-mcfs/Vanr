// Wiki links in markdown, in the Obsidian format: [[target]], [[target|text]], [[target#Heading]],
// [[target#^block]], ![[embed]] and block ids `^id` at the end of a line. Code (fenced blocks and inline
// code spans) and %% %% comments do not count. Pure functions: the server and the front end use the same ones.

export interface WikiLinkRef {
  /** The whole text as it is in the markdown, with `!`, brackets, heading and link text. */
  raw: string;
  /** Target without heading or link text (`Folder/Page`), trimmed. */
  target: string;
  /** `Heading` of [[a#Heading]] or `^block` of [[a#^block]]; null without an anchor. */
  anchor: string | null;
  linkText: string | null;
  embed: boolean;
  /** Position in the markdown (start inclusive, end exclusive). */
  start: number;
  end: number;
}

export interface Heading {
  level: number;
  text: string;
  line: number;
}

const LINK = /(!?)\[\[([^\]\n]+?)\]\]/g;

/**
 * Ranges of the markdown that are not running text: fenced code blocks (``` and ~~~, up to 3 spaces
 * of indentation), inline code spans and %%…%% comments. Returns sorted [start, end) pairs.
 */
export function codeRanges(md: string): [number, number][] {
  const ranges: [number, number][] = [];
  const fence = /^ {0,3}(`{3,}|~{3,})[^\n]*$/gm;
  let open: { char: string; len: number; start: number } | null = null;
  for (const m of md.matchAll(fence)) {
    const mark = m[1] ?? "";
    const at = m.index ?? 0;
    if (!open) {
      if (mark[0] === "`" && /`/.test(m[0].slice(m[0].indexOf(mark) + mark.length))) continue;
      open = { char: mark[0] ?? "`", len: mark.length, start: at };
    } else if (mark[0] === open.char && mark.length >= open.len && m[0].trim() === mark) {
      ranges.push([open.start, at + m[0].length]);
      open = null;
    }
  }
  if (open) ranges.push([open.start, md.length]);
  const inFence = (i: number) => ranges.some(([a, b]) => i >= a && i < b);
  const extra: [number, number][] = [];
  for (const m of md.matchAll(/(`+)(?!`)[\s\S]*?[^`]\1(?!`)|%%[\s\S]*?%%/g)) {
    const at = m.index ?? 0;
    if (inFence(at)) continue;
    // An inline code span does not cross a paragraph (blank line).
    if (m[0].startsWith("`") && /\n\s*\n/.test(m[0])) continue;
    extra.push([at, at + m[0].length]);
  }
  return [...ranges, ...extra].sort((a, b) => a[0] - b[0]);
}

function inside(ranges: [number, number][], at: number): boolean {
  for (const [a, b] of ranges) {
    if (at < a) return false;
    if (at < b) return true;
  }
  return false;
}

export function parseLinkInner(inner: string): Pick<WikiLinkRef, "target" | "anchor" | "linkText"> {
  const bar = inner.indexOf("|");
  const head = bar >= 0 ? inner.slice(0, bar) : inner;
  const linkText = bar >= 0 ? inner.slice(bar + 1).trim() || null : null;
  const hash = head.indexOf("#");
  const target = (hash >= 0 ? head.slice(0, hash) : head).trim();
  const anchor = hash >= 0 ? head.slice(hash + 1).trim() || null : null;
  return { target, anchor, linkText };
}

/** Every link and embed outside code, in the order they appear. */
export function parseWikiLinks(md: string): WikiLinkRef[] {
  const skip = codeRanges(md);
  const out: WikiLinkRef[] = [];
  for (const m of md.matchAll(LINK)) {
    const start = m.index ?? 0;
    if (inside(skip, start)) continue;
    // An escaped `\[[` is not a link.
    if (start > 0 && md[start - 1] === "\\") continue;
    const parsed = parseLinkInner(m[2] ?? "");
    // [[#Heading]] points at the page itself: empty target.
    if (!parsed.target && !parsed.anchor) continue;
    out.push({ raw: m[0], embed: m[1] === "!", start, end: start + m[0].length, ...parsed });
  }
  return out;
}

/** Block ids: `text ^id` at the end of a line, or `^id` alone on a line (after a table). */
export function blockIds(md: string): string[] {
  const skip = codeRanges(md);
  const out: string[] = [];
  for (const m of md.matchAll(/(?:^|[ \t])\^([A-Za-z0-9-]+)[ \t]*$/gm)) {
    if (inside(skip, m.index ?? 0)) continue;
    if (m[1]) out.push(m[1]);
  }
  return [...new Set(out)];
}

/** ATX and setext headings outside code, with the (0-based) line where they start. */
export function headings(md: string): Heading[] {
  const skip = codeRanges(md);
  const lines = md.split("\n");
  const out: Heading[] = [];
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const here = offset;
    offset += line.length + 1;
    if (inside(skip, here)) continue;
    const atx = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/.exec(line);
    if (atx) {
      out.push({ level: (atx[1] ?? "#").length, text: cleanHeading(atx[2] ?? ""), line: i });
      continue;
    }
    const next = lines[i + 1] ?? "";
    if (line.trim() && !/^\s*([-*+>|]|\d+[.)])\s/.test(line) && /^ {0,3}(=+|-+)[ \t]*$/.test(next)) {
      out.push({ level: next.trim().startsWith("=") ? 1 : 2, text: cleanHeading(line.trim()), line: i });
    }
  }
  return out;
}

/** Heading text as Obsidian uses it in the anchor: no emphasis or code markup, links by their text. */
export function cleanHeading(text: string): string {
  return text
    .replace(/!?\[\[([^\]|]+?)(?:\|([^\]]+))?\]\]/g, (_, t: string, a?: string) => a ?? t)
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_~`=]/g, "")
    .replace(/\s+\^[A-Za-z0-9-]+$/, "")
    .trim();
}

/**
 * Tags in the body: `#tag` or `#parent/child` preceded by the start of a line or a space, with at least
 * one letter (Obsidian does not accept a tag made only of digits). Headings (`# `) are not tags.
 */
export function bodyTags(md: string): string[] {
  const skip = codeRanges(md);
  const out = new Set<string>();
  for (const m of md.matchAll(/(^|[ \t(])#([\p{L}\p{N}_/-]*\p{L}[\p{L}\p{N}_/-]*)/gmu)) {
    const at = (m.index ?? 0) + (m[1] ?? "").length;
    if (inside(skip, at)) continue;
    const tag = (m[2] ?? "").replace(/\/+$/, "").toLowerCase();
    if (tag) out.add(tag);
  }
  return [...out];
}

/**
 * Replaces the links for which `next` returns a new target (and, optionally, new link text), keeping
 * `!` and the anchor; `null` leaves the link as it is. Returns the new markdown and how many links
 * changed. Code and comments stay as they are.
 */
export function rewriteLinks(
  md: string,
  next: (link: WikiLinkRef) => { target: string; linkText?: string | null } | null,
): { md: string; count: number } {
  let out = "";
  let last = 0;
  let count = 0;
  for (const l of parseWikiLinks(md)) {
    const to = l.target ? next(l) : null;
    if (!to) continue;
    const anchor = l.anchor ? `#${l.anchor}` : "";
    const linkText = to.linkText !== undefined ? to.linkText : l.linkText;
    out += `${md.slice(last, l.start)}${l.embed ? "!" : ""}[[${to.target}${anchor}${linkText ? `|${linkText}` : ""}]]`;
    last = l.end;
    count++;
  }
  return count ? { md: out + md.slice(last), count } : { md, count: 0 };
}

/** Slug from the title: lowercase, no accents, hyphens. The folder is not part of it. */
export function slugify(title: string): string {
  const s = title
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, "");
  return s || "page";
}

/** The target as it is compared: without the trailing `.md` and trimmed. */
export const stripMd = (t: string) => t.replace(/\.md$/i, "").trim();

export interface LinkPage {
  slug: string;
  title: string;
  folder: string;
  /** Other titles of the page (Obsidian's `aliases`): they also resolve links. */
  aliases?: readonly string[] | null;
  /** A restricted page: in a tie it loses to a page the whole workspace reads. */
  restricted?: boolean;
}

const bySlug = (a: LinkPage, b: LinkPage) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0);

/**
 * Resolves a link target: slug, title, folder/title, other title and slug of the text, in that order.
 * With two candidates at the same step, the page the whole workspace reads wins (a restricted one only
 * when nothing else matches), then the shortest folder (as in Obsidian) and then the slug. The server (page_links table) and the screen use this same function, so both find the same page.
 */
export function resolveTarget<T extends LinkPage>(target: string, pages: readonly T[]): T | undefined {
  const raw = stripMd(target);
  const t = raw.toLowerCase();
  if (!t) return undefined;
  const tries: ((p: T) => boolean)[] = [
    (p) => p.slug === t,
    (p) => p.title.toLowerCase() === t,
    (p) => !!p.folder && `${p.folder}/${p.title}`.toLowerCase() === t,
    (p) => (p.aliases ?? []).some((a) => a.toLowerCase() === t),
    (p) => p.slug === slugify(raw),
  ];
  for (const ok of tries) {
    const hit = pages
      .filter(ok)
      .sort(
        (a, b) =>
          Number(!!a.restricted) - Number(!!b.restricted) ||
          a.folder.length - b.folder.length ||
          bySlug(a, b),
      )[0];
    if (hit) return hit;
  }
  return undefined;
}
