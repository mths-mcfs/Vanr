// What the wiki's screens share: the server's limits, refetching the wiki after a write, names for
// the people and agents behind a version, [[link]] resolution with the server's own rule, version
// notes in the interface language, and how a batch of notes is cut for the import.
import { useQueryClient } from "@tanstack/react-query";
import { type KeyPrefix, prefixKey, useApiQuery, useVanrClient } from "@vanr/client/react";
import type { ActorRef, Role, WikiPageSummary } from "@vanr/contract";
import { resolveTarget } from "@vanr/engine/wiki/links";
import { useCallback, useMemo } from "react";
import { useMessages } from "../../i18n/react.tsx";
import { useSession } from "../../session/react.tsx";

/** The server's limits (routes/wiki.ts): titles and folders up to 200, a body up to 500 thousand. */
export const TITLE_MAX = 200;
export const FOLDER_MAX = 200;
export const BODY_MAX = 500_000;
export const SEARCH_MAX = 200;
/** The server keeps up to 20 tags of up to 40 characters. */
export const TAGS_MAX = 20;
export const TAG_LENGTH = 40;
/** The tree has no event of its own: it is asked again on open and about once a minute. */
export const REFRESH_MS = 60_000;

/** Every read of a workspace's wiki, to refetch after a write that may change any of them. */
const WIKI_READS = [
  "listWikiPages",
  "getWikiSearch",
  "getWikiPage",
  "getWikiPageHistory",
  "getWikiPagePanel",
  "getWikiPageDiff",
  "getWikiReads",
  "getWikiTrash",
  "listWikiProps",
  "listWikiAttachments",
] as const;

/** Refetches the wiki of a workspace: the tree, the pages, their panels and the trash. */
export function useWikiRefresh(workspaceId: string): () => Promise<void> {
  const client = useVanrClient();
  const queries = useQueryClient();
  return useCallback(async () => {
    const prefixes: KeyPrefix[] = WIKI_READS.map(
      (method) => ({ method, args: { workspaceId } }) as KeyPrefix,
    );
    await Promise.all(
      prefixes.map((prefix) => queries.invalidateQueries({ queryKey: prefixKey(client, prefix) })),
    );
  }, [client, queries, workspaceId]);
}

/** The reader's role in the workspace, for the actions only an admin is offered. */
export function useRole(workspaceId: string): { role: Role; userId: string | undefined } {
  const { me } = useSession();
  const role = me?.workspaces.find((workspace) => workspace.id === workspaceId)?.role ?? "member";
  return { role, userId: me?.user.id };
}

/** The name of whoever wrote a version: a member or an agent. */
export function useActorName(workspaceId: string): (actor: ActorRef) => string {
  const t = useMessages("wiki");
  const members = useApiQuery("listMembers", { workspaceId });
  const agents = useApiQuery("listAgents", { workspaceId });
  return useMemo(() => {
    const names = new Map<string, string>();
    for (const member of members.data ?? []) names.set(`person:${member.userId}`, member.name);
    for (const agent of agents.data ?? []) names.set(`agent:${agent.id}`, agent.name);
    return (actor: ActorRef) => names.get(`${actor.type}:${actor.id}`) ?? t("actor.unknown");
  }, [members.data, agents.data, t]);
}

/** The page a [[target]] opens, by the same rule the server uses for its link table. */
export function linkResolver(pages: readonly WikiPageSummary[]): (target: string) => string | null {
  const candidates = pages.map((page) => ({
    slug: page.slug,
    title: page.title,
    folder: page.folder,
    aliases: page.altTitles,
    restricted: page.restricted,
  }));
  return (target) => resolveTarget(target, candidates)?.slug ?? null;
}

