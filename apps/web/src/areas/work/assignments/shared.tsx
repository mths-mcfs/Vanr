// What the assignment screens and cards share: the server's limits, who acted on the trail, where an
// assignment lives, and the queries a change on an assignment makes stale.

import { useQueryClient } from "@tanstack/react-query";
import { type KeyPrefix, prefixKey, useVanrClient } from "@vanr/client/react";
import type { Assignment, AssignmentActorRef } from "@vanr/contract";
import { useMessages } from "../../../i18n/react.tsx";
import type { Actors } from "../issues/shared.tsx";

export const GOAL_MAX = 4_000;
export const ASSIGNMENT_TITLE_MAX = 120;
export const CLOSE_NOTE_MAX = 4_000;
export const REVIEW_NOTE_MAX = 4_000;

export const isClosedAssignment = (assignment: Pick<Assignment, "status">) =>
  assignment.status === "done" || assignment.status === "canceled";

/**
 * How much of an assignment is open, and how much of it waits on this person, counted from its pending
 * items as the server's "waiting on you" counts them: nothing for who may not act; never a provisional
 * decision; requests to take part only for the owner, who answers them. The server's list also puts an
 * assignment there for a pause on the cost ceiling or a stuck step, which have no count here, so such a
 * row says nothing waits while the "Waiting on you" tab lists it.
 */
export function pendingOf(assignment: Pick<Assignment, "pending" | "actionable" | "role">) {
  const p = assignment.pending;
  const open = Object.values(p).reduce((sum, count) => sum + count, 0);
  const waiting = assignment.actionable
    ? p.decisions +
      p.reviews +
      p.commands +
      p.submissions +
      (assignment.role === "owner" ? p.joinRequests : 0)
    : 0;
  return { open, waiting };
}

/** Everything a change on one assignment can make stale: its own reads and the lists it shows in. */
export function assignmentKeys(workspaceId: string, assignmentId: string): KeyPrefix[] {
  const own = { workspaceId, assignmentId };
  return [
    { method: "listAssignments", args: { workspaceId } },
    { method: "getAssignment", args: own },
    { method: "getAssignmentSummary", args: own },
    { method: "getAssignmentPlan", args: own },
    { method: "listAssignmentDecisions", args: own },
    { method: "listAssignmentSubmissions", args: own },
    { method: "listAssignmentReviews", args: own },
    { method: "listAssignmentCommands", args: own },
    { method: "listAssignmentParticipants", args: own },
    { method: "listAssignmentJoinRequests", args: own },
    { method: "listAssignmentEvents", args: own },
  ];
}

/** Who acted on an assignment: a person or the agent by name, the checker or the product itself. */
export function useActorName(actors: Actors): (actor: AssignmentActorRef) => string {
  const t = useMessages("work");
  return (actor) => {
    if (actor.type === "verifier") return t("asg.who.verifier");
    if (actor.type === "system" || actor.id === null) return t("asg.who.system");
    return actors.name({ type: actor.type, id: actor.id });
  };
}

/** Loads the assignment's reads again: after a 409, someone else changed it first. */
export function useAssignmentRefresh(workspaceId: string, assignmentId: string): () => void {
  const queries = useQueryClient();
  const client = useVanrClient();
  return () => {
    for (const prefix of assignmentKeys(workspaceId, assignmentId))
      void queries.invalidateQueries({ queryKey: prefixKey(client, prefix) });
  };
}
