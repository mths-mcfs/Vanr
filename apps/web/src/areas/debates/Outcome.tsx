// How a debate ended: the synthesis (decision, summary, where the table agrees and what is still open,
// dissent, the majority before and after the challenges), the steps it proposes with the issues already
// made from them, the verdict and its acceptance, and the blind read that checks whether the debate
// beat a single agent's first answer.
import { useApiMutation, useApiQuery } from "@vanr/client/react";
import type { DebateDetail, DebateIssueItem } from "@vanr/contract";
import { Button, Callout, Checkbox } from "@vanr/ui";
import { useState } from "react";
import { AppLink } from "../../app/navigation.tsx";
import { useErrorMessage } from "../../app/screens.tsx";
import { useMessages } from "../../i18n/react.tsx";
import { useRelativeTime } from "../../i18n/relative-time.tsx";
import { useMajorityText } from "./Positions.tsx";
import { type Directory, debateKeys, useDebateOutcome, useLatchedMutation, useOnce } from "./shared.tsx";

/** The server takes at most this many steps per request, with these lengths. */
const ISSUES_PER_REQUEST = 30;
const ISSUE_TITLE_MAX = 300;
const ISSUE_OWNER_MAX = 100;
const ISSUE_STEP_MAX = 500;

/** Cuts text to a limit without leaving half an emoji or a trailing space, as the server keeps it. */
export function fit(text: string, max: number): string {
  const cut = text.trim().slice(0, max);
  return (/[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut).trimEnd();
}

/** A step of the synthesis as the server takes it; its title matches the issue it becomes. */
export function issueItem(step: { title: string; owner?: string; step?: string }): DebateIssueItem {
  const owner = step.owner?.trim() ?? "";
  const detail = step.step?.trim() ?? "";
  return {
    title: fit(step.title, ISSUE_TITLE_MAX),
    ...(owner !== "" && { owner: fit(owner, ISSUE_OWNER_MAX) }),
    ...(detail !== "" && { step: fit(detail, ISSUE_STEP_MAX) }),
  };
}

type Props = { workspaceId: string; debate: DebateDetail; directory: Directory; steers: boolean };

export function Outcome({ workspaceId, debate, directory, steers }: Props) {
  if (debate.synthesis === null && debate.status !== "done") return null;
  return (
    <>
      {debate.synthesis !== null && (
        <Synthesis
          key={debate.synthesis.revision}
          workspaceId={workspaceId}
          debate={debate}
          steers={steers}
        />
      )}
      {debate.status === "done" && (
        <Verdict workspaceId={workspaceId} debate={debate} directory={directory} steers={steers} />
      )}
      {debate.status === "done" && debate.synthesis !== null && (
        <BlindRead workspaceId={workspaceId} debateId={debate.id} />
      )}
    </>
  );
}

function Synthesis({ workspaceId, debate, steers }: Omit<Props, "directory">) {
  const t = useMessages("debates");
  const majorityText = useMajorityText();
  const synthesis = debate.synthesis;
  const steps = (synthesis?.structured.items ?? []).map(issueItem).filter((step) => step.title !== "");
  const made = new Set(debate.issues.map((issue) => issue.title));
  const open = steps.map((step, index) => ({ step, index })).filter(({ step }) => !made.has(step.title));
  const [picked, setPicked] = useState<number[]>(() => open.map(({ index }) => index));
  if (synthesis === null) return null;
  const s = synthesis.structured;
  const agreements = s.agreements ?? [];
  const disagreements = s.disagreements ?? [];
  const dissent = s.dissent ?? [];
  const blank = s.summary.trim() === "" && (s.decision ?? "").trim() === "" && steps.length === 0;
  return (
    <section className="debate-section debate-outcome" aria-labelledby="debate-synthesis">
      <h2 className="debate-section__title" id="debate-synthesis">
        {t("out.title")}
      </h2>
      {synthesis.fallback === "budget" && <p className="debate-section__note">{t("out.fallback")}</p>}
      {(s.decision ?? "").trim() !== "" && (
        <div className="debate-outcome__decision">
          <h3>{t("out.decision")}</h3>
          <p>{s.decision}</p>
        </div>
      )}
      {s.summary.trim() !== "" && <p className="debate-outcome__summary">{s.summary}</p>}
      {blank && <p className="debate-section__note">{t("out.empty")}</p>}
      {agreements.length > 0 && (
        <>
          <h3>{t("out.agree")}</h3>
          <ul>
            {agreements.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </>
      )}
      {disagreements.length > 0 && (
        <div className="debate-outcome__open">
          <h3>{t("out.disagree")}</h3>
          {disagreements.map((point) => (
            <div key={point.point} className="debate-outcome__point">
              <p>{point.point}</p>
              <ul>
                {point.sides.map((side) => (
                  <li key={side.position}>
                    <strong>{side.position}</strong>
                    {side.mustProve.trim() !== "" && <> {t("out.mustProve", { text: side.mustProve })}</>}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
      {dissent.length > 0 && (
        <>
          <h3>{t("out.dissent")}</h3>
          <ul>
            {dissent.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </>
      )}
      {(synthesis.baseline !== undefined || synthesis.final !== undefined) && (
        <dl className="debate-outcome__votes">
          <div>
            <dt className="debate-outcome__vote-label">{t("out.baseline")}</dt>
            <dd className="debate-outcome__vote">{majorityText(synthesis.baseline)}</dd>
          </div>
          <div>
            <dt className="debate-outcome__vote-label">{t("out.final")}</dt>
            <dd className="debate-outcome__vote">{majorityText(synthesis.final)}</dd>
          </div>
        </dl>
      )}
      {debate.issues.length > 0 && (
        <>
          <h3>{t("out.issues")}</h3>
          <ul>
            {debate.issues.map((issue) => (
              <li key={issue.id}>
                <AppLink
                  className="app-link"
                  route="issue"
                  params={{ workspaceId, issueSeq: String(issue.number) }}
                >
                  #{issue.number} {issue.title}
                </AppLink>
              </li>
            ))}
          </ul>
        </>
      )}
      {steers && open.length > 0 && (
        <Steps
          workspaceId={workspaceId}
          debateId={debate.id}
          open={open}
          picked={picked}
          setPicked={setPicked}
        />
      )}
    </section>
  );
}

function Steps({
  workspaceId,
  debateId,
  open,
  picked,
  setPicked,
}: {
  workspaceId: string;
  debateId: string;
  open: { step: DebateIssueItem; index: number }[];
  picked: number[];
  setPicked: (next: (list: number[]) => number[]) => void;
}) {
  const t = useMessages("debates");
  const outcome = useDebateOutcome(workspaceId, debateId);
  const create = useApiMutation("createDebateIssue");
  const once = useOnce();
  const [sending, setSending] = useState(false);
  const chosen = open.filter(({ index }) => picked.includes(index)).map(({ step }) => step);
  // Latched: a second click before the button greys out would make every chosen issue twice.
  const submit = () =>
    once((done) => {
      if (chosen.length === 0) return done();
      setSending(true);
      void (async () => {
        let made = 0;
        try {
          for (let at = 0; at < chosen.length; at += ISSUES_PER_REQUEST) {
            const result = await create.mutateAsync({
              workspaceId,
              debateId,
              body: { items: chosen.slice(at, at + ISSUES_PER_REQUEST) },
            });
            made += result.issues.length;
          }
          outcome.done(t("out.madeIssues", { count: made }));
        } catch (error) {
          outcome.failed(error);
        } finally {
          // Whatever was made before a failure shows as made, and is not offered again: the button comes
          // back only once the debate has reloaded with its new issues, so a second click can't repeat them.
          await outcome.refresh().catch(() => undefined);
          setSending(false);
          done();
        }
      })();
    });
  return (
    <div className="debate-outcome__steps">
      <h3>{t("out.steps")}</h3>
      <div className="debate-form__choices">
        {open.map(({ step, index }) => (
          <Checkbox
            key={`${index}:${step.title}`}
            label={
              step.owner === undefined
                ? step.title
                : t("out.stepOwner", { title: step.title, owner: step.owner })
            }
            checked={picked.includes(index)}
            onCheckedChange={(on) =>
              setPicked((list) => (on === true ? [...list, index] : list.filter((each) => each !== index)))
            }
          />
        ))}
      </div>
      <Button variant="primary" disabled={chosen.length === 0} loading={sending} onClick={submit}>
        {t("out.makeIssues", { count: chosen.length })}
      </Button>
    </div>
  );
}

function Verdict({ workspaceId, debate, directory, steers }: Props) {
  const t = useMessages("debates");
  const when = useRelativeTime();
  const outcome = useDebateOutcome(workspaceId, debate.id);
  const act = useLatchedMutation("setDebateVerdict", {
    invalidates: () => debateKeys(workspaceId, debate.id),
  });
  const verdict = debate.verdictState;
  const person = (id: string) => directory.name({ type: "person", id });
  const status =
    verdict?.state === "accepted"
      ? t("verdict.acceptedBy", { name: person(verdict.endorsedBy), when: when(verdict.acceptedAt) })
      : verdict?.state === "reverted" && verdict.revertedBy !== undefined && verdict.revertedAt !== undefined
        ? t("verdict.revertedBy", { name: person(verdict.revertedBy), when: when(verdict.revertedAt) })
        : t("verdict.pending");
  // A reverted verdict can be accepted again, as the server allows.
  const action = verdict?.state === "accepted" ? "revert" : "accept";
  return (
    <div className="debate-verdict" data-state={verdict?.state ?? "pending"}>
      <p role="status">{status}</p>
      {steers && (
        <Button
          variant={action === "accept" ? "primary" : "ghost"}
          loading={act.isPending}
          onClick={() =>
            act.fire({ workspaceId, debateId: debate.id, body: { action } }, { onError: outcome.failed })
          }
        >
          {t(action === "accept" ? "verdict.accept" : "verdict.revert")}
        </Button>
      )}
    </div>
  );
}

/** The pair is drawn on the server the first time it is asked for, so it loads only once opened. */
function BlindRead({ workspaceId, debateId }: { workspaceId: string; debateId: string }) {
  const t = useMessages("debates");
  const [open, setOpen] = useState(false);
  return (
    <details className="debate-blind" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>{t("blind.title")}</summary>
      <p className="debate-section__note">{t("blind.body")}</p>
      {open && <BlindPair workspaceId={workspaceId} debateId={debateId} />}
    </details>
  );
}

function BlindPair({ workspaceId, debateId }: { workspaceId: string; debateId: string }) {
  const t = useMessages("debates");
  const common = useMessages("common");
  const describe = useErrorMessage("debates");
  const pair = useApiQuery("reviewDebate", { workspaceId, debateId }, { retry: false });
  const pick = useLatchedMutation("reviewDebatePickReview");
  const [shown, setShown] = useState<"a" | "b" | "tie" | null>(null);
  if (pair.isPending)
    return (
      <p className="debate-section__note" role="status">
        {t("blind.loading")}
      </p>
    );
  if (pair.isError && pair.data === undefined)
    return (
      <Callout
        tone="danger"
        role="alert"
        actions={<Button onClick={() => void pair.refetch()}>{common("action.retry")}</Button>}
      >
        {t("blind.failed")}: {describe(pair.error)}
      </Callout>
    );
  const chosen = shown ?? pair.data.pick;
  const label = (side: "a" | "b" | "tie") => (side === "tie" ? t("blind.tie") : t(`blind.${side}`));
  const choose = (side: "a" | "b" | "tie") =>
    pick.fire({ workspaceId, debateId, body: { pick: side } }, { onSuccess: (next) => setShown(next.pick) });
  return (
    <div className="debate-blind__body">
      <div className="debate-blind__pair">
        {(["a", "b"] as const).map((side) => (
          <article
            key={side}
            className="debate-blind__side"
            data-picked={chosen === side || undefined}
            aria-labelledby={`debate-blind-${side}`}
          >
            <h3 id={`debate-blind-${side}`}>{t(`blind.${side}`)}</h3>
            <p>{pair.data[side]}</p>
          </article>
        ))}
      </div>
      <div className="debate-composer__actions">
        <Button disabled={pick.isPending} onClick={() => choose("a")}>
          {t("blind.pickA")}
        </Button>
        <Button variant="ghost" disabled={pick.isPending} onClick={() => choose("tie")}>
          {t("blind.tie")}
        </Button>
        <Button disabled={pick.isPending} onClick={() => choose("b")}>
          {t("blind.pickB")}
        </Button>
      </div>
      {pick.isError && (
        <Callout tone="danger" role="alert">
          {describe(pick.error)}
        </Callout>
      )}
      {chosen !== null && (
        <p className="debate-section__note" role="status">
          {t("blind.picked", { pick: label(chosen) })}
        </p>
      )}
    </div>
  );
}
