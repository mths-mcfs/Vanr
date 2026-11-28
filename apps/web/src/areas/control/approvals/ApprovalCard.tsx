// One approval: what the agent wants to do, how far the effect reaches (K0 reads, K3 cannot be
// undone), the exact effect (recipients, the whole text, links with their real destination, the
// diff), why it asks, and, for whoever the server lets decide, the decision. "Always allow for 30
// days" shows only when the server says what it would remember. Approving and editing send the hash
// of the version on screen, so a request that changed meanwhile is never approved blind. Once the
// approved action ran, the card shows the receipt of what it changed, with undo.
import { useQueryClient } from "@tanstack/react-query";
import { prefixKey, useApiMutation, useApiQuery, useVanrClient } from "@vanr/client/react";
import type { Approval, EffectClass } from "@vanr/contract";
import { AgentSigil, Button, Callout, Checkbox, StatusBadge } from "@vanr/ui";
import { useState } from "react";
import { AppLink } from "../../../app/navigation.tsx";
import { useLocale, useLookup, useMessages } from "../../../i18n/react.tsx";
import { useSecondsUntil } from "../../../platform/clock.tsx";
import { useChannelSubscription } from "../../../realtime/react.tsx";
import { ActionReceipt } from "../actions/Receipt.tsx";
import {
  APPROVAL_BADGE,
  allowanceFor,
  approvalTitle,
  isMisleading,
  ruleText,
  shortDateTime,
  timeLeft,
  trailText,
} from "../format.ts";
import { Block, type Directory, type Me, useOutcome } from "../shared.tsx";
import { EditDialog, RejectDialog } from "./Decide.tsx";

const EFFECTS: readonly EffectClass[] = ["K0", "K1", "K2", "K3"];

/** Four steps, from only reading (K0) to what cannot be undone (K3). */
function EffectScale({ effect }: { effect: EffectClass }) {
  const t = useMessages("control");
  const level = EFFECTS.indexOf(effect);
  const label = t(`effect.${effect}`);
  return (
    <div className="effect-scale" data-effect={effect}>
      <span className="effect-scale__steps" role="img" aria-label={t("effect.scale", { label })}>
        {EFFECTS.map((step, index) => (
          <span key={step} className="effect-scale__step" data-on={index <= level || undefined} />
        ))}
      </span>
      <span className="effect-scale__code" aria-hidden="true">
        {effect}
      </span>
      <span className="effect-scale__label" aria-hidden="true">
        {label}
      </span>
    </div>
  );
}

function EffectPreview({ approval }: { approval: Approval }) {
  const t = useMessages("control");
  const preview = approval.preview;
  const body = preview?.body ?? approval.detail;
  return (
    <>
      {preview?.recipients !== undefined && preview.recipients.length > 0 && (
        <Block label={t("card.to")}>
          <ul className="control-tags">
            {preview.recipients.map((recipient) => (
              <li key={recipient}>{recipient}</li>
            ))}
          </ul>
        </Block>
      )}
      {body !== "" && (
        <Block label={t("card.exact")}>
          <pre className="control-exact">{body}</pre>
        </Block>
      )}
      {preview?.links !== undefined && preview.links.length > 0 && (
        <Block label={t("card.links")}>
          <ul className="control-links">
            {preview.links.map((link) => (
              <li key={link} data-misleading={isMisleading(link) || undefined}>
                <code>{link}</code>
                {isMisleading(link) && <span className="control-links__warn">{t("card.misleading")}</span>}
              </li>
            ))}
          </ul>
        </Block>
      )}
      {preview?.diff !== undefined && preview.diff !== "" && (
        <Block label={t("card.diff")}>
          <pre className="control-exact control-diff">
            {preview.diff.split("\n").map((line, index) => (
              <span
                // The diff's lines have no identity of their own: the same text can repeat.
                // biome-ignore lint/suspicious/noArrayIndexKey: lines of one fixed text, never reordered
                key={index}
                data-kind={line.startsWith("+ ") ? "add" : line.startsWith("- ") ? "del" : undefined}
              >
                {line}
                {"\n"}
              </span>
            ))}
          </pre>
        </Block>
      )}
    </>
  );
}

function WhyGate({ approval }: { approval: Approval }) {
  const t = useMessages("control");
  const lookup = useLookup("control");
  const reason = approval.gateReason === null ? undefined : lookup(`gate.${approval.gateReason}`);
  if (reason === undefined && approval.flags.length === 0) return null;
  return (
    <Block label={t("card.whyGate")}>
      {reason !== undefined && <p>{reason}</p>}
      {approval.flags.length > 0 && (
        <ul className="control-flags">
          {approval.flags.map((flag) => (
            <li key={`${flag.flag}:${flag.source}`} data-flag={flag.flag}>
              {t("card.flag", { flag: t(`flag.${flag.flag}`), source: flag.source })}
            </li>
          ))}
        </ul>
      )}
    </Block>
  );
}

