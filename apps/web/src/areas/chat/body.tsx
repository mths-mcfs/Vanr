// A message's text as people write it: paragraphs, quotes, lists and fenced code, with bold, italic,
// strikethrough, inline code, links and @mentions inside. Everything becomes React elements; no text is
// ever read as HTML, and a link opens only when it is a web or mail address.
import { Fragment, type ReactNode } from "react";

export type Block =
  | { kind: "paragraph"; lines: string[] }
  | { kind: "quote"; lines: string[] }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "code"; text: string };

const BULLET = /^\s*[-*]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;
const QUOTED = /^>\s?(.*)$/;
const FENCE = /^```/;

/** The text split into its blocks. An unclosed fence runs to the end. */
export function blocksOf(text: string): Block[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (FENCE.test(line)) {
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !FENCE.test(lines[i] ?? "")) body.push(lines[i++] ?? "");
      i += 1;
      blocks.push({ kind: "code", text: body.join("\n") });
      continue;
    }
    if (line.trim() === "") {
      i += 1;
      continue;
    }
    const take = (pattern: RegExp) => {
      const taken: string[] = [];
      while (i < lines.length) {
        const match = pattern.exec(lines[i] ?? "");
        if (match === null) break;
        taken.push(match[1] ?? "");
        i += 1;
      }
      return taken;
    };
    if (QUOTED.test(line)) blocks.push({ kind: "quote", lines: take(QUOTED) });
    else if (BULLET.test(line)) blocks.push({ kind: "list", ordered: false, items: take(BULLET) });
    else if (NUMBERED.test(line)) blocks.push({ kind: "list", ordered: true, items: take(NUMBERED) });
    else {
      const taken: string[] = [];
      while (i < lines.length) {
        const next = lines[i] ?? "";
        if (
          next.trim() === "" ||
          FENCE.test(next) ||
          QUOTED.test(next) ||
          BULLET.test(next) ||
          NUMBERED.test(next)
        )
          break;
        taken.push(next);
        i += 1;
      }
      blocks.push({ kind: "paragraph", lines: taken });
    }
  }
  return blocks;
}

export type Inline =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "strong" | "em" | "strike"; children: Inline[] }
  | { kind: "link"; href: string; children: Inline[] }
  | { kind: "mention"; handle: string };

// The first of these to match at a position wins; the order puts code first so nothing inside it is read.
const INLINE: { pattern: RegExp; make: (match: RegExpExecArray) => Inline }[] = [
  { pattern: /`([^`\n]+)`/y, make: (m) => ({ kind: "code", text: m[1] ?? "" }) },
  {
    pattern: /\[([^\]\n]+)\]\(([^)\s]+)\)/y,
    make: (m) => ({ kind: "link", href: m[2] ?? "", children: inlineOf(m[1] ?? "") }),
  },
  {
    pattern: /\*\*(?=\S)([^\n]*?\S)\*\*/y,
    make: (m) => ({ kind: "strong", children: inlineOf(m[1] ?? "") }),
  },
  { pattern: /~~(?=\S)([^\n]*?\S)~~/y, make: (m) => ({ kind: "strike", children: inlineOf(m[1] ?? "") }) },
  { pattern: /[*_](?=\S)([^*_\n]*?\S)[*_]/y, make: (m) => ({ kind: "em", children: inlineOf(m[1] ?? "") }) },
  {
    pattern: /https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]/y,
    make: (m) => ({ kind: "link", href: m[0], children: [{ kind: "text", text: m[0] }] }),
  },
  {
    pattern: /@([A-Za-z0-9][A-Za-z0-9_.-]*[A-Za-z0-9_]|[A-Za-z0-9])/y,
    make: (m) => ({ kind: "mention", handle: m[1] ?? "" }),
  },
];

/** Whether the character before `at` lets an emphasis or a mention start there. */
const startsWord = (text: string, at: number) => at === 0 || /[\s([{>"'*_~]/.test(text[at - 1] ?? "");

/** The inline pieces of one line. */
export function inlineOf(text: string): Inline[] {
  const out: Inline[] = [];
  let plain = "";
  let at = 0;
  const flush = () => {
    if (plain !== "") out.push({ kind: "text", text: plain });
    plain = "";
  };
  outer: while (at < text.length) {
    for (const { pattern, make } of INLINE) {
      const char = text[at];
      const wordy = char === "@" || char === "*" || char === "_" || char === "~";
      if (wordy && !startsWord(text, at)) continue;
      pattern.lastIndex = at;
      const match = pattern.exec(text);
      if (match === null) continue;
      flush();
      // The end is read before `make`: building the inside parses again with the same patterns.
      const end = at + match[0].length;
      out.push(make(match));
      at = end;
      continue outer;
    }
    plain += text[at];
    at += 1;
  }
  flush();
  return out;
}

const SAFE_LINK = /^(https?:\/\/|mailto:)/i;

export type MentionLookup = (handle: string) => { name: string; kind: "agent" | "person" } | undefined;

function inlinePiece(piece: Inline, mention: MentionLookup): ReactNode {
  switch (piece.kind) {
    case "text":
      return piece.text;
    case "code":
      return <code>{piece.text}</code>;
    case "strong":
      return <strong>{renderInline(piece.children, mention)}</strong>;
    case "em":
      return <em>{renderInline(piece.children, mention)}</em>;
    case "strike":
      return <s>{renderInline(piece.children, mention)}</s>;
    case "link":
      return SAFE_LINK.test(piece.href) ? (
        <a href={piece.href} target="_blank" rel="noopener noreferrer nofollow">
          {renderInline(piece.children, mention)}
        </a>
      ) : (
        renderInline(piece.children, mention)
      );
    case "mention": {
      const found = mention(piece.handle);
      if (found === undefined) return `@${piece.handle}`;
      return (
        <span className="chat-mention" data-kind={found.kind} title={found.name}>
          @{piece.handle}
        </span>
      );
    }
  }
}

function renderInline(pieces: Inline[], mention: MentionLookup): ReactNode[] {
  return pieces.map((piece, index) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: the pieces of a message never move.
    <Fragment key={`${piece.kind}-${index}`}>{inlinePiece(piece, mention)}</Fragment>
  ));
}

function lines(texts: string[], mention: MentionLookup): ReactNode[] {
  return texts.flatMap((text, index) => [
    // biome-ignore lint/suspicious/noArrayIndexKey: the lines of a message never move.
    index > 0 ? <br key={`br-${index}`} /> : null,
    // biome-ignore lint/suspicious/noArrayIndexKey: the lines of a message never move.
    <Fragment key={`line-${index}`}>{renderInline(inlineOf(text), mention)}</Fragment>,
  ]);
}

function blockElement(block: Block, mention: MentionLookup): ReactNode {
  switch (block.kind) {
    case "paragraph":
      return <p>{lines(block.lines, mention)}</p>;
    case "quote":
      return <blockquote>{lines(block.lines, mention)}</blockquote>;
    case "code":
      return (
        <pre>
          <code>{block.text}</code>
        </pre>
      );
    case "list": {
      const List = block.ordered ? "ol" : "ul";
      return (
        <List>
          {block.items.map((item, at) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: the items of a message never move.
            <li key={at}>{renderInline(inlineOf(item), mention)}</li>
          ))}
        </List>
      );
    }
  }
}

export function MessageBody({ text, mention }: { text: string; mention: MentionLookup }) {
  return (
    <div className="chat-body">
      {blocksOf(text).map((block, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the blocks of a message never move.
        <Fragment key={`${block.kind}-${index}`}>{blockElement(block, mention)}</Fragment>
      ))}
    </div>
  );
}
