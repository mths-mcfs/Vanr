// The workspace's search: messages in the channels the person reads, files (with the text inside and
// its page), wiki pages, issues and debates. The server reads the operators (`from:`, `in:`, `has:`,
// `is:`, `before:`, `after:`, quotes and `-`). "Ask" answers in parts, each pointing at numbered
// sources. The query lives in the address, so a search can be shared and the back button works.
import { isApiError } from "@vanr/client";
import { useApiMutation, useApiQuery } from "@vanr/client/react";
import type { AskAnswer, SearchHit, SearchKind } from "@vanr/contract";
import { Button, Callout, Chip, EmptyState, Icon, Input } from "@vanr/ui";
import { Sparkles } from "lucide-react";
import { type ReactNode, useDeferredValue, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { AppLink, useGo, useRouteParams, useSearch } from "../../../app/navigation.tsx";
import { ScreenError, ScreenLoading, useDocumentTitle, useErrorMessage } from "../../../app/screens.tsx";
import { useMessages } from "../../../i18n/react.tsx";
import { Marked, TITLE_MAX, useActorName, useRelativeTime } from "../shared.tsx";

/** The server returns at most this many hits of each kind. */
export const PER_KIND = 30;
const MIN_QUERY = 2;

export const SEARCH_KINDS = [
  "message",
  "file",
  "wiki",
  "issue",
  "debate",
] as const satisfies readonly SearchKind[];

/** Examples of each operator, put into the query by the help. */
const OPERATORS = [
  "from:@ana",
  "in:#general",
  "has:link",
  "is:thread",
  "after:2026-10-01",
  '"exact phrase"',
  "-word",
];

const SearchAddress = z.object({ q: z.string().max(TITLE_MAX).optional(), ask: z.literal("1").optional() });
type SearchAddress = z.infer<typeof SearchAddress>;
const EMPTY: SearchAddress = {};

/** `person:<id>` or `agent:<id>`, as the index writes the author. */
export function authorRef(authorId: string | null | undefined) {
  const match = authorId == null ? null : /^(user|person|agent):(.+)$/.exec(authorId);
  if (match?.[2] === undefined) return null;
  return { type: match[1] === "agent" ? ("agent" as const) : ("person" as const), id: match[2] };
}

export function SearchScreen() {
  const t = useMessages("files");
  const { workspaceId } = useRouteParams("search");
  const address = useSearch(SearchAddress, EMPTY);
  const go = useGo();
  const initial = address.q ?? "";
  const [text, setText] = useState(initial);
  // The address changed from outside (back, the frame's search): the field follows. What the typing
  // itself wrote to the address does not come back to the field.
  const pushed = useRef(initial);
  useEffect(() => {
    if (initial === pushed.current) return;
    pushed.current = initial;
    setText(initial);
  }, [initial]);
  const write = (next: string) => {
    setText(next);
    pushed.current = next;
    void go("search", { workspaceId }, { search: { q: next === "" ? undefined : next }, replace: true });
  };

  const [kind, setKind] = useState<SearchKind | null>(null);
  const [helping, setHelping] = useState(false);
  const q = useDeferredValue(text.trim());
  useDocumentTitle(t("search.title"));

  const ask = useApiMutation("askSearch");
  const [asked, setAsked] = useState<string | null>(null);
  const runAsk = (question: string) => {
    setAsked(question);
    ask.mutate({ workspaceId, body: { q: question } });
  };
  // Opened with a question (from the palette): asked once, as soon as the screen opens.
  const autoAsked = useRef(false);
  useEffect(() => {
    if (address.ask !== "1" || autoAsked.current || initial.trim().length < MIN_QUERY) return;
    autoAsked.current = true;
    setAsked(initial.trim());
    ask.mutate({ workspaceId, body: { q: initial.trim() } });
  }, [address.ask, initial, ask, workspaceId]);

  return (
    <div className="page files files--search">
      <h1 className="page__title">{t("search.title")}</h1>
      <p className="page__muted">{t("search.lead")}</p>
      <form
        className="files__query"
        onSubmit={(event) => {
          event.preventDefault();
          if (text.trim().length >= MIN_QUERY) runAsk(text.trim());
        }}
      >
        <Input
          type="search"
          value={text}
          autoFocus
          maxLength={TITLE_MAX}
          onChange={(event) => write(event.target.value)}
          placeholder={t("search.placeholder")}
          aria-label={t("search.field")}
        />
        <Button
          type="submit"
          icon={<Icon icon={Sparkles} />}
          disabled={text.trim().length < MIN_QUERY}
          loading={ask.isPending}
        >
          {t("search.ask")}
        </Button>
        <Button variant="ghost" size="sm" aria-expanded={helping} onClick={() => setHelping(!helping)}>
          {t("search.operators")}
        </Button>
      </form>
      {helping && (
        <div className="files__operators">
          <p className="page__muted">{t("search.operatorsLead")}</p>
          <ul aria-label={t("search.operators")}>
            {OPERATORS.map((operator) => (
              <li key={operator}>
                <button
                  type="button"
                  className="files__operator"
                  aria-label={t("search.addOperator", { operator })}
                  onClick={() => write(`${text.trim()} ${operator}`.trim())}
                >
                  <code>{operator}</code>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {asked !== null && (
        <AskCard
          workspaceId={workspaceId}
          q={asked}
          pending={ask.isPending}
          answer={ask.data}
          error={ask.error}
          onRetry={() => runAsk(asked)}
        />
      )}
      <fieldset className="files__filters">
        <legend className="vr-visually-hidden">{t("search.filters")}</legend>
        <Chip selected={kind === null} onSelectedChange={() => setKind(null)}>
          {t("search.kinds.all")}
        </Chip>
        {SEARCH_KINDS.map((choice) => (
          <Chip key={choice} selected={kind === choice} onSelectedChange={() => setKind(choice)}>
            {t(`search.kinds.${choice}`)}
          </Chip>
        ))}
      </fieldset>
      <Results workspaceId={workspaceId} q={q} kind={kind} />
    </div>
  );
}

function Results({ workspaceId, q, kind }: { workspaceId: string; q: string; kind: SearchKind | null }) {
  const t = useMessages("files");
  const name = useActorName(workspaceId);
  const when = useRelativeTime();
  const channels = useApiQuery("listChannels", { workspaceId });
  const results = useApiQuery(
    "getSearch",
    { workspaceId, query: { q, limit: PER_KIND, ...(kind !== null && { kinds: [kind] }) } },
    { enabled: q.length >= MIN_QUERY, placeholderData: (previous) => previous },
  );
  if (q.length < MIN_QUERY) return <EmptyState className="page__narrow" title={t("search.typeMore")} />;
  if (results.isError && results.data === undefined) {
    return (
      <ScreenError
        title={t("search.failed")}
        error={results.error}
        onRetry={() => void results.refetch()}
        namespace="files"
      />
    );
  }
  if (results.isPending) return <ScreenLoading />;
  const hits = results.data;
  if (hits.length === 0) return <EmptyState className="page__narrow" title={t("search.none", { q })} />;
  const capped = SEARCH_KINDS.some((each) => hits.filter((hit) => hit.kind === each).length >= PER_KIND);
  const channelName = (hit: SearchHit) => {
    const id = hit.channelIds[0];
    const channel = id === undefined ? undefined : channels.data?.find((candidate) => candidate.id === id);
    return channel === undefined ? null : t("origin.channel", { channel: channel.name });
  };
  return (
    <>
      <ul className="files__results" aria-label={t("search.results")}>
        {hits.map((hit) => {
          const author = authorRef(hit.authorId);
          const where = channelName(hit);
          return (
            <li key={`${hit.kind}:${hit.sourceId}:${hit.page ?? 0}`} className="files__result">
              <div className="files__result-head">
                <Chip>{t(`search.kind.${hit.kind}`)}</Chip>
                <HitLink workspaceId={workspaceId} hit={hit}>
                  <Marked text={hit.title ?? hit.snippet.slice(0, 80)} query={q} />
                </HitLink>
              </div>
              {hit.title !== null && (
                <p className="files__snippet">
                  <Marked text={hit.snippet} query={q} />
                </p>
              )}
              <p className="files__result-meta">
                {where !== null && <span>{where}</span>}
                {author !== null && <span>{name(author)}</span>}
                {hit.page != null && <span>{t("page", { page: hit.page })}</span>}
                <time dateTime={hit.createdAt}>{when(hit.createdAt)}</time>
              </p>
            </li>
          );
        })}
      </ul>
      {capped && <p className="page__muted">{t("search.capped", { count: PER_KIND })}</p>}
    </>
  );
}

/** A link to where a hit lives; a kind without a screen of its own yet is plain text. */
function HitLink({
  workspaceId,
  hit,
  children,
}: {
  workspaceId: string;
  hit: SearchHit;
  children: ReactNode;
}) {
  const className = "app-link files__result-title";
  switch (hit.kind) {
    case "message":
      if (hit.threadId !== null) {
        return (
          <AppLink className={className} route="thread" params={{ workspaceId, threadId: hit.threadId }}>
            {children}
          </AppLink>
        );
      }
      if (hit.channelIds[0] === undefined) return <span className="files__result-title">{children}</span>;
      return (
        <AppLink className={className} route="channel" params={{ workspaceId, channelId: hit.channelIds[0] }}>
          {children}
        </AppLink>
      );
    case "file":
      return (
        <AppLink
          className={className}
          route="files"
          params={{ workspaceId }}
          search={{ file: hit.sourceId, p: hit.page == null ? undefined : String(hit.page) }}
        >
          {children}
        </AppLink>
      );
    case "wiki":
      return (
        <AppLink className={className} route="wikiPage" params={{ workspaceId, pageId: hit.sourceId }}>
          {children}
        </AppLink>
      );
    case "issue":
      return (
        <AppLink className={className} route="issue" params={{ workspaceId, issueSeq: hit.sourceId }}>
          {children}
        </AppLink>
      );
    case "debate":
      return (
        <AppLink className={className} route="debate" params={{ workspaceId, debateId: hit.sourceId }}>
          {children}
        </AppLink>
      );
    default:
      return <span className="files__result-title">{children}</span>;
  }
}

/** The answer in parts, each with the numbers of its sources; the sources below, in the same order. */
function AskCard({
  workspaceId,
  q,
  pending,
  answer,
  error,
  onRetry,
}: {
  workspaceId: string;
  q: string;
  pending: boolean;
  answer: AskAnswer | undefined;
  error: unknown;
  onRetry: () => void;
}) {
  const t = useMessages("files");
  const common = useMessages("common");
  const describe = useErrorMessage("files");
  if (pending) {
    return (
      <section className="files__answer" aria-busy="true" aria-label={t("ask.title")}>
        <p className="page__muted" role="status">
          {t("ask.working")}
        </p>
      </section>
    );
  }
  if (error !== null && error !== undefined) {
    return (
      <Callout
        tone="danger"
        role="alert"
        title={t("ask.failed")}
        actions={<Button onClick={onRetry}>{common("action.retry")}</Button>}
      >
        {isApiError(error) && error.rawCode === "not_available" ? t("ask.unavailable") : describe(error)}
      </Callout>
    );
  }
  if (answer === undefined) return null;
  return (
    <section className="files__answer" aria-label={t("ask.title")}>
      {answer.blocks.length === 0 ? (
        <p className="page__muted">{t("ask.none")}</p>
      ) : (
        <p className="files__answer-text">
          {answer.blocks.map((block, index) => (
            <span key={index}>
              {block.text}
              {block.sources.map((n) => (
                <a
                  key={n}
                  href={`#ask-source-${n}`}
                  className="files__ref"
                  aria-label={t("ask.sourceN", { n })}
                >
                  {n}
                </a>
              ))}
            </span>
          ))}
        </p>
      )}
      {answer.sources.length > 0 && (
        <>
          <h2 className="files__aside-title">{t("ask.sources")}</h2>
          <ol className="files__sources" aria-label={t("ask.sources")}>
            {answer.sources.map((source) => (
              <li key={source.n} id={`ask-source-${source.n}`}>
                <span className="files__ref files__ref--static" aria-hidden="true">
                  {source.n}
                </span>
                <HitLink workspaceId={workspaceId} hit={source}>
                  <Marked text={source.title ?? source.snippet.slice(0, 80)} query={q} />
                </HitLink>
                {source.page != null && (
                  <span className="files__meta">{t("page", { page: source.page })}</span>
                )}
              </li>
            ))}
          </ol>
        </>
      )}
      {answer.testModel && <p className="page__muted">{t("ask.testModel")}</p>}
    </section>
  );
}
