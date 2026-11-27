// The wiki for the fake server: pages with versions, the tree and a search by title, body and tag,
// renames, moves, pins and locks, the trash, properties, the panel of links, a line diff between two
// versions, and the import of loose Markdown notes. The live draft is the real server's alone: here a
// page has no draft, and publishing one answers with the page as it is. Never part of the production
// build.
import type * as T from "@vanr/contract";
import type { FilesHost, FilesReply } from "./fake-files.ts";

type Version = {
  version: number;
  title: string;
  body: string;
  author: T.ActorRef;
  at: string;
  note: string | null;
};
export type FakePage = {
  workspaceId: string;
  slug: string;
  title: string;
  folder: string;
  tags: string[];
  altTitles: string[];
  props: Record<string, unknown>;
  pinned: boolean;
  locked: boolean;
  versions: Version[];
  deletedAt: string | null;
  deletedBy: T.ActorRef | null;
  /** Who reads it: null is the whole workspace. A channel's readers are everyone here. */
  access?:
    | { kind: "private"; userIds: string[]; agentIds: string[] }
    | { kind: "channel"; channelId: string }
    | null;
  agentEdits?: "direct" | "propose";
  comments?: T.WikiComment[];
  proposals?: T.WikiProposal[];
};

const DAY_MS = 86_400_000;
const reply = (status: number, body: unknown): FilesReply => ({ status, body });
const fail = (status: number, code: string, message: string, params?: Record<string, unknown>) =>
  reply(status, { error: params === undefined ? { code, message } : { code, message, params } });
const notFound = () => fail(404, "not_found", "Page not found");
const text = (value: unknown) => (typeof value === "string" ? value : undefined);
const words = (value: unknown) =>
  Array.isArray(value) ? value.filter((each): each is string => typeof each === "string") : undefined;

export function slugify(title: string): string {
  return (
    title
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "page"
  );
}

export class FakeWiki {
  pages: FakePage[] = [];
  defs: { defs: T.WikiPropDef[]; version: number } = { defs: [], version: 0 };
  reads: T.WikiTopRead[] = [];

  constructor(private readonly host: FilesHost & { nameOf?: (userId: string) => string | undefined }) {}

  seed(): void {
    this.pages = [];
    this.defs = {
      version: 1,
      defs: [
        { id: "prop_owner", name: "Owner", type: "text" },
        {
          id: "prop_stage",
          name: "Stage",
          type: "select",
          options: [
            { id: "opt_draft", name: "Draft" },
            { id: "opt_live", name: "Live" },
          ],
        },
      ],
    };
    const ana: T.ActorRef = { type: "person", id: "usr_ana" };
    const scout: T.ActorRef = { type: "agent", id: "agt_scout" };
    const at = (days: number) => new Date(this.host.now().getTime() - days * DAY_MS).toISOString();
    const page = (input: Partial<FakePage> & { title: string; versions: Version[] }): FakePage => ({
      workspaceId: "workspace_birchwood",
      slug: slugify(input.title),
      folder: "",
      tags: [],
      altTitles: [],
      props: {},
      pinned: false,
      locked: false,
      deletedAt: null,
      deletedBy: null,
      ...input,
    });
    this.pages.push(
      page({
        title: "Press checklist",
        folder: "Print",
        tags: ["print", "daily"],
        pinned: true,
        props: { prop_owner: "Ana" },
        versions: [
          {
            version: 1,
            title: "Press checklist",
            body: "# Before a run\n\nClean the rollers.",
            author: ana,
            at: at(9),
            note: null,
          },
          {
            version: 2,
            title: "Press checklist",
            body: "# Before a run\n\nClean the rollers and check the [[Ink suppliers]].\n\n## After\n\nCover the press.",
            author: scout,
            at: at(1),
            note: "publish",
          },
        ],
      }),
      page({
        title: "Ink suppliers",
        folder: "Print",
        tags: ["print"],
        versions: [
          {
            version: 1,
            title: "Ink suppliers",
            body: "Two suppliers in Porto.",
            author: ana,
            at: at(4),
            note: null,
          },
        ],
      }),
      page({
        title: "Holidays",
        locked: true,
        versions: [
          {
            version: 1,
            title: "Holidays",
            body: "The shop closes in August.",
            author: { type: "person", id: "usr_jonas" },
            at: at(2),
            note: null,
          },
        ],
      }),
      page({
        title: "Old price list",
        deletedAt: at(3),
        deletedBy: ana,
        versions: [
          {
            version: 1,
            title: "Old price list",
            body: "Prices of 2025.",
            author: ana,
            at: at(30),
            note: null,
          },
        ],
      }),
    );
    const checklist = this.pages[0];
    if (checklist !== undefined)
      checklist.proposals = [
        {
          id: "ann_proposal",
          author: scout,
          createdAt: at(0),
          handledAt: null,
          handledBy: null,
          note: "The press stays warm otherwise.",
          parentVersion: 2,
          status: "pending",
          hunks: [
            {
              id: "h1",
              oldStr: "Cover the press.",
              newStr: "Cover the press and switch it off.",
              status: "pending",
            },
          ],
        },
      ];
    this.pages.push(
      page({
        title: "Salaries",
        access: { kind: "private", userIds: ["usr_ana", "usr_jonas"], agentIds: [] },
        versions: [
          {
            version: 1,
            title: "Salaries",
            body: "Only for the founders.",
            author: ana,
            at: at(5),
            note: null,
          },
        ],
      }),
    );
    this.reads = [{ slug: "press-checklist", title: "Press checklist", total: 12, agents: ["agt_scout"] }];
  }

