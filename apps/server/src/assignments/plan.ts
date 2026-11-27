// The assignment's plan as a table (`assignment_plan_items`), with a version and an author per edit. Person,
// agent, verifier and engine write through the same path (`writePlan`), which locks the assignment row: two
// edits at once lose no item, and whoever sent an old `parentVersion` gets 409.
//
// Rules:
// - `passes` doesn't come in here: only the verifier writes it (verify.ts).
// - A person doesn't mark done; they drop an item (dropped) or put it back in the plan (todo). Changing the
//   title or criteria of an item already judged clears the verdict (the verifier looks again) and the turns.
// - The agent doesn't remove what a person or the verifier added: an item of theirs the agent omits stays.
// - Dropping an item in progress doesn't stop the work under way (the screen warns).
import type { AssignmentActorRef, AssignmentPlanItem } from "@vanr/contract";
import { schema } from "@vanr/engine/db";
import { planItemWorkState } from "@vanr/engine/work-state";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { AppDeps } from "../context";
import { HttpError } from "../http";
import { itemStuck } from "./state";

const { assignments, assignmentPlanItems, assignmentPlanVersions } = schema;
type AssignmentActor = schema.AssignmentActor;
type PlanItemStatusRow = schema.PlanItemStatusRow;

export type PlanItemRow = typeof assignmentPlanItems.$inferSelect;
export const MAX_PLAN_ITEMS = 60;

interface PlanInput {
  id?: string;
  title: string;
  criteria?: string;
  milestone?: string | null;
  status?: PlanItemStatusRow;
  kind?: PlanItemRow["kind"];
  fixes?: string | null;
  /**
   * A validation's fix: it goes in only while the item it fixes is still done at the epoch and round that were
   * judged, read under the plan's lock (an edit in between makes the verdict about another item).
   */
  judged?: { epoch: number; checks: number };
}

export async function planOf(deps: Pick<AppDeps, "db">, assignmentId: string): Promise<PlanItemRow[]> {
  return deps.db
    .select()
    .from(assignmentPlanItems)
    .where(eq(assignmentPlanItems.assignmentId, assignmentId))
    .orderBy(asc(assignmentPlanItems.ord), asc(assignmentPlanItems.createdAt));
}

export async function itemOf(
  deps: Pick<AppDeps, "db">,
  assignmentId: string,
  itemId: string,
): Promise<PlanItemRow | null> {
  const [row] = await deps.db
    .select()
    .from(assignmentPlanItems)
    .where(and(eq(assignmentPlanItems.assignmentId, assignmentId), eq(assignmentPlanItems.id, itemId)));
  return row ?? null;
}

const actorRef = (a: AssignmentActor): AssignmentActorRef => ({ type: a.type, id: a.id });

