// The Drive: every file of the workspace, uploaded or written in the app, in a grid or a list, with a
// search by name, filters by kind and by who made it, the files whose text matches, the upload queue
// and the trash. Files of a channel only announce themselves to the channel's subscribers, so the list
// is also asked again on open and once a minute.
import { useApiQuery } from "@vanr/client/react";
import type { File as DriveFile, FileKind } from "@vanr/contract";
import { Button, Chip, EmptyState, Icon, Input } from "@vanr/ui";
import { FilePlus, LayoutGrid, List, Trash2, Upload } from "lucide-react";
import { type DragEvent, useCallback, useDeferredValue, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { useRuntime } from "../../../app/context.tsx";
import { useGo, useRouteParams, useSearch } from "../../../app/navigation.tsx";
import { ScreenError, ScreenLoading, useDocumentTitle } from "../../../app/screens.tsx";
import { useMessages } from "../../../i18n/react.tsx";
import { readStored, STORAGE_KEYS, writeStored } from "../../../platform/storage.ts";
import {
  FILE_KINDS,
  KIND_ICON,
  Marked,
  TITLE_MAX,
  useActorName,
  useRefetch,
  useRelativeTime,
} from "../shared.tsx";
import { NewDocumentDialog } from "./NewDocument.tsx";
import { Preview } from "./Preview.tsx";
import { useBlobUrl } from "./preview-parts.tsx";
import { Trash } from "./Trash.tsx";
import { UploadTray } from "./UploadTray.tsx";
import { useUploadQueue } from "./upload-queue.ts";

/** The list is asked again this often, for files of channels whose events don't reach this person. */
const REFRESH_MS = 60_000;
const CONTENT_HITS = 10;

const positive = z.coerce.number().int().positive();
export const DriveAddress = z.object({
  file: z.string().min(1).optional(),
  v: positive.optional(),
  /** The page the search cited. */
  p: positive.optional(),
  trash: z.literal("1").optional(),
});
export type DriveAddress = z.infer<typeof DriveAddress>;
const EMPTY: DriveAddress = {};

const View = z.enum(["grid", "list"]);
type Who = "all" | "agent" | "person";

export function DriveScreen() {
  const { workspaceId } = useRouteParams("files");
  // Another workspace is another Drive: its own queue, so nothing picked here goes up there.
  return <Drive key={workspaceId} workspaceId={workspaceId} />;
}

function Drive({ workspaceId }: { workspaceId: string }) {
  const t = useMessages("files");
  const address = useSearch(DriveAddress, EMPTY);
  const go = useGo();
  const open = useCallback(
    (next: DriveAddress, replace = false) =>
      void go(
        "files",
        { workspaceId },
        { search: { ...next, v: next.v?.toString(), p: next.p?.toString() }, replace },
      ),
    [go, workspaceId],
  );
  const refetch = useRefetch();
  const uploads = useUploadQueue(
    workspaceId,
    () => void refetch([{ method: "listFiles", args: { workspaceId } }]),
  );
  const picker = useRef<HTMLInputElement>(null);
  const [creating, setCreating] = useState(false);
  const inTrash = address.trash === "1";
  useDocumentTitle(inTrash ? t("trash.title") : t("drive.title"));

  const drop = (event: DragEvent) => {
    if (inTrash) return;
    event.preventDefault();
    uploads.add([...event.dataTransfer.files]);
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a drop target for files; the Upload button is the keyboard's way in.
    <div
      className="page files"
      onDragOver={(event) => {
        if (!inTrash) event.preventDefault();
      }}
      onDrop={drop}
    >
      <header className="files__head">
        <div>
          <h1 className="page__title">{inTrash ? t("trash.title") : t("drive.title")}</h1>
          <p className="page__muted">{inTrash ? t("trash.lead") : t("drive.lead")}</p>
        </div>
        <div className="files__actions">
          {inTrash ? (
            <Button onClick={() => open({})}>{t("trash.back")}</Button>
          ) : (
            <>
              <Button icon={<Icon icon={Trash2} />} variant="ghost" onClick={() => open({ trash: "1" })}>
                {t("trash.open")}
              </Button>
              <Button icon={<Icon icon={FilePlus} />} onClick={() => setCreating(true)}>
                {t("drive.newDocument")}
              </Button>
              <Button variant="primary" icon={<Icon icon={Upload} />} onClick={() => picker.current?.click()}>
                {t("drive.upload")}
              </Button>
              <input
                ref={picker}
                type="file"
                multiple
                hidden
                aria-label={t("drive.upload")}
                data-testid="files-upload"
                onChange={(event) => {
                  const files = [...(event.target.files ?? [])];
                  event.target.value = "";
                  uploads.add(files);
                }}
              />
            </>
          )}
        </div>
      </header>
      <UploadTray queue={uploads} />
      {inTrash ? (
        <Trash workspaceId={workspaceId} />
      ) : (
        <FileList workspaceId={workspaceId} address={address} open={open} />
      )}
      {creating && (
        <NewDocumentDialog
          workspaceId={workspaceId}
          onClose={() => setCreating(false)}
          onCreated={(file) => {
            setCreating(false);
            open({ file: file.id });
          }}
        />
      )}
      {address.file !== undefined && !inTrash && (
        <Preview
          workspaceId={workspaceId}
          fileId={address.file}
          {...(address.v !== undefined && { version: address.v })}
          {...(address.p !== undefined && { page: address.p })}
          onClose={() => open({})}
          onVersion={(v) => open({ file: address.file, ...(v !== undefined && { v }) }, true)}
        />
      )}
    </div>
  );
}

function FileList({
  workspaceId,
  address,
  open,
}: {
  workspaceId: string;
  address: DriveAddress;
  open: (next: DriveAddress) => void;
}) {
  const t = useMessages("files");
  const { store } = useRuntime();
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<FileKind | null>(null);
  const [who, setWho] = useState<Who>("all");
  const [view, setView] = useState(() => readStored(store, STORAGE_KEYS.filesView, View) ?? "grid");
  const q = useDeferredValue(query.trim());
  const list = useApiQuery(
    "listFiles",
    { workspaceId, ...(q !== "" && { query: { q } }) },
    { refetchInterval: REFRESH_MS, refetchOnMount: "always", placeholderData: (previous) => previous },
  );

  const all = list.data ?? [];
  const kinds = FILE_KINDS.filter((candidate) => all.some((file) => file.kind === candidate));
  const shown = all.filter(
    (file) => (kind === null || file.kind === kind) && (who === "all" || file.createdBy.type === who),
  );
  const filtered = q !== "" || kind !== null || who !== "all";
  const clear = () => {
    setQuery("");
    setKind(null);
    setWho("all");
  };

  // With the preview open, the arrows move to the file beside it, in the list's order.
  useEffect(() => {
    const current = address.file;
    if (current === undefined) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT|VIDEO|AUDIO)$/.test(target.tagName))
      ) {
        return;
      }
      const at = shown.findIndex((file) => file.id === current);
      const next = shown[at + (event.key === "ArrowRight" ? 1 : -1)];
      if (at < 0 || next === undefined) return;
      event.preventDefault();
      open({ file: next.id });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [address.file, shown, open]);

  if (list.isError && list.data === undefined) {
    return (
      <ScreenError
        title={t("drive.failed")}
        error={list.error}
        onRetry={() => void list.refetch()}
        namespace="files"
      />
    );
  }
  if (list.isPending) return <ScreenLoading />;
  if (all.length === 0 && !filtered) {
    return (
      <EmptyState
        className="page__narrow"
        title={t("drive.empty.title")}
        description={t("drive.empty.body")}
      />
    );
  }

  return (
    <>
      <div className="files__toolbar">
        <Input
          type="search"
          value={query}
          maxLength={TITLE_MAX}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("drive.search")}
          aria-label={t("drive.search")}
        />
        <fieldset className="files__toggle">
          <legend className="vr-visually-hidden">{t("drive.view")}</legend>
          {(["grid", "list"] as const).map((choice) => (
            <Button
              key={choice}
              size="sm"
              variant={view === choice ? "secondary" : "ghost"}
              aria-pressed={view === choice}
              icon={<Icon icon={choice === "grid" ? LayoutGrid : List} />}
              onClick={() => {
                setView(choice);
                writeStored(store, STORAGE_KEYS.filesView, choice);
              }}
            >
              {t(`drive.view.${choice}`)}
            </Button>
          ))}
        </fieldset>
      </div>
      <fieldset className="files__filters">
        <legend className="vr-visually-hidden">{t("drive.filters")}</legend>
        {(["all", "person", "agent"] as const).map((choice) => (
          <Chip key={choice} selected={who === choice} onSelectedChange={() => setWho(choice)}>
            {t(`drive.who.${choice}`)}
          </Chip>
        ))}
        {kinds.map((choice) => (
          <Chip
            key={choice}
            selected={kind === choice}
            onSelectedChange={(selected) => setKind(selected ? choice : null)}
          >
            {t(`kind.${choice}`)}
          </Chip>
        ))}
      </fieldset>
      {shown.length === 0 ? (
        <EmptyState
          className="page__narrow"
          title={t("drive.none.title")}
          action={<Button onClick={clear}>{t("drive.none.clear")}</Button>}
        />
      ) : (
        <ul className={view === "grid" ? "files__grid" : "files__rows"} aria-label={t("drive.list")}>
          {shown.map((file) => (
            <FileItem
              key={file.id}
              workspaceId={workspaceId}
              file={file}
              view={view}
              onOpen={() => open({ file: file.id })}
            />
          ))}
        </ul>
      )}
      {q.length >= 2 && <ContentHits workspaceId={workspaceId} q={q} open={open} />}
    </>
  );
}

