// A page's versions: who wrote each one (a person, an agent, or an agent for a person), when, and the
// note. The newest is picked at first; the picked one is compared with the one before it or with the
// current one, line by line and word by word, with the unchanged runs folded. Whoever may edit the
// page restores an older version, which becomes a new version.
import { useApiMutation, useApiQuery } from "@vanr/client/react";
import type { WikiDiff, WikiPage } from "@vanr/contract";
import { Button, Callout, Dialog, DialogContent, Icon, Radio, RadioGroup, Spinner } from "@vanr/ui";
import { RotateCcw } from "lucide-react";
import { useState } from "react";
import { useErrorMessage } from "../../../app/screens.tsx";
import { useMessages } from "../../../i18n/react.tsx";
import { useRelativeTime } from "../../../i18n/relative-time.tsx";
import { useActorName, versionNote } from "../shared.tsx";

type Against = "previous" | "current";

function DiffView({ diff }: { diff: WikiDiff }) {
  const t = useMessages("wiki");
  if (diff.from.version === diff.to.version) return <p className="page__muted">{t("history.same")}</p>;
  return (
    <div className="wiki-diff">
      <p className="wiki-diff__stats">
        {t("history.stats", {
          from: diff.from.version,
          to: diff.to.version,
          added: diff.stats.added,
          removed: diff.stats.removed,
        })}
      </p>
      {diff.from.title !== diff.to.title && (
        <p className="wiki-diff__title">
          {t("history.titleChanged", { from: diff.from.title, to: diff.to.title })}
        </p>
      )}
      {diff.props.length > 0 && (
        <ul className="wiki-diff__props" aria-label={t("history.props")}>
          {diff.props.map((prop) => (
            <li key={prop.propId}>
              {t("history.propChanged", {
                name: prop.name,
                before: prop.before || "—",
                after: prop.after || "—",
              })}
            </li>
          ))}
        </ul>
      )}
      <ol className="wiki-diff__lines" aria-label={t("history.lines")}>
        {diff.lines.map((line, index) =>
          line.kind === "gap" ? (
            // biome-ignore lint/suspicious/noArrayIndexKey: the lines of one comparison never move.
            <li key={index} className="wiki-diff__gap">
              {t("history.gap", { count: line.count })}
            </li>
          ) : (
            // biome-ignore lint/suspicious/noArrayIndexKey: the lines of one comparison never move.
            <li key={index} className={`wiki-diff__line wiki-diff__line--${line.kind}`}>
              {line.kind !== "same" && (
                <span className="vr-visually-hidden">
                  {t(line.kind === "add" ? "history.added" : "history.removed")}
                </span>
              )}
              {line.parts === undefined
                ? line.text
                : line.parts.map((part, at) =>
                    part.kind === "same" ? (
                      // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one line never move.
                      <span key={at}>{part.text}</span>
                    ) : (
                      // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one line never move.
                      <mark key={at} className={`wiki-diff__word wiki-diff__word--${part.kind}`}>
                        {part.text}
                      </mark>
                    ),
                  )}
            </li>
          ),
        )}
      </ol>
    </div>
  );
}

