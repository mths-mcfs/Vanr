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

/** Reads and validates the JSON body. An empty body becomes {} (the client sends {} on a POST without data). */
export async function readJson<S extends ZodType>(c: Context, schema: S): Promise<z.infer<S>> {
  const text = await c.req.text();
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
