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
  const fenced = / {0,3}(```|~~~)/y;
  const code = codeRanges(body).filter(([a]) => {
    fenced.lastIndex = a;
    return fenced.test(body);
  });
  // Strictly inside a code block, by binary search over the starts (with how far the blocks so far reach):
  // a page full of blocks and blank lines stays linear.
  const reach: number[] = [];
  for (const [, b] of code) reach.push(Math.max(reach.at(-1) ?? 0, b));
  const inCode = (i: number) => {
    let lo = 0;
    let hi = code.length - 1;
    let last = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if ((code[mid] as [number, number])[0] < i) {
        last = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return last >= 0 && (reach[last] as number) > i;
  };
  // Cut points: start of a heading or of a paragraph, outside code blocks.
  const cuts: { at: number; heading: string | null }[] = [
    { at: 0, heading: /^#{1,6}[ \t]+([^\n]*)/.exec(body)?.[1]?.trim() ?? null },
  ];
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
    authorId: `${row.updatedBy.type === "person" ? "user" : "agent"}:${row.updatedBy.id}`,
    updatedAt,
  }));
  return chunks;
}
