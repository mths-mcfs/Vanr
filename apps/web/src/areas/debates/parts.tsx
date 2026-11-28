// The pieces a debate wears wherever it shows: its state, the round it is in drawn as a rail, and the
// table, one seat per participant in speaking order with the ones it waits on marked.
import type { Debate } from "@vanr/contract";
import { AgentSigil, Avatar, StatusBadge } from "@vanr/ui";
import { useMessages } from "../../i18n/react.tsx";
import { type Directory, STATE_BADGE, seatsOf, stateOf } from "./shared.tsx";

export function DebateState({ debate, me }: { debate: Debate; me: string }) {
  const t = useMessages("debates");
  const state = stateOf(debate, me);
  return <StatusBadge status={STATE_BADGE[state]} label={t(`state.${state}`)} />;
}

/** Where the debate is, in words: the sealed opening, a vote, or round N of the limit. */
export function useRoundLabel(): (debate: Pick<Debate, "round" | "roundLimit">) => string {
  const t = useMessages("debates");
  return ({ round, roundLimit }) => {
    if (roundLimit === 0) return t("row.vote");
    if (round === 0) return t("row.opening");
    return t("row.round", { round: Math.min(round, roundLimit), limit: roundLimit });
  };
}

/**
 * The rounds as a rail: a ring for the sealed opening, then one notch per round of challenge, filled up
 * to where the debate is. Only drawn; the words beside it say the same.
 */
export function RoundRail({ debate }: { debate: Pick<Debate, "round" | "roundLimit" | "status"> }) {
  const finished = debate.status === "done" || debate.status === "canceled";
  const notches = Array.from({ length: debate.roundLimit }, (_, index) => index + 1);
  const reached = (round: number) => finished || round <= debate.round;
  return (
    <span className="debate-rail" aria-hidden="true" data-finished={finished || undefined}>
      <span className="debate-rail__opening" data-reached="" />
      {notches.map((round) => (
        <span
          key={round}
          className="debate-rail__notch"
          data-reached={reached(round) ? "" : undefined}
          data-current={!finished && round === debate.round ? "" : undefined}
        />
      ))}
    </span>
  );
}

/** The table in speaking order. A person or agent the round still waits on is ringed. */
export function Table({ debate, directory }: { debate: Debate; directory: Directory }) {
  const t = useMessages("debates");
  const seats = seatsOf(debate);
  const live = debate.status === "open";
  return (
    <ul className="debate-table" aria-label={t("row.seats")}>
      {seats.map((seat) => {
        const name = directory.name(seat);
        const waited = live && seat.type === "person" && debate.waitingUserIds.includes(seat.id);
        const thinking = live && seat.type === "agent" && debate.engagedAgentIds.includes(seat.id);
        const label = waited ? t("row.waitsOn", { name }) : thinking ? t("row.thinking", { name }) : name;
        return (
          <li
            key={`${seat.type}:${seat.id}`}
            className="debate-table__seat"
            data-waited={waited || undefined}
            title={label}
          >
            {seat.type === "agent" ? (
              <AgentSigil agentId={seat.id} name={name} size="sm" working={thinking} aria-hidden="true" />
            ) : (
              <Avatar name={name} size="sm" aria-hidden="true" />
            )}
            <span className="vr-visually-hidden">{label}</span>
          </li>
        );
      })}
    </ul>
  );
}
