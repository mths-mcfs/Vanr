// Where the agent runs its tools: the runner it works on, the secrets it holds there (names only, never
// values), the domains its commands asked to reach, and the policy of its browser. Whoever edits the agent
// changes the runner, decides the domains and edits the policy; the private network ranges also need the
// person who paired that runner or someone who configures the workspace. Secrets and the browser's
// takeover are asked again every minute. Watching the browser live comes with the secure browser work.
import { useApiMutation, useApiQuery } from "@vanr/client/react";
import type {
  AgentBrowserSettings,
  AgentDetail,
  AgentSecret,
  BrowserLevel,
  NetworkRequest,
  Runner,
  SiteAccess,
  SiteRule,
} from "@vanr/contract";
import { can } from "@vanr/contract";
import {
  BROWSER_LEVELS,
  checkRanges,
  PRIVATE_RANGES_MAX,
  SITE_PATTERN,
  SITES_MAX,
  sensitiveCategory,
} from "@vanr/engine/browser-policy";
import {
  Button,
  Callout,
  Chip,
  ConfirmDialog,
  Field,
  Input,
  Radio,
  RadioGroup,
  Select,
  SelectItem,
} from "@vanr/ui";
import { Trash2 } from "lucide-react";
import { type ReactNode, useState } from "react";
import { AppLink } from "../../app/navigation.tsx";
import { useLocale, useMessages } from "../../i18n/react.tsx";
import { type AgentRights, PartError, PartLoading, Section, useOutcome } from "./shared.tsx";

export const ENVIRONMENT_REFRESH_MS = 60_000;
/** The choice that takes the agent off any runner. */
const NO_RUNNER = "none";

type Props = { agent: AgentDetail; workspaceId: string; rights: AgentRights };

/** The runners a person may point the agent at: the ones they paired, the current one, every one for an admin. */
export function targetsFor(
  runners: readonly Runner[],
  userId: string | undefined,
  currentId: string | null,
  all: boolean,
) {
  return runners.filter(
    (runner) =>
      runner.revokedAt === null && (all || runner.pairedByUserId === userId || runner.id === currentId),
  );
}

/** A site as typed: trimmed and lowercase; undefined when it is not a site the policy takes. */
export function normalizeSite(typed: string): string | undefined {
  const site = typed.trim().toLowerCase();
  return SITE_PATTERN.test(site) ? site : undefined;
}

export function Environment(props: Props) {
  const runners = useApiQuery("listRunners", { workspaceId: props.workspaceId });
  const environment = useApiQuery("getAgentEnvironment", {
    workspaceId: props.workspaceId,
    agentId: props.agent.id,
  });
  const target = environment.data?.target;
  const runnerId = target?.kind === "runner" ? target.runnerId : null;
  return (
    <>
      <Target {...props} runners={runners} />
      <Secrets {...props} />
      <Network {...props} />
      <Browser {...props} runners={runners.data ?? []} runnerId={runnerId} />
    </>
  );
}

