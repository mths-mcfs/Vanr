// The one error type of the web's API layer. Screens never see a Response, a fetch failure or a
// library error: every failed call is an ApiError.
import { z } from "zod";

/** Statuses worth trying again without changing the request. */
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

export type ApiErrorInit = {
  /** HTTP status, or 0 when no answer arrived (offline, DNS, aborted connection). */
  status: number;
  /** Stable code from the server's error table, e.g. `invitation.used`. */
  code: string;
  /** The server's message in English: the fallback when no translation exists for `code`. */
  message: string;
  /** Seconds the server asked the client to wait (`Retry-After`). */
  retryAfterSeconds?: number;
  /** Extra data the server attached to the error. */
  params?: Record<string, unknown>;
};

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  /** True when the same request may succeed later: no answer, a timeout, a rate limit or a 5xx. */
  readonly retryable: boolean;
  readonly retryAfterSeconds: number | undefined;
  readonly params: Record<string, unknown>;

  constructor(init: ApiErrorInit) {
    super(init.message);
    this.name = "ApiError";
    this.status = init.status;
    this.code = init.code;
    this.retryable = init.status === 0 || RETRYABLE_STATUS.has(init.status);
    this.retryAfterSeconds = init.retryAfterSeconds;
    this.params = init.params ?? {};
  }
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}

/** Any thrown value as an ApiError, so a screen has one shape to render. */
export function toApiError(value: unknown): ApiError {
  if (isApiError(value)) return value;
  const message = value instanceof Error ? value.message : "Unexpected error";
  return new ApiError({ status: 0, code: "client.unexpected", message });
}

/** No answer from the server. */
export const unreachable = () =>
  new ApiError({ status: 0, code: "network.unreachable", message: "The server could not be reached" });

/** The server answered 2xx with a body the web does not understand. */
export const malformed = (what: string) =>
  new ApiError({ status: 502, code: "response.malformed", message: `Unexpected response from ${what}` });

// The server's envelope: {"error":{"code","message","params?"}}.
const Envelope = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string(),
    params: z.record(z.string(), z.unknown()).optional(),
  }),
});

// The sign-in service answers {"code":"SOME_CODE","message"} with upper-case codes.
const AuthServiceBody = z.object({ code: z.string().min(1).optional(), message: z.string().optional() });

/** Whole seconds from a Retry-After header; a date or a malformed value counts as absent. */
export function parseRetryAfter(header: string | null): number | undefined {
  if (header === null) return undefined;
  const text = header.trim();
  return /^\d{1,6}$/.test(text) ? Number(text) : undefined;
}

/** The ApiError of a non-2xx answer, whatever shape its body has. */
export function errorFromResponse(input: {
  status: number;
  body: unknown;
  retryAfter: string | null;
}): ApiError {
  const retryAfterSeconds = parseRetryAfter(input.retryAfter);
  const envelope = Envelope.safeParse(input.body);
  if (envelope.success) {
    const { code, message, params } = envelope.data.error;
    return new ApiError({ status: input.status, code, message, params, retryAfterSeconds });
  }
  const auth = AuthServiceBody.safeParse(input.body);
  if (auth.success && auth.data.code !== undefined) {
    return new ApiError({
      status: input.status,
      code: auth.data.code.toLowerCase(),
      message: auth.data.message ?? "",
      retryAfterSeconds,
    });
  }
  return new ApiError({
    status: input.status,
    code: `http_${input.status}`,
    message: auth.success ? (auth.data.message ?? "") : "",
    retryAfterSeconds,
  });
}
