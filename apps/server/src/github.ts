// Reading GitHub repositories: agent instructions and skill folders.
// Only github.com is accepted (no arbitrary URL: keeps the server from fetching an internal address), and every
// request goes through the fetch injected in the deps (the network guard of integrations/net.ts; the tests replace
// it with a fake one). A private repository is read with the token of the workspace's own GitHub App installation,
// which the caller passes explicitly; without one the repository is read as public.
import { parseSkillMd, validateSkillFrontmatter } from "@vanr/engine/skill-md";
import { z } from "zod";
import { badRequest, HttpError } from "./http";

/** Largest file read, in bytes: past it the read stops before keeping more. */
export const MAX_FILE = 100_000;
/** Most files a skill folder may have next to its SKILL.md. */
export const MAX_FILES = 30;
/** Largest folder listing the API may answer, in bytes. */
const MAX_LISTING = 1_000_000;

export interface RepoRef {
  owner: string;
  repo: string;
  /** Branch, tag or commit; null uses the repository's default. */
  ref: string | null;
  /** Folder or file inside the repository, without a leading slash. */
  path: string;
  kind: "tree" | "blob";
}

const NAME = /^[A-Za-z0-9_.-]{1,100}$/;

/** https://github.com/owner/repo[/tree|blob/ref/path]. Anything else is 400. */
export function parseGithubUrl(raw: string): RepoRef {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw badRequest("Use a github.com URL", { field: "url" });
  }
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.username || url.port) {
    throw badRequest("Use a github.com URL", { field: "url" });
  }
  const parts = url.pathname.split("/").filter(Boolean);
  const [owner, repoRaw, kind, ref, ...rest] = parts;
  const repo = repoRaw?.replace(/\.git$/, "");
  if (!owner || !repo || !NAME.test(owner) || !NAME.test(repo)) {
    throw badRequest("Use a github.com/owner/repo URL", { field: "url" });
  }
  if (kind === undefined) return { owner, repo, ref: null, path: "", kind: "tree" };
  if ((kind !== "tree" && kind !== "blob") || !ref)
    throw badRequest("Unsupported GitHub URL", { field: "url" });
  const path = rest.join("/");
  if (path.split("/").some((seg) => seg === ".." || seg === "."))
    throw badRequest("Invalid path", { field: "url" });
  return { owner, repo, ref, path, kind };
}

const enc = (s: string) => s.split("/").map(encodeURIComponent).join("/");

function rawUrl(r: RepoRef, path: string): string {
  return `https://raw.githubusercontent.com/${enc(r.owner)}/${enc(r.repo)}/${enc(r.ref ?? "HEAD")}/${enc(path)}`;
}

type Read = { kind: "ok"; text: string } | { kind: "missing" } | { kind: "too_large" };

/**
 * Reads the body up to `max` bytes. Past it the read stops (the stream is cancelled) before anything more is
 * kept, so an answer of any size never sits in memory whole.
 */
async function capped(res: Response, max: number): Promise<Read> {
  if (!res.body) return { kind: "ok", text: "" };
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return { kind: "too_large" };
    }
    parts.push(value);
  }
  return { kind: "ok", text: new TextDecoder().decode(Buffer.concat(parts)) };
}

