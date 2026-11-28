// The Connectors section of the settings: the services the workspace can plug in (each with a sign-in
// on the service, a key, or both), the workspace's own MCP servers, and the GitHub App. A sign-in or an
// install on another site comes back to this section with its outcome in the address, which is read
// once, said in a toast and cleared. Only someone who may configure the workspace opens this section.
import { useApiMutation, useApiQuery } from "@vanr/client/react";
import type { Connection, ConnectorDef } from "@vanr/contract";
import {
  Button,
  Callout,
  Chip,
  ConfirmDialog,
  Dialog,
  DialogContent,
  EmptyState,
  Field,
  Input,
  useToast,
} from "@vanr/ui";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { useGo, useRouteParams, useSearch } from "../../../app/navigation.tsx";
import { useErrorMessage } from "../../../app/screens.tsx";
import { useLocale, useMessages } from "../../../i18n/react.tsx";
import { useOutcome } from "../shared.tsx";
import { MailReturn } from "./DataSources.tsx";
import { GitHubApp } from "./GitHub.tsx";
import { OwnServers } from "./OwnServers.tsx";
import {
  ADDRESS_MAX,
  Block,
  comeBackTo,
  isLost,
  KEY_MAX,
  KEY_MIN,
  leaveFor,
  PartError,
  PartLoading,
  SECRET,
  useForgetOnLoss,
  useLatch,
  useReturnFocus,
} from "./shared.tsx";

const CONNECTOR_READS = ["listConnectors", "getConnectorCatalog"] as const;

export function ConnectorsSection() {
  const { workspaceId } = useRouteParams("settings");
  const [reviewing, setReviewing] = useState<string | null>(null);
  return (
    <>
      <ComeBack workspaceId={workspaceId} onServerBack={setReviewing} />
      <Services workspaceId={workspaceId} />
      <OwnServers workspaceId={workspaceId} reviewing={reviewing} onReview={setReviewing} />
      <GitHubApp workspaceId={workspaceId} />
    </>
  );
}

/* ---------- the way back from a sign-in or an install ---------- */

const Back = z.object({
  connected: z.string().optional(),
  connector_error: z.string().optional(),
  github_app: z.string().optional(),
});
const NOTHING_BACK: z.infer<typeof Back> = {};
const NO_MAIL: z.infer<typeof MailReturn> = {};
// What the server's callbacks say (integrations/connectors.ts, github-app.ts); anything else reads as
// the generic failure.
const SIGN_IN_FAILURES = [
  "state",
  "gone",
  "issuer",
  "denied",
  "access_denied",
  "tools",
  "exists",
  "token",
] as const;
const INSTALL_OUTCOMES = ["installed", "error", "unverified", "taken"] as const;

function ComeBack({
  workspaceId,
  onServerBack,
}: {
  workspaceId: string;
  onServerBack: (id: string) => void;
}) {
  const t = useMessages("control");
  const toast = useToast();
  const go = useGo();
  const back = useSearch(Back, NOTHING_BACK);
  const catalog = useApiQuery("getConnectorCatalog", {});
  const mail = useSearch(MailReturn, NO_MAIL);
  const said = useRef(false);
  // The server sends a hosted mail sign-in back here; mailboxes are in Data sources, so it goes on there.
  useEffect(() => {
    if (mail.mail_connected === undefined && mail.mail_error === undefined) return;
    void go(
      "settings",
      { workspaceId, section: "data-sources" },
      { replace: true, search: { mail_connected: mail.mail_connected, mail_error: mail.mail_error } },
    );
  }, [mail, go, workspaceId]);
  const servers = useApiQuery("getConnectorCustom", { workspaceId });
  // The address only says what came back; the name shown is the catalog's or the workspace's own, never
  // the address's, so a crafted link can't announce a connection that isn't there.
  const ownServer = back.connected?.startsWith("custom:") === true;
  const named =
    back.connected === undefined ||
    (ownServer
      ? servers.data !== undefined || servers.isError
      : catalog.data !== undefined || catalog.isError);
  useEffect(() => {
    if (said.current || !named) return;
    const { connected, connector_error: failed, github_app: install } = back;
    if (connected === undefined && failed === undefined && install === undefined) return;
    said.current = true;
    if (connected !== undefined && ownServer) {
      const server = servers.data?.find((each) => each.id === connected.slice("custom:".length));
      if (server === undefined) toast.push({ tone: "info", title: t("back.unknown") });
      else {
        toast.push({ tone: "success", title: t("back.serverConnected") });
        onServerBack(server.id);
      }
    } else if (connected !== undefined) {
      const service = catalog.data?.connectors.find((each) => each.id === connected)?.label;
      toast.push(
        service === undefined
          ? { tone: "info", title: t("back.unknown") }
          : { tone: "success", title: t("back.connected", { service }) },
      );
    }
    if (failed !== undefined) {
      const known = SIGN_IN_FAILURES.find((each) => each === failed);
      toast.push({
        tone: "danger",
        title: t(known === undefined ? "back.failed.other" : `back.failed.${known}`),
      });
    }
    if (install !== undefined) {
      const known = INSTALL_OUTCOMES.find((each) => each === install) ?? "error";
      toast.push({
        tone: known === "installed" ? "success" : "danger",
        title: t(`back.github.${known}`),
      });
    }
    void go("settings", { workspaceId, section: "connectors" }, { replace: true });
  }, [back, named, ownServer, catalog.data, servers.data, go, onServerBack, t, toast, workspaceId]);
  return null;
}

