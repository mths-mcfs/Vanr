// The customer's own Postgres databases, for agents to read under the rules set on each agent: connected
// by a connection string or by its fields. The connection is encrypted by default (`require`); checking
// the server's certificate (`verify-full`) is a choice per connection, and no encryption at all only works
// where this server allows it. Vanr checks the connection when it is saved, says whether the login could
// change data (agents still only read) and suggests columns to hide. The password is never shown back.
import { useApiMutation, useApiQuery } from "@vanr/client/react";
import type { DatabaseConnectInput, DatabaseConnection, DatabaseProvider } from "@vanr/contract";
import {
  Button,
  Callout,
  Checkbox,
  Chip,
  ConfirmDialog,
  Dialog,
  DialogContent,
  EmptyState,
  Field,
  Icon,
  Input,
  Radio,
  RadioGroup,
  Select,
  SelectItem,
} from "@vanr/ui";
import { Plus } from "lucide-react";
import { type ReactNode, useState } from "react";
import { useErrorMessage } from "../../../app/screens.tsx";
import { useMessages } from "../../../i18n/react.tsx";
import { useOutcome } from "../shared.tsx";
import {
  Block,
  isLost,
  PartError,
  PartLoading,
  portOf,
  SECRET,
  useForgetOnLoss,
  useForgetReadOnLoss,
  useLatch,
} from "./shared.tsx";

// The server's limits (routes/integrations.ts, dbInput and dbUpdateInput).
const LIMIT = { url: 2000, host: 253, name: 120, password: 500 } as const;
export const PROVIDERS = [
  "supabase",
  "neon",
  "railway",
  "rds",
  "render",
  "other",
] as const satisfies readonly DatabaseProvider[];
export const TLS = ["require", "verify-full", "disable"] as const;
type Tls = (typeof TLS)[number];
export const DB_ACTIONS = ["tables", "describe", "query"] as const;
type DbAction = (typeof DB_ACTIONS)[number];
/** How many suggested columns a row names before it only counts the rest. */
const SUGGESTED_SHOWN = 4;
const READS = ["listDatabases"] as const;

