// The workspace's mailboxes, for agents to read and send from: connected with an app password over IMAP
// (with a provider's preset servers, or servers typed in), or with a sign-in on a hosted provider. Each
// mailbox says which of its actions agents may take freely, only after a person approves, or not at all.
// Which agents reach a mailbox, and how far, is set on each agent. A password is never shown back.
import { useApiMutation, useApiQuery } from "@vanr/client/react";
import type { MailAccount, MailProviders } from "@vanr/contract";
import {
  Button,
  Callout,
  Chip,
  ConfirmDialog,
  Dialog,
  DialogContent,
  EmptyState,
  Field,
  Icon,
  Input,
  Select,
  SelectItem,
} from "@vanr/ui";
import { Plus } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { useErrorMessage } from "../../../app/screens.tsx";
import { useMessages } from "../../../i18n/react.tsx";
import { useOutcome } from "../shared.tsx";
import {
  Block,
  isLost,
  leaveFor,
  PartError,
  PartLoading,
  portOf,
  SECRET,
  useForgetOnLoss,
  useForgetReadOnLoss,
  useLatch,
  useReturnFocus,
} from "./shared.tsx";

// The server's limits (routes/integrations.ts, imapInput; integrations/mail.ts, mailUpdateInput).
const LIMIT = { address: 254, password: 500, username: 254, host: 253, name: 120 } as const;
export const MAIL_ACTIONS = [
  "search",
  "read",
  "folders",
  "draft",
  "organize",
  "send",
  "reply",
  "forward",
  "delete",
] as const;
type MailAction = (typeof MAIL_ACTIONS)[number];
/** What an action of a mailbox is for agents. */
type Rule = "free" | "ask" | "off";
const RULES = ["free", "ask", "off"] as const satisfies readonly Rule[];
const HOSTED = { gmail: "Gmail", outlook: "Outlook" } as const;
const READS = ["listMailAccounts"] as const;

