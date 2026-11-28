// One debate's page: where it came from, the question and its goal, its state and round, the table,
// what it spent (for who may see spend), the positions round by round, what was said, the synthesis with
// its verdict and the blind read, and the person's own part: their turn, a comment, or steering it.
// A debate the person can't see (a channel they don't read) is one that isn't here, and its cached read
// goes with the page.
import { useQueryClient } from "@tanstack/react-query";
import { isApiError } from "@vanr/client";
import { prefixKey, useApiQuery, useVanrClient } from "@vanr/client/react";
import { can, type DebateDetail } from "@vanr/contract";
import { Button, Callout, ConfirmDialog, EmptyState } from "@vanr/ui";
import { ArrowLeft } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { AppLink, useRouteParams } from "../../app/navigation.tsx";
import { ScreenError, ScreenLoading, useDocumentTitle } from "../../app/screens.tsx";
import { useMessages } from "../../i18n/react.tsx";
import { useRelativeTime } from "../../i18n/relative-time.tsx";
import { Outcome } from "./Outcome.tsx";
import { Positions } from "./Positions.tsx";
import { DebateState, RoundRail, Table, useRoundLabel } from "./parts.tsx";
import {
  type Directory,
  debateKeys,
  isFinished,
  startedBy,
  useDebateOutcome,
  useDirectory,
  useLatchedMutation,
  useMe,
  useMoney,
  useSeesSpend,
} from "./shared.tsx";
import { Talk } from "./Talk.tsx";

export function DebateScreen() {
  const { workspaceId, debateId } = useRouteParams("debate");
  return <DebateView key={`${workspaceId}/${debateId}`} workspaceId={workspaceId} debateId={debateId} />;
}

const isGone = (error: unknown) => isApiError(error) && (error.status === 404 || error.status === 403);

function DebateView({ workspaceId, debateId }: { workspaceId: string; debateId: string }) {
  const t = useMessages("debates");
  const shell = useMessages("shell");
  const debate = useApiQuery(
    "getDebate",
    { workspaceId, debateId },
    { retry: (count, error) => !isGone(error) && count < 2 },
  );
  const directory = useDirectory(workspaceId);
  const gone = debate.isError && isGone(debate.error);
  useDocumentTitle(gone ? shell("route.debate") : (debate.data?.title ?? shell("route.debate")));

  // What was read before the debate left the person's sight never shows again, here or on the way back.
  const queries = useQueryClient();
  const client = useVanrClient();
  const goneNow = useRef(gone);
  goneNow.current = gone;
  useEffect(() => {
    if (!gone) return;
    // The blind pair it held goes at once: it is text from a debate the person no longer sees.
    queries.removeQueries({
      queryKey: prefixKey(client, { method: "reviewDebate", args: { workspaceId, debateId } }),
    });
    void queries.invalidateQueries({
      queryKey: prefixKey(client, { method: "listDebates", args: { workspaceId } }),
    });
  }, [client, debateId, gone, queries, workspaceId]);
  useEffect(
    () => () => {
      if (goneNow.current)
        for (const method of ["getDebate", "reviewDebate"] as const)
          queries.removeQueries({ queryKey: prefixKey(client, { method, args: { workspaceId, debateId } }) });
    },
    [client, debateId, queries, workspaceId],
  );

  const back = (
    <AppLink className="app-link debate-page__back" route="debates" params={{ workspaceId }}>
      <ArrowLeft size={14} aria-hidden="true" />
      {t("page.back")}
    </AppLink>
  );
  if (gone) {
    return (
      <div className="page">
        <h1 className="page__title">{shell("route.debate")}</h1>
        <EmptyState
          className="page__narrow"
          title={t("page.missing.title")}
          description={t("page.missing.body")}
          action={back}
        />
      </div>
    );
  }
  if (debate.isPending) return <ScreenLoading />;
  if (debate.isError && debate.data === undefined) {
    return (
      <ScreenError
        title={t("page.failed")}
        error={debate.error}
        onRetry={() => void debate.refetch()}
        namespace="debates"
      />
    );
  }
  return <DebatePage workspaceId={workspaceId} debate={debate.data} directory={directory} back={back} />;
}

