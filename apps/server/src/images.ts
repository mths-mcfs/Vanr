import { createHash } from "node:crypto";
import { badRequest } from "./http";

const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

/** Accepted signatures. SVG is left out: an image served from the same origin must not run script. */
const SIGNATURES: Record<string, (b: Uint8Array) => boolean> = {
  "image/png": (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  "image/jpeg": (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  "image/gif": (b) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46,
  "image/webp": (b) =>
    String.fromCharCode(b[0] ?? 0, b[1] ?? 0, b[2] ?? 0, b[3] ?? 0) === "RIFF" &&
    String.fromCharCode(b[8] ?? 0, b[9] ?? 0, b[10] ?? 0, b[11] ?? 0) === "WEBP",
};

/** Decodes `{imageBase64, contentType}` and checks type and size by the content, not by the label. */
export function decodeImage(input: { imageBase64: string; contentType: string }): {
  bytes: Uint8Array;
  contentType: string;
} {
  const check = SIGNATURES[input.contentType];
  if (!check) throw badRequest("Use PNG, JPEG, GIF or WebP", { contentType: input.contentType });
  const raw = input.imageBase64.replace(/^data:[^,]*,/, "");
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(Buffer.from(raw, "base64"));
  } catch {
    throw badRequest("imageBase64 is not valid base64");
  }
  if (bytes.length === 0) throw badRequest("Empty image");
  if (bytes.length > MAX_IMAGE_BYTES) throw badRequest("Image is over 2 MB", { maxBytes: MAX_IMAGE_BYTES });
  if (!check(bytes)) throw badRequest("Image content doesn't match contentType");
  return { bytes, contentType: input.contentType };
}

const etagOf = (bytes: Uint8Array) =>
  `"${createHash("sha256").update(bytes).digest("base64url").slice(0, 32)}"`;

/** Whether an `If-None-Match` header names this ETag (a list, weak validators and `*` included). */
function matches(ifNoneMatch: string | undefined, etag: string): boolean {
  if (!ifNoneMatch) return false;
  return ifNoneMatch.split(",").some((tag) => {
    const t = tag.trim();
    return t === "*" || t.replace(/^W\//, "") === etag;
  });
}

/**
 * A protected image (an avatar, the logo). `no-cache`: the browser asks again every time, so whoever lost access
 * (signed out, removed) gets nothing from its cache; an unchanged image costs a 304, never a second download. The
 * route checks access before it gets here, so a 304 also goes only to whoever may still see the image.
 */
export function imageResponse(
  blob: { bytes: Uint8Array; contentType: string },
  ifNoneMatch: string | undefined,
): Response {
  const etag = etagOf(blob.bytes);
  const headers = {
    etag,
    "cache-control": "private, no-cache",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'",
  };
  if (matches(ifNoneMatch, etag)) return new Response(null, { status: 304, headers });
  return new Response(blob.bytes, { headers: { ...headers, "content-type": blob.contentType } });
}
