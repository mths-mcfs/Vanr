// Wiki markdown on the server: md ↔ editor document (Milkdown, same schema as the browser) ↔
// Yjs. Milkdown only creates the converter by mounting a view, which reads `document`: the instance is born once
// with a happy-dom DOM put on `globalThis` only during create() and removed right after.
// Call `wikiMarkdown()` at boot, before accepting connections, so no other code runs
// while `window` exists.

import { Editor, parserCtx, rootCtx, schemaCtx, serializerCtx } from "@milkdown/kit/core";
import type { Node as PMNode, Schema } from "@milkdown/kit/prose/model";
import { configureWikiMarkdown, wikiMarkdownPlugins } from "@vanr/engine/wiki/milkdown";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { prosemirrorToYXmlFragment, updateYFragment, yXmlFragmentToProseMirrorRootNode } from "y-prosemirror";
import * as Y from "yjs";

/** Name of the fragment in the Y.Doc: the @milkdown/plugin-collab default. */
export const YFRAGMENT = "prosemirror";

export interface WikiMarkdown {
  schema: Schema;
  parse(md: string): PMNode;
  serialize(doc: PMNode): string;
  /**
   * Serializes keeping the original text of the blocks that did not change relative to `base` (the body
   * the document came from): editing one paragraph does not rewrite the whole page.
   */
  serializePreserving(doc: PMNode, base: string): string;
  /** Editor document → new Yjs state (to seed the live session). */
  toYDoc(md: string): Y.Doc;
  fromYDoc(doc: Y.Doc): PMNode;
  /**
   * Brings the fragment to the markdown's content with the smallest swap (equal prefix and suffix stay):
   * whoever is editing another block does not lose the cursor.
   */
  replaceYContent(doc: Y.Doc, md: string, origin?: unknown): void;
}

const DOM_KEYS = [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "Node",
  "MutationObserver",
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
] as const;

async function createEditor() {
  const { Window } = await import("happy-dom");
  const win = new Window();
  const saved = DOM_KEYS.map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)] as const);
  Object.assign(globalThis, {
    window: win,
    document: win.document,
    navigator: win.navigator,
    HTMLElement: win.HTMLElement,
    Node: win.Node,
    MutationObserver: win.MutationObserver,
    getComputedStyle: win.getComputedStyle.bind(win),
    requestAnimationFrame: (f: () => void) => setTimeout(f, 0),
    cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
  });
  try {
    const root = win.document.createElement("div");
    const editor = Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, root as unknown as Node);
        configureWikiMarkdown(ctx);
      })
      .use(wikiMarkdownPlugins);
    await editor.create();
    return editor.action((ctx) => ({
      schema: ctx.get(schemaCtx),
      parse: ctx.get(parserCtx),
      serialize: ctx.get(serializerCtx),
    }));
  } finally {
    for (const [k, d] of saved) {
      if (d) Object.defineProperty(globalThis, k, d);
      else delete (globalThis as Record<string, unknown>)[k];
    }
    await win.happyDOM.close();
  }
}

type Block = { start: number; end: number; text: string };
const blockParser = unified().use(remarkParse).use(remarkGfm);

/** Top-level blocks with their position in the text. */
function topBlocks(md: string): Block[] {
  const tree = blockParser.parse(md) as {
    children: { position?: { start: { offset?: number }; end: { offset?: number } } }[];
  };
  const out: Block[] = [];
  for (const c of tree.children) {
    const start = c.position?.start.offset;
    const end = c.position?.end.offset;
    if (start === undefined || end === undefined) return [];
    out.push({ start, end, text: md.slice(start, end) });
  }
  return out;
}

let ready: Promise<WikiMarkdown> | null = null;

export function wikiMarkdown(): Promise<WikiMarkdown> {
  ready ??= createEditor().then(({ schema, parse, serialize: ser }) => {
    const toDoc = (md: string): PMNode => {
      const doc = parse(md);
      if (!doc) throw new Error("wiki markdown: parse failed");
      return doc;
    };
    const canon = (text: string): string => ser(toDoc(text)).trim();

    // Canonical forms of the blocks of each base, cached: autosave serializes the same base
    // many times and each form costs one parse + serialize of the block.
    const baseCache = new Map<string, { origs: Block[]; keys: string[] }>();
    const baseInfo = (base: string) => {
      const hit = baseCache.get(base);
      if (hit) {
        baseCache.delete(base);
        baseCache.set(base, hit);
        return hit;
      }
      const origs = topBlocks(base);
      const info = { origs, keys: origs.map((b) => canon(b.text)) };
      baseCache.set(base, info);
      if (baseCache.size > 64) baseCache.delete(baseCache.keys().next().value as string);
      return info;
    };

    const serializePreserving = (doc: PMNode, base: string): string => {
      const full = ser(doc);
      if (!base.trim()) return full;
      const outs = topBlocks(full);
      const { origs, keys } = baseInfo(base);
      if (!outs.length || !origs.length) return full;
      // Queue of original indexes per canonical form; matches in ascending order. The output block already
      // is the serializer's form: its key is the text itself (the guard at the end covers the rest).
      const pool = new Map<string, number[]>();
      keys.forEach((key, i) => {
        const list = pool.get(key) ?? [];
        list.push(i);
        pool.set(key, list);
      });
      let lastOrig = -1;
      const picked: (number | null)[] = outs.map((b) => {
        const list = pool.get(b.text.trim());
        if (!list) return null;
        const at = list.findIndex((i) => i > lastOrig);
        if (at < 0) return null;
        const [i] = list.splice(at, 1);
        lastOrig = i ?? lastOrig;
        return i ?? null;
      });
      if (picked.every((p) => p === null)) return full;
      let out = "";
      for (let j = 0; j < outs.length; j++) {
        const o = outs[j] as Block;
        const i = picked[j];
        const prev = j > 0 ? picked[j - 1] : undefined;
        if (j === 0) out += i === 0 ? base.slice(0, origs[0]?.start ?? 0) : full.slice(0, o.start);
        else if (i != null && prev != null && i === prev + 1)
          out += base.slice((origs[prev] as Block).end, (origs[i] as Block).start);
        else out += full.slice((outs[j - 1] as Block).end, o.start);
        out += i != null ? (origs[i] as Block).text : o.text;
      }
      const lastPick = picked[outs.length - 1];
      out +=
        lastPick != null && lastPick === origs.length - 1
          ? base.slice((origs[lastPick] as Block).end)
          : full.slice((outs[outs.length - 1] as Block).end);
      // The preserved text must serialize as the edited document, including its marks.
      return ser(toDoc(out)) === full ? out : full;
    };

    return {
      schema,
      parse: toDoc,
      serialize: ser,
      serializePreserving,
      toYDoc(md) {
        const ydoc = new Y.Doc();
        prosemirrorToYXmlFragment(toDoc(md), ydoc.getXmlFragment(YFRAGMENT));
        return ydoc;
      },
      fromYDoc(ydoc) {
        return yXmlFragmentToProseMirrorRootNode(ydoc.getXmlFragment(YFRAGMENT), schema);
      },
      replaceYContent(ydoc, md, origin) {
        const fragment = ydoc.getXmlFragment(YFRAGMENT);
        const node = toDoc(md);
        // updateYFragment is the minimal diff that ySyncPlugin itself uses (exported, marked
        // unstable in y-prosemirror 1.3.7).
        ydoc.transact(() => {
          updateYFragment(ydoc, fragment, node, { mapping: new Map(), isOMark: new Map() });
        }, origin);
      },
    };
  });
  return ready;
}
