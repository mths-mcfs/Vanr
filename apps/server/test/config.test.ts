import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config";

describe("configuration", () => {
  test("public URL: PUBLIC_URL, else the Railway domain, else localhost", () => {
    expect(loadConfig({ PORT: "4400" }).publicUrl).toBe("http://localhost:4400");
    expect(loadConfig({ RAILWAY_PUBLIC_DOMAIN: "app.up.railway.app" }).publicUrl).toBe(
      "https://app.up.railway.app",
    );
    expect(
      loadConfig({ PUBLIC_URL: "https://chat.example.com", RAILWAY_PUBLIC_DOMAIN: "app.up.railway.app" })
        .publicUrl,
    ).toBe("https://chat.example.com");
  });

  test("production without the Better Auth secret does not start", () => {
    expect(() => loadConfig(without("BETTER_AUTH_SECRET"))).toThrow("BETTER_AUTH_SECRET");
    expect(loadConfig(PROD).authSecret).toBe("x".repeat(32));
  });
});

/** The minimum production needs to start. */
const PROD = {
  NODE_ENV: "production",
  BETTER_AUTH_SECRET: "x".repeat(32),
  MAIL_PROVIDER: "file",
  TRUSTED_ORIGINS: "https://chat.example.com",
  PUBLIC_URL: "https://chat.example.com",
};
const without = (key: keyof typeof PROD) =>
  Object.fromEntries(Object.entries(PROD).filter(([k]) => k !== key));

describe("production fails closed", () => {
  test("public URL: required and https (the session cookie is Secure only on https)", () => {
    expect(() => loadConfig(without("PUBLIC_URL"))).toThrow("PUBLIC_URL is required");
    // The Railway domain no longer stands in for it in production.
    expect(() =>
      loadConfig({ ...without("PUBLIC_URL"), RAILWAY_PUBLIC_DOMAIN: "app.up.railway.app" }),
    ).toThrow("PUBLIC_URL is required");
    expect(() => loadConfig({ ...PROD, PUBLIC_URL: "http://chat.example.com" })).toThrow("https://");
    expect(loadConfig(PROD).publicUrl).toBe("https://chat.example.com");
  });

  test("integrations: TLS required and auth rate limits on, unless the operator says otherwise", () => {
    expect(loadConfig(PROD).integrations.allowPlaintext).toBe(false);
    expect(loadConfig({ ...PROD, ALLOW_PLAINTEXT_INTEGRATIONS: "true" }).integrations.allowPlaintext).toBe(
      true,
    );
    expect(loadConfig({}).integrations.allowPlaintext).toBe(true);
    expect(loadConfig(PROD).authRateLimit).toBe(true);
    expect(loadConfig({ ...PROD, AUTH_RATE_LIMIT: "false" }).authRateLimit).toBe(false);
    expect(loadConfig({}).authRateLimit).toBe(false);
  });

  test("without a platform key: never the fake provider, only the workspace credential", () => {
    expect(loadConfig(PROD).model).toEqual({ provider: "workspace_only" });
    expect(loadConfig({ ...PROD, ANTHROPIC_API_KEY: "sk-ant-1" }).model).toEqual({
      provider: "anthropic",
      apiKey: "sk-ant-1",
    });
    // Outside production nothing changes: without a key, the fake one.
    expect(loadConfig({}).model).toMatchObject({ provider: "fake", forced: false });
    expect(loadConfig({ MODEL_PROVIDER: "fake" }).model).toMatchObject({ provider: "fake", forced: true });
  });

  test("explicit MODEL_PROVIDER=fake does not start", () => {
    expect(() => loadConfig({ ...PROD, MODEL_PROVIDER: "fake" })).toThrow("MODEL_PROVIDER=fake");
    expect(() => loadConfig({ ...PROD, MODEL_PROVIDER: "fake", ANTHROPIC_API_KEY: "sk" })).toThrow(
      "MODEL_PROVIDER=fake",
    );
  });

  test("email: missing MAIL_PROVIDER does not start; explicit file starts", () => {
    expect(() => loadConfig(without("MAIL_PROVIDER"))).toThrow("MAIL_PROVIDER");
    expect(loadConfig(PROD).mail).toMatchObject({ provider: "file" });
    expect(loadConfig({ ...PROD, MAIL_PROVIDER: "resend", RESEND_API_KEY: "re_1" }).mail).toMatchObject({
      provider: "resend",
    });
    expect(loadConfig({}).mail).toMatchObject({ provider: "file" });
  });

  test("search: SEARCH_EMBEDDER=fake does not start", () => {
    expect(() => loadConfig({ ...PROD, SEARCH_EMBEDDER: "fake" })).toThrow("SEARCH_EMBEDDER=fake");
    expect(loadConfig({ ...PROD, SEARCH_EMBEDDER: "off" }).search.embedder).toEqual({ kind: "off" });
    expect(loadConfig({ SEARCH_EMBEDDER: "fake" }).search.embedder).toEqual({ kind: "fake" });
  });

  test("origins: TRUSTED_ORIGINS required and no localhost injected", () => {
    expect(() => loadConfig(without("TRUSTED_ORIGINS"))).toThrow("TRUSTED_ORIGINS");
    expect(() => loadConfig({ ...PROD, TRUSTED_ORIGINS: " , " })).toThrow("TRUSTED_ORIGINS");
    expect(() => loadConfig({ ...PROD, TRUSTED_ORIGINS: "not-a-url" })).toThrow("invalid");
    expect(() => loadConfig({ ...PROD, TRUSTED_ORIGINS: "ftp://x.com" })).toThrow("invalid");
    expect(loadConfig({ ...PROD, TRUSTED_ORIGINS: "https://a.com, https://b.com/" }).trustedOrigins).toEqual([
      "https://a.com",
      "https://b.com",
    ]);
    // Outside production, Vite in dev is still accepted by default.
    expect(loadConfig({}).trustedOrigins).toEqual(["http://localhost:5173"]);
    expect(loadConfig({ TRUSTED_ORIGINS: "http://localhost:4410" }).trustedOrigins).toEqual([
      "http://localhost:4410",
    ]);
  });
});
