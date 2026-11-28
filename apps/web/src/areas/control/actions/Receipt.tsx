// The receipt of what an agent changed from one message (a post, a reminder, a memory, a page), with
// undo and redo while the window is open. A post or an email waits in the send queue first: the
// receipt counts the seconds down, and undoing then cancels it. The approval card shows it once the
// approved action ran, and the conversation shows it under the agent's answer. Who may undo follows
// the server's rule (queue.ts); the button disappears when the window closes.

import { useApiMutation } from "@vanr/client/react";
import type { AgentAction, Message } from "@vanr/contract";
import { Button } from "@vanr/ui";
import { Undo2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useLookup, useMessages } from "../../../i18n/react.tsx";
import { useClock, useSecondsUntil } from "../../../platform/clock.tsx";
import { type Directory, type Me, useOutcome } from "../shared.tsx";
import { isOpen, mayUndo, offer, queueOf } from "./queue.ts";

/** Re-renders when the next undo window closes, so its button goes away on time. */
function useWindowTick(actions: readonly AgentAction[]): number {
  const clock = useClock();
  const [now, setNow] = useState(() => clock.now());
  const next = actions
    .flatMap((action) => (action.revertibleUntil === null ? [] : [Date.parse(action.revertibleUntil)]))
    .filter((at) => at > now)
    .sort((a, b) => a - b)[0];
  useEffect(() => {
    if (next === undefined) return;
    return clock.setTimer(() => setNow(clock.now()), Math.max(0, next - clock.now()) + 50);
  }, [next, clock]);
  return now;
}

export function ActionReceipt({
  workspaceId,
  message,
  me,
  directory,
}: {
  workspaceId: string;
  message: Message;
  me: Me;
  directory: Directory;
}) {
  const t = useMessages("control");
  const outcome = useOutcome();
  const now = useWindowTick(message.actions);
  const [busy, setBusy] = useState<string | null>(null);
  const staleMessages = () => [
    { method: "listChannelMessages" as const, args: { workspaceId, channelId: message.channelId } },
  ];
  const undo = useApiMutation("undoAction", { invalidates: staleMessages });
  const redo = useApiMutation("redoAction", { invalidates: staleMessages });
  const undoAll = useApiMutation("undoMessageAction", { invalidates: staleMessages });
  const owner = message.author.type === "agent" ? directory.agentOwner(message.author.id) : undefined;
  const allowed = (action: AgentAction) => mayUndo(action, me, owner);
  const undoable = message.actions.filter(
    (action) => action.revertedAt === null && isOpen(action, now) && allowed(action),
  );

  const run = async (key: string, task: () => Promise<unknown>) => {
    setBusy(key);
    try {
      await task();
    } catch (error) {
      outcome.failed(error);
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="receipt" aria-label={t("receipt.label")}>
      <header className="receipt__head">
        <Undo2 aria-hidden="true" size={14} />
        <span>{t("receipt.count", { count: message.actions.length })}</span>
        {undoable.length > 1 && (
          <Button
            size="sm"
            variant="ghost"
            loading={busy === "all"}
            disabled={busy !== null}
            onClick={() =>
              void run("all", async () => {
                const result = await undoAll.mutateAsync({ workspaceId, messageId: message.id });
                if (result.failed.length > 0)
                  outcome.warn(t("receipt.partial", { count: result.failed.length }));
              })
            }
          >
            {t("receipt.undoAll")}
          </Button>
        )}
      </header>
      <ul className="receipt__list">
        {message.actions.map((action) => (
          <ActionRow
            key={action.id}
            action={action}
            now={now}
            busy={busy}
            button={offer(action, now, allowed(action))}
            reverter={directory.personName(action.reverterUserId)}
            onToggle={(direction) =>
              void run(action.id, () =>
                (direction === "undo" ? undo : redo).mutateAsync({ workspaceId, actionId: action.id }),
              )
            }
          />
        ))}
      </ul>
    </section>
  );
}

function ActionRow({
  action,
  now,
  busy,
  button,
  reverter,
  onToggle,
}: {
  action: AgentAction;
  now: number;
  busy: string | null;
  button: "undo" | "redo" | null;
  reverter: string;
  onToggle: (direction: "undo" | "redo") => void;
}) {
  const t = useMessages("control");
  const lookup = useLookup("control");
  const queue = queueOf(action, now);
  const seconds = useSecondsUntil(queue?.queued ? queue.sendAt : undefined);
  const title = { title: action.target.title ?? "" };
  const text =
    queue !== null
      ? (lookup(`queued.${action.kind === "mail_sent" ? "mail_sent" : "message_posted"}`, title) ?? "")
      : (lookup(`kind.${action.kind}`, title) ?? action.kind);
  return (
    <li
      className="receipt__item"
      data-state={queue?.queued && seconds > 0 ? "queued" : action.revertedAt ? "undone" : "done"}
    >
      <span className="receipt__text">{text}</span>
      {queue?.queued && seconds > 0 && (
        <span className="receipt__meta" role="timer">
          {t("receipt.sendsIn", { count: seconds })}
        </span>
      )}
      {queue !== null && (queue.sending || (queue.queued && seconds === 0)) && (
        <span className="receipt__meta">{t("receipt.sending")}</span>
      )}
      {queue?.failed && (
        <span className="receipt__meta receipt__meta--failed">
          {t("receipt.notSent", { error: queue.failed })}
        </span>
      )}
      {action.revertedAt !== null && (
        <span className="receipt__meta">
          {queue !== null
            ? t("receipt.canceled", { name: reverter })
            : t("receipt.undone", { name: reverter })}
        </span>
      )}
      {button !== null && (
        <Button
          size="sm"
          variant="secondary"
          loading={busy === action.id}
          disabled={busy !== null}
          onClick={() => onToggle(button)}
        >
          {button === "undo" ? t("receipt.undo") : t("receipt.redo")}
        </Button>
      )}
    </li>
  );
}
