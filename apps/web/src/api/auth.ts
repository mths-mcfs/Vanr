// The one part of the server the shared client does not cover: the sign-in service under
// `/api/auth`. It is not in the server's route table, so its seven operations are declared here,
// and only here. Calls take the client's argument shape (`{ body }`, `{ query }`) and reject with
// the client's ApiError, so a screen handles them like any other call.
//
// The service answers errors as `{ code, message }` with upper-case codes; the sign-up queue in
// front of it answers the server's envelope. Both become an ApiError whose `rawCode` is the code in
// lower case and whose `params.retryAfterSeconds` carries what a Retry-After header asked for.
import { ApiError, type Clock } from "@vanr/client";
import { z } from "zod";
import type { WebTransport } from "./wire.ts";

/** Every path the sign-in service answers starts with this. A 401 from it never means "signed out". */
export const AUTH_PREFIX = "/api/auth/";

export const AUTH_ROUTES = {
  signIn: { verb: "POST", path: "/api/auth/sign-in/email" },
  signUp: { verb: "POST", path: "/api/auth/sign-up/email" },
  signOut: { verb: "POST", path: "/api/auth/sign-out" },
  requestPasswordReset: { verb: "POST", path: "/api/auth/request-password-reset" },
  resetPassword: { verb: "POST", path: "/api/auth/reset-password" },
  verifyEmail: { verb: "GET", path: "/api/auth/verify-email" },
  sendVerificationEmail: { verb: "POST", path: "/api/auth/send-verification-email" },
} as const;

export type AuthMethod = keyof typeof AUTH_ROUTES;

type Call<Body> = (args: { body: Body }, options?: { signal?: AbortSignal }) => Promise<void>;

export type AuthApi = {
  signIn: Call<{ email: string; password: string }>;
  signUp: Call<{ name: string; email: string; password: string; callbackURL?: string }>;
  signOut: (args?: undefined, options?: { signal?: AbortSignal }) => Promise<void>;
  /** `redirectTo` is where the emailed link ends: the web's reset screen. */
  requestPasswordReset: Call<{ email: string; redirectTo: string }>;
  resetPassword: Call<{ token: string; newPassword: string }>;
  verifyEmail: (args: { query: { token: string } }, options?: { signal?: AbortSignal }) => Promise<void>;
  sendVerificationEmail: Call<{ email: string; callbackURL: string }>;
};

const ServiceError = z.object({ code: z.string().min(1).optional(), message: z.string().optional() });
const Envelope = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string(),
    params: z.record(z.string(), z.unknown()).optional(),
  }),
});

/**
 * The seconds a Retry-After header asks for, as whole seconds or as an HTTP date (counted from
 * `now`). Anything else counts as absent. The answer is what the server said, not what the web
 * will do with it: the caller keeps it within its own limits.
 */
export function parseRetryAfter(header: string | null, now: number): number | undefined {
  const text = header?.trim() ?? "";
  if (/^\d{1,9}$/.test(text)) return Number(text);
  // A date has letters; without that check, Date.parse reads a bare number as a year.
  if (!/[A-Za-z]/.test(text)) return undefined;
  const at = Date.parse(text);
  return Number.isNaN(at) ? undefined : Math.ceil((at - now) / 1000);
}

/** The ApiError of a failed sign-in call, whichever of the two bodies it came with. */
export function authError(
  status: number,
  text: string,
  retryAfter: string | null,
  now: number = Date.now(),
): ApiError {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    raw = undefined;
  }
  const seconds = parseRetryAfter(retryAfter, now);
  const wait = seconds === undefined ? {} : { retryAfterSeconds: seconds };
  const envelope = Envelope.safeParse(raw);
  const service = ServiceError.safeParse(raw);
  const rawCode = envelope.success
    ? envelope.data.error.code
    : service.success
      ? service.data.code?.toLowerCase()
      : undefined;
  const message = envelope.success
    ? envelope.data.error.message
    : service.success
      ? service.data.message
      : "";
  return new ApiError({
    status,
    code: `http_${status}`,
    ...(rawCode !== undefined && { rawCode }),
    message: message ?? "",
    params: { ...(envelope.success ? envelope.data.error.params : {}), ...wait },
  });
}

/** The calls after which who is signed in may have changed. */
const CHANGES_SESSION: readonly AuthMethod[] = ["signIn", "signUp", "signOut"];

export function createAuthApi(
  wire: WebTransport,
  options: {
    /** Tells the time a Retry-After date is counted from. */
    clock?: Pick<Clock, "now">;
    /** A call that changes the session ended without an answer: the server may have acted on it. */
    onSessionUnknown?: () => void;
  } = {},
): AuthApi {
  const now = () => options.clock?.now() ?? Date.now();
  const call = async (
    method: AuthMethod,
    args: { body?: unknown; query?: Record<string, string> } | undefined,
    callOptions: { signal?: AbortSignal } | undefined,
  ): Promise<void> => {
    const { verb, path } = AUTH_ROUTES[method];
    const query = new URLSearchParams(args?.query).toString();
    const signal = callOptions?.signal;
    const unanswered = (code: "canceled" | "network", cause?: unknown) => {
      if (CHANGES_SESSION.includes(method)) options.onSessionUnknown?.();
      return new ApiError({
        status: 0,
        code,
        message: code === "canceled" ? "Canceled" : "Could not reach the server",
        cause,
      });
    };
    let response: Response;
    try {
      response = await wire.fetch(`${wire.baseUrl}${path}${query === "" ? "" : `?${query}`}`, {
        method: verb,
        headers: {
          accept: "application/json",
          ...(verb === "POST" && { "content-type": "application/json" }),
          ...wire.headers(),
        },
        ...(verb === "POST" && { body: JSON.stringify(args?.body ?? {}) }),
        ...(signal !== undefined && { signal }),
      });
    } catch (cause) {
      throw unanswered(signal?.aborted === true ? "canceled" : "network", cause);
    }
    // Given up on while the answer was on its way: whoever asked is gone, so it counts as no answer.
    if (signal?.aborted === true) throw unanswered("canceled");
    if (!response.ok) {
      throw authError(response.status, await response.text(), response.headers.get("retry-after"), now());
    }
  };
  return {
    signIn: (args, options) => call("signIn", args, options),
    signUp: (args, options) => call("signUp", args, options),
    signOut: (_args, options) => call("signOut", undefined, options),
    requestPasswordReset: (args, options) => call("requestPasswordReset", args, options),
    resetPassword: (args, options) => call("resetPassword", args, options),
    verifyEmail: (args, options) => call("verifyEmail", args, options),
    sendVerificationEmail: (args, options) => call("sendVerificationEmail", args, options),
  };
}