function Target({
  agent,
  workspaceId,
  rights,
  runners,
}: Props & { runners: ReturnType<typeof useApiQuery<"listRunners">> }) {
  const t = useMessages("agents");
  const { locale } = useLocale();
  const outcome = useOutcome();
  const args = { workspaceId, agentId: agent.id };
  const environment = useApiQuery("getAgentEnvironment", args);
  const move = useApiMutation("setAgentEnvironmentTarget", {
    invalidates: () => [
      { method: "getAgentEnvironment" as const, args },
      { method: "getAgent" as const, args },
      { method: "getAgentRuntime" as const, args },
    ],
  });
  let body: ReactNode;
  if (environment.isPending || runners.isPending) body = <PartLoading />;
  else if (environment.isError || runners.isError) {
    const failed = environment.isError ? environment : runners;
    body = <PartError title={t("env.failed")} error={failed.error} onRetry={() => void failed.refetch()} />;
  } else {
    const target = environment.data.target;
    const currentId = target?.kind === "runner" ? target.runnerId : null;
    const options = targetsFor(runners.data, rights.userId, currentId, rights.manage);
    // Whether the runner is online comes from the runner list, which the runner events keep current.
    const online = runners.data.find((runner) => runner.id === currentId)?.online ?? target?.online === true;
    body = (
      <>
        <p role="status">
          {target === null || target.kind === "cloud"
            ? t("env.noRunner")
            : t(online ? "env.onRunner" : "env.onRunnerOffline", { name: target.name ?? "" })}
          {environment.data.lastUsedAt !== null && (
            <span className="page__muted">
              {" "}
              {t("env.lastUsed", {
                when: new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(
                  new Date(environment.data.lastUsedAt),
                ),
              })}
            </span>
          )}
        </p>
        {options.length === 0 ? (
          <p className="page__muted">
            {t("env.noRunners")}{" "}
            <AppLink className="app-link" route="settings" params={{ workspaceId, section: "runners" }}>
              {t("env.connectRunner")}
            </AppLink>
          </p>
        ) : (
          <Field label={t("env.runner")}>
            <Select
              value={currentId ?? NO_RUNNER}
              disabled={!rights.editLook || move.isPending}
              onValueChange={(next) =>
                move.mutate(
                  { ...args, body: { runnerId: next === NO_RUNNER ? null : next } },
                  {
                    onSuccess: (moved) =>
                      outcome.done(
                        moved.kind === "runner"
                          ? t("env.moved", { name: moved.name ?? "" })
                          : t("env.removed"),
                      ),
                    onError: outcome.failed,
                  },
                )
              }
            >
              <SelectItem value={NO_RUNNER}>{t("env.none")}</SelectItem>
              {options.map((runner) => (
                <SelectItem key={runner.id} value={runner.id}>
                  {t(runner.online ? "env.runnerOnline" : "env.runnerOffline", { name: runner.name })}
                </SelectItem>
              ))}
            </Select>
          </Field>
        )}
      </>
    );
  }
  return (
    <Section title={t("env.title")} help={t("env.help")}>
      {body}
    </Section>
  );
}

function Secrets({ agent, workspaceId, rights }: Props) {
  const t = useMessages("agents");
  const outcome = useOutcome();
  const args = { workspaceId, agentId: agent.id };
  const secrets = useApiQuery("listAgentSecrets", args, { refetchInterval: ENVIRONMENT_REFRESH_MS });
  const runners = useApiQuery("listRunners", { workspaceId });
  const remove = useApiMutation("deleteAgentSecret", {
    invalidates: () => [{ method: "listAgentSecrets" as const, args }],
  });
  const [deleting, setDeleting] = useState<AgentSecret | null>(null);
  const mayDelete = (secret: AgentSecret) =>
    rights.editLook ||
    can(rights.role, "configure") ||
    runners.data?.some(
      (runner) => runner.id === secret.runnerId && runner.pairedByUserId === rights.userId,
    ) === true;
  let body: ReactNode;
  if (secrets.isPending) body = <PartLoading />;
  else if (secrets.isError)
    body = (
      <PartError title={t("secrets.failed")} error={secrets.error} onRetry={() => void secrets.refetch()} />
    );
  else if (secrets.data.length === 0) body = <p className="page__muted">{t("secrets.empty")}</p>;
  else
    body = (
      <ul className="agent-plain" aria-label={t("secrets.title")}>
        {secrets.data.map((secret) => (
          <li key={`${secret.runnerId}:${secret.name}`} className="access-rule">
            <code>{secret.name}</code>
            <span className="page__muted">
              {secret.browser !== null
                ? t("secrets.browser", { sites: secret.browser.sites.join(", ") })
                : secret.target.kind === "env"
                  ? t("secrets.env")
                  : t("secrets.file", { path: secret.target.path })}
            </span>
            {mayDelete(secret) && (
              <Button
                variant="ghost"
                size="sm"
                icon={<Trash2 size={16} />}
                aria-label={t("secrets.delete", { name: secret.name })}
                onClick={() => setDeleting(secret)}
              />
            )}
          </li>
        ))}
      </ul>
    );
  return (
    <Section title={t("secrets.title")} help={t("secrets.help")}>
      {body}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        tone="danger"
        title={t("secrets.deleteTitle", { name: deleting?.name ?? "" })}
        description={t("secrets.deleteBody")}
        confirmLabel={t("skill.delete")}
        cancelLabel={t("instructions.discard")}
        confirming={remove.isPending}
        onConfirm={() => {
          if (deleting === null) return;
          remove.mutate(
            { ...args, secretId: deleting.name, query: { runnerId: deleting.runnerId } },
            {
              onSuccess: () => {
                outcome.done(t("secrets.deleted", { name: deleting.name }));
                setDeleting(null);
              },
              onError: (error) => {
                setDeleting(null);
                outcome.failed(error);
              },
            },
          );
        }}
      />
    </Section>
  );
}

