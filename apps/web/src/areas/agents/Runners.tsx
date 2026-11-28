// Runners: the computers paired with the workspace, where agents run commands, Claude Code, Codex and a
// browser. The settings section lists them and says how to pair one; a runner's page shows what it
// allows, which agents work on it, and lets whoever may manage it rename it, turn a tool off, move its
// agents elsewhere, revoke it or remove it. Presence and changes arrive as runner events.
import { useApiMutation, useApiQuery } from "@vanr/client/react";
import type { Runner } from "@vanr/contract";
import { Button, Chip, ConfirmDialog, EmptyState, Field, Input, Select, SelectItem, Surface } from "@vanr/ui";
import { ArrowLeft } from "lucide-react";
import { type ReactNode, useState } from "react";
import { AppLink, useGo, useRouteParams } from "../../app/navigation.tsx";
import { ScreenLoading, useDocumentTitle } from "../../app/screens.tsx";
import { useLocale, useMessages } from "../../i18n/react.tsx";
import { PartError, PartLoading, Section, useOutcome } from "./shared.tsx";

export const RUNNER_NAME_MAX = 80;
const TOOLS = ["commands", "claude", "codex", "browser"] as const;

/** The settings section: every runner of the workspace, and how to pair another one. */
export function RunnersSection() {
  const t = useMessages("agents");
  const { workspaceId } = useRouteParams("settings");
  const runners = useApiQuery("listRunners", { workspaceId });
  let body: ReactNode;
  if (runners.isPending) body = <PartLoading />;
  else if (runners.isError)
    body = (
      <PartError title={t("runners.failed")} error={runners.error} onRetry={() => void runners.refetch()} />
    );
  else if (runners.data.length === 0)
    body = <EmptyState title={t("runners.empty")} description={t("runners.emptyBody")} />;
  else
    body = (
      <ul className="listing listing--wide" aria-label={t("runners.title")}>
        {runners.data.map((runner) => (
          <li key={runner.id} className="listing__row">
            <AppLink
              className="app-link listing__name"
              route="runner"
              params={{ workspaceId, runnerId: runner.id }}
            >
              {runner.name}
            </AppLink>
            <span className="listing__handle">
              {t("runners.pairedBy", { name: runner.pairedByName, os: runner.os, arch: runner.arch })}
            </span>
            <span className="listing__state">{t(stateOf(runner))}</span>
          </li>
        ))}
      </ul>
    );
  return (
    <>
      <Surface variant="card" className="section-card">
        <h3 className="page__heading">{t("runners.pairTitle")}</h3>
        <p className="page__muted">{t("runners.pairHelp")}</p>
        <pre className="runner-command">
          <code>{`vanr-runner pair --server ${window.location.origin}`}</code>
        </pre>
      </Surface>
      {body}
    </>
  );
}

const stateOf = (runner: Runner) =>
  runner.revokedAt !== null
    ? "runners.revoked"
    : runner.paused
      ? "runners.paused"
      : runner.online
        ? "runners.online"
        : "runners.offline";

/** One runner's page. */
export function RunnerScreen() {
  const t = useMessages("agents");
  const { workspaceId, runnerId } = useRouteParams("runner");
  const runners = useApiQuery("listRunners", { workspaceId });
  const runner = runners.data?.find((each) => each.id === runnerId);
  useDocumentTitle(runner?.name ?? t("runner.title"));
  if (runners.isPending) return <ScreenLoading />;
  const back = (
    <AppLink className="app-link agent-back" route="settings" params={{ workspaceId, section: "runners" }}>
      <ArrowLeft size={16} aria-hidden="true" /> {t("runner.back")}
    </AppLink>
  );
  if (runners.isError || runner === undefined) {
    return (
      <div className="page">
        {back}
        <h1 className="page__title">{t("runner.title")}</h1>
        {runners.isError ? (
          <PartError
            title={t("runners.failed")}
            error={runners.error}
            onRetry={() => void runners.refetch()}
          />
        ) : (
          <EmptyState title={t("runner.missing")} description={t("runner.missingBody")} />
        )}
      </div>
    );
  }
  return (
    <div className="page page--wide agent-page">
      {back}
      <RunnerDetails key={runner.name} runner={runner} others={runners.data} workspaceId={workspaceId} />
    </div>
  );
}

