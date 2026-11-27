// A wiki page: its title, the properties on top and the live block editor. Editing changes the page's
// shared draft, kept in sync with everyone on the page and saved by the server on its own; "Publish"
// makes it a version. The header says who changed it last, the version, the lock, who is here and
// where the draft stands. Beside it, the outline, the links and who reads it.
import { isApiError } from "@vanr/client";
import { useApiQuery, useVanrClient } from "@vanr/client/react";
import { can, type WikiAnchor, type WikiPropDef } from "@vanr/contract";
import {
  Avatar,
  Button,
  Callout,
  ConfirmDialog,
  Icon,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
  useToast,
} from "@vanr/ui";
import {
  Bot,
  Check,
  EyeOff,
  History,
  Lock,
  LockOpen,
  MessageSquarePlus,
  MoreHorizontal,
  Pin,
  PinOff,
  Trash2,
  Undo2,
  UserRoundCheck,
  Users,
} from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import { AppLink, useGo, useRouteParams } from "../../../app/navigation.tsx";
import { ScreenError, ScreenLoading, useDocumentTitle, useErrorMessage } from "../../../app/screens.tsx";
import { useMessages } from "../../../i18n/react.tsx";
import { useRelativeTime } from "../../../i18n/relative-time.tsx";
import { href } from "../../../routes.ts";
import { Editor, type EditorHandle, type EditorSource, type Picked } from "../editor/Editor.tsx";
import type { ResolvedLink } from "../editor/plugins.ts";
import { linkResolver, REFRESH_MS, TITLE_MAX, useActorName, useRole, useWikiRefresh } from "../shared.tsx";
import { AccessDialog, accessSummary } from "./Access.tsx";
import { Annotations, anchorFor } from "./Annotations.tsx";
import { type LiveEvent, settle, useLive } from "./collab.ts";
import { HistoryDialog } from "./History.tsx";
import { type MetaWrite, PropsBar } from "./Props.tsx";
import { SidePanel } from "./SidePanel.tsx";

const IMAGE = /\.(png|jpe?g|gif|webp|svg|avif)$/i;
/** A target with a file extension other than Markdown names an attachment. */
const ATTACHMENT = /\.[a-z0-9]{2,5}$/i;

export function WikiPageScreen() {
  const { workspaceId, pageId } = useRouteParams("wikiPage");
  // Each address is its own page: its own live document and its own state.
  return <PageView key={`${workspaceId}/${pageId}`} workspaceId={workspaceId} slug={pageId} />;
}

type Busy = null | "publish" | "discard" | "rename" | "meta" | "move" | "pin" | "lock" | "delete";