/* ---------- the catalog ---------- */

type Asking = { def: ConnectorDef; again: boolean };

function Services({ workspaceId }: { workspaceId: string }) {
  const t = useMessages("control");
  const { locale } = useLocale();
  const when = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" });
  const outcome = useOutcome();
  const latch = useLatch();
  const focus = useReturnFocus();
  const forget = useForgetOnLoss(workspaceId, CONNECTOR_READS);
  const catalog = useApiQuery("getConnectorCatalog", {});
  const connections = useApiQuery("listConnectors", { workspaceId });
  const [asking, setAsking] = useState<Asking | null>(null);
  const [removing, setRemoving] = useState<{ connection: Connection; service: string } | null>(null);
  const invalidates = () => [{ method: "listConnectors" as const, args: { workspaceId } }];
  const remove = useApiMutation("deleteConnector", { invalidates });
  const widen = useApiMutation("createConnectorScope");

  let body: ReactNode;
  if (catalog.isPending || connections.isPending) body = <PartLoading />;
  else if (catalog.isError || connections.isError)
    body = (
      <PartError
        title={t("svc.failed")}
        error={catalog.error ?? connections.error}
        onRetry={() => void Promise.all([catalog.refetch(), connections.refetch()])}
      />
    );
  else if (catalog.data.connectors.length === 0)
    body = <EmptyState title={t("svc.none")} description={t("svc.noneBody")} />;
  else {
    // The server lets a workspace connect a service more than once (a sign-in that stopped working is
    // not renewed in place, a new one is made): every connection gets its own row and its own controls.
    const byService = new Map<string, Connection[]>();
    for (const each of connections.data)
      byService.set(each.connector, [...(byService.get(each.connector) ?? []), each]);
    body = (
      <ul className="wire-list" aria-label={t("svc.title")}>
        {catalog.data.connectors.flatMap((def) => {
          const own = byService.get(def.id) ?? [];
          const connectable = def.available && def.authMethods.length > 0;
          if (own.length === 0)
            return [
              <li key={def.id} className="wire-row" data-state={def.available ? "open" : "later"}>
                <div className="wire-row__who">
                  <span className="wire-row__name">{def.label}</span>
                  <span className="wire-row__what">{def.description}</span>
                </div>
                <ServiceState def={def} connection={undefined} />
                <div className="wire-row__actions">
                  {connectable && (
                    <Button
                      size="sm"
                      onClick={() => {
                        focus.remember();
                        setAsking({ def, again: false });
                      }}
                    >
                      {t("svc.connect")}
                    </Button>
                  )}
                </div>
              </li>,
            ];
          const working = own.some((each) => each.status === "active");
          return own.map((connection) => {
            // Two connections of one service with the same name are told apart by when they were made.
            const since = t("svc.since", { date: when.format(new Date(connection.createdAt)) });
            const base =
              connection.accountDisplayName ??
              (own.length > 1 && connection.label === def.label ? since : connection.label);
            // Still the same as another one (made in the same minute): its place in the list tells them apart.
            const twins = own.filter(
              (each) =>
                (each.accountDisplayName ??
                  (each.label === def.label
                    ? t("svc.since", { date: when.format(new Date(each.createdAt)) })
                    : each.label)) === base,
            );
            const who =
              twins.length > 1 ? t("svc.nth", { name: base, n: twins.indexOf(connection) + 1 }) : base;
            return (
              <li key={connection.id} className="wire-row" data-state={connection.status}>
                <div className="wire-row__who">
                  <span className="wire-row__name">{def.label}</span>
                  <span className="wire-row__what">
                    {connection.accountDisplayName != null
                      ? t("svc.account", { account: connection.accountDisplayName })
                      : own.length > 1
                        ? since
                        : def.description}
                  </span>
                  {connection.status === "reauth_required" && (
                    <span className="wire-row__note">{t("svc.reauthBody")}</span>
                  )}
                  {connection.scopeRequest != null && (
                    <span className="wire-row__note">
                      {t("svc.moreAsked", {
                        scope: connection.scopeRequest.scope,
                        tool: connection.scopeRequest.tool,
                      })}
                    </span>
                  )}
                </div>
                <ServiceState def={def} connection={connection} />
                <div className="wire-row__actions">
                  {connection.scopeRequest != null && (
                    <Button
                      size="sm"
                      variant="primary"
                      loading={widen.isPending && widen.variables?.connectorId === connection.id}
                      disabled={widen.isPending}
                      onClick={() =>
                        latch(() =>
                          widen
                            .mutateAsync({
                              workspaceId,
                              connectorId: connection.id,
                              body: { nextPath: comeBackTo(workspaceId, "connectors") },
                            })
                            .then(
                              (answer) => leaveFor(answer.consentUrl),
                              (error: unknown) => {
                                forget(error);
                                outcome.failed(error);
                              },
                            ),
                        )
                      }
                    >
                      {t("svc.grantMore")}
                    </Button>
                  )}
                  {connection.status === "reauth_required" && !working && connectable && (
                    <Button
                      size="sm"
                      variant="primary"
                      onClick={() => {
                        focus.remember();
                        setAsking({ def, again: true });
                      }}
                    >
                      {t("svc.reconnect")}
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={
                      own.length > 1
                        ? t("svc.disconnectOne", { service: def.label, account: who })
                        : t("svc.disconnectNamed", { service: def.label })
                    }
                    onClick={() => {
                      focus.remember();
                      setRemoving({ connection, service: def.label });
                    }}
                  >
                    {t("svc.disconnect")}
                  </Button>
                </div>
              </li>
            );
          });
        })}
      </ul>
    );
  }

  return (
    <Block title={t("svc.title")} lead={t("svc.lead")}>
      {body}
      {asking !== null && (
        <ConnectDialog
          // Another service, or the same one in another workspace, starts a fresh dialog.
          key={`${workspaceId}/${asking.def.id}`}
          workspaceId={workspaceId}
          def={asking.def}
          again={asking.again}
          onClose={() => setAsking(null)}
          onCloseAutoFocus={focus.onCloseAutoFocus}
        />
      )}
      <ConfirmDialog
        returnFocus={focus.back}
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open && !remove.isPending) setRemoving(null);
        }}
        tone="danger"
        title={t("svc.disconnectTitle", { service: removing?.service ?? "" })}
        description={t("svc.disconnectBody")}
        confirmLabel={t("svc.disconnect")}
        cancelLabel={t("wire.keep")}
        confirming={remove.isPending}
        onConfirm={() => {
          const target = removing;
          if (target === null) return;
          latch(() =>
            remove.mutateAsync({ workspaceId, connectorId: target.connection.id }).then(
              () => {
                setRemoving(null);
                outcome.done(t("svc.disconnected", { service: target.service }));
              },
              (error: unknown) => {
                setRemoving(null);
                forget(error);
                outcome.failed(error);
              },
            ),
          );
        }}
      />
    </Block>
  );
}

