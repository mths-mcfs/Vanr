// The sign-in service's calls: the one part of the server the shared client does not cover.
import { describe, expect, test } from "bun:test";
import { type FetchLike, isApiError } from "@vanr/client";
import { createAuthApi } from "./auth.ts";
import { AUTH_PREFIX, AUTH_ROUTES, authError, createFetchTransport, parseRetryAfter } from "./index.ts";

type Sent = { url: string; init: RequestInit };

function wire(answer: (sent: Sent) => Response | Promise<Response>) {
  const sent: Sent[] = [];
  const fetch: FetchLike = async (url, init) => {
    sent.push({ url, init });
    return answer({ url, init });
  };
  return { sent, auth: createAuthApi(createFetchTransport({ fetch, locale: () => "pt-BR" })) };
}

async function failure(run: () => Promise<unknown>) {
  try {
    await run();
  } catch (cause) {
    if (isApiError(cause)) return cause;
    throw cause;
  }
  throw new Error("the call did not fail");
}

describe("the sign-in service's routes", () => {
  test("every one is under the service's prefix, which is what exempts it from the session rule", () => {
    for (const route of Object.values(AUTH_ROUTES)) expect(route.path.startsWith(AUTH_PREFIX)).toBe(true);
  });

  test("a call sends JSON with the session cookie and the interface language", async () => {
    const { sent, auth } = wire(() => Response.json({ ok: true }));
    await auth.signIn({ body: { email: "ana@birchwood.example", password: "secret" } });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe("/api/auth/sign-in/email");
    expect(sent[0]?.init.method).toBe("POST");
    expect(sent[0]?.init.credentials).toBe("include");
    expect(sent[0]?.init.body).toBe('{"email":"ana@birchwood.example","password":"secret"}');
    expect(new Headers(sent[0]?.init.headers).get("accept-language")).toBe("pt-BR");
    expect(new Headers(sent[0]?.init.headers).get("content-type")).toBe("application/json");
  });

  test("an email link's token goes in the query string, encoded", async () => {
    const { sent, auth } = wire(() => Response.json({ status: true }));
    await auth.verifyEmail({ query: { token: "a b&c" } });
    expect(sent[0]?.url).toBe("/api/auth/verify-email?token=a+b%26c");
    expect(sent[0]?.init.method).toBe("GET");
    expect(sent[0]?.init.body).toBeUndefined();
  });
});

describe("a failed sign-in call is the client's ApiError", () => {
  test("the service's own body: the code in lower case, under rawCode", () => {
    const error = authError(
      401,
      '{"code":"INVALID_EMAIL_OR_PASSWORD","message":"Invalid email or password"}',
      null,
    );
    expect(isApiError(error)).toBe(true);
    expect(error.status).toBe(401);
    expect(error.code).toBe("http_401");
    expect(error.rawCode).toBe("invalid_email_or_password");
    expect(error.message).toBe("Invalid email or password");
  });

  test("the server's envelope, from the queue in front of sign-up, with its params", () => {
    const body = '{"error":{"code":"signup_busy","message":"Busy","params":{"position":3}}}';
    const error = authError(503, body, "5");
    expect(error.code).toBe("http_503");
    expect(error.rawCode).toBe("signup_busy");
    expect(error.params).toEqual({ position: 3, retryAfterSeconds: 5 });
    expect(error.retryable).toBe(true);
  });

  test("a body that is not JSON still gives the status", () => {
    const error = authError(502, "<html>Bad gateway</html>", null);
    expect(error.status).toBe(502);
    expect(error.code).toBe("http_502");
    // With no code in the body, the only code there is is the status.
    expect(error.rawCode).toBe("http_502");
  });

  test("Retry-After is whole seconds or nothing", () => {
    expect(parseRetryAfter("5")).toBe(5);
    expect(parseRetryAfter(" 12 ")).toBe(12);
    for (const header of [null, "", "soon", "-3", "1.5", "1e3"]) {
      expect(parseRetryAfter(header)).toBeUndefined();
    }
  });

  test("no answer is a network error, worth retrying", async () => {
    const { auth } = wire(() => {
      throw new TypeError("Failed to fetch");
    });
    const error = await failure(() => auth.signOut());
    expect(error.code).toBe("network");
    expect(error.status).toBe(0);
    expect(error.retryable).toBe(true);
  });

  test("a call given up on is canceled, not a network error", async () => {
    const stop = new AbortController();
    const { auth } = wire(
      ({ init }) =>
        new Promise<Response>((_, reject) => {
          init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        }),
    );
    const call = failure(() =>
      auth.signIn({ body: { email: "a@b.example", password: "x" } }, { signal: stop.signal }),
    );
    stop.abort();
    const error = await call;
    expect(error.code).toBe("canceled");
    expect(error.retryable).toBe(false);
  });
});
