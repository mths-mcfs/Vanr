// Wiki editor schema on Milkdown 7 (ProseMirror + remark), the same in the browser and on the server.
// The markdown is the source of truth and the round trip md → editor → md must not change the text.
// What plain markdown does not know becomes an atom that comes out identical:
// - `wiki_link`: [[target]], [[target|text]], [[target#Heading]], [[target#^block]], ![[embed]];
// - `wiki_raw`: %%comment%%, ==highlight==, [!callout], $math$, #tag, ^block id, link reference and
//   definition (`[x][ref]`, `[ref]: url`), a lone `<br>`, $$ and %% blocks.
import { remarkStringifyOptionsCtx } from "@milkdown/kit/core";
import type { Ctx, MilkdownPlugin } from "@milkdown/kit/ctx";
import { commonmark, syncHeadingIdPlugin } from "@milkdown/kit/preset/commonmark";
import { gfm, tableCellSchema, tableHeaderSchema } from "@milkdown/kit/preset/gfm";
import { $nodeSchema, $remark, type GetNodeSchema } from "@milkdown/kit/utils";
import { parseLinkInner } from "./links";

export type RawKind = "comment" | "mark" | "callout" | "math" | "tag" | "block" | "ref" | "html";

/** Inline snippets kept as atoms. Order matters: links before everything else. */
export const INLINE_RAW =
  /!?\[\[[^\]\n]+?\]\]|%%[^\n]*?%%|==[^=\n]+==|\[![A-Za-z-]+\][+-]?|\$(?=\S)[^$\n]*?\S\$(?!\d)|(?<=^|\s)#[\p{L}\p{N}_/-]*\p{L}[\p{L}\p{N}_/-]*|(?<=\s)\^[A-Za-z0-9-]+(?=\s*$)/mu;

/**
 * A whole paragraph that is a raw block: $$ math $$, a multi-line %% comment %%, or a paragraph with an
 * HTML tag split over more than one line (the indentation of the inner lines would be lost). The same
 * as `/^(?:\$\$[\s\S]*?\$\$|%%[\s\S]*?%%)\s*$|<[A-Za-z][\w-]*\s[^<>]*\n[^<>]*>/`, in one pass: that
 * expression backtracks over every line break of an unclosed tag (quadratic in the paragraph).
 */
export function isBlockRaw(text: string): boolean {
  const trimmed = text.trimEnd();
  for (const fence of ["$$", "%%"])
    if (trimmed.length >= 4 && trimmed.startsWith(fence) && trimmed.endsWith(fence)) return true;
  // `<tag` then one space; then up to the first `<` or `>`: a `>` there with a line break before it.
  const word = /[\w-]/;
  for (let i = text.indexOf("<"); i >= 0; ) {
    let j = i + 1;
    if (!/[A-Za-z]/.test(text[j] ?? "")) {
      i = text.indexOf("<", j);
      continue;
    }
    j++;
    while (j < text.length && word.test(text[j] as string)) j++;
    if (!/\s/.test(text[j] ?? "")) {
      i = text.indexOf("<", j);
      continue;
    }
    let broken = false;
    for (j++; j < text.length && text[j] !== "<" && text[j] !== ">"; j++) if (text[j] === "\n") broken = true;
    if (text[j] === ">" && broken) return true;
    i = text.indexOf("<", j);
  }
  return false;
}

export function rawKind(raw: string): RawKind | "link" {
  if (raw.startsWith("[[") || raw.startsWith("![[")) return "link";
  if (raw.startsWith("%%")) return "comment";
  if (raw.startsWith("==")) return "mark";
  if (raw.startsWith("[!")) return "callout";
  if (raw.startsWith("$")) return "math";
  if (raw.startsWith("#")) return "tag";
  if (raw.startsWith("^")) return "block";
  if (raw.startsWith("<")) return "html";
  return "ref";
}

type MdNode = {
  type: string;
  value?: string;
  children?: MdNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
};

const atom = (raw: string): MdNode =>
  rawKind(raw) === "link" ? { type: "wikiLink", value: raw } : { type: "wikiRaw", value: raw };

/**
 * A remark plugin that runs before commonmark: replaces the syntax Milkdown does not know (or would
 * rewrite) with `wikiLink`/`wikiRaw` nodes holding the original text, using the position in the source.
 */
export function remarkWikiSyntax() {
  return (tree: unknown, file: unknown) => {
    const src = String(file);
    const inline = new RegExp(INLINE_RAW.source, "gmu");
    const walk = (node: MdNode) => {
      if (!node.children) return;
      const flow = node.type === "root" || node.type === "blockquote" || node.type === "listItem";
      const out: MdNode[] = [];
      for (const child of node.children) {
        const a = child.position?.start.offset;
        const b = child.position?.end.offset;
        const slice = a !== undefined && b !== undefined ? src.slice(a, b) : null;
        if (slice !== null) {
          if (child.type === "paragraph" && isBlockRaw(slice)) {
            out.push({ type: "paragraph", children: [{ type: "wikiRaw", value: slice.trimEnd() }] });
            continue;
          }
          // Reference and definition: Milkdown turns them into inline links (remark-inline-links).
          if (child.type === "linkReference" || child.type === "imageReference") {
            out.push({ type: "wikiRaw", value: slice });
            continue;
          }
          if (child.type === "definition") {
            out.push({ type: "paragraph", children: [{ type: "wikiRaw", value: slice }] });
            continue;
          }
          // A lone `<br>` in a block: Milkdown reads it as an empty paragraph and writes `<br />`.
          if (flow && child.type === "html" && /^<br\s*\/?>$/i.test((child.value ?? "").trim())) {
            out.push({ type: "paragraph", children: [{ type: "wikiRaw", value: child.value ?? "" }] });
            continue;
          }
        }
        if (child.type === "text" && child.value) {
          let last = 0;
          for (const m of child.value.matchAll(inline)) {
            const at = m.index ?? 0;
            if (at > last) out.push({ type: "text", value: child.value.slice(last, at) });
            out.push(atom(m[0]));
            last = at + m[0].length;
          }
          if (last === 0) out.push(child);
          else if (last < child.value.length) out.push({ type: "text", value: child.value.slice(last) });
          continue;
        }
        walk(child);
        out.push(child);
      }
      node.children = out;
    };
    walk(tree as MdNode);
  };
}

