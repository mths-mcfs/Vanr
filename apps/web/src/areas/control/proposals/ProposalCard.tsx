// A change an agent proposes to its instructions or to what the workspace remembers: the line diff
// from today's text, why, what it saw, and for whoever the server lets decide, accept (after editing
// the final text, if they want) or reject, which becomes a lesson. A proposal whose text changed
// since can only be rejected. Once accepted, whoever accepted, the agent's lead or an admin can undo
// it while the window is open (the server says so in `canUndo`), and redo it after.
import { useApiMutation } from "@vanr/client/react";
import type { Proposal } from "@vanr/contract";
import { AgentSigil, Button, Callout, Field, StatusBadge, Textarea, type WorkStatus } from "@vanr/ui";
import { useMemo, useState } from "react";
import { useLocale, useLookup, useMessages } from "../../../i18n/react.tsx";
import { lineDiff, shortDateTime, trailText } from "../format.ts";
import { Block, type Directory, useOutcome } from "../shared.tsx";
import { ProposalEval } from "./ProposalEval.tsx";

/** The server's limit for the final text. */
const TEXT_MAX = 20_000;

const BADGE: Record<Proposal["status"], WorkStatus> = {
  pending: "awaiting-approval",
  accepted: "done",
  rejected: "failed",
};

function useTarget(proposal: Proposal, directory: Directory): string {
  const t = useMessages("control");
  const target = proposal.target;
  if (target.kind === "workspace_context") return t("target.workspace_context");
  if (target.kind === "workspace_memory") return t("target.workspace_memory", { path: target.path });
  return t("target.agent_prompt", { agent: directory.agentName(target.agentId) });
}

