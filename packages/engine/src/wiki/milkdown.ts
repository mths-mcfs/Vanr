// Wiki editor schema on Milkdown 7 (ProseMirror + remark), the same in the browser and on the server.
// The markdown is the source of truth and the round trip md → editor → md must not change the text.
// What plain markdown does not know becomes an atom that comes out identical:
// - `wiki_link`: [[target]], [[target|text]], [[target#Heading]], [[target#^block]], ![[embed]];
// - `wiki_raw`: %%comment%%, ==highlight==, [!callout], $math$, #tag, ^block id, link reference and
//   definition (`[x][ref]`, `[ref]: url`), a lone `<br>`, $$ and %% blocks.
import { remarkStringifyOptionsCtx } from "@milkdown/kit/core";
import type { Ctx, MilkdownPlugin } from "@milkdown/kit/ctx";
import { commonmark, syncHeadingIdPlugin } from "@milkdown/kit/preset/commonmark";
import {
  extendListItemSchemaForTask,
  gfm,
  tableCellSchema,
  tableHeaderSchema,
} from "@milkdown/kit/preset/gfm";
import type { RemarkPluginRaw } from "@milkdown/kit/transformer";
import { $nodeSchema, $remark, type GetNodeSchema } from "@milkdown/kit/utils";
import { parseLinkInner } from "./links";

export type RawKind = "comment" | "mark" | "callout" | "math" | "tag" | "block" | "ref" | "html";

/** Inline snippets kept as atoms. Order matters: links before everything else. */
export const INLINE_RAW =
  /!?\[\[[^\]\n]+?\]\]|%%[^\n]*?%%|==[^=\n]+==|\[![A-Za-z-]+\][+-]?|\$(?=\S)[^$\n]*?\S\$(?!\d)|(?<=^|\s)#[\p{L}\p{N}_/-]*\p{L}[\p{L}\p{N}_/-]*|(?<=\s)\^[A-Za-z0-9-]+(?=\s*$)/mu;

/**
 * A whole paragraph that is a raw block: $$ math $$, a multi-line %% comment %%, or a paragraph with an
 * HTML tag split over more than one line (the indentation of the inner lines would be lost).
 */
const BLOCK_RAW = /^(?:\$\$[\s\S]*?\$\$|%%[\s\S]*?%%)\s*$|<[A-Za-z][\w-]*\s[^<>]*\n[^<>]*>/;

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
export function remarkWikiSyntax(this: ThisParameterType<RemarkPluginRaw<unknown>>) {
  // Consume raw source as an HTML token, before CommonMark decodes escapes or parses marks.
  const inline = new RegExp(`^(?:${INLINE_RAW.source})$`, "mu");
  const data = this.data();
  data.micromarkExtensions ??= [];
  type State = (code: number | null) => State | undefined;
  const construct: NonNullable<(typeof data.micromarkExtensions)[number]["text"]>[number] = {
    name: "wikiRaw",
    tokenize(effects, ok, nok) {
      let raw = "";
      let suffix = "";
      let prefix = "";
      let close = "";
      return start;
      function start(code: number | null): State | undefined {
        const c = String.fromCharCode(code ?? 0);
        prefix = c === "!" ? "![[" : c === "\\" ? "\\[[" : c === "[" ? "[[" : c === "$" ? "$" : c + c;
        close = prefix.endsWith("[[") ? "]]" : prefix;
        effects.enter("htmlText");
        return read(code);
      }
      function read(code: number | null): State | undefined {
        const c = code === -2 ? "\t" : String.fromCharCode(code ?? 0);
        if (raw.length >= prefix.length + close.length && suffix === close) {
          if (close === "$" && /\d/.test(c)) return nok(code);
          if (raw.startsWith("\\[[") || inline.test(raw)) {
            effects.exit("htmlText");
            return ok(code);
          }
          return nok(code);
        }
        if (code === null || code < -2) return nok(code);
        if (code === -1) {
          effects.consume(code);
          return read;
        }
        if (raw === "[" && c === "!") {
          prefix = "[!";
          close = "]";
        }
        if (raw.length < prefix.length) {
          if (c !== prefix[raw.length]) return nok(code);
        } else if (close === "]" && c !== "]" && !/[A-Za-z-]/.test(c)) return nok(code);
        else if (c === "[" && close === "]]" && raw.length > prefix.length && suffix.endsWith("["))
          return nok(code);
        raw += c;
        suffix = (suffix + c).slice(-close.length);
        effects.consume(code);
        return read;
      }
    },
  };
  data.micromarkExtensions.push({
    text: { 33: construct, 36: construct, 37: construct, 61: construct, 91: construct, 92: construct },
  });
  return (tree: unknown, file: unknown) => {
    const src = String(file);
    const walk = (node: MdNode) => {
      if (!node.children) return;
      const flow = node.type === "root" || node.type === "blockquote" || node.type === "listItem";
      const out: MdNode[] = [];
      for (const child of node.children) {
        const a = child.position?.start.offset;
        const b = child.position?.end.offset;
        const slice = a !== undefined && b !== undefined ? src.slice(a, b) : null;
        if (slice !== null) {
          if (child.type === "paragraph") {
            const prefix = a === undefined ? "" : src.slice(src.lastIndexOf("\n", a - 1) + 1, a);
            const quotes = prefix.match(/>/g)?.length ?? 0;
            const indent = prefix
              .replace(/[-+*]|\d+[.)]/g, (m) => " ".repeat(m.length))
              .replace(/[ \t]*>[ \t]?/g, "").length;
            const logical = slice
              .split("\n")
              .map((line, i) => {
                if (!i) return line;
                for (let q = 0; q < quotes; q++) line = line.replace(/^[ \t]*>[ \t]?/, "");
                return line.slice(indent);
              })
              .join("\n");
            if (BLOCK_RAW.test(logical)) {
              out.push({ type: "paragraph", children: [{ type: "wikiRaw", value: logical.trimEnd() }] });
              continue;
            }
          }
          if (child.type === "html" && (slice.startsWith("\\[[") || inline.test(slice))) {
            out.push(slice.startsWith("\\[[") ? { type: "wikiRaw", value: slice } : atom(slice));
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
          // Tags and block ids cannot contain CommonMark inline markup or escapes.
          for (const m of child.value.matchAll(
            /(?<=^|\s)#[\p{L}\p{N}_/-]*\p{L}[\p{L}\p{N}_/-]*|(?<=\s)\^[A-Za-z0-9-]+(?=\s*$)/gmu,
          )) {
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
  extendListItemSchemaForTask.extendSchema((prev) => (ctx) => {
    const spec = prev(ctx);
    return {
      ...spec,
      toMarkdown: {
        ...spec.toMarkdown,
        runner: (state, node) => {
          const first = node.firstChild;
          if (first?.type.name === "paragraph" && first.content.size === 0) {
            state.openNode("listItem", undefined, {
              label: node.attrs.label,
              listType: node.attrs.listType,
              spread: node.attrs.spread,
              checked: node.attrs.checked,
            });
            state.addNode("paragraph", []);
            state.next(node.content.cut(first.nodeSize));
            state.closeNode();
          } else spec.toMarkdown.runner(state, node);
        },
      },
    };
  }),
].flat();