function DebatePage({
  workspaceId,
  debate,
  directory,
  back,
}: {
  workspaceId: string;
  debate: DebateDetail;
  directory: Directory;
  back: ReactNode;
}) {
  const t = useMessages("debates");
  const me = useMe(workspaceId);
  // The server's rule for steering: who opened, asked for or leads it, or who sets the workspace up.
  const steers = startedBy(debate, me.id) || can(me.role, "configure");
  const finished = isFinished(debate);
  const roundLabel = useRoundLabel();
  const when = useRelativeTime();
  const talk = debate.posts.filter((post) => post.kind !== "synthesis");
  return (
    <div className="page page--wide debates debate-page">
      {back}
      <header className="debate-page__head">
        <div className="debate-page__heading">
          <Origin workspaceId={workspaceId} debate={debate} directory={directory} />
          <h1 className="page__title debate-page__title">{debate.title}</h1>
          <div className="debate-page__facts">
            <DebateState debate={debate} me={me.id} />
            <RoundRail debate={debate} />
            <span>{roundLabel(debate)}</span>
            {debate.deadline !== null && !finished && (
              <span>{t("page.deadline", { when: when(debate.deadline) })}</span>
            )}
          </div>
        </div>
        {steers && !finished && <Steering workspaceId={workspaceId} debate={debate} />}
      </header>
      {debate.goal.trim() !== debate.title.trim() && <p className="debate-page__goal">{debate.goal}</p>}
      <div className="debate-page__table">
        <Table debate={debate} directory={directory} />
        <Spend workspaceId={workspaceId} debate={debate} />
      </div>
      <Notices
        workspaceId={workspaceId}
        debate={debate}
        directory={directory}
        steers={steers}
        talk={talk.length}
      />
      <Positions debate={debate} directory={directory} />
      <Talk workspaceId={workspaceId} debate={debate} directory={directory} posts={talk} />
      <Outcome workspaceId={workspaceId} debate={debate} directory={directory} steers={steers} />
    </div>
  );
}

/** Where the debate came from and the channel it lives in, when the person reads that channel. */
function Origin({
  workspaceId,
  debate,
  directory,
}: {
  workspaceId: string;
  debate: DebateDetail;
  directory: Directory;
}) {
  const t = useMessages("debates");
  const channels = useApiQuery("listChannels", { workspaceId });
  const channelId = debate.channelId ?? debate.origin?.channelId ?? null;
  const channel = channelId === null ? undefined : channels.data?.find((each) => each.id === channelId);
  const origin = debate.origin;
  const parts: ReactNode[] = [];
  if (origin?.kind === "issue" && origin.issueSeq !== undefined)
    parts.push(
      <AppLink
        key="issue"
        className="app-link"
        route="issue"
        params={{ workspaceId, issueSeq: String(origin.issueSeq) }}
      >
        {t("page.fromIssue", { number: origin.issueSeq })}
      </AppLink>,
    );
  if (origin?.kind === "suggestion")
    parts.push(
      <span key="suggestion">
        {t("page.fromSuggestion", {
          name:
            origin.agentId === undefined
              ? t("someone")
              : directory.name({ type: "agent", id: origin.agentId }),
        })}
      </span>,
    );
  if (origin?.kind === "routine") parts.push(<span key="routine">{t("page.fromRoutine")}</span>);
  if (channel !== undefined)
    parts.push(
      <AppLink
        key="channel"
        className="app-link"
        route="channel"
        params={{ workspaceId, channelId: channel.id }}
      >
        {t("page.inChannel", { channel: channel.name })}
      </AppLink>,
    );
  if (parts.length === 0) return null;
  return <p className="debate-page__origin">{parts}</p>;
}

function Spend({ workspaceId, debate }: { workspaceId: string; debate: DebateDetail }) {
  const t = useMessages("debates");
  const money = useMoney();
  const seesSpend = useSeesSpend(workspaceId);
  if (!seesSpend) return null;
  // Absent when the server leaves spend out for this person: then nothing shows, never a zero.
  const spent = money(debate.spentUsd);
  if (spent === null) return null;
  const cap = money(debate.spendCapUsd);
  return (
    <p className="debate-page__spend">
      {cap === null ? t("page.spent", { spent }) : t("page.spentOf", { spent, cap })}
    </p>
  );
}