function FileItem({
  workspaceId,
  file,
  view,
  onOpen,
}: {
  workspaceId: string;
  file: DriveFile;
  view: "grid" | "list";
  onOpen: () => void;
}) {
  const t = useMessages("files");
  const name = useActorName(workspaceId);
  const when = useRelativeTime();
  const origin = useOrigin(workspaceId);
  return (
    <li className={view === "grid" ? "files__card" : "files__row"}>
      <button type="button" className="files__open" onClick={onOpen}>
        {view === "grid" && file.hasThumb === true ? (
          <Thumb workspaceId={workspaceId} file={file} />
        ) : (
          <span className="files__glyph" aria-hidden="true">
            <Icon icon={KIND_ICON[file.kind]} size={view === "grid" ? "lg" : "md"} />
          </span>
        )}
        <span className="files__name">{file.title}</span>
      </button>
      <span className="files__ear">
        {t("drive.kindVersion", { kind: t(`kind.${file.kind}`), version: file.version })}
      </span>
      <span className="files__meta">{name(file.createdBy)}</span>
      <span className="files__meta">{origin(file)}</span>
      <time className="files__meta" dateTime={file.updatedAt}>
        {when(file.updatedAt)}
      </time>
    </li>
  );
}

/** Where a file came from: its channel when the person sees it, a conversation, or only the Drive. */
function useOrigin(workspaceId: string): (file: DriveFile) => string {
  const t = useMessages("files");
  const channels = useApiQuery("listChannels", { workspaceId });
  return (file) => {
    if (file.channelId === null) return file.threadId === null ? t("origin.drive") : t("origin.conversation");
    const channel = channels.data?.find((candidate) => candidate.id === file.channelId);
    return channel === undefined ? t("origin.conversation") : t("origin.channel", { channel: channel.name });
  };
}

