// The agent's instructions and their history. Only whoever manages agents changes them (the owner reads
// them); each save is a new version with its author and reason, and going back to an old one writes a
// new version with its text, so nothing in the history is lost.
import { useApiMutation, useApiQuery } from "@vanr/client/react";
import type { AgentDetail, InstructionVersion } from "@vanr/contract";
import { diffText } from "@vanr/engine/wiki/diff";
import { Button, Chip, ConfirmDialog, EmptyState, Field, Input, Textarea } from "@vanr/ui";
import { type ReactNode, useState } from "react";
import { useLocale, useMessages } from "../../i18n/react.tsx";
import {
  type AgentRights,
  INSTRUCTIONS_MAX,
  PartError,
  PartLoading,
  REASON_MAX,
  Section,
  useOutcome,
} from "./shared.tsx";

type Props = { agent: AgentDetail; workspaceId: string; rights: AgentRights };

const refetchAgent = (workspaceId: string, agentId: string) => [
  { method: "getAgent" as const, args: { workspaceId, agentId } },
  { method: "listAgentInstructionVersions" as const, args: { workspaceId, agentId } },
];

export function Instructions({ agent, workspaceId, rights }: Props) {
  return (
    <>
      {/* A new text from elsewhere (a restore, another tab) starts the editor over. */}
      <Editor key={agent.instructions} agent={agent} workspaceId={workspaceId} rights={rights} />
      <History agent={agent} workspaceId={workspaceId} rights={rights} />
    </>
  );
}

function Editor({ agent, workspaceId, rights }: Props) {
  const t = useMessages("agents");
  const outcome = useOutcome();
  const [text, setText] = useState(agent.instructions);
  const [reason, setReason] = useState("");
  const save = useApiMutation("updateAgent", { invalidates: () => refetchAgent(workspaceId, agent.id) });
  const dirty = text !== agent.instructions;
  return (
    <Section title={t("instructions.title")} help={t("instructions.help")}>
      <Field
        label={t("field.instructions")}
        hint={
          rights.editAll
            ? t("field.count", { count: text.length, max: INSTRUCTIONS_MAX })
            : t("instructions.adminOnly")
        }
      >
        <Textarea
          rows={14}
          value={text}
          readOnly={!rights.editAll || save.isPending}
          maxLength={INSTRUCTIONS_MAX}
          onChange={(event) => setText(event.target.value)}
        />
      </Field>
      {rights.editAll && dirty && (
        <>
          <Field label={t("instructions.reason")}>
            <Input
              value={reason}
              maxLength={REASON_MAX}
              readOnly={save.isPending}
              onChange={(event) => setReason(event.target.value)}
            />
          </Field>
          <div className="section-form__actions">
            <span className="page__muted">{t("instructions.unsaved")}</span>
            <Button variant="ghost" disabled={save.isPending} onClick={() => setText(agent.instructions)}>
              {t("instructions.discard")}
            </Button>
            <Button
              variant="primary"
              loading={save.isPending}
              onClick={() =>
                save.mutate(
                  {
                    workspaceId,
                    agentId: agent.id,
                    body: {
                      instructions: text,
                      ...(reason.trim() !== "" && { instructionsReason: reason.trim() }),
                    },
                  },
                  { onSuccess: () => outcome.done(t("instructions.saved")), onError: outcome.failed },
                )
              }
            >
              {t("instructions.save")}
            </Button>
          </div>
        </>
      )}
    </Section>
  );
}

