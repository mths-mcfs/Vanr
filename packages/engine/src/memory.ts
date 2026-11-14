// Agent memory: memory tool paths, limits and when a write goes to the review queue. Pure: no database
// dependency; the server keeps the items in Postgres.
//
// The tree the model sees lives under /memories, with three stores:
//   /memories/agent/…      the agent's (read and write)
//   /memories/you/…        the person who started the run (read and write; only they see it on screen)
//   /memories/workspace/…  the workspace's (read only; changes by proposal or by an admin)
import type { MemoryScope } from "@vanr/contract";
import type { RiskTracker, RunRisk } from "./effects";

export const MEMORY_ROOT = "/memories";
const STORE_DIRS = { agent: "agent", person: "you", workspace: "workspace" } as const satisfies Record<
  MemoryScope,
  string
>;

/** Maximum size of an item (like the memory stores: 100 kB). */
export const MEMORY_ITEM_MAX_BYTES = 100_000;
/** Items per store. */
export const MEMORY_STORE_MAX_ITEMS = 10_000;
export const MEMORY_PATH_MAX = 300;
const SEGMENT_MAX = 100;
const DEPTH_MAX = 8;
/** Letters, digits, space, dot, hyphen, underscore, parentheses and `@`. No `/` inside a segment. */
const SEGMENT = /^[\p{L}\p{N}][\p{L}\p{N} ._()@-]*$/u;

export type MemoryPath =
  /** `/memories` (`view` only). */
  | { kind: "root" }
  /** A store's folder or a folder inside it (empty `path` = the store's root). */
  | { kind: "store"; scope: MemoryScope; path: string };

export class MemoryPathError extends Error {}

/**
 * Reads a memory tool path. Rejects anything that is not `/memories/<store>/<segments>` with simple
 * segments: `..`, `.`, double slashes, backslash, `%`, control bytes, a relative path, another root. It is
 * the path traversal defense the memory tool docs ask for.
 */
export function parseMemoryPath(raw: string): MemoryPath {
  if (typeof raw !== "string" || raw.length === 0) throw new MemoryPathError("The path is empty");
  if (raw.length > MEMORY_PATH_MAX) throw new MemoryPathError("The path is too long");
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control bytes is the point
  if (/[\u0000-\u001f\u007f\\%]/.test(raw)) throw new MemoryPathError(`Invalid path ${raw}`);
  const trimmed = raw.length > 1 && raw.endsWith("/") ? raw.slice(0, -1) : raw;
  if (trimmed === MEMORY_ROOT) return { kind: "root" };
  if (!trimmed.startsWith(`${MEMORY_ROOT}/`))
    throw new MemoryPathError(`The path ${raw} must be inside ${MEMORY_ROOT}`);
  const parts = trimmed.slice(MEMORY_ROOT.length + 1).split("/");
  const [dir, ...rest] = parts;
  const scope = (Object.keys(STORE_DIRS) as MemoryScope[]).find((s) => STORE_DIRS[s] === dir);
  if (!scope)
    throw new MemoryPathError(
      `The path ${raw} must start with ${MEMORY_ROOT}/agent, ${MEMORY_ROOT}/you or ${MEMORY_ROOT}/workspace`,
    );
  if (rest.length > DEPTH_MAX) throw new MemoryPathError("The path is too deep");
  for (const seg of rest) {
    if (seg === "" || seg === "." || seg === ".." || seg.length > SEGMENT_MAX || !SEGMENT.test(seg))
      throw new MemoryPathError(`Invalid path ${raw}`);
  }
  return { kind: "store", scope, path: rest.join("/") };
}

/** Path the model sees for a store item. */
export const virtualPath = (scope: MemoryScope, path: string) =>
  path ? `${MEMORY_ROOT}/${STORE_DIRS[scope]}/${path}` : `${MEMORY_ROOT}/${STORE_DIRS[scope]}`;

/** Short note from `remember` (no file): shows in the tree as `remembered/<id>.md`. */
export const rememberedPath = (id: string) => `remembered/${id}.md`;

/** Is the item inside the folder (empty `dir` = the whole store)? */
export const isUnder = (path: string, dir: string) =>
  dir === "" || path === dir || path.startsWith(`${dir}/`);

export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** SHA-256 (hex) of the text: precondition against concurrent writes (like the stores' `content_sha256`). */
export function contentSha256(text: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(text);
  return hasher.digest("hex");
}

/**
 * A memory write by a run with flag A (it read an email, page, connector or outside message) is not valid on
 * its own: it goes to the review queue. Memory is what the next sessions read as trusted, and the attack
 * (MemGhost, Jul 2026) is exactly an email that makes the agent store a lie.
 */
export function memoryWriteNeedsReview(risk: RunRisk): boolean {
  return risk.flags.has("A");
}

/** The sources that raised A, for the item's origin and the queue card. */
export function untrustedSources(risk: RiskTracker | RunRisk): string[] {
  return risk.reasons.filter((r) => r.flag === "A").map((r) => r.source);
}

/** Numbered lines as the memory tool shows them (`view`): a 6-column number, a tab, the line. */
export function numberLines(text: string, range?: readonly [number, number]): string {
  const lines = text.split("\n");
  const start = range ? Math.max(1, range[0]) : 1;
  const end = range && range[1] !== -1 ? Math.min(lines.length, range[1]) : lines.length;
  const out: string[] = [];
  for (let i = start; i <= end; i++) out.push(`${String(i).padStart(6, " ")}\t${lines[i - 1] ?? ""}`);
  return out.join("\n");
}
