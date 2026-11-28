// What the agent did lately, newest first. A finished run can become a workspace skill: the server drafts
// the skill from the run, the person reviews it and saves it, and can then turn it on for this agent.
// A run from a private channel or a DM asks first, because the skill becomes readable by everyone.
import { useApiMutation, useApiQuery } from "@vanr/client/react";
import type { AgentDetail, Run, SkillDraft } from "@vanr/contract";
import {
  Button,
  Callout,
  Checkbox,
  Chip,
  Dialog,
  DialogContent,
  EmptyState,
  Field,
  Input,
  Spinner,
  Textarea,
} from "@vanr/ui";
import { BookPlus } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import { useErrorMessage } from "../../app/screens.tsx";
import { useLocale, useMessages } from "../../i18n/react.tsx";
import {
  type AgentRights,
  PartError,
  PartLoading,
  Section,
  SKILL_DESCRIPTION_MAX,
  SKILL_NAME_MAX,
  SKILL_NAME_RE,
  useOutcome,
} from "./shared.tsx";

export const RUNS_SHOWN = 20;

type Props = { agent: AgentDetail; workspaceId: string; rights: AgentRights };

export function Activity({ agent, workspaceId, rights }: Props) {
  const t = useMessages("agents");
  const { locale } = useLocale();
  const runs = useApiQuery("listRuns", { workspaceId, query: { agentId: agent.id, limit: RUNS_SHOWN } });
  const when = new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" });
  let body: ReactNode;
  if (runs.isPending) body = <PartLoading />;
  else if (runs.isError)
    body = <PartError title={t("activity.failed")} error={runs.error} onRetry={() => void runs.refetch()} />;
  else if (runs.data.length === 0)
    body = <EmptyState title={t("activity.empty")} description={t("activity.emptyBody")} />;
  else
    body = (
      <ul className="agent-runs" aria-label={t("activity.title")}>
        {runs.data.map((run) => (
          <li key={run.id} className="agent-runs__row">
            <Chip>{t(`run.${run.status}`)}</Chip>
            <span className="agent-runs__what">{run.what === "" ? t("activity.noTitle") : run.what}</span>
            <span className="page__muted">{when.format(new Date(run.createdAt))}</span>
            {rights.manage && run.status === "done" && (
              <SaveAsSkill run={run} agent={agent} workspaceId={workspaceId} canEnable={rights.editLook} />
            )}
          </li>
        ))}
      </ul>
    );
  return (
    <Section title={t("activity.title")} help={t("activity.help")}>
      {body}
    </Section>
  );
}