async function fetchText(
  fetcher: typeof fetch,
  url: string,
  token: string | null,
  max = MAX_FILE,
): Promise<Read> {
  let res: Response;
  try {
    res = await fetcher(url, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new HttpError(502, "github.unreachable", "Could not reach GitHub");
  }
  if (res.status === 404) {
    await res.body?.cancel().catch(() => undefined);
    return { kind: "missing" };
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw new HttpError(502, "github.failed", `GitHub answered ${res.status}`);
  }
  return capped(res, max);
}

const INSTRUCTION_FILES = [
  "AGENTS.md",
  "CLAUDE.md",
  ".github/copilot-instructions.md",
  ".cursorrules",
  "README.md",
];

/** Instruction files of a repository (the ones that exist; one past MAX_FILE is left out). */
export async function importInstructions(fetcher: typeof fetch, url: string, token: string | null) {
  const ref = parseGithubUrl(url);
  const base = ref.kind === "blob" ? null : ref.path;
  const candidates = base === null ? [ref.path] : INSTRUCTION_FILES.map((f) => (base ? `${base}/${f}` : f));
  const files: { path: string; text: string }[] = [];
  for (const path of candidates) {
    const read = await fetchText(fetcher, rawUrl(ref, path), token);
    if (read.kind === "ok") files.push({ path, text: read.text });
  }
  return files;
}

const Listing = z.array(
  z.object({
    name: z.string(),
    path: z.string(),
    type: z.string(),
    size: z.number(),
  }),
);

const TEXT_EXT = /\.(md|txt|json|ya?ml|toml|py|js|ts|sh|sql|csv|html|css)$/i;
const mimeOf = (path: string) =>
  path.endsWith(".md")
    ? "text/markdown"
    : path.endsWith(".json")
      ? "application/json"
      : TEXT_EXT.test(path)
        ? "text/plain"
        : "application/octet-stream";

export interface ImportedSkill {
  name: string;
  description: string;
  body: string;
  files: { path: string; status: "ok" | "skipped"; mime: string; text?: string }[];
}

/** Reads the simple frontmatter (name, description) of a SKILL.md. */
function parseSkillMarkdown(text: string, fallbackName: string): Omit<ImportedSkill, "files"> {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  const head = m?.[1] ?? "";
  const body = (m ? m[2] : text) ?? "";
  const field = (key: string) =>
    new RegExp(`^${key}:\\s*(.+)$`, "m")
      .exec(head)?.[1]
      ?.trim()
      .replace(/^["']|["']$/g, "");
  return {
    name: (field("name") ?? fallbackName).slice(0, 120),
    description: (field("description") ?? "").slice(0, 1000),
    body: body.trim(),
  };
}

const tooLarge = (path: string) =>
  new HttpError(400, "skill.too_large", `${path} is larger than ${MAX_FILE} bytes`, { path, max: MAX_FILE });
const tooManyFiles = () =>
  new HttpError(400, "skill.too_many_files", `A skill folder has at most ${MAX_FILES} files`, {
    max: MAX_FILES,
  });

/**
 * A skill folder on GitHub: the SKILL.md and the text files next to it, read with `token` (the workspace's own
 * installation; null reads it as public). Everything is read before anything is saved: a file past MAX_FILE or a
 * folder with more than MAX_FILES files rejects the whole import. What comes back is the repository's data.
 */
export async function importSkill(
  fetcher: typeof fetch,
  ref: RepoRef,
  token: string | null,
): Promise<ImportedSkill> {
  const dir = ref.kind === "blob" ? ref.path.split("/").slice(0, -1).join("/") : ref.path;
  const skillPath = dir ? `${dir}/SKILL.md` : "SKILL.md";
  const read = await fetchText(fetcher, rawUrl(ref, skillPath), token);
  if (read.kind === "missing") throw new HttpError(404, "skill.not_found", "No SKILL.md at that address");
  if (read.kind === "too_large") throw tooLarge(skillPath);
  const md = read.text;
  // The SKILL.md must pass the standard's validator (Agent Skills), with the name equal to the folder's.
  const dirName = dir.split("/").at(-1) || undefined;
  const strict = parseSkillMd(md);
  const problems = strict.ok ? validateSkillFrontmatter(strict.frontmatter, dirName) : strict.problems;
  if (problems.length)
    throw new HttpError(400, "skill.invalid", `Invalid SKILL.md: ${problems.join("; ")}`, { problems });
  const parsed = parseSkillMarkdown(md, dirName || ref.repo);

  const api = `https://api.github.com/repos/${enc(ref.owner)}/${enc(ref.repo)}/contents/${enc(dir)}${
    ref.ref ? `?ref=${encodeURIComponent(ref.ref)}` : ""
  }`;
  const listing = await fetchText(fetcher, api, token, MAX_LISTING);
  if (listing.kind === "too_large") throw tooManyFiles();
  let entries: z.infer<typeof Listing> = [];
  if (listing.kind === "ok") {
    try {
      const data = Listing.safeParse(JSON.parse(listing.text));
      if (data.success) entries = data.data;
    } catch {
      entries = [];
    }
  }
  const others = entries.filter((x) => x.type === "file" && x.name !== "SKILL.md");
  if (others.length > MAX_FILES) throw tooManyFiles();
  const files: ImportedSkill["files"] = [];
  for (const e of others) {
    const rel = dir ? e.path.slice(dir.length + 1) : e.path;
    const mime = mimeOf(e.path);
    if (!TEXT_EXT.test(e.path)) {
      files.push({ path: rel, status: "skipped", mime });
      continue;
    }
    if (e.size > MAX_FILE) throw tooLarge(rel);
    const text = await fetchText(fetcher, rawUrl(ref, e.path), token);
    if (text.kind === "too_large") throw tooLarge(rel);
    files.push(
      text.kind === "missing"
        ? { path: rel, status: "skipped", mime }
        : { path: rel, status: "ok", mime, text: text.text },
    );
  }
  return { ...parsed, files };
}
