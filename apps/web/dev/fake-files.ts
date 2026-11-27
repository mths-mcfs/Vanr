// The Drive and the search, for the fake server: files with their versions, the trash, resumable upload
// sessions (the bytes are only counted, never kept), the search over titles and written text, and an
// answer to a question built from the hits. Every change announces itself on the workspace's socket as
// the real server does. Wired into FakeServer's operations; never part of the production build.
import type * as T from "@vanr/contract";

/** What an operation answers: JSON, or raw bytes for a file's content. */
export type FilesReply = {
  status: number;
  body: unknown;
  bytes?: { data: Uint8Array; type: string };
};

type Scope = { workspaceId: string; user: T.User; role: T.Role };

/** What the fake server lends this module. */
export type FilesHost = {
  now: () => Date;
  id: (prefix: string) => string;
  /** The workspace and the caller of a member-only call, or the error answer. */
  scope: (params: Record<string, unknown>, session: string | undefined) => Scope | FilesReply;
  emit: (workspaceId: string, event: { type: string } & Record<string, unknown>) => void;
};

type Version = {
  version: number;
  content: T.FileContent;
  author: T.ActorRef;
  createdAt: string;
  note: string | null;
};
export type FakeFile = {
  workspaceId: string;
  id: string;
  title: string;
  kind: T.FileKind;
  channelId: string | null;
  threadId: string | null;
  createdBy: T.ActorRef;
  createdAt: string;
  deletedAt: string | null;
  versions: Version[];
};
type Upload = {
  workspaceId: string;
  userId: string;
  id: string;
  fileName: string;
  size: number;
  received: number;
  contentType: string | null;
  fileId: string | null;
  parentVersion: number | null;
  status: T.UploadSession["status"];
  resultFileId: string | null;
};

const DAY_MS = 86_400_000;
const TRASH_DAYS = 30;

const reply = (status: number, body: unknown): FilesReply => ({ status, body });
const fail = (status: number, code: string, message: string, params?: Record<string, unknown>) =>
  reply(status, { error: params ? { code, message, params } : { code, message } });
const notFound = () => fail(404, "not_found", "Not found");

const text = (value: unknown) => (typeof value === "string" ? value : undefined);
const count = (value: unknown) => {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isSafeInteger(n) ? n : undefined;
};
const person = (id: string): T.ActorRef => ({ type: "person", id });

export const uploaded = (
  name: string,
  size: number,
  contentType: string,
  extra: Partial<Extract<T.FileContent, { kind: "file" }>> = {},
): T.FileContent => ({
  kind: "file",
  name,
  size,
  contentType,
  detectedType: contentType,
  extract: "none",
  extractError: null,
  hasPreview: false,
  hasThumb: false,
  text: null,
  totalPages: 0,
  ...extra,
});

export class FakeFiles {
  files: FakeFile[] = [];
  uploads: Upload[] = [];
  /** The part size upload sessions announce; tests make it small to see a file go up in parts. */
  partSize = 8 * 1024 * 1024;

  constructor(private readonly host: FilesHost) {}

