// What was said, round by round, and the person's part in it. On their turn they give an answer, how
// sure they are and their argument, or skip the round; otherwise they may comment, which never counts as
// a position. Nothing can be posted once the debate has closed or while its synthesis is being written.
import { isApiError } from "@vanr/client";
import type { DebateDetail, DebatePost } from "@vanr/contract";
import { Button, Callout, Field, Input, Select, SelectItem, Textarea } from "@vanr/ui";
import { useState } from "react";
import { useMessages } from "../../i18n/react.tsx";
import { useRelativeTime } from "../../i18n/relative-time.tsx";
import { useSpeaker } from "./Positions.tsx";
import {
  type Directory,
  debateKeys,
  isFinished,
  useDebateOutcome,
  useLatchedMutation,
  useMe,
} from "./shared.tsx";

/** The server's limits on a post. */
export const POST_MAX = 20_000;
export const ANSWER_MAX = 200;
const CONFIDENCES = [20, 40, 60, 80, 100] as const;
const NO_CONFIDENCE = "none";

export function Talk({
  workspaceId,
  debate,
  directory,
  posts,
}: {
  workspaceId: string;
  debate: DebateDetail;
  directory: Directory;
  posts: DebatePost[];
}) {
  const t = useMessages("debates");
  const rounds = [...new Set(posts.map((post) => post.round))].sort((a, b) => a - b);
  const open = !isFinished(debate) && debate.status === "open" && debate.phase !== "concluding";
  return (
    <>
      {rounds.length > 0 && (
        <section className="debate-section" aria-labelledby="debate-talk">
          <h2 className="debate-section__title" id="debate-talk">
            {t("talk.title")}
          </h2>
          {rounds.map((round) => {
            const name = round === 0 ? t("pos.opening") : t("pos.round", { round });
            return (
              <section key={round} className="debate-round" aria-label={name}>
                <h3 className="debate-round__title">{name}</h3>
                <ol className="debate-posts">
                  {posts
                    .filter((post) => post.round === round)
                    .map((post) => (
                      <Post key={post.id} post={post} directory={directory} />
                    ))}
                </ol>
              </section>
            );
          })}
        </section>
      )}
      {open ? (
        <Composer workspaceId={workspaceId} debate={debate} />
      ) : (
        isFinished(debate) && <p className="debate-section__note">{t("page.ended")}</p>
      )}
    </>
  );
}

