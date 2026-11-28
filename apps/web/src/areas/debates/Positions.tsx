// The positions as a grid: one row per participant, one column per round, and the agents' majority of each
// closed round at the foot. While the debate runs an agent's row carries only the letter the server sent;
// its name shows once the server reveals who spoke. A change of position says whether it came with a reason.
import type { DebateDetail, DebateMajority, DebatePost } from "@vanr/contract";
import { useMessages } from "../../i18n/react.tsx";
import type { Directory } from "./shared.tsx";

type Lane = { key: string; label: string; letter: string | null; cells: Map<number, DebatePost> };

/** Whose row a post sits in: its author when the server names one, otherwise its letter. */
const laneKey = (post: DebatePost) =>
  post.author !== null ? `${post.author.type}:${post.author.id}` : `letter:${post.pseudonym ?? "?"}`;

export function useSpeaker(directory: Directory): (post: DebatePost) => string {
  const t = useMessages("debates");
  return (post) =>
    post.author !== null ? directory.name(post.author) : t("pos.letter", { letter: post.pseudonym ?? "?" });
}

export function useMajorityText(): (majority: DebateMajority | null | undefined) => string {
  const t = useMessages("debates");
  return (majority) => {
    if (!majority || majority.total === 0) return t("pos.noVotes");
    const top = majority.groups[0];
    if (majority.winner !== null && top !== undefined)
      return t("pos.lead", { answer: majority.winner, count: top.count, total: majority.total });
    return t("pos.split", {
      groups: majority.groups
        .map((group) => t("pos.group", { answer: group.answer, count: group.count }))
        .join(", "),
    });
  };
}

export function Positions({ debate, directory }: { debate: DebateDetail; directory: Directory }) {
  const t = useMessages("debates");
  const speaker = useSpeaker(directory);
  const majorityText = useMajorityText();
  const rounds = debate.track.roundLimit;
  if (rounds.length === 0) return null;
  const byId = new Map(debate.posts.map((post) => [post.id, post]));
  const lanes = new Map<string, Lane>();
  for (const round of rounds)
    for (const id of round.posts) {
      const post = byId.get(id);
      if (post === undefined) continue;
      const key = laneKey(post);
      const lane = lanes.get(key) ?? { key, label: speaker(post), letter: post.pseudonym, cells: new Map() };
      lane.cells.set(round.round, post);
      lanes.set(key, lane);
    }
  // Agents in letter order, then the people by name.
  const sorted = [...lanes.values()].sort((a, b) =>
    (a.letter ?? `~${a.label}`).localeCompare(b.letter ?? `~${b.label}`),
  );
  const roundName = (round: number) => (round === 0 ? t("pos.opening") : t("pos.round", { round }));
  return (
    <section className="debate-section" aria-labelledby="debate-positions">
      <h2 className="debate-section__title" id="debate-positions">
        {t("pos.title")}
      </h2>
      <div className="debate-grid__scroll">
        <table className="debate-grid">
          <thead>
            <tr>
              <th scope="col">{t("pos.who")}</th>
              {rounds.map((round) => (
                <th key={round.round} scope="col">
                  {roundName(round.round)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((lane) => (
              <tr key={lane.key}>
                <th scope="row" className="debate-grid__who">
                  {lane.label}
                  {/* Once revealed, the letter the agent spoke under stays beside its name. */}
                  {lane.letter !== null && !lane.key.startsWith("letter:") && (
                    <span className="debate-grid__letter">{lane.letter}</span>
                  )}
                </th>
                {rounds.map((round) => (
                  <Cell key={round.round} post={lane.cells.get(round.round)} />
                ))}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">{t("pos.majority")}</th>
              {rounds.map((round) => (
                <td key={round.round}>{majorityText(round.majority)}</td>
              ))}
            </tr>
          </tfoot>
        </table>
      </div>
      <p className="debate-section__note">{t("pos.note")}</p>
    </section>
  );
}

function Cell({ post }: { post: DebatePost | undefined }) {
  const t = useMessages("debates");
  if (post === undefined) return <td className="debate-grid__cell" data-empty="" />;
  if (post.kind === "out_of_budget")
    return (
      <td className="debate-grid__cell" data-muted="">
        {t("pos.skipped")}
      </td>
    );
  const claim = post.claimData;
  if (claim === null)
    return (
      <td className="debate-grid__cell" data-muted="">
        {t("pos.none")}
      </td>
    );
  // Changing without a reason or evidence is the mark of going along, not of being persuaded.
  const bare = claim.changed && claim.reason.trim() === "" && claim.evidence.length === 0;
  return (
    <td className="debate-grid__cell" data-changed={claim.changed ? (bare ? "bare" : "argued") : undefined}>
      <a className="debate-grid__answer" href={`#debate-post-${post.id}`}>
        {claim.answer}
      </a>
      {claim.confidence !== null && (
        <span className="debate-grid__confidence">
          {t("pos.confidence", { value: Math.round(claim.confidence * 100) })}
        </span>
      )}
      {claim.changed && (
        <span className="debate-grid__changed">
          {bare
            ? t("pos.changedBare")
            : t("pos.changed", { reason: claim.reason || claim.evidence.join("; ") })}
        </span>
      )}
    </td>
  );
}