/** A link's text without its syntax: `[[target#heading|text]]` reads as a person would read it. */
export function plainSnippet(text: string): string {
  return text.replace(
    /!?\[\[([^\]|#]*)(#[^\]|]*)?(?:\|([^\]]*))?\]\]/g,
    (_match, target: string, anchor: string | undefined, label: string | undefined) =>
      label ?? `${target}${anchor === undefined ? "" : ` › ${anchor.slice(1).replace(/^\^/, "")}`}`.trim(),
  );
}

/** "Folder/Sub/Title": the last part is the title, the rest the folder. */
export function splitPath(path: string): { folder: string; title: string } {
  const parts = path
    .split("/")
    .map((part) => part.trim())
    .filter((part) => part !== "");
  const title = parts.pop() ?? "";
  return { folder: parts.join("/"), title };
}

/** Tags written as "a, b, c", as the server keeps them, and whether they pass what it accepts. */
export function parseList(text: string): string[] {
  return text
    .split(",")
    .map((part) => part.trim().replace(/^#/, ""))
    .filter((part) => part !== "");
}

type Translate = ReturnType<typeof useMessages<"wiki">>;

/** The note the server wrote on a version, in the interface language; a person's own note as written. */
export function versionNote(note: string, t: Translate): string {
  const renamed = /^renamed from "(.*)"$/s.exec(note);
  if (renamed) return t("note.renamed", { title: renamed[1] ?? "" });
  const restored = /^(?:restored version |restore:v)(\d+)$/.exec(note);
  if (restored) return t("note.restored", { version: restored[1] ?? "" });
  const relinked = /^link: "(.*)" → "(.*)"$/s.exec(note);
  if (relinked) return t("note.relinked", { from: relinked[1] ?? "", to: relinked[2] ?? "" });
  const linked = /^link to (.+)$/.exec(note);
  if (linked) return t("note.linked", { page: linked[1] ?? "" });
  if (/^proposal \S+$/.test(note)) return t("note.proposal");
  // The live draft's publish: the button, a quiet spell, or everyone leaving; "+N" counts the co-authors.
  const live = /^(publish|idle|session)(?: \+(\d+))?$/.exec(note);
  if (live) {
    const kind = live[1] === "idle" ? "note.idle" : live[1] === "session" ? "note.session" : "note.publish";
    const text = t(kind);
    return live[2] === undefined ? text : t("note.withOthers", { text, count: Number(live[2]) });
  }
  if (note === "meta") return t("note.meta");
  if (note === "import" || note === "wiki import") return t("note.import");
  return note;
}

export type ImportFile = { path: string; text: string };

/** The import takes up to 500 files a call, each with a body plus 10 thousand of front matter. */
const IMPORT_FILES_MAX = 500;
const IMPORT_PATH_MAX = 500;
const IMPORT_FILE_MAX = BODY_MAX + 10_000;
const IMPORT_BATCH_CHARS = 20_000_000;

/**
 * Cuts the notes into calls the server accepts (up to 500 files and 20 million characters each). A
 * note past one file's limit, or with a path past 500 characters, is left out in `tooLarge` (one
 * would fail its whole batch); what is not Markdown counts in `skipped`.
 */
export function importBatches(files: readonly ImportFile[]): {
  batches: ImportFile[][];
  tooLarge: string[];
  skipped: number;
} {
  const batches: ImportFile[][] = [];
  const tooLarge: string[] = [];
  let skipped = 0;
  let current: ImportFile[] = [];
  let size = 0;
  for (const file of files) {
    if (!/\.md$/i.test(file.path)) {
      skipped += 1;
      continue;
    }
    if (file.text.length > IMPORT_FILE_MAX || file.path.length > IMPORT_PATH_MAX) {
      tooLarge.push(file.path);
      continue;
    }
    if (
      current.length === IMPORT_FILES_MAX ||
      (current.length > 0 && size + file.text.length > IMPORT_BATCH_CHARS)
    ) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(file);
    size += file.text.length;
  }
  if (current.length > 0) batches.push(current);
  return { batches, tooLarge, skipped };
}
