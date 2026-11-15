// The Drive's extraction without a server: text per page of PDF, Word, PowerPoint and Excel, and the limits
// against a hostile file (zip bomb, a zip with thousands of entries, the Worker's deadline).
import { describe, expect, spyOn, test } from "bun:test";
import { strToU8, UnzipInflate, zipSync } from "fflate";
import { extractInWorker } from "../src/drive-extract";
import { DEFAULT_LIMITS, ExtractError, extractPages, readZip } from "../src/drive-extract-core";
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

// The base layer's own bounds on Office files (sparse cells, column limits, reordered manifests, inflation).
const zip = (files: Record<string, string>) =>
  zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])));
const cell = (r: string, text: string) => `<c r="${r}" t="inlineStr"><is><t>${text}</t></is></c>`;
const sheet = (rows: string) => `<worksheet><sheetData>${rows}</sheetData></worksheet>`;
const manifest = '<sheet name="First" r:id="rId2"/><sheet name="Second" r:id="rId1"/>';
const rels = (folder: string, part: string) =>
  `<Relationships><Relationship Id="rId1" Target="${folder}/${part}1.xml"/><Relationship Id="rId2" Target="/${folder === "slides" ? "ppt" : "xl"}/${folder}/${part}2.xml"/></Relationships>`;
const workbook = (rows: string) =>
  zip({
    "xl/workbook.xml": `<workbook><sheets>${manifest}</sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": rels("worksheets", "sheet"),
    "xl/worksheets/sheet1.xml": sheet(rows),
    "xl/worksheets/sheet2.xml": sheet(`<row>${cell("A1", "Start")}</row>`),
  });

test.each(["A", "XFD"])("XLSX bounds text and sparse gaps before assembly: %s", async (column) => {
  const limit = 1024;
  const value = column === "A" ? "x".repeat(limit) : "END";
  const bytes = workbook(
    Array.from({ length: 10 }, (_, i) => `<row>${cell(`${column}${i + 1}`, value)}</row>`).join(""),
  );
  let joined = 0;
  const join = Array.prototype.join;
  const spy = spyOn(Array.prototype, "join").mockImplementation(function (this: unknown[], separator) {
    const out = join.call(this, separator);
    if (separator === "\t" || separator === "\n") joined += out.length;
    return out;
  });
  try {
    const pages = await extractPages(
      bytes,
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      { ...DEFAULT_LIMITS, textChars: limit },
    );
    spy.mockRestore();
    const first = "## First\n\nStart";
    const second = "## Second\n\n";
    expect(pages).toEqual([
      { page: 1, markdown: first },
      {
        page: 2,
        markdown: second + (column === "A" ? "x" : "\t").repeat(limit - first.length - second.length),
      },
    ]);
    expect(joined + "## First\n\n".length + second.length).toBeLessThanOrEqual(limit);
  } finally {
    spy.mockRestore();
  }
});

test("XLSX rejects columns beyond XFD before expanding gaps", async () => {
  for (const column of ["XFE", "ZZZZZ"])
    await expect(
      extractPages(
        workbook(`<row>${cell(`${column}1`, "END")}</row>`),
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        { ...DEFAULT_LIMITS, textChars: 1024 },
      ),
    ).rejects.toBeInstanceOf(ExtractError);
});

test("Office manifests preserve reordered pages, sheet names and sparse cell columns", async () => {
  const pages = await extractPages(
    zip({
      "xl/workbook.xml": `<workbook><sheets>${manifest}</sheets></workbook>`,
      "xl/_rels/workbook.xml.rels": rels("worksheets", "sheet"),
      "xl/worksheets/sheet1.xml": sheet(`<row>${cell("A1", "Second content")}</row>`),
      "xl/worksheets/sheet2.xml": sheet(
        `<row>${cell("A1", "Item")}${cell("B1", "Quantity")}${cell("C1", "Price")}</row><row>${cell("A2", "Apples")}<c r="C2"><v>9.99</v></c></row>`,
      ),
    }),
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
  expect(pages).toEqual([
    { page: 1, markdown: "## First\n\nItem\tQuantity\tPrice\nApples\t\t9.99" },
    { page: 2, markdown: "## Second\n\nSecond content" },
  ]);
  expect(
    await extractPages(
      zip({
        "ppt/presentation.xml":
          '<p:presentation><p:sldIdLst><p:sldId r:id="rId2"/><p:sldId r:id="rId1"/></p:sldIdLst></p:presentation>',
        "ppt/_rels/presentation.xml.rels": rels("slides", "slide"),
        "ppt/slides/slide1.xml": "<a:p><a:t>Second slide</a:t></a:p>",
        "ppt/slides/slide2.xml": "<a:p><a:t>First slide</a:t></a:p>",
      }),
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ),
  ).toEqual([
    { page: 1, markdown: "First slide" },
    { page: 2, markdown: "Second slide" },
  ]);
});

test("ZIP limits stop incremental inflation before a whole compressed entry expands", () => {
  let largest = 0;
  const push = UnzipInflate.prototype.push;
  const spy = spyOn(UnzipInflate.prototype, "push").mockImplementation(function (
    this: UnzipInflate,
    chunk,
    final,
  ) {
    const ondata = this.ondata;
    this.ondata = (err, data, done) => {
      if (data) largest = Math.max(largest, data.length);
      ondata(err, data, done);
    };
    push.call(this, chunk, final);
    this.ondata = ondata;
  });
  try {
    const bytes = zipSync({ "word/document.xml": new Uint8Array(1024 * 1024).fill(65) });
    expect(() => readZip(bytes, () => true, { ...DEFAULT_LIMITS, entryBytes: 1024, zipBytes: 1024 })).toThrow(
      "zip expands beyond the limit",
    );
    expect(largest).toBeLessThan(16 * 1024);
  } finally {
    spy.mockRestore();
  }
});