function SaveAsSkill({
  run,
  agent,
  workspaceId,
  canEnable,
}: {
  run: Run;
  agent: AgentDetail;
  workspaceId: string;
  /** Turning the skill on is a change to the agent: not for an archived one. */
  canEnable: boolean;
}) {
  const t = useMessages("agents");
  const common = useMessages("common");
  const describe = useErrorMessage("agents");
  const outcome = useOutcome();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<SkillDraft | null>(null);
  const [share, setShare] = useState(false);
  const [savedId, setSavedId] = useState<string | null>(null);
  const drafting = useApiMutation("createRunSkillDraft");
  const create = useApiMutation("createSkill", {
    invalidates: () => [
      { method: "listSkills" as const, args: { workspaceId } },
      { method: "listAgentSkills" as const, args: { workspaceId, agentId: agent.id } },
    ],
  });
  const enable = useApiMutation("setAgentSkills", {
    invalidates: () => [{ method: "listAgentSkills" as const, args: { workspaceId, agentId: agent.id } }],
  });

  // Each opening of the dialog is one attempt; an answer that arrives for an earlier one is dropped.
  const attempt = useRef(0);
  const start = () => {
    attempt.current += 1;
    const mine = attempt.current;
    setOpen(true);
    setDraft(null);
    setSavedId(null);
    setShare(false);
    drafting.mutate(
      { workspaceId, runId: run.id },
      {
        onSuccess: (next) => {
          if (attempt.current === mine) setDraft(next);
        },
      },
    );
  };
  const save = () => {
    if (draft === null) return;
    const mine = attempt.current;
    create.mutate(
      {
        workspaceId,
        body: {
          name: draft.name.trim(),
          description: draft.description.trim(),
          body: draft.body,
          sourceRunId: draft.runId,
          ...(draft.fromPrivate && { shareFromPrivate: share }),
        },
      },
      {
        onSuccess: (skill) => {
          outcome.done(t("saveSkill.saved", { name: skill.name }));
          if (attempt.current === mine) setSavedId(skill.id);
        },
      },
    );
  };
  const ready =
    draft !== null &&
    SKILL_NAME_RE.test(draft.name.trim()) &&
    draft.description.trim() !== "" &&
    draft.body.trim() !== "" &&
    (!draft.fromPrivate || share);

  let content: ReactNode;
  if (drafting.isError) {
    content = (
      <Callout tone="danger" role="alert" title={t("saveSkill.draftFailed")}>
        {describe(drafting.error)}
      </Callout>
    );
  } else if (draft === null) {
    content = (
      <p className="lab-progress" role="status">
        <Spinner /> {t("saveSkill.drafting")}
      </p>
    );
  } else {
    content = (
      <div className="section-form">
        {draft.testModel && <Callout tone="warning">{t("saveSkill.testModel")}</Callout>}
        {draft.fromPrivate && <Callout tone="warning">{t("saveSkill.private")}</Callout>}
        <Field label={t("skill.name")}>
          <Input
            value={draft.name}
            maxLength={SKILL_NAME_MAX}
            disabled={savedId !== null || create.isPending}
            onChange={(event) => setDraft({ ...draft, name: event.target.value })}
          />
        </Field>
        <Field label={t("skill.description")}>
          <Textarea
            rows={2}
            value={draft.description}
            maxLength={SKILL_DESCRIPTION_MAX}
            disabled={savedId !== null || create.isPending}
            onChange={(event) => setDraft({ ...draft, description: event.target.value })}
          />
        </Field>
        <Field label={t("skill.body")}>
          <Textarea
            rows={10}
            mono
            value={draft.body}
            disabled={savedId !== null || create.isPending}
            onChange={(event) => setDraft({ ...draft, body: event.target.value })}
          />
        </Field>
        {draft.fromPrivate && (
          <Checkbox
            label={t("saveSkill.share")}
            checked={share}
            disabled={savedId !== null || create.isPending}
            onCheckedChange={(on) => setShare(on === true)}
          />
        )}
        {create.isError && (
          <Callout tone="danger" role="alert">
            {describe(create.error)}
          </Callout>
        )}
      </div>
    );
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button variant="secondary" size="sm" icon={<BookPlus size={16} />} onClick={start}>
        {t("saveSkill.action")}
      </Button>
      <DialogContent
        size="lg"
        closeLabel={common("action.close")}
        title={t("saveSkill.title")}
        description={t("saveSkill.help")}
        footer={
          savedId === null ? (
            <Button variant="primary" disabled={!ready} loading={create.isPending} onClick={save}>
              {t("saveSkill.save")}
            </Button>
          ) : !canEnable ? (
            <p className="page__muted">{t("saveSkill.archived", { name: agent.name })}</p>
          ) : (
            <Button
              variant="primary"
              loading={enable.isPending}
              onClick={() =>
                enable.mutate(
                  { workspaceId, agentId: agent.id, body: { skills: [{ id: savedId, enabled: true }] } },
                  {
                    onSuccess: () => {
                      outcome.done(t("agentSkills.on", { name: draft?.name ?? "" }));
                      setOpen(false);
                    },
                    onError: outcome.failed,
                  },
                )
              }
            >
              {t("saveSkill.enable", { name: agent.name })}
            </Button>
          )
        }
      >
        {content}
      </DialogContent>
    </Dialog>
  );
}