  seed(): void {
    const at = (daysAgo: number) => new Date(this.host.now().getTime() - daysAgo * DAY_MS).toISOString();
    const file = (
      id: string,
      title: string,
      kind: T.FileKind,
      createdBy: T.ActorRef,
      versions: Omit<Version, "author">[],
      extra: Partial<FakeFile> = {},
    ): FakeFile => ({
      workspaceId: "workspace_birchwood",
      id,
      title,
      kind,
      channelId: null,
      threadId: null,
      createdBy,
      createdAt: versions[0]?.createdAt ?? at(0),
      deletedAt: null,
      versions: versions.map((version) => ({ ...version, author: createdBy })),
      ...extra,
    });
    this.files = [
      file("fil_plan", "Release plan", "document", person("usr_ana"), [
        {
          version: 1,
          content: { kind: "document", markdown: "# Release plan\nShip the press calendar." },
          createdAt: at(6),
          note: null,
        },
        {
          version: 2,
          content: { kind: "document", markdown: "# Release plan\nShip the press calendar in March." },
          createdAt: at(2),
          note: "Moved to March",
        },
      ]),
      file(
        "fil_notes",
        "field-notes.txt",
        "file",
        { type: "agent", id: "agt_scout" },
        [
          {
            version: 1,
            content: uploaded("field-notes.txt", 2048, "text/plain", {
              text: "Ink drying times by paper weight.",
            }),
            createdAt: at(1),
            note: null,
          },
        ],
        { channelId: "ch_design" },
      ),
      file("fil_budget", "Budget", "table", person("usr_jonas"), [
        {
          version: 1,
          content: {
            kind: "table",
            columns: ["Item", "Cost"],
            rows: [
              ["Paper", "120"],
              ["Ink", "80"],
            ],
          },
          createdAt: at(3),
          note: null,
        },
      ]),
      file(
        "fil_old",
        "Old flyer",
        "document",
        person("usr_jonas"),
        [
          {
            version: 1,
            content: { kind: "document", markdown: "Spring sale" },
            createdAt: at(60),
            note: null,
          },
        ],
        { deletedAt: at(TRASH_DAYS - 2) },
      ),
      file(
        "fil_draft",
        "Draft poster",
        "document",
        person("usr_iris"),
        [{ version: 1, content: { kind: "document", markdown: "Poster" }, createdAt: at(10), note: null }],
        { deletedAt: at(1) },
      ),
    ];
    this.uploads = [];
  }

  private find(workspaceId: string, id: unknown, trashed = false): FakeFile | undefined {
    return this.files.find(
      (file) => file.workspaceId === workspaceId && file.id === id && (file.deletedAt !== null) === trashed,
    );
  }

  private mayDelete(file: FakeFile, scope: Scope) {
    return (
      (file.createdBy.type === "person" && file.createdBy.id === scope.user.id) || scope.role !== "member"
    );
  }

  private summary(file: FakeFile, scope: Scope): T.File {
    const latest = file.versions.at(-1);
    return {
      id: file.id,
      channelId: file.channelId,
      threadId: file.threadId,
      createdAt: file.createdAt,
      createdBy: file.createdBy,
      deletable: this.mayDelete(file, scope),
      kind: file.kind,
      title: file.title,
      updatedAt: latest?.createdAt ?? file.createdAt,
      updatedBy: latest?.author ?? file.createdBy,
      version: latest?.version ?? 1,
    };
  }

  private detail(file: FakeFile, scope: Scope, version?: number): T.FileDetail | undefined {
    const shown =
      version === undefined ? file.versions.at(-1) : file.versions.find((each) => each.version === version);
    if (shown === undefined) return undefined;
    return {
      ...this.summary(file, scope),
      content: shown.content,
      editable: file.kind === "document",
      viewVersion: shown.version,
    };
  }

  private body(file: FakeFile): string {
    const content = file.versions.at(-1)?.content;
    if (content === undefined) return "";
    if (content.kind === "document") return content.markdown;
    if (content.kind === "file") return content.text ?? "";
    if (content.kind === "table") return content.rows.flat().join(" ");
    return "";
  }

  private hits(scope: Scope, q: string, kinds: unknown): T.SearchHit[] {
    const words = q
      .toLowerCase()
      .split(/\s+/)
      .filter((word) => word.length >= 2);
    const wanted = Array.isArray(kinds) ? kinds : typeof kinds === "string" ? kinds.split(",") : undefined;
    if (wanted !== undefined && !wanted.includes("file")) return [];
    return this.files
      .filter((file) => file.workspaceId === scope.workspaceId && file.deletedAt === null)
      .filter((file) => {
        const haystack = `${file.title} ${this.body(file)}`.toLowerCase();
        return words.length > 0 && words.every((word) => haystack.includes(word));
      })
      .map((file) => ({
        kind: "file" as const,
        sourceId: file.id,
        title: file.title,
        snippet: this.body(file).slice(0, 160),
        channelIds: file.channelId === null ? [] : [file.channelId],
        threadId: null,
        authorId: `${file.createdBy.type}:${file.createdBy.id}`,
        createdAt: file.versions.at(-1)?.createdAt ?? file.createdAt,
        page: null,
      }));
  }

