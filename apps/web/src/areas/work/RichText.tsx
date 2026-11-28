// Text people and agents write in an issue (the description, a comment), drawn with the little
// formatting they use: paragraphs, headings, lists, quotes, code, bold, italics and links. Everything
// becomes React elements, never HTML, and only an http or https address becomes a link.
import type { ReactNode } from "react";

/** The address, if it is one a link may open: http or https, nothing else. */
export function safeHref(raw: string): string | undefined {
  try {
    const url = new URL(raw.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/** A block and the line it starts on, which is also its key. */
type Block = { line: number } & (
  | { kind: "heading"; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "quote"; text: string }
  | { kind: "code"; text: string }
  | { kind: "list"; ordered: boolean; items: { line: number; text: string }[] }
);

const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;
const HEADING = /^#{1,6}\s+(.*)$/;
const QUOTE = /^>\s?(.*)$/;

/** The blocks of a text, line by line. */
export function blocksOf(text: string): Block[] {
  const blocks: Block[] = [];
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.trim() === "") {
      i += 1;
      continue;
    }
    const start = i;
    if (line.trimStart().startsWith("```")) {
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !(lines[i] ?? "").trimStart().startsWith("```")) code.push(lines[i++] ?? "");
      i += 1;
      blocks.push({ line: start, kind: "code", text: code.join("\n") });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ line: start, kind: "heading", text: heading[1] ?? "" });
      i += 1;
      continue;
    }
    const list = BULLET.test(line) ? BULLET : NUMBERED.test(line) ? NUMBERED : null;
    if (list) {
      const items: { line: number; text: string }[] = [];
      while (i < lines.length && list.test(lines[i] ?? "")) {
        items.push({ line: i, text: list.exec(lines[i] ?? "")?.[1] ?? "" });
        i += 1;
      }
      blocks.push({ line: start, kind: "list", ordered: list === NUMBERED, items });
      continue;
    }
    const kind = QUOTE.test(line) ? "quote" : "paragraph";
    const own: string[] = [];
    while (i < lines.length) {
      const next = lines[i] ?? "";
      if (next.trim() === "" || next.trimStart().startsWith("```") || HEADING.test(next)) break;
      if (BULLET.test(next) || NUMBERED.test(next)) break;
      if ((kind === "quote") !== QUOTE.test(next)) break;
      own.push(kind === "quote" ? (QUOTE.exec(next)?.[1] ?? "") : next);
      i += 1;
    }
    blocks.push({ line: start, kind, text: own.join("\n") });
  }
  return blocks;
}

// `code`, **bold**, *italic* or _italic_, [label](address), and a bare address.
const INLINE =
  /`([^`]+)`|\*\*([^*]+)\*\*|\*([^*\s][^*]*)\*|_([^_\s][^_]*)_|\[([^\]]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s<>()]+)/g;

function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  for (const match of text.matchAll(INLINE)) {
    const at = match.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const id = `${key}.${n++}`;
    const [whole, code, bold, star, under, label, address, bare] = match;
    if (code !== undefined) out.push(<code key={id}>{code}</code>);
    else if (bold !== undefined) out.push(<strong key={id}>{inline(bold, id)}</strong>);
    else if (star !== undefined || under !== undefined)
      out.push(<em key={id}>{inline(star ?? under ?? "", id)}</em>);
    else {
      const href = safeHref(address ?? bare ?? "");
      const shown = label ?? bare ?? whole;
      out.push(
        href === undefined ? (
          whole
        ) : (
          <a key={id} href={href} target="_blank" rel="noopener noreferrer">
            {shown}
          </a>
        ),
      );
    }
    last = at + whole.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** A line break inside a paragraph stays a line break. */
function lines(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  let at = 0;
  for (const line of text.split("\n")) {
    if (at > 0) out.push(<br key={`${key}.br${at}`} />);
    out.push(...inline(line, `${key}.${at}`));
    at += 1;
  }
  return out;
}

export function RichText({ text }: { text: string }) {
  return (
    <div className="work-rich">
      {blocksOf(text).map((block) => {
        const key = `b${block.line}`;
        switch (block.kind) {
          case "heading":
            return (
              <p key={key} className="work-rich__heading">
                {inline(block.text, key)}
              </p>
            );
          case "quote":
            return <blockquote key={key}>{lines(block.text, key)}</blockquote>;
          case "code":
            return (
              <pre key={key}>
                <code>{block.text}</code>
              </pre>
            );
          case "list": {
            const items = block.items.map((item) => (
              <li key={`l${item.line}`}>{inline(item.text, `l${item.line}`)}</li>
            ));
            return block.ordered ? <ol key={key}>{items}</ol> : <ul key={key}>{items}</ul>;
          }
          default:
            return <p key={key}>{lines(block.text, key)}</p>;
        }
      })}
    </div>
  );
}