function PageView({ workspaceId, slug }: { workspaceId: string; slug: string }) {
  const t = useMessages("wiki");
  const common = useMessages("common");
  const describe = useErrorMessage("wiki");
  const when = useRelativeTime();
  const name = useActorName(workspaceId);
  const go = useGo();
  const toast = useToast();
  const { api } = useVanrClient();
  const { role, userId } = useRole(workspaceId);
  const refresh = useWikiRefresh(workspaceId);
  const page = useApiQuery("getWikiPage", { workspaceId, pageId: slug }, { refetchOnMount: "always" });
  const tree = useApiQuery("listWikiPages", { workspaceId }, { refetchInterval: REFRESH_MS });
  const schema = useApiQuery("listWikiProps", { workspaceId });
  const attachments = useApiQuery("listWikiAttachments", { workspaceId });
  const agents = useApiQuery("listAgents", { workspaceId });
  const [conflict, setConflict] = useState<number | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [title, setTitle] = useState<string | null>(null);
  const [history, setHistory] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [picked, setPicked] = useState<Picked | null>(null);
  const [anchor, setAnchor] = useState<WikiAnchor | null>(null);
  const editor = useRef<EditorHandle>(null);
  const p = page.data;
  useDocumentTitle(p?.title ?? t("index.title"));

  const onEvent = useCallback(
    (event: LiveEvent) => {
      if (event.type === "conflict") setConflict(event.version);
      else if (event.type === "published" || event.type === "discarded") setConflict(null);
      if (event.type === "rights") setConflict(null);
      if (event.type === "publish_failed" || event.type === "draft_save_failed")
        setFailure(
          new Error(t(event.type === "publish_failed" ? "draft.publishFailed" : "draft.saveFailed")),
        );
      void refresh();
    },
    [refresh, t],
  );
  const live = useLive(workspaceId, slug, p !== undefined, onEvent);

  const pages = tree.data ?? [];
  const resolveSlug = useMemo(() => linkResolver(pages), [pages]);
  const resolve = useCallback(
    (target: string): ResolvedLink => {
      const clean = target.trim();
      if (ATTACHMENT.test(clean) && !/\.md$/i.test(clean)) {
        const wanted = clean.toLowerCase();
        const hit = (attachments.data ?? []).find(
          (file) => file.path.toLowerCase() === wanted || file.path.toLowerCase().endsWith(`/${wanted}`),
        );
        if (hit !== undefined)
          return {
            kind: "file",
            fileId: hit.fileId,
            name: hit.path.split("/").pop() ?? hit.path,
            image: (hit.contentType ?? "").startsWith("image/") || IMAGE.test(hit.path),
          };
      }
      // `[[#Heading]]` points inside this page.
      const found = clean === "" ? slug : resolveSlug(clean);
      return found === null ? { kind: "missing" } : { kind: "page", slug: found };
    },
    [attachments.data, resolveSlug, slug],
  );
  const create = useCallback(
    (target: string) => void go("wiki", { workspaceId }, { search: { new: target } }),
    [go, workspaceId],
  );
  const hooks = useMemo(
    () => ({
      resolve,
      create,
      open: (to: string) => void go("wikiPage", { workspaceId, pageId: to }),
      openFile: (fileId: string) => void go("files", { workspaceId }, { search: { file: fileId } }),
      imageUrl: async (fileId: string) => {
        const download = await api.getFileBlob({ workspaceId, fileId, query: {} });
        return URL.createObjectURL(await download.blob());
      },
      href: (resolved: ResolvedLink, target: string) =>
        resolved.kind === "page"
          ? href("wikiPage", { workspaceId, pageId: resolved.slug })
          : resolved.kind === "file"
            ? href("files", { workspaceId }, { file: resolved.fileId })
            : href("wiki", { workspaceId }, { new: target }),
    }),
    [api, create, go, resolve, workspaceId],
  );
  // Each source keeps its identity while its document is the same: a new object would make the editor
  // again, losing the cursor and the undo history (a pin or a status change gives a new page object).
  const liveSource = useMemo<EditorSource | null>(
    () => (live.live === null ? null : { kind: "live", live: live.live }),
    [live.live],
  );
  const body = p?.body;
  const staticSource = useMemo<EditorSource | null>(
    () => (body === undefined ? null : { kind: "static", body }),
    [body],
  );
  const source = liveSource !== null && live.ready && live.status !== "denied" ? liveSource : staticSource;

  if (p === undefined) {
    if (page.isError && isApiError(page.error) && page.error.status === 404)
      return (
        <div className="page wiki">
          <h1 className="page__title">{t("page.missing.title")}</h1>
          <p className="page__lead">{t("page.missing.body")}</p>
          <Button variant="primary" onClick={() => create(slug)}>
            {t("page.missing.create")}
          </Button>
        </div>
      );
    if (page.isError)
      return (
        <ScreenError
          title={t("page.failed")}
          error={page.error}
          onRetry={() => void page.refetch()}
          namespace="wiki"
        />
      );
    return <ScreenLoading />;
  }

  const admin = can(role, "configure");
  const firstAuthor = p.history.at(-1)?.author;
  // Who created the page, as the server counts it: their own first version, or an agent's made for them.
  const createdIt =
    firstAuthor?.type === "person" ? firstAuthor.id === userId : firstAuthor?.actingFor === userId;
  const mayDelete = admin || (!p.locked && createdIt);
  // Offline, the live document still takes edits: they wait in it and sync on reconnect.
  // One rule for every write control: the page says this person may edit it, and the live document has
  // not said otherwise since (a lock seen live, a revoked read).
  const canWrite = p.editable && live.status !== "denied" && !live.readOnly;
  const editable = canWrite && source?.kind === "live";
  const dirty = live.touched || p.draft?.dirty === true;
  const agentName = (id: string) => agents.data?.find((agent) => agent.id === id)?.name;

  /** Runs one action of the page at a time, shows its failure, and reads the wiki again after it. */
  const run = async (what: Exclude<Busy, null>, action: () => Promise<void>): Promise<boolean> => {
    setBusy(what);
    setFailure(null);
    try {
      await action();
      return true;
    } catch (error) {
      setFailure(error);
      return false;
    } finally {
      setBusy(null);
      await refresh();
    }
  };

  const publish = (force = false) =>
    run("publish", async () => {
      // What is still on its way to the server goes in first.
      if (!(await settle(live.live))) throw new Error(t("draft.stillSyncing"));
      try {
        const saved = await api.publishWikiPageDraft({
          workspaceId,
          pageId: slug,
          body: force ? { force } : {},
        });
        setConflict(null);
        live.clearTouched();
        toast.push({ tone: "success", title: t("draft.publishedToast", { version: saved.version }) });
      } catch (error) {
        if (isApiError(error) && error.status === 409) {
          const current = error.params?.currentVersion;
          setConflict(typeof current === "number" ? current : p.version);
          return;
        }
        throw error;
      }
    });

  const discard = () =>
    run("discard", async () => {
      await api.deleteWikiPageDraft({ workspaceId, pageId: slug });
      setConflict(null);
      live.clearTouched();
    });

  const rename = (next: string) =>
    run("rename", async () => {
      const saved = await api.renameWikiPage({ workspaceId, pageId: slug, body: { title: next } });
      setTitle(null);
      const rewritten = saved.relinked?.rewritten.length ?? 0;
      const skipped = saved.relinked?.skipped.length ?? 0;
      if (rewritten > 0) toast.push({ tone: "success", title: t("page.relinked", { count: rewritten }) });
      if (skipped > 0)
        toast.push({ tone: "warning", title: t("page.relinkSkipped", { count: skipped, title: p.title }) });
    });

  const writeMeta = (write: MetaWrite) =>
    run("meta", async () => {
      try {
        await api.updateWikiPageMeta({
          workspaceId,
          pageId: slug,
          body: { parentVersion: p.version, ...write },
        });
      } catch (error) {
        if (!(isApiError(error) && error.status === 409)) throw error;
        // Someone saved in between: once more, on the version that is current now.
        const fresh = await page.refetch();
        await api.updateWikiPageMeta({
          workspaceId,
          pageId: slug,
          body: { parentVersion: fresh.data?.version ?? p.version, ...write },
        });
      }
    });

  const saveDefs = async (defs: WikiPropDef[]) => {
    const current = schema.data ?? { defs: [], version: 0 };
    await api.setWikiProps({ workspaceId, body: { defs, parentVersion: current.version } });
    await refresh();
  };

  const status =
    live.status === "denied"
      ? { tone: "neutral" as const, text: t("draft.readOnly") }
      : live.status === "offline"
        ? { tone: "warning" as const, text: t("draft.offline") }
        : live.status === "connecting"
          ? { tone: "neutral" as const, text: t("draft.connecting") }
          : conflict !== null
            ? { tone: "danger" as const, text: t("draft.conflict") }
            : live.unsynced > 0
              ? { tone: "neutral" as const, text: t("draft.saving") }
              : dirty
                ? { tone: "warning" as const, text: t("draft.unpublished") }
                : { tone: "success" as const, text: t("draft.published", { version: p.version }) };

  return (
    <div className="page wiki wiki-page">
      <header className="wiki-page__head">
        <div className="wiki-page__where">
          <nav aria-label={t("page.breadcrumb")} className="wiki-page__crumbs">
            <AppLink route="wiki" params={{ workspaceId }}>
              {t("index.title")}
            </AppLink>
            {p.folder !== "" && <span aria-hidden="true"> / </span>}
            {p.folder !== "" && <span>{p.folder}</span>}
          </nav>
          <p className="wiki-page__meta">
            {t("page.updated", { who: name(p.updatedBy), when: when(p.updatedAt), version: p.version })}
            {p.locked && (
              <span className="wiki-page__lock">
                <Icon icon={Lock} /> {t("page.locked")}
              </span>
            )}
            {p.restricted && (
              <span className="wiki-page__restricted">
                <Icon icon={EyeOff} /> {accessSummary(p, t)}
              </span>
            )}
          </p>
        </div>
        <ul className="wiki-page__presence" aria-label={t("live.presence")}>
          {live.peers.map((peer) => (
            <li key={peer.clientId} title={peer.name}>
              {peer.kind === "agent" ? (
                <span
                  className="wiki-page__agent"
                  role="img"
                  aria-label={t("live.agent", { name: peer.name })}
                >
                  <Icon icon={Bot} />
                </span>
              ) : (
                <Avatar name={peer.name} size="sm" />
              )}
            </li>
          ))}
        </ul>
        <span className="wiki-page__status" role="status" data-tone={status.tone}>
          {status.text}
        </span>
        {canWrite && dirty && conflict === null && live.status === "synced" && (
          <Button
            variant="primary"
            icon={<Icon icon={Check} />}
            loading={busy === "publish"}
            onClick={() => void publish()}
          >
            {t("draft.publish")}
          </Button>
        )}
        <Menu>
          <MenuTrigger asChild>
            <Button variant="ghost" icon={<Icon icon={MoreHorizontal} />} aria-label={t("page.actions")} />
          </MenuTrigger>
          <MenuContent align="end">
            <MenuItem icon={<Icon icon={History} />} onSelect={() => setHistory(true)}>
              {t("page.history")}
            </MenuItem>
            {canWrite && dirty && (
              <MenuItem icon={<Icon icon={Undo2} />} onSelect={() => void discard()}>
                {t("draft.discard")}
              </MenuItem>
            )}
            <MenuItem
              icon={<Icon icon={p.pinned ? PinOff : Pin} />}
              onSelect={() =>
                void run("pin", async () => {
                  await api.pinWikiPage({ workspaceId, pageId: slug, body: { pinned: !p.pinned } });
                })
              }
            >
              {p.pinned ? t("page.unpin") : t("page.pin")}
            </MenuItem>
            {admin && (
              <MenuItem
                icon={<Icon icon={p.locked ? LockOpen : Lock} />}
                onSelect={() =>
                  void run("lock", async () => {
                    await api.lockWikiPage({ workspaceId, pageId: slug, body: { locked: !p.locked } });
                  })
                }
              >
                {p.locked ? t("page.unlock") : t("page.lock")}
              </MenuItem>
            )}
            {p.accessEditable && (
              <MenuItem icon={<Icon icon={Users} />} onSelect={() => setSharing(true)}>
                {t("access.open")}
              </MenuItem>
            )}
            {canWrite && (
              <MenuItem
                icon={<Icon icon={UserRoundCheck} />}
                onSelect={() =>
                  void writeMeta({ agentEdits: p.agentEdits === "propose" ? "direct" : "propose" })
                }
              >
                {p.agentEdits === "propose" ? t("page.agentsEdit") : t("page.agentsPropose")}
              </MenuItem>
            )}
            {mayDelete && (
              <MenuItem tone="danger" icon={<Icon icon={Trash2} />} onSelect={() => setDeleting(true)}>
                {t("page.delete")}
              </MenuItem>
            )}
          </MenuContent>
        </Menu>
      </header>
      <div className="wiki-page__body">
        <article className="wiki-doc" data-draft={status.tone}>
          {canWrite ? (
            <input
              className="wiki-doc__title"
              aria-label={t("page.title")}
              value={title ?? p.title}
              maxLength={TITLE_MAX}
              onChange={(event) => setTitle(event.target.value)}
              onBlur={() => {
                const next = (title ?? p.title).trim();
                if (next !== "" && next !== p.title) void rename(next);
                else setTitle(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  editor.current?.focus();
                } else if (event.key === "Escape") setTitle(null);
              }}
            />
          ) : (
            <h1 className="wiki-doc__title">{p.title}</h1>
          )}
          {schema.data !== undefined && (
            <PropsBar
              workspaceId={workspaceId}
              page={p}
              defs={schema.data.defs}
              editable={canWrite}
              busy={busy === "meta"}
              onMeta={writeMeta}
              onMove={(folder) =>
                run("move", async () => {
                  await api.moveWikiPage({ workspaceId, pageId: slug, body: { folder } });
                })
              }
              onDefs={(defs) => run("meta", () => saveDefs(defs))}
            />
          )}
          {failure !== null && (
            <Callout tone="danger" role="alert" title={t("page.actionFailed")}>
              {failure instanceof Error && !isApiError(failure) ? failure.message : describe(failure)}
            </Callout>
          )}
          {conflict !== null && (
            <Callout
              tone="warning"
              role="alert"
              title={t("draft.conflictTitle")}
              actions={
                <>
                  <Button size="sm" variant="ghost" onClick={() => setHistory(true)}>
                    {t("draft.seeHistory")}
                  </Button>
                  {canWrite && live.status === "synced" && (
                    <>
                      <Button
                        size="sm"
                        variant="ghost"
                        loading={busy === "discard"}
                        onClick={() => void discard()}
                      >
                        {t("draft.discardMine")}
                      </Button>
                      <Button
                        size="sm"
                        variant="primary"
                        loading={busy === "publish"}
                        onClick={() => void publish(true)}
                      >
                        {t("draft.publishOver", { version: conflict })}
                      </Button>
                    </>
                  )}
                </>
              }
            >
              {t("draft.conflictBody", { version: conflict })}
            </Callout>
          )}
          {live.status === "denied" && (
            <p className="page__muted" role="note">
              {t("draft.readOnlyBody")}
            </p>
          )}
          <div className="wiki-doc__tools">
            <Button
              size="sm"
              variant="ghost"
              icon={<Icon icon={MessageSquarePlus} />}
              disabled={picked === null}
              onClick={() => {
                if (picked !== null) setAnchor(anchorFor(p.body, picked));
              }}
            >
              {t("comments.onSelection")}
            </Button>
          </div>
          {source !== null && source.kind === "static" && p.body.trim() === "" ? (
            <p className="wiki-doc__empty">{t("page.empty")}</p>
          ) : (
            source !== null && (
              <Editor
                // A new published text, while the live document is away, is a new read-only document.
                key={source.kind}
                ref={editor}
                source={source}
                editable={editable}
                label={t("page.editor", { title: p.title })}
                pages={pages}
                hooks={hooks}
                onPick={setPicked}
              />
            )
          )}
        </article>
        <SidePanel
          workspaceId={workspaceId}
          page={p}
          agentName={agentName}
          onHeading={(index) => editor.current?.scrollToHeading(index)}
          onCreate={create}
        >
          <Annotations
            workspaceId={workspaceId}
            page={{ ...p, editable: canWrite }}
            draft={anchor}
            onDraftDone={() => setAnchor(null)}
            onDecided={(saved) => {
              toast.push({ tone: "success", title: t("proposals.decided", { version: saved.version }) });
              void refresh();
            }}
          />
        </SidePanel>
      </div>
      {sharing && (
        <AccessDialog
          workspaceId={workspaceId}
          page={p}
          userId={userId}
          onClose={() => setSharing(false)}
          onSaved={(saved) => {
            setSharing(false);
            void refresh();
            // Restricting gives the page a new address, so the old one no longer tells it exists.
            if (saved.slug !== slug)
              void go("wikiPage", { workspaceId, pageId: saved.slug }, { replace: true });
          }}
        />
      )}
      {history && (
        <HistoryDialog
          workspaceId={workspaceId}
          page={{ ...p, editable: canWrite }}
          onClose={() => setHistory(false)}
          onRestored={(saved, from) => {
            setHistory(false);
            toast.push({ tone: "success", title: t("history.restored", { from, version: saved.version }) });
            void refresh();
          }}
        />
      )}
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        tone="danger"
        title={t("page.deleteTitle", { title: p.title })}
        description={t("page.deleteBody")}
        confirmLabel={t("page.delete")}
        cancelLabel={common("action.cancel")}
        confirming={busy === "delete"}
        onConfirm={() =>
          void run("delete", async () => {
            await api.deleteWikiPage({ workspaceId, pageId: slug });
            setDeleting(false);
            await go("wiki", { workspaceId });
          })
        }
      />
    </div>
  );
}