function Thumb({ workspaceId, file }: { workspaceId: string; file: DriveFile }) {
  const { url } = useBlobUrl({
    workspaceId,
    fileId: file.id,
    query: { version: file.version, format: "inline", variant: "thumb" },
  });
  if (url === undefined) {
    return (
      <span className="files__glyph" aria-hidden="true">
        <Icon icon={KIND_ICON[file.kind]} size="lg" />
      </span>
    );
  }
  return <img className="files__thumb" src={url} alt="" />;
}

/** Files whose text (a PDF, a document, slides) has the words: the snippet marked, and the page. */
function ContentHits({
  workspaceId,
  q,
  open,
}: {
  workspaceId: string;
  q: string;
  open: (next: DriveAddress) => void;
}) {
  const t = useMessages("files");
  const hits = useApiQuery("getSearch", { workspaceId, query: { q, kinds: ["file"], limit: CONTENT_HITS } });
  const list = hits.data ?? [];
  if (list.length === 0) return null;
  return (
    <section className="files__hits" aria-labelledby="files-hits-title">
      <h2 className="page__heading" id="files-hits-title">
        {t("drive.inContent")}
      </h2>
      <ul>
        {list.map((hit) => (
          <li key={`${hit.sourceId}:${hit.page ?? 0}`}>
            <button
              type="button"
              className="app-link-button"
              onClick={() => open({ file: hit.sourceId, ...(hit.page != null && { p: hit.page }) })}
            >
              {hit.title ?? hit.sourceId}
            </button>
            {hit.page != null && <span className="files__meta">{t("page", { page: hit.page })}</span>}
            <p className="files__snippet">
              <Marked text={hit.snippet} query={q} />
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}
