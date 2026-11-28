// Where integrations may connect: one decision point (integrations/net.ts) for MCP, S3, IMAP and SMTP, the
// connection to the IP it checked, every redirect checked again, TLS unless the operator allows plain text, and
// replies with a byte cap and a deadline.
import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server, type Socket } from "node:net";
import { HttpError } from "../src/http";
import { connectCustom } from "../src/integrations/connectors";
import { ImapClient } from "../src/integrations/imap";
import { McpClient, McpError } from "../src/integrations/mcp";
import { guardedFetch, type NetPolicy, resolveHost } from "../src/integrations/net";
import { exchangeCode } from "../src/integrations/oauth";
import { s3Blobs } from "../src/integrations/s3";
import { smtpSend } from "../src/integrations/smtp";
import { startFakeMcp } from "./fake-mcp";
import { startFakeS3 } from "./fake-s3";
import { SERVER_TEST_MS, signedIn, startTestServer } from "./harness";
import { seedWorkspace } from "./seed";

/** The code of the HttpError a call ends in, or the message of any other error. */
const failureOf = async (run: Promise<unknown>) => {
  try {
    await run;
    return "ok";
  } catch (err) {
    return err instanceof HttpError ? err.code : err instanceof Error ? err.message : String(err);
  }
};

const CLOSED: NetPolicy = { allowPrivate: false, allowPlaintext: false };
const LOCAL: NetPolicy = { allowPrivate: true, allowPlaintext: true };
/** A public name resolving to a public IP (no real DNS in the tests). */
const PUBLIC_IP = "93.184.216.34";

describe("the address after resolving the name", () => {
  test.each([
    "127.0.0.1",
    "2130706433",
    "0x7f000001",
    "0177.0.0.1",
    "0x7f.1",
    "127.1",
    "::1",
    "::ffff:127.0.0.1",
    "[::ffff:7f00:1]",
    "169.254.169.254",
    "10.0.0.1",
    "0.0.0.0",
    "fd00::1",
    "localhost",
  ])("%p is rejected without the local network", async (host) => {
    expect(await failureOf(resolveHost(host, false))).toBe("blocked_host");
  });

  test("a name with any internal address is rejected; a public one connects to its first IP", async () => {
    const dns = async (host: string) => (host === "inside.test" ? [PUBLIC_IP, "10.1.2.3"] : [PUBLIC_IP]);
    expect(await failureOf(resolveHost("inside.test", false, "blocked_host", dns))).toBe("blocked_host");
    expect(await resolveHost("outside.test", false, "blocked_host", dns)).toBe(PUBLIC_IP);
    // The installation allows the local network: nothing is resolved here.
    expect(await resolveHost("10.0.0.1", true)).toBe("10.0.0.1");
  });
});