function Network({ agent, workspaceId, rights }: Props) {
  const t = useMessages("agents");
  const outcome = useOutcome();
  const args = { workspaceId, agentId: agent.id };
  const environment = useApiQuery("getAgentEnvironment", args);
  const domains = useApiQuery("listAgentEnvironmentDomains", args);
  const invalidates = () => [{ method: "listAgentEnvironmentDomains" as const, args }];
  const allow = useApiMutation("allowNetworkRequest", { invalidates });
  const deny = useApiMutation("denyNetworkRequest", { invalidates });
  const remove = useApiMutation("deleteNetworkRequest", { invalidates });
  const busy = allow.isPending || deny.isPending || remove.isPending;
  const act = (request: NetworkRequest, kind: "allow" | "deny" | "remove") => {
    const mutation = kind === "allow" ? allow : kind === "deny" ? deny : remove;
    mutation.mutate(
      { workspaceId, networkRequestId: request.id },
      {
        onSuccess: () => outcome.done(t(`network.${kind}ed`, { domain: request.domain })),
        onError: outcome.failed,
      },
    );
  };
  let body: ReactNode;
  if (domains.isPending) body = <PartLoading />;
  else if (domains.isError)
    body = (
      <PartError title={t("network.failed")} error={domains.error} onRetry={() => void domains.refetch()} />
    );
  else {
    const shown = domains.data.filter((request) => request.status !== "removed");
    body =
      shown.length === 0 ? (
        <p className="page__muted">{t("network.empty")}</p>
      ) : (
        <ul className="agent-plain" aria-label={t("network.title")}>
          {shown.map((request) => (
            <li key={request.id} className="access-rule">
              <code>{request.domain}</code>
              <Chip>{t(`network.status.${request.status}`)}</Chip>
              {rights.editLook && (
                <span className="memory-note__actions">
                  {request.status !== "allowed" && (
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busy}
                      onClick={() => act(request, "allow")}
                    >
                      {t("network.allow")}
                    </Button>
                  )}
                  {request.status !== "denied" && (
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => act(request, "deny")}>
                      {t("network.deny")}
                    </Button>
                  )}
                  {request.status !== "pending" && (
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => act(request, "remove")}>
                      {t("network.remove")}
                    </Button>
                  )}
                </span>
              )}
            </li>
          ))}
        </ul>
      );
  }
  return (
    <Section
      title={t("network.title")}
      help={environment.isSuccess ? t(`network.mode.${environment.data.network}`) : undefined}
    >
      {body}
    </Section>
  );
}

type OnRunner = { runners: Runner[] /** The runner the agent works on now. */; runnerId: string | null };

function Browser({ agent, workspaceId, rights, runners, runnerId }: Props & OnRunner) {
  const t = useMessages("agents");
  const args = { workspaceId, agentId: agent.id };
  const policy = useApiQuery("getAgentBrowser", args);
  let body: ReactNode;
  if (policy.isPending) body = <PartLoading />;
  else if (policy.isError)
    body = (
      <PartError title={t("browser.failed")} error={policy.error} onRetry={() => void policy.refetch()} />
    );
  else
    body = (
      <PolicyForm
        key={JSON.stringify(policy.data)}
        saved={policy.data}
        agent={agent}
        workspaceId={workspaceId}
        rights={rights}
        runners={runners}
        runnerId={runnerId}
      />
    );
  return (
    <>
      <Section title={t("browser.title")} help={t("browser.help")}>
        {body}
      </Section>
      <Takeover
        agent={agent}
        workspaceId={workspaceId}
        rights={rights}
        runners={runners}
        runnerId={runnerId}
      />
    </>
  );
}

