// The transport: turns an endpoint and its arguments into a fetch, and the response into either the
// validated value or an ApiError. Nothing here is global; every client carries its own options.
import type { Clock } from "./clock.ts";
import { systemClock } from "./clock.ts";
import type { AnyEndpoint, CallOptions, Download, QueryParams } from "./endpoint.ts";
import { pathParamNames } from "./endpoint.ts";
import { ApiError, isServerErrorCode } from "./errors.ts";
import * as s from "./schema.ts";

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface TransportOptions {
  /** Origin of the server (`https://vanr.example`). Empty: the page's own origin, with its session cookie. */
  baseUrl?: string;
  fetch?: FetchLike;
  /** Deadline for each call, until the whole JSON answer (or a download's headers) arrives. */
  timeoutMs?: number;
  /** Extra headers on every call (a bearer token outside the browser, for instance). */
  headers?: () => Record<string, string>;
  credentials?: RequestCredentials;
  /** The clock the deadline runs on; tests pass a manual one. */
  clock?: Clock;
}

export const DEFAULT_TIMEOUT_MS = 30_000;

const ErrorEnvelope = s.object({
  error: s.object({ code: s.string, message: s.string, params: s.optional(s.record(s.unknown)) }),
});

export interface Transport {
  readonly baseUrl: string;
  call(
    endpoint: AnyEndpoint,
    args: Record<string, unknown> | undefined,
    options?: CallOptions,
  ): Promise<unknown>;
  /** The absolute URL a call would hit (for `<img src>`, links and the socket). */
  url(path: string, query?: QueryParams): string;
}

export function encodeQuery(query: QueryParams | undefined, into = new URLSearchParams()): URLSearchParams {
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value)) {
      if (value.length > 0) into.set(key, value.join(","));
    } else into.set(key, String(value));
  }
  return into;
}

function fillPath(path: string, args: Record<string, unknown>): { path: string; fixed: string } {
  const [base = "", fixed = ""] = path.split("?");
  let out = base;
  for (const name of pathParamNames(base)) {
    const value = args[name];
    if (typeof value !== "string" || value === "") throw new TypeError(`Missing path parameter ${name}`);
    out = out.replace(`:${name}`, encodeURIComponent(value));
  }
  return { path: out, fixed };
}

function formData(fields: Record<string, unknown>): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    if (value instanceof Blob) form.set(key, value);
    else if (typeof value === "object" && "blob" in value && value.blob instanceof Blob) {
      form.set(
        key,
        value.blob,
        "fileName" in value && typeof value.fileName === "string" ? value.fileName : "blob",
      );
    } else form.set(key, String(value));
  }
  return form;
}

function isQuery(v: unknown): v is QueryParams {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function fileNameOf(disposition: string | null): string | null {
  if (!disposition) return null;
  const star = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
  if (star?.[1]) {
    try {
      return decodeURIComponent(star[1]);
    } catch {
      return null;
    }
  }
  return /filename="?([^";]+)"?/i.exec(disposition)?.[1] ?? null;
}

function sizeOf(header: string | null): number | null {
  if (header === null) return null;
  const n = Number(header);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

/** The error from a non-2xx answer: the envelope when the body has one, `http_<status>` otherwise. */
export function errorFromBody(status: number, statusText: string, text: string): ApiError {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return new ApiError({ status, code: `http_${status}`, message: statusText || `HTTP ${status}` });
  }
  const r = ErrorEnvelope.check(raw, "$");
  if (!r.ok) return new ApiError({ status, code: `http_${status}`, message: statusText || `HTTP ${status}` });
  const { code, message, params } = r.value.error;
  return new ApiError({
    status,
    code: isServerErrorCode(code) ? code : `http_${status}`,
    rawCode: code,
    message,
    ...(params ? { params } : {}),
  });
}

