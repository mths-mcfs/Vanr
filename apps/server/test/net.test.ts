import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { connectCustom } from "../src/integrations/connectors";
import { guardedFetch, isPrivateAddress, type Resolver } from "../src/integrations/net";
import { discoverAuthServer } from "../src/integrations/oauth";
import type { RunningServer } from "../src/server";
import { SERVER_TEST_MS, signedIn, startTestServer } from "./harness";
import { seedWorkspace } from "./seed";

// The integrations' network on the cloud edition: nothing of the internal network, not even when the remote
// server points at it later (OAuth metadata, client registration, redirect).

type Seen = {
  method: string;
  url: string;
  auth: string | null;
  host: string | null;
  serverName: string | null;
};

function fakeFetch(routes: Record<string, (init: RequestInit) => Response>) {
  const seen: Seen[] = [];
  const fn = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    const headers = new Headers(init.headers);
    const tls = (init as { tls?: { serverName?: string } }).tls;
    seen.push({
      method: init.method ?? "GET",
      url,
      auth: headers.get("authorization"),
      host: headers.get("host"),
      serverName: tls?.serverName ?? null,
    });
    const route = Object.entries(routes).find(([prefix]) => url.startsWith(prefix));
    return route ? route[1](init) : new Response("no", { status: 404 });
  };
  return { fetch: Object.assign(fn, { preconnect: () => {} }) as typeof fetch, seen };
}

describe("guardedFetch", () => {
  test("rejects the internal network on the request and on each redirect; the Authorization doesn't change origin", async () => {
    const { fetch: raw, seen } = fakeFetch({
      "https://93.184.216.34/goes-inside": () =>
        new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest" } }),
      "https://93.184.216.34/goes-outside": () =>
        new Response(null, { status: 307, headers: { location: "https://93.184.216.35/end" } }),
      "https://93.184.216.35/end": () => new Response("ok"),
    });
    const guarded = guardedFetch(raw, false);
    await expect(guarded("http://10.0.0.5/admin")).rejects.toMatchObject({ status: 400 });
    await expect(guarded("https://127.0.0.1/admin")).rejects.toMatchObject({ code: "blocked_host" });
    await expect(guarded("https://93.184.216.34/goes-inside")).rejects.toMatchObject({ status: 400 });
    const res = await guarded("https://93.184.216.34/goes-outside", {
      headers: { authorization: "Bearer secret" },
    });
    expect(await res.text()).toBe("ok");
    // No request went out to the internal network; the token stayed with the origin that received it.
    expect(seen.map((s) => [s.url, s.auth] as const)).toEqual([
      ["https://93.184.216.34/goes-inside", null],
      ["https://93.184.216.34/goes-outside", "Bearer secret"],
      ["https://93.184.216.35/end", null],
    ]);
  });

  test("with the local network allowed (selfhost), it follows like fetch", async () => {
    const { fetch: raw } = fakeFetch({
      "http://192.168.0.10/a": () => new Response(null, { status: 302, headers: { location: "/b" } }),
      "http://192.168.0.10/b": () => new Response("b"),
    });
    expect(await (await guardedFetch(raw, true)("http://192.168.0.10/a")).text()).toBe("b");
  });
});