function PolicyForm({
  saved,
  agent,
  workspaceId,
  rights,
  runners,
  runnerId,
}: Props & OnRunner & { saved: AgentBrowserSettings }) {
  const t = useMessages("agents");
  const outcome = useOutcome();
  const args = { workspaceId, agentId: agent.id };
  const save = useApiMutation("setAgentBrowserPolicy", {
    invalidates: () => [{ method: "getAgentBrowser" as const, args }],
  });
  const [level, setLevel] = useState<BrowserLevel>(saved.level);
  const [sites, setSites] = useState<SiteRule[]>(saved.sites);
  const [typed, setTyped] = useState("");
  const [access, setAccess] = useState<SiteAccess>("read");
  const [ranges, setRanges] = useState(saved.privateRanges.join(" "));
  // Nothing changes while a save is on its way: the form starts over from what the server kept.
  const editable = rights.editLook && !save.isPending;
  const rangesRunner = runners.find((runner) => runner.id === saved.privateRangesRunnerId);
  // The ranges open the runner's own network: its pairer or someone who configures the workspace.
  const mayRanges =
    editable &&
    (can(rights.role, "configure") ||
      runners.some((runner) => runner.id === runnerId && runner.pairedByUserId === rights.userId));
  const rangeList = ranges.split(/\s+/).filter((each) => each !== "");
  const rangesChanged = rangeList.join(" ") !== saved.privateRanges.join(" ");
  const rangeCheck = checkRanges(rangeList);
  const rangesWrong = !rangeCheck.ok || rangeList.length > PRIVATE_RANGES_MAX;
  const site = normalizeSite(typed);
  const tooMany = sites.length > SITES_MAX;
  const dirty =
    level !== saved.level || JSON.stringify(sites) !== JSON.stringify(saved.sites) || rangesChanged;
  const sensitive = site === undefined ? null : sensitiveCategory(site.replace(/^\*\./, ""));

  return (
    <div className="section-form">
      <RadioGroup
        value={level}
        disabled={!editable}
        aria-label={t("browser.level")}
        onValueChange={(next) => setLevel(BROWSER_LEVELS.find((each) => each === next) ?? level)}
      >
        {BROWSER_LEVELS.map((each) => (
          <Radio
            key={each}
            value={each}
            label={t(`browser.level.${each}`)}
            hint={t(`browser.levelHint.${each}`)}
          />
        ))}
      </RadioGroup>
      {sites.length === 0 ? (
        <p className="page__muted">{t("browser.noSites")}</p>
      ) : (
        <ul className="agent-plain" aria-label={t("browser.sites")}>
          {sites.map((rule) => (
            <li key={rule.pattern} className="access-rule">
              <code>{rule.pattern}</code>
              <Chip>{t(`browser.access.${rule.access}`)}</Chip>
              {editable && (
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<Trash2 size={16} />}
                  aria-label={t("browser.removeSite", { site: rule.pattern })}
                  onClick={() => setSites(sites.filter((each) => each !== rule))}
                />
              )}
            </li>
          ))}
        </ul>
      )}
      {tooMany && (
        <p className="agent-error" role="alert">
          {t("browser.tooMany", { max: SITES_MAX })}
        </p>
      )}
      {editable && (
        <div className="access-add">
          <Field
            label={t("browser.site")}
            hint={t("browser.siteHint")}
            error={typed.trim() !== "" && site === undefined ? t("browser.siteWrong") : undefined}
          >
            <Input value={typed} spellCheck={false} onChange={(event) => setTyped(event.target.value)} />
          </Field>
          <Field label={t("browser.siteAccess")}>
            <Select value={access} onValueChange={(next) => setAccess(next === "write" ? "write" : "read")}>
              <SelectItem value="read">{t("browser.access.read")}</SelectItem>
              <SelectItem value="write">{t("browser.access.write")}</SelectItem>
            </Select>
          </Field>
          <Button
            disabled={site === undefined}
            onClick={() => {
              if (site === undefined) return;
              // A site already on the list takes the new access.
              setSites([...sites.filter((each) => each.pattern !== site), { pattern: site, access }]);
              setTyped("");
            }}
          >
            {t("browser.addSite")}
          </Button>
        </div>
      )}
      {sensitive !== null && <Callout tone="warning">{t("browser.sensitive")}</Callout>}
      <Field
        label={t("browser.ranges")}
        hint={t("browser.rangesHint", { max: PRIVATE_RANGES_MAX })}
        error={
          rangesWrong
            ? rangeCheck.ok
              ? t("browser.rangesTooMany", { max: PRIVATE_RANGES_MAX })
              : t("browser.rangeWrong", { range: rangeCheck.bad })
            : undefined
        }
      >
        <Input
          mono
          value={ranges}
          readOnly={!mayRanges}
          onChange={(event) => setRanges(event.target.value)}
        />
      </Field>
      {rangesRunner !== undefined && rangesRunner.id !== runnerId && saved.privateRanges.length > 0 && (
        <Callout tone="warning">{t("browser.rangesElsewhere", { name: rangesRunner.name })}</Callout>
      )}
      {rights.editLook && dirty && (
        <div className="section-form__actions">
          <Button
            variant="ghost"
            onClick={() => {
              setLevel(saved.level);
              setSites(saved.sites);
              setRanges(saved.privateRanges.join(" "));
            }}
          >
            {t("instructions.discard")}
          </Button>
          <Button
            variant="primary"
            disabled={rangesWrong || tooMany}
            loading={save.isPending}
            onClick={() =>
              save.mutate(
                {
                  ...args,
                  // The ranges go only when the person changed them: they open the network of the runner they are saved on.
                  body: { level, sites, ...(mayRanges && rangesChanged && { privateRanges: rangeList }) },
                },
                { onSuccess: () => outcome.done(t("browser.saved")), onError: outcome.failed },
              )
            }
          >
            {t("browser.save")}
          </Button>
        </div>
      )}
    </div>
  );
}