export function HistoryDialog({
  workspaceId,
  page,
  onClose,
  onRestored,
}: {
  workspaceId: string;
  page: WikiPage;
  onClose: () => void;
  onRestored: (page: WikiPage, from: number) => void;
}) {
  const t = useMessages("wiki");
  const common = useMessages("common");
  const describe = useErrorMessage("wiki");
  const when = useRelativeTime();
  const name = useActorName(workspaceId);
  const versions = page.history;
  const [picked, setPicked] = useState(versions[0]?.version ?? page.version);
  const [against, setAgainst] = useState<Against>("previous");
  // The first version is compared with itself: its whole text shows as it was.
  const from = against === "current" ? picked : Math.max(1, picked - 1);
  const to = against === "current" ? page.version : picked;
  const diff = useApiQuery("getWikiPageDiff", { workspaceId, pageId: page.slug, query: { from, to } });
  // The first version has none before it: its whole text is shown as it was.
  const first = from === to && against === "previous";
  const firstBody = useApiQuery(
    "getWikiPageVersion",
    { workspaceId, pageId: page.slug, versionId: String(picked) },
    { enabled: first },
  );
  const restore = useApiMutation("restoreWikiPageVersion", {
    // The version the request sent, not the one picked now: the person may have moved on meanwhile.
    onSuccess: (saved, args) => onRestored(saved, Number(args.versionId)),
  });

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        size="lg"
        title={t("history.title", { title: page.title })}
        closeLabel={common("action.close")}
        footer={
          page.editable && picked !== page.version ? (
            <Button
              variant="primary"
              icon={<Icon icon={RotateCcw} />}
              loading={restore.isPending}
              onClick={() =>
                restore.mutate({
                  workspaceId,
                  pageId: page.slug,
                  versionId: String(picked),
                  body: { parentVersion: page.version },
                })
              }
            >
              {t("history.restore", { version: picked })}
            </Button>
          ) : undefined
        }
      >
        <div className="wiki-history">
          <ol className="wiki-history__versions" aria-label={t("history.versions")}>
            {versions.map((version) => (
              <li key={version.version}>
                <button
                  type="button"
                  className="wiki-history__version"
                  aria-pressed={version.version === picked}
                  onClick={() => setPicked(version.version)}
                >
                  <span className="wiki-history__number">
                    {t("history.version", { version: version.version })}
                  </span>
                  <span className="wiki-history__who">
                    {version.author.actingFor === undefined
                      ? name(version.author)
                      : t("history.actingFor", {
                          agent: name(version.author),
                          person: name({ type: "person", id: version.author.actingFor }),
                        })}
                  </span>
                  <time className="wiki-history__when" dateTime={version.at}>
                    {when(version.at)}
                  </time>
                  {version.note !== null && version.note !== "" && (
                    <span className="wiki-history__note">{versionNote(version.note, t)}</span>
                  )}
                </button>
              </li>
            ))}
          </ol>
          <div className="wiki-history__compare">
            <RadioGroup
              aria-label={t("history.against")}
              orientation="horizontal"
              value={against}
              onValueChange={(value) => setAgainst(value === "current" ? "current" : "previous")}
            >
              <Radio value="previous" label={t("history.previous")} />
              <Radio value="current" label={t("history.current")} />
            </RadioGroup>
            {restore.isError && (
              <Callout tone="danger" role="alert" title={t("history.restoreFailed")}>
                {describe(restore.error)}
              </Callout>
            )}
            {first ? (
              firstBody.data !== undefined ? (
                <div className="wiki-diff">
                  <p className="wiki-diff__stats">{t("history.firstVersion")}</p>
                  <pre className="wiki-diff__lines wiki-diff__whole">{firstBody.data.body}</pre>
                </div>
              ) : firstBody.isError ? (
                <Callout
                  tone="danger"
                  role="alert"
                  title={t("history.failed")}
                  actions={
                    <Button size="sm" onClick={() => void firstBody.refetch()}>
                      {common("action.retry")}
                    </Button>
                  }
                >
                  {describe(firstBody.error)}
                </Callout>
              ) : (
                <p className="page__muted" role="status">
                  <Spinner /> {common("state.loading")}
                </p>
              )
            ) : diff.data === undefined ? (
              diff.isError ? (
                <Callout
                  tone="danger"
                  role="alert"
                  title={t("history.failed")}
                  actions={
                    <Button size="sm" onClick={() => void diff.refetch()}>
                      {common("action.retry")}
                    </Button>
                  }
                >
                  {describe(diff.error)}
                </Callout>
              ) : (
                <p className="page__muted" role="status">
                  <Spinner /> {common("state.loading")}
                </p>
              )
            ) : (
              <DiffView diff={diff.data} />
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
