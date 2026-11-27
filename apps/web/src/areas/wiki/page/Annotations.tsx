// A page's comments and proposals. A comment holds the passage it was made on (shown as a quote, or as
// gone when the passage left the published text) and its replies; who started a thread or may edit
// the page resolves it, who wrote a comment or an admin deletes it. A proposal is a set of changes an
// agent suggested: each one is accepted or rejected on its own by whoever may edit the page, and an
// accepted change lands on the published text as a new version.
import { useApiMutation, useApiQuery } from "@vanr/client/react";
import type { WikiAnchor, WikiComment, WikiPage, WikiProposal } from "@vanr/contract";
import { can } from "@vanr/contract";
import { Button, Callout, Icon, Textarea } from "@vanr/ui";
import { Check, MessageSquare, RotateCcw, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useErrorMessage } from "../../../app/screens.tsx";
import { useMessages } from "../../../i18n/react.tsx";
import { useRelativeTime } from "../../../i18n/relative-time.tsx";
import { useActorName, useRole } from "../shared.tsx";

const COMMENT_MAX = 10_000;

type Props = {
  workspaceId: string;
  page: WikiPage;
  /** A passage picked in the editor, waiting for its comment. */
  draft: WikiAnchor | null;
  onDraftDone: () => void;
  onDecided: (page: WikiPage) => void;
};

function Composer({
  label,
  submit,
  busy,
  onSubmit,
  onCancel,
}: {
  label: string;
  submit: string;
  busy: boolean;
  /**
   * Sends the text; `sent` empties the field, so a failed send keeps what was written. The field can't
   * be changed while its text is on the way, so nothing typed then is lost when the form closes.
   */
  onSubmit: (body: string, sent: () => void) => void;
  onCancel?: () => void;
}) {
  const t = useMessages("wiki");
  const [body, setBody] = useState("");
  // This form's text is the one on its way (`busy` is the page's, shared by every form).
  const [sending, setSending] = useState(false);
  useEffect(() => {
    if (!busy) setSending(false);
  }, [busy]);
  return (
    <form
      className="wiki-notes__composer"
      onSubmit={(event) => {
        event.preventDefault();
        const text = body.trim();
        if (text === "") return;
        setSending(true);
        onSubmit(text, () => setBody(""));
      }}
    >
      <Textarea
        aria-label={label}
        rows={3}
        value={body}
        maxLength={COMMENT_MAX}
        readOnly={busy && sending}
        onChange={(event) => setBody(event.target.value)}
      />
      <div className="wiki-notes__actions">
        {onCancel !== undefined && (
          <Button size="sm" variant="ghost" onClick={onCancel}>
            {t("comments.cancel")}
          </Button>
        )}
        <Button size="sm" variant="primary" type="submit" loading={busy} disabled={body.trim() === ""}>
          {submit}
        </Button>
      </div>
    </form>
  );
}