describe("SSRF attacks (cloud edition)", () => {
  /** A fake DNS: each name answers the list of its turn (the last one repeats). */
  function dns(answers: Record<string, string[][]>) {
    const calls: string[] = [];
    const resolve: Resolver = async (host) => {
      calls.push(host);
      const list = answers[host];
      if (!list) throw new Error("NXDOMAIN");
      const n = calls.filter((h) => h === host).length;
      return list[Math.min(n, list.length) - 1] ?? [];
    };
    return { resolve, calls };
  }

  test("http and odd schemes are rejected before any request", async () => {
    const { fetch: raw, seen } = fakeFetch({});
    const guarded = guardedFetch(raw, false, dns({}).resolve);
    for (const url of [
      "http://93.184.216.34/",
      "file:///etc/passwd",
      "gopher://93.184.216.34:70/_x",
      "javascript:alert(1)",
      "ftp://93.184.216.34/",
      "https://user:pass@93.184.216.34/",
    ])
      await expect(guarded(url)).rejects.toMatchObject({ code: "invalid_url" });
    expect(seen).toEqual([]);
  });

  test("a name that resolves to an internal IP is rejected; an internal address written in IPv6 too", async () => {
    const { fetch: raw, seen } = fakeFetch({});
    const { resolve } = dns({
      "internal.example": [["10.0.0.7"]],
      "half.example": [["93.184.216.34", "169.254.169.254"]],
      "v6.example": [["::ffff:7f00:1"]],
    });
    const guarded = guardedFetch(raw, false, resolve);
    for (const url of [
      "https://internal.example/",
      "https://half.example/",
      "https://v6.example/",
      // URL normalizes ::ffff:127.0.0.1 to ::ffff:7f00:1, which the old rule let through.
      "https://[::ffff:127.0.0.1]/",
      "https://[::ffff:a9fe:a9fe]/latest",
      "https://[64:ff9b::a9fe:a9fe]/",
      "https://[2002:7f00:1::]/",
      "https://[fe80::1]/",
      "https://[::1]/",
      "https://0x7f.1/",
      "https://2130706433/",
    ])
      await expect(guarded(url)).rejects.toMatchObject({ code: "blocked_host" });
    expect(seen).toEqual([]);
  });

  test("DNS rebinding: the name is resolved once and the request goes to the checked IP, with the name's Host and SNI", async () => {
    const { fetch: raw, seen } = fakeFetch({
      "https://93.184.216.34/mcp": () =>
        new Response(null, { status: 302, headers: { location: "https://rebind.example/end" } }),
      "https://93.184.216.35/end": () => new Response("ok"),
    });
    // First answer public, second internal: whoever resolves again on connecting lands on the internal network.
    const { resolve, calls } = dns({
      "mcp.example": [["93.184.216.34"], ["127.0.0.1"]],
      "rebind.example": [["93.184.216.35"], ["169.254.169.254"]],
    });
    const res = await guardedFetch(raw, false, resolve)("https://mcp.example/mcp");
    expect(await res.text()).toBe("ok");
    expect(calls).toEqual(["mcp.example", "rebind.example"]);
    expect(seen.map((s) => [s.url, s.host, s.serverName])).toEqual([
      ["https://93.184.216.34/mcp", "mcp.example", "mcp.example"],
      ["https://93.184.216.35/end", "rebind.example", "rebind.example"],
    ]);
  });

  test("a redirect to a name that resolves to the internal network is rejected", async () => {
    const { fetch: raw, seen } = fakeFetch({
      "https://93.184.216.34/": () =>
        new Response(null, { status: 307, headers: { location: "https://internal.example/admin" } }),
    });
    const { resolve } = dns({ "outside.example": [["93.184.216.34"]], "internal.example": [["10.1.2.3"]] });
    await expect(guardedFetch(raw, false, resolve)("https://outside.example/")).rejects.toMatchObject({
      code: "blocked_host",
    });
    expect(seen.map((s) => s.url)).toEqual(["https://93.184.216.34/"]);
  });

  test("OAuth metadata with an odd-scheme address brings the discovery down", async () => {
    for (const bad of ["javascript:alert(1)", "file:///etc/passwd", "http://93.184.216.34/authorize"]) {
      const { fetch: raw } = fakeFetch({
        "https://93.184.216.34/.well-known/oauth-protected-resource": () =>
          Response.json({ authorization_servers: ["https://93.184.216.34"] }),
        "https://93.184.216.34/.well-known/oauth-authorization-server": () =>
          Response.json({
            issuer: "https://93.184.216.34",
            authorization_endpoint: bad,
            token_endpoint: "https://93.184.216.34/token",
            registration_endpoint: "https://93.184.216.34/register",
          }),
      });
      await expect(
        discoverAuthServer(guardedFetch(raw, false), "https://93.184.216.34/mcp", null, false),
      ).rejects.toThrow("unsafe OAuth address");
    }
  });

  test("isPrivateAddress covers IPv4 and IPv6 with IPv4 inside", () => {
    for (const ip of [
      "::ffff:0:7f00:1",
      "::ffff:0:808:808",
      "10.1.1.1",
      "100.64.0.1",
      "198.18.0.1",
      "192.0.0.8",
      "::ffff:10.0.0.1",
      "::ffff:a00:1",
      "64:ff9b::a00:1",
      "2001::1",
      "ff02::1",
      "fd00::1",
      "::",
      "zz::1",
    ])
      expect([ip, isPrivateAddress(ip)]).toEqual([ip, true]);
    for (const ip of [
      "93.184.216.34",
      "2606:2800:220:1:248:1893:25c8:1946",
      "::ffff:5db8:d822",
      "64:ff9b::5db8:d822",
    ])
      expect([ip, isPrivateAddress(ip)]).toEqual([ip, false]);
  });
});

// The origin runs this through the custom connector route (a later slice); here it calls the function that
// route calls, with a real workspace and member.
describe("an MCP connector on the cloud edition", () => {
  const { fetch: external, seen } = fakeFetch({
    "https://93.184.216.34/mcp": () =>
      new Response("{}", {
        status: 401,
        headers: {
          "www-authenticate": 'Bearer resource_metadata="http://169.254.169.254/latest/meta-data/iam"',
        },
      }),
    "https://93.184.216.34/.well-known/oauth-authorization-server": () =>
      Response.json({
        authorization_endpoint: "https://93.184.216.34/authorize",
        token_endpoint: "http://10.0.0.5/token",
        registration_endpoint: "http://10.0.0.5/admin/register",
      }),
  });
  let server: RunningServer;
  beforeAll(async () => {
    server = await startTestServer({
      env: { EDITION: "cloud" },
      fetchExternal: external,
    });
  }, SERVER_TEST_MS);
  afterAll(() => server.stop(), SERVER_TEST_MS);

  test(
    "the OAuth discovery and registration don't go to the internal network; without OAuth, it asks for a key",
    async () => {
      const eve = await signedIn(server, "Eve", "eve@net.test");
      const { workspaceId } = await seedWorkspace(server, eve, "Eve Workspace");
      const me = { workspaceId, userId: eve.user.id, role: "owner" as const, handle: "eve", sessionId: "s" };
      const start = await connectCustom(server.deps, me, {
        serverUrl: "https://93.184.216.34/mcp",
        nextPath: "/",
      });
      // No OAuth possible (the internal addresses were rejected): the connector asks for a key.
      expect(start).toMatchObject({ status: "key_missing" });
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.filter((s) => !s.url.startsWith("https://93.184.216.34/"))).toEqual([]);
    },
    SERVER_TEST_MS,
  );
});
