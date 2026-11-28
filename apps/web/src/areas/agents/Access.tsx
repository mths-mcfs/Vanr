// What the agent reaches of the workspace (Reach.tsx), its own accounts on services and its per-channel
// rules. A rule only narrows what the workspace granted (off, read only, or each use waits for
// approval), for one connection or for all of them, in one channel the agent is in. The server answers
// with the rules on channels this person may read and keeps the others as they are, so a member never
// sees the rules of a private channel they are not in: this screen shows and replaces exactly what came
// back. Whoever edits the agent changes them; everyone else reads them. The connector screens
// themselves are the workspace settings'.
import { useApiMutation, useApiQuery } from "@vanr/client/react";
import type { AgentDetail, ChannelAccessLevel, ChannelAccessRule, Connection } from "@vanr/contract";
import { Button, Callout, Chip, ConfirmDialog, EmptyState, Field, Input, Select, SelectItem } from "@vanr/ui";
import { Trash2 } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useErrorMessage } from "../../app/screens.tsx";
import { useMessages } from "../../i18n/react.tsx";
import { Reach } from "./Reach.tsx";
import { type AgentRights, PartError, PartLoading, Section, useOutcome } from "./shared.tsx";

/** The connection id of a rule that covers every connection. */
export const ALL_CONNECTIONS = "*";
export const KEY_MIN = 8;
const LEVELS = ["off", "read", "approval"] as const satisfies readonly ChannelAccessLevel[];

type Props = { agent: AgentDetail; workspaceId: string; rights: AgentRights };

/** The rules with this one added; a rule for the same channel and connection is replaced. */
export function withRule(rules: readonly ChannelAccessRule[], rule: ChannelAccessRule): ChannelAccessRule[] {
  return [
    ...rules.filter((each) => each.channelId !== rule.channelId || each.connectionId !== rule.connectionId),
    rule,
  ];
}

export function Access(props: Props) {
  const t = useMessages("agents");
  const identity = useApiQuery("getAgentIdentity", {
    workspaceId: props.workspaceId,
    agentId: props.agent.id,
  });
  let accounts: ReactNode;
  let rules: ReactNode;
  if (identity.isPending) {
    accounts = <PartLoading />;
    rules = <PartLoading />;
  } else if (identity.isError) {
    const failed = (
      <PartError title={t("access.failed")} error={identity.error} onRetry={() => void identity.refetch()} />
    );
    accounts = failed;
    rules = null;
  } else {
    accounts = <Accounts {...props} connections={identity.data.connections} />;
    rules = (
      <Rules
        {...props}
        rules={identity.data.channels}
        own={identity.data.connections}
        onStale={identity.refetch}
      />
    );
  }
  return (
    <>
      <Section title={t("reach.title")} help={t("reach.help")}>
        <Reach {...props} />
      </Section>
      <Section title={t("access.accounts")} help={t("access.accountsHelp")}>
        {accounts}
      </Section>
      {rules !== null && (
        <Section title={t("access.rules")} help={t("access.rulesHelp")}>
          {rules}
        </Section>
      )}
    </>
  );
}