export function toPlanItem(row: PlanItemRow): AssignmentPlanItem {
  const stallReason = itemStuck(row);
  return {
    id: row.id,
    title: row.title,
    criteria: row.criteria,
    milestone: row.milestone,
    kind: row.kind,
    fixes: row.fixes,
    status: row.status,
    // Stuck (attempts or validation rounds ran out) waits for the person to ask for another try.
    state: stallReason ? "blocked_on_you" : planItemWorkState(row.status),
    stallReason,
    passes: row.passes,
    verdict: row.verdict,
    verifiedAt: row.verifiedAt?.toISOString() ?? null,
    summary: row.summary,
    createdBy: actorRef(row.createdBy),
    updatedBy: actorRef(row.updatedBy),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const snapshot = (items: PlanItemRow[]) =>
  items.map((i) => ({
    id: i.id,
    title: i.title,
    criteria: i.criteria,
    milestone: i.milestone,
    status: i.status,
  }));

const ID_RE = /^[\w-]{1,40}$/;
/** Validation group: the milestone, or the item itself (a fix goes to the group of the item it fixes). */
export function groupOf(
  item: Pick<PlanItemRow, "id" | "milestone" | "fixes">,
  byId: ReadonlyMap<string, Pick<PlanItemRow, "id" | "milestone" | "fixes">>,
): string {
  let cur: Pick<PlanItemRow, "id" | "milestone" | "fixes"> = item;
  for (let hops = 0; hops < 20; hops++) {
    if (cur.milestone) return `m:${cur.milestone}`;
    const parent = cur.fixes ? byId.get(cur.fixes) : undefined;
    if (!parent) return `i:${cur.id}`;
    cur = parent;
  }
  return `i:${cur.id}`;
}

/** Item a person or the verifier added: the agent neither removes nor rewrites it. */
const isLocked = (i: Pick<PlanItemRow, "createdBy">) =>
  i.createdBy.type === "person" || i.createdBy.type === "verifier";

interface PlanWrite {
  version: number;
  items: PlanItemRow[];
  added: string[];
  removed: string[];
  edited: string[];
}

/**
 * Replaces the plan with the given list (in the given order). `mode`:
 * - `person`: an omitted item leaves (dropped); status only `todo`/`dropped`.
 * - `agent`: an omitted item leaves, except the person's and the verifier's; any status (done = the agent
 *   says it did it; the verifier judges). The agent neither removes nor rewrites an item of a person or of
 *   the verifier: it only changes its progress.
 * - `append`: only adds the new items (fixed IDs: repeating doesn't duplicate) and touches the given status.
 */
export async function writePlan(
  deps: AppDeps,
  assignmentId: string,
  input: {
    author: AssignmentActor;
    mode: "person" | "agent" | "append" | "import";
    items: PlanInput[];
    parentVersion?: number;
    note?: string;
  },
): Promise<PlanWrite> {
  const at = deps.now();
  return deps.db.transaction(async (tx) => {
    const [m] = await tx
      .select({ planVersion: assignments.planVersion })
      .from(assignments)
      .where(eq(assignments.id, assignmentId))
      .for("update");
    if (!m) throw new HttpError(404, "assignment.not_found", "Assignment not found");
    if (input.parentVersion !== undefined && input.parentVersion !== m.planVersion)
      throw new HttpError(409, "assignment.plan_changed", "The plan changed since you opened it", {
        version: m.planVersion,
      });
    const current = await tx
      .select()
      .from(assignmentPlanItems)
      .where(eq(assignmentPlanItems.assignmentId, assignmentId))
      .orderBy(asc(assignmentPlanItems.ord), asc(assignmentPlanItems.createdAt));
    const byId = new Map(current.map((i) => [i.id, i]));
    const used = new Set(current.map((i) => i.id));
    let n = current.length;
    const nextId = () => {
      let id: string;
      do id = `p${++n}`;
      while (used.has(id));
      used.add(id);
      return id;
    };

    // Final list: [id, changes] in order.
    type Draft = { row: PlanItemRow | null; next: PlanItemRow };
    const drafts: Draft[] = [];
    const seen = new Set<string>();
    const added: string[] = [];
    const edited: string[] = [];
    for (const raw of input.items) {
      const title = raw.title.trim().slice(0, 300);
      if (!title) continue;
      const criteria = (raw.criteria ?? "").trim().slice(0, 2000);
      const milestone = raw.milestone?.trim().slice(0, 80) || null;
      const old = raw.id && byId.has(raw.id) && !seen.has(raw.id) ? (byId.get(raw.id) as PlanItemRow) : null;
      if (old) {
        seen.add(old.id);
        // What a person or the verifier added the agent neither rewrites nor removes (the criteria are the contract).
        const locked = input.mode === "agent" && isLocked(old);
        const textChanged =
          !locked &&
          (old.title !== title ||
            (raw.criteria !== undefined && old.criteria !== criteria) ||
            (raw.milestone !== undefined && old.milestone !== milestone));
        let status = old.status;
        if (raw.status && raw.status !== old.status) {
          if (input.mode === "person") {
            if (raw.status === "dropped" || raw.status === "todo") status = raw.status;
          } else if (!(locked && raw.status === "dropped")) status = raw.status;
        }
        const changed = textChanged || status !== old.status;
        // Back to work (put back in the plan, redo): the old verdict doesn't hold for the redone item.
        const reopened = status !== old.status && (status === "todo" || status === "doing");
        const reset = textChanged || (changed && input.mode === "person");
        const next: PlanItemRow = {
          ...old,
          title: locked ? old.title : title,
          criteria: !locked && raw.criteria !== undefined ? criteria : old.criteria,
          milestone: !locked && raw.milestone !== undefined ? milestone : old.milestone,
          status,
          ...(textChanged || reopened ? { passes: null, verdict: null, verifiedAt: null } : {}),
          // New text clears the rounds; a person touching it clears the turns (the "try again"). Once cleared, the
          // epoch changes: the engine's keys (fix, verdict) don't collide with the old round's.
          ...(textChanged ? { checks: 0 } : {}),
          ...(changed && input.mode === "person" ? { turns: 0, checks: 0 } : {}),
          ...(reset ? { epoch: old.epoch + 1 } : {}),
          ...(status === "done" && old.status !== "done" ? { doneAt: at } : {}),
          ...(changed ? { updatedBy: input.author, updatedAt: at } : {}),
        };
        if (changed) edited.push(old.id);
        drafts.push({ row: old, next });
      } else {
        if (input.mode === "append" && raw.id && byId.has(raw.id)) continue;
        if (raw.judged) {
          const target = raw.fixes ? byId.get(raw.fixes) : undefined;
          if (
            target?.status !== "done" ||
            target.epoch !== raw.judged.epoch ||
            target.checks !== raw.judged.checks
          )
            continue;
        }
        let id: string;
        if (raw.id && ID_RE.test(raw.id) && !used.has(raw.id)) {
          id = raw.id;
          used.add(id);
        } else id = nextId();
        let status: PlanItemStatusRow = raw.status ?? "todo";
        if (input.mode !== "import" && (input.mode === "person" || status === "dropped")) status = "todo";
        added.push(id);
        drafts.push({
          row: null,
          next: {
            assignmentId,
            id,
            ord: 0,
            title,
            criteria,
            milestone,
            kind: raw.kind ?? (input.author.type === "person" && input.mode === "append" ? "change" : "work"),
            fixes: raw.fixes ?? null,
            status,
            passes: null,
            verdict: null,
            verifiedAt: null,
            checks: 0,
            summary: null,
            turns: 0,
            epoch: 0,
            createdBy: input.author,
            updatedBy: input.author,
            createdAt: at,
            updatedAt: at,
            doneAt: status === "done" ? at : null,
          },
        });
      }
    }

    // The ones left out of the list.
    const removed: string[] = [];
    const keep = (old: PlanItemRow) => input.mode === "append" || (input.mode === "agent" && isLocked(old));
    const order: Draft[] = [];
    const leftovers = current.filter((i) => !seen.has(i.id));
    if (input.mode === "append") {
      // Previous order; a touched item stays in place and a new one goes after the item it fixes (or at the end).
      order.push(...current.map((row) => ({ row, next: row })));
      for (const d of drafts) {
        if (d.row) {
          order[order.findIndex((o) => o.next.id === d.next.id)] = d;
          continue;
        }
        let i = d.next.fixes ? order.findIndex((o) => o.next.id === d.next.fixes) : -1;
        // After the other fixes of the same item.
        if (i >= 0) while (order[i + 1]?.next.fixes === d.next.fixes) i++;
        if (i >= 0) order.splice(i + 1, 0, d);
        else order.push(d);
      }
    } else {
      order.push(...drafts);
      for (const old of leftovers) {
        if (keep(old)) {
          // Stays where it was: after the previous neighbour that still exists.
          const before = current.slice(0, current.indexOf(old)).reverse();
          const anchor = before.find((b) => order.some((o) => o.next.id === b.id));
          const i = anchor ? order.findIndex((o) => o.next.id === anchor.id) + 1 : 0;
          order.splice(i, 0, { row: old, next: old });
        } else if (old.status !== "dropped") {
          removed.push(old.id);
          order.push({
            row: old,
            next: { ...old, status: "dropped", updatedBy: input.author, updatedAt: at },
          });
        } else order.push({ row: old, next: old });
      }
    }
    // A removed item takes its fix items with it, done or not: no fix is left without the item it fixes.
    const gone = new Set(order.flatMap((o) => (o.next.status === "dropped" ? [o.next.id] : [])));
    for (let grew = true; grew; ) {
      grew = false;
      for (const o of order) {
        if (o.next.kind !== "fix" || !o.next.fixes || !gone.has(o.next.fixes) || o.next.status === "dropped")
          continue;
        o.next = { ...o.next, status: "dropped", updatedBy: input.author, updatedAt: at };
        gone.add(o.next.id);
        if (!removed.includes(o.next.id)) removed.push(o.next.id);
        grew = true;
      }
    }
    if (order.filter((o) => o.next.status !== "dropped").length > MAX_PLAN_ITEMS)
      throw new HttpError(400, "assignment.plan_too_long", `A plan has at most ${MAX_PLAN_ITEMS} items`);

    const final = order.map((o, i) => ({ ...o, next: { ...o.next, ord: i } }));
    const changed =
      added.length > 0 ||
      removed.length > 0 ||
      edited.length > 0 ||
      final.some((o) => o.row && o.row.ord !== o.next.ord);
    if (!changed) return { version: m.planVersion, items: final.map((o) => o.next), added, removed, edited };

    for (const o of final) {
      if (!o.row) await tx.insert(assignmentPlanItems).values(o.next).onConflictDoNothing();
      else if (o.row !== o.next)
        await tx
          .update(assignmentPlanItems)
          .set({
            ord: o.next.ord,
            title: o.next.title,
            criteria: o.next.criteria,
            milestone: o.next.milestone,
            status: o.next.status,
            passes: o.next.passes,
            verdict: o.next.verdict,
            verifiedAt: o.next.verifiedAt,
            checks: o.next.checks,
            turns: o.next.turns,
            epoch: o.next.epoch,
            doneAt: o.next.doneAt,
            updatedBy: o.next.updatedBy,
            updatedAt: o.next.updatedAt,
          })
          .where(
            and(eq(assignmentPlanItems.assignmentId, assignmentId), eq(assignmentPlanItems.id, o.next.id)),
          );
    }
    const version = m.planVersion + 1;
    await tx
      .update(assignments)
      .set({ planVersion: version, updatedAt: at })
      .where(eq(assignments.id, assignmentId));
    const items = final.map((o) => o.next);
    await tx.insert(assignmentPlanVersions).values({
      assignmentId,
      version,
      author: input.author,
      note: input.note?.slice(0, 500) ?? null,
      items: snapshot(items),
      createdAt: at,
    });
    return { version, items, added, removed, edited };
  });
}

/** Changes item fields that are not a plan edit (progress, summary, turns). Doesn't bump the version. */
export async function touchItem(
  deps: AppDeps,
  assignmentId: string,
  itemId: string,
  set: Partial<
    Pick<
      PlanItemRow,
      | "status"
      | "summary"
      | "turns"
      | "doneAt"
      | "updatedBy"
      | "checks"
      | "epoch"
      | "passes"
      | "verdict"
      | "verifiedAt"
    >
  > & {
    turnsPlus?: number;
  },
  /** Only an item in one of these statuses changes (the state read before may be stale). */
  from?: readonly PlanItemRow["status"][],
): Promise<PlanItemRow | null> {
  const { turnsPlus, ...rest } = set;
  const [row] = await deps.db
    .update(assignmentPlanItems)
    .set({
      ...rest,
      ...(turnsPlus ? { turns: sql`${assignmentPlanItems.turns} + ${turnsPlus}` } : {}),
      updatedAt: deps.now(),
    })
    .where(
      and(
        eq(assignmentPlanItems.assignmentId, assignmentId),
        eq(assignmentPlanItems.id, itemId),
        from ? inArray(assignmentPlanItems.status, [...from]) : undefined,
      ),
    )
    .returning();
  return row ?? null;
}

export async function planVersions(deps: AppDeps, assignmentId: string) {
  return deps.db
    .select()
    .from(assignmentPlanVersions)
    .where(eq(assignmentPlanVersions.assignmentId, assignmentId))
    .orderBy(asc(assignmentPlanVersions.version));
}

/** An assignment from before the table: the jsonb plan becomes rows (once, at boot). */
export async function importLegacyPlan(
  deps: AppDeps,
  row: {
    id: string;
    planVersion: number;
    plan: { items: { id: string; title: string; status: PlanItemStatusRow; note?: string }[] };
    agentId: string;
  },
): Promise<boolean> {
  if (row.planVersion > 0 || row.plan.items.length === 0) return false;
  if ((await planOf(deps, row.id)).length > 0) return false;
  await writePlan(deps, row.id, {
    author: { type: "agent", id: row.agentId },
    mode: "import",
    items: row.plan.items.map((i) => ({ id: i.id, title: i.title, status: i.status, criteria: i.note })),
    note: "imported",
  });
  return true;
}
