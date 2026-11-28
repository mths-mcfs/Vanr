// The state of one action an agent took, as its receipt shows it. A post or an email waits in the
// send queue (target type "outbox") for the undo window before it leaves: undoing it then cancels it,
// and there is nothing to redo.
import type { AgentAction, Role } from "@vanr/contract";
import { can } from "@vanr/contract";

/** The action can still be undone or redone: its window has not closed. */
export const isOpen = (action: AgentAction, now: number) =>
  action.revertibleUntil !== null && Date.parse(action.revertibleUntil) > now;

export type QueueState = {
  /** When the post or email leaves (a clock time in ms). */
  sendAt: number;
  /** Why it did not leave, when it failed. */
  failed: string | null;
  /** Still waiting: the seconds count down. */
  queued: boolean;
  /** The window passed and the post has not appeared yet. */
  sending: boolean;
  /** Undone inside the window: nothing went out. */
  canceled: boolean;
};

/** The send queue's view of an action, or null for an action that never went through it. */
export function queueOf(action: AgentAction, now: number): QueueState | null {
  if (action.target.type !== "outbox" || typeof action.params.sendAt !== "string") return null;
  const sendAt = Date.parse(action.params.sendAt);
  const failed = typeof action.params.failed === "string" ? action.params.failed : null;
  const waiting = action.revertedAt === null && failed === null;
  return {
    sendAt,
    failed,
    queued: waiting && sendAt > now,
    sending: waiting && sendAt <= now && action.kind === "message_posted",
    canceled: action.revertedAt !== null,
  };
}

/**
 * Whether the person may undo the action, as the server decides it: whoever asked the agent, the
 * agent's owner, or someone who manages agents. The server checks again on every undo.
 */
export function mayUndo(
  action: AgentAction,
  me: { userId: string; role: Role },
  agentOwnerId: string | undefined,
): boolean {
  return action.requesterUserId === me.userId || agentOwnerId === me.userId || can(me.role, "manage_agents");
}

/** The button the action offers now, if any: undo, redo, or nothing (closed, or canceled in the queue). */
export function offer(action: AgentAction, now: number, allowed: boolean): "undo" | "redo" | null {
  if (!allowed || !isOpen(action, now)) return null;
  if (action.revertedAt === null) return "undo";
  return queueOf(action, now) === null ? "redo" : null;
}
