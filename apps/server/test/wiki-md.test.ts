// The server's md ↔ editor ↔ Yjs converter (the same schema as the browser).
import { describe, expect, test } from "bun:test";
import { Fragment, Slice } from "@milkdown/kit/prose/model";
import { Transform } from "@milkdown/kit/prose/transform";
import { splitFrontmatter } from "@vanr/engine/wiki/frontmatter";
import { VAULT_NOTES } from "@vanr/engine/wiki/vault-fixture";
import * as Y from "yjs";
import { wikiMarkdown, YFRAGMENT } from "../src/wiki-md";

describe("wiki-md", () => {
  test("creates without leaving window/document in the process", async () => {
    await wikiMarkdown();
    expect(typeof (globalThis as Record<string, unknown>).window).toBe("undefined");
    expect(typeof (globalThis as Record<string, unknown>).document).toBe("undefined");
  });

  test("test vault: md → editor → md without changing any block (with preservation)", async () => {
    const md = await wikiMarkdown();
    for (const note of VAULT_NOTES) {
      const { body } = splitFrontmatter(note.text);
      expect({ path: note.path, out: md.serializePreserving(md.parse(body), body) }).toEqual({
        path: note.path,
        out: body,
      });
    }
  });

  test("atoms: links, embeds, tags, highlight, comment, callout and block id come back the same", async () => {
    const md = await wikiMarkdown();
    const src =
      "See [[A|a]] and ![[img.png|300]] with #tag and ==ok== %%hidden%% end ^block-1\n\n> [!note] Title\n> body\n";
    expect(md.serialize(md.parse(src))).toBe(src);
    const json = JSON.stringify(md.parse(src).toJSON());
    expect(json).toContain('"wiki_link"');
    expect(json).toContain('"wiki_raw"');
  });

  test("editing one block preserves the original text of the others", async () => {
    const md = await wikiMarkdown();
    const base = "* one\n* two\n\nText __strong__ here.\n\nAnother paragraph.\n";
    const doc = md.parse(base);
    // Replaces only the last paragraph, as the editor would.
    const last = doc.child(doc.childCount - 1);
    const { schema } = md;
    const para = schema.nodes.paragraph?.create(null, schema.text("Changed."));
    if (!para) throw new Error("no paragraph in the schema");
    const edited = doc.replace(
      doc.content.size - last.nodeSize,
      doc.content.size,
      new Slice(Fragment.from(para), 0, 0),
    );
    expect(md.serialize(edited)).toBe("- one\n- two\n\nText __strong__ here.\n\nChanged.\n");
    expect(md.serializePreserving(edited, base)).toBe("* one\n* two\n\nText __strong__ here.\n\nChanged.\n");
  });

  test("preservation guard: neighbouring lists do not merge", async () => {
    const md = await wikiMarkdown();
    // Base with one list; the new document has a new list before it, separate.
    const base = "- b\n";
    const doc = md.parse("- a\n\n* b\n");
    expect(doc.childCount).toBe(2);
    const out = md.serializePreserving(doc, base);
    expect(md.parse(out).childCount).toBe(2);
  });

  test("Yjs: preserves unchanged table formatting", async () => {
    const md = await wikiMarkdown();
    const base =
      "Antes.\n\n| Item | Onde |\n| --- | --- |\n| Chave | Bancada 2 |\n\n" +
      "![npm](https://img.shields.io/npm/v/x.svg) and see [[Vacation]]\n";
    // The table does not lose its "no alignment" in Yjs (it used to come back as :---).
    const table = md.fromYDoc(md.toYDoc("| a | b |\n| --- | --- |\n"));
    expect(md.serialize(table)).toBe("| a | b |\n| - | - |\n");
    // Blocks that survive Yjs keep their original formatting.
    expect(md.serializePreserving(md.fromYDoc(md.toYDoc(base)), base)).toBe(base);
    // Editing only the first paragraph through the live session, the rest stays as it was.
    const ydoc = md.toYDoc(base);
    md.replaceYContent(ydoc, base.replace("Antes.", "Depois."));
    expect(md.serializePreserving(md.fromYDoc(ydoc), base)).toBe(base.replace("Antes.", "Depois."));
    for (const note of VAULT_NOTES) {
      const { body } = splitFrontmatter(note.text);
      const doc = md.fromYDoc(md.toYDoc(body));
      expect(md.serialize(md.parse(md.serializePreserving(doc, body)))).toBe(md.serialize(doc));
    }
  });

  test("Yjs: md → Y.Doc → md and a minimal swap keeps the block intact", async () => {
    const md = await wikiMarkdown();
    const ydoc = md.toYDoc("# T\n\nOne.\n\nTwo.\n");
    expect(md.serialize(md.fromYDoc(ydoc))).toBe("# T\n\nOne.\n\nTwo.\n");
    const first = ydoc.getXmlFragment(YFRAGMENT).get(1);
    md.replaceYContent(ydoc, "# T\n\nOne.\n\nThree.\n");
    expect(md.serialize(md.fromYDoc(ydoc))).toBe("# T\n\nOne.\n\nThree.\n");
    // The paragraph "One." is the same Yjs item (it was not deleted and recreated).
    expect(ydoc.getXmlFragment(YFRAGMENT).get(1)).toBe(first);
    expect(first instanceof Y.XmlElement).toBe(true);
  });
});

test("preservation respects deliberate mark removal from images and atoms", async () => {
  const md = await wikiMarkdown();
  for (const [base, mark] of [
    ["[![alt](https://img.test/a.png)](https://target.test/)\n", "link"],
    ["**[[A]]**\n", "strong"],
  ] as const) {
    const doc = md.parse(base);
    const edited = new Transform(doc).removeMark(0, doc.content.size, md.schema.marks[mark]).doc;
    expect(md.serializePreserving(edited, base)).toBe(md.serialize(edited));
  }
});
