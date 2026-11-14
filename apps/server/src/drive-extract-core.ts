// Drive text extraction (runs inside the extraction Worker): PDF per page, Word,
// PowerPoint slides, Excel sheets and plain text become markdown per page. An outside file is
// hostile: the zip is read as a stream counting the bytes that come out (a zip bomb stops at the limit, even with
// a size that lies in the header), and the total text has a cap.

import { posix } from "node:path";
import { isTextual, officeKind } from "@vanr/engine/file-type";
import { Unzip, UnzipInflate } from "fflate";

export interface Page {
  page: number;
  markdown: string;
}

export interface ExtractLimits {
  /** Uncompressed bytes per file inside the zip. */
  entryBytes: number;
  /** Uncompressed bytes in the whole zip. */
  zipBytes: number;
  /** Entries read from the zip. */
  entries: number;
  /** Text characters in the result (the rest is cut). */
  textChars: number;
}

export const DEFAULT_LIMITS: ExtractLimits = {
  entryBytes: 20 * 1024 * 1024,
  zipBytes: 100 * 1024 * 1024,
  entries: 2000,
  textChars: 5_000_000,
};

export class ExtractError extends Error {}

/** Reads the chosen entries of the zip, stopping at the limit (counts what comes out of inflate, not the header). */
export function readZip(
  bytes: Uint8Array,
  want: (name: string) => boolean,
  limits: ExtractLimits = DEFAULT_LIMITS,
): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  let total = 0;
  let seen = 0;
  let failure: Error | null = null;
  const uz = new Unzip();
  uz.register(UnzipInflate);
  uz.onfile = (file) => {
    if (failure) return;
    if (++seen > limits.entries) {
      failure = new ExtractError("zip has too many entries");
      return;
    }
    if (!want(file.name)) return;
    const parts: Uint8Array[] = [];
    let size = 0;
    file.ondata = (err, chunk, final) => {
      if (failure) return;
      if (err) {
        failure = new ExtractError(`zip entry ${file.name}: ${err.message}`);
        return;
      }
      size += chunk.length;
      total += chunk.length;
      if (size > limits.entryBytes || total > limits.zipBytes) {
        failure = new ExtractError("zip expands beyond the limit");
        file.terminate();
        return;
      }
      parts.push(chunk);
      if (final) out.set(file.name, concat(parts, size));
    };
    file.start();
  };
  try {
    // DEFLATE can expand roughly 1032 bytes per input byte. Bound each synchronous inflate.
    const step = Math.max(1, Math.min(1024, Math.floor(Math.min(limits.entryBytes, limits.zipBytes) / 1032)));
    for (let at = 0; at < bytes.length && !failure; at += step)
      uz.push(bytes.subarray(at, at + step), at + step >= bytes.length);
  } catch (err) {
    if (!failure) throw new ExtractError(`invalid zip: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (failure) throw failure;
  return out;
}

function concat(parts: Uint8Array[], size: number): Uint8Array {
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const decode = (b: Uint8Array | undefined) => (b ? new TextDecoder().decode(b) : "");

function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(Number.parseInt(n, 16)))
    .replace(/&amp;/g, "&");
}

/**
 * Each `<tag ...>body</tag>` (or `<tag .../>`) of the XML, in order, without nesting. A scan with indexOf:
 * a lazy regex (`<w:p[\s>][\s\S]*?</w:p>`) is quadratic on a file without the closing tag, and 4 KB of zip
 * held the extraction for a minute.
 */
export function* elements(xml: string, tag: string): Generator<{ attrs: string; body: string }> {
  const open = `<${tag}`;
  const close = `</${tag}>`;
  let i = 0;
  for (;;) {
    const start = xml.indexOf(open, i);
    if (start < 0) return;
    const next = xml.charCodeAt(start + open.length);
    // `<w:p` does not match `<w:pPr`: after the name comes a space, `>` or `/`.
    if (next !== 62 && next !== 47 && next !== 32 && next !== 9 && next !== 10 && next !== 13) {
      i = start + open.length;
      continue;
    }
    const gt = xml.indexOf(">", start);
    if (gt < 0) return;
    const attrs = xml.slice(start + open.length, gt);
    if (attrs.endsWith("/")) {
      yield { attrs: attrs.slice(0, -1), body: "" };
      i = gt + 1;
      continue;
    }
    const end = xml.indexOf(close, gt + 1);
    if (end < 0) return;
    yield { attrs, body: xml.slice(gt + 1, end) };
    i = end + close.length;
  }
}

/** Text of the `<prefix:t>` tags of an XML fragment. */
function runs(xml: string, tag: string): string {
  let s = "";
  for (const e of elements(xml, tag)) s += unescapeXml(e.body);
  return s;
}

/** Word: one paragraph per line; a heading style becomes `#`. */
function docx(files: Map<string, Uint8Array>): Page[] {
  const xml = decode(files.get("word/document.xml"));
  const lines: string[] = [];
  for (const { body } of elements(xml, "w:p")) {
    const text = runs(body, "w:t").trim();
    if (!text) continue;
    const level = /<w:pStyle w:val="(?:Heading|Ttulo|Titulo)(\d)"/i.exec(body)?.[1];
    lines.push(level ? `${"#".repeat(Math.min(Number(level), 6))} ${text}` : text);
  }
  return lines.length ? [{ page: 1, markdown: lines.join("\n\n") }] : [];
}

const attr = (attrs: string, name: string) =>
  unescapeXml(new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(attrs)?.[1] ?? "");

/** Resolve document order and names through the package relationships. */
function officeParts(files: Map<string, Uint8Array>, manifest: string, tag: string) {
  const dir = posix.dirname(manifest);
  const rels = new Map(
    [...elements(decode(files.get(`${dir}/_rels/${posix.basename(manifest)}.rels`)), "Relationship")]
      .filter((e) => attr(e.attrs, "TargetMode") !== "External")
      .map((e) => [attr(e.attrs, "Id"), attr(e.attrs, "Target")]),
  );
  return [...elements(decode(files.get(manifest)), tag)].map((e, i) => {
    const target = rels.get(attr(e.attrs, "r:id")) ?? "";
    return {
      name: posix.normalize(target.startsWith("/") ? target.slice(1) : `${dir}/${target}`),
      title: attr(e.attrs, "name"),
      page: i + 1,
    };
  });
}

/** PowerPoint: one slide per page, in presentation order. */
function pptx(files: Map<string, Uint8Array>): Page[] {
  const pages: Page[] = [];
  for (const s of officeParts(files, "ppt/presentation.xml", "p:sldId")) {
    const xml = decode(files.get(s.name));
    const paras = [...elements(xml, "a:p")].map((e) => runs(e.body, "a:t").trim()).filter(Boolean);
    if (paras.length) pages.push({ page: s.page, markdown: paras.join("\n") });
  }
  return pages;
}

/** Excel: one sheet per page, rows separated by tabs (values and shared strings). */
function xlsx(files: Map<string, Uint8Array>): Page[] {
  const shared = [...elements(decode(files.get("xl/sharedStrings.xml")), "si")].map((e) => runs(e.body, "t"));
  const pages: Page[] = [];
  for (const s of officeParts(files, "xl/workbook.xml", "sheet")) {
    const xml = decode(files.get(s.name));
    const rows: string[] = [];
    for (const row of elements(xml, "row")) {
      const cells: string[] = [];
      for (const { attrs, body } of elements(row.body, "c")) {
        const column = /^[A-Z]+/i.exec(attr(attrs, "r"))?.[0];
        const at = column
          ? [...column.toUpperCase()].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1
          : cells.length;
        const v = elements(body, "v").next().value?.body;
        if (/\bt="s"/.test(attrs)) cells[at] = shared[Number(v)] ?? "";
        else if (/\bt="inlineStr"/.test(attrs)) cells[at] = runs(body, "t");
        else cells[at] = v === undefined ? "" : unescapeXml(v);
      }
      if (cells.some((x) => x.trim())) rows.push(cells.join("\t"));
    }
    if (rows.length) {
      pages.push({ page: s.page, markdown: `${s.title ? `## ${s.title}\n\n` : ""}${rows.join("\n")}` });
    }
  }
  return pages;
}

const OFFICE_ENTRIES: Record<"docx" | "xlsx" | "pptx", (name: string) => boolean> = {
  docx: (n) => n === "word/document.xml",
  pptx: (n) =>
    n === "ppt/presentation.xml" ||
    n === "ppt/_rels/presentation.xml.rels" ||
    /^ppt\/slides\/slide\d+\.xml$/.test(n),
  xlsx: (n) =>
    n === "xl/sharedStrings.xml" ||
    n === "xl/workbook.xml" ||
    n === "xl/_rels/workbook.xml.rels" ||
    /^xl\/worksheets\/sheet\d+\.xml$/.test(n),
};

async function pdf(bytes: Uint8Array): Promise<Page[]> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  // Runs in the Worker, which is terminated at the end: no need to free the document.
  const { text } = await extractText(await getDocumentProxy(bytes), { mergePages: false });
  return text.map((t, i) => ({ page: i + 1, markdown: t.trim() })).filter((p) => p.markdown);
}

/** Cuts the total text at the cap, page by page. */
function capped(pages: Page[], max: number): Page[] {
  const out: Page[] = [];
  let left = max;
  for (const p of pages) {
    if (left <= 0) break;
    out.push(p.markdown.length > left ? { ...p, markdown: p.markdown.slice(0, left) } : p);
    left -= p.markdown.length;
  }
  return out;
}

/** Text per page of the file, by the detected type. A type without text (image, video) returns []. */
export async function extractPages(
  bytes: Uint8Array,
  type: string,
  limits: ExtractLimits = DEFAULT_LIMITS,
): Promise<Page[]> {
  let pages: Page[] = [];
  if (type === "application/pdf") pages = await pdf(bytes);
  else if (isTextual(type)) {
    const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, limits.textChars * 4));
    pages = text.trim() ? [{ page: 1, markdown: text }] : [];
  } else {
    const kind = officeKind(type);
    if (kind) {
      const files = readZip(bytes, OFFICE_ENTRIES[kind], limits);
      pages = kind === "docx" ? docx(files) : kind === "pptx" ? pptx(files) : xlsx(files);
    }
  }
  return capped(pages, limits.textChars);
}
