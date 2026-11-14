// Test files made on the spot (a PDF with text per page, docx, pptx, xlsx, PNG), with no binary kept
// in the repository.
import { strToU8, zipSync } from "fflate";
import sharp from "sharp";

/** A minimal PDF with one line of text (ASCII) per page and a correct xref. */
export function makePdf(pages: string[]): Uint8Array {
  const objs: string[] = [];
  const kids = pages.map((_, i) => `${3 + i * 2} 0 R`).join(" ");
  const font = 3 + pages.length * 2;
  objs.push("<< /Type /Catalog /Pages 2 0 R >>");
  objs.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  for (const [i, text] of pages.entries()) {
    const stream = `BT /F1 18 Tf 72 700 Td (${text.replace(/[()\\]/g, "\\$&")}) Tj ET`;
    objs.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${4 + i * 2} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> >>`,
    );
    objs.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  }
  objs.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const [i, body] of objs.entries()) {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

export function makeZip(files: Record<string, string | Uint8Array>): Uint8Array {
  return zipSync(
    Object.fromEntries(Object.entries(files).map(([k, v]) => [k, typeof v === "string" ? strToU8(v) : v])),
  );
}

const para = (text: string, style?: string) =>
  `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ""}<w:r><w:t>${text}</w:t></w:r></w:p>`;

export function makeDocx(paragraphs: { text: string; style?: string }[]): Uint8Array {
  return makeZip({
    "[Content_Types].xml": "<Types/>",
    "word/document.xml": `<?xml version="1.0"?><w:document><w:body>${paragraphs.map((p) => para(p.text, p.style)).join("")}</w:body></w:document>`,
  });
}

export function makePptx(slides: string[][]): Uint8Array {
  const files: Record<string, string> = { "[Content_Types].xml": "<Types/>" };
  for (const [i, lines] of slides.entries())
    files[`ppt/slides/slide${i + 1}.xml`] =
      `<p:sld><p:cSld><p:spTree>${lines.map((l) => `<a:p><a:r><a:t>${l}</a:t></a:r></a:p>`).join("")}</p:spTree></p:cSld></p:sld>`;
  return makeZip(files);
}

/** One sheet per item; the text cells go in sharedStrings. */
export function makeXlsx(sheets: { name: string; rows: (string | number)[][] }[]): Uint8Array {
  const shared: string[] = [];
  const files: Record<string, string> = {
    "[Content_Types].xml": "<Types/>",
    "xl/workbook.xml": `<workbook><sheets>${sheets.map((s, i) => `<sheet name="${s.name}" sheetId="${i + 1}"/>`).join("")}</sheets></workbook>`,
  };
  for (const [i, s] of sheets.entries()) {
    const rows = s.rows
      .map(
        (r) =>
          `<row>${r
            .map((cell) => {
              if (typeof cell === "number") return `<c><v>${cell}</v></c>`;
              shared.push(cell);
              return `<c t="s"><v>${shared.length - 1}</v></c>`;
            })
            .join("")}</row>`,
      )
      .join("");
    files[`xl/worksheets/sheet${i + 1}.xml`] = `<worksheet><sheetData>${rows}</sheetData></worksheet>`;
  }
  files["xl/sharedStrings.xml"] = `<sst>${shared.map((t) => `<si><t>${t}</t></si>`).join("")}</sst>`;
  return makeZip(files);
}

export async function makePng(width = 800, height = 600): Promise<Uint8Array> {
  const buf = await sharp({ create: { width, height, channels: 3, background: "#3366ff" } })
    .png()
    .toBuffer();
  return new Uint8Array(buf);
}
