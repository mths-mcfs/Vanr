// What answers for the agent: a model called directly, or Claude Code or Codex on the runner the agent
// works on. Each choice says whether it can be used here and, if not, why. Moving to a harness on a runner
// first asks to accept that it runs on the pairer's personal plan and that only they can talk to it.
// Whoever manages agents changes the harness and the model; the owner only turns the fallback on or off.
import { useApiMutation, useApiQuery } from "@vanr/client/react";
import type { AgentDetail, AgentHarness, HarnessKind, HarnessOption } from "@vanr/contract";
import { Callout, ConfirmDialog, Field, Radio, RadioGroup, Select, SelectItem, Switch } from "@vanr/ui";
import { type ReactNode, useState } from "react";
import { useMessages } from "../../i18n/react.tsx";
import { type AgentRights, PartError, PartLoading, Section, useOutcome } from "./shared.tsx";

type Props = { agent: AgentDetail; workspaceId: string; rights: AgentRights };
/** The choice that leaves the model to the harness itself (sent as an empty model). */
const DEFAULT_MODEL = "harness-default";

export function Harness({ agent, workspaceId, rights }: Props) {
  const t = useMessages("agents");
  const args = { workspaceId, agentId: agent.id };
  const runtime = useApiQuery("getAgentRuntime", args);
  const models = useApiQuery("listModels", {});
  let body: ReactNode;
  if (runtime.isPending || models.isPending) body = <PartLoading />;
  else if (runtime.isError || models.isError) {
    const failed = runtime.isError ? runtime : models;
    body = (
      <PartError title={t("harness.failed")} error={failed.error} onRetry={() => void failed.refetch()} />
    );
  } else
    body = (
      <Choices
        key={`${runtime.data.harness}:${runtime.data.resolvedModel}`}
        runtime={runtime.data}
        models={models.data.models}
        agent={agent}
        workspaceId={workspaceId}
        rights={rights}
      />
    );
  return (
    <Section title={t("harness.title")} help={t("harness.help")}>
      {body}
    </Section>
  );
}

function Choices({
  runtime,
  models,
  agent,
  workspaceId,
  rights,
}: Props & { runtime: AgentHarness; models: { id: string; label: string; available: boolean }[] }) {
  const t = useMessages("agents");
  const outcome = useOutcome();
  const args = { workspaceId, agentId: agent.id };
  const save = useApiMutation("setAgentRuntime", {
    invalidates: () => [
      { method: "getAgentRuntime" as const, args },
      { method: "getAgent" as const, args },
    ],
  });
  const [asking, setAsking] = useState<HarnessKind | null>(null);
  const option = (kind: HarnessKind) => runtime.options.find((candidate) => candidate.kind === kind);
  const current = option(runtime.harness);
  const remote = runtime.harness !== "model";
  const send = (body: {
    harness: HarnessKind;
    model?: string;
    fallback?: boolean;
    agreeToPlanTerms?: boolean;
  }) =>
    save.mutate(
      { ...args, body },
      { onSuccess: () => outcome.done(t("harness.saved")), onError: outcome.failed },
    );
  const pick = (kind: HarnessKind) => {
    if (kind === runtime.harness) return;
    if (kind === "model") send({ harness: "model" });
    else setAsking(kind);
  };
  const unavailableNow = current !== undefined && !current.available;

  return (
    <div className="section-form">
      <RadioGroup
        value={runtime.harness}
        disabled={!rights.editAll || save.isPending}
        aria-label={t("harness.title")}
        onValueChange={(next) => pick(next === "claude_code" || next === "codex" ? next : "model")}
      >
        {(["model", "claude_code", "codex"] as const).map((kind) => {
          const found = option(kind);
          return (
            <Radio
              key={kind}
              value={kind}
              disabled={kind !== "model" && found?.available !== true && kind !== runtime.harness}
              label={t(`harness.kind.${kind}`)}
              hint={reasonOf(found, t) ?? t(`harness.hint.${kind}`)}
            />
          );
        })}
      </RadioGroup>
      {unavailableNow && remote && (
        <Callout tone="warning" role="alert">
          {t("harness.nowUnavailable", { reason: reasonOf(current, t) ?? "" })}
        </Callout>
      )}
      {remote ? (
        <>
          <Field label={t("harness.model")} hint={t("harness.modelHint")}>
            <Select
              value={runtime.resolvedModel === current?.defaultModel ? DEFAULT_MODEL : runtime.resolvedModel}
              disabled={!rights.editAll || save.isPending}
              onValueChange={(model) =>
                send({ harness: runtime.harness, model: model === DEFAULT_MODEL ? "" : model })
              }
            >
              <SelectItem value={DEFAULT_MODEL}>{t("harness.defaultModel")}</SelectItem>
              {(current?.models ?? []).map((model) => (
                <SelectItem key={model.value} value={model.value}>
                  {model.label}
                </SelectItem>
              ))}
            </Select>
          </Field>
          <Switch
            label={t("harness.fallback")}
            hint={t("harness.fallbackHint")}
            checked={runtime.fallback}
            disabled={!rights.editLook || save.isPending}
            onCheckedChange={(fallback) => send({ harness: runtime.harness, fallback })}
          />
        </>
      ) : (
        <Field label={t("harness.model")}>
          <Select
            value={agent.model}
            disabled={!rights.editAll || save.isPending}
            onValueChange={(model) => send({ harness: "model", model })}
          >
            {models.map((model) => (
              <SelectItem key={model.id} value={model.id} disabled={!model.available}>
                {model.label}
              </SelectItem>
            ))}
          </Select>
        </Field>
      )}
      {agent.testModel && <p className="page__muted">{t("harness.testModel")}</p>}
      {!rights.editAll && <p className="page__muted">{t("harness.adminOnly")}</p>}
      <ConfirmDialog
        open={asking !== null}
        onOpenChange={(open) => {
          if (!open) setAsking(null);
        }}
        title={t("harness.termsTitle", { harness: asking === null ? "" : t(`harness.kind.${asking}`) })}
        description={t("harness.termsBody")}
        confirmLabel={t("harness.termsAccept")}
        cancelLabel={t("instructions.discard")}
        confirming={save.isPending}
        onConfirm={() => {
          if (asking === null) return;
          save.mutate(
            { ...args, body: { harness: asking, agreeToPlanTerms: true } },
            {
              onSuccess: () => {
                outcome.done(t("harness.saved"));
                setAsking(null);
              },
              onError: (error) => {
                outcome.failed(error);
                setAsking(null);
              },
            },
          );
        }}
      />
    </div>
  );
}

function reasonOf(option: HarnessOption | undefined, t: ReturnType<typeof useMessages<"agents">>) {
  if (option === undefined || option.available || option.reason === null) return undefined;
  return t(`harness.reason.${option.reason}`);
}