const wikiSyntax = $remark("wikiSyntax", () => remarkWikiSyntax);

/** The link label on screen: the link text, or the target with the anchor. */
export function linkLabel(raw: string): string {
  const inner = raw.replace(/^!?\[\[|\]\]$/g, "");
  const { target, anchor, linkText } = parseLinkInner(inner);
  if (linkText) return linkText;
  if (!target && anchor) return anchor;
  return anchor ? `${target} › ${anchor}` : target;
}

export const wikiLinkNode = $nodeSchema("wiki_link", () => ({
  group: "inline",
  inline: true,
  atom: true,
  attrs: { raw: { default: "" } },
  toDOM: (node) => {
    const raw = String(node.attrs.raw);
    const embed = raw.startsWith("!");
    const { target, anchor } = parseLinkInner(raw.replace(/^!?\[\[|\]\]$/g, ""));
    return [
      "span",
      {
        class: embed ? "wiki-link wiki-link--embed" : "wiki-link",
        "data-raw": raw,
        "data-target": target,
        "data-anchor": anchor ?? "",
      },
      linkLabel(raw),
    ];
  },
  parseDOM: [
    {
      tag: "span.wiki-link[data-raw]",
      getAttrs: (dom) => ({
        raw: (dom as { getAttribute(name: string): string | null }).getAttribute("data-raw") ?? "",
      }),
    },
  ],
  parseMarkdown: {
    match: (n) => n.type === "wikiLink",
    runner: (state, n, type) => {
      state.addNode(type, { raw: String(n.value ?? "") });
    },
  },
  toMarkdown: {
    match: (n) => n.type.name === "wiki_link",
    runner: (state, n) => {
      state.addNode("wikiRaw", undefined, String(n.attrs.raw));
    },
  },
}));

export const wikiRawNode = $nodeSchema("wiki_raw", () => ({
  group: "inline",
  inline: true,
  atom: true,
  attrs: { raw: { default: "" } },
  toDOM: (node) => {
    const raw = String(node.attrs.raw);
    return ["span", { class: `wiki-raw wiki-raw--${rawKind(raw)}`, "data-raw": raw }, raw];
  },
  parseDOM: [
    {
      tag: "span.wiki-raw[data-raw]",
      getAttrs: (dom) => ({
        raw: (dom as { getAttribute(name: string): string | null }).getAttribute("data-raw") ?? "",
      }),
    },
  ],
  parseMarkdown: {
    match: (n) => n.type === "wikiRaw",
    runner: (state, n, type) => {
      state.addNode(type, { raw: String(n.value ?? "") });
    },
  },
  toMarkdown: {
    match: (n) => n.type.name === "wiki_raw",
    runner: (state, n) => {
      state.addNode("wikiRaw", undefined, String(n.attrs.raw));
    },
  },
}));

// In remark-stringify, `peek` tells the first character of the node. With the default (`<`, from html),
// a line break before `[[x]]` turned into a space: the raw text came from that position, so this is safe.
const rawHandler = Object.assign((node: { value: string }) => node.value, { peek: () => "a" });

/**
 * Serializer options: `-` for lists and rules, and the handler for the atoms. Goes in the editor's
 * `.config()`: Milkdown's init reads the options once, before running the plugins.
 */
export function configureWikiMarkdown(ctx: Ctx) {
  ctx.update(remarkStringifyOptionsCtx, (o) => ({
    ...o,
    bullet: "-" as const,
    rule: "-" as const,
    handlers: { ...(o.handlers ?? {}), wikiRaw: rawHandler as never },
  }));
}

/**
 * A cell without alignment stays `null`, as remark reads it. gfm defaults to "left"; Yjs does not keep
 * null attributes, so the cell came back from the live session as "left" and a table nobody touched
 * went out with `:---` on publish.
 */
const alignNull =
  (prev: GetNodeSchema): GetNodeSchema =>
  (ctx) => {
    const spec = prev(ctx);
    return { ...spec, attrs: { ...spec.attrs, alignment: { ...spec.attrs?.alignment, default: null } } };
  };

/**
 * Plugins in `.use()` order: the wiki syntax before commonmark (to catch references before
 * remark-inline-links), then the presets and the changes to their schema. No plugin here may change
 * the document on its own when it opens: in Yjs, that counts as an edit.
 */
export const wikiMarkdownPlugins: MilkdownPlugin[] = [
  wikiSyntax,
  wikiLinkNode,
  wikiRawNode,
  // Without the automatic heading ids: the browser wrote them into the document when the page opened,
  // and in Yjs that becomes an edit by someone who is only reading (a dirty draft and the wrong author).
  // The table of contents uses the heading position, not the id.
  commonmark.filter((p) => p !== syncHeadingIdPlugin),
  gfm,
  tableCellSchema.extendSchema(alignNull),
  tableHeaderSchema.extendSchema(alignNull),
].flat();

/** Finishing touches on the text the serializer returns. */
export function finishMarkdown(md: string): string {
  // An empty list item: Milkdown writes `<br />` to keep the empty paragraph.
  return md.replace(/^(\s*(?:[-*+]|\d+[.)])(?: \[[ xX]\])?) <br \/>$/gm, "$1");
}