describe("guardedFetch", () => {
  const recorder = (answers: Response[]) => {
    const sent: { url: string; init: RequestInit & { tls?: { serverName?: string } } }[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      sent.push({ url, init });
      return answers.shift() ?? new Response("no more answers", { status: 500 });
    }) as unknown as typeof fetch;
    return { sent, fetchFn };
  };

  test("connects to the IP it checked, keeping the name in Host and in the TLS SNI (one resolution)", async () => {
    const resolved: string[] = [];
    const dns = async (host: string) => {
      resolved.push(host);
      return [PUBLIC_IP];
    };
    const { sent, fetchFn } = recorder([new Response("ok")]);
    await guardedFetch(fetchFn, false, dns)("https://mcp.example.test/rpc", { method: "POST" });
    expect(resolved).toEqual(["mcp.example.test"]);
    expect(sent[0]?.url).toBe(`https://${PUBLIC_IP}/rpc`);
    expect(new Headers(sent[0]?.init.headers).get("host")).toBe("mcp.example.test");
    expect(sent[0]?.init.tls?.serverName).toBe("mcp.example.test");
    expect(sent[0]?.init.redirect).toBe("manual");
  });

  test("each redirect passes the same check: one to the internal network stops there", async () => {
    const dns = async (host: string) => (host === "metadata.test" ? ["169.254.169.254"] : [PUBLIC_IP]);
    for (const location of ["http://10.0.0.1/x", "https://metadata.test/latest", "https://[::ffff:a00:1]/"]) {
      const { sent, fetchFn } = recorder([new Response(null, { status: 302, headers: { location } })]);
      const got = await failureOf(guardedFetch(fetchFn, false, dns)("https://ok.test/"));
      expect([location, got]).toEqual([
        location,
        location.startsWith("http:") ? "invalid_url" : "blocked_host",
      ]);
      expect(sent).toHaveLength(1);
    }
  });

  test("plain http only when the operator allows it", async () => {
    const { fetchFn } = recorder([new Response("ok"), new Response("ok")]);
    const dns = async () => [PUBLIC_IP];
    expect(await failureOf(guardedFetch(fetchFn, false, dns, false)("http://ok.test/"))).toBe("invalid_url");
    expect(await failureOf(guardedFetch(fetchFn, false, dns, true)("http://ok.test/"))).toBe("ok");
  });

  test("a same-origin redirect keeps every header; another origin gets only the allowlisted ones", async () => {
    const sentHeaders = {
      authorization: "Bearer test-token",
      cookie: "session=test-cookie",
      "x-api-key": "composio-key",
      "x-secret": "made-up-secret",
      accept: "application/json",
      "content-type": "application/json",
      "user-agent": "vanr-test",
      range: "bytes=0-9",
    };
    const received: { method: string; body: string; headers: Record<string, string | null> }[] = [];
    const record = async (req: Request) => {
      const headers = Object.fromEntries(Object.keys(sentHeaders).map((k) => [k, req.headers.get(k)]));
      received.push({ method: req.method, body: await req.text(), headers });
    };
    const target = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        await record(req);
        return new Response("ok");
      },
    });
    stops.push(async () => {
      await target.stop(true);
    });
    const source = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        if (new URL(req.url).pathname === "/start")
          return new Response(null, { status: 307, headers: { location: "/same" } });
        await record(req);
        return new Response(null, { status: 307, headers: { location: target.url.toString() } });
      },
    });
    stops.push(async () => {
      await source.stop(true);
    });
    // 307 keeps the method and replays the body on both hops; only the headers change at the new origin.
    const res = await guardedFetch(fetch, true)(new URL("/start", source.url), {
      method: "POST",
      headers: sentHeaders,
      body: '{"q":1}',
    });
    expect(await res.text()).toBe("ok");
    expect(received).toEqual([
      { method: "POST", body: '{"q":1}', headers: sentHeaders },
      {
        method: "POST",
        body: '{"q":1}',
        headers: {
          authorization: null,
          cookie: null,
          "x-api-key": null,
          "x-secret": null,
          accept: "application/json",
          "content-type": "application/json",
          "user-agent": "vanr-test",
          range: "bytes=0-9",
        },
      },
    ]);
  });

  test("a token request that is redirected fails without sending its form on", async () => {
    const dns = async () => [PUBLIC_IP];
    const { sent, fetchFn } = recorder([
      new Response(null, { status: 307, headers: { location: "https://other.test/token" } }),
    ]);
    const exchange = exchangeCode(
      guardedFetch(fetchFn, false, dns),
      {
        tokenEndpoint: "https://auth.test/token",
        code: "c",
        verifier: "v",
        redirectUri: "https://vanr.test/back",
        clientId: "client",
        clientSecret: "secret",
      },
      new Date(),
    );
    await expect(exchange).rejects.toThrow("Token exchange failed");
    expect(sent.map((s) => s.url)).toEqual([`https://${PUBLIC_IP}/token`]);
  });

  test("a guard wrapped again is one guard: the credentials follow a redirect back to the same name", async () => {
    const dns = async () => [PUBLIC_IP];
    const { sent, fetchFn } = recorder([
      new Response(null, { status: 307, headers: { location: "https://mcp.example.test/end" } }),
      new Response("ok"),
    ]);
    const twice = guardedFetch(guardedFetch(fetchFn, false, dns), false, dns);
    const res = await twice("https://mcp.example.test/start", { headers: { authorization: "Bearer k" } });
    expect(await res.text()).toBe("ok");
    expect(sent.map((s) => [s.url, new Headers(s.init.headers).get("authorization")])).toEqual([
      [`https://${PUBLIC_IP}/start`, "Bearer k"],
      [`https://${PUBLIC_IP}/end`, "Bearer k"],
    ]);
  });
});

