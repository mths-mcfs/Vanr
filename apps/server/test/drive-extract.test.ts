// The Drive's extraction without a server: text per page of PDF, Word, PowerPoint and Excel, and the limits
// against a hostile file (zip bomb, a zip with thousands of entries, the Worker's deadline).
import { describe, expect, test } from "bun:test";
import { strToU8, zipSync } from "fflate";
import { extractInWorker } from "../src/drive-extract";
import { DEFAULT_LIMITS, extractPages, readZip } from "../src/drive-extract-core";
import { makeDocx, makePdf, makePptx, makeXlsx } from "./files";

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

describe("extraction by type", () => {
  test("PDF: one page of text per page", async () => {
    const pages = await extractPages(makePdf(["Lease agreement", "Termination penalty"]), "application/pdf");
    expect(pages).toEqual([
      { page: 1, markdown: "Lease agreement" },
      { page: 2, markdown: "Termination penalty" },
    ]);
  });

  test("Word: paragraphs and headings become markdown; XML entities go back to text", async () => {
    const pages = await extractPages(
      makeDocx([{ text: "Proposal", style: "Heading1" }, { text: "Deadline &amp; price" }]),
      DOCX,
    );
    expect(pages).toEqual([{ page: 1, markdown: "# Proposal\n\nDeadline & price" }]);
  });

  test("PowerPoint: one slide per page, in numeric order (slide10 after slide2)", async () => {
    const slides = Array.from({ length: 10 }, (_, i) => [`Slide ${i + 1}`]);
    const pages = await extractPages(makePptx(slides), PPTX);
    expect(pages.map((p) => p.page)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(pages[9]?.markdown).toBe("Slide 10");
  });

  test("Excel: one sheet per page with the name and the cells (shared text and number)", async () => {
    const pages = await extractPages(
      makeXlsx([
        {
          name: "Sales",
          rows: [
            ["Car", "Price"],
            ["Beetle", 50000],
          ],
        },
        { name: "Costs", rows: [["Rent", 3000]] },
      ]),
      XLSX,
    );
    expect(pages).toEqual([
      { page: 1, markdown: "## Sales\n\nCar\tPrice\nBeetle\t50000" },
      { page: 2, markdown: "## Costs\n\nRent\t3000" },
    ]);
  });

  test("plain text and a type without text", async () => {
    expect(await extractPages(new TextEncoder().encode("hi"), "text/plain")).toEqual([
      { page: 1, markdown: "hi" },
    ]);
    expect(await extractPages(new Uint8Array([1, 2, 3]), "video/mp4")).toEqual([]);
  });
});

describe("hostile file", () => {
  test("zip bomb: 30 MB of XML in 30 KB stops at the 20 MB limit per entry, counting what comes out", async () => {
    const bomb = zipSync({ "word/document.xml": strToU8("a".repeat(30 * 1024 * 1024)) }, { level: 9 });
    expect(bomb.length).toBeLessThan(200_000);
    const t0 = performance.now();
    await expect(extractPages(bomb, DOCX)).rejects.toThrow("beyond the limit");
    expect(performance.now() - t0).toBeLessThan(5000);
  });

  test("zip bomb with a size that lies in the header: the limit counts the uncompressed bytes", () => {
    const zip = zipSync({ "word/document.xml": strToU8("b".repeat(3 * 1024 * 1024)) }, { level: 9 });
    // The uncompressed size in the local header (offset 22) and in the central directory becomes 10 bytes.
    const view = new DataView(zip.buffer);
    view.setUint32(22, 10, true);
    const cd = zip.length - 22 - 46 - "word/document.xml".length;
    view.setUint32(cd + 24, 10, true);
    expect(() => readZip(zip, () => true, { ...DEFAULT_LIMITS, entryBytes: 1024 * 1024 })).toThrow(
      "beyond the limit",
    );
  });

  test("a zip with too many entries is rejected", () => {
    const files: Record<string, Uint8Array> = {};
    for (let i = 0; i < 30; i++) files[`x/${i}.xml`] = strToU8("x");
    expect(() => readZip(zipSync(files), () => false, { ...DEFAULT_LIMITS, entries: 20 })).toThrow(
      "too many",
    );
  });

  test("XML without the closing tag doesn't hang the reading: 400 thousand `<w:p >` (4 KB of zip) in under 1 s", async () => {
    // A review attack: the lazy regex scanned to the end each time at `<w:p` and held the tick for 60 s.
    const open = (tag: string) => `<${tag} `.repeat(400_000);
    const cases: [string, Record<string, string>][] = [
      [DOCX, { "word/document.xml": `<w:document><w:body>${open("w:p")}<w:p><w:t>end</w:t></w:body>` }],
      [PPTX, { "ppt/slides/slide1.xml": `<p:sld>${open("a:p")}${open("a:t")}</p:sld>` }],
      [
        XLSX,
        {
          "xl/sharedStrings.xml": `<sst>${"<si>".repeat(400_000)}</sst>`,
          "xl/workbook.xml": `<workbook>${open("sheet")}</workbook>`,
          "xl/worksheets/sheet1.xml": `<worksheet><row>${open("c")}</row></worksheet>`,
        },
      ],
    ];
    for (const [type, files] of cases) {
      const zip = zipSync(
        Object.fromEntries(
          Object.entries({ "[Content_Types].xml": "<Types/>", ...files }).map(([k, v]) => [k, strToU8(v)]),
        ),
        { level: 9 },
      );
      const t = performance.now();
      await extractPages(zip, type);
      expect(performance.now() - t).toBeLessThan(1000);
    }
  });

  test("the text cap cuts the total across the pages", async () => {
    const pages = await extractPages(makePdf(["aaaa bbbb", "cccc dddd"]), "application/pdf", {
      ...DEFAULT_LIMITS,
      textChars: 12,
    });
    expect(pages.map((p) => p.markdown).join("|")).toBe("aaaa bbbb|ccc");
  });

  test("Worker: extracts off the thread and, past the deadline, terminates and fails", async () => {
    const pdf = makePdf(["Hello from the worker"]);
    expect(await extractInWorker(pdf.slice(), "application/pdf")).toEqual([
      { page: 1, markdown: "Hello from the worker" },
    ]);
    await expect(extractInWorker(pdf.slice(), "application/pdf", 1)).rejects.toThrow("timed out");
    await expect(extractInWorker(new TextEncoder().encode("%PDF-junk"), "application/pdf")).rejects.toThrow();
  });
});

// Limits of the origin that had no test of their own.
describe("hostile file: limits without a test in the origin", () => {
  test("the zip's total cap: entries each under the per-entry limit stop at the total", () => {
    const zip = zipSync({ "a.xml": strToU8("a".repeat(600_000)), "b.xml": strToU8("b".repeat(600_000)) });
    expect(() =>
      readZip(zip, () => true, { ...DEFAULT_LIMITS, entryBytes: 1_000_000, zipBytes: 1_000_000 }),
    ).toThrow("beyond the limit");
  });

  test("a zip inside the zip is not opened: only the document's own entries are read", async () => {
    const inner = zipSync({ "word/document.xml": strToU8("c".repeat(30 * 1024 * 1024)) }, { level: 9 });
    const docx = zipSync({
      "[Content_Types].xml": strToU8("<Types/>"),
      "word/document.xml": strToU8(
        '<?xml version="1.0"?><w:document><w:body><w:p><w:r><w:t>Outer text</w:t></w:r></w:p></w:body></w:document>',
      ),
      "word/embeddings/inner.zip": inner,
    });
    expect(await extractPages(docx, DOCX)).toEqual([{ page: 1, markdown: "Outer text" }]);
  });

  test("a malformed PDF fails with an error; a .docx that is not a zip gives no text, without hanging", async () => {
    await expect(
      extractPages(new TextEncoder().encode("%PDF-1.4 no objects"), "application/pdf"),
    ).rejects.toThrow();
    expect(await extractPages(new TextEncoder().encode("PK not really a zip"), DOCX)).toEqual([]);
  });
});
