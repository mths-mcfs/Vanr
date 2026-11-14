import { afterAll, beforeAll, expect, test } from "bun:test";
import net from "node:net";
import { type NetBlock, type NetGuard, startNetGuard } from "./net-guard";

// Test destination on 127.0.0.2 (allowed by the range) and a "victim" on 127.0.0.1 on the same port.
const BIG = "x".repeat(4 * 1024 * 1024);
let site: ReturnType<typeof Bun.serve>;
let victim: ReturnType<typeof Bun.serve>;
const victimHits: string[] = [];
const dns = new Map<string, () => string[]>();
const blocks: NetBlock[] = [];
let guard: NetGuard;

beforeAll(async () => {
  site = Bun.serve({
    hostname: "127.0.0.2",
    port: 0,
    fetch: (req) => new Response(new URL(req.url).pathname === "/big" ? BIG : "site ok"),
  });
  victim = Bun.serve({
    hostname: "127.0.0.1",
    port: site.port,
    fetch: (req) => {
      victimHits.push(new URL(req.url).pathname);
      return new Response("internal secret");
    },
  });
  guard = await startNetGuard({
    ranges: () => ["127.0.0.2/32"],
    resolve: async (h) => dns.get(h)?.() ?? [],
    onBlock: (b) => blocks.push(b),
  });
});
afterAll(() => {
  guard.close();
  site.stop(true);
  victim.stop(true);
});

/** Talks to the proxy in raw text and returns everything it answered until it closed. */
function raw(text: string, after?: (sock: net.Socket, first: string) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: "127.0.0.1", port: guard.port }, () => sock.write(text));
    const chunks: Buffer[] = [];
    let sentAfter = false;
    sock.on("data", (c: Buffer) => {
      chunks.push(c);
      if (after && !sentAfter && Buffer.concat(chunks).includes("\r\n\r\n")) {
        sentAfter = true;
        after(sock, Buffer.concat(chunks).toString("latin1"));
      }
    });
    sock.on("end", () => resolve(Buffer.concat(chunks).toString("latin1")));
    sock.on("error", reject);
  });
}

const get = (host: string, path = "/") =>
  raw(
    `GET http://${host}:${site.port}${path} HTTP/1.1\r\nHost: ${host}:${site.port}\r\nProxy-Connection: keep-alive\r\n\r\n`,
  );

test("allowed http goes through, with Connection: close in the answer and the whole body", async () => {
  dns.set("site.test", () => ["127.0.0.2"]);
  const r = await get("site.test");
  expect(r).toStartWith("HTTP/1.1 200");
  expect(r).toContain("Connection: close");
  expect(r.endsWith("site ok")).toBe(true);
  const big = await get("site.test", "/big");
  expect(big.slice(big.indexOf("\r\n\r\n") + 4).length).toBe(BIG.length);
});

test("loopback, link-local, private and CGNAT are blocked, by IP or by name", async () => {
  dns.set("intra.test", () => ["10.0.0.7"]);
  dns.set("mixed.test", () => ["127.0.0.2", "192.168.1.1"]);
  for (const host of [
    "127.0.0.1",
    "[::1]",
    "localhost",
    "a.localhost",
    "169.254.169.254",
    "intra.test",
    "mixed.test",
    "100.64.0.1",
  ]) {
    const r = await get(host);
    expect(r, host).toStartWith("HTTP/1.1 403");
  }
  expect(blocks.map((b) => b.kind)).toEqual([
    "loopback",
    "loopback",
    "loopback",
    "loopback",
    "link_local",
    "private",
    "private",
    "shared",
  ]);
  expect(victimHits).toEqual([]);
});

test("an allowed CONNECT becomes a tunnel; CONNECT to the internal network is rejected", async () => {
  dns.set("site.test", () => ["127.0.0.2"]);
  const ok = await raw(
    `CONNECT site.test:${site.port} HTTP/1.1\r\nHost: site.test:${site.port}\r\n\r\n`,
    (sock) => sock.write(`GET / HTTP/1.1\r\nHost: site.test\r\nConnection: close\r\n\r\n`),
  );
  expect(ok).toStartWith("HTTP/1.1 200 Connection Established");
  expect(ok.endsWith("site ok")).toBe(true);
  const no = await raw(`CONNECT 127.0.0.1:${site.port} HTTP/1.1\r\n\r\n`);
  expect(no).toStartWith("HTTP/1.1 403");
  expect(victimHits).toEqual([]);
});

test("DNS rebinding: the name is resolved once per connection and the connection goes to the checked IP", async () => {
  // A check and a connection with different resolutions (the attack) would reach the victim on the even answer.
  let n = 0;
  dns.set("flip.test", () => (++n % 2 === 1 ? ["127.0.0.2"] : ["127.0.0.1"]));
  const results = [];
  for (let i = 0; i < 6; i++) results.push((await get("flip.test")).slice(0, 12));
  expect(n).toBe(6);
  expect(results).toEqual([
    "HTTP/1.1 200",
    "HTTP/1.1 403",
    "HTTP/1.1 200",
    "HTTP/1.1 403",
    "HTTP/1.1 200",
    "HTTP/1.1 403",
  ]);
  expect(victimHits).toEqual([]);
});

test("the page does not use the proxy to call the proxy itself, not even with loopback allowed", async () => {
  const open = await startNetGuard({ ranges: () => ["127.0.0.0/8"], resolve: async () => [] });
  try {
    const r = await new Promise<string>((resolve) => {
      const sock = net.connect({ host: "127.0.0.1", port: open.port }, () =>
        sock.write(`GET http://127.0.0.1:${open.port}/ HTTP/1.1\r\nHost: x\r\n\r\n`),
      );
      let out = "";
      sock.on("data", (c) => {
        out += c.toString("latin1");
      });
      sock.on("end", () => resolve(out));
    });
    expect(r).toStartWith("HTTP/1.1 403");
  } finally {
    open.close();
  }
});

test("another scheme or a malformed request does not go through", async () => {
  expect(await raw(`GET ftp://site.test/ HTTP/1.1\r\n\r\n`)).toStartWith("HTTP/1.1 405");
  expect(await raw(`GET /relative HTTP/1.1\r\n\r\n`)).toStartWith("HTTP/1.1 400");
  expect(await raw(`CONNECT [nothing HTTP/1.1\r\n\r\n`)).toStartWith("HTTP/1.1 400");
});
