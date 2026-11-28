// The wiki's index: the tree of folders, with a search on the server (title, body and tags) and a
// filter by tag; beside it the pinned pages, the recent ones and the most read. The header creates a
// page (`?new=Title` opens the form filled in, which is where a [[link]] with no page sends), imports
// notes or a vault, exports the wiki and opens the trash. There is no wiki event: the tree is asked
// again on open and about once a minute.
import { useApiQuery } from "@vanr/client/react";
import type { WikiPageSummary } from "@vanr/contract";
import {
  Button,
  Callout,
  Chip,
  EmptyState,
  Icon,
  Input,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
  Spinner,
} from "@vanr/ui";
import {
  ChevronRight,
  Download,
  EyeOff,
  FilePlus,
  Folder,
  Lock,
  MoreHorizontal,
  Pin,
  Trash2,
  Upload,
} from "lucide-react";
import { type ReactNode, useDeferredValue, useRef, useState } from "react";
import { z } from "zod";
import { AppLink, useGo, useRouteParams, useSearch } from "../../../app/navigation.tsx";
import { ScreenError, ScreenLoading, useDocumentTitle, useErrorMessage } from "../../../app/screens.tsx";
import { useMessages } from "../../../i18n/react.tsx";
import { useRelativeTime } from "../../../i18n/relative-time.tsx";
import { FOLDER_MAX, REFRESH_MS, SEARCH_MAX, TITLE_MAX } from "../shared.tsx";
import { CreatePageDialog } from "./CreatePage.tsx";
import { TrashDialog } from "./Trash.tsx";
import { useWikiTransfer } from "./transfer.ts";

const RECENT = 8;
const MOST_READ = 5;

/** A [[link]] path: a folder, a slash and a title, each as long as the server takes. */
const IndexAddress = z.object({
  new: z
    .string()
    .max(FOLDER_MAX + 1 + TITLE_MAX)
    .optional(),
});
type IndexAddress = z.infer<typeof IndexAddress>;
const EMPTY: IndexAddress = {};

export function WikiIndexScreen() {
  const { workspaceId } = useRouteParams("wiki");
  return <WikiIndex key={workspaceId} workspaceId={workspaceId} />;
}

function PageLink({ workspaceId, page }: { workspaceId: string; page: WikiPageSummary }) {
  const t = useMessages("wiki");
  return (
    <AppLink route="wikiPage" params={{ workspaceId, pageId: page.slug }} className="wiki-index__link">
      <span className="wiki-index__title">{page.title}</span>
      {page.pinned && <Icon icon={Pin} label={t("page.pinned")} />}
      {page.locked && <Icon icon={Lock} label={t("page.locked")} />}
      {page.restricted && <Icon icon={EyeOff} label={t("access.restricted")} />}
    </AppLink>
  );
}