function RunnerDetails({
  runner,
  others,
  workspaceId,
}: {
  runner: Runner;
  others: Runner[];
  workspaceId: string;
}) {
  const t = useMessages("agents");
  const { locale } = useLocale();
  const go = useGo();
  const outcome = useOutcome();
  const agents = useApiQuery("listAgents", { workspaceId });
  const [name, setName] = useState(runner.name);
  const [target, setTarget] = useState("");
  const [asking, setAsking] = useState<"revoke" | "delete" | null>(null);
  const invalidates = () => [{ method: "listRunners" as const, args: { workspaceId } }];
  const args = { workspaceId, runnerId: runner.id };
  const rename = useApiMutation("updateRunner", { invalidates });
  const reduce = useApiMutation("reduceRunnerAccess", { invalidates });
  const moveAgents = useApiMutation("moveRunnerAgents", {
    invalidates: () => [...invalidates(), { method: "listAgents" as const, args: { workspaceId } }],
  });
  const revoke = useApiMutation("revokeRunner", { invalidates });
  const remove = useApiMutation("deleteRunner", { invalidates });
  const manage = runner.manageable;
  const names = new Map((agents.data ?? []).map((agent) => [agent.id, agent.name]));
  const destinations = others.filter((each) => each.id !== runner.id && each.revokedAt === null);
  const when = (iso: string | null) =>
    iso === null
      ? t("runner.never")
      : new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));

  return (
    <>
      <header className="agent-cover">
        <div className="agent-cover__text">
          <h1 className="page__title">{runner.name}</h1>
          <p className="agent-cover__meta">
            <Chip>{t(stateOf(runner))}</Chip>
            <span>
              {t("runners.pairedBy", { name: runner.pairedByName, os: runner.os, arch: runner.arch })}
            </span>
          </p>
        </div>
      </header>
      <Section title={t("runner.about")}>
        <dl className="agent-facts">
          <dt>{t("runner.hostname")}</dt>
          <dd>{runner.hostname}</dd>
          <dt>{t("runner.release")}</dt>
          <dd>{runner.runnerRelease}</dd>
          <dt>{t("runner.lastOnline")}</dt>
          <dd>{runner.online ? t("runners.online") : when(runner.lastOnlineAt)}</dd>
          <dt>{t("runner.sandbox")}</dt>
          <dd>
            {runner.sandbox === null
              ? t("runner.sandbox.unknown")
              : t(`runner.sandbox.${runner.sandbox.state}`)}
          </dd>
          <dt>{t("runner.workDir")}</dt>
          <dd>{runner.workDir ?? t("runner.notSet")}</dd>
        </dl>
        {manage && (
          <form
            className="access-add"
            aria-label={t("runner.rename")}
            onSubmit={(event) => {
              event.preventDefault();
              if (name.trim() === "" || name.trim() === runner.name) return;
              rename.mutate(
                { ...args, body: { name: name.trim() } },
                { onSuccess: () => outcome.done(t("runner.renamed")), onError: outcome.failed },
              );
            }}
          >
            <Field label={t("runner.name")}>
              <Input
                value={name}
                maxLength={RUNNER_NAME_MAX}
                disabled={rename.isPending}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
            <Button
              type="submit"
              disabled={name.trim() === "" || name.trim() === runner.name}
              loading={rename.isPending}
            >
              {t("runner.rename")}
            </Button>
          </form>
        )}
      </Section>
      <Section title={t("runner.tools")} help={t("runner.toolsHelp")}>
        <ul className="agent-plain" aria-label={t("runner.tools")}>
          {TOOLS.map((tool) => (
            <li key={tool} className="access-rule">
              <span>{t(`runner.tool.${tool}`)}</span>
              <Chip>{t(runner.access.tools[tool] ? "runner.on" : "runner.off")}</Chip>
              {manage && runner.access.tools[tool] && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={reduce.isPending}
                  onClick={() =>
                    reduce.mutate(
                      { ...args, body: { disableTool: tool } },
                      {
                        onSuccess: () =>
                          outcome.done(t("runner.toolOff", { tool: t(`runner.tool.${tool}`) })),
                        onError: outcome.failed,
                      },
                    )
                  }
                >
                  {t("runner.turnOff", { tool: t(`runner.tool.${tool}`) })}
                </Button>
              )}
            </li>
          ))}
        </ul>
      </Section>
      <Section title={t("runner.agents")}>
        {runner.agents.length === 0 ? (
          <p className="page__muted">{t("runner.noAgents")}</p>
        ) : (
          <ul className="agent-plain" aria-label={t("runner.agents")}>
            {runner.agents.map((agentId) => (
              <li key={agentId}>
                <AppLink className="app-link" route="agent" params={{ workspaceId, agentId }}>
                  {names.get(agentId) ?? t("team.someAgent")}
                </AppLink>
              </li>
            ))}
          </ul>
        )}
        {manage && runner.agents.length > 0 && destinations.length > 0 && (
          <form
            className="access-add"
            aria-label={t("runner.move")}
            onSubmit={(event) => {
              event.preventDefault();
              if (target === "") return;
              moveAgents.mutate(
                { ...args, body: { toRunnerId: target } },
                {
                  onSuccess: (result) => outcome.done(t("runner.moved", { count: result.moved.length })),
                  onError: outcome.failed,
                },
              );
            }}
          >
            <Field label={t("runner.moveTo")}>
              <Select value={target} placeholder={t("runner.pickRunner")} onValueChange={setTarget}>
                {destinations.map((each) => (
                  <SelectItem key={each.id} value={each.id}>
                    {each.name}
                  </SelectItem>
                ))}
              </Select>
            </Field>
            <Button type="submit" disabled={target === ""} loading={moveAgents.isPending}>
              {t("runner.move")}
            </Button>
          </form>
        )}
      </Section>
      {manage && (
        <Section title={t("runner.danger")} help={t("runner.dangerHelp")}>
          <div className="memory-note__actions">
            {runner.revokedAt === null && (
              <Button variant="secondary" onClick={() => setAsking("revoke")}>
                {t("runner.revoke")}
              </Button>
            )}
            <Button variant="danger" onClick={() => setAsking("delete")}>
              {t("runner.delete")}
            </Button>
          </div>
        </Section>
      )}
      <ConfirmDialog
        open={asking !== null}
        onOpenChange={(open) => {
          if (!open) setAsking(null);
        }}
        tone="danger"
        title={t(asking === "delete" ? "runner.deleteTitle" : "runner.revokeTitle", { name: runner.name })}
        description={t(asking === "delete" ? "runner.deleteBody" : "runner.revokeBody")}
        confirmLabel={t(asking === "delete" ? "runner.delete" : "runner.revoke")}
        cancelLabel={t("instructions.discard")}
        confirming={revoke.isPending || remove.isPending}
        onConfirm={() => {
          if (asking === "revoke") {
            revoke.mutate(args, {
              onSuccess: () => {
                setAsking(null);
                outcome.done(t("runner.revokedDone", { name: runner.name }));
              },
              onError: (error) => {
                setAsking(null);
                outcome.failed(error);
              },
            });
          } else if (asking === "delete") {
            remove.mutate(args, {
              onSuccess: () => {
                outcome.done(t("runner.deleted", { name: runner.name }));
                void go("settings", { workspaceId, section: "runners" });
              },
              onError: (error) => {
                setAsking(null);
                outcome.failed(error);
              },
            });
          }
        }}
      />
    </>
  );
}