export function Databases({ workspaceId }: { workspaceId: string }) {
  const t = useMessages("control");
  const outcome = useOutcome();
  const latch = useLatch();
  const forget = useForgetOnLoss(workspaceId, READS);
  const list = useApiQuery("listDatabases", { workspaceId });
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [removing, setRemoving] = useState<DatabaseConnection | null>(null);
  const remove = useApiMutation("deleteDatabase", {
    invalidates: () => [{ method: "listDatabases" as const, args: { workspaceId } }],
  });
  useForgetReadOnLoss(workspaceId, READS, list.error);
  // Something gone, or no longer the person's to see, closes its dialog; a passing failure keeps it.
  const open = isLost(list.error) ? undefined : list.data?.find((each) => each.id === editing);

  let body: ReactNode;
  if (list.isPending) body = <PartLoading />;
  else if (list.isError)
    body = <PartError title={t("db.failed")} error={list.error} onRetry={() => void list.refetch()} />;
  else if (list.data.length === 0) body = <EmptyState title={t("db.none")} description={t("db.noneBody")} />;
  else
    body = (
      <ul className="wire-list" aria-label={t("db.title")}>
        {list.data.map((each) => {
          const reaching = each.agents.filter((agent) => agent.level !== "none").length;
          const named = each.hiddenSuggestion.slice(0, SUGGESTED_SHOWN);
          const more = each.hiddenSuggestion.length - named.length;
          return (
            <li key={each.id} className="wire-row" data-state={each.status}>
              <div className="wire-row__who">
                <span className="wire-row__name">{each.label}</span>
                <span className="wire-row__address">
                  {t("db.where", {
                    provider: t(`db.provider.${each.provider}`),
                    user: each.username,
                    host: each.host,
                    database: each.database,
                  })}
                </span>
                {each.status === "reauth_required" && (
                  <span className="wire-row__note">{t("db.reauthBody")}</span>
                )}
                {each.canWrite && <span className="wire-row__what">{t("db.canWrite")}</span>}
                {named.length > 0 && (
                  <span className="wire-row__what">
                    {t(more > 0 ? "db.suggestedMore" : "db.suggested", { columns: named.join(", "), more })}
                  </span>
                )}
              </div>
              <div className="wire-row__chips">
                <Chip className={each.status === "active" ? "wire-chip--live" : "wire-chip--attention"}>
                  {t(`db.status.${each.status}`)}
                </Chip>
                <Chip>{reaching === 0 ? t("wire.noAgents") : t("wire.agentCount", { count: reaching })}</Chip>
              </div>
              <div className="wire-row__actions">
                <Button
                  size="sm"
                  variant={each.status === "reauth_required" ? "primary" : "secondary"}
                  aria-label={t("db.editNamed", { name: each.label })}
                  onClick={() => setEditing(each.id)}
                >
                  {t(each.status === "reauth_required" ? "db.renew" : "wire.edit")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={t("db.disconnectNamed", { name: each.label })}
                  onClick={() => setRemoving(each)}
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
      title={t("db.title")}
      lead={t("db.lead")}
      action={
        <Button icon={<Icon icon={Plus} />} onClick={() => setAdding(true)}>
          {t("db.add")}
        </Button>
      }
    >
      {body}
      {adding && <AddDatabase key={workspaceId} workspaceId={workspaceId} onClose={() => setAdding(false)} />}
      {open !== undefined && (
        <EditDatabase
          key={`${workspaceId}/${open.id}`}
          workspaceId={workspaceId}
          connection={open}
          onClose={() => setEditing(null)}
        />
      )}
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(next) => {
          if (!next && !remove.isPending) setRemoving(null);
        }}
        tone="danger"
        title={t("db.disconnectTitle", { name: removing?.label ?? "" })}
        description={t("db.disconnectBody")}
        confirmLabel={t("svc.disconnect")}
        cancelLabel={t("wire.keep")}
        confirming={remove.isPending}
        onConfirm={() => {
          const target = removing;
          if (target === null) return;
          latch(() =>
            remove.mutateAsync({ workspaceId, databaseId: target.id }).then(
              () => {
                setRemoving(null);
                outcome.done(t("db.disconnected", { name: target.label }));
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

type Fields = { host: string; port: string; database: string; username: string };
const NO_FIELDS: Fields = { host: "", port: "5432", database: "", username: "" };

/** Connects a database. The string and the password live only in this dialog and leave with the one call. */
function AddDatabase({ workspaceId, onClose }: { workspaceId: string; onClose: () => void }) {
  const t = useMessages("control");
  const common = useMessages("common");
  const describe = useErrorMessage("control");
  const outcome = useOutcome();
  const latch = useLatch();
  const forget = useForgetOnLoss(workspaceId, READS);
  const [provider, setProvider] = useState<DatabaseProvider>("supabase");
  const [name, setName] = useState("");
  const [by, setBy] = useState<"url" | "fields">("url");
  const [url, setUrl] = useState("");
  const [fields, setFields] = useState<Fields>(NO_FIELDS);
  const [password, setPassword] = useState("");
  const [tls, setTls] = useState<Tls>("require");
  const connect = useApiMutation("createDatabase", {
    ...SECRET,
    invalidates: () => [{ method: "listDatabases" as const, args: { workspaceId } }],
  });
  const port = portOf(fields.port);
  const ready =
    by === "url"
      ? url.trim() !== ""
      : fields.host.trim() !== "" &&
        fields.database.trim() !== "" &&
        fields.username.trim() !== "" &&
        port !== null &&
        password !== "";
  const input = (): DatabaseConnectInput => ({
    provider,
    sslmode: tls,
    ...(name.trim() !== "" && { label: name.trim() }),
    ...(by === "url"
      ? { url: url.trim(), ...(password !== "" && { password }) }
      : {
          host: fields.host.trim(),
          port: port ?? 5432,
          database: fields.database.trim(),
          username: fields.username.trim(),
          password,
        }),
  });
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !connect.isPending) onClose();
      }}
    >
      <DialogContent
        size="lg"
        closeLabel={common("action.close")}
        title={t("db.addTitle")}
        description={t("db.addLead")}
      >
        <form
          className="section-form"
          aria-label={t("db.addTitle")}
          onSubmit={(event) => {
            event.preventDefault();
            if (!ready) return;
            latch(() =>
              connect.mutateAsync({ workspaceId, body: input() }).then(
                (created) => {
                  setUrl("");
                  setPassword("");
                  connect.reset();
                  outcome.done(t("db.connected", { name: created.label }));
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
          <div className="wire-pair">
            <Field label={t("db.providerLabel")}>
              <Select
                value={provider}
                disabled={connect.isPending}
                onValueChange={(next) => {
                  const found = PROVIDERS.find((each) => each === next);
                  if (found !== undefined) setProvider(found);
                }}
              >
                {PROVIDERS.map((each) => (
                  <SelectItem key={each} value={each}>
                    {t(`db.provider.${each}`)}
                  </SelectItem>
                ))}
              </Select>
            </Field>
            <Field label={t("db.name")} hint={t("db.nameHint")}>
              <Input
                value={name}
                maxLength={LIMIT.name}
                disabled={connect.isPending}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
          </div>
          <Field label={t("db.by")}>
            <RadioGroup
              value={by}
              disabled={connect.isPending}
              onValueChange={(next) => {
                // A connection on its way keeps its form: its answer still has to arrive and say how it went.
                if (connect.isPending) return;
                setBy(next === "fields" ? "fields" : "url");
                // What was typed for one way never goes with the other.
                setUrl("");
                setPassword("");
                connect.reset();
              }}
            >
              <Radio value="url" label={t("db.byUrl")} hint={t("db.byUrlHint")} />
              <Radio value="fields" label={t("db.byFields")} hint={t("db.byFieldsHint")} />
            </RadioGroup>
          </Field>
          {by === "url" ? (
            <>
              <Field label={t("db.url")} hint={t("db.urlHint")} required>
                <Input
                  type="password"
                  value={url}
                  maxLength={LIMIT.url}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="postgres://"
                  disabled={connect.isPending}
                  onChange={(event) => setUrl(event.target.value)}
                />
              </Field>
              <Field label={t("db.password")} hint={t("db.passwordApart")}>
                <Input
                  type="password"
                  value={password}
                  maxLength={LIMIT.password}
                  autoComplete="new-password"
                  disabled={connect.isPending}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </Field>
            </>
          ) : (
            <div className="wire-pair">
              <Field label={t("db.host")} required>
                <Input
                  value={fields.host}
                  maxLength={LIMIT.host}
                  autoComplete="off"
                  disabled={connect.isPending}
                  onChange={(event) => setFields({ ...fields, host: event.target.value })}
                />
              </Field>
              <Field
                label={t("db.port")}
                error={fields.port.trim() !== "" && port === null ? t("wire.portInvalid") : undefined}
                required
              >
                <Input
                  value={fields.port}
                  inputMode="numeric"
                  maxLength={5}
                  disabled={connect.isPending}
                  onChange={(event) => setFields({ ...fields, port: event.target.value })}
                />
              </Field>
              <Field label={t("db.database")} required>
                <Input
                  value={fields.database}
                  maxLength={LIMIT.name}
                  autoComplete="off"
                  disabled={connect.isPending}
                  onChange={(event) => setFields({ ...fields, database: event.target.value })}
                />
              </Field>
              <Field label={t("db.username")} required>
                <Input
                  value={fields.username}
                  maxLength={LIMIT.name}
                  autoComplete="off"
                  disabled={connect.isPending}
                  onChange={(event) => setFields({ ...fields, username: event.target.value })}
                />
              </Field>
              <Field label={t("db.password")} required>
                <Input
                  type="password"
                  value={password}
                  maxLength={LIMIT.password}
                  autoComplete="new-password"
                  disabled={connect.isPending}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </Field>
            </div>
          )}
          <Field label={t("db.tls")} hint={t(by === "url" ? "db.tlsUrlHint" : "db.tlsHint")}>
            <Select
              value={tls}
              disabled={connect.isPending}
              onValueChange={(next) => {
                const found = TLS.find((each) => each === next);
                if (found !== undefined) setTls(found);
              }}
            >
              {TLS.map((each) => (
                <SelectItem key={each} value={each}>
                  {t(`db.tlsMode.${each}`)}
                </SelectItem>
              ))}
            </Select>
          </Field>
          {connect.isError && !isLost(connect.error) && (
            <Callout tone="danger" role="alert">
              {describe(connect.error)}
            </Callout>
          )}
          <div className="section-form__actions">
            <Button variant="ghost" disabled={connect.isPending} onClick={onClose}>
              {common("action.cancel")}
            </Button>
            <Button type="submit" variant="primary" disabled={!ready} loading={connect.isPending}>
              {t("db.connect")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** The connection's name, a new password (needed after the database stopped accepting it), and what agents may ask. */
function EditDatabase({
  workspaceId,
  connection,
  onClose,
}: {
  workspaceId: string;
  connection: DatabaseConnection;
  onClose: () => void;
}) {
  const t = useMessages("control");
  const common = useMessages("common");
  const describe = useErrorMessage("control");
  const outcome = useOutcome();
  const latch = useLatch();
  const forget = useForgetOnLoss(workspaceId, READS);
  const [name, setName] = useState(connection.label);
  const [password, setPassword] = useState("");
  const [off, setOff] = useState<ReadonlySet<string>>(() => new Set(connection.disabledActions));
  const save = useApiMutation("updateDatabase", {
    ...SECRET,
    invalidates: () => [{ method: "listDatabases" as const, args: { workspaceId } }],
  });
  const renewing = connection.status === "reauth_required";
  const ready = name.trim() !== "" && (!renewing || password !== "");
  const toggle = (action: DbAction, allowed: boolean) => {
    const next = new Set(off);
    if (allowed) next.delete(action);
    else next.add(action);
    setOff(next);
  };
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !save.isPending) onClose();
      }}
    >
      <DialogContent
        size="md"
        closeLabel={common("action.close")}
        title={connection.label}
        description={t("db.editLead")}
      >
        <form
          className="section-form"
          aria-label={t("db.editNamed", { name: connection.label })}
          onSubmit={(event) => {
            event.preventDefault();
            if (!ready) return;
            latch(() =>
              save
                .mutateAsync({
                  workspaceId,
                  databaseId: connection.id,
                  body: {
                    ...(name.trim() !== connection.label && { label: name.trim() }),
                    disabledActions: DB_ACTIONS.filter((action) => off.has(action)),
                    ...(password !== "" && { password }),
                  },
                })
                .then(
                  (saved) => {
                    setPassword("");
                    save.reset();
                    outcome.done(t(password !== "" ? "db.renewed" : "db.saved", { name: saved.label }));
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
              {t("db.renewNeeded")}
            </Callout>
          )}
          <Field label={t("db.name")} required>
            <Input
              value={name}
              maxLength={LIMIT.name}
              disabled={save.isPending}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          <Field
            label={t("db.newPassword")}
            hint={renewing ? undefined : t("db.newPasswordHint")}
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
          <fieldset className="wire-rules">
            <legend className="page__heading">{t("db.allowed")}</legend>
            {DB_ACTIONS.map((action) => (
              <Checkbox
                key={action}
                checked={!off.has(action)}
                disabled={save.isPending}
                onCheckedChange={(checked) => toggle(action, checked === true)}
                label={t(`db.action.${action}`)}
              />
            ))}
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
              {t("db.save")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