export function createTransport(options: TransportOptions = {}): Transport {
  const baseUrl = (options.baseUrl ?? "").replace(/\/+$/, "");
  const doFetch: FetchLike = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
  const clock = options.clock ?? systemClock;
  const defaultTimeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const url = (path: string, query?: QueryParams) => {
    const [base = "", fixed = ""] = path.split("?");
    const qs = encodeQuery(query, new URLSearchParams(fixed)).toString();
    return `${baseUrl}${base}${qs ? `?${qs}` : ""}`;
  };

  async function call(
    endpoint: AnyEndpoint,
    rawArgs: Record<string, unknown> | undefined,
    callOptions: CallOptions = {},
  ) {
    const args = rawArgs ?? {};
    const filled = fillPath(endpoint.path, args);
    const query = isQuery(args.query) ? args.query : undefined;
    const target = url(filled.fixed ? `${filled.path}?${filled.fixed}` : filled.path, query);

    const headers: Record<string, string> = { accept: "application/json", ...options.headers?.() };
    let body: BodyInit | undefined;
    if (endpoint.send === "json") {
      headers["content-type"] = "application/json";
      body = JSON.stringify(args.body ?? {});
    } else if (endpoint.send === "form") {
      body = formData(isQuery(args.body) ? args.body : {});
    } else if (endpoint.send === "bytes") {
      if (!(args.body instanceof Blob)) throw new TypeError("The body must be a Blob");
      headers["content-type"] = "application/octet-stream";
      body = args.body;
    } else if (endpoint.verb !== "GET" && endpoint.verb !== "DELETE") {
      // The server reads an empty body as {}; sending it keeps proxies that want a body on POST happy.
      headers["content-type"] = "application/json";
      body = "{}";
    }

    // One controller aborts the fetch for both reasons; `reason` tells them apart afterwards.
    const controller = new AbortController();
    let reason: "canceled" | "timeout" | null = null;
    const abort = (why: "canceled" | "timeout") => {
      reason ??= why;
      controller.abort();
    };
    const external = callOptions.signal;
    if (external?.aborted) abort("canceled");
    const onAbort = () => abort("canceled");
    external?.addEventListener("abort", onAbort, { once: true });
    const timeoutMs = callOptions.timeoutMs ?? defaultTimeout;
    const cancelTimer = clock.setTimer(() => abort("timeout"), timeoutMs);
    const stop = () => {
      cancelTimer();
      external?.removeEventListener("abort", onAbort);
    };
    const failure = (cause: unknown): ApiError => {
      if (reason === "timeout") {
        return new ApiError({
          status: 0,
          code: "timeout",
          message: `No answer within ${timeoutMs} ms`,
          cause,
        });
      }
      if (reason === "canceled")
        return new ApiError({ status: 0, code: "canceled", message: "Canceled", cause });
      return new ApiError({ status: 0, code: "network", message: "Could not reach the server", cause });
    };

    let res: Response;
    try {
      if (reason) throw new Error(reason);
      res = await doFetch(target, {
        method: endpoint.verb,
        headers,
        ...(body === undefined ? {} : { body }),
        signal: controller.signal,
        credentials: options.credentials ?? "same-origin",
      });
    } catch (err) {
      stop();
      throw failure(err);
    }

    let streaming = false;
    try {
      if (!res.ok && endpoint.nullOn.includes(res.status)) return null;
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw errorFromBody(res.status, res.statusText, text);
      }
      if (endpoint.reply.kind === "download") {
        // The deadline covers the headers only; the caller's signal keeps canceling the stream itself.
        streaming = true;
        cancelTimer();
        const stream = res.body ?? new Blob([]).stream();
        const download: Download = {
          body: stream,
          contentType: res.headers.get("content-type"),
          size: sizeOf(res.headers.get("content-length")),
          fileName: fileNameOf(res.headers.get("content-disposition")),
          blob: () => new Response(stream).blob(),
        };
        return download;
      }
      const text = await res.text();
      if (endpoint.reply.kind === "none") return undefined;
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch (cause) {
        throw new ApiError({
          status: res.status,
          code: "invalid_response",
          message: "The server answered with something that is not JSON",
          cause,
        });
      }
      const r = endpoint.reply.schema.check(raw, "$");
      if (!r.ok) {
        throw new ApiError({
          status: res.status,
          code: "invalid_response",
          message: `Unexpected answer: expected ${r.issue.expected} at ${r.issue.path}`,
          params: { path: r.issue.path, expected: r.issue.expected },
        });
      }
      return r.value;
    } catch (err) {
      if (err instanceof ApiError) throw err;
      throw failure(err);
    } finally {
      if (streaming) cancelTimer();
      else stop();
    }
  }

  return { baseUrl, call, url };
}
