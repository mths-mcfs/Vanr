// What the debate screens share: the server's limits, the names of who sits at a table, who the
// signed-in person is in a debate (waited on, steering it, part of it), the state a debate is in, and
// what the person's role lets them see.
import { type MutateOptions, useQueryClient } from "@tanstack/react-query";
import type { ApiError, ArgsOf, MethodName, ResultOf } from "@vanr/client";
import {
  type ApiMutationOptions,
  type KeyPrefix,
  prefixKey,
  useApiMutation,
  useApiQuery,
  useVanrClient,
} from "@vanr/client/react";
import { type ActorRef, can, type Debate, type DebateSpeaker } from "@vanr/contract";
import { useToast, type WorkStatus } from "@vanr/ui";
import { useCallback, useMemo, useRef } from "react";
import { useErrorMessage } from "../../app/screens.tsx";
import { useLocale, useMessages } from "../../i18n/react.tsx";
import { useSession } from "../../session/react.tsx";

/** The server's own limits on opening a debate: the form stops at them instead of being refused. */
export const QUESTION_MAX = 200;
export const GOAL_MAX = 4_000;
export const AGENTS_MAX = 8;
/** Seats at the table, agents and people together. */
export const SEATS_MAX = 20;
export const OPTION_MAX = 200;
export const OPTIONS_MIN = 2;
export const OPTIONS_MAX = 8;
export const CAP_MIN = 0.1;
export const CAP_MAX = 100;
/** The choices of challenge rounds the form offers, besides the workspace's default. */
export const ROUND_CHOICES = [1, 2, 3, 5, 10] as const;

export const isFinished = (debate: Pick<Debate, "status">) =>
  debate.status === "done" || debate.status === "canceled";

export type Directory = {
  /** A person's or an agent's name; "Someone" while unknown. */
  name: (actor: ActorRef) => string;
  people: readonly { id: string; name: string }[];
  /** The agents the signed-in person can seat: live and reachable by them. */
  seatable: readonly { id: string; name: string }[];
  /** Each list's state: loading, failed (with its error) or there. */
  peopleState: ListState;
  agentsState: ListState;
  retry: () => void;
};

export type ListState = { status: "loading" } | { status: "failed"; error: unknown } | { status: "ready" };

function listState(query: { data: unknown; isError: boolean; error: unknown }): ListState {
  if (query.data !== undefined) return { status: "ready" };
  return query.isError ? { status: "failed", error: query.error } : { status: "loading" };
}

/** The workspace's people and agents by name, and the agents a person can bring to a table. */
export function useDirectory(workspaceId: string): Directory {
  const t = useMessages("debates");
  const peopleQuery = useApiQuery("listMembers", { workspaceId });
  const agentsQuery = useApiQuery("listAgents", { workspaceId });
  return useMemo(() => {
    const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
    const people = (peopleQuery.data ?? []).map((m) => ({ id: m.userId, name: m.name })).sort(byName);
    // An archived agent, or one on someone else's personal plan, is refused at the table: neither is offered.
    const seatable = (agentsQuery.data ?? [])
      .filter((agent) => agent.archivedAt === null && agent.reachable)
      .map((agent) => ({ id: agent.id, name: agent.name }))
      .sort(byName);
    const names = new Map<string, string>([
      ...people.map((p) => [`person:${p.id}`, p.name] as const),
      ...(agentsQuery.data ?? []).map((a) => [`agent:${a.id}`, a.name] as const),
    ]);
    return {
      name: (actor) => names.get(`${actor.type}:${actor.id}`) ?? t("someone"),
      people,
      seatable,
      peopleState: listState(peopleQuery),
      agentsState: listState(agentsQuery),
      retry: () => {
        if (peopleQuery.data === undefined) void peopleQuery.refetch();
        if (agentsQuery.data === undefined) void agentsQuery.refetch();
      },
    };
  }, [peopleQuery, agentsQuery, t]);
}

/** The signed-in person and their role in this workspace. */
export function useMe(workspaceId: string): { id: string; role: Parameters<typeof can>[0] } {
  const { me } = useSession();
  const role = me?.workspaces.find((workspace) => workspace.id === workspaceId)?.role ?? "member";
  return { id: me?.user.id ?? "", role };
}

/** Whether the person may see what things cost. The server decides; this only hides. */
export function useSeesSpend(workspaceId: string): boolean {
  return can(useMe(workspaceId).role, "view_usage");
}

/** Characters as the server counts them: code points, so an emoji is one. */
export const charCount = (text: string) => [...text].length;

/**
 * A latch for an action that must start once: a second click before the screen redraws (when a pending
 * flag would disable the button) is dropped. `start` gets `done`, to call when the request settles.
 */