function Accounts({ agent, workspaceId, rights, connections }: Props & { connections: Connection[] }) {
  const t = useMessages("agents");
  const outcome = useOutcome();
  const describe = useErrorMessage("agents");
  const catalog = useApiQuery("getConnectorCatalog", {});
  const [service, setService] = useState("");
  const [key, setKey] = useState("");
  const [revoking, setRevoking] = useState(false);
  const args = { workspaceId, agentId: agent.id };
  const invalidates = () => [{ method: "getAgentIdentity" as const, args }];
  const connect = useApiMutation("createAgentIdentityConnection", { invalidates });
  const revoke = useApiMutation("revokeAgentIdentity", { invalidates });
  const labelOf = (id: string) => catalog.data?.connectors.find((each) => each.id === id)?.label ?? id;
  const taken = new Set(connections.map((each) => each.connector));
  const offered = (catalog.data?.connectors ?? []).filter(
    (each) => each.available && each.authMethods.length > 0 && !taken.has(each.id),
  );
  const chosen = offered.find((each) => each.id === service);
  const keyOnly = chosen !== undefined && !chosen.authMethods.includes("oauth");
  const keyShort = key.trim() !== "" && key.trim().length < KEY_MIN;
  const ready = chosen !== undefined && !keyShort && (!keyOnly || key.trim() !== "");
  const busy = connect.isPending || revoke.isPending;

  return (
    <>
      {connections.length === 0 ? (
        <p className="page__muted">{t("access.noAccounts")}</p>
      ) : (
        <ul className="agent-plain" aria-label={t("access.accounts")}>
          {connections.map((connection) => (
            <li key={connection.id} className="access-account">
              <strong>{labelOf(connection.connector)}</strong>
              <span>{connection.accountDisplayName ?? connection.label}</span>
              <Chip>{t(`access.status.${connection.status}`)}</Chip>
              {connection.scopeRequest != null && (
                <span className="page__muted">
                  {t("access.scopeRequest", {
                    scope: connection.scopeRequest.scope,
                    tool: connection.scopeRequest.tool,
                  })}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {rights.editLook && (
        <>
          {catalog.isError ? (
            <PartError
              title={t("access.catalogFailed")}
              error={catalog.error}
              onRetry={() => void catalog.refetch()}
            />
          ) : (
            offered.length > 0 && (
              <form
                className="section-form access-connect"
                aria-label={t("access.connect")}
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!ready || chosen === undefined) return;
                  connect.mutate(
                    {
                      ...args,
                      body: {
                        connector: chosen.id,
                        nextPath: window.location.pathname + window.location.search,
                        ...(key.trim() !== "" && { apiKey: key.trim() }),
                      },
                    },
                    {
                      onSuccess: (answer) => {
                        if (answer.status === "oauth") {
                          window.location.assign(answer.consentUrl);
                          return;
                        }
                        setService("");
                        setKey("");
                        outcome.done(t("access.connected", { service: chosen.label }));
                      },
                    },
                  );
                }}
              >
                <Field label={t("access.service")}>
                  <Select
                    value={service}
                    disabled={busy}
                    placeholder={t("access.pickService")}
                    onValueChange={(next) => {
                      // A key typed for one service never goes to another.
                      setService(next);
                      setKey("");
                      // An error about the service before is not about this one.
                      connect.reset();
                    }}
                  >
                    {offered.map((each) => (
                      <SelectItem key={each.id} value={each.id}>
                        {each.label}
                      </SelectItem>
                    ))}
                  </Select>
                </Field>
                {chosen?.authMethods.includes("api_key") && (
                  <Field
                    label={t("access.key")}
                    hint={t(keyOnly ? "access.keyHint" : "access.keyOptional", { min: KEY_MIN })}
                    error={keyShort ? t("access.keyShort", { min: KEY_MIN }) : undefined}
                  >
                    <Input
                      type="password"
                      autoComplete="off"
                      value={key}
                      disabled={busy}
                      onChange={(event) => setKey(event.target.value)}
                    />
                  </Field>
                )}
                {connect.isError && (
                  <Callout tone="danger" role="alert">
                    {describe(connect.error)}
                  </Callout>
                )}
                <div className="section-form__actions">
                  <Button type="submit" variant="primary" disabled={!ready} loading={connect.isPending}>
                    {key.trim() === "" && !keyOnly ? t("access.signIn") : t("access.connectAction")}
                  </Button>
                </div>
              </form>
            )
          )}
          {connections.length > 0 && (
            <div>
              <Button variant="danger" disabled={busy} onClick={() => setRevoking(true)}>
                {t("access.revokeAll")}
              </Button>
            </div>
          )}
        </>
      )}
      <ConfirmDialog
        open={revoking}
        onOpenChange={setRevoking}
        tone="danger"
        title={t("access.revokeTitle", { name: agent.name })}
        description={t("access.revokeBody")}
        confirmLabel={t("access.revokeAll")}
        cancelLabel={t("instructions.discard")}
        confirming={revoke.isPending}
        onConfirm={() =>
          revoke.mutate(args, {
            onSuccess: (answer) => {
              setRevoking(false);
              outcome.done(t("access.revoked", { count: answer.revoked }));
            },
            onError: (error) => {
              setRevoking(false);
              outcome.failed(error);
            },
          })
        }
      />
    </>
  );
}

function Rules({
  agent,
  workspaceId,
  rights,
  rules,
  own,
  onStale,
}: Props & {
  rules: ChannelAccessRule[];
  own: Connection[];
  /** The person's channels changed: ask the server for the rules again. */
  onStale: () => unknown;
}) {
  const t = useMessages("agents");
  const outcome = useOutcome();
  const channels = useApiQuery("listChannels", { workspaceId });
  const shared = useApiQuery("listConnectors", { workspaceId });
  const catalog = useApiQuery("getConnectorCatalog", {});
  const args = { workspaceId, agentId: agent.id };
  const save = useApiMutation("setAgentIdentityChannels", {
    invalidates: () => [{ method: "getAgentIdentity" as const, args }],
  });
  const [channelId, setChannelId] = useState("");
  const [connectionId, setConnectionId] = useState(ALL_CONNECTIONS);
  const [level, setLevel] = useState<ChannelAccessLevel>("read");
  const names = new Map((channels.data ?? []).map((channel) => [channel.id, channel.name]));
  const service = (id: string) => catalog.data?.connectors.find((each) => each.id === id)?.label ?? id;
  const connections = [
    ...(shared.data ?? []).filter((each) => each.revokedAt === null),
    ...own.filter((each) => each.revokedAt === null),
  ];
  const connectionName = (id: string) => {
    if (id === ALL_CONNECTIONS) return t("access.allConnections");
    const found = connections.find((each) => each.id === id);
    return found === undefined ? t("access.someConnection") : `${service(found.connector)} · ${found.label}`;
  };
  // Only channels the agent is in and the person may read can take a new rule.
  const choosable = agent.channels.filter((channel) => names.has(channel.id));
  // The rules are exactly what the server answered: someone who manages agents sees rules on private
  // channels missing from their own channel list, and a save replaces every rule they see, so nothing
  // here is dropped by name. When the channels change (the person left one), the rules are asked again
  // and the server's answer decides what stays.
  const shown = rules;
  const channelKey = (channels.data ?? []).map((channel) => channel.id).join(",");
  const firstKey = useRef(channelKey);
  useEffect(() => {
    if (channelKey === firstKey.current) return;
    firstKey.current = channelKey;
    onStale();
  }, [channelKey, onStale]);
  const picked = choosable.some((channel) => channel.id === channelId) ? channelId : "";
  const send = (next: ChannelAccessRule[], done: string) =>
    save.mutate(
      { ...args, body: { channels: next } },
      { onSuccess: () => outcome.done(done), onError: outcome.failed },
    );

  return (
    <>
      {shown.length === 0 ? (
        <EmptyState title={t("access.noRules")} description={t("access.noRulesBody")} />
      ) : (
        <ul className="agent-plain" aria-label={t("access.rules")}>
          {shown.map((rule) => {
            const where = names.has(rule.channelId)
              ? `#${names.get(rule.channelId)}`
              : t("overview.privateChannel");
            const what = connectionName(rule.connectionId);
            return (
              <li key={`${rule.channelId}|${rule.connectionId}`} className="access-rule">
                <span>{where}</span>
                <span>{what}</span>
                <Chip>{t(`access.level.${rule.level}`)}</Chip>
                {rights.editLook && (
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={<Trash2 size={16} />}
                    disabled={save.isPending}
                    aria-label={t("access.removeRule", { channel: where, connection: what })}
                    onClick={() =>
                      send(
                        shown.filter((each) => each !== rule),
                        t("access.ruleRemoved"),
                      )
                    }
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}
      {rights.editLook && shared.isError && (
        <PartError
          title={t("access.connectionsFailed")}
          error={shared.error}
          onRetry={() => void shared.refetch()}
        />
      )}
      {rights.editLook &&
        (channels.isError ? (
          <PartError
            title={t("new.channelsFailed")}
            error={channels.error}
            onRetry={() => void channels.refetch()}
          />
        ) : choosable.length === 0 ? (
          channels.isSuccess && <p className="page__muted">{t("access.noChannels")}</p>
        ) : (
          <form
            className="access-add"
            aria-label={t("access.addRule")}
            onSubmit={(event) => {
              event.preventDefault();
              if (picked === "") return;
              send(withRule(shown, { channelId: picked, connectionId, level }), t("access.ruleSaved"));
            }}
          >
            <Field label={t("access.channel")}>
              <Select
                value={picked}
                placeholder={t("access.pickChannel")}
                disabled={save.isPending}
                onValueChange={setChannelId}
              >
                {choosable.map((channel) => (
                  <SelectItem key={channel.id} value={channel.id}>
                    #{names.get(channel.id)}
                  </SelectItem>
                ))}
              </Select>
            </Field>
            <Field label={t("access.connection")}>
              <Select value={connectionId} disabled={save.isPending} onValueChange={setConnectionId}>
                <SelectItem value={ALL_CONNECTIONS}>{t("access.allConnections")}</SelectItem>
                {connections.map((each) => (
                  <SelectItem key={each.id} value={each.id}>
                    {connectionName(each.id)}
                  </SelectItem>
                ))}
              </Select>
            </Field>
            <Field label={t("access.level")}>
              <Select
                value={level}
                disabled={save.isPending}
                onValueChange={(next) => setLevel(LEVELS.find((each) => each === next) ?? "read")}
              >
                {LEVELS.map((each) => (
                  <SelectItem key={each} value={each}>
                    {t(`access.level.${each}`)}
                  </SelectItem>
                ))}
              </Select>
            </Field>
            <Button type="submit" disabled={picked === ""} loading={save.isPending}>
              {t("access.addRule")}
            </Button>
          </form>
        ))}
    </>
  );
}
