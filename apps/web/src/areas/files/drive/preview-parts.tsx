// The content of a file version as the preview shows it: written content drawn from its data, and an
// uploaded file by the type its bytes have (image, PDF, audio, video), a converted preview, its plain
// text, the text read from each page, or just its type and size.
import type { ArgsOf } from "@vanr/client";
import { useApiQuery, useVanrClient } from "@vanr/client/react";
import type { FileContent, FileDetail } from "@vanr/contract";
import { Button, Callout, Chip } from "@vanr/ui";
import { useEffect, useRef, useState } from "react";
import { ScreenError, ScreenLoading } from "../../../app/screens.tsx";
import { useLocale, useMessages } from "../../../i18n/react.tsx";
import { formatBytes } from "../shared.tsx";

type UploadedContent = Extract<FileContent, { kind: "file" }>;

const IMAGE = /^image\/(png|jpeg|gif|webp|avif|bmp)$/;

/**
 * A local address for a version's bytes, read through the client: `url` once they arrive, `failed` when
 * they could not be read (with `retry`). Nothing is fetched while `enabled` is false.
 */
export function useBlobUrl(
  args: ArgsOf<"getFileBlob">,
  enabled = true,
): { url: string | undefined; failed: boolean; retry: () => void } {
  const client = useVanrClient();
  const [url, setUrl] = useState<string>();
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const key = JSON.stringify(args);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for `args`, a new object on every render; `attempt` asks again.
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let made: string | undefined;
    setUrl(undefined);
    setFailed(false);
    client.api
      .getFileBlob(args, { signal: controller.signal })
      .then((download) => download.blob())
      .then((blob) => {
        if (controller.signal.aborted) return;
        made = URL.createObjectURL(blob);
        setUrl(made);
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => {
      controller.abort();
      if (made !== undefined) URL.revokeObjectURL(made);
    };
  }, [client, key, enabled, attempt]);
  return { url, failed, retry: () => setAttempt((n) => n + 1) };
}

/** Where the reading of the file's text stands: working, done with its pages, or failed and why. */
function ExtractChip({ content }: { content: UploadedContent }) {
  const t = useMessages("files");
  if (content.extract === "none" || (content.extract === "ready" && content.totalPages === 0)) return null;
  if (content.extract === "ready") return <Chip>{t("extract.ready", { count: content.totalPages })}</Chip>;
  if (content.extract === "failed") {
    return <Chip className="files__chip--failed">{t("extract.failed")}</Chip>;
  }
  return <Chip>{t("extract.working")}</Chip>;
}

/** The text read from each page; the page the search cited is marked and scrolled into view. */
function ExtractedText({
  workspaceId,
  detail,
  page,
}: {
  workspaceId: string;
  detail: FileDetail;
  page?: number;
}) {
  const t = useMessages("files");
  const text = useApiQuery("getFileText", {
    workspaceId,
    fileId: detail.id,
    query: { version: detail.viewVersion },
  });
  const box = useRef<HTMLElement>(null);
  useEffect(() => {
    if (page === undefined || text.data === undefined) return;
    box.current?.querySelector(`[data-page="${page}"]`)?.scrollIntoView?.({ block: "start" });
  }, [page, text.data]);
  if (text.isPending) return <ScreenLoading />;
  if (text.isError) {
    return <ScreenError error={text.error} onRetry={() => void text.refetch()} namespace="files" />;
  }
  return (
    <section className="files__pages" ref={box} aria-label={t("preview.pages")}>
      {text.data.pages.map((each) => (
        <section
          key={each.page}
          data-page={each.page}
          className={each.page === page ? "files__page files__page--cited" : "files__page"}
          aria-current={each.page === page ? "location" : undefined}
        >
          <h3 className="files__page-title">{t("page", { page: each.page })}</h3>
          <pre className="files__text">{each.markdown}</pre>
        </section>
      ))}
    </section>
  );
}

function Uploaded({
  workspaceId,
  detail,
  content,
  page,
}: {
  workspaceId: string;
  detail: FileDetail;
  content: UploadedContent;
  page?: number;
}) {
  const t = useMessages("files");
  const common = useMessages("common");
  const { locale } = useLocale();
  const type = content.detectedType ?? "";
  const media = IMAGE.test(type) || type === "application/pdf" || /^(audio|video)\//.test(type);
  const showsPreview = !media && content.hasPreview;
  // Only the views that show the bytes read them: plain text, pages and metadata need none.
  const { url, failed, retry } = useBlobUrl(
    {
      workspaceId,
      fileId: detail.id,
      query: {
        version: detail.viewVersion,
        format: "inline",
        variant: showsPreview ? "preview" : "original",
      },
    },
    media || showsPreview,
  );
  const atPage = page === undefined ? "" : `#page=${page}`;
  let view: React.ReactNode;
  if (media || showsPreview) {
    if (failed) {
      view = (
        <Callout
          tone="danger"
          role="alert"
          title={t("preview.mediaFailed")}
          actions={<Button onClick={retry}>{common("action.retry")}</Button>}
        >
          {t("preview.binary", {
            type: content.detectedType ?? content.contentType,
            size: formatBytes(content.size, locale),
          })}
        </Callout>
      );
    } else if (url === undefined) view = <ScreenLoading />;
    else if (IMAGE.test(type)) view = <img className="files__image" src={url} alt={detail.title} />;
    else if (type.startsWith("video/"))
      // biome-ignore lint/a11y/useMediaCaption: a file someone uploaded, with no captions to attach.
      view = <video className="files__media" src={url} controls preload="metadata" />;
    else if (type.startsWith("audio/"))
      // biome-ignore lint/a11y/useMediaCaption: a file someone uploaded, with no captions to attach.
      view = <audio src={url} controls preload="metadata" />;
    else view = <iframe className="files__frame" title={detail.title} src={`${url}${atPage}`} />;
  } else if (content.text !== null) view = <pre className="files__text">{content.text}</pre>;
  else if (content.totalPages > 0)
    view = <ExtractedText workspaceId={workspaceId} detail={detail} {...(page !== undefined && { page })} />;
  else {
    view = (
      <p className="page__muted">
        {t("preview.binary", {
          type: content.detectedType ?? content.contentType,
          size: formatBytes(content.size, locale),
        })}
      </p>
    );
  }
  return (
    <div className="files__stack">
      <ExtractChip content={content} />
      {view}
    </div>
  );
}

export function FileBody({
  workspaceId,
  detail,
  page,
}: {
  workspaceId: string;
  detail: FileDetail;
  page?: number;
}) {
  const content = detail.content;
  switch (content.kind) {
    case "document":
      return <div className="files__document">{content.markdown}</div>;
    case "table":
      return (
        <div className="files__table">
          <table>
            <thead>
              <tr>
                {content.columns.map((column, index) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: the columns of one version never move.
                  <th key={index} scope="col">
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {content.rows.map((row, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: the rows of one version never move.
                <tr key={index}>
                  {row.map((cell, column) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: the cells of one version never move.
                    <td key={column}>{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "diff":
      return (
        <div className="files__stack">
          {content.files.map((changed) => (
            <section key={changed.path}>
              <h3 className="files__page-title">{changed.path}</h3>
              <pre className="files__text">{changed.patch}</pre>
            </section>
          ))}
        </div>
      );
    case "diagram":
      return <pre className="files__text">{content.mermaid}</pre>;
    case "html":
      return <iframe className="files__frame" title={detail.title} sandbox="" srcDoc={content.html} />;
    case "file":
      return (
        <Uploaded
          workspaceId={workspaceId}
          detail={detail}
          content={content}
          {...(page !== undefined && { page })}
        />
      );
  }
}
