import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { type ZodType, z } from "zod";

/** Error with the API envelope: {"error":{"code","message","params?"}}. */
export class HttpError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: string,
    message: string,
    readonly params?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export const unauthorized = () => new HttpError(401, "unauthorized", "Sign in to continue");
export const forbidden = (message = "You don't have permission to do that") =>
  new HttpError(403, "forbidden", message);
export const notFound = (what = "Not found") => new HttpError(404, "not_found", what);
export const badRequest = (message: string, params?: Record<string, unknown>) =>
  new HttpError(400, "invalid_request", message, params);
export const conflict = (code: string, message: string, params?: Record<string, unknown>) =>
  new HttpError(409, code, message, params);

export function errorBody(code: string, message: string, params?: Record<string, unknown>) {
  return { error: params ? { code, message, params } : { code, message } };
}

/** Largest JSON body a regular route reads (uploads and imports have routes of their own). */
export const JSON_BODY_LIMIT = 1024 * 1024;

const tooLarge = (limit: number) =>
  new HttpError(413, "payload_too_large", "The request body is too large", { limitBytes: limit });

/**
 * The body as text, up to `limit` bytes: a larger Content-Length is rejected before reading, and a body without
 * one stops being read once it passes the limit (it never sits whole in memory).
 */
export async function readBodyText(req: Request, limit: number): Promise<string> {
  const declared = Number(req.headers.get("content-length") ?? Number.NaN);
  if (declared > limit) throw tooLarge(limit);
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > limit) throw tooLarge(limit);
      chunks.push(next.value);
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks, size).toString("utf8");
}

/**
 * Bodies a border middleware already read and checked (the wiki's NUL check), by request. Only what was handed
 * over here is reused by `readJson`; any other text in Hono's body cache is ignored and the body is read again.
 */
const preRead = new WeakMap<Request, string>();

/** A middleware that read the request's body hands it to the route's `readJson`, which still applies its cap. */
export function handOverBody(req: Request, text: string): void {
  preRead.set(req, text);
}

const isJsonType = (type: string | undefined) => /^application\/json\s*(?:;|$)/i.test(type ?? "");

/**
 * Reads and validates the JSON body, of at most `limit` bytes (413 `payload_too_large` past it) and sent as
 * application/json (415 `unsupported_media_type` otherwise). An empty body becomes {} (the client sends {} on
 * a POST without data).
 */
export async function readJson<S extends ZodType>(
  c: Context,
  schema: S,
  limit = JSON_BODY_LIMIT,
): Promise<z.infer<S>> {
  const req = c.req.raw;
  const empty = !req.body || req.headers.get("content-length") === "0";
  if (!empty && !isJsonType(c.req.header("content-type")))
    throw new HttpError(415, "unsupported_media_type", "Send JSON (application/json)");
  // A body a border middleware handed over (handOverBody) is reused under the same cap; otherwise it is read.
  const handed = preRead.get(req);
  let text = "";
  if (handed !== undefined) {
    if (Buffer.byteLength(handed) > limit) throw tooLarge(limit);
    text = handed;
  } else if (!empty) text = await readBodyText(req, limit);
  let raw: unknown = {};
  if (text.trim()) {
    try {
      raw = JSON.parse(text);
    } catch {
      throw badRequest("Body is not valid JSON");
    }
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw badRequest("Invalid body", { issues: z.treeifyError(parsed.error) });
  }
  return parsed.data;
}

export function readQuery<S extends ZodType>(c: Context, schema: S): z.infer<S> {
  const parsed = schema.safeParse(c.req.query());
  if (!parsed.success) throw badRequest("Invalid query", { issues: z.treeifyError(parsed.error) });
  return parsed.data;
}

/** Required route parameter (Hono types it as string | undefined outside the typed handler). */
export function param(c: Context, name: string): string {
  const value = c.req.param(name);
  if (!value) throw badRequest(`Missing ${name}`);
  return value;
}