function WikiIndex({ workspaceId }: { workspaceId: string }) {
  const t = useMessages("wiki");
  const common = useMessages("common");
  const go = useGo();
  const address = useSearch(IndexAddress, EMPTY);
  const when = useRelativeTime();
  const describe = useErrorMessage("wiki");
  const tree = useApiQuery(
    "listWikiPages",
    { workspaceId },
    { refetchInterval: REFRESH_MS, refetchOnMount: "always" },
  );
  const reads = useApiQuery("getWikiReads", { workspaceId });
  const [query, setQuery] = useState("");
  const [tag, setTag] = useState<string | null>(null);
  const [trashOpen, setTrashOpen] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const transfer = useWikiTransfer(workspaceId);
  useDocumentTitle(t("index.title"));

  const needle = useDeferredValue(query.trim());
  const found = useApiQuery(
    "getWikiSearch",
    { workspaceId, query: { q: needle } },
    { enabled: needle !== "", placeholderData: (previous) => previous },
  );
  // The form opens from the button, or from the address a [[link]] with no page sends to (`?new=`).
  const [formOpen, setFormOpen] = useState(false);
  const creating = address.new ?? (formOpen ? "" : undefined);
  const setCreating = (title: string | undefined) => {
    setFormOpen(title !== undefined);
    if (title === undefined && address.new !== undefined) void go("wiki", { workspaceId }, { search: {} });
  };

  const pages = tree.data ?? [];
  const base = needle === "" ? pages : (found.data ?? []);
  const shown = base.filter((page) => tag === null || page.tags.includes(tag));
  const folders = [...new Set(shown.map((page) => page.folder))].sort((a, b) => a.localeCompare(b));
  const tags = [...new Set(pages.flatMap((page) => page.tags))].sort((a, b) => a.localeCompare(b));
  const pinned = pages.filter((page) => page.pinned);
  const recent = [...pages].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, RECENT);
  const mostRead = (reads.data ?? []).slice(0, MOST_READ);

  const header = (
    <header className="wiki-index__head">
      <div>
        <h1 className="page__title">{t("index.title")}</h1>
        <p className="page__muted">
          {tree.data === undefined ? t("index.lead") : t("index.count", { count: pages.length })}
        </p>
      </div>
      <div className="wiki-index__actions">
        <Button
          icon={<Icon icon={Upload} />}
          loading={transfer.importing}
          onClick={() => picker.current?.click()}
        >
          {t("import.action")}
        </Button>
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          accept=".md,.zip,text/markdown,application/zip"
          aria-label={t("import.action")}
          data-testid="wiki-import"
          onChange={(event) => {
            const files = [...(event.target.files ?? [])];
            event.target.value = "";
            if (files.length > 0) void transfer.importFiles(files);
          }}
        />
        <Menu>
          <MenuTrigger asChild>
            <Button variant="ghost" icon={<Icon icon={MoreHorizontal} />} aria-label={t("index.more")} />
          </MenuTrigger>
          <MenuContent align="end">
            <MenuItem icon={<Icon icon={Download} />} onSelect={() => void transfer.exportWiki()}>
              {t("export.action")}
            </MenuItem>
            <MenuItem icon={<Icon icon={Trash2} />} onSelect={() => setTrashOpen(true)}>
              {t("trash.open")}
            </MenuItem>
          </MenuContent>
        </Menu>
        <Button variant="primary" icon={<Icon icon={FilePlus} />} onClick={() => setCreating("")}>
          {t("create.action")}
        </Button>
      </div>
    </header>
  );

  let body: ReactNode;
  if (tree.isPending) body = <ScreenLoading />;
  else if (tree.isError && tree.data === undefined)
    body = (
      <ScreenError
        title={t("index.failed")}
        error={tree.error}
        onRetry={() => void tree.refetch()}
        namespace="wiki"
      />
    );
  else if (pages.length === 0)
    body = (
      <EmptyState
        className="page__narrow"
        title={t("index.empty.title")}
        description={t("index.empty.body")}
        action={
          <Button variant="primary" onClick={() => setCreating("")}>
            {t("create.first")}
          </Button>
        }
      />
    );
  else
    body = (
      <div className="wiki-index">
        <nav className="wiki-index__tree" aria-label={t("index.tree")}>
          <Input
            type="search"
            value={query}
            maxLength={SEARCH_MAX}
            placeholder={t("index.search")}
            aria-label={t("index.search")}
            onChange={(event) => setQuery(event.target.value)}
          />
          {tags.length > 0 && (
            <fieldset className="wiki-index__tags">
              <legend className="vr-visually-hidden">{t("index.tags")}</legend>
              {tags.map((name) => (
                <Chip key={name} selected={tag === name} onSelectedChange={(on) => setTag(on ? name : null)}>
                  #{name}
                </Chip>
              ))}
            </fieldset>
          )}
          {needle !== "" && found.isError && found.data === undefined ? (
            <Callout
              tone="danger"
              role="alert"
              title={t("index.searchFailed")}
              actions={
                <Button size="sm" onClick={() => void found.refetch()}>
                  {common("action.retry")}
                </Button>
              }
            >
              {describe(found.error)}
            </Callout>
          ) : needle !== "" && found.isFetching ? (
            <p className="page__muted" role="status">
              <Spinner /> {t("index.searching")}
            </p>
          ) : shown.length === 0 ? (
            <p className="page__muted" role="status">
              {t("index.noResults")}
            </p>
          ) : null}
          {folders.map((folder) => {
            const inFolder = shown.filter((page) => page.folder === folder);
            return (
              <details key={folder === "" ? "/" : folder} className="wiki-index__folder" open>
                <summary>
                  <Icon icon={ChevronRight} className="wiki-index__chevron" />
                  <Icon icon={Folder} />
                  <span>{folder === "" ? t("index.root") : folder}</span>
                  <span className="wiki-index__count">{inFolder.length}</span>
                </summary>
                <ul className="wiki-index__pages">
                  {inFolder.map((page) => (
                    <li key={page.slug}>
                      <PageLink workspaceId={workspaceId} page={page} />
                    </li>
                  ))}
                </ul>
              </details>
            );
          })}
        </nav>
        <div className="wiki-index__side">
          {pinned.length > 0 && (
            <section aria-labelledby="wiki-pinned">
              <h2 id="wiki-pinned" className="wiki-index__heading">
                {t("index.pinned")}
              </h2>
              <ul className="wiki-index__cards">
                {pinned.map((page) => (
                  <li key={page.slug} className="wiki-index__card">
                    <PageLink workspaceId={workspaceId} page={page} />
                    {page.excerpt !== "" && <p className="wiki-index__excerpt">{page.excerpt}</p>}
                  </li>
                ))}
              </ul>
            </section>
          )}
          <section aria-labelledby="wiki-recent">
            <h2 id="wiki-recent" className="wiki-index__heading">
              {t("index.recent")}
            </h2>
            <ul className="wiki-index__cards">
              {recent.map((page) => (
                <li key={page.slug} className="wiki-index__card">
                  <PageLink workspaceId={workspaceId} page={page} />
                  {page.excerpt !== "" && <p className="wiki-index__excerpt">{page.excerpt}</p>}
                  <time className="wiki-index__when" dateTime={page.updatedAt}>
                    {when(page.updatedAt)}
                  </time>
                </li>
              ))}
            </ul>
          </section>
          {mostRead.length > 0 && (
            <section aria-labelledby="wiki-read">
              <h2 id="wiki-read" className="wiki-index__heading">
                {t("index.mostRead")}
              </h2>
              <ol className="wiki-index__ranked">
                {mostRead.map((read) => (
                  <li key={read.slug}>
                    <AppLink route="wikiPage" params={{ workspaceId, pageId: read.slug }}>
                      {read.title}
                    </AppLink>
                    <Chip>{t("index.reads", { count: read.total })}</Chip>
                  </li>
                ))}
              </ol>
            </section>
          )}
        </div>
      </div>
    );

  return (
    <div className="page wiki">
      {header}
      {transfer.notice !== null && (
        <Callout
          tone={transfer.notice.tone}
          role={transfer.notice.tone === "danger" ? "alert" : "status"}
          title={transfer.notice.title}
        >
          {transfer.notice.detail}
        </Callout>
      )}
      {body}
      {creating !== undefined && (
        <CreatePageDialog
          workspaceId={workspaceId}
          initial={creating}
          onClose={() => setCreating(undefined)}
          onCreated={(slug) => void go("wikiPage", { workspaceId, pageId: slug })}
        />
      )}
      {trashOpen && <TrashDialog workspaceId={workspaceId} onClose={() => setTrashOpen(false)} />}
    </div>
  );
}
