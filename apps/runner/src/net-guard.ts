// Network proxy of the agent's browser. Chrome starts with `--proxy-server` pointing here and with
// `--proxy-bypass-list=<-loopback>` (without it, it skips the proxy for localhost): every connection of the
// page (navigation, redirect, fetch, WebSocket, iframe, image) goes through here with the NAME of the target,
// because with an HTTP proxy the proxy is the one that resolves DNS. Here the name is resolved, each IP is checked and
// the connection goes to the checked IP. So a DNS that answers a public IP at the check and a
// private one at the connection (DNS rebinding) does not get through: there is no second resolution.
//
// Blocks loopback, link-local (including 169.254.169.254, the cloud metadata), private network and CGNAT,
// except the ranges the owner allowed for the agent (net-address.ts). Only http (absolute form) and
// CONNECT (https and ws/wss); the rest gets 405.
import { lookup } from "node:dns/promises";
import net from "node:net";
import { type AddressKind, addressAllowed, parseIp } from "@vanr/engine/net-address";

const HEAD_MAX = 32 * 1024;
const CONNECT_TIMEOUT_MS = 15_000;

export interface NetBlock {
  host: string;
  port: number;
  /** IP behind the block (the first one outside the rule), when there was a resolution. */
  ip: string | null;
  kind: AddressKind | "unresolved";
}

export interface NetGuardOptions {
  /** Ranges allowed now (read on every connection: the policy changes while the agent runs). */
  ranges: () => readonly string[];
  /** Name resolver; the tests pass a fake one to point names at local addresses. */
  resolve?: (host: string) => Promise<string[]>;
  onBlock?: (block: NetBlock) => void;
}

export interface NetGuard {
  port: number;
  close(): void;
}

