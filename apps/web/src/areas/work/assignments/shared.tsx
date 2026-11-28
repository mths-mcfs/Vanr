// What the assignment screens and cards share: the server's limits, who acted on the trail, where an
// assignment lives, and the queries a change on an assignment makes stale.

import type { KeyPrefix } from "@vanr/client/react";
import type { Assignment, AssignmentActorRef } from "@vanr/contract";
import { useMessages } from "../../../i18n/react.tsx";
import type { Actors } from "../issues/shared.tsx";

export const GOAL_MAX = 4_000;
export const ASSIGNMENT_TITLE_MAX = 120;
export const CLOSE_NOTE_MAX = 4_000;
export const REVIEW_NOTE_MAX = 4_000;

export const isClosedAssignment = (assignment: Pick<Assignment, "status">) =>
  assignment.status === "done" || assignment.status === "canceled";

/** Everything a change on one assignment can make stale: its own reads and the lists it shows in. */
/**
 * How much of an assignment is open, and how much of it waits on this person: requests to take
 * part only on who may let people in, the rest only on someone who may act.
 */
export function pendingOf(assignment: Pick<Assignment, "pending" | "actionable" | "manageable">) {
  const open = Object.values(assignment.pending).reduce((sum, count) => sum + count, 0);
  const mine =
    (assignment.actionable ? open - assignment.pending.joinRequests : 0) +
    (assignment.manageable ? assignment.pending.joinRequests : 0);
  return { open, waiting: mine };
}

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