export function ProposalCard({
  workspaceId,
  proposal,
  directory,
}: {
  workspaceId: string;
  proposal: Proposal;
  directory: Directory;
}) {
  const t = useMessages("control");
  const lookup = useLookup("control");
  const { locale } = useLocale();
  const outcome = useOutcome();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(proposal.after);
  const target = useTarget(proposal, directory);
  const diff = useMemo(
    () => lineDiff(proposal.before, editing ? text : proposal.after),
    [proposal.before, proposal.after, editing, text],
  );
  const changed = () => [
    { method: "listProposals" as const, args: { workspaceId } },
    ...(proposal.target.kind === "agent_prompt"
      ? [{ method: "getAgent" as const, args: { workspaceId, agentId: proposal.target.agentId } }]
      : [{ method: "getSettings" as const, args: { workspaceId } }]),
  ];
  const accept = useApiMutation("acceptProposal", { invalidates: changed });
  const reject = useApiMutation("rejectProposal", { invalidates: changed });
  const undo = useApiMutation("undoAction", { invalidates: changed });
  const redo = useApiMutation("redoAction", { invalidates: changed });
  const busy = accept.isPending || reject.isPending || undo.isPending || redo.isPending;
  const pending = proposal.status === "pending";

  const onAccept = () =>
    accept.mutate(
      { workspaceId, proposalId: proposal.id, body: editing ? { text } : {} },
      {
        onSuccess: () => {
          setEditing(false);
          outcome.done(t("toast.accepted"));
        },
        onError: outcome.failed,
      },
    );
  const onReject = () =>
    reject.mutate(
      { workspaceId, proposalId: proposal.id },
      { onSuccess: () => outcome.done(t("toast.proposalRejected")), onError: outcome.failed },
    );
  const onToggle = () => {
    if (proposal.actionId === null) return;
    const args = { workspaceId, actionId: proposal.actionId };
    if (proposal.undone)
      redo.mutate(args, { onSuccess: () => outcome.done(t("toast.redone")), onError: outcome.failed });
    else undo.mutate(args, { onSuccess: () => outcome.done(t("toast.undone")), onError: outcome.failed });
  };

  const status = t(`proposal.status.${proposal.status}`);
  return (
    <article className="proposal" data-status={proposal.status} aria-label={proposal.title}>
      <header className="approval__head">
        <AgentSigil agentId={proposal.agentId} name="" aria-hidden="true" size="sm" />
        <span className="approval__asks">
          {t("proposal.proposes", { agent: directory.agentName(proposal.agentId) })}
        </span>
        <time className="approval__when" dateTime={proposal.createdAt}>
          {shortDateTime(proposal.createdAt, locale)}
        </time>
        <StatusBadge status={BADGE[proposal.status]} label={status} />
      </header>
      <h3 className="approval__title">{proposal.title}</h3>
      <p className="proposal__target">{target}</p>
      {proposal.why !== "" && (
        <Block label={t("proposal.why")}>
          <p>{proposal.why}</p>
        </Block>
      )}
      {proposal.evidence !== "" && (
        <Block label={t("proposal.evidence")}>
          <p>{proposal.evidence}</p>
        </Block>
      )}
      <Block label={t("proposal.diff")}>
        <pre className="control-exact control-diff">
          {diff.map((line, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: the lines of one diff, rebuilt as a whole
            <span key={index} data-kind={line.kind === "same" ? undefined : line.kind}>
              {line.kind !== "same" && <span className="vr-visually-hidden">{t(`diff.${line.kind}`)} </span>}
              <span aria-hidden="true">{line.kind === "add" ? "+ " : line.kind === "del" ? "- " : "  "}</span>
              {line.text}
              {"\n"}
            </span>
          ))}
        </pre>
      </Block>
      {pending && proposal.stale && <Callout tone="warning">{t("proposal.stale")}</Callout>}
      {pending && proposal.decidable && proposal.target.kind === "agent_prompt" && (
        <ProposalEval workspaceId={workspaceId} proposal={proposal} />
      )}
      {pending && proposal.decidable && editing && !proposal.stale && (
        <Field label={t("proposal.finalText")} hint={t("proposal.textHint", { max: TEXT_MAX })}>
          <Textarea
            rows={8}
            value={text}
            maxLength={TEXT_MAX}
            onChange={(event) => setText(event.target.value)}
          />
        </Field>
      )}
      {pending &&
        (proposal.decidable ? (
          <div className="approval__actions">
            <span className="approval__left">{t("proposal.rejectHelp")}</span>
            {!proposal.stale && !editing && (
              <Button variant="ghost" disabled={busy} onClick={() => setEditing(true)}>
                {t("proposal.edit")}
              </Button>
            )}
            <Button
              variant={proposal.stale ? "secondary" : "ghost"}
              loading={reject.isPending}
              disabled={busy}
              onClick={onReject}
            >
              {t("proposal.reject")}
            </Button>
            {!proposal.stale && (
              <Button
                variant="primary"
                loading={accept.isPending}
                disabled={busy || (editing && text.trim() === "")}
                onClick={onAccept}
              >
                {t("proposal.accept")}
              </Button>
            )}
          </div>
        ) : (
          <p className="control-note">{t("proposal.waiting")}</p>
        ))}
      {!pending && (
        <p className="control-note">
          {t("proposal.decidedBy", { status, name: directory.personName(proposal.decidedBy) })}
        </p>
      )}
      {proposal.status === "accepted" && proposal.undone && (
        <p className="control-note">{t("proposal.undone")}</p>
      )}
      {proposal.status === "accepted" && proposal.actionId !== null && proposal.canUndo && (
        <div className="approval__actions">
          <Button
            variant="secondary"
            loading={undo.isPending || redo.isPending}
            disabled={busy}
            onClick={onToggle}
          >
            {proposal.undone ? t("proposal.redo") : t("proposal.undo")}
          </Button>
        </div>
      )}
      {proposal.trail.length > 0 && (
        <footer className="approval__foot">
          <details className="control-trail">
            <summary>{t("proposal.trail")}</summary>
            <ol>
              {proposal.trail.map((entry, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: a trail only grows at its end
                <li key={index}>
                  <time dateTime={entry.at}>{shortDateTime(entry.at, locale)}</time>{" "}
                  {trailText(entry, "proposal", lookup)}
                </li>
              ))}
            </ol>
          </details>
        </footer>
      )}
    </article>
  );
}
