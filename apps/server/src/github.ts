// Reading public GitHub repositories: agent instructions and skill folders.
// Only github.com is accepted (no arbitrary URL: keeps the server from fetching an internal address), and it
// uses the fetch injected in the deps, which the tests replace with a fake one.
import { parseSkillMd, validateSkillFrontmatter } from "@vanr/engine/skill-md";
import { z } from "zod";
import { badRequest, HttpError } from "./http";

const MAX_FILE = 100_000;
const MAX_FILES = 30;

interface RepoRef {
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
function parseGithubUrl(raw: string): RepoRef {
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

async function fetchText(fetcher: typeof fetch, url: string): Promise<string | null> {
  let res: Response;
  try {
    res = await fetcher(url, { redirect: "follow", signal: AbortSignal.timeout(15_000) });
  } catch {
    throw new HttpError(502, "github.unreachable", "Could not reach GitHub");
  }
  if (res.status === 404) return null;
  if (!res.ok) throw new HttpError(502, "github.failed", `GitHub answered ${res.status}`);
  const text = await res.text();
  return text.length > MAX_FILE ? null : text;
}

const INSTRUCTION_FILES = [
  "AGENTS.md",
  "CLAUDE.md",
  ".github/copilot-instructions.md",
  ".cursorrules",
  "README.md",
];

/** Instruction files of a repository (the ones that exist). */
export async function importInstructions(fetcher: typeof fetch, url: string) {
  const ref = parseGithubUrl(url);
  const base = ref.kind === "blob" ? null : ref.path;
  const candidates = base === null ? [ref.path] : INSTRUCTION_FILES.map((f) => (base ? `${base}/${f}` : f));
  const files: { path: string; text: string }[] = [];
  for (const path of candidates) {
    const text = await fetchText(fetcher, rawUrl(ref, path));
    if (text !== null) files.push({ path, text });
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

interface ImportedSkill {
  name: string;
  description: string;
  body: string;
  files: { path: string; status: "ok" | "skipped"; mime: string; text?: string }[];
}

/** A skill folder on GitHub: the SKILL.md and the text files next to it. */
export async function importSkill(fetcher: typeof fetch, url: string): Promise<ImportedSkill> {
  const ref = parseGithubUrl(url);
  const dir = ref.kind === "blob" ? ref.path.split("/").slice(0, -1).join("/") : ref.path;
  const skillPath = dir ? `${dir}/SKILL.md` : "SKILL.md";
  const md = await fetchText(fetcher, rawUrl(ref, skillPath));
  if (md === null) throw new HttpError(404, "skill.not_found", "No SKILL.md at that address");
  // The SKILL.md must pass the standard's validator (Agent Skills), with the name equal to the folder's.
  const dirName = dir.split("/").at(-1) || undefined;
  const strict = parseSkillMd(md);
  const problems = strict.ok ? validateSkillFrontmatter(strict.frontmatter, dirName) : strict.problems;
  if (!strict.ok || problems.length)
    throw new HttpError(400, "skill.invalid", `Invalid SKILL.md: ${problems.join("; ")}`, { problems });
  const { name, description } = z
    .object({ name: z.string(), description: z.string() })
    .parse(strict.frontmatter);

  const api = `https://api.github.com/repos/${enc(ref.owner)}/${enc(ref.repo)}/contents/${enc(dir)}${
    ref.ref ? `?ref=${encodeURIComponent(ref.ref)}` : ""
  }`;
  const files: ImportedSkill["files"] = [];
  const listing = await fetchText(fetcher, api);
  let entries: z.infer<typeof Listing> = [];
  if (listing !== null) {
    try {
      const data = Listing.safeParse(JSON.parse(listing));
      if (data.success) entries = data.data;
    } catch {
      entries = [];
    }
  }
  for (const e of entries.filter((x) => x.type === "file" && x.name !== "SKILL.md").slice(0, MAX_FILES)) {
    const rel = dir ? e.path.slice(dir.length + 1) : e.path;
    const mime = mimeOf(e.path);
    if (!TEXT_EXT.test(e.path) || e.size > MAX_FILE) {
      files.push({ path: rel, status: "skipped", mime });
      continue;
    }
    const text = await fetchText(fetcher, rawUrl(ref, e.path));
    files.push(
      text === null ? { path: rel, status: "skipped", mime } : { path: rel, status: "ok", mime, text },
    );
  }
  return { name, description, body: strict.body, files };
}