export function Annotations({ workspaceId, page, draft, onDraftDone, onDecided }: Props) {
  const t = useMessages("wiki");
  const common = useMessages("common");
  const describe = useErrorMessage("wiki");
  const when = useRelativeTime();
  const name = useActorName(workspaceId);
  const { role, userId } = useRole(workspaceId);
  const notes = useApiQuery("getWikiPageAnnotations", { workspaceId, pageId: page.slug });
  const refetch = [{ method: "getWikiPageAnnotations" as const, args: { workspaceId, pageId: page.slug } }];
  const comment = useApiMutation("createWikiPageComment", { invalidates: () => refetch });
  const draftNow = useRef(draft);
  draftNow.current = draft;
  const resolve = useApiMutation("resolveWikiAnnotation", { invalidates: () => refetch });
  const reopen = useApiMutation("reopenWikiAnnotation", { invalidates: () => refetch });
  const remove = useApiMutation("deleteWikiAnnotation", { invalidates: () => refetch });
  const decide = useApiMutation("decideWikiAnnotation", {
    invalidates: () => refetch,
    onSuccess: (decision) => onDecided(decision.page),
  });
  const [replying, setReplying] = useState<string | null>(null);
  const failure = comment.error ?? resolve.error ?? reopen.error ?? remove.error ?? decide.error;

  const comments = notes.data?.comments ?? [];
  const threads = comments.filter((each) => each.parentId === null);
  const repliesOf = (root: WikiComment) => comments.filter((each) => each.parentId === root.id);
  const pending = (notes.data?.proposals ?? []).filter((proposal) => proposal.status === "pending");
  const mine = (each: WikiComment) => each.author.type === "person" && each.author.id === userId;

  const commentView = (each: WikiComment) => (
    <div className="wiki-notes__comment">
      <p className="wiki-notes__who">
        {name(each.author)} <time dateTime={each.createdAt}>{when(each.createdAt)}</time>
      </p>
      <p className="wiki-notes__body">{each.body}</p>
      {(mine(each) || can(role, "configure")) && (
        <Button
          size="sm"
          variant="ghost"
          icon={<Icon icon={Trash2} />}
          aria-label={t("comments.delete")}
          loading={remove.isPending && remove.variables?.annotationId === each.id}
          onClick={() => remove.mutate({ workspaceId, annotationId: each.id })}
        />
      )}
    </div>
  );

  const proposalView = (proposal: WikiProposal) => {
    const open = proposal.hunks.filter((hunk) => hunk.status === "pending");
    return (
      <li key={proposal.id} className="wiki-notes__thread">
        <p className="wiki-notes__who">
          {t("proposals.by", { who: name(proposal.author) })}{" "}
          <time dateTime={proposal.createdAt}>{when(proposal.createdAt)}</time>
        </p>
        {proposal.note !== "" && <p className="wiki-notes__body">{proposal.note}</p>}
        <ol className="wiki-notes__hunks" aria-label={t("proposals.changes")}>
          {proposal.hunks.map((hunk) => (
            <li key={hunk.id} className="wiki-notes__hunk">
              <del className="wiki-notes__old">
                <span className="vr-visually-hidden">{t("history.removed")}</span>
                {hunk.oldStr}
              </del>
              <ins className="wiki-notes__new">
                <span className="vr-visually-hidden">{t("history.added")}</span>
                {hunk.newStr}
              </ins>
              {hunk.status === "pending" && page.editable ? (
                <div className="wiki-notes__actions">
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<Icon icon={X} />}
                    loading={decide.isPending}
                    onClick={() =>
                      decide.mutate({
                        workspaceId,
                        annotationId: proposal.id,
                        body: { decisions: [{ hunkId: hunk.id, accept: false }] },
                      })
                    }
                  >
                    {t("proposals.reject")}
                  </Button>
                  <Button
                    size="sm"
                    icon={<Icon icon={Check} />}
                    loading={decide.isPending}
                    onClick={() =>
                      decide.mutate({
                        workspaceId,
                        annotationId: proposal.id,
                        body: { decisions: [{ hunkId: hunk.id, accept: true }] },
                      })
                    }
                  >
                    {t("proposals.accept")}
                  </Button>
                </div>
              ) : (
                <span className="wiki-notes__state">{t(`proposals.state.${hunk.status}`)}</span>
              )}
            </li>
          ))}
        </ol>
        {page.editable && open.length > 1 && (
          <Button
            size="sm"
            variant="primary"
            loading={decide.isPending}
            onClick={() =>
              decide.mutate({
                workspaceId,
                annotationId: proposal.id,
                body: { decisions: open.map((hunk) => ({ hunkId: hunk.id, accept: true })) },
              })
            }
          >
            {t("proposals.acceptAll")}
          </Button>
        )}
      </li>
    );
  };

  return (
    <>
      {pending.length > 0 && (
        <section className="wiki-side__section" aria-labelledby="wiki-proposals">
          <h2 id="wiki-proposals" className="wiki-side__heading">
            {t("proposals.title", { count: pending.length })}
          </h2>
          <ul className="wiki-notes">{pending.map(proposalView)}</ul>
        </section>
      )}
      <section className="wiki-side__section" aria-labelledby="wiki-comments">
        <h2 id="wiki-comments" className="wiki-side__heading">
          {t("comments.title", { count: threads.filter((each) => each.status === "open").length })}
        </h2>
        {failure !== null && (
          <Callout tone="danger" role="alert">
            {describe(failure)}
          </Callout>
        )}
        {draft !== null && (
          <div className="wiki-notes__thread" key={`${draft.position ?? ""}:${draft.quote}`}>
            <blockquote className="wiki-notes__quote">{draft.quote}</blockquote>
            <Composer
              label={t("comments.new")}
              submit={t("comments.send")}
              busy={comment.isPending}
              onCancel={onDraftDone}
              onSubmit={(body, sent) =>
                comment.mutate(
                  { workspaceId, pageId: page.slug, body: { body, anchor: draft } },
                  {
                    onSuccess: () => {
                      sent();
                      // Another passage picked meanwhile keeps its own comment open.
                      if (draftNow.current === draft) onDraftDone();
                    },
                  },
                )
              }
            />
          </div>
        )}
        {notes.data === undefined ? (
          notes.isError ? (
            <Callout
              tone="danger"
              role="alert"
              title={t("comments.failed")}
              actions={
                <Button size="sm" onClick={() => void notes.refetch()}>
                  {common("action.retry")}
                </Button>
              }
            />
          ) : null
        ) : threads.length === 0 && draft === null ? (
          <p className="wiki-side__empty">{t("comments.empty")}</p>
        ) : (
          <ul className="wiki-notes" aria-label={t("comments.list")}>
            {threads.map((thread) => (
              <li
                key={thread.id}
                className="wiki-notes__thread"
                data-resolved={thread.status === "resolved" || undefined}
              >
                {thread.anchor !== null && (
                  <blockquote
                    className="wiki-notes__quote"
                    data-orphan={thread.anchorState === "orphan" || undefined}
                  >
                    {thread.anchor.quote}
                    {thread.anchorState === "orphan" && (
                      <span className="wiki-notes__gone">{t("comments.orphan")}</span>
                    )}
                  </blockquote>
                )}
                {commentView(thread)}
                {repliesOf(thread).map((reply) => (
                  <div key={reply.id} className="wiki-notes__reply">
                    {commentView(reply)}
                  </div>
                ))}
                {thread.status === "resolved" && (
                  <p className="wiki-notes__state">
                    {t("comments.resolvedBy", {
                      who: thread.handledBy === null ? "" : name(thread.handledBy),
                    })}
                  </p>
                )}
                <div className="wiki-notes__actions">
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<Icon icon={MessageSquare} />}
                    onClick={() => setReplying(replying === thread.id ? null : thread.id)}
                  >
                    {t("comments.reply")}
                  </Button>
                  {(mine(thread) || page.editable) &&
                    (thread.status === "open" ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={<Icon icon={Check} />}
                        loading={resolve.isPending && resolve.variables?.annotationId === thread.id}
                        onClick={() => resolve.mutate({ workspaceId, annotationId: thread.id })}
                      >
                        {t("comments.resolve")}
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={<Icon icon={RotateCcw} />}
                        loading={reopen.isPending && reopen.variables?.annotationId === thread.id}
                        onClick={() => reopen.mutate({ workspaceId, annotationId: thread.id })}
                      >
                        {t("comments.reopen")}
                      </Button>
                    ))}
                </div>
                {replying === thread.id && (
                  <Composer
                    label={t("comments.replyTo", { who: name(thread.author) })}
                    submit={t("comments.send")}
                    busy={comment.isPending}
                    onCancel={() => setReplying(null)}
                    onSubmit={(body, sent) =>
                      comment.mutate(
                        { workspaceId, pageId: page.slug, body: { body, parentId: thread.id } },
                        {
                          onSuccess: () => {
                            sent();
                            // Only this thread's reply closes: another one opened meanwhile stays.
                            setReplying((open) => (open === thread.id ? null : open));
                          },
                        },
                      )
                    }
                  />
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

/**
 * The anchor of a passage picked in the editor, on the published Markdown: the occurrence of the quote
 * whose surroundings match the editor's best, with up to 32 characters before and after it.
 */
export function anchorFor(
  body: string,
  picked: { quote: string; before: string; after: string },
): WikiAnchor {
  const { quote, before, after } = picked;
  const CONTEXT = 32;
  let best = -1;
  let score = -1;
  for (let at = body.indexOf(quote); at !== -1; at = body.indexOf(quote, at + 1)) {
    let tail = 0;
    while (
      tail < before.length &&
      at - 1 - tail >= 0 &&
      body[at - 1 - tail] === before[before.length - 1 - tail]
    )
      tail++;
    let head = 0;
    const end = at + quote.length;
    while (head < after.length && end + head < body.length && body[end + head] === after[head]) head++;
    if (tail + head > score) {
      score = tail + head;
      best = at;
    }
  }
  if (best === -1) return { quote, prefix: before.slice(-CONTEXT), suffix: after.slice(0, CONTEXT) };
  return {
    quote,
    prefix: body.slice(Math.max(0, best - CONTEXT), best),
    suffix: body.slice(best + quote.length, best + quote.length + CONTEXT),
    position: best,
  };
}
