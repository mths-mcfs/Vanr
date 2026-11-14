// An Obsidian vault as a zip: import (notes, attachments, alternate titles, #tags and front matter as
// properties) and export (the pages as .md with front matter and the imported attachments). The zip comes
// from outside: the limits count what comes out of the decompressor, not the size the header declares (zip
// bomb), and a path with `..`, absolute or with a drive letter is rejected (zip slip).
import type { ActorRef, WikiAttachment, WikiVaultImportResult } from "@vanr/contract";
import { schema } from "@vanr/engine/db";
import { formatFrontmatter, splitFrontmatter, vaultMeta } from "@vanr/engine/wiki/frontmatter";
import { bodyTags } from "@vanr/engine/wiki/links";
import { frontmatterToProps, propsToFrontmatter } from "@vanr/engine/wiki/props-vault";
import { and, eq, isNull } from "drizzle-orm";
import { Unzip, UnzipInflate, zipSync } from "fflate";
import type { AppDeps } from "./context";
import { createFile, MAX_UPLOAD_BYTES } from "./drive";
import { HttpError } from "./http";
import { log } from "./logger";
import { allPages, createPage, MAX_BODY, normalizeFolder, propSchemaOf, TITLE_BREAKS_LINK } from "./wiki";

const { wikiAttachments, fileVersions, files } = schema;

export const VAULT_LIMITS = {
  /** Files in the zip (folders don't count). */
  entries: 2000,
  /** Sum of what comes out of the decompressor. */
  totalBytes: 100 * 1024 * 1024,
  /** One note: the body is capped at 500 thousand characters (up to 4 bytes each in UTF-8). */
  noteBytes: 2 * 1024 * 1024,
  attachmentBytes: MAX_UPLOAD_BYTES,
  attachments: 500,
};

const CHUNK = 16 * 1024;
const SKIP = /(^|\/)(\.obsidian|\.trash|\.git|__MACOSX)(\/|$)|(^|\/)\.[^/]*$/;

export interface VaultEntry {
  path: string;
  bytes: Uint8Array;
}

/** A path in the zip → a safe path, or null (absolute, drive letter, `..`). */
export function safeVaultPath(name: string): string | null {
  const p = name.replace(/\\/g, "/");
  if (p.startsWith("/") || /^[a-zA-Z]:/.test(p) || p.includes("\0")) return null;
  const parts = p.split("/").filter((s) => s && s !== ".");
  if (parts.some((s) => s === "..")) return null;
  return parts.join("/") || null;
}

/** Every zip ends with the end-of-central-directory record (up to 64 KB of comment after it). */
function hasZipEnd(zip: Uint8Array): boolean {
  for (let i = zip.byteLength - 22; i >= Math.max(0, zip.byteLength - 22 - 0xffff); i--)
    if (zip[i] === 0x50 && zip[i + 1] === 0x4b && zip[i + 2] === 0x05 && zip[i + 3] === 0x06) return true;
  return false;
}

/**
 * Unpacks counting real bytes: the zip goes in in 16 KB slices, so the decompressor never lets out more than
 * ~16 MB at once, and the file that passes the limit is cut.
 */