function History({ agent, workspaceId, rights }: Props) {
  const t = useMessages("agents");
  const { locale } = useLocale();
  const versions = useApiQuery("listAgentInstructionVersions", { workspaceId, agentId: agent.id });
  const members = useApiQuery("listMembers", { workspaceId });
  const [open, setOpen] = useState<string | null>(null);
  const [restoring, setRestoring] = useState<InstructionVersion | null>(null);
  const outcome = useOutcome();
  const restore = useApiMutation("restoreAgentInstructionVersion", {
    invalidates: () => refetchAgent(workspaceId, agent.id),
  });
  const when = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" });
  const authorOf = (version: InstructionVersion) => {
    if (version.author.type === "system") return t("history.bySystem");
    if (version.author.type === "agent") return agent.name;
    return members.data?.find((member) => member.userId === version.author.id)?.name ?? t("history.someone");
  };

  let body: ReactNode;
  if (versions.isPending) body = <PartLoading />;
  else if (versions.isError)
    body = (
      <PartError title={t("history.failed")} error={versions.error} onRetry={() => void versions.refetch()} />
    );
  else if (versions.data.length === 0) body = <EmptyState title={t("history.empty")} />;
  else {
    const list = [...versions.data].sort((a, b) => b.seq - a.seq);
    const current = list[0]?.id;
    body = (
      <ol className="agent-history" aria-label={t("history.title")}>
        {list.map((version, at) => {
          const before = list[at + 1];
          const shown = open === version.id;
          return (
            <li key={version.id} className="agent-history__item">
              <div className="agent-history__line">
                <strong>{t("history.version", { seq: version.seq })}</strong>
                <span>{t(`history.source.${version.source}`)}</span>
                <span className="page__muted">
                  {authorOf(version)} · {when.format(new Date(version.createdAt))}
                </span>
                {version.id === current && <Chip>{t("history.current")}</Chip>}
              </div>
              {version.reason !== "" && <p className="page__muted">{version.reason}</p>}
              <div className="section-form__actions">
                {before !== undefined && (
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-expanded={shown}
                    onClick={() => setOpen(shown ? null : version.id)}
                  >
                    {t(shown ? "history.hide" : "history.compare")}
                  </Button>
                )}
                {rights.editAll && version.id !== current && (
                  <Button variant="secondary" size="sm" onClick={() => setRestoring(version)}>
                    {t("history.restore")}
                  </Button>
                )}
              </div>
              {shown && before !== undefined && <LineDiff before={before.text} after={version.text} />}
            </li>
          );
        })}
      </ol>
    );
  }

  return (
    <Section title={t("history.title")} help={t("history.help")}>
      {body}
      <ConfirmDialog
        open={restoring !== null}
        onOpenChange={(next) => {
          if (!next) setRestoring(null);
        }}
        title={t("history.restoreTitle", { seq: restoring?.seq ?? 0 })}
        description={t("history.restoreBody")}
        confirmLabel={t("history.restore")}
        cancelLabel={t("instructions.discard")}
        confirming={restore.isPending}
        onConfirm={() => {
          if (restoring === null) return;
          restore.mutate(
            { workspaceId, agentId: agent.id, instructionVersionId: restoring.id, body: {} },
            {
              onSuccess: () => {
                outcome.done(t("history.restored", { seq: restoring.seq }));
                setRestoring(null);
              },
              onError: outcome.failed,
            },
          );
        }}
      />
    </Section>
  );
}

function LineDiff({ before, after }: { before: string; after: string }) {
  const t = useMessages("agents");
  const diff = diffText(before, after);
  // The rows of one diff never move, so their place is their key.
  const rows = diff.rows.map((row, at) => ({ row, key: `row-${at}` }));
  return (
    <section className="agent-diff" aria-label={t("history.diff")}>
      <p className="page__muted">{t("history.diffStats", { added: diff.added, removed: diff.removed })}</p>
      <pre className="agent-diff__body">
        {rows.map(({ row, key }) =>
          row.kind === "gap" ? (
            <span key={key} className="agent-diff__gap">
              {t("history.gap", { count: row.count })}
            </span>
          ) : (
            <span key={key} className={`agent-diff__${row.kind}`}>
              {row.kind === "add" ? "+ " : row.kind === "del" ? "− " : "  "}
              {row.text}
              {"\n"}
            </span>
          ),
        )}
      </pre>
    </section>
  );
}