describe("the server's integration network policy", () => {
  test(
    "requires TLS even with private networks allowed, including on redirects",
    async () => {
      const sent: string[] = [];
      const server = await startTestServer({
        env: { ALLOW_PRIVATE_NETWORKS: "true", ALLOW_PLAINTEXT_INTEGRATIONS: "false" },
        fetchExternal: Object.assign(
          async (input: string | URL | Request) => {
            const url = input instanceof Request ? input.url : String(input);
            sent.push(url);
            return url.endsWith("/redirect")
              ? new Response(null, { status: 302, headers: { location: `http://${PUBLIC_IP}/rpc` } })
              : new Response("ok");
          },
          { preconnect() {} },
        ),
      });
      try {
        expect(await (await server.deps.fetchExternal("https://127.0.0.1/rpc")).text()).toBe("ok");
        await expect(server.deps.fetchExternal(`https://${PUBLIC_IP}/redirect`)).rejects.toMatchObject({
          code: "invalid_url",
        });
        await expect(server.deps.fetchExternal(`http://${PUBLIC_IP}/rpc`)).rejects.toMatchObject({
          code: "invalid_url",
        });
        expect(sent).toEqual(["https://127.0.0.1/rpc", `https://${PUBLIC_IP}/redirect`]);
      } finally {
        await server.stop();
      }
    },
    SERVER_TEST_MS,
  );

  test(
    "allows plaintext while still blocking private networks",
    async () => {
      const sent: string[] = [];
      const server = await startTestServer({
        env: { ALLOW_PRIVATE_NETWORKS: "false", ALLOW_PLAINTEXT_INTEGRATIONS: "true" },
        fetchExternal: Object.assign(
          async (input: string | URL | Request) => {
            sent.push(input instanceof Request ? input.url : String(input));
            return new Response("ok");
          },
          { preconnect() {} },
        ),
      });
      try {
        expect(await (await server.deps.fetchExternal(`http://${PUBLIC_IP}/rpc`)).text()).toBe("ok");
        await expect(server.deps.fetchExternal("http://127.0.0.1/rpc")).rejects.toMatchObject({
          code: "blocked_host",
        });
        expect(sent).toEqual([`http://${PUBLIC_IP}/rpc`]);
      } finally {
        await server.stop();
      }
    },
    SERVER_TEST_MS,
  );

  test(
    "a connector on a public plain http address connects when plain text is allowed",
    async () => {
      const mcp = startFakeMcp({ keyOnly: true });
      const sent: string[] = [];
      const server = await startTestServer({
        env: { ALLOW_PRIVATE_NETWORKS: "false", ALLOW_PLAINTEXT_INTEGRATIONS: "true" },
        // The public address answers as the fake MCP server on loopback.
        fetchExternal: Object.assign(
          async (input: string | URL | Request, init?: RequestInit) => {
            sent.push(input instanceof Request ? input.url : String(input));
            return fetch(mcp.url, init);
          },
          { preconnect() {} },
        ),
      });
      try {
        const ana = await signedIn(server, "Ana", "ana@plaintext.test");
        const { workspaceId } = await seedWorkspace(server, ana);
        const me = {
          workspaceId,
          userId: ana.user.id,
          role: "owner" as const,
          handle: "ana",
          sessionId: "s",
        };
        const connected = await connectCustom(server.deps, me, {
          serverUrl: `http://${PUBLIC_IP}/mcp`,
          apiKey: mcp.apiKey,
          nextPath: "/",
        });
        expect(connected.status).toBe("server");
        expect(sent.length).toBeGreaterThan(0);
        expect(sent.every((url) => url === `http://${PUBLIC_IP}/mcp`)).toBe(true);
      } finally {
        await server.stop();
        mcp.stop();
      }
    },
    SERVER_TEST_MS,
  );
});

