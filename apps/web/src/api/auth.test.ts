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

  test("Retry-After is whole seconds, or a date counted from now; anything else is absent", () => {
    const now = Date.UTC(2026, 10, 14, 12, 0, 0);
    expect(parseRetryAfter("5", now)).toBe(5);
    expect(parseRetryAfter(" 12 ", now)).toBe(12);
    expect(parseRetryAfter("86400", now)).toBe(86_400);
    expect(parseRetryAfter("Sat, 14 Nov 2026 12:00:10 GMT", now)).toBe(10);
    // A date that already passed is a wait that is over, not a missing one.
    expect(parseRetryAfter("Sat, 14 Nov 2026 11:59:00 GMT", now)).toBe(-60);
    for (const header of [null, "", "soon", "-3", "1.5", "1e3", "12:00:10"]) {
      expect(parseRetryAfter(header, now), String(header)).toBeUndefined();
    }
  });

  test("a date in Retry-After is counted on the clock the web was given", async () => {
    const stamp = "Sat, 14 Nov 2026 12:00:07 GMT";
    const fetch: FetchLike = async () =>
      Response.json(
        { error: { code: "signup_busy", message: "Busy" } },
        { status: 503, headers: { "retry-after": stamp } },
      );
    const auth = createAuthApi(createFetchTransport({ fetch }), {
      clock: { now: () => Date.UTC(2026, 10, 14, 12) },
    });
    const error = await failure(() =>
      auth.signUp({ body: { name: "Mel", email: "mel@b.example", password: "x" } }),
    );
    expect(error.params).toEqual({ retryAfterSeconds: 7 });
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

  test("an answer that arrives after the call was given up on is discarded", async () => {
    const stop = new AbortController();
    let deliver: (response: Response) => void = () => {};
    const fetch: FetchLike = () =>
      new Promise<Response>((resolve) => {
        deliver = resolve;
      });
    const auth = createAuthApi(createFetchTransport({ fetch }));
    const call = failure(() =>
      auth.signIn({ body: { email: "a@b.example", password: "x" } }, { signal: stop.signal }),
    );
    stop.abort();
    deliver(Response.json({ ok: true }));
    expect((await call).code).toBe("canceled");
  });

  test("a sign-in, sign-up or sign-out without an answer says the session is unknown; other calls do not", async () => {
    let unknown = 0;
    const fetch: FetchLike = async () => {
      throw new TypeError("Failed to fetch");
    };
    const auth = createAuthApi(createFetchTransport({ fetch }), { onSessionUnknown: () => unknown++ });
    await failure(() => auth.signIn({ body: { email: "a@b.example", password: "x" } }));
    await failure(() => auth.signUp({ body: { name: "A", email: "a@b.example", password: "x" } }));
    await failure(() => auth.signOut());
    expect(unknown).toBe(3);
    await failure(() => auth.verifyEmail({ query: { token: "t" } }));
    await failure(() => auth.resetPassword({ body: { token: "t", newPassword: "x" } }));
    expect(unknown).toBe(3);
  });
});