function Post({ post, directory }: { post: DebatePost; directory: Directory }) {
  const t = useMessages("debates");
  const when = useRelativeTime();
  const speaker = useSpeaker(directory);
  const claim = post.claimData;
  const kind =
    post.kind === "comment" || post.kind === "out_of_budget" || post.kind === "free"
      ? t(`talk.kind.${post.kind}`)
      : null;
  return (
    <li id={`debate-post-${post.id}`} className="debate-post" data-kind={post.kind}>
      <article aria-label={speaker(post)}>
        <header className="debate-post__head">
          <strong>{speaker(post)}</strong>
          {kind !== null && <span className="debate-post__kind">{kind}</span>}
          {claim !== null && (
            <span className="debate-post__answer">{t("talk.answer", { answer: claim.answer })}</span>
          )}
          <span className="debate-post__when">{when(post.createdAt)}</span>
        </header>
        {post.replyTo !== null && <p className="debate-post__reply">{t("talk.reply")}</p>}
        <p className="debate-post__body">
          {post.kind === "out_of_budget" ? t("talk.outOfBudget") : post.body}
        </p>
        {claim !== null && claim.evidence.length > 0 && (
          <div className="debate-post__evidence">
            <span>{t("talk.evidence")}</span>
            <ul>
              {claim.evidence.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
        )}
      </article>
    </li>
  );
}

function Composer({ workspaceId, debate }: { workspaceId: string; debate: DebateDetail }) {
  const t = useMessages("debates");
  const me = useMe(workspaceId);
  const outcome = useDebateOutcome(workspaceId, debate.id);
  const myTurn = debate.waitingUserIds.includes(me.id);
  const [text, setText] = useState("");
  const [answer, setAnswer] = useState("");
  const [confidence, setConfidence] = useState<string>(NO_CONFIDENCE);
  const [notice, setNotice] = useState<string | null>(null);
  const keys = () => debateKeys(workspaceId, debate.id);
  const post = useLatchedMutation("createDebatePost", { invalidates: keys });
  const skip = useLatchedMutation("skipDebate", { invalidates: keys });
  const busy = post.isPending || skip.isPending;
  const fail = (error: unknown) => {
    // The turn moved on (another tab, the deadline): the draft stays, the debate shows as it is now.
    if (
      isApiError(error) &&
      (error.rawCode === "debate.turn_changed" || error.rawCode === "debate.out_of_turn")
    )
      setNotice(t("turn.changed"));
    outcome.failed(error);
  };
  const send = () => {
    const body = text.trim();
    if (body === "" || busy) return;
    setNotice(null);
    const sentAnswer = answer;
    const sentConfidence = confidence;
    post.fire(
      {
        workspaceId,
        debateId: debate.id,
        body: {
          body,
          ...(myTurn && answer.trim() !== "" && { answer: answer.trim() }),
          ...(myTurn && confidence !== NO_CONFIDENCE && { confidence: Number(confidence) / 100 }),
        },
      },
      {
        onSuccess: () => {
          // Only what was sent is cleared: anything typed while it was on its way stays.
          setText((current) => (current.trim() === body ? "" : current));
          setAnswer((current) => (current === sentAnswer ? "" : current));
          setConfidence((current) => (current === sentConfidence ? NO_CONFIDENCE : current));
          outcome.done(myTurn ? t("turn.sent") : t("comment.sent"));
        },
        onError: fail,
      },
    );
  };
  return (
    <section className="debate-composer" aria-label={myTurn ? t("turn.title") : t("comment.text")}>
      {myTurn && (
        <Callout tone="info" title={t("turn.title")}>
          {t("turn.body")}
        </Callout>
      )}
      {notice !== null && (
        <Callout tone="warning" role="status">
          {notice}
        </Callout>
      )}
      <form
        className="debate-form"
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
      >
        {myTurn && (
          <div className="debate-form__row">
            <Field label={t("turn.answer")}>
              {debate.options.length > 0 ? (
                <Select value={answer} onValueChange={setAnswer} placeholder={t("turn.answer.pick")}>
                  {debate.options.map((option) => (
                    <SelectItem key={option} value={option}>
                      {option}
                    </SelectItem>
                  ))}
                </Select>
              ) : (
                <Input
                  value={answer}
                  maxLength={ANSWER_MAX}
                  onChange={(event) => setAnswer(event.target.value)}
                />
              )}
            </Field>
            <Field label={t("turn.confidence")}>
              <Select value={confidence} onValueChange={setConfidence}>
                <SelectItem value={NO_CONFIDENCE}>{t("turn.confidence.none")}</SelectItem>
                {CONFIDENCES.map((value) => (
                  <SelectItem key={value} value={String(value)}>
                    {t("turn.confidence.value", { value })}
                  </SelectItem>
                ))}
              </Select>
            </Field>
          </div>
        )}
        <Field
          label={myTurn ? t("turn.text") : t("comment.text")}
          hint={myTurn ? undefined : t("comment.hint")}
        >
          <Textarea
            rows={4}
            value={text}
            maxLength={POST_MAX}
            onChange={(event) => setText(event.target.value)}
          />
        </Field>
        <div className="debate-composer__actions">
          {myTurn && (
            <Button
              variant="ghost"
              loading={skip.isPending}
              disabled={busy}
              onClick={() =>
                skip.fire(
                  { workspaceId, debateId: debate.id },
                  { onSuccess: () => outcome.done(t("turn.skipped")), onError: fail },
                )
              }
            >
              {t("turn.skip")}
            </Button>
          )}
          <Button
            variant="primary"
            type="submit"
            disabled={text.trim() === "" || busy}
            loading={post.isPending}
          >
            {myTurn ? t("turn.send") : t("comment.send")}
          </Button>
        </div>
      </form>
    </section>
  );
}
