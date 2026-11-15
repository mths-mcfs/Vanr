// What the server rejects at its edges: a revoked credential, the values of a failed query in the log, a JSON
// body too large or of another type, a reservation that would lower the spending, a server URL that would
// break the install script, and password guessing past the auth rate limits.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type Db, openDb } from "@vanr/engine/db";
import { createSealer } from "@vanr/engine/seal";
import { CONTRACT_PRICES } from "@vanr/engine/usage-contract";
import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { AUTH_RATE_LIMITS, createAuth } from "../src/auth";
import { loadConfig } from "../src/config";
import { errorBody, HttpError, JSON_BODY_LIMIT, readJson } from "../src/http";
import { log } from "../src/logger";
import { createProviderLookup } from "../src/models";
import { installScript } from "../src/runners/install";
import { LEDGER_LIMITS, postgresLedger } from "../src/usage-ledger";

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await openDb({ kind: "pglite", dataDir: null }));
  await db.execute(sql`insert into workspaces (id, name) values ('w1', 'Acme')`);
});
afterAll(() => close());

describe("model credentials", () => {
  const sealer = createSealer("test-secret", "credentials");
  const lookup = () =>
    createProviderLookup(
      {
        config: loadConfig({ ANTHROPIC_API_KEY: "sk-ant-platform" }),
        db,
        now: () => new Date(),
        hub: { toChannel() {}, toWorkspace() {} },
        ledger: postgresLedger(db, CONTRACT_PRICES),
        sealer,
      },
      {},
    );

  test("a revoked credential is an error, never the installation's key", async () => {
    await db.execute(sql`
      insert into credentials (id, workspace_id, label, provider, secret, key_preview, revoked_at)
      values ('cred_old', 'w1', 'Old', 'anthropic', ${sealer.seal("sk-ant-old")}, 'sk-…old', now()),
             ('cred_live', 'w1', 'Live', 'anthropic', ${sealer.seal("sk-ant-live")}, 'sk-…ive', null)
    `);
    const find = lookup();
    // Pointed at by the agent, and as the workspace's primary credential.
    expect(await find({ workspaceId: "w1", credentialId: "cred_old" })).toEqual({ error: "no_credential" });
    await db.execute(sql`update workspaces set primary_credential_id = 'cred_old' where id = 'w1'`);
    expect(await find({ workspaceId: "w1", credentialId: null })).toEqual({ error: "no_credential" });
    // A live credential answers; with no credential pointed at, the platform key still does.
    expect(await find({ workspaceId: "w1", credentialId: "cred_live" })).not.toHaveProperty("error");
    await db.execute(sql`update workspaces set primary_credential_id = null where id = 'w1'`);
    expect(await find({ workspaceId: "w1", credentialId: null })).not.toHaveProperty("error");
  });
});

describe("the log never carries a failed query's values", () => {
  const capture = (run: () => void) => {
    const chunks: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stderr.write;
    try {
      run();
    } finally {
      process.stderr.write = write;
    }
    return chunks.join("");
  };

  test("message and stack lose `params:`; the query with its placeholders and the code stay", async () => {
    const secret = "user-secret-token-XYZ123";
    const err = await db
      .execute(sql`insert into workspaces (id, name) values ('w1', ${secret})`)
      .catch((e: unknown) => e);
    expect(String((err as Error).message)).toContain(secret);
    const line = capture(() => log.error("db.failed", { err, nested: { cause: err } }));
    expect(line).not.toContain(secret);
    const logged = JSON.parse(line.trim()) as { err: { message: string; stack?: string; code?: string } };
    expect(logged.err.message).toContain("insert into workspaces (id, name) values ('w1', $1)");
    expect(logged.err.stack ?? "").not.toContain("params: user");
    expect(logged.err.code).toBe("23505");
  });
});

describe("readJson", () => {
  const app = new Hono();
  app.onError((err, c) =>
    err instanceof HttpError ? c.json(errorBody(err.code, err.message), err.status) : c.json({}, 500),
  );
  app.post("/t", async (c) => c.json(await readJson(c, z.object({ a: z.string() }))));
  const post = (
    body: RequestInit["body"],
    headers: Record<string, string> = { "content-type": "application/json" },
  ) => app.request("/t", { method: "POST", headers, body });
  const codeOf = async (res: Response) => [
    res.status,
    ((await res.json()) as { error?: { code: string } }).error?.code,
  ];

  test("past 1 MB: 413 payload_too_large, by the declared size or while reading", async () => {
    const big = JSON.stringify({ a: "x".repeat(JSON_BODY_LIMIT) });
    expect(await codeOf(await post(big))).toEqual([413, "payload_too_large"]);
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled += 64 * 1024;
        // A body without a length that never ends: the read stops a little past the limit.
        if (pulled > 64 * JSON_BODY_LIMIT) c.close();
        else c.enqueue(new Uint8Array(64 * 1024).fill(32));
      },
    });
    expect(await codeOf(await post(stream))).toEqual([413, "payload_too_large"]);
    expect(pulled).toBeLessThan(2 * JSON_BODY_LIMIT);
  });

  test("another content type: 415 unsupported_media_type, before reading", async () => {
    expect(await codeOf(await post('{"a":"x"}', { "content-type": "text/plain" }))).toEqual([
      415,
      "unsupported_media_type",
    ]);
    expect(await codeOf(await post('{"a":"x"}', {}))).toEqual([415, "unsupported_media_type"]);
  });

  test("JSON within the limit still works, and an empty body is {}", async () => {
    const ok = await post(JSON.stringify({ a: "x".repeat(1000) }), {
      "content-type": "application/json; charset=utf-8",
    });
    expect(ok.status).toBe(200);
    expect(await codeOf(await post(null, {}))).toEqual([400, "invalid_request"]);
  });
});

