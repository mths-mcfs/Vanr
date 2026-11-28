// What the issue screens share: the server's limits, the stages and priorities in order, the names of
// the people and agents an issue mentions, the marks a card and a row draw (stage, priority, criteria),
// how a description turns into criteria, and where a card lands between two others.
import { useApiQuery } from "@vanr/client/react";
import { type ActorRef, can, type IssueColumn, type IssuePriority, type IssueStage } from "@vanr/contract";
import { useToast } from "@vanr/ui";
import { useMemo } from "react";
import { useErrorMessage } from "../../../app/screens.tsx";
import { useMessages } from "../../../i18n/react.tsx";
import { useSession } from "../../../session/react.tsx";

/** The server's own limits: the forms stop at them instead of sending what it would refuse. */
export const TITLE_MAX = 300;
export const DESCRIPTION_MAX = 50_000;
export const CRITERIA_MAX = 50;
export const CRITERION_MAX = 500;
export const COMMENT_MAX = 20_000;
export const SEARCH_MAX = 200;

export const STAGES = [
  "todo",
  "in_progress",
  "reviewing",
  "done",
  "canceled",
] as const satisfies readonly IssueStage[];
export const PRIORITIES = [
  "none",
  "low",
  "medium",
  "high",
  "urgent",
] as const satisfies readonly IssuePriority[];

/** How often the issues are read again: only the columns have an event of their own. */
export const ISSUES_REFRESH_MS = 60_000;

export const isClosed = (stage: IssueStage) => stage === "done" || stage === "canceled";

/** A column's name: the one it was given, or its stage's. */
export function useColumnName() {
  const t = useMessages("work");
  return (column: Pick<IssueColumn, "name" | "stage">) =>
    column.name.trim() === "" ? t(`stage.${column.stage}`) : column.name;
}

/** The select value for nobody: a select's item can't have an empty value. */
export const NOBODY = "none";

/** An assignee as a select's value: "agent:<id>", "person:<id>", or NOBODY. */
export const actorValue = (actor: ActorRef | null): string =>
  actor === null ? NOBODY : `${actor.type}:${actor.id}`;

export function actorFromValue(value: string): ActorRef | null {
  const at = value.indexOf(":");
  if (at < 0) return null;
  const type = value.slice(0, at);
  const id = value.slice(at + 1);
  return (type === "agent" || type === "person") && id !== "" ? { type, id } : null;
}

export type Actors = {
  /** The name of a person or an agent; "Someone" while unknown. */
  name: (actor: ActorRef | null) => string;
  people: readonly { id: string; name: string; handle: string }[];
  /** Every live agent of the workspace. */
  agents: readonly { id: string; name: string; handle: string; reachable: boolean }[];
  /** The agents the signed-in person may set to work: the only ones the server lets them hand an issue to. */
  reachable: readonly { id: string; name: string; handle: string }[];
};

/** The people and agents of the workspace, by name. */
export function useActors(workspaceId: string): Actors {
  const t = useMessages("work");
  const members = useApiQuery("listMembers", { workspaceId });
  const agents = useApiQuery("listAgents", { workspaceId });
  return useMemo(() => {
    const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
    const people = (members.data ?? [])
      .map((member) => ({ id: member.userId, name: member.name, handle: member.handle }))
      .sort(byName);
    const live = (agents.data ?? [])
      .filter((agent) => agent.archivedAt === null)
      .map((agent) => ({ id: agent.id, name: agent.name, handle: agent.handle, reachable: agent.reachable }))
      .sort(byName);
    const names = new Map<string, string>([
      ...people.map((person) => [`person:${person.id}`, person.name] as const),
      ...(agents.data ?? []).map((agent) => [`agent:${agent.id}`, agent.name] as const),
    ]);
    return {
      name: (actor) => (actor === null ? t("someone") : (names.get(actorValue(actor)) ?? t("someone"))),
      people,
      agents: live,
      reachable: live.filter((agent) => agent.reachable),
    };
  }, [members.data, agents.data, t]);
}

