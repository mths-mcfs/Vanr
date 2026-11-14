// The file's real type from its first bytes. The type the browser sends is the sender's guess: an HTML
// named .png with `image/png` would run script if the server trusted it. The Drive stores the detected type
// and serves with it.

/** How many leading bytes are enough to decide. */
export const SNIFF_BYTES = 4096;

const OFFICE: Record<string, string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  odt: "application/vnd.oasis.opendocument.text",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  odp: "application/vnd.oasis.opendocument.presentation",
};
const LEGACY_OFFICE: Record<string, string> = {
  doc: "application/msword",
  xls: "application/vnd.ms-excel",
  ppt: "application/vnd.ms-powerpoint",
};
const TEXT_BY_EXT: Record<string, string> = {
  md: "text/markdown",
  markdown: "text/markdown",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  json: "application/json",
  yaml: "application/yaml",
  yml: "application/yaml",
  xml: "application/xml",
};

const ext = (name: string) => /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? "";

function ascii(b: Uint8Array, at: number, s: string): boolean {
  if (b.length < at + s.length) return false;
  for (let i = 0; i < s.length; i++) if (b[at + i] !== s.charCodeAt(i)) return false;
  return true;
}

function bytesAt(b: Uint8Array, at: number, sig: readonly number[]): boolean {
  if (b.length < at + sig.length) return false;
  return sig.every((x, i) => b[at + i] === x);
}

/** Text: no NUL byte and valid UTF-8 (the last character may have been cut at the limit). */
function looksLikeText(b: Uint8Array): boolean {
  if (b.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(b.length >= SNIFF_BYTES ? b.subarray(0, -4) : b);
    return true;
  } catch {
    return false;
  }
}

/** Markup the browser renders (and where script runs). */
function markupType(b: Uint8Array): string | null {
  const head = new TextDecoder().decode(b.subarray(0, 1024)).replace(/^﻿/, "").trimStart().toLowerCase();
  if (
    /^<(!doctype\s+html|html|head|body|script|iframe|object|embed|meta|style|title|a\s|img\s|div|p>)/.test(
      head,
    )
  )
    return "text/html";
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) return "image/svg+xml";
  if (head.startsWith("<?xml")) return "application/xml";
  return null;
}

/** Detected type, or null when the bytes say nothing (then the file is served as binary). */
export function sniffType(head: Uint8Array, fileName: string): string | null {
  const b = head.subarray(0, SNIFF_BYTES);
  const e = ext(fileName);
  if (bytesAt(b, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (bytesAt(b, 0, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (ascii(b, 0, "GIF87a") || ascii(b, 0, "GIF89a")) return "image/gif";
  if (ascii(b, 0, "RIFF")) {
    if (ascii(b, 8, "WEBP")) return "image/webp";
    if (ascii(b, 8, "WAVE")) return "audio/wav";
    if (ascii(b, 8, "AVI ")) return "video/x-msvideo";
  }
  if (ascii(b, 4, "ftyp")) {
    const brand = new TextDecoder().decode(b.subarray(8, 12));
    if (brand === "avif" || brand === "avis") return "image/avif";
    if (["heic", "heix", "mif1", "msf1"].includes(brand)) return "image/heic";
    if (brand === "qt  ") return "video/quicktime";
    if (brand === "M4A " || brand === "M4B ") return "audio/mp4";
    return "video/mp4";
  }
  if (bytesAt(b, 0, [0x1a, 0x45, 0xdf, 0xa3]))
    return new TextDecoder().decode(b.subarray(0, 64)).includes("webm") ? "video/webm" : "video/x-matroska";
  if (ascii(b, 0, "OggS")) return "audio/ogg";
  if (ascii(b, 0, "fLaC")) return "audio/flac";
  if (ascii(b, 0, "ID3") || (b[0] === 0xff && ((b[1] ?? 0) & 0xe0) === 0xe0)) return "audio/mpeg";
  if (ascii(b, 0, "%PDF-")) return "application/pdf";
  if (bytesAt(b, 0, [0x50, 0x4b, 0x03, 0x04]) || bytesAt(b, 0, [0x50, 0x4b, 0x05, 0x06]))
    return OFFICE[e] ?? "application/zip";
  if (bytesAt(b, 0, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))
    return LEGACY_OFFICE[e] ?? "application/x-ole-storage";
  if (bytesAt(b, 0, [0x1f, 0x8b])) return "application/gzip";
  if (ascii(b, 0, "BM") && e === "bmp") return "image/bmp";
  if (b.length === 0) return "text/plain";
  if (looksLikeText(b)) return markupType(b) ?? TEXT_BY_EXT[e] ?? "text/plain";
  return null;
}

/** Types the browser shows without running script: the preview opens directly (the rest goes with a CSP sandbox). */
export function isSafeInline(type: string): boolean {
  return /^(image\/(png|jpeg|gif|webp|avif|bmp)|application\/pdf|text\/(plain|markdown|csv|tab-separated-values)|application\/(json|yaml)|video\/(mp4|webm|quicktime)|audio\/(mpeg|mp4|ogg|wav|flac|webm))$/.test(
    type,
  );
}

/** Plain text (decodes as UTF-8). */
export function isTextual(type: string): boolean {
  return /^(text\/(plain|markdown|csv|tab-separated-values)|application\/(json|yaml|xml))$/.test(type);
}

export const isOffice = (type: string) => Object.values(OFFICE).includes(type);
export const isLegacyOffice = (type: string) => Object.values(LEGACY_OFFICE).includes(type);
export const officeKind = (type: string): "docx" | "xlsx" | "pptx" | null => {
  if (type === OFFICE.docx) return "docx";
  if (type === OFFICE.xlsx) return "xlsx";
  if (type === OFFICE.pptx) return "pptx";
  return null;
};