/** A TCP server that counts connections and answers each with `onSocket`. */
async function tcpServer(onSocket: (s: Socket) => void) {
  let connections = 0;
  const sockets: Socket[] = [];
  const server: Server = createServer((socket) => {
    connections++;
    sockets.push(socket);
    socket.on("error", () => {});
    onSocket(socket);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  return {
    port: addr.port,
    connections: () => connections,
    stop: () => {
      for (const s of sockets) s.destroy();
      return new Promise<void>((r) => server.close(() => r()));
    },
  };
}

let stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of stops) await stop();
  stops = [];
});

describe("IMAP and SMTP go through the same rule", () => {
  test("an internal host is rejected before any connection; plain text is rejected when not allowed", async () => {
    const srv = await tcpServer((s) => s.write("* OK ready\r\n"));
    stops.push(srv.stop);
    const base = { host: "127.0.0.1", port: srv.port, user: "u", password: "p" };
    expect(await failureOf(ImapClient.open({ ...base, secure: true, policy: CLOSED }))).toBe("blocked_host");
    expect(
      await failureOf(
        ImapClient.open({ ...base, secure: false, policy: { ...LOCAL, allowPlaintext: false } }),
      ),
    ).toBe("tls_required");
    const envelope = { from: "a@b.test", to: ["c@d.test"] };
    expect(await failureOf(smtpSend({ ...base, security: "tls", policy: CLOSED }, envelope, "x"))).toBe(
      "blocked_host",
    );
    expect(
      await failureOf(
        smtpSend({ ...base, security: "none", policy: { ...LOCAL, allowPlaintext: false } }, envelope, "x"),
      ),
    ).toBe("tls_required");
    expect(srv.connections()).toBe(0);
  });

  test("IMAP: a literal larger than the cap is rejected before reading it", async () => {
    const srv = await tcpServer((s) => {
      s.write("* OK ready\r\n");
      s.on("data", (d) => {
        const tag = d.toString().split(" ")[0];
        s.write(`* 1 FETCH (UID 1 BODY[] {999999999}\r\n`);
        s.write(`${tag} OK done\r\n`);
      });
    });
    stops.push(srv.stop);
    const client = await ImapClient.open({
      host: "127.0.0.1",
      port: srv.port,
      secure: false,
      policy: LOCAL,
      user: "u",
      password: "p",
      maxReplyBytes: 1024 * 1024,
    });
    expect(await failureOf(client.fetch([1]))).toBe("The mail server sent a reply that is too large");
  });

  test("IMAP: a line that never ends can't grow past the cap", async () => {
    const srv = await tcpServer((s) => {
      s.write("* OK ready\r\n");
      s.on("data", () => {
        const chunk = "x".repeat(64 * 1024);
        for (let i = 0; i < 40; i++) s.write(chunk);
      });
    });
    stops.push(srv.stop);
    const client = await ImapClient.open({
      host: "127.0.0.1",
      port: srv.port,
      secure: false,
      policy: LOCAL,
      user: "u",
      password: "p",
      maxReplyBytes: 1024 * 1024,
    });
    expect(await failureOf(client.folders())).toBe("The mail server sent a reply that is too large");
  });

  test("IMAP: a server that trickles a reply hits the command's deadline", async () => {
    const timers: ReturnType<typeof setInterval>[] = [];
    const srv = await tcpServer((s) => {
      s.write("* OK ready\r\n");
      s.on("data", () => {
        s.write('* LIST () "/" ');
        timers.push(setInterval(() => s.writable && s.write("x"), 20));
      });
    });
    stops.push(async () => {
      for (const t of timers) clearInterval(t);
      await srv.stop();
    });
    const client = await ImapClient.open({
      host: "127.0.0.1",
      port: srv.port,
      secure: false,
      policy: LOCAL,
      user: "u",
      password: "p",
      timeoutMs: 5_000,
      commandMs: 300,
    });
    const started = Date.now();
    expect(await failureOf(client.folders())).toBe("Mail server did not answer in time");
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe("MCP", () => {
  const serve = (handler: (req: Request) => Response) => {
    let requests = 0;
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (req) => {
        requests++;
        return handler(req);
      },
    });
    stops.push(async () => {
      server.stop(true);
    });
    return { url: `http://127.0.0.1:${server.port}/mcp`, requests: () => requests };
  };

  test("an internal address is rejected before any request; plain http only when allowed", async () => {
    const srv = serve(() => Response.json({}));
    const closed = new McpClient({ url: srv.url, fetch, policy: CLOSED });
    expect(await failureOf(closed.listTools())).toBe("invalid_url");
    const https = new McpClient({ url: srv.url.replace("http:", "https:"), fetch, policy: CLOSED });
    expect(await failureOf(https.listTools())).toBe("blocked_host");
    const noPlain = new McpClient({ url: srv.url, fetch, policy: { ...LOCAL, allowPlaintext: false } });
    expect(await failureOf(noPlain.listTools())).toBe("invalid_url");
    expect(srv.requests()).toBe(0);
  });

  test("a response past the byte cap is rejected, declared or streamed", async () => {
    const big = "x".repeat(2 * 1024 * 1024);
    const declared = serve(() => new Response(big, { headers: { "content-type": "application/json" } }));
    const client = new McpClient({ url: declared.url, fetch, policy: LOCAL, maxResponseBytes: 1024 * 1024 });
    const err = await client.listTools().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpError);
    expect((err as Error).message).toBe("MCP server sent a response that is too large");

    const streamed = serve(
      () =>
        new Response(
          new ReadableStream({
            pull(c) {
              c.enqueue(new TextEncoder().encode("x".repeat(64 * 1024)));
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
    const endless = new McpClient({ url: streamed.url, fetch, policy: LOCAL, maxResponseBytes: 1024 * 1024 });
    expect(await failureOf(endless.listTools())).toBe("MCP server sent a response that is too large");
  });

  test("a stream that never ends hits the deadline", async () => {
    const srv = serve(
      () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode(": ping\n\n"));
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
    const client = new McpClient({ url: srv.url, fetch, policy: LOCAL, timeoutMs: 300 });
    const started = Date.now();
    const err = await client.listTools().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpError);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe("S3", () => {
  test("the endpoint passes the same rule before each operation, the bucket host included", async () => {
    const s3 = startFakeS3();
    stops.push(async () => s3.stop());
    const cfg = {
      endpoint: s3.endpoint,
      region: "us-east-1",
      bucket: s3.bucket,
      prefix: "",
      pathAddressing: true,
      accessKeyId: "AKIATEST",
      secretAccessKey: "secret",
    };
    const put = (policy: NetPolicy, extra = {}) =>
      failureOf(
        s3Blobs({ ...cfg, ...extra }, policy).put("a.txt", new TextEncoder().encode("hi"), "text/plain"),
      );
    expect(await put(CLOSED, { endpoint: s3.endpoint.replace("http:", "https:") })).toBe("blocked_host");
    expect(await put({ ...LOCAL, allowPlaintext: false })).toBe("invalid_url");
    // Virtual-hosted style: the endpoint already carries the bucket in its host, and that name resolves on its own.
    const dns = async (host: string) => (host.startsWith("evil.") ? ["169.254.169.254"] : [PUBLIC_IP]);
    expect(
      await put(
        { ...CLOSED, resolve: dns },
        { endpoint: "https://evil.s3.example.test", bucket: "evil", pathAddressing: false },
      ),
    ).toBe("blocked_host");
    expect(s3.objects.size).toBe(0);
    expect(await put(LOCAL)).toBe("ok");
    expect([...s3.objects.keys()]).toEqual(["a.txt"]);
  });
});