export function ApprovalCard({
  workspaceId,
  approval,
  me,
  directory,
  readableChannels,
}: {
  workspaceId: string;
  approval: Approval;
  me: Me;
  directory: Directory;
  /** The channels the person can read: the conversation link and the receipt need one of these. */
  readableChannels: ReadonlySet<string>;
}) {
  const t = useMessages("control");
  const lookup = useLookup("control");
  const { locale } = useLocale();
  const outcome = useOutcome();
  const client = useVanrClient();
  const queryClient = useQueryClient();
  const [rejecting, setRejecting] = useState(false);
  // The version the edit started from: its fields and its hash go together, so a request that changed while
  // the dialog was open is refused by the server instead of approved with fields the person never saw.
  const [editing, setEditing] = useState<Approval | null>(null);
  // The rule the person ticked "always allow" for: a request whose rule changed since asks for a new tick.
  const [remember, setRemember] = useState<string | null>(null);
  const title = approvalTitle(approval, lookup);
  const expiresAt = Date.parse(approval.expiresAt);
  const secondsLeft = useSecondsUntil(approval.status === "pending" ? expiresAt : undefined);
  // Past its deadline the server expires it: the decision is no longer offered while that lands.
  const lapsed = approval.status === "pending" && secondsLeft === 0;
  const pending = approval.status === "pending" && !lapsed;
  const deciding = pending && approval.decidable;
  const readable = approval.channelId !== null && readableChannels.has(approval.channelId);
  // Following the conversation brings the card's events (and the receipt's) to people who don't decide.
  useChannelSubscription(readable ? (approval.channelId ?? undefined) : undefined);

  const changed = (remembered: boolean) => [
    { method: "listApprovals" as const, args: { workspaceId } },
    { method: "getApproval" as const, args: { workspaceId, approvalId: approval.id } },
    { method: "getOverview" as const, args: { workspaceId } },
    ...(remembered ? [{ method: "listApprovalRules" as const, args: { workspaceId } }] : []),
  ];
  const approve = useApiMutation("approveApproval", {
    invalidates: (args) => changed(args.body?.remember === true),
  });
  const edit = useApiMutation("editApproval", {
    invalidates: (args) => changed(args.body?.remember === true),
  });
  const reject = useApiMutation("rejectApproval", { invalidates: () => changed(false) });
  const busy = approve.isPending || edit.isPending || reject.isPending;
  // "Remember" goes with the decision only while its box is on screen and ticked for the rule it shows.
  const remembering = remember !== null && remember === approval.rememberLabel;
  /** A refused decision shows the request as it is now, to look at again; nothing is sent again. */
  const failed = (error: unknown) => {
    outcome.failed(error);
    for (const method of ["listApprovals", "getApproval"] as const)
      void queryClient.invalidateQueries({ queryKey: prefixKey(client, { method, args: { workspaceId } }) });
  };

  const onApprove = () =>
    approve.mutate(
      {
        workspaceId,
        approvalId: approval.id,
        body: {
          ...(approval.payloadHash !== null && { payloadHash: approval.payloadHash }),
          remember: remembering,
        },
      },
      {
        onError: failed,
        onSuccess: () => outcome.done(t(remembering ? "toast.remembered" : "toast.approved")),
      },
    );
  const onEdit = (from: Approval, input: Record<string, unknown>) =>
    edit.mutate(
      {
        workspaceId,
        approvalId: approval.id,
        body: { input, payloadHash: from.payloadHash ?? "", remember: remembering },
      },
      {
        onError: (error) => {
          setEditing(null);
          failed(error);
        },
        onSuccess: () => {
          setEditing(null);
          outcome.done(t(remembering ? "toast.remembered" : "toast.approved"));
        },
      },
    );
  const onReject = (reason: string | undefined) =>
    reject.mutate(
      { workspaceId, approvalId: approval.id, body: reason === undefined ? {} : { reason } },
      {
        onError: failed,
        onSuccess: () => {
          setRejecting(false);
          outcome.done(t("toast.rejected"));
        },
      },
    );

  const status = t(`status.${approval.status}`);
  const decider = directory.personName(approval.deciderUserId);
  return (
    <article
      className="approval"
      data-status={approval.status}
      data-effect={approval.effect ?? undefined}
      aria-label={title}
    >
      <header className="approval__head">
        <AgentSigil agentId={approval.agentId} name="" aria-hidden="true" size="sm" />
        <span className="approval__asks">
          {t("card.asks", { agent: directory.agentName(approval.agentId) })}
        </span>
        <time className="approval__when" dateTime={approval.createdAt}>
          {shortDateTime(approval.createdAt, locale)}
        </time>
        <StatusBadge status={APPROVAL_BADGE[approval.status]} label={status} />
      </header>
      <h3 className="approval__title">{title}</h3>
      {approval.effect !== null && <EffectScale effect={approval.effect} />}
      <EffectPreview approval={approval} />
      {approval.edited && <p className="control-note">{t("card.edited")}</p>}
      {approval.why !== "" && (
        <Block label={t("card.why")}>
          <p>{approval.why}</p>
        </Block>
      )}
      {pending && <WhyGate approval={approval} />}
      {deciding && approval.rememberLabel !== null && (
        <div className="approval__remember">
          <Checkbox
            checked={remembering}
            disabled={busy}
            onCheckedChange={(next) => setRemember(next === true ? approval.rememberLabel : null)}
            label={t("remember.label")}
            hint={`${ruleText(approval.tool, approval.rememberLabel, lookup)}. ${t("remember.help")}`}
          />
        </div>
      )}
      {pending &&
        (approval.decidable ? (
          <div className="approval__actions">
            <span className="approval__left">
              {t("card.timeLeft", {
                time: timeLeft(approval.expiresAt, expiresAt - secondsLeft * 1000, locale),
              })}
            </span>
            <Button variant="ghost" disabled={busy} onClick={() => setRejecting(true)}>
              {t("action.reject")}
            </Button>
            {approval.editable.length > 0 && approval.input !== null && (
              <Button variant="secondary" disabled={busy} onClick={() => setEditing(approval)}>
                {t("action.edit")}
              </Button>
            )}
            <Button
              variant={approval.effect === "K3" ? "danger" : "primary"}
              loading={approve.isPending}
              disabled={busy}
              onClick={onApprove}
            >
              {t(`allow.${allowanceFor(approval.tool)}`)}
            </Button>
          </div>
        ) : (
          <p className="control-note">
            {directory.isMember(approval.ownerUserId)
              ? t("card.waitingFor", { name: directory.personName(approval.ownerUserId) })
              : t("card.waitingAdmin")}
          </p>
        ))}
      {(approval.status === "approved" || approval.status === "rejected") && (
        <p className="control-note">
          {approval.reason !== null && approval.reason !== ""
            ? t("card.decidedByReason", { status, name: decider, reason: approval.reason })
            : t("card.decidedBy", { status, name: decider })}
        </p>
      )}
      {approval.status === "approved" && <Result approval={approval} />}
      {(approval.status === "expired" || lapsed) && <p className="control-note">{t("card.expired")}</p>}
      {approval.status === "canceled" && <p className="control-note">{t("card.canceled")}</p>}
      {approval.status === "approved" &&
        approval.appliedAt !== null &&
        readable &&
        approval.channelId !== null && (
          <RunReceipt
            workspaceId={workspaceId}
            channelId={approval.channelId}
            threadId={approval.threadId}
            runId={approval.runId}
            me={me}
            directory={directory}
          />
        )}
      <footer className="approval__foot">
        <details className="control-trail">
          <summary>{t("card.trail")}</summary>
          <ol>
            {approval.trail.map((entry, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: a trail only grows at its end
              <li key={index}>
                <time dateTime={entry.at}>{shortDateTime(entry.at, locale)}</time>{" "}
                {trailText(entry, "approval", lookup)}
              </li>
            ))}
          </ol>
        </details>
        {readable && approval.channelId !== null && (
          <ConversationLink workspaceId={workspaceId} approval={approval} />
        )}
      </footer>
      {/* A request someone else decided, or that ran out of time, takes its open dialog with it. */}
      {deciding && rejecting && (
        <RejectDialog busy={reject.isPending} onReject={onReject} onClose={() => setRejecting(false)} />
      )}
      {deciding && editing !== null && (
        <EditDialog
          approval={editing}
          busy={edit.isPending}
          onSave={(input) => onEdit(editing, input)}
          onClose={() => setEditing(null)}
        />
      )}
    </article>
  );
}

