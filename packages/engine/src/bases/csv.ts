// CSV round trip. Reading follows RFC 4180 (quotes, doubled quotes, line breaks inside a field, BOM, a
// `,` `;` or tab separator detected on the first line) and writing neutralizes formulas: a cell that starts
// with = + - @ tab or CR gets an apostrophe in front, so Excel and Sheets do not run it (CSV injection,
// OWASP). A negative number stays as it is. On the way back, the apostrophe is removed.
import { isCheckboxWord, type PropDef, type PropOption } from "../props";

export interface CsvLimits {
  maxBytes: number;
  maxRows: number;
  maxCols: number;
  maxCell: number;
}

export const CSV_LIMITS: CsvLimits = {
  maxBytes: 10_000_000,
  maxRows: 100_000,
  maxCols: 200,
  maxCell: 100_000,
};

export class CsvError extends Error {
  constructor(
    readonly code:
      | "too_large"
      | "too_many_rows"
      | "too_many_columns"
      | "cell_too_long"
      | "unterminated_quote"
      | "empty",
    readonly detail?: Record<string, number>,
  ) {
    super(code);
  }
}

function detectDelimiter(text: string): string {
  let inQuote = false;
  const counts: Record<string, number> = { ",": 0, ";": 0, "\t": 0 };
  for (const c of text.slice(0, 10_000)) {
    if (c === '"') inQuote = !inQuote;
    else if (!inQuote && c === "\n") break;
    else if (!inQuote && c in counts) counts[c] = (counts[c] ?? 0) + 1;
  }
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return best && best[1] > 0 ? best[0] : ",";
}

/** CSV text → rows of cells (the first is the header). Empty lines are dropped. */
export function parseCsv(input: string, limits: CsvLimits = CSV_LIMITS): string[][] {
  if (input.length > limits.maxBytes) throw new CsvError("too_large", { max: limits.maxBytes });
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const delim = detectDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let i = 0;
  let quoted = false;
  const endCell = () => {
    if (cell.length > limits.maxCell) throw new CsvError("cell_too_long", { max: limits.maxCell });
    row.push(cell);
    if (row.length > limits.maxCols) throw new CsvError("too_many_columns", { max: limits.maxCols });
    cell = "";
  };
  const endRow = () => {
    endCell();
    if (row.length > 1 || row[0] !== "") rows.push(row);
    if (rows.length > limits.maxRows + 1) throw new CsvError("too_many_rows", { max: limits.maxRows });
    row = [];
  };
  while (i < text.length) {
    const c = text[i] as string;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      cell += c;
      i++;
      continue;
    }
    if (c === '"' && cell === "") {
      quoted = true;
      i++;
    } else if (c === delim) {
      endCell();
      i++;
    } else if (c === "\r" && text[i + 1] === "\n") {
      endRow();
      i += 2;
    } else if (c === "\n" || c === "\r") {
      endRow();
      i++;
    } else {
      cell += c;
      i++;
    }
  }
  if (quoted) throw new CsvError("unterminated_quote");
  if (cell !== "" || row.length) endRow();
  if (!rows.length) throw new CsvError("empty");
  return rows.map(unprotectRow);
}

const RISKY = /^[=+\-@\t\r]/;
const NUMBER = /^-?\d+([.,]\d+)?([eE][+-]?\d+)?$/;

/** A cell a spreadsheet would read as a formula gets a `'` in front. */
export function protectCell(text: string): string {
  return RISKY.test(text) && !NUMBER.test(text) ? `'${text}` : text;
}

function unprotectRow(row: string[]): string[] {
  return row.map((c) => (/^'[=+\-@\t\r]/.test(c) ? c.slice(1) : c));
}

// Quote on `;` and tab too: the reader picks the separator from the first line, so a header with more
// `;` than commas outside quotes would switch the separator on the way back.
function quote(cell: string): string {
  return /[",;\t\n\r]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell;
}

/** Rows → CSV with commas and CRLF, already protected against formulas. */
export function toCsv(rows: readonly (readonly string[])[]): string {
  return rows.map((r) => r.map((c) => quote(protectCell(c))).join(",")).join("\r\n");
}

// ---------- schema inference on import ----------

const ISO_DAY = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/;
const URL_RE = /^https?:\/\/\S+$/i;

export interface InferredColumn {
  name: string;
  type: "text" | "number" | "checkbox" | "date" | "url" | "select";
  options?: PropOption[];
}

/**
 * Type of each column from its values: all numbers → number; all yes/no → checkbox; all ISO dates →
 * date; all http(s) links → URL; up to 25 distinct values that repeat → select; otherwise text.
 * The first column stays text (it is the row title).
 */
export function inferColumns(
  header: readonly string[],
  rows: readonly (readonly string[])[],
  newId: () => string,
): InferredColumn[] {
  return header.map((raw, col) => {
    const name = raw.trim() || `Column ${col + 1}`;
    if (col === 0) return { name, type: "text" };
    const values = rows.map((r) => (r[col] ?? "").trim()).filter(Boolean);
    if (!values.length) return { name, type: "text" };
    if (values.every((v) => NUMBER.test(v))) return { name, type: "number" };
    if (values.every(isCheckboxWord)) return { name, type: "checkbox" };
    if (values.every((v) => ISO_DAY.test(v))) return { name, type: "date" };
    if (values.every((v) => URL_RE.test(v))) return { name, type: "url" };
    const distinct = [...new Set(values)];
    if (
      distinct.length <= 25 &&
      distinct.every((v) => v.length <= 100 && !v.includes(",")) &&
      values.length >= distinct.length * 2
    ) {
      return { name, type: "select", options: distinct.map((v) => ({ id: newId(), name: v })) };
    }
    return { name, type: "text" };
  });
}

/** Unique names for the columns (a duplicate gets " 2", " 3"…), not clashing with the ones that exist. */
export function uniqueNames(names: readonly string[], taken: readonly string[] = []): string[] {
  const used = new Set(taken.map((n) => n.toLowerCase()));
  return names.map((n) => {
    let name = n.slice(0, 100);
    for (let i = 2; used.has(name.toLowerCase()); i++) name = `${n.slice(0, 95)} ${i}`;
    used.add(name.toLowerCase());
    return name;
  });
}

/** CSV header → existing property (by name, without case). */
export function matchHeader(header: readonly string[], defs: readonly PropDef[]): (PropDef | null)[] {
  return header.map((h) => defs.find((d) => d.name.toLowerCase() === h.trim().toLowerCase()) ?? null);
}
