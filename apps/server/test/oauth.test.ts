// The token response's lifetime read at the boundary, and the one door outside text goes through before it
// reaches an error or a log line.
import { describe, expect, test } from "bun:test";
import { discoverAuthServer, exchangeCode, MAX_EXPIRES_IN_S, needsRefresh } from "../src/integrations/oauth";
import { OUTSIDE_TEXT_MAX, outsideText } from "../src/integrations/outside-text";

const NOW = new Date("2026-11-14T12:00:00Z");
const input = {
  tokenEndpoint: "https://auth.example.test/token",
  code: "c",
  verifier: "v",
  redirectUri: "https://vanr.example.test/back",
  clientId: "client",
  clientSecret: null,
};
const answering = (body: Record<string, unknown>) =>
  Object.assign(async () => Response.json({ access_token: "t", refresh_token: "r", ...body }), {
    preconnect: () => {},
  }) as typeof fetch;

describe("the token's lifetime", () => {
  test("0 is expired now and the next call refreshes; absent never expires; the ceiling is accepted", async () => {
    const zero = await exchangeCode(answering({ expires_in: 0 }), input, NOW);
    expect(zero.expiresAt).toBe(NOW.toISOString());
    expect(needsRefresh(zero, NOW)).toBe(true);
    const none = await exchangeCode(answering({}), input, NOW);
    expect(none.expiresAt).toBeNull();
    expect(needsRefresh(none, NOW)).toBe(false);
    const max = await exchangeCode(answering({ expires_in: MAX_EXPIRES_IN_S }), input, NOW);
    expect(max.expiresAt).toBe(new Date(NOW.getTime() + MAX_EXPIRES_IN_S * 1000).toISOString());
  });

  test("past the ten-year ceiling, negative, fractional, text or huge: the response is malformed", async () => {
    for (const value of [MAX_EXPIRES_IN_S + 1, -1, 1.5, "3600", 1e100, Number.MAX_VALUE]) {
      const out = await exchangeCode(answering({ expires_in: value }), input, NOW).catch((e: unknown) => e);
      expect([value, out instanceof Error ? out.message : out]).toEqual([
        value,
        "Token response has no access_token",
      ]);
    }
  });

  test("a kept expiry that can't be read counts as expired", () => {
    const tokens = { accessToken: "t", refreshToken: "r", tokenEndpoint: "x", clientId: "c" };
    expect(needsRefresh({ ...tokens, clientSecret: null, expiresAt: "not a date" }, NOW)).toBe(true);
  });
});

describe("outside text", () => {
  const secret = "s3cr3t/+key=";
  test("every form of the secrets goes, control characters go, and the text is cut", () => {
    const echoed = [
      `plain ${secret}`,
      `b64 ${Buffer.from(secret).toString("base64")}`,
      `b64url ${Buffer.from(secret).toString("base64url")}`,
      `pct ${encodeURIComponent(secret)} ${encodeURIComponent(secret).toLowerCase()}`,
      "bell\u0007 nul\u0000 esc\u001b[31m newline\r\n end",
    ].join(" | ");
    const out = outsideText(new Error(echoed), [secret, null, undefined, ""]);
    for (const form of [
      secret,
      Buffer.from(secret).toString("base64"),
      Buffer.from(secret).toString("base64").replace(/=+$/, ""),
      Buffer.from(secret).toString("base64url"),
      encodeURIComponent(secret),
    ])
      expect([form, out.includes(form)]).toEqual([form, false]);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the assertion is about control characters
    expect(/[\u0000-\u001f\u007f-\u009f]/.test(out)).toBe(false);
    expect(out).toContain("[redacted]");
  });

  test("the text keeps OUTSIDE_TEXT_MAX characters at most", () => {
    expect(outsideText("x".repeat(OUTSIDE_TEXT_MAX), [])).toBe("x".repeat(OUTSIDE_TEXT_MAX));
    const cut = outsideText("x".repeat(OUTSIDE_TEXT_MAX + 1), []);
    expect(cut.length).toBe(OUTSIDE_TEXT_MAX);
    expect(cut.endsWith("…")).toBe(true);
  });
});

test("resource metadata must identify the exact resource before its issuer is used", async () => {
  for (const resource of [undefined, "https://resource.test/other-tenant"]) {
    const fetcher = Object.assign(
      async () =>
        Response.json({
          resource,
          authorization_servers: ["https://issuer.test"],
          issuer: "https://issuer.test",
          authorization_endpoint: "https://issuer.test/auth",
          token_endpoint: "https://issuer.test/token",
        }),
      { preconnect() {} },
    );
    await expect(
      discoverAuthServer(fetcher, "https://resource.test/mcp", "https://resource.test/meta", {
        allowPrivate: false,
        allowPlaintext: false,
      }),
    ).rejects.toThrow();
  }
});

test("with the local network allowed and plain text off, a plain http OAuth endpoint is refused", async () => {
  const meta = (endpoints: { authorize: string; token: string }) =>
    Object.assign(
      async (input: string | URL | Request) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url === "https://resource.test/meta")
          return Response.json({
            resource: "https://resource.test/mcp",
            authorization_servers: ["https://issuer.test"],
          });
        return Response.json({
          issuer: "https://issuer.test",
          authorization_endpoint: endpoints.authorize,
          token_endpoint: endpoints.token,
        });
      },
      { preconnect() {} },
    );
  const discover = (endpoints: { authorize: string; token: string }, allowPlaintext: boolean) =>
    discoverAuthServer(meta(endpoints), "https://resource.test/mcp", "https://resource.test/meta", {
      allowPrivate: true,
      allowPlaintext,
    });
  const secure = { authorize: "https://issuer.test/auth", token: "https://issuer.test/token" };
  for (const plain of [
    { ...secure, authorize: "http://issuer.test/auth" },
    { ...secure, token: "http://issuer.test/token" },
  ]) {
    await expect(discover(plain, false)).rejects.toThrow("unsafe OAuth address");
    expect(await discover(plain, true)).toMatchObject({
      authorization_endpoint: plain.authorize,
      token_endpoint: plain.token,
    });
  }
  expect(await discover(secure, false)).toMatchObject({
    authorization_endpoint: secure.authorize,
    token_endpoint: secure.token,
  });
});