function Result({ approval }: { approval: Approval }) {
  const t = useMessages("control");
  if (approval.result === null) return <p className="approval__result">{t("result.running")}</p>;
  // A success's text is the tool's answer to the model (English, with ids); a failure's is its reason.
  if (approval.result.ok)
    return (
      <p className="approval__result" data-ok="true">
        {t("result.done")}
      </p>
    );
  return (
    <Callout tone="danger" className="approval__result">
      {approval.result.text === ""
        ? t("result.failed")
        : t("result.failedWith", { text: approval.result.text })}
    </Callout>
  );
}

function ConversationLink({ workspaceId, approval }: { workspaceId: string; approval: Approval }) {
  const t = useMessages("control");
  if (approval.threadId !== null)
    return (
      <AppLink className="app-link" route="thread" params={{ workspaceId, threadId: approval.threadId }}>
        {t("card.conversation")}
      </AppLink>
    );
  return (
    <AppLink
      className="app-link"
      route="channel"
      params={{ workspaceId, channelId: approval.channelId ?? "" }}
    >
      {t("card.conversation")}
    </AppLink>
  );
}

/** What the approved run changed: its answer carries the receipt, found by the run. */
function RunReceipt({
  workspaceId,
  channelId,
  threadId,
  runId,
  me,
  directory,
}: {
  workspaceId: string;
  channelId: string;
  threadId: string | null;
  runId: string | null;
  me: Me;
  directory: Directory;
}) {
  const messages = useApiQuery(
    "listChannelMessages",
    { workspaceId, channelId, query: threadId === null ? {} : { threadId } },
    { enabled: runId !== null },
  );
  const answer = messages.data?.find((message) => message.runId === runId && message.actions.length > 0);
  if (answer === undefined) return null;
  return <ActionReceipt workspaceId={workspaceId} message={answer} me={me} directory={directory} />;
}
