// Wiki links in markdown, in the Obsidian format: [[target]], [[target|text]], [[target#Heading]],
// [[target#^block]], ![[embed]] and block ids `^id` at the end of a line. Code (fenced blocks and inline
// code spans) and %% %% comments do not count. Pure functions: the server and the front end use the same ones.
import { remarkCtx } from "@milkdown/kit/core";
import type { Root } from "@milkdown/kit/transformer";

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

/** Fenced code in containers, code spans and comments, in original source offsets. */
export function codeRanges(md: string): [number, number][] {
  const ranges: [number, number][] = [];
  let open: { char: string; len: number; start: number; quote: number; indent: number } | null = null;
  let at = 0;
  for (const line of md.split("\n")) {
    let content = line.replace(/\r$/, "");
    let quote = 0;
    let marker = /^ {0,3}>[ \t]?/.exec(content);
    while (marker && (!open || quote < open.quote)) {
      quote++;
      content = content.slice(marker[0].length);
      marker = /^ {0,3}>[ \t]?/.exec(content);
    }
    if (open && (quote !== open.quote || (content.trim() && content.search(/\S/) < open.indent))) {
      ranges.push([open.start, at]);
      open = null;
    }
    let indent = 0;
    if (open) content = content.slice(open.indent);
    else {
      let list = /^(?: {0,3})(?:[-+*]|\d+[.)])[ \t]+/.exec(content);
      while (list) {
        indent += list[0].length;
        content = content.slice(list[0].length);
        list = /^(?: {0,3})(?:[-+*]|\d+[.)])[ \t]+/.exec(content);
      }
    }
    const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(content);
    const mark = fence?.[1] ?? "";
    if (fence && open) {
      if (mark[0] === open.char && mark.length >= open.len && !fence[2]?.trim()) {
        ranges.push([open.start, at + line.length]);
        open = null;
      }
    } else if (fence && !(mark[0] === "`" && fence[2]?.includes("`"))) {
      open = { char: mark[0] ?? "`", len: mark.length, start: at, quote, indent };
    }
    at += line.length + 1;
  }
  if (open) ranges.push([open.start, md.length]);

  // Index each delimiter run once. Failed openers never search the same suffix again.
  const marks: { at: number; end: number; key: string; next: number; section: number }[] = [];
  let fenceIndex = 0;
  for (const m of md.matchAll(/`+|%%|\r?\n[ \t]*\r?\n/g)) {
    const at = m.index;
    while (ranges[fenceIndex] && at >= (ranges[fenceIndex]?.[1] ?? 0)) fenceIndex++;
    if (ranges[fenceIndex] && at >= (ranges[fenceIndex]?.[0] ?? 0)) continue;
    marks.push({
      at,
      end: at + m[0].length,
      key: m[0][0] === "`" ? String(m[0].length) : m[0] === "%%" ? "comment" : "break",
      next: -1,
      section: fenceIndex,
    });
  }
  const next = new Map<string, number>();
  for (let i = marks.length - 1; i >= 0; i--) {
    const mark = marks[i];
    if (!mark) continue;
    if (mark.key === "break") {
      const comment = next.get("comment");
      next.clear();
      if (comment !== undefined) next.set("comment", comment);
    } else {
      mark.next = next.get(mark.key) ?? -1;
      next.set(mark.key, i);
    }
  }
  for (let i = 0; i < marks.length; i++) {
    const mark = marks[i];
    const end = mark && marks[mark.next];
    if (!mark || !end) continue;
    // A span must stay outside fenced code, even if its delimiters have the same length.
    if (mark.key !== "comment" && mark.section !== end.section) continue;
    ranges.push([mark.at, end.end]);
    i = mark.next;
  }
  return ranges.sort((a, b) => a[0] - b[0]);
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
  const head = bar >= 0 ? inner.slice(0, bar).replace(/\\$/, "") : inner;
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
  let range = 0;
  for (let i = 0; i < md.length; ) {
    while (skip[range] && i >= (skip[range]?.[1] ?? 0)) range++;
    if (skip[range] && i >= (skip[range]?.[0] ?? 0)) {
      i = skip[range]?.[1] ?? md.length;
      continue;
    }
    const embed = md.startsWith("![[", i);
    if ((!embed && !md.startsWith("[[", i)) || md[i - 1] === "\\") {
      i++;
      continue;
    }
    const start = i;
    const body = i + (embed ? 3 : 2);
    i = body;
    while (i < md.length && md[i] !== "]" && md[i] !== "\n") i++;
    if (i === body || !md.startsWith("]]", i)) continue;
    const end = i + 2;
    const parsed = parseLinkInner(md.slice(body, i));
    i = end;
    if (!parsed.target && !parsed.anchor) continue;
    out.push({ raw: md.slice(start, end), embed, start, end, ...parsed });
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
    const source = lines[i] ?? "";
    const line = source.replace(/\r$/, "");
    const here = offset;
    offset += source.length + 1;
    if (inside(skip, here)) continue;
    const atx = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/.exec(line);
    if (atx) {
      out.push({ level: (atx[1] ?? "#").length, text: cleanHeading(atx[2] ?? ""), line: i });
      continue;
    }
    const next = (lines[i + 1] ?? "").replace(/\r$/, "");
    if (line.trim() && !/^\s*([-*+>|]|\d+[.)])\s/.test(line) && /^ {0,3}(=+|-+)[ \t]*$/.test(next)) {
      out.push({ level: next.trim().startsWith("=") ? 1 : 2, text: cleanHeading(line.trim()), line: i });
    }
  }
  return out;
}

const headingMarkdown = remarkCtx.create(new Map()).get()();

/** Heading text as Obsidian uses it in the anchor: no emphasis or code markup, links by their text. */
export function cleanHeading(text: string): string {
  text = text
    .replace(/!?\[\[([^\]|]+?)(?:\|([^\]]+))?\]\]/g, (_, t: string, a?: string) => a ?? t)
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  const plain = (s: string) => s.replace(/(~~|==)(?=\S)(.+?)\1/g, "$2");
  let out = "";
  let pending = "";
  const walk = (nodes: Extract<Root["children"][number], { type: "paragraph" }>["children"]) => {
    for (const node of nodes) {
      if ("children" in node) walk(node.children);
      else if (node.type === "inlineCode") {
        out += plain(pending) + node.value;
        pending = "";
      } else if ("value" in node) pending += node.value;
    }
  };
  // Keep literal block markers in heading content inside a paragraph.
  const paragraph = headingMarkdown.parse(`x ${text}`).children[0];
  if (paragraph?.type === "paragraph") walk(paragraph.children);
  return (out + plain(pending))
    .slice(2)
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
    const separator = l.raw.includes("\\|") ? "\\|" : "|";
    out += `${md.slice(last, l.start)}${l.embed ? "!" : ""}[[${to.target}${anchor}${linkText ? `${separator}${linkText}` : ""}]]`;
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
}

const bySlug = (a: LinkPage, b: LinkPage) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0);

/**
 * Resolves a link target: slug, title, folder/title, other title and slug of the text, in that order.
 * With two candidates at the same step, the shortest folder wins (as in Obsidian) and then the slug. The
 * server (page_links table) and the screen use this same function, so both find the same page.
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
    const hit = pages.filter(ok).sort((a, b) => a.folder.length - b.folder.length || bySlug(a, b))[0];
    if (hit) return hit;
  }
  return undefined;
}