export function unzipVault(zip: Uint8Array): {
  entries: VaultEntry[];
  failed: { path: string; error: string }[];
} {
  if (!hasZipEnd(zip)) throw new HttpError(400, "wiki.import.invalid_zip", "This is not a valid zip file");
  const entries: VaultEntry[] = [];
  const failed: { path: string; error: string }[] = [];
  let count = 0;
  let total = 0;
  let fatal: HttpError | null = null;
  const uz = new Unzip((file) => {
    if (fatal || file.name.endsWith("/")) return;
    if (++count > VAULT_LIMITS.entries) {
      fatal = new HttpError(413, "wiki.import.too_many_files", "The vault has too many files", {
        max: VAULT_LIMITS.entries,
      });
      return;
    }
    const path = safeVaultPath(file.name);
    if (!path) {
      failed.push({ path: file.name.slice(0, 300), error: "wiki.import.unsafe_path" });
      return;
    }
    if (SKIP.test(path)) return;
    const max = /\.md$/i.test(path) ? VAULT_LIMITS.noteBytes : VAULT_LIMITS.attachmentBytes;
    if ((file.originalSize ?? 0) > max) {
      failed.push({ path, error: "wiki.import.too_large" });
      return;
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    let done = false;
    file.ondata = (err, chunk, final) => {
      if (done) return;
      if (err) {
        done = true;
        failed.push({ path, error: "wiki.import.invalid_zip" });
        return;
      }
      size += chunk.byteLength;
      total += chunk.byteLength;
      if (total > VAULT_LIMITS.totalBytes) {
        done = true;
        fatal = new HttpError(413, "wiki.import.too_large", "The vault is too large once unpacked", {
          maxBytes: VAULT_LIMITS.totalBytes,
        });
        return;
      }
      if (size > max) {
        // The header lied about the size (or didn't say it): cut here.
        done = true;
        file.terminate();
        failed.push({ path, error: "wiki.import.too_large" });
        return;
      }
      chunks.push(chunk);
      if (final) {
        done = true;
        const bytes = new Uint8Array(size);
        let at = 0;
        for (const c of chunks) {
          bytes.set(c, at);
          at += c.byteLength;
        }
        entries.push({ path, bytes });
      }
    };
    file.start();
  });
  uz.register(UnzipInflate);
  try {
    for (let i = 0; i < zip.byteLength && !fatal; i += CHUNK)
      uz.push(zip.subarray(i, i + CHUNK), i + CHUNK >= zip.byteLength);
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, "wiki.import.invalid_zip", "This is not a valid zip file");
  }
  if (fatal) throw fatal;
  // A vault zipped with its outer folder: the folder goes away.
  const tops = new Set(
    [...entries, ...failed].map((e) => (e.path.includes("/") ? e.path.split("/")[0] : "")),
  );
  if (tops.size === 1 && !tops.has("")) {
    const top = `${[...tops][0]}/`;
    for (const e of entries) e.path = e.path.slice(top.length);
  }
  return { entries, failed };
}