describe("usage ledger input", () => {
  const ledger = () => postgresLedger(db, CONTRACT_PRICES);
  const at = new Date("2026-11-14T12:00:00Z");
  const scope = { kind: "agent" as const, id: "ag1", limitUsd: 1, period: "month" as const };
  const call = (inputTokens: number, runId: string) => ({
    workspaceId: "w1",
    agentId: "ag1",
    userId: "u1",
    runId,
    source: "chat" as const,
    model: "m",
    usage: { inputTokens, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0 },
    at,
  });

  test.each([-5, -0.000001, Number.NaN, Number.POSITIVE_INFINITY, LEDGER_LIMITS.maxUsd + 1])(
    "a reservation of %p is rejected",
    async (estimateUsd) => {
      await expect(ledger().reserve({ workspaceId: "w1", scopes: [scope], estimateUsd, at })).rejects.toThrow(
        RangeError,
      );
    },
  );

  test.each([-1, Number.NaN, Number.NEGATIVE_INFINITY])("a cap of %p is rejected", async (limitUsd) => {
    await expect(
      ledger().reserve({ workspaceId: "w1", scopes: [{ ...scope, limitUsd }], estimateUsd: 0.1, at }),
    ).rejects.toThrow(RangeError);
  });

  test("a call with negative, fractional or absurd tokens is rejected and the spending doesn't move", async () => {
    const l = ledger();
    const r = await l.reserve({ workspaceId: "w1", scopes: [scope], estimateUsd: 0.1, at });
    if (!r.ok) throw new Error("reservation rejected");
    for (const [n, tokens] of [-2_000_000, 1.5, 3_000_000_000, Number.NaN].entries())
      await expect(l.settle(r.reservation, call(tokens, `r${n}`))).rejects.toThrow(RangeError);
    await expect(l.record(call(-1, "rx"), [scope])).rejects.toThrow(RangeError);
    expect(await l.spent(scope, at)).toBe(0);
    // The reservation is still open and settles normally.
    expect((await l.settle(r.reservation, call(1000, "ok"))).costUsd).toBeGreaterThanOrEqual(0);
  });
});

describe("install script", () => {
  const sha = "0".repeat(64);
  test.each([
    "https://ok.test\nid #",
    "https://ok.test\rid",
    "https://ok.test/\u0000",
    "ftp://ok.test",
    "javascript:alert(1)",
    "https://user:pass@ok.test",
    "https://ok.test/?x=$(id)",
    "not a url",
  ])("%p is rejected as the server URL", (server) => {
    expect(() => installScript({ server, sha256: sha })).toThrow();
  });

  test("every value in the script is shell-quoted; a quote in the path can't close it", () => {
    const sh = installScript({ server: "https://ok.test/a'b", sha256: sha });
    expect(sh).toContain(`SERVER='https://ok.test/a'\\''b'`);
    expect(sh.split("\n").slice(0, 3).join("\n")).toBe(
      "#!/bin/sh\n# Installs vanr-runner on this computer and pairs it with 'https://ok.test/a'\\''b'.\n" +
        "# Usage: curl -fsSL 'https://ok.test/a'\\''b/api/v1/runners/install.sh' | sh -s -- [--name NAME] [--dir FOLDER] [--no-exec] [--no-service] [--no-pair]",
    );
    expect(() => installScript({ server: "https://ok.test", sha256: "abc'; id" })).toThrow();
  });
});

describe("auth rate limits", () => {
  const PROD = {
    NODE_ENV: "production",
    BETTER_AUTH_SECRET: "a".repeat(32),
    MAIL_PROVIDER: "file",
    TRUSTED_ORIGINS: "https://app.example.com",
    PUBLIC_URL: "https://app.example.com",
  };
  const auth = (env: Record<string, string>) => {
    const cfg = loadConfig(env);
    return createAuth({
      db,
      config: cfg,
      mailer: { async send() {} },
      trustedOrigins: cfg.trustedOrigins,
      signupAllowed: async () => true,
    });
  };
  const signIn = (a: ReturnType<typeof auth>, ip: string) =>
    a.handler(
      new Request("https://app.example.com/api/auth/sign-in/email", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://app.example.com",
          "x-forwarded-for": ip,
        },
        body: JSON.stringify({ email: "nobody@example.com", password: "wrong-password" }),
      }),
    );

  test("production: past the limit an IP gets 429; another IP still gets an answer", async () => {
    const a = auth(PROD);
    const max = AUTH_RATE_LIMITS.rules["/sign-in/*"].max;
    const statuses: number[] = [];
    for (let i = 0; i < max + 3; i++) statuses.push((await signIn(a, "203.0.113.7")).status);
    expect(statuses).toEqual([...Array(max).fill(401), 429, 429, 429]);
    expect((await signIn(a, "203.0.113.8")).status).toBe(401);
  });

  test("the operator can turn it off (AUTH_RATE_LIMIT=false); outside production it is off", async () => {
    for (const env of [{ ...PROD, AUTH_RATE_LIMIT: "false" }, {}]) {
      const a = auth(env);
      const statuses = new Set<number>();
      for (let i = 0; i < 8; i++) statuses.add((await signIn(a, "203.0.113.9")).status);
      expect([...statuses]).toEqual([401]);
    }
  });

  test("production: the session cookie is Secure (PUBLIC_URL is https)", async () => {
    const a = auth(PROD);
    const res = await a.handler(
      new Request("https://app.example.com/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://app.example.com" },
        body: JSON.stringify({ email: "cookie@example.com", password: "password123", name: "C" }),
      }),
    );
    const cookies = res.headers.getSetCookie();
    expect(cookies.some((c) => c.includes("session_token"))).toBe(true);
    for (const c of cookies) expect(c).toContain("Secure");
  });
});