/** What the debate is waiting on, or why it stopped. */
function Notices({
  workspaceId,
  debate,
  directory,
  steers,
  talk,
}: {
  workspaceId: string;
  debate: DebateDetail;
  directory: Directory;
  steers: boolean;
  talk: number;
}) {
  const t = useMessages("debates");
  const finished = isFinished(debate);
  return (
    <div className="debate-page__notices">
      {debate.anonymous && !finished && <p className="debate-page__note">{t("page.blind")}</p>}
      {!finished && debate.sealedCount > 0 && (
        <p className="debate-page__note" role="status">
          {t("page.sealed", { count: debate.sealedCount })}
        </p>
      )}
      {debate.status === "open" && talk === 0 && debate.sealedCount === 0 && (
        <p className="debate-page__note" role="status">
          {t("page.firstWait")}
        </p>
      )}
      {debate.status === "open" && debate.phase === "concluding" && (
        <p className="debate-page__note" role="status">
          {t("page.summing")}
        </p>
      )}
      {debate.status === "stalled" && debate.stallInfo !== null && (
        <Callout
          tone="danger"
          actions={steers ? <ResumeButton workspaceId={workspaceId} debateId={debate.id} /> : undefined}
        >
          {/* While blind, naming the agent that got stuck would give away its letter. */}
          {debate.anonymous
            ? t("page.stuckBlind", { round: debate.stallInfo.round })
            : t("page.stuck", {
                who: directory.name({ type: "agent", id: debate.stallInfo.agentId }),
                round: debate.stallInfo.round,
                reason: debate.stallInfo.reason,
              })}
        </Callout>
      )}
      {finished && debate.endReason !== null && (
        <p className="debate-page__note">{t(`page.end.${debate.endReason}`)}</p>
      )}
    </div>
  );
}

function ResumeButton({ workspaceId, debateId }: { workspaceId: string; debateId: string }) {
  const t = useMessages("debates");
  const outcome = useDebateOutcome(workspaceId, debateId);
  const resume = useLatchedMutation("resumeDebate", { invalidates: () => debateKeys(workspaceId, debateId) });
  return (
    <Button
      size="sm"
      loading={resume.isPending}
      onClick={() =>
        resume.fire(
          { workspaceId, debateId },
          { onSuccess: () => outcome.done(t("steer.resumed")), onError: outcome.failed },
        )
      }
    >
      {t("steer.resume")}
    </Button>
  );
}

/** Conclude now, or cancel after a confirmation: only for who steers the debate. */
function Steering({ workspaceId, debate }: { workspaceId: string; debate: DebateDetail }) {
  const t = useMessages("debates");
  const outcome = useDebateOutcome(workspaceId, debate.id);
  const [confirming, setConfirming] = useState(false);
  const keys = () => debateKeys(workspaceId, debate.id);
  const conclude = useLatchedMutation("concludeDebate", { invalidates: keys });
  const cancel = useLatchedMutation("cancelDebate", { invalidates: keys });
  const args = { workspaceId, debateId: debate.id };
  return (
    <div className="debate-page__steer">
      <Button
        disabled={debate.phase === "concluding"}
        loading={conclude.isPending}
        onClick={() =>
          conclude.fire(args, {
            onSuccess: () => outcome.done(t("steer.concluded")),
            onError: outcome.failed,
          })
        }
      >
        {t("steer.conclude")}
      </Button>
      <Button variant="ghost" onClick={() => setConfirming(true)}>
        {t("steer.cancel")}
      </Button>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t("steer.cancel.title")}
        description={t("steer.cancel.body")}
        confirmLabel={t("steer.cancel.confirm")}
        cancelLabel={t("steer.cancel.keep")}
        tone="danger"
        confirming={cancel.isPending}
        onConfirm={() =>
          cancel.fire(args, {
            onSuccess: () => {
              setConfirming(false);
              outcome.done(t("steer.canceled"));
            },
            onError: (error) => {
              setConfirming(false);
              outcome.failed(error);
            },
          })
        }
      />
    </div>
  );
}
