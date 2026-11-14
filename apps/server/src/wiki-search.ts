// Wiki chunks for search: the search index calls wikiChunks when it
// reindexes the page. The page belongs to the whole workspace, so the scope is `workspace` (per-page permission comes later).
import type { ChunkInput } from "@vanr/engine/search";
import { codeRanges } from "@vanr/engine/wiki/links";
import type { WikiRow } from "./wiki";

const CHUNK = 1500;
const MAX_CHUNKS = 400;

/**
 * Cuts the body into chunks of up to ~1500 characters, preferably at headings and blank lines,
 * without splitting a code block. The section heading goes at the start of each of its chunks.
 */
export function wikiChunks(
  row: Pick<WikiRow, "workspaceId" | "slug" | "title" | "body" | "updatedAt" | "updatedBy">,
) {
  const body = row.body;
  const code = codeRanges(body).filter(([a, b]) => /^ {0,3}(```|~~~)/.test(body.slice(a, b)));
  const inCode = (i: number) => code.some(([a, b]) => i > a && i < b);
  // Cut points: start of a heading or of a paragraph, outside code blocks.
  const cuts: { at: number; heading: string | null }[] = [{ at: 0, heading: null }];
  const re = /\n(?=(#{1,6})[ \t]+([^\n]*)|\n)/g;
  for (let m = re.exec(body); m; m = re.exec(body)) {
    const at = m.index + 1;
    if (inCode(at)) continue;
    cuts.push({ at, heading: m[1] ? (m[2] ?? "").trim() : null });
  }
  const texts: string[] = [];
  let heading: string | null = null;
  let current = "";
  const flush = () => {
    const t = current.trim();
    if (t) texts.push(t);
    current = "";
  };
  for (let i = 0; i < cuts.length; i++) {
    const cut = cuts[i] as (typeof cuts)[number];
    const piece = body.slice(cut.at, cuts[i + 1]?.at ?? body.length);
    if (cut.heading !== null) {
      flush();
      heading = cut.heading;
    }
    if (current.length + piece.length > CHUNK && current.trim()) flush();
    if (!current && heading && cut.heading === null) current = `${heading}\n`;
    // A paragraph longer than two chunks: cut it flat.
    for (let k = 0; k < piece.length; k += CHUNK * 2) {
      if (k > 0) flush();
      current += piece.slice(k, k + CHUNK * 2);
    }
  }
  flush();
  const updatedAt = row.updatedAt.toISOString();
  const chunks: ChunkInput[] = (texts.length ? texts : [""]).slice(0, MAX_CHUNKS).map((text, ordinal) => ({
    workspaceId: row.workspaceId,
    ordinal,
    title: row.title,
    text,
    scope: { kind: "workspace" },
    url: `/workspace/${encodeURIComponent(row.workspaceId)}/wiki/${encodeURIComponent(row.slug)}`,
    authorId: row.updatedBy.id,
    updatedAt,
  }));
  return chunks;
}