function ServiceState({ def, connection }: { def: ConnectorDef; connection: Connection | undefined }) {
  const t = useMessages("control");
  if (connection === undefined) {
    if (!def.available) return <Chip>{t("svc.later")}</Chip>;
    if (def.authMethods.length === 0) return <Chip>{t("svc.builtIn")}</Chip>;
    return null;
  }
  if (connection.status === "reauth_required")
    return <Chip className="wire-chip--attention">{t("svc.reauth")}</Chip>;
  return <Chip className="wire-chip--live">{t("svc.connected")}</Chip>;
}

/**
 * Connects one service: a sign-in on the service, a key, or the choice of either. A service that asks
 * for its server's address gets that field too. The key lives only in this dialog: it is sent once and
 * never kept anywhere once the dialog closes.
 */
function ConnectDialog({
  workspaceId,
  def,
  again,
  onClose,
  onCloseAutoFocus,
}: {
  workspaceId: string;
  def: ConnectorDef;
  again: boolean;
  onClose: () => void;
  onCloseAutoFocus: (event: Event) => void;
}) {
  const t = useMessages("control");
  const common = useMessages("common");
  const describe = useErrorMessage("control");
  const outcome = useOutcome();
  const latch = useLatch();
  const forget = useForgetOnLoss(workspaceId, CONNECTOR_READS);
  const [key, setKey] = useState("");
  const [address, setAddress] = useState("");
  const invalidates = () => [{ method: "listConnectors" as const, args: { workspaceId } }];
  const withKey = useApiMutation("createConnector", { ...SECRET, invalidates });
  const signIn = useApiMutation("startConnectorOauth");
  const byKey = def.authMethods.includes("api_key");
  const bySignIn = def.authMethods.includes("oauth");
  const trimmedKey = key.trim();
  const keyShort = trimmedKey !== "" && trimmedKey.length < KEY_MIN;
  const needsAddress = def.askServerUrl && address.trim() === "";
  const busy = withKey.isPending || signIn.isPending;
  const failure = withKey.error ?? signIn.error;
  const serverUrl = def.askServerUrl ? { serverUrl: address.trim() } : {};
  const fail = (error: unknown) => {
    forget(error);
    if (isLost(error)) {
      onClose();
      outcome.failed(error);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent
        onCloseAutoFocus={onCloseAutoFocus}
        size="md"
        closeLabel={common("action.close")}
        title={t(again ? "svc.reconnectTitle" : "svc.connectTitle", { service: def.label })}
        description={t(bySignIn && byKey ? "svc.eitherWay" : bySignIn ? "svc.signInOnly" : "svc.keyOnly", {
          service: def.label,
        })}
      >
        <div className="section-form">
          {def.askServerUrl && (
            <Field label={t("svc.address")} hint={t("svc.addressHint", { service: def.label })} required>
              <Input
                type="url"
                value={address}
                maxLength={ADDRESS_MAX}
                autoComplete="off"
                placeholder="https://"
                disabled={busy}
                onChange={(event) => setAddress(event.target.value)}
              />
            </Field>
          )}
          {bySignIn && (
            <div className="wire-way">
              <Button
                variant="primary"
                disabled={needsAddress || (busy && !signIn.isPending)}
                loading={signIn.isPending}
                onClick={() =>
                  latch(() =>
                    signIn
                      .mutateAsync({
                        workspaceId,
                        connectorId: def.id,
                        body: { nextPath: comeBackTo(workspaceId, "connectors"), ...serverUrl },
                      })
                      .then((answer) => leaveFor(answer.consentUrl), fail),
                  )
                }
              >
                {t("svc.signIn", { service: def.label })}
              </Button>
            </div>
          )}
          {byKey && (
            <form
              className="section-form wire-way"
              aria-label={t("svc.keyForm", { service: def.label })}
              onSubmit={(event) => {
                event.preventDefault();
                if (trimmedKey.length < KEY_MIN || needsAddress) return;
                latch(() =>
                  withKey
                    .mutateAsync({
                      workspaceId,
                      body: { connector: def.id, apiKey: trimmedKey, ...serverUrl },
                    })
                    .then(() => {
                      setKey("");
                      withKey.reset();
                      outcome.done(t("svc.connectedToast", { service: def.label }));
                      onClose();
                    }, fail),
                );
              }}
            >
              <Field
                label={t("svc.key")}
                hint={t("svc.keyHint", { min: KEY_MIN })}
                error={keyShort ? t("svc.keyShort", { min: KEY_MIN }) : undefined}
              >
                <Input
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={key}
                  maxLength={KEY_MAX}
                  disabled={busy}
                  onChange={(event) => setKey(event.target.value)}
                />
              </Field>
              <div className="section-form__actions">
                <Button
                  type="submit"
                  variant={bySignIn ? "secondary" : "primary"}
                  disabled={trimmedKey.length < KEY_MIN || needsAddress || (busy && !withKey.isPending)}
                  loading={withKey.isPending}
                >
                  {t("svc.useKey")}
                </Button>
              </div>
            </form>
          )}
          {failure !== null && !isLost(failure) && (
            <Callout tone="danger" role="alert">
              {describe(failure)}
            </Callout>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
