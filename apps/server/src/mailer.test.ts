// What the Resend mailer reports for each answer of the provider (a double of its HTTP API).
import { describe, expect, test } from "bun:test";
import { resendMailer } from "./mailer";

const mail = { to: "ana@example.com", subject: "Hi", text: "Hello", kind: "notification" };

const answering = (status: number): typeof fetch =>
  Object.assign(async () => new Response("{}", { status }), { preconnect: () => {} });

/** A provider that never answers: only the deadline ends the send. */
const silent: typeof fetch = Object.assign(
  (_url: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    }),
  { preconnect: () => {} },
);

describe("resend mailer", () => {
  test("accepted, rejected worth retrying, rejected for good", async () => {
    const results = [];
    for (const status of [200, 202, 429, 500, 503, 400, 401, 422])
      results.push([
        status,
        await resendMailer("k", "n@example.com", { fetch: answering(status) }).send(mail),
      ]);
    expect(results).toEqual([
      [200, { ok: true }],
      [202, { ok: true }],
      [429, { ok: false, retry: true, reason: "http_429" }],
      [500, { ok: false, retry: true, reason: "http_500" }],
      [503, { ok: false, retry: true, reason: "http_503" }],
      [400, { ok: false, retry: false, reason: "http_400" }],
      [401, { ok: false, retry: false, reason: "http_401" }],
      [422, { ok: false, retry: false, reason: "http_422" }],
    ]);
  });

  test("a network failure and a provider that doesn't answer in time are worth retrying", async () => {
    const down: typeof fetch = Object.assign(
      async () => {
        throw new TypeError("connection refused");
      },
      { preconnect: () => {} },
    );
    expect(await resendMailer("k", "n@example.com", { fetch: down }).send(mail)).toEqual({
      ok: false,
      retry: true,
      reason: "network",
    });
    expect(await resendMailer("k", "n@example.com", { fetch: silent, timeoutMs: 50 }).send(mail)).toEqual({
      ok: false,
      retry: true,
      reason: "timeout",
    });
  });

  test("the request carries the sender, the recipient and the text", async () => {
    let sent: unknown = null;
    const capture: typeof fetch = Object.assign(
      async (_url: string | URL | Request, init?: RequestInit) => {
        sent = JSON.parse(String(init?.body));
        return new Response("{}", { status: 200 });
      },
      { preconnect: () => {} },
    );
    await resendMailer("k", "n@example.com", { fetch: capture }).send(mail);
    expect(sent).toEqual({ from: "n@example.com", to: ["ana@example.com"], subject: "Hi", text: "Hello" });
  });
});