  private session(upload: Upload): T.UploadSession {
    return {
      id: upload.id,
      offset: upload.received,
      size: upload.size,
      partSize: this.partSize,
      status: upload.status,
      expiresAt: new Date(this.host.now().getTime() + DAY_MS).toISOString(),
      fileId: upload.resultFileId,
    };
  }

  /** The operations, by the client's method names; `raw` is the request body as sent. */
  operations(): Record<
    string,
    (params: Record<string, unknown>, session: string | undefined, raw: unknown) => FilesReply
  > {
    const within =
      (handler: (scope: Scope, params: Record<string, unknown>, raw: unknown) => FilesReply) =>
      (params: Record<string, unknown>, session: string | undefined, raw: unknown) => {
        const scope = this.host.scope(params, session);
        return "status" in scope ? scope : handler(scope, params, raw);
      };
    return {
      listFiles: within((scope, params) => {
        const q = text(params.q)?.toLowerCase();
        const files = this.files
          .filter((file) => file.workspaceId === scope.workspaceId && file.deletedAt === null)
          .filter((file) => q === undefined || file.title.toLowerCase().includes(q))
          .filter((file) => params.kind === undefined || file.kind === params.kind)
          .filter((file) => params.authorKind === undefined || file.createdBy.type === params.authorKind)
          .map((file) => this.summary(file, scope))
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        return reply(200, { files });
      }),
      getFile: within((scope, params) => {
        const file = this.find(scope.workspaceId, params.fileId);
        const detail = file && this.detail(file, scope, count(params.version));
        return detail === undefined ? notFound() : reply(200, detail);
      }),
      listFileVersions: within((scope, params) => {
        const file = this.find(scope.workspaceId, params.fileId);
        if (file === undefined) return notFound();
        return reply(200, {
          versions: file.versions.map(({ version, author, createdAt, note }) => ({
            version,
            author,
            createdAt,
            note,
          })),
        });
      }),
      getFileText: within((scope, params) => {
        const file = this.find(scope.workspaceId, params.fileId);
        if (file === undefined) return notFound();
        return reply(200, { version: file.versions.at(-1)?.version ?? 1, status: "none", pages: [] });
      }),
      getFileDownload: within((scope, params) => {
        const file = this.find(scope.workspaceId, params.fileId);
        if (file === undefined) return notFound();
        if (file.kind !== "file")
          return fail(400, "file.not_a_file", "Only uploaded files can be downloaded");
        return reply(200, {
          url: `https://files.vanr.test/${file.id}`,
          expiresAt: new Date(this.host.now().getTime() + 60_000).toISOString(),
        });
      }),
      getFileBlob: within((scope, params) => {
        const file = this.find(scope.workspaceId, params.fileId);
        if (file === undefined) return notFound();
        return {
          status: 200,
          body: null,
          bytes: { data: new TextEncoder().encode(this.body(file)), type: "text/plain" },
        };
      }),
      createFile: within((scope, params) => {
        const title = text(params.title)?.trim();
        const content = params.content as T.FileContent | undefined;
        if (title === undefined || title === "" || content === undefined)
          return fail(400, "invalid_request", "Invalid body");
        const now = this.host.now().toISOString();
        const file: FakeFile = {
          workspaceId: scope.workspaceId,
          id: this.host.id("fil"),
          title,
          kind: content.kind === "file" ? "file" : content.kind,
          channelId: text(params.channelId) ?? null,
          threadId: null,
          createdBy: person(scope.user.id),
          createdAt: now,
          deletedAt: null,
          versions: [{ version: 1, content, author: person(scope.user.id), createdAt: now, note: null }],
        };
        this.files.push(file);
        this.host.emit(scope.workspaceId, {
          type: "file.created",
          fileId: file.id,
          channelId: file.channelId,
        });
        return reply(201, this.detail(file, scope));
      }),
      createFileVersion: within((scope, params) => {
        const file = this.find(scope.workspaceId, params.fileId);
        if (file === undefined) return notFound();
        const latest = file.versions.at(-1)?.version ?? 0;
        if (count(params.parentVersion) !== latest) {
          return fail(409, "file.version_conflict", "Someone saved a newer version", { version: latest });
        }
        file.versions.push({
          version: latest + 1,
          content: params.content as T.FileContent,
          author: person(scope.user.id),
          createdAt: this.host.now().toISOString(),
          note: text(params.note) ?? null,
        });
        this.host.emit(scope.workspaceId, {
          type: "file.updated",
          fileId: file.id,
          channelId: file.channelId,
        });
        return reply(200, this.detail(file, scope));
      }),
      deleteFile: within((scope, params) => {
        const file = this.find(scope.workspaceId, params.fileId);
        if (file === undefined) return notFound();
        if (!this.mayDelete(file, scope)) return fail(403, "forbidden", "Not yours");
        file.deletedAt = this.host.now().toISOString();
        this.host.emit(scope.workspaceId, {
          type: "file.deleted",
          fileId: file.id,
          channelId: file.channelId,
        });
        return reply(204, null);
      }),
      restoreFile: within((scope, params) => {
        const file = this.find(scope.workspaceId, params.fileId, true);
        if (file === undefined) return notFound();
        if (!this.mayDelete(file, scope)) return fail(403, "forbidden", "Not yours");
        file.deletedAt = null;
        this.host.emit(scope.workspaceId, {
          type: "file.updated",
          fileId: file.id,
          channelId: file.channelId,
        });
        return reply(200, this.detail(file, scope));
      }),
      getFileTrash: within((scope) => {
        const files: T.TrashedFile[] = this.files
          .filter((file) => file.workspaceId === scope.workspaceId && file.deletedAt !== null)
          .map((file) => ({
            id: file.id,
            title: file.title,
            kind: file.kind,
            createdBy: file.createdBy,
            deletedAt: file.deletedAt ?? "",
            expungeAt: new Date(Date.parse(file.deletedAt ?? "") + TRASH_DAYS * DAY_MS).toISOString(),
          }));
        return reply(200, { files });
      }),

      createFileUpload: within((scope, params) => {
        const size = count(params.size);
        const fileName = text(params.fileName);
        if (size === undefined || fileName === undefined) return fail(400, "invalid_request", "Invalid body");
        const fileId = text(params.fileId) ?? null;
        if (fileId !== null) {
          const file = this.find(scope.workspaceId, fileId);
          if (file === undefined) return notFound();
          if (count(params.parentVersion) !== file.versions.at(-1)?.version) {
            return fail(409, "file.version_conflict", "Someone saved a newer version");
          }
        }
        const upload: Upload = {
          workspaceId: scope.workspaceId,
          userId: scope.user.id,
          id: this.host.id("upl"),
          fileName,
          size,
          received: 0,
          contentType: text(params.contentType) ?? null,
          fileId,
          parentVersion: count(params.parentVersion) ?? null,
          status: "open",
          resultFileId: null,
        };
        this.uploads.push(upload);
        return reply(201, this.session(upload));
      }),
      getFileUpload: within((scope, params) => {
        const upload = this.uploads.find(
          (each) =>
            each.id === params.uploadId &&
            each.userId === scope.user.id &&
            each.workspaceId === scope.workspaceId,
        );
        return upload === undefined ? notFound() : reply(200, this.session(upload));
      }),
      replaceFileUpload: within((scope, params, raw) => {
        const upload = this.uploads.find(
          (each) =>
            each.id === params.uploadId &&
            each.userId === scope.user.id &&
            each.workspaceId === scope.workspaceId,
        );
        if (upload === undefined) return notFound();
        if (upload.status !== "open") return fail(409, "upload.closed", "This upload is closed");
        const offset = count(params.offset);
        if (offset !== upload.received) {
          return fail(409, "upload.offset_mismatch", "Wrong offset", { offset: upload.received });
        }
        const size = raw instanceof Blob ? raw.size : raw instanceof Uint8Array ? raw.byteLength : 0;
        if (size === 0) return fail(400, "upload.empty_part", "Empty part");
        upload.received = Math.min(upload.size, upload.received + size);
        return reply(200, this.session(upload));
      }),
      completeFileUpload: within((scope, params) => {
        const upload = this.uploads.find(
          (each) =>
            each.id === params.uploadId &&
            each.userId === scope.user.id &&
            each.workspaceId === scope.workspaceId,
        );
        if (upload === undefined) return notFound();
        // Completing again gives back what the first completion made, as the server does.
        if (upload.status === "done" && upload.resultFileId !== null) {
          const made = this.find(scope.workspaceId, upload.resultFileId);
          if (made !== undefined) return reply(200, this.detail(made, scope));
        }
        if (upload.received < upload.size) return fail(409, "upload.incomplete", "Parts are missing");
        const now = this.host.now().toISOString();
        const content = uploaded(
          upload.fileName,
          upload.size,
          upload.contentType ?? "application/octet-stream",
        );
        let file = upload.fileId === null ? undefined : this.find(scope.workspaceId, upload.fileId);
        if (file === undefined) {
          file = {
            workspaceId: scope.workspaceId,
            id: this.host.id("fil"),
            title: upload.fileName,
            kind: "file",
            channelId: null,
            threadId: null,
            createdBy: person(scope.user.id),
            createdAt: now,
            deletedAt: null,
            versions: [{ version: 1, content, author: person(scope.user.id), createdAt: now, note: null }],
          };
          this.files.push(file);
          this.host.emit(scope.workspaceId, { type: "file.created", fileId: file.id, channelId: null });
        } else {
          const latest = file.versions.at(-1)?.version ?? 0;
          // Someone saved while the parts went up: the version this one replaces is no longer the current one.
          if (upload.parentVersion !== null && upload.parentVersion !== latest) {
            return fail(409, "file.version_conflict", "Someone saved a newer version");
          }
          file.versions.push({
            version: latest + 1,
            content,
            author: person(scope.user.id),
            createdAt: now,
            note: null,
          });
          this.host.emit(scope.workspaceId, {
            type: "file.updated",
            fileId: file.id,
            channelId: file.channelId,
          });
        }
        upload.status = "done";
        upload.resultFileId = file.id;
        return reply(200, this.detail(file, scope));
      }),
      deleteFileUpload: within((scope, params) => {
        const at = this.uploads.findIndex(
          (each) =>
            each.id === params.uploadId &&
            each.userId === scope.user.id &&
            each.workspaceId === scope.workspaceId,
        );
        if (at === -1) return notFound();
        this.uploads.splice(at, 1);
        return reply(204, null);
      }),

      getSearch: within((scope, params) => {
        const q = text(params.q) ?? "";
        const limit = count(params.limit) ?? 30;
        return reply(200, { hits: this.hits(scope, q, params.kinds).slice(0, limit) });
      }),
      askSearch: within((scope, params) => {
        const sources = this.hits(scope, text(params.q) ?? "", undefined)
          .slice(0, 3)
          .map((hit, index) => ({ ...hit, n: index + 1 }));
        const blocks =
          sources.length === 0
            ? []
            : [{ text: `The workspace mentions this in ${sources[0]?.title}.`, sources: [1] }];
        return reply(200, { blocks, sources, testModel: true });
      }),
    };
  }
}