const defaultResolve = async (host: string) =>
  (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

type Target = { ok: true; ip: string } | { ok: false; block: NetBlock };

/**
 * Checks the target. Any IP outside the rule blocks the whole name (a name that points to a public IP
 * and a private one at the same time is a name to avoid); connects to the first IP of the answer.
 */
async function check(opts: NetGuardOptions, ownPort: number, host: string, port: number): Promise<Target> {
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  const name = bare.toLowerCase().replace(/\.+$/, "");
  let ips: string[];
  if (parseIp(bare)) ips = [bare];
  // `localhost` and `*.localhost` are always loopback (RFC 6761), without asking DNS.
  else if (name === "localhost" || name.endsWith(".localhost")) ips = ["127.0.0.1", "::1"];
  else {
    try {
      ips = await (opts.resolve ?? defaultResolve)(name);
    } catch {
      ips = [];
    }
    if (ips.length === 0) return { ok: false, block: { host, port, ip: null, kind: "unresolved" } };
  }
  const ranges = opts.ranges();
  for (const ip of ips) {
    const v = addressAllowed(ip, ranges);
    if (!v.ok) return { ok: false, block: { host, port, ip, kind: v.kind } };
    // The proxy itself: with loopback allowed, the page would make the proxy call itself.
    if (port === ownPort && parseIp(ip) && /^(127\.|::1$|::ffff:127\.)/.test(ip))
      return { ok: false, block: { host, port, ip, kind: "loopback" } };
  }
  return { ok: true, ip: ips[0] as string };
}

function splitHostPort(authority: string, defaultPort: number): { host: string; port: number } | null {
  const m = /^(\[[0-9a-fA-F:.%a-zA-Z]+\]|[^:[\]]+)(?::(\d{1,5}))?$/.exec(authority);
  if (!m?.[1]) return null;
  const port = m[2] ? Number(m[2]) : defaultPort;
  if (port < 1 || port > 65535) return null;
  return { host: m[1], port };
}

const blockedBody = (b: NetBlock) =>
  `Blocked by the agent's network guard: ${b.host} (${b.ip ?? "does not resolve"}) is ${
    b.kind === "unresolved" ? "not reachable" : `a ${b.kind.replace("_", "-")} address`
  }.\nThis browser cannot reach ${b.host}.\n`;

function reject(socket: net.Socket, status: string, body = "") {
  if (socket.destroyed) return;
  socket.end(
    `HTTP/1.1 ${status}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
  );
}

/** Request headers in origin form (`GET /path`), without the proxy ones, with `Connection: close`. */
function originHead(lines: string[], method: string, url: URL): string {
  const out = [`${method} ${url.pathname}${url.search} HTTP/1.1`];
  for (const l of lines.slice(1)) {
    const name = l.slice(0, l.indexOf(":")).trim().toLowerCase();
    if (["proxy-connection", "proxy-authorization", "connection", "keep-alive"].includes(name)) continue;
    out.push(l);
  }
  out.push("Connection: close");
  return `${out.join("\r\n")}\r\n\r\n`;
}

/**
 * The target's answer with `Connection: close`: Chrome does not reuse this connection to the proxy
 * for another target (each connection here leads to a single checked IP).
 */
function closeResponses(upstream: net.Socket, client: net.Socket) {
  let buf = Buffer.alloc(0);
  const onData = (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    const end = buf.indexOf("\r\n\r\n");
    if (end < 0) {
      if (buf.length > HEAD_MAX) {
        upstream.destroy();
        client.destroy();
      }
      return;
    }
    upstream.off("data", onData);
    const lines = buf.subarray(0, end).toString("latin1").split("\r\n");
    const kept = lines.filter((l, i) => {
      if (i === 0) return true;
      const name = l.slice(0, l.indexOf(":")).trim().toLowerCase();
      return name !== "connection" && name !== "keep-alive" && name !== "proxy-connection";
    });
    kept.push("Connection: close");
    client.write(Buffer.from(`${kept.join("\r\n")}\r\n\r\n`, "latin1"));
    client.write(buf.subarray(end + 4));
    upstream.pipe(client);
  };
  upstream.on("data", onData);
}

export function startNetGuard(opts: NetGuardOptions): Promise<NetGuard> {
  const sockets = new Set<net.Socket>();
  let ownPort = 0;
  const server = net.createServer((client) => {
    sockets.add(client);
    client.on("close", () => sockets.delete(client));
    client.on("error", () => {});
    let buf = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf("\r\n\r\n");
      if (end < 0) {
        if (buf.length > HEAD_MAX) reject(client, "431 Request Header Fields Too Large");
        return;
      }
      client.off("data", onData);
      client.pause();
      const head = buf.subarray(0, end).toString("latin1");
      const rest = buf.subarray(end + 4);
      void route(client, head, rest);
    };
    client.on("data", onData);
  });

  const route = async (client: net.Socket, head: string, rest: Buffer) => {
    const lines = head.split("\r\n");
    const [method = "", target = ""] = (lines[0] ?? "").split(" ");
    let host: string;
    let port: number;
    let url: URL | null = null;
    if (method === "CONNECT") {
      const hp = splitHostPort(target, 443);
      if (!hp) return reject(client, "400 Bad Request");
      ({ host, port } = hp);
    } else {
      try {
        url = new URL(target);
      } catch {
        return reject(client, "400 Bad Request");
      }
      if (url.protocol !== "http:") return reject(client, "405 Method Not Allowed");
      host = url.hostname;
      port = Number(url.port || 80);
    }
    const t = await check(opts, ownPort, host, port);
    if (!t.ok) {
      opts.onBlock?.(t.block);
      return reject(client, "403 Forbidden", blockedBody(t.block));
    }
    const upstream = net.connect({ host: t.ip, port });
    sockets.add(upstream);
    // `end`, not `destroy`: what is still in the client's buffer goes out before closing.
    upstream.on("close", () => {
      sockets.delete(upstream);
      client.end();
    });
    client.on("close", () => upstream.destroy());
    upstream.setTimeout(CONNECT_TIMEOUT_MS, () => {
      if (upstream.connecting) {
        upstream.destroy();
        reject(client, "504 Gateway Timeout");
      }
    });
    upstream.on("error", () => reject(client, "502 Bad Gateway"));
    upstream.once("connect", () => {
      upstream.setTimeout(0);
      if (method === "CONNECT") {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (rest.length) upstream.write(rest);
        client.pipe(upstream);
        upstream.pipe(client);
      } else {
        upstream.write(originHead(lines, method, url as URL));
        if (rest.length) upstream.write(rest);
        client.pipe(upstream);
        closeResponses(upstream, client);
      }
      client.resume();
    });
  };

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      ownPort = (server.address() as net.AddressInfo).port;
      resolve({
        port: ownPort,
        close() {
          server.close();
          for (const s of sockets) s.destroy();
          sockets.clear();
        },
      });
    });
  });
}