  /** Who asks, during one call: what they may not read is never there for them. */
  private viewer: string | null = null;

  private readable(page: FakePage): boolean {
    const access = page.access ?? null;
    if (access === null || access.kind === "channel" || this.viewer === null) return true;
    return access.userIds.includes(this.viewer);
  }

  private live(workspaceId: string) {
    return this.pages.filter(
      (page) => page.workspaceId === workspaceId && page.deletedAt === null && this.readable(page),
    );
  }

  private find(workspaceId: string, slug: unknown) {
    return this.live(workspaceId).find((page) => page.slug === slug);
  }

  private summary(page: FakePage): T.WikiPageSummary {
    const last = page.versions.at(-1) as Version;
    return {
      agentEdits: page.agentEdits ?? "direct",
      altTitles: page.altTitles,
      excerpt: last.body
        .replace(/[#>*[\]]/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 160),
      folder: page.folder,
      locked: page.locked,
      pinned: page.pinned,
      props: page.props,
      restricted: (page.access ?? null) !== null,
      slug: page.slug,
      sourceType: null,
      tags: page.tags,
      title: page.title,
      updatedAt: last.at,
      updatedBy: last.author,
      version: last.version,
    };
  }

  private accessOf(page: FakePage): T.WikiAccess | null {
    const access = page.access ?? null;
    if (access === null) return null;
    if (access.kind === "channel") return { kind: "channel", channelId: access.channelId, channelName: null };
    return {
      kind: "private",
      people: access.userIds.map((id) => ({ id, name: this.host.nameOf?.(id) ?? null })),
      agents: access.agentIds.map((id) => ({ id, name: null })),
    };
  }

  private detail(page: FakePage, scope: { user: T.User; role: T.Role }): T.WikiPage {
    const admin = scope.role === "owner" || scope.role === "admin";
    const inbound = this.live(page.workspaceId).filter(
      (other) => other !== page && (other.versions.at(-1)?.body ?? "").includes(`[[${page.title}`),
    );
    return {
      ...this.summary(page),
      access: this.accessOf(page),
      accessEditable: admin || page.versions[0]?.author.id === scope.user.id,
      authors: [...new Map(page.versions.map((v) => [`${v.author.type}:${v.author.id}`, v.author])).values()],
      body: page.versions.at(-1)?.body ?? "",
      draft: null,
      editable: !page.locked || admin,
      history: [...page.versions]
        .reverse()
        .map(({ version, author, at, note }) => ({ version, author, at, note })),
      inboundLinks: inbound.map((other) => ({ slug: other.slug, title: other.title })),
      reads: {
        agents: [],
        last: null,
        total: this.reads.find((read) => read.slug === page.slug)?.total ?? 0,
      },
    };
  }

  private setStatus(
    scope: { workspaceId: string; user: T.User },
    id: unknown,
    status: "open" | "resolved",
  ): FilesReply {
    const page = this.live(scope.workspaceId).find((each) => (each.comments ?? []).some((c) => c.id === id));
    const comment = page?.comments?.find((each) => each.id === id);
    if (comment === undefined) return notFound();
    comment.status = status;
    comment.handledBy = status === "resolved" ? { type: "person", id: scope.user.id } : null;
    comment.handledAt = status === "resolved" ? this.host.now().toISOString() : null;
    return reply(200, comment);
  }

  private save(
    page: FakePage,
    author: T.User,
    change: Partial<Pick<Version, "title" | "body">>,
    note: string | null,
  ) {
    const last = page.versions.at(-1) as Version;
    page.versions.push({
      version: last.version + 1,
      title: change.title ?? last.title,
      body: change.body ?? last.body,
      author: { type: "person", id: author.id },
      at: this.host.now().toISOString(),
      note,
    });
  }

  operations(): Record<
    string,
    (params: Record<string, unknown>, session: string | undefined, raw: unknown) => FilesReply
  > {
    type Scope = { workspaceId: string; user: T.User; role: T.Role };
    const within =
      (handler: (scope: Scope, params: Record<string, unknown>) => FilesReply) =>
      (params: Record<string, unknown>, session: string | undefined) => {
        const scope = this.host.scope(params, session);
        if ("status" in scope) return scope;
        this.viewer = scope.user.id;
        try {
          return handler(scope, params);
        } finally {
          this.viewer = null;
        }
      };
    const onPage = (handler: (scope: Scope, page: FakePage, params: Record<string, unknown>) => FilesReply) =>
      within((scope, params) => {
        const page = this.find(scope.workspaceId, params.pageId);
        return page === undefined ? notFound() : handler(scope, page, params);
      });
    const writable = (
      handler: (scope: Scope, page: FakePage, params: Record<string, unknown>) => FilesReply,
    ) =>
      onPage((scope, page, params) =>
        page.locked && scope.role !== "owner" && scope.role !== "admin"
          ? fail(423, "wiki.locked", "The page is locked")
          : handler(scope, page, params),
      );
    const admin = (scope: Scope) => scope.role === "owner" || scope.role === "admin";
    return {
      listWikiPages: within((scope) =>
        reply(200, { pages: this.live(scope.workspaceId).map((page) => this.summary(page)) }),
      ),
      getWikiSearch: within((scope, params) => {
        const q = (text(params.q) ?? "").toLowerCase();
        const pages = this.live(scope.workspaceId).filter((page) =>
          [page.title, page.versions.at(-1)?.body ?? "", ...page.tags].some((field) =>
            field.toLowerCase().includes(q),
          ),
        );
        return reply(200, { pages: pages.slice(0, 50).map((page) => this.summary(page)) });
      }),
      getWikiPage: onPage((scope, page) => reply(200, this.detail(page, scope))),
      createWikiPage: within((scope, params) => {
        const title = text(params.title)?.trim() ?? "";
        if (title === "") return fail(400, "invalid_request", "A title is needed");
        let slug = slugify(title);
        for (
          let n = 2;
          this.pages.some((page) => page.workspaceId === scope.workspaceId && page.slug === slug);
          n++
        )
          slug = `${slugify(title)}-${n}`;
        const page: FakePage = {
          workspaceId: scope.workspaceId,
          slug,
          title,
          folder: text(params.folder) ?? "",
          tags: words(params.tags) ?? [],
          altTitles: [],
          props: {},
          pinned: false,
          locked: false,
          deletedAt: null,
          deletedBy: null,
          versions: [
            {
              version: 1,
              title,
              body: text(params.body) ?? "",
              author: { type: "person", id: scope.user.id },
              at: this.host.now().toISOString(),
              note: null,
            },
          ],
        };
        this.pages.push(page);
        return reply(200, this.detail(page, scope));
      }),
      renameWikiPage: writable((scope, page, params) => {
        const title = text(params.title)?.trim() ?? "";
        if (title === "") return fail(400, "invalid_request", "A title is needed");
        const before = page.title;
        page.title = title;
        this.save(page, scope.user, { title }, `renamed from "${before}"`);
        return reply(200, { ...this.detail(page, scope), relinked: { rewritten: [], skipped: [] } });
      }),
      moveWikiPage: writable((scope, page, params) => {
        page.folder = text(params.folder) ?? "";
        return reply(200, this.detail(page, scope));
      }),
      updateWikiPageMeta: writable((scope, page, params) => {
        if (params.parentVersion !== page.versions.at(-1)?.version)
          return fail(409, "wiki.page_changed", "Someone saved a newer version", {
            currentVersion: page.versions.at(-1)?.version,
          });
        const tags = words(params.tags);
        const altTitles = words(params.altTitles);
        if (tags !== undefined) page.tags = tags;
        if (altTitles !== undefined) page.altTitles = altTitles;
        if (typeof params.props === "object" && params.props !== null) {
          for (const [id, value] of Object.entries(params.props)) {
            if (value === null) delete page.props[id];
            else page.props[id] = value;
          }
        }
        this.save(page, scope.user, {}, "meta");
        return reply(200, this.detail(page, scope));
      }),
      pinWikiPage: onPage((scope, page, params) => {
        page.pinned = params.pinned === true;
        return reply(200, this.detail(page, scope));
      }),
      lockWikiPage: onPage((scope, page, params) => {
        if (!admin(scope)) return fail(403, "forbidden", "Only admins can lock pages");
        page.locked = params.locked === true;
        return reply(200, this.detail(page, scope));
      }),
      deleteWikiPage: onPage((scope, page) => {
        const first = page.versions[0]?.author;
        if (!admin(scope) && (page.locked || first?.id !== scope.user.id))
          return fail(403, "forbidden", "Only who created the page or an admin can delete it");
        page.deletedAt = this.host.now().toISOString();
        page.deletedBy = { type: "person", id: scope.user.id };
        return reply(204, null);
      }),
      getWikiTrash: within((scope) =>
        reply(200, {
          pages: this.pages
            .filter(
              (page) =>
                page.workspaceId === scope.workspaceId && page.deletedAt !== null && this.readable(page),
            )
            .map((page) => ({
              slug: page.slug,
              title: page.title,
              folder: page.folder,
              deletedAt: page.deletedAt,
              deletedBy: page.deletedBy,
              expungeAt: new Date(Date.parse(page.deletedAt ?? "") + 30 * DAY_MS).toISOString(),
              canPurge: admin(scope) || page.versions[0]?.author.id === scope.user.id,
            })),
        }),
      ),
      restoreWikiTrash: within((scope, params) => {
        const page = this.pages.find(
          (each) =>
            each.workspaceId === scope.workspaceId && each.slug === params.trashId && each.deletedAt !== null,
        );
        if (page === undefined) return notFound();
        page.deletedAt = null;
        page.deletedBy = null;
        return reply(200, this.detail(page, scope));
      }),
      deleteWikiTrash: within((scope, params) => {
        const before = this.pages.length;
        this.pages = this.pages.filter(
          (page) =>
            !(
              page.workspaceId === scope.workspaceId &&
              page.slug === params.trashId &&
              page.deletedAt !== null
            ),
        );
        return this.pages.length === before ? notFound() : reply(204, null);
      }),
      getWikiPageHistory: onPage((scope, page) => reply(200, { versions: this.detail(page, scope).history })),
      getWikiPageDiff: onPage((_scope, page, params) => {
        const last = page.versions.at(-1) as Version;
        const pick = (value: unknown, fallback: number) =>
          page.versions.find((v) => v.version === Number(value ?? fallback)) ?? last;
        const to = pick(params.to, last.version);
        const from = pick(params.from, Math.max(1, to.version - 1));
        const before = from.body.split("\n");
        const after = to.body.split("\n");
        const lines: T.WikiDiff["lines"] = [
          ...before
            .filter((line) => !after.includes(line))
            .map((line) => ({ kind: "del" as const, text: line })),
          ...after.map((line) => ({
            kind: before.includes(line) ? ("same" as const) : ("add" as const),
            text: line,
          })),
        ];
        const ref = (v: Version) => ({
          version: v.version,
          at: v.at,
          author: v.author,
          note: v.note,
          title: v.title,
        });
        return reply(200, {
          from: ref(from),
          to: ref(to),
          lines: from === to ? [] : lines,
          props: [],
          stats: {
            added: lines.filter((l) => l.kind === "add").length,
            removed: lines.filter((l) => l.kind === "del").length,
          },
        });
      }),
      restoreWikiPageVersion: writable((scope, page, params) => {
        const from = page.versions.find((v) => v.version === Number(params.versionId));
        if (from === undefined) return notFound();
        if (params.parentVersion !== page.versions.at(-1)?.version)
          return fail(409, "wiki.page_changed", "Someone saved a newer version");
        this.save(page, scope.user, { body: from.body }, `restored version ${from.version}`);
        return reply(200, this.detail(page, scope));
      }),
      getWikiPagePanel: onPage((_scope, page) => {
        const body = page.versions.at(-1)?.body ?? "";
        const outline = body.split("\n").flatMap((line, at) => {
          const heading = /^(#{1,6})\s+(.*)$/.exec(line);
          return heading === null
            ? []
            : [{ level: (heading[1] ?? "#").length, line: at + 1, text: heading[2] ?? "" }];
        });
        const outgoing = [...body.matchAll(/\[\[([^\]|#]+)\]\]/g)].map((match) => {
          const target = match[1] ?? "";
          const found = this.live(page.workspaceId).find(
            (other) => other.title.toLowerCase() === target.toLowerCase(),
          );
          return {
            target,
            anchor: null,
            label: null,
            embed: false,
            page: found === undefined ? null : { slug: found.slug, title: found.title },
            state: found === undefined ? ("missing" as const) : ("ok" as const),
          };
        });
        const inboundLinks = this.live(page.workspaceId)
          .filter(
            (other) => other !== page && (other.versions.at(-1)?.body ?? "").includes(`[[${page.title}`),
          )
          .map((other) => ({
            slug: other.slug,
            title: other.title,
            count: 1,
            snippet: other.versions.at(-1)?.body.slice(0, 80) ?? "",
          }));
        return reply(200, { outline, outgoing, inboundLinks, mentions: [] });
      }),
      publishWikiPageDraft: onPage((scope, page) => reply(200, this.detail(page, scope))),
      deleteWikiPageDraft: onPage((scope, page) => reply(200, this.detail(page, scope))),
      getWikiReads: within((scope) =>
        reply(
          200,
          this.reads.filter((read) => this.find(scope.workspaceId, read.slug) !== undefined),
        ),
      ),
      listWikiProps: within(() => reply(200, this.defs)),
      setWikiProps: within((_scope, params) => {
        if (params.parentVersion !== this.defs.version)
          return fail(409, "wiki.props_changed", "The properties changed");
        this.defs = { defs: (params.defs as T.WikiPropDef[]) ?? [], version: this.defs.version + 1 };
        return reply(200, this.defs);
      }),
      setWikiPageAccess: onPage((scope, page, params) => {
        if (!admin(scope) && page.versions[0]?.author.id !== scope.user.id)
          return fail(403, "forbidden", "Only who created the page or an admin can change who reads it");
        const access = params.access as T.WikiAccessInput;
        page.access =
          access === null
            ? null
            : access.kind === "channel"
              ? access
              : {
                  kind: "private",
                  userIds: [...new Set([...access.userIds, scope.user.id])],
                  agentIds: access.agentIds,
                };
        return reply(200, this.detail(page, scope));
      }),
      getWikiPageAnnotations: onPage((_scope, page) =>
        reply(200, { comments: page.comments ?? [], proposals: page.proposals ?? [] }),
      ),
      createWikiPageComment: onPage((scope, page, params) => {
        const body = text(params.body)?.trim() ?? "";
        if (body === "") return fail(400, "invalid_request", "A comment needs text");
        const parentId = text(params.parentId) ?? null;
        const anchor = (params.anchor as T.WikiAnchor | undefined) ?? null;
        const comment: T.WikiComment = {
          id: this.host.id("ann"),
          agentId: null,
          anchor: parentId === null ? anchor : null,
          anchorState:
            parentId === null && anchor !== null
              ? (page.versions.at(-1)?.body ?? "").includes(anchor.quote)
                ? "ok"
                : "orphan"
              : null,
          author: { type: "person", id: scope.user.id },
          body,
          createdAt: this.host.now().toISOString(),
          handledAt: null,
          handledBy: null,
          parentId,
          status: "open",
        };
        page.comments = [...(page.comments ?? []), comment];
        return reply(201, comment);
      }),
      resolveWikiAnnotation: within((scope, params) =>
        this.setStatus(scope, params.annotationId, "resolved"),
      ),
      reopenWikiAnnotation: within((scope, params) => this.setStatus(scope, params.annotationId, "open")),
      deleteWikiAnnotation: within((scope, params) => {
        const page = this.live(scope.workspaceId).find((each) =>
          (each.comments ?? []).some((c) => c.id === params.annotationId),
        );
        if (page === undefined) return notFound();
        page.comments = (page.comments ?? []).filter(
          (c) => c.id !== params.annotationId && c.parentId !== params.annotationId,
        );
        return reply(204, null);
      }),
      decideWikiAnnotation: within((scope, params) => {
        const page = this.live(scope.workspaceId).find((each) =>
          (each.proposals ?? []).some((p) => p.id === params.annotationId),
        );
        const proposal = page?.proposals?.find((each) => each.id === params.annotationId);
        if (page === undefined || proposal === undefined) return notFound();
        const decisions = (params.decisions as { hunkId: string; accept: boolean }[]) ?? [];
        let body = page.versions.at(-1)?.body ?? "";
        for (const decision of decisions) {
          const hunk = proposal.hunks.find((each) => each.id === decision.hunkId);
          if (hunk === undefined || hunk.status !== "pending") continue;
          if (!decision.accept) hunk.status = "rejected";
          else if (body.split(hunk.oldStr).length === 2) {
            body = body.replace(hunk.oldStr, hunk.newStr);
            hunk.status = "accepted";
          } else hunk.status = "stale";
        }
        if (body !== page.versions.at(-1)?.body)
          this.save(page, scope.user, { body }, `proposal ${proposal.id}`);
        if (proposal.hunks.every((hunk) => hunk.status !== "pending")) {
          proposal.status = "done";
          proposal.handledAt = this.host.now().toISOString();
          proposal.handledBy = { type: "person", id: scope.user.id };
        }
        return reply(200, { proposal, page: this.detail(page, scope) });
      }),
      listWikiAttachments: within(() => reply(200, { attachments: [] })),
      importWiki: within((scope, params) => {
        const files = Array.isArray(params.files) ? (params.files as { path: string; text: string }[]) : [];
        let created = 0;
        for (const file of files) {
          const title = (file.path.split("/").pop() ?? file.path).replace(/\.md$/i, "");
          const folder = file.path.split("/").slice(0, -1).join("/");
          this.pages.push({
            workspaceId: scope.workspaceId,
            slug: slugify(`${folder} ${title}`),
            title,
            folder,
            tags: [],
            altTitles: [],
            props: {},
            pinned: false,
            locked: false,
            deletedAt: null,
            deletedBy: null,
            versions: [
              {
                version: 1,
                title,
                body: file.text,
                author: { type: "person", id: scope.user.id },
                at: this.host.now().toISOString(),
                note: "import",
              },
            ],
          });
          created += 1;
        }
        return reply(200, { created, skipped: 0, failed: [] });
      }),
      exportWiki: within(() => ({
        status: 200,
        body: null,
        bytes: { data: new TextEncoder().encode("zip"), type: "application/zip" },
      })),
    };
  }
}

/**
 * The live page's socket in tests and the fake server: it never opens, as a server without the live
 * document would. A page then shows its published text, read only, with "connecting" as its state.
 */
export class IdleWikiSocket {
  readonly url: string;
  readyState = 0;
  binaryType = "arraybuffer";
  onopen: unknown = null;
  onclose: unknown = null;
  onerror: unknown = null;
  onmessage: unknown = null;
  constructor(url: string) {
    this.url = url;
  }
  addEventListener(): void {}
  removeEventListener(): void {}
  send(): void {}
  close(): void {}
}