export function MailAccounts({ workspaceId }: { workspaceId: string }) {
  const t = useMessages("control");
  const outcome = useOutcome();
  const latch = useLatch();
  const focus = useReturnFocus();
  const forget = useForgetOnLoss(workspaceId, READS);
  const accounts = useApiQuery("listMailAccounts", { workspaceId });
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [removing, setRemoving] = useState<MailAccount | null>(null);
  const remove = useApiMutation("deleteMailAccount", {
    invalidates: () => [{ method: "listMailAccounts" as const, args: { workspaceId } }],
  });
  useForgetReadOnLoss(workspaceId, READS, accounts.error);
  // Something gone, or no longer the person's to see, closes its dialog; a passing failure keeps it.
  const lost = isLost(accounts.error);
  // A mailbox that is gone, or no longer the person's to see, drops its dialog for good.
  useEffect(() => {
    if (lost) setEditing(null);
  }, [lost]);
  const open = lost ? undefined : accounts.data?.find((each) => each.id === editing);

  let body: ReactNode;
  if (accounts.isPending) body = <PartLoading />;
  else if (accounts.isError)
    body = (
      <PartError title={t("box.failed")} error={accounts.error} onRetry={() => void accounts.refetch()} />
    );
  else if (accounts.data.length === 0)
    body = <EmptyState title={t("box.none")} description={t("box.noneBody")} />;
  else
    body = (
      <ul className="wire-list" aria-label={t("box.title")}>
        {accounts.data.map((account) => {
          const reaching = account.agents.filter((each) => each.level !== "none").length;
          return (
            <li key={account.id} className="wire-row" data-state={account.status}>
              <div className="wire-row__who">
                <span className="wire-row__name">{account.label}</span>
                <span className="wire-row__address">{account.address}</span>
                {account.status === "reauth_required" && (
                  <span className="wire-row__note">{t("box.reauthBody")}</span>
                )}
              </div>
              <div className="wire-row__chips">
                <Chip className={account.status === "active" ? "wire-chip--live" : "wire-chip--attention"}>
                  {t(`box.status.${account.status}`)}
                </Chip>
                <Chip>{reaching === 0 ? t("wire.noAgents") : t("wire.agentCount", { count: reaching })}</Chip>
              </div>
              <div className="wire-row__actions">
                <Button
                  size="sm"
                  variant={account.status === "reauth_required" ? "primary" : "secondary"}
                  aria-label={t("box.editNamed", { address: account.address })}
                  onClick={() => {
                    focus.remember();
                    setEditing(account.id);
                  }}
                >
                  {t(account.status === "reauth_required" ? "box.renew" : "wire.edit")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={t("box.disconnectNamed", { address: account.address })}
                  onClick={() => {
                    focus.remember();
                    setRemoving(account);
                  }}
                >
                  {t("svc.disconnect")}
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
    );

  return (
    <Block
      title={t("box.title")}
      lead={t("box.lead")}
      action={
        <Button
          icon={<Icon icon={Plus} />}
          onClick={() => {
            focus.remember();
            setAdding(true);
          }}
        >
          {t("box.add")}
        </Button>
      }
    >
      {body}
      {adding && (
        <AddMailbox
          key={workspaceId}
          workspaceId={workspaceId}
          onClose={() => setAdding(false)}
          onCloseAutoFocus={focus.onCloseAutoFocus}
        />
      )}
      {open !== undefined && (
        <EditMailbox
          key={`${workspaceId}/${open.id}`}
          workspaceId={workspaceId}
          account={open}
          onClose={() => setEditing(null)}
          onCloseAutoFocus={focus.onCloseAutoFocus}
        />
      )}
      <ConfirmDialog
        returnFocus={focus.back}
        open={removing !== null}
        onOpenChange={(next) => {
          if (!next && !remove.isPending) setRemoving(null);
        }}
        tone="danger"
        title={t("box.disconnectTitle", { address: removing?.address ?? "" })}
        description={t("box.disconnectBody")}
        confirmLabel={t("svc.disconnect")}
        cancelLabel={t("wire.keep")}
        confirming={remove.isPending}
        onConfirm={() => {
          const target = removing;
          if (target === null) return;
          latch(() =>
            remove.mutateAsync({ workspaceId, accountId: target.id }).then(
              () => {
                setRemoving(null);
                outcome.done(t("box.disconnected", { address: target.address }));
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

type Servers = { imapHost: string; imapPort: string; smtpHost: string; smtpPort: string };
const NO_SERVERS: Servers = { imapHost: "", imapPort: "993", smtpHost: "", smtpPort: "587" };

/** Connects a mailbox. The password lives only in this dialog and leaves with the one call. */
function AddMailbox({
  workspaceId,
  onClose,
  onCloseAutoFocus,
}: {
  workspaceId: string;
  onClose: () => void;
  onCloseAutoFocus: (event: Event) => void;
}) {
  const t = useMessages("control");
  const common = useMessages("common");
  const providers = useApiQuery("listMailProviders", { workspaceId });
  // While a connection is on its way the dialog stays: Escape, the overlay and the close button too.
  const [busy, setBusy] = useState(false);
  let body: ReactNode;
  if (providers.isPending) body = <PartLoading />;
  // A failed reload keeps the form that is already there (and a connection on its way in it).
  else if (providers.isError && providers.data === undefined)
    body = (
      <PartError
        title={t("box.providersFailed")}
        error={providers.error}
        onRetry={() => void providers.refetch()}
      />
    );
  else if (providers.data !== undefined)
    body = (
      <MailboxForm workspaceId={workspaceId} providers={providers.data} onClose={onClose} onBusy={setBusy} />
    );
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
    >
      <DialogContent
        onCloseAutoFocus={onCloseAutoFocus}
        size="md"
        closeLabel={common("action.close")}
        title={t("box.addTitle")}
        description={t("box.addLead")}
      >
        {body}
      </DialogContent>
    </Dialog>
  );
}

function MailboxForm({
  workspaceId,
  providers,
  onClose,
  onBusy,
}: {
  workspaceId: string;
  providers: MailProviders;
  onClose: () => void;
  onBusy: (busy: boolean) => void;
}) {
  const t = useMessages("control");
  const common = useMessages("common");
  const describe = useErrorMessage("control");
  const outcome = useOutcome();
  const latch = useLatch();
  const [preset, setPreset] = useState(providers.presets[0]?.id ?? "other");
  const [address, setAddress] = useState("");
  const [password, setPassword] = useState("");
  const [username, setUsername] = useState("");
  const [servers, setServers] = useState<Servers>(NO_SERVERS);
  const invalidates = () => [{ method: "listMailAccounts" as const, args: { workspaceId } }];
  const connect = useApiMutation("createMailAccountImap", { ...SECRET, invalidates });
  const hosted = useApiMutation("createMailAccountComposio");
  const chosen = providers.presets.find((each) => each.id === preset);
  const other = preset === "other";
  const imapPort = portOf(servers.imapPort);
  const smtpPort = portOf(servers.smtpPort);
  const serversReady =
    !other ||
    (servers.imapHost.trim() !== "" &&
      servers.smtpHost.trim() !== "" &&
      imapPort !== null &&
      smtpPort !== null);
  const ready = address.trim().length >= 3 && password !== "" && serversReady;
  const busy = connect.isPending || hosted.isPending;
  useEffect(() => onBusy(busy), [busy, onBusy]);
  // A form that goes away mid-connection never leaves the dialog unable to close.
  useEffect(() => () => onBusy(false), [onBusy]);
  const forget = useForgetOnLoss(workspaceId, READS);
  // Access lost while the dialog was open closes it and says why; any other failure keeps what was typed.
  const lost = (error: unknown) => {
    forget(error);
    if (isLost(error)) {
      outcome.failed(error);
      onClose();
    }
  };
  const failure = connect.error ?? hosted.error;
  const portError = (text: string) =>
    text.trim() !== "" && portOf(text) === null ? t("wire.portInvalid") : undefined;

  return (
    <div className="section-form">
      {providers.composio.length > 0 && (
        <div className="wire-way">
          <p className="page__muted">{t("box.hostedLead")}</p>
          <div className="section-form__actions wire-way__start">
            {providers.composio.map((provider) => (
              <Button
                key={provider}
                disabled={busy}
                loading={hosted.isPending && hosted.variables?.body.provider === provider}
                onClick={() => {
                  // Each attempt shows its own failure, not the one before it.
                  connect.reset();
                  latch(() =>
                    hosted
                      .mutateAsync({ workspaceId, body: { provider } })
                      .then((answer) => leaveFor(answer.redirectUrl), lost),
                  );
                }}
              >
                {t("box.hosted", { provider: HOSTED[provider] })}
              </Button>
            ))}
          </div>
        </div>
      )}
      <form
        className="section-form wire-way"
        aria-label={t("box.imapForm")}
        onSubmit={(event) => {
          event.preventDefault();
          if (!ready) return;
          hosted.reset();
          latch(() =>
            connect
              .mutateAsync({
                workspaceId,
                body: {
                  preset,
                  address: address.trim(),
                  password,
                  ...(username.trim() !== "" && { username: username.trim() }),
                  ...(other &&
                    imapPort !== null &&
                    smtpPort !== null && {
                      imapHost: servers.imapHost.trim(),
                      imapPort,
                      smtpHost: servers.smtpHost.trim(),
                      smtpPort,
                    }),
                },
              })
              .then((answer) => {
                setPassword("");
                connect.reset();
                outcome.done(t("box.connected", { address: answer.address }));
                onClose();
              }, lost),
          );
        }}
      >
        <Field label={t("box.provider")}>
          <Select value={preset} disabled={busy} onValueChange={setPreset}>
            {providers.presets.map((each) => (
              <SelectItem key={each.id} value={each.id}>
                {each.id === "other" ? t("box.otherProvider") : each.label}
              </SelectItem>
            ))}
          </Select>
        </Field>
        <Field label={t("box.address")} required>
          <Input
            type="email"
            value={address}
            maxLength={LIMIT.address}
            autoComplete="off"
            disabled={busy}
            onChange={(event) => setAddress(event.target.value)}
          />
        </Field>
        <Field
          label={t("box.password")}
          hint={
            chosen?.appPasswordGuide != null ? (
              <a className="app-link" href={chosen.appPasswordGuide} target="_blank" rel="noreferrer">
                {t("box.appPasswordGuide", { provider: chosen.label })}
              </a>
            ) : (
              t("box.passwordHint")
            )
          }
          required
        >
          <Input
            type="password"
            value={password}
            maxLength={LIMIT.password}
            autoComplete="new-password"
            disabled={busy}
            onChange={(event) => setPassword(event.target.value)}
          />
        </Field>
        {other && (
          <>
            <Field label={t("box.username")} hint={t("box.usernameHint")}>
              <Input
                value={username}
                maxLength={LIMIT.username}
                autoComplete="off"
                disabled={busy}
                onChange={(event) => setUsername(event.target.value)}
              />
            </Field>
            <div className="wire-pair">
              <Field label={t("box.imapHost")} required>
                <Input
                  value={servers.imapHost}
                  maxLength={LIMIT.host}
                  placeholder="imap.example.com"
                  disabled={busy}
                  onChange={(event) => setServers({ ...servers, imapHost: event.target.value })}
                />
              </Field>
              <Field label={t("box.imapPort")} error={portError(servers.imapPort)} required>
                <Input
                  value={servers.imapPort}
                  inputMode="numeric"
                  maxLength={5}
                  disabled={busy}
                  onChange={(event) => setServers({ ...servers, imapPort: event.target.value })}
                />
              </Field>
              <Field label={t("box.smtpHost")} hint={t("box.smtpHint")} required>
                <Input
                  value={servers.smtpHost}
                  maxLength={LIMIT.host}
                  placeholder="smtp.example.com"
                  disabled={busy}
                  onChange={(event) => setServers({ ...servers, smtpHost: event.target.value })}
                />
              </Field>
              <Field label={t("box.smtpPort")} error={portError(servers.smtpPort)} required>
                <Input
                  value={servers.smtpPort}
                  inputMode="numeric"
                  maxLength={5}
                  disabled={busy}
                  onChange={(event) => setServers({ ...servers, smtpPort: event.target.value })}
                />
              </Field>
            </div>
          </>
        )}
        {failure !== null && !isLost(failure) && (
          <Callout tone="danger" role="alert">
            {describe(failure)}
          </Callout>
        )}
        <div className="section-form__actions">
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            {common("action.cancel")}
          </Button>
          <Button
            type="submit"
            variant="primary"
            disabled={!ready || hosted.isPending}
            loading={connect.isPending}
          >
            {t("box.connect")}
          </Button>
        </div>
      </form>
    </div>
  );
}

const ruleOf = (account: MailAccount, action: MailAction): Rule =>
  account.disabledActions.includes(action) ? "off" : account.confirmActions.includes(action) ? "ask" : "free";

/** The mailbox's name, a new password (needed when the server stopped accepting the old one) and its rules. */
function EditMailbox({
  workspaceId,
  account,
  onClose,
  onCloseAutoFocus,
}: {
  workspaceId: string;
  account: MailAccount;
  onClose: () => void;
  onCloseAutoFocus: (event: Event) => void;
}) {
  const t = useMessages("control");
  const common = useMessages("common");
  const describe = useErrorMessage("control");
  const outcome = useOutcome();
  const latch = useLatch();
  const forget = useForgetOnLoss(workspaceId, READS);
  const [name, setName] = useState(account.label);
  const [password, setPassword] = useState("");
  const [rules, setRules] = useState<Record<MailAction, Rule>>(
    () =>
      Object.fromEntries(MAIL_ACTIONS.map((action) => [action, ruleOf(account, action)])) as Record<
        MailAction,
        Rule
      >,
  );
  const save = useApiMutation("updateMailAccount", {
    ...SECRET,
    invalidates: () => [{ method: "listMailAccounts" as const, args: { workspaceId } }],
  });
  const renewing = account.status === "reauth_required" && account.via === "imap";
  const rulesChanged = MAIL_ACTIONS.some((action) => rules[action] !== ruleOf(account, action));
  const ready = name.trim() !== "" && (!renewing || password !== "");
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !save.isPending) onClose();
      }}
    >
      <DialogContent
        onCloseAutoFocus={onCloseAutoFocus}
        size="lg"
        closeLabel={common("action.close")}
        title={account.address}
        description={t("box.editLead")}
      >
        <form
          className="section-form"
          aria-label={t("box.editNamed", { address: account.address })}
          onSubmit={(event) => {
            event.preventDefault();
            if (!ready) return;
            latch(() =>
              save
                .mutateAsync({
                  workspaceId,
                  accountId: account.id,
                  body: {
                    label: name.trim(),
                    // Only what changed goes: untouched rules never undo someone else's change.
                    ...(rulesChanged && {
                      disabledActions: MAIL_ACTIONS.filter((action) => rules[action] === "off"),
                      confirmActions: MAIL_ACTIONS.filter((action) => rules[action] === "ask"),
                    }),
                    ...(password !== "" && { password }),
                  },
                })
                .then(
                  () => {
                    setPassword("");
                    save.reset();
                    outcome.done(t("box.saved", { address: account.address }));
                    onClose();
                  },
                  (error: unknown) => {
                    forget(error);
                    if (isLost(error)) {
                      outcome.failed(error);
                      onClose();
                    }
                  },
                ),
            );
          }}
        >
          {renewing && (
            <Callout tone="warning" role="status">
              {t("box.renewNeeded")}
            </Callout>
          )}
          <Field label={t("box.name")} required>
            <Input
              value={name}
              maxLength={LIMIT.name}
              disabled={save.isPending}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          {account.via === "imap" && (
            <Field
              label={t("box.newPassword")}
              hint={renewing ? undefined : t("box.newPasswordHint")}
              required={renewing}
            >
              <Input
                type="password"
                value={password}
                maxLength={LIMIT.password}
                autoComplete="new-password"
                disabled={save.isPending}
                onChange={(event) => setPassword(event.target.value)}
              />
            </Field>
          )}
          <fieldset className="wire-rules">
            <legend className="page__heading">{t("box.rules")}</legend>
            <p className="page__muted">{t("box.rulesLead")}</p>
            <ul className="wire-rules__list">
              {MAIL_ACTIONS.map((action) => (
                <li key={action} className="wire-rules__row">
                  <span>{t(`box.action.${action}`)}</span>
                  <Select
                    size="sm"
                    value={rules[action]}
                    disabled={save.isPending}
                    aria-label={t("box.ruleFor", { action: t(`box.action.${action}`) })}
                    onValueChange={(next) => {
                      const rule = RULES.find((each) => each === next);
                      if (rule !== undefined) setRules({ ...rules, [action]: rule });
                    }}
                  >
                    {RULES.map((rule) => (
                      <SelectItem key={rule} value={rule}>
                        {t(`box.rule.${rule}`)}
                      </SelectItem>
                    ))}
                  </Select>
                </li>
              ))}
            </ul>
          </fieldset>
          {save.isError && !isLost(save.error) && (
            <Callout tone="danger" role="alert">
              {describe(save.error)}
            </Callout>
          )}
          <div className="section-form__actions">
            <Button variant="ghost" disabled={save.isPending} onClick={onClose}>
              {common("action.cancel")}
            </Button>
            <Button type="submit" variant="primary" disabled={!ready} loading={save.isPending}>
              {t("box.save")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
