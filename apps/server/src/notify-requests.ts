// "Waiting on you" derived from the request, not from the event: the notice waits while the request behind it
// (approval, question, secret, browser, debate turn, command or assignment) is open in the database.
// notify checks it on creation, and the tick closes the notice of a request that was resolved by a path that
// forgot to close it (or that closed it before the notice existed).
import { type Db, schema } from "@vanr/engine/db";
import { type RequestRef, requestOf } from "@vanr/engine/notify-rules";
import { inArray, sql } from "drizzle-orm";

const {
  approvals,
  questions,
  secretPrompts,
  browserInterventions,
  debates,
  assignmentCommands,
  assignments,
} = schema;

export interface WaitingKey {
  userId: string;
  groupKey: string;
}

const keyOf = (k: WaitingKey) => `${k.userId}|${k.groupKey}`;

/**
 * State of the request behind each notice: `open`, `closed` (exists and was resolved), `missing` (the row
 * was not found: deleted, or still in an unfinished transaction) or `unknown` (a groupKey with no request
 * we know how to check, which counts as open).
 */
export type RequestState = "open" | "closed" | "missing" | "unknown";

export async function requestStates(db: Db, keys: readonly WaitingKey[]): Promise<Map<string, RequestState>> {
  const states = new Map<string, RequestState>();
  for (const key of keys) states.set(keyOf(key), requestOf(key.groupKey) ? "missing" : "unknown");
  const found = new Set<string>();
  const open = new Set<string>();
  const byType = new Map<RequestRef["type"], { key: WaitingKey; ref: RequestRef }[]>();
  for (const key of keys) {
    const ref = requestOf(key.groupKey);
    if (!ref) continue;
    const list = byType.get(ref.type) ?? [];
    list.push({ key, ref });
    byType.set(ref.type, list);
  }
  const idsOf = (type: RequestRef["type"], pick: (r: RequestRef) => string) => [
    ...new Set((byType.get(type) ?? []).map((x) => pick(x.ref))),
  ];
  const mark = (
    type: RequestRef["type"],
    pick: (r: RequestRef) => string,
    ok: Set<string>,
    seen: Set<string>,
  ) => {
    for (const x of byType.get(type) ?? []) {
      if (seen.has(pick(x.ref))) found.add(keyOf(x.key));
      if (ok.has(pick(x.ref))) open.add(keyOf(x.key));
    }
  };
  const split = <R extends { id: string; open: boolean }>(rows: R[]) =>
    [new Set(rows.filter((r) => r.open).map((r) => r.id)), new Set(rows.map((r) => r.id))] as const;
  const idOf = (r: RequestRef) => ("id" in r ? r.id : "");

  const approvalIds = idsOf("approval", idOf);
  if (approvalIds.length) {
    const rows = await db
      .select({ id: approvals.id, open: sql<boolean>`${approvals.status} = 'pending'` })
      .from(approvals)
      .where(inArray(approvals.id, approvalIds));
    mark("approval", idOf, ...split(rows));
  }
  const questionIds = idsOf("question", idOf);
  if (questionIds.length) {
    const rows = await db
      .select({ id: questions.id, open: sql<boolean>`${questions.status} = 'open'` })
      .from(questions)
      .where(inArray(questions.id, questionIds));
    mark("question", idOf, ...split(rows));
  }
  const secretIds = idsOf("secret", idOf);
  if (secretIds.length) {
    const rows = await db
      .select({ id: secretPrompts.id, open: sql<boolean>`${secretPrompts.status} = 'pending'` })
      .from(secretPrompts)
      .where(inArray(secretPrompts.id, secretIds));
    mark("secret", idOf, ...split(rows));
  }
  const interventionIds = idsOf("intervention", idOf);
  if (interventionIds.length) {
    // "active": the person already took over the browser; the notice closes (the runner pairing routes do the same).
    const rows = await db
      .select({ id: browserInterventions.id, open: sql<boolean>`${browserInterventions.status} = 'pending'` })
      .from(browserInterventions)
      .where(inArray(browserInterventions.id, interventionIds));
    mark("intervention", idOf, ...split(rows));
  }
  const turns = byType.get("debate_turn") ?? [];
  if (turns.length) {
    const debateIds = [...new Set(turns.map((t) => (t.ref.type === "debate_turn" ? t.ref.debateId : "")))];
    const rows = await db
      .select({
        id: debates.id,
        status: debates.status,
        phase: debates.phase,
        pendingSpeakers: debates.pendingSpeakers,
      })
      .from(debates)
      .where(inArray(debates.id, debateIds));
    const seen = new Set(rows.map((r) => r.id));
    // Debates: the round is parallel, so every person who still has to answer has the turn (the
    // same rule as `pendingPeople` in the debate module), not only the head of the queue.
    const due = new Map(
      rows
        .filter((r) => r.status === "open" && r.phase !== "concluding")
        .map((r) => [r.id, new Set(r.pendingSpeakers.filter((a) => a.type === "person").map((a) => a.id))]),
    );
    for (const t of turns) {
      if (t.ref.type !== "debate_turn") continue;
      if (seen.has(t.ref.debateId)) found.add(keyOf(t.key));
      if (due.get(t.ref.debateId)?.has(t.key.userId)) open.add(keyOf(t.key));
    }
  }
  const commands = byType.get("assignment_command") ?? [];
  if (commands.length) {
    const messageIds = [
      ...new Set(commands.map((c) => (c.ref.type === "assignment_command" ? c.ref.messageId : ""))),
    ];
    const rows = await db
      .select({
        id: assignmentCommands.messageId,
        open: sql<boolean>`${assignmentCommands.state} = 'pending'`,
      })
      .from(assignmentCommands)
      .where(inArray(assignmentCommands.messageId, messageIds));
    mark(
      "assignment_command",
      (r) => (r.type === "assignment_command" ? r.messageId : ""),
      ...split(rows.map((r) => ({ id: r.id ?? "", open: r.open }))),
    );
  }
  const assignmentIds = idsOf("assignment", (r) => (r.type === "assignment" ? r.assignmentId : ""));
  if (assignmentIds.length) {
    // Question, join request and submission of an assignment: open while the assignment is not over (the end closes
    // all its notices; the answer to each request closes its own in the assignment routes).
    const rows = await db
      .select({ id: assignments.id, open: sql<boolean>`${assignments.status} not in ('done', 'canceled')` })
      .from(assignments)
      .where(inArray(assignments.id, assignmentIds));
    mark("assignment", (r) => (r.type === "assignment" ? r.assignmentId : ""), ...split(rows));
  }
  for (const k of found) states.set(k, open.has(k) ? "open" : "closed");
  return states;
}

export { keyOf as waitingKeyOf };

/** Only a notice request that has existed for this long counts as missing (it may be inside a transaction). */
export const MISSING_GRACE_MS = 60_000;

/** The request behind the notice ended: resolved, or missing for longer than the grace period. */
export function requestEnded(state: RequestState | undefined, updatedAt: Date, now: Date): boolean {
  return (
    state === "closed" || (state === "missing" && now.getTime() - updatedAt.getTime() > MISSING_GRACE_MS)
  );
}