const CONTENT_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  mp4: "video/mp4",
  webm: "video/webm",
  txt: "text/plain",
  csv: "text/csv",
  json: "application/json",
  canvas: "application/json",
};
const contentTypeOf = (path: string) =>
  CONTENT_TYPES[path.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";

/** Imports notes and attachments. A page with the same title in the same folder stays as it is (skipped). */
export async function importVault(
  deps: AppDeps,
  input: {
    workspaceId: string;
    author: ActorRef;
    files: VaultEntry[];
    folder?: string;
    failed?: { path: string; error: string }[];
  },
): Promise<WikiVaultImportResult> {
  const result: WikiVaultImportResult = {
    created: 0,
    skipped: 0,
    attachments: 0,
    propsCreated: [],
    failed: [...(input.failed ?? [])],
  };
  const existing = await allPages(deps.db, input.workspaceId);
  const key = (f: string, t: string) => `${f}\u0000${t.toLowerCase()}`;
  const taken = new Set(existing.map((p) => key(p.folder, p.title)));
  let { defs, version } = await propSchemaOf(deps.db, input.workspaceId);
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const notes = input.files.filter((f) => /\.md$/i.test(f.path));
  const others = input.files.filter((f) => !/\.md$/i.test(f.path));

  for (const file of notes) {
    const parts = file.path.split("/").filter(Boolean);
    const base = (parts.pop() ?? "").replace(/\.md$/i, "").trim();
    const text = decoder.decode(file.bytes).replace(/^﻿/, "");
    const fm = splitFrontmatter(text);
    const meta = vaultMeta(fm.data);
    const title = (meta.title ?? base)
      .replace(new RegExp(TITLE_BREAKS_LINK.source, "g"), "")
      .trim()
      .slice(0, 200);
    const folder = normalizeFolder([input.folder ?? "", ...parts].join("/"));
    if (!title) {
      result.failed.push({ path: file.path, error: "wiki.import.no_title" });
      continue;
    }
    if (fm.body.length > MAX_BODY) {
      result.failed.push({ path: file.path, error: "wiki.import.too_large" });
      continue;
    }
    if (taken.has(key(folder, title))) {
      result.skipped++;
      continue;
    }
    const props = frontmatterToProps(defs, meta.rest);
    await createPage(deps, {
      workspaceId: input.workspaceId,
      title,
      folder,
      body: fm.body,
      tags: [...meta.tags, ...bodyTags(fm.body)],
      aliases: meta.aliases,
      props: props.write,
      author: input.author,
      sourceType: "obsidian",
      note: "import",
      propSchema: { defs: props.defs, version },
    });
    defs = props.defs;
    version++;
    for (const name of props.created) if (!result.propsCreated.includes(name)) result.propsCreated.push(name);
    taken.add(key(folder, title));
    result.created++;
  }

  const liveAttachments = new Set(
    (await attachmentsOf(deps, input.workspaceId)).map((a) => a.path.toLowerCase()),
  );
  for (const file of others) {
    if (result.attachments >= VAULT_LIMITS.attachments) {
      result.failed.push({ path: file.path, error: "wiki.import.too_many_attachments" });
      continue;
    }
    const name = file.path.split("/").pop() ?? file.path;
    const path = normalizeFolder([input.folder ?? "", file.path].join("/"));
    // An attachment already at the same path stays as it is, like the notes: importing the same vault again
    // doesn't duplicate a file in the Drive.
    if (liveAttachments.has(path.toLowerCase())) {
      result.skipped++;
      continue;
    }
    const { row } = await createFile(deps, {
      workspaceId: input.workspaceId,
      title: name.slice(0, 200),
      author: input.author,
      note: "wiki import",
      file: { bytes: file.bytes, fileName: name.slice(0, 255), contentType: contentTypeOf(name) },
    });
    await deps.db
      .insert(wikiAttachments)
      .values({
        workspaceId: input.workspaceId,
        path,
        pathKey: path.toLowerCase(),
        fileId: row.id,
        createdAt: deps.now(),
      })
      .onConflictDoUpdate({
        target: [wikiAttachments.workspaceId, wikiAttachments.pathKey],
        set: { path, fileId: row.id, createdAt: deps.now() },
      });
    liveAttachments.add(path.toLowerCase());
    result.attachments++;
  }
  return result;
}

/** Imported attachments (path in the vault → file), for the editor to resolve ![[file]]. */
export async function attachmentsOf(deps: AppDeps, workspaceId: string): Promise<WikiAttachment[]> {
  return deps.db
    .select({
      path: wikiAttachments.path,
      fileId: wikiAttachments.fileId,
      contentType: fileVersions.contentType,
    })
    .from(wikiAttachments)
    .innerJoin(files, eq(files.id, wikiAttachments.fileId))
    .innerJoin(fileVersions, and(eq(fileVersions.fileId, files.id), eq(fileVersions.version, files.version)))
    .where(and(eq(wikiAttachments.workspaceId, workspaceId), isNull(files.deletedAt)))
    .orderBy(wikiAttachments.path);
}

const fileSafe = (s: string) =>
  [...s]
    .map((ch) => (ch.charCodeAt(0) < 32 || '\\/:*?"<>|'.includes(ch) ? "-" : ch))
    .join("")
    .trim() || "page";

/** The whole vault as a zip: one note per page (front matter with tags, alternate titles and properties). */
export async function exportVault(deps: AppDeps, workspaceId: string): Promise<Uint8Array> {
  const pages = await allPages(deps.db, workspaceId);
  const { defs } = await propSchemaOf(deps.db, workspaceId);
  const out: Record<string, Uint8Array> = {};
  const enc = new TextEncoder();
  const used = new Set<string>();
  for (const p of pages) {
    const dir = `wiki/${p.folder ? `${p.folder.split("/").map(fileSafe).join("/")}/` : ""}`;
    let path = `${dir}${fileSafe(p.title)}.md`;
    for (let i = 2; used.has(path.toLowerCase()); i++) path = `${dir}${fileSafe(p.title)} (${i}).md`;
    used.add(path.toLowerCase());
    const data = {
      ...(p.aliases.length ? { aliases: p.aliases } : {}),
      ...(p.tags.length ? { tags: p.tags } : {}),
      ...Object.fromEntries(
        Object.entries(propsToFrontmatter(defs, p.props)).filter(([key]) => key.toLowerCase() !== "title"),
      ),
      title: p.title,
    };
    // A body that starts with a divider (`---`) would be read as front matter on the way back: it gets an
    // empty block in front so it stays body.
    const head = formatFrontmatter(data) || (splitFrontmatter(p.body).body !== p.body ? "---\n---\n" : "");
    out[path] = enc.encode(`${head}${p.body}`);
  }
  for (const a of await attachmentsOf(deps, workspaceId)) {
    const path = `wiki/${a.path.split("/").map(fileSafe).join("/")}`;
    if (used.has(path.toLowerCase())) continue;
    const [v] = await deps.db
      .select({ blobKey: fileVersions.blobKey })
      .from(fileVersions)
      .innerJoin(files, eq(files.id, fileVersions.fileId))
      .where(and(eq(fileVersions.fileId, a.fileId), eq(fileVersions.version, files.version)));
    const blob = v?.blobKey ? await deps.blobs.get(v.blobKey).catch(() => null) : null;
    if (!blob) {
      log.warn("wiki.export_attachment_missing", { fileId: a.fileId });
      continue;
    }
    used.add(path.toLowerCase());
    out[path] = blob.bytes;
  }
  return zipSync(out, { level: 6 });
}
