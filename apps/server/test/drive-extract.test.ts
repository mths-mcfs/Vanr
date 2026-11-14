import { expect, spyOn, test } from "bun:test";
import { strToU8, UnzipInflate, zipSync } from "fflate";
import { DEFAULT_LIMITS, ExtractError, extractPages, readZip } from "../src/drive-extract-core";

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
