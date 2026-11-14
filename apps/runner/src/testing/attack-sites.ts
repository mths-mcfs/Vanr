// Test sites for the attacks on the agent's browser, with no internet. Everything runs on loopback:
// - the "site" answers on 127.0.0.2 (http and https, with a self-signed certificate), in a range the
//   test policy allows (`SITE_RANGE`), and picks the page by the requested name (Host header);
// - the "victim" sits on 127.0.0.1 on the SAME port as the site's http and counts every hit: it is the
//   internal service the attack wants to reach. In the tests it must end with zero hits;
// - the fake resolver points the test names at those addresses (the runner's proxy uses it).
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const SITE_IP = "127.0.0.2";
export const SITE_RANGE = "127.0.0.2/32";

type Handler = (req: Request, url: URL) => Response | Promise<Response>;

export interface AttackSites {
  /** http port of the site (and of the victim). */
  port: number;
  /** https port of the site. */
  tlsPort: number;
  http(host: string, path?: string): string;
  https(host: string, path?: string): string;
  /** Page of a name (`host`) at the path `path`. */
  page(host: string, path: string, handler: Handler): void;
  /** Every request the site got: `host/path`. */
  hits: string[];
  /** Every request the victim on 127.0.0.1 got. */
  victimHits: string[];
  /** Name → IPs; what is not here does not resolve. It may change the answer on each call. */
  dns: Map<string, string[] | (() => string[])>;
  resolve(host: string): Promise<string[]>;
  stop(): void;
}

const html = (body: string) =>
  new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });

function selfSigned(): { cert: string; key: string } {
  const dir = mkdtempSync(join(tmpdir(), "attack-tls-"));
  try {
    const r = spawnSync("openssl", [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=attack.test",
      "-keyout",
      join(dir, "key.pem"),
      "-out",
      join(dir, "cert.pem"),
    ]);
    if (r.status !== 0) throw new Error(`openssl failed: ${r.stderr}`);
    return {
      cert: readFileSync(join(dir, "cert.pem"), "utf8"),
      key: readFileSync(join(dir, "key.pem"), "utf8"),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function startAttackSites(): AttackSites {
  const routes = new Map<string, Handler>();
  const hits: string[] = [];
  const victimHits: string[] = [];
  const serve: Handler = (req, url) => {
    const host = (req.headers.get("host") ?? "").replace(/:\d+$/, "");
    hits.push(`${host}${url.pathname}`);
    const h = routes.get(`${host}${url.pathname}`);
    return h ? h(req, url) : html(`<title>${host}</title><p>${host}${url.pathname}</p>`);
  };
  const site = Bun.serve({ hostname: SITE_IP, port: 0, fetch: (req) => serve(req, new URL(req.url)) });
  const port = site.port as number;
  const tls = Bun.serve({
    hostname: SITE_IP,
    port: 0,
    tls: selfSigned(),
    fetch: (req) => serve(req, new URL(req.url)),
  });
  const victim = Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch(req, srv) {
      victimHits.push(new URL(req.url).pathname);
      if (srv.upgrade(req)) return undefined;
      return new Response("internal secret");
    },
    websocket: { message() {} },
  });
  const dns = new Map<string, string[] | (() => string[])>();
  return {
    port,
    tlsPort: tls.port as number,
    http: (host, path = "/") => `http://${host}:${port}${path}`,
    https: (host, path = "/") => `https://${host}:${tls.port}${path}`,
    page: (host, path, handler) => routes.set(`${host}${path}`, handler),
    hits,
    victimHits,
    dns,
    async resolve(host) {
      const v = dns.get(host);
      return typeof v === "function" ? v() : (v ?? []);
    },
    stop() {
      site.stop(true);
      tls.stop(true);
      victim.stop(true);
    },
  };
}

export { html };