export function useOnce(): (start: (done: () => void) => void) => void {
  const busy = useRef(false);
  return useCallback((start) => {
    if (busy.current) return;
    busy.current = true;
    start(() => {
      busy.current = false;
    });
  }, []);
}

/** A sum of money in dollars, or null when the server sent none (the person may not see it). */
export function usdText(usd: number | null | undefined, locale: string): string | null {
  if (typeof usd !== "number" || !Number.isFinite(usd)) return null;
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 4,
  }).format(usd);
}

export function useMoney(): (usd: number | null | undefined) => string | null {
  const { locale } = useLocale();
  return useMemo(() => (usd: number | null | undefined) => usdText(usd, locale), [locale]);
}

type Hosted = Pick<Debate, "createdBy" | "requesterUserId" | "leadUserId">;

/** Opened, asked for or leads the debate: who it waits on when it gets stuck. */
export const startedBy = (debate: Hosted, userId: string) =>
  (debate.createdBy.type === "person" && debate.createdBy.id === userId) ||
  debate.requesterUserId === userId ||
  debate.leadUserId === userId;

/** Takes part in the debate in some way: what "Yours" lists. */
export const takesPart = (debate: Hosted & Pick<Debate, "userIds">, userId: string) =>
  startedBy(debate, userId) || debate.userIds.includes(userId);

/** The debate waits on this person: their turn, or it is stuck and they started it. */
export const needsMe = (debate: Debate, userId: string) =>
  (debate.status === "open" && debate.waitingUserIds.includes(userId)) ||
  (debate.status === "stalled" && startedBy(debate, userId));

export type DebateState =
  | "yourTurn"
  | "arguing"
  | "waitingPeople"
  | "summing"
  | "stuck"
  | "done"
  | "canceled";

export function stateOf(debate: Debate, userId: string): DebateState {
  if (debate.status === "done") return "done";
  if (debate.status === "canceled") return "canceled";
  if (debate.status === "stalled") return "stuck";
  if (debate.waitingUserIds.includes(userId)) return "yourTurn";
  if (debate.phase === "concluding") return "summing";
  if (debate.phase === "human_turn") return "waitingPeople";
  return "arguing";
}

/** The badge each state wears: its glyph says the state without the color. */
export const STATE_BADGE: Record<DebateState, WorkStatus> = {
  yourTurn: "awaiting-reply",
  arguing: "running",
  waitingPeople: "awaiting-reply",
  summing: "running",
  stuck: "failed",
  done: "done",
  canceled: "paused",
};

/** Who sits at the table, in speaking order; an agent that only reads the debate comes after. */
export function seatsOf(debate: Pick<Debate, "speakers" | "agentIds" | "userIds">): DebateSpeaker[] {
  const seen = new Set(debate.speakers.map((s) => `${s.type}:${s.id}`));
  return [
    ...debate.speakers,
    ...debate.agentIds.filter((id) => !seen.has(`agent:${id}`)).map((id) => ({ type: "agent" as const, id })),
    ...debate.userIds
      .filter((id) => !seen.has(`person:${id}`))
      .map((id) => ({ type: "person" as const, id })),
  ];
}

/** The reads a change on one debate makes stale: its own and the list it shows in. */
export function debateKeys(workspaceId: string, debateId: string): KeyPrefix[] {
  return [
    { method: "getDebate", args: { workspaceId, debateId } },
    { method: "listDebates", args: { workspaceId } },
  ];
}

/** Says a change went through, or why it didn't, and loads the debate again after a refusal. */
export function useDebateOutcome(workspaceId: string, debateId: string) {
  const toast = useToast();
  const describe = useErrorMessage("debates");
  const queries = useQueryClient();
  const client = useVanrClient();
  const refresh = () => {
    for (const prefix of debateKeys(workspaceId, debateId))
      void queries.invalidateQueries({ queryKey: prefixKey(client, prefix) });
  };
  return {
    done: (title: string) => toast.push({ tone: "success", title }),
    failed: (error: unknown) => {
      toast.push({ tone: "danger", title: describe(error) });
      // A 409 means someone else moved the debate first: show it as it is now.
      refresh();
    },
    refresh,
  };
}

/**
 * A mutation that starts once per click: `fire` drops a second call made before the first settles,
 * even within the same tick, when the pending flag has not reached the screen yet.
 */
export function useLatchedMutation<K extends MethodName>(method: K, options?: ApiMutationOptions<K>) {
  const mutation = useApiMutation(method, options);
  const once = useOnce();
  const fire = (args: ArgsOf<K>, callbacks?: MutateOptions<ResultOf<K>, ApiError, ArgsOf<K>>) =>
    once((done) => mutation.mutate(args, { ...callbacks, onSettled: done }));
  return { ...mutation, fire };
}