/** Taking over the agent's browser, handing it back, and closing it. */
function Takeover({ agent, workspaceId, rights, runners, runnerId }: Props & OnRunner) {
  const t = useMessages("agents");
  const outcome = useOutcome();
  const args = { workspaceId, agentId: agent.id };
  const runner = runners.find((each) => each.id === runnerId);
  const archived = agent.archivedAt !== null;
  const usable = !archived && agent.reachable && runner?.online === true && runner.browser;
  const open = useApiQuery("listAgentBrowserInterventions", args, {
    enabled: usable,
    refetchInterval: ENVIRONMENT_REFRESH_MS,
  });
  const invalidates = () => [{ method: "listAgentBrowserInterventions" as const, args }];
  const start = useApiMutation("startAgentBrowserIntervention", { invalidates });
  const complete = useApiMutation("completeBrowserIntervention", { invalidates });
  const stop = useApiMutation("stopAgentBrowser", { invalidates });
  let body: ReactNode;
  if (archived) body = <p className="page__muted">{t("takeover.archived")}</p>;
  else if (!agent.reachable) body = <p className="page__muted">{t("takeover.notAllowed")}</p>;
  else if (runner === undefined || !runner.online)
    body = <p className="page__muted">{t("takeover.offline")}</p>;
  else if (!runner.browser) body = <p className="page__muted">{t("takeover.noBrowser")}</p>;
  else if (open.isPending) body = <PartLoading />;
  else if (open.isError)
    body = <PartError title={t("takeover.failed")} error={open.error} onRetry={() => void open.refetch()} />;
  else {
    const current = open.data;
    const mine = current !== null && current.controllingUserId === rights.userId;
    body = (
      <>
        <p role="status">
          {current === null
            ? t("takeover.idle")
            : mine
              ? t("takeover.yours")
              : t(`takeover.status.${current.status}`)}
        </p>
        <div className="memory-note__actions">
          {current === null && (
            <Button
              loading={start.isPending}
              onClick={() =>
                start.mutate(
                  { ...args, body: {} },
                  { onSuccess: () => outcome.done(t("takeover.started")), onError: outcome.failed },
                )
              }
            >
              {t("takeover.start")}
            </Button>
          )}
          {mine && (
            <Button
              variant="primary"
              loading={complete.isPending}
              onClick={() =>
                complete.mutate(
                  { workspaceId, interventionId: current.id },
                  { onSuccess: () => outcome.done(t("takeover.done")), onError: outcome.failed },
                )
              }
            >
              {t("takeover.complete")}
            </Button>
          )}
          <Button
            variant="ghost"
            loading={stop.isPending}
            onClick={() =>
              stop.mutate(args, {
                onSuccess: () => outcome.done(t("takeover.stopped")),
                onError: outcome.failed,
              })
            }
          >
            {t("takeover.stop")}
          </Button>
        </div>
      </>
    );
  }
  return (
    <Section title={t("takeover.title")} help={t("takeover.help")}>
      {body}
    </Section>
  );
}
