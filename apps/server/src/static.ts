import { stat } from "node:fs/promises";
import { isAbsolute, join, normalize, relative } from "node:path";

/**
 * SPA fallback: files under /assets cached for 4 h (the name has a hash), any other path
 * that is not /api gets index.html.
 */
export function createStatic(distDir: string) {
  const root = normalize(distDir);
  const exists = async (path: string) => {
    try {
      return (await stat(path)).isFile();
    } catch {
      return false;
    }
  };
  /** The requested file, only when it is inside the build ("dist-x" does not count as "dist"). */
  const inside = (pathname: string) => {
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return null; // A malformed "%" is not a file: it falls back to index.html, not to a 500.
    }
    const target = normalize(join(root, decoded));
    const rel = relative(root, target);
    return rel && !rel.startsWith("..") && !isAbsolute(rel) ? target : null;
  };
  return async (pathname: string): Promise<Response> => {
    const target = inside(pathname);
    if (target && (await exists(target))) {
      // The service worker has to arrive fresh on every visit (the browser decides whether to swap it).
      const cache = pathname.startsWith("/assets/")
        ? "public, max-age=14400"
        : pathname === "/sw.js"
          ? "no-cache"
          : "public, max-age=300";
      const headers: Record<string, string> = { "cache-control": cache };
      if (pathname.endsWith(".webmanifest")) headers["content-type"] = "application/manifest+json";
      return new Response(Bun.file(target), { headers });
    }
    const index = join(root, "index.html");
    if (!(await exists(index))) {
      return new Response("web build not found", { status: 404, headers: { "content-type": "text/plain" } });
    }
    return new Response(Bun.file(index), {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" },
    });
  };
}