/** The signed-in person's id. */
export function useMyId(): string {
  return useSession().me?.user.id ?? "";
}

/** Whether the signed-in person may see the workspace's usage and costs (admins and owners). */
export function useSeesUsage(workspaceId: string): boolean {
  const { me } = useSession();
  const role = me?.workspaces.find((workspace) => workspace.id === workspaceId)?.role ?? "member";
  return can(role, "view_usage");
}

/** Whether the signed-in person sets the workspace up (admins and owners): the server decides, this hides. */
export function useConfigures(workspaceId: string): boolean {
  const { me } = useSession();
  const role = me?.workspaces.find((workspace) => workspace.id === workspaceId)?.role ?? "member";
  return can(role, "configure");
}

/** Says a change went through, or why it did not, in a toast. */
export function useOutcome() {
  const toast = useToast();
  const describe = useErrorMessage("work");
  return {
    done: (title: string) => toast.push({ tone: "success", title }),
    failed: (error: unknown, title?: string) =>
      toast.push({
        tone: "danger",
        title: title ?? describe(error),
        ...(title !== undefined && { description: describe(error) }),
      }),
  };
}

// A line that is a list item: "- text", "* text", "[ ] text", "- [x] text". The marker alone is no criterion.
const ITEM = /^\s*(?:[-*]\s+)?\[[ xX]?\]\s*(.*)$|^\s*[-*]\s+(.*)$|^\s*[-*]\s*$/;

/** A description as typed: the list lines become acceptance criteria, the rest stays the description. */
export function splitCriteria(text: string): { description: string; criteria: string[] } {
  const criteria: string[] = [];
  const kept: string[] = [];
  for (const line of text.split("\n")) {
    const match = ITEM.exec(line);
    if (match === null) {
      kept.push(line);
      continue;
    }
    const item = (match[1] ?? match[2] ?? "").trim();
    if (item !== "") criteria.push(item);
  }
  return { description: kept.join("\n").trim(), criteria };
}

const STEP = 1024;

/**
 * The board position for a card dropped between `before` and `after` (the positions of its new
 * neighbours, either missing at an end of the column).
 */
export function positionBetween(before: number | undefined, after: number | undefined): number {
  if (before === undefined && after === undefined) return 0;
  if (before === undefined) return (after ?? 0) - STEP;
  if (after === undefined) return before + STEP;
  return (before + after) / 2;
}

/** The stage's tone, for the rule above a column and the dot beside a row. */
export function StageDot({ stage }: { stage: IssueStage }) {
  return <span className={`work-stage work-stage--${stage}`} aria-hidden="true" />;
}

/** Four ticks, filled up to the priority: read at a glance, named for a screen reader. */
export function PriorityMark({ priority }: { priority: IssuePriority }) {
  const t = useMessages("work");
  if (priority === "none") return null;
  const level = PRIORITIES.indexOf(priority);
  return (
    <span
      className={`work-priority work-priority--${priority}`}
      role="img"
      aria-label={t("priority.label", { level: t(`priority.${priority}`) })}
    >
      {[1, 2, 3, 4].map((tick) => (
        <span key={tick} className={tick <= level ? "work-priority__tick is-on" : "work-priority__tick"} />
      ))}
    </span>
  );
}

/** One notch per criterion, filled when it is met. */
export function CriteriaMark({ criteria }: { criteria: readonly { id: string; done: boolean }[] }) {
  const t = useMessages("work");
  if (criteria.length === 0) return null;
  const done = criteria.filter((criterion) => criterion.done).length;
  return (
    <span
      className="work-criteria"
      role="img"
      aria-label={t("criteria.progress", { done, total: criteria.length })}
    >
      {/* Past ten the notches stop being countable at a glance: the numbers carry it alone. */}
      {criteria.length <= 10 &&
        criteria.map((criterion) => (
          <span
            key={criterion.id}
            className={criterion.done ? "work-criteria__notch is-on" : "work-criteria__notch"}
          />
        ))}
      <span className="work-criteria__count" aria-hidden="true">
        {done}/{criteria.length}
      </span>
    </span>
  );
}
