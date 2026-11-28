// The workspace's mailboxes, databases and GitHub repositories, as far as one agent may use them: on its
// Access tab, under what it reaches. A mailbox is read only or read and write, with the senders and
// folders it may read, the recipients it may write to, how many messages a day, whether it may send
// to those recipients without asking and whether it may delete. A database is read only, with the
// tables it may query, the columns it never sees and a daily query limit. Everyone in the workspace reads
// these; whoever manages agents changes them. The mailboxes and databases themselves are connected in
// the workspace settings.
//
// Each form keeps only what the person changed, over what the server has now: a refresh while they type
// shows the others' changes in the fields they left alone and keeps theirs. A save reads the agent's
// setting fresh and sends the changed fields only (the server keeps the rest), so it never puts back what
// someone else saved meanwhile.
import { useQueryClient } from "@tanstack/react-query";
import { isApiError, type MethodName } from "@vanr/client";
import { prefixKey, useApiMutation, useApiQuery, useVanrClient } from "@vanr/client/react";
import type {
  AgentDatabase,
  AgentDetail,
  AgentMailbox,
  DatabaseConnection,
  MailAccount,
  MailLevel,
} from "@vanr/contract";
import {
  Button,
  Callout,
  Checkbox,
  EmptyState,
  Field,
  Input,
  Radio,
  RadioGroup,
  Select,
  SelectItem,
  Textarea,
} from "@vanr/ui";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useErrorMessage } from "../../app/screens.tsx";
import { useMessages } from "../../i18n/react.tsx";
import { useForgetOnLoss, useOneChange } from "../control/connections/shared.tsx";
import { readLimit } from "../work/limits.ts";
import { type AgentRights, PartError, PartLoading, Section, useOutcome } from "./shared.tsx";
import { tableName } from "./table-name.ts";

type Props = { agent: AgentDetail; workspaceId: string; rights: AgentRights };

// The server's limits (integrations/mail-rules.ts policyInput, integrations/databases.ts databasePolicyInput,
// routes/connectors.ts for repositories).
export const POLICY = {
  addresses: 200,
  addressChars: 254,
  folders: 50,
  folderChars: 200,
  lookback: { min: 1, max: 3650, step: 1 },
  sends: { min: 0, max: 1000, step: 1 },
  queries: { min: 1, max: 100_000, step: 1 },
  columns: 1000,
  repositories: 200,
} as const;
const MAIL_LEVELS = ["none", "read", "read_write"] as const satisfies readonly MailLevel[];
const TIMEOUTS = [15, 30, 60] as const;
const ADDRESS = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/;
const DOMAIN = /^@[^\s@,;<>"]+\.[^\s@,;<>"]+$/;

/** A list typed one per line (and, for addresses, separated by commas), trimmed, without blanks or repeats. */
export const listOf = (text: string, commas = false) => [
  ...new Set(
    text
      .split(commas ? /[\n,]+/ : /\n+/)
      .map((each) => each.trim())
      .filter((each) => each !== ""),
  ),
];

/** The first entry that is not an address or an @domain, or undefined when every one is. */
export const badAddress = (list: readonly string[]) =>
  list.find((each) => each.length > POLICY.addressChars || !(ADDRESS.test(each) || DOMAIN.test(each)));

/** A whole number typed in a field, inside its bounds; the empty text is `empty`. */
function countOf<E>(
  text: string,
  bounds: { min: number; max: number; step: 1 },
  empty: E,
): number | E | undefined {
  return text.trim() === "" ? empty : readLimit(text, bounds, ".");
}

/**
 * The fields of a form as the person sees them: what they changed (their picks) over what the server has
 * now. A pick set back to the server's value is no change any more.
 */
function usePicks<F extends Record<string, unknown>>(server: F) {
  const [picks, setPicks] = useState<Partial<F>>({});
  const shown: F = { ...server, ...picks };
  const pick = <K extends keyof F>(key: K, value: F[K]) =>
    setPicks((before) => {
      const next = { ...before };
      if (Object.is(value, server[key])) delete next[key];
      else next[key] = value;
      return next;
    });
  /** Keeps a value as the person's own even if it equals what the screen shows as saved now. */
  const keep = <K extends keyof F>(key: K, value: F[K]) =>
    setPicks((before) => ({ ...before, [key]: value }));
  return { shown, picks, pick, keep, clear: () => setPicks({}) };
}

/** A set as the person sees it: the server's entries with the ones they ticked or unticked. */
function useToggles(server: readonly string[]) {
  const [toggles, setToggles] = useState<ReadonlyMap<string, boolean>>(new Map());
  const over = (base: readonly string[]) => {
    const next = new Set(base);
    for (const [entry, on] of toggles) {
      if (on) next.add(entry);
      else next.delete(entry);
    }
    return next;
  };
  const toggle = (entry: string, on: boolean) =>
    setToggles((before) => {
      const next = new Map(before);
      if (server.includes(entry) === on) next.delete(entry);
      else next.set(entry, on);
      return next;
    });
  /** Keeps these entries ticked as the person's own, whatever the saved list becomes. */
  const keep = (entries: Iterable<string>) => setToggles(new Map([...entries].map((entry) => [entry, true])));
  return {
    shown: over(server),
    over,
    changed: toggles.size > 0,
    toggle,
    keep,
    clear: () => setToggles(new Map()),
  };
}

/**
 * How one of these saves fails: the error shows on the form; a mailbox, database or agent that is gone
 * (404, or 403 when it is no longer the person's) drops what the screen kept, and an archived agent loads
 * the agent and these reads again, so the form stops offering what can't be saved.
 */
function useSaveFailure(workspaceId: string, reads: readonly MethodName[]) {
  const client = useVanrClient();
  const queryClient = useQueryClient();
  const forget = useForgetOnLoss(workspaceId, reads);
  const [error, setError] = useState<unknown>(null);
  return {
    error,
    clear: () => setError(null),
    /** Loads these reads again. */
    reload: () =>
      Promise.all(
        reads.map((method) =>
          queryClient.invalidateQueries({ queryKey: prefixKey(client, { method, args: { workspaceId } }) }),
        ),
      ),
    failed: (failure: unknown) => {
      setError(failure);
      forget(failure);
      if (isApiError(failure) && failure.status === 409 && failure.code === "agent.archived")
        for (const method of ["getAgent", "listAgents", ...reads] as const)
          void queryClient.invalidateQueries({
            queryKey: prefixKey(client, { method, args: { workspaceId } }),
          });
    },
  };
}

export function Sources(props: Props) {
  const t = useMessages("agents");
  return (
    <>
      <Section title={t("mbx.title")} help={t("mbx.help")}>
        <Mailboxes {...props} />
      </Section>
      <Section title={t("dbx.title")} help={t("dbx.help")}>
        <Databases {...props} />
      </Section>
      <Section title={t("repo.title")} help={t("repo.help")}>
        <Repositories {...props} />
      </Section>
    </>
  );
}

/* ---------- mailboxes ---------- */

const MAIL_READS = ["getAgentMail", "listMailAccounts"] as const;

function Mailboxes({ agent, workspaceId, rights }: Props) {
  const t = useMessages("agents");
  const accounts = useApiQuery("listMailAccounts", { workspaceId });
  const boxes = useApiQuery("getAgentMail", { workspaceId, agentId: agent.id });
  if (accounts.isPending || boxes.isPending) return <PartLoading />;
  if (accounts.isError || boxes.isError)
    return (
      <PartError
        title={t("mbx.failed")}
        error={accounts.error ?? boxes.error}
        onRetry={() => void Promise.all([accounts.refetch(), boxes.refetch()])}
      />
    );
  // A mailbox whose sign-in hasn't come back yet isn't offered.
  const usable = accounts.data.filter((account) => account.status !== "pending");
  if (usable.length === 0) return <EmptyState title={t("mbx.none")} description={t("mbx.noneBody")} />;
  return (
    <ul className="source-list" aria-label={t("mbx.title")}>
      {usable.map((account) => (
        <MailboxForm
          key={`${workspaceId}/${agent.id}/${account.id}`}
          workspaceId={workspaceId}
          agentId={agent.id}
          account={account}
          box={boxes.data.find((each) => each.accountId === account.id)}
          edit={rights.editAll}
        />
      ))}
    </ul>
  );
}

/** A mailbox's settings as its form shows them. */
const mailFields = (box: AgentMailbox | undefined) => ({
  level: box?.level ?? ("none" as MailLevel),
  senders: (box?.policy.senderAllowlist ?? []).join("\n"),
  folders: (box?.policy.folders ?? []).join("\n"),
  lookback: box?.policy.lookbackDays == null ? "" : String(box.policy.lookbackDays),
  recipients: (box?.policy.recipientAllowlist ?? []).join("\n"),
  sends: String(box?.policy.sendsPerDay ?? 25),
  autoSend: box?.policy.autoSend ?? false,
  deletable: box?.deletable ?? false,
});

function MailboxForm({
  workspaceId,
  agentId,
  account,
  box,
  edit,
}: {
  workspaceId: string;
  agentId: string;
  account: MailAccount;
  box: AgentMailbox | undefined;
  edit: boolean;
}) {
  const t = useMessages("agents");
  const describe = useErrorMessage("agents");
  const outcome = useOutcome();
  const client = useVanrClient();
  const change = useOneChange();
  const failure = useSaveFailure(workspaceId, MAIL_READS);
  const form = usePicks(mailFields(box));
  const { level, senders, folders, lookback, recipients, sends, autoSend, deletable } = form.shown;
  const save = useApiMutation("replaceAgentMail", {
    invalidates: () => [
      { method: "getAgentMail" as const, args: { workspaceId, agentId } },
      { method: "listMailAccounts" as const, args: { workspaceId } },
    ],
  });
  const reading = level !== "none";
  const writing = level === "read_write";
  const senderList = listOf(senders, true);
  const folderList = listOf(folders);
  const recipientList = listOf(recipients, true);
  const lookbackDays = countOf(lookback, POLICY.lookback, null);
  const sendsPerDay = countOf(sends, POLICY.sends, undefined);
  const problems = {
    senders: reading
      ? senderList.length > POLICY.addresses
        ? t("mbx.tooMany", { max: POLICY.addresses })
        : badAddress(senderList) !== undefined
          ? t("mbx.badAddress", { entry: badAddress(senderList) ?? "" })
          : undefined
      : undefined,
    folders:
      reading &&
      (folderList.length > POLICY.folders || folderList.some((each) => each.length > POLICY.folderChars))
        ? t("mbx.badFolders", { max: POLICY.folders, chars: POLICY.folderChars })
        : undefined,
    lookback: reading && lookbackDays === undefined ? t("mbx.badLookback", POLICY.lookback) : undefined,
    recipients: writing
      ? recipientList.length > POLICY.addresses
        ? t("mbx.tooMany", { max: POLICY.addresses })
        : badAddress(recipientList) !== undefined
          ? t("mbx.badAddress", { entry: badAddress(recipientList) ?? "" })
          : undefined
      : undefined,
    sends: writing && sendsPerDay === undefined ? t("mbx.badSends", POLICY.sends) : undefined,
  };
  const invalid = Object.values(problems).some((each) => each !== undefined);
  // The server turns "send without asking" off when no recipient is allowed (mail-rules.ts).
  const noRecipients = recipientList.length === 0;
  const locked = !edit || change.busy;
  const { picks } = form;
  const submit = () =>
    change.run(async () => {
      failure.clear();
      try {
        const fresh = (await client.call("getAgentMail", { workspaceId, agentId })).find(
          (each) => each.accountId === account.id,
        );
        const saving = picks.level ?? fresh?.level ?? "none";
        const reads = saving !== "none";
        const writes = saving === "read_write";
        const policy = {
          ...(reads && picks.senders !== undefined && { senderAllowlist: senderList }),
          ...(reads && picks.folders !== undefined && { folders: folderList }),
          ...(reads && picks.lookback !== undefined && { lookbackDays: lookbackDays ?? null }),
          ...(writes && picks.recipients !== undefined && { recipientAllowlist: recipientList }),
          ...(writes && picks.sends !== undefined && { sendsPerDay: sendsPerDay ?? 0 }),
          ...(writes && picks.autoSend !== undefined && { autoSend: autoSend && !noRecipients }),
        };
        await save.mutateAsync({
          workspaceId,
          agentId,
          mailId: account.id,
          body: {
            level: saving,
            ...(writes && picks.deletable !== undefined && { deletable }),
            ...(Object.keys(policy).length > 0 && { policy }),
          },
        });
        form.clear();
        outcome.done(t("mbx.saved", { address: account.address }));
      } catch (error) {
        failure.failed(error);
      }
    });
  return (
    <li className="source">
      <form
        className="section-form"
        aria-label={
          account.label === account.address ? account.address : `${account.label} (${account.address})`
        }
        aria-busy={change.busy}
        onFocusCapture={change.onFocusCapture}
        onSubmit={(event) => {
          event.preventDefault();
          if (edit && !invalid) submit();
        }}
      >
        <div className="source__head">
          <div className="source__who">
            <strong>{account.label}</strong>
            {account.label !== account.address && <span className="page__muted">{account.address}</span>}
          </div>
          <Select
            size="sm"
            value={level}
            disabled={locked}
            aria-label={t("mbx.levelFor", { address: account.address })}
            onValueChange={(next) => form.pick("level", MAIL_LEVELS.find((each) => each === next) ?? "none")}
          >
            {MAIL_LEVELS.map((each) => (
              <SelectItem key={each} value={each}>
                {t(`mbx.level.${each}`)}
              </SelectItem>
            ))}
          </Select>
        </div>
        {reading && (
          <div className="source__grid">
            <Field label={t("mbx.senders")} hint={t("mbx.sendersHint")} error={problems.senders}>
              <Textarea
                rows={2}
                value={senders}
                disabled={locked}
                onChange={(e) => form.pick("senders", e.target.value)}
              />
            </Field>
            <Field label={t("mbx.folders")} hint={t("mbx.foldersHint")} error={problems.folders}>
              <Textarea
                rows={2}
                value={folders}
                disabled={locked}
                onChange={(e) => form.pick("folders", e.target.value)}
              />
            </Field>
            <Field label={t("mbx.lookback")} hint={t("mbx.lookbackHint")} error={problems.lookback}>
              <Input
                inputMode="numeric"
                value={lookback}
                disabled={locked}
                onChange={(e) => form.pick("lookback", e.target.value)}
              />
            </Field>
            {writing && (
              <>
                <Field label={t("mbx.recipients")} hint={t("mbx.recipientsHint")} error={problems.recipients}>
                  <Textarea
                    rows={2}
                    value={recipients}
                    disabled={locked}
                    onChange={(e) => form.pick("recipients", e.target.value)}
                  />
                </Field>
                <Field label={t("mbx.sends")} hint={t("mbx.sendsHint")} error={problems.sends}>
                  <Input
                    inputMode="numeric"
                    value={sends}
                    disabled={locked}
                    onChange={(e) => form.pick("sends", e.target.value)}
                  />
                </Field>
              </>
            )}
          </div>
        )}
        {writing && (
          <div className="source__checks">
            <Checkbox
              checked={autoSend && !noRecipients}
              disabled={locked || noRecipients}
              label={t("mbx.autoSend")}
              hint={noRecipients ? t("mbx.autoSendNeedsList") : t("mbx.autoSendHint")}
              onCheckedChange={(on) => form.pick("autoSend", on === true)}
            />
            <Checkbox
              checked={deletable}
              disabled={locked}
              label={t("mbx.deletable")}
              hint={t("mbx.deletableHint")}
              onCheckedChange={(on) => form.pick("deletable", on === true)}
            />
          </div>
        )}
        {failure.error !== null && (
          <Callout tone="danger" role="alert">
            {describe(failure.error)}
          </Callout>
        )}
        {edit && (
          <div className="section-form__actions">
            <Button type="submit" size="sm" variant="primary" disabled={invalid} loading={change.busy}>
              {t("mbx.save")}
            </Button>
          </div>
        )}
      </form>
    </li>
  );
}

/* ---------- databases ---------- */

const DATABASE_READS = ["listAgentDatabases", "listDatabases"] as const;

function Databases({ agent, workspaceId, rights }: Props) {
  const t = useMessages("agents");
  const connections = useApiQuery("listDatabases", { workspaceId });
  const links = useApiQuery("listAgentDatabases", { workspaceId, agentId: agent.id });
  if (connections.isPending || links.isPending) return <PartLoading />;
  if (connections.isError || links.isError)
    return (
      <PartError
        title={t("dbx.failed")}
        error={connections.error ?? links.error}
        onRetry={() => void Promise.all([connections.refetch(), links.refetch()])}
      />
    );
  if (connections.data.length === 0)
    return <EmptyState title={t("dbx.none")} description={t("dbx.noneBody")} />;
  return (
    <ul className="source-list" aria-label={t("dbx.title")}>
      {connections.data.map((connection) => (
        <DatabaseForm
          key={`${workspaceId}/${agent.id}/${connection.id}`}
          workspaceId={workspaceId}
          agentId={agent.id}
          connection={connection}
          link={links.data.find((each) => each.connectionId === connection.id)}
          edit={rights.editAll}
        />
      ))}
    </ul>
  );
}

/**
 * A link with no policy of its own: never saved, or saved at "none" before it ever read (the server keeps
 * that one empty). Its form shows the server's first-time defaults, and raising it sends them in full.
 */
const unset = (link: AgentDatabase | undefined) =>
  link === undefined ||
  (link.level === "none" &&
    link.policy.tables.length === 0 &&
    link.policy.maskedColumns.length === 0 &&
    link.policy.queriesPerDay === 200 &&
    link.policy.timeoutSeconds === 30);

/** A database link's settings as its form shows them (for an unset one, the server's first-time defaults). */
const databaseFields = (saved: AgentDatabase | undefined, connection: DatabaseConnection) => {
  const link = unset(saved) ? undefined : saved;
  return {
    reads: (saved?.level ?? "none") === "read",
    hidden: (link?.policy.maskedColumns ?? connection.hiddenSuggestion).join("\n"),
    queries:
      link === undefined
        ? "200"
        : link.policy.queriesPerDay === null
          ? ""
          : String(link.policy.queriesPerDay),
    timeout: (link?.policy.timeoutSeconds ?? 30) as (typeof TIMEOUTS)[number],
  };
};

function DatabaseForm({
  workspaceId,
  agentId,
  connection,
  link,
  edit,
}: {
  workspaceId: string;
  agentId: string;
  connection: DatabaseConnection;
  link: AgentDatabase | undefined;
  edit: boolean;
}) {
  const t = useMessages("agents");
  const describe = useErrorMessage("agents");
  const outcome = useOutcome();
  const client = useVanrClient();
  const change = useOneChange();
  const failure = useSaveFailure(workspaceId, DATABASE_READS);
  const [changedMeanwhile, setChangedMeanwhile] = useState(false);
  const form = usePicks(databaseFields(link, connection));
  const { reads, hidden, queries, timeout } = form.shown;
  // The list of tables reads the customer's database, so it is only asked of someone who may change this.
  const listed = useApiQuery(
    "listDatabaseTables",
    { workspaceId, databaseId: connection.id },
    { enabled: edit && reads && connection.status === "active" },
  );
  const save = useApiMutation("replaceAgentDatabase", {
    invalidates: () => [
      { method: "listAgentDatabases" as const, args: { workspaceId, agentId } },
      { method: "listDatabases" as const, args: { workspaceId } },
    ],
  });
  const columns = listOf(hidden);
  const queriesPerDay = countOf(queries, POLICY.queries, null);
  const problems = {
    hidden:
      reads && columns.length > POLICY.columns ? t("dbx.tooManyColumns", { max: POLICY.columns }) : undefined,
    queries: reads && queriesPerDay === undefined ? t("dbx.badQueries", POLICY.queries) : undefined,
  };
  const invalid = Object.values(problems).some((each) => each !== undefined);
  const locked = !edit || change.busy;
  const allTables = listed.data?.map(tableName) ?? [];
  // Before the first save, every table there is now is checked: the server's own default.
  const tables = useToggles(unset(link) ? allTables : (link?.policy.tables ?? []));
  // Saved tables the list no longer has (dropped, or past what the database lists) stay visible.
  const unlisted = unset(link) ? [] : (link?.policy.tables ?? []).filter((name) => !allTables.includes(name));
  const chosen = tables.shown;
  const refusedPassword = isApiError(listed.error) && listed.error.rawCode === "database.auth";
  let tablePicker: ReactNode;
  if (!edit) {
    tablePicker =
      link === undefined || link.policy.tables.length === 0 ? (
        <p className="page__muted">{t("dbx.noTables")}</p>
      ) : (
        <ul className="source__tags" aria-label={t("dbx.tables")}>
          {link.policy.tables.map((name) => (
            <li key={name}>
              <code>{name}</code>
            </li>
          ))}
        </ul>
      );
  } else if (connection.status !== "active" || refusedPassword) {
    tablePicker = <p className="wire-row__note">{t("dbx.needsRenew")}</p>;
  } else if (listed.isPending) tablePicker = <PartLoading />;
  else if (listed.isError)
    tablePicker = (
      <PartError title={t("dbx.tablesFailed")} error={listed.error} onRetry={() => void listed.refetch()} />
    );
  else if (allTables.length === 0 && unlisted.length === 0)
    tablePicker = <p className="page__muted">{t("dbx.noTablesThere")}</p>;
  else
    tablePicker = (
      <ul className="source__tables" aria-label={t("dbx.tables")}>
        {[...allTables, ...unlisted].map((name) => (
          <li key={name}>
            <Checkbox
              checked={chosen.has(name)}
              disabled={locked}
              label={
                <>
                  <code>{name}</code>
                  {!allTables.includes(name) && <span className="page__muted"> {t("dbx.notListed")}</span>}
                </>
              }
              onCheckedChange={(on) => tables.toggle(name, on === true)}
            />
          </li>
        ))}
      </ul>
    );
  // The list is needed for a first save (the server takes every table there is) or for ticked tables;
  // a saved link whose tables stay as they are saves without it, even while the database is down.
  const tablesReady = !edit || !reads || listed.isSuccess || (!unset(link) && !tables.changed);
  const { picks } = form;
  const submit = () =>
    change.run(async () => {
      failure.clear();
      setChangedMeanwhile(false);
      try {
        const fresh = (await client.call("listAgentDatabases", { workspaceId, agentId })).find(
          (each) => each.connectionId === connection.id,
        );
        const reading = picks.reads ?? fresh?.level === "read";
        // A link with no policy yet gets the whole form; the server would otherwise keep an empty one.
        // The form was built for a link with a setup of its own, or without one. If that changed meanwhile,
        // what the person sees is not what a save would keep: nothing is sent, and the form loads again.
        if (reading && unset(link) !== unset(fresh)) {
          setChangedMeanwhile(true);
          await failure.reload();
          return;
        }
        const whole = unset(fresh);
        const policy = whole
          ? {
              maskedColumns: columns,
              queriesPerDay: queriesPerDay ?? null,
              timeoutSeconds: timeout,
              ...(listed.isSuccess && { tables: [...tables.over(allTables)] }),
            }
          : {
              ...(picks.hidden !== undefined && { maskedColumns: columns }),
              ...(picks.queries !== undefined && { queriesPerDay: queriesPerDay ?? null }),
              ...(picks.timeout !== undefined && { timeoutSeconds: timeout }),
              // Over the tables saved now (or, the first time, every table there is); only once the list is
              // known, and only when the person ticked some: otherwise the saved ones stay.
              ...(listed.isSuccess &&
                tables.changed && { tables: [...tables.over(fresh?.policy.tables ?? [])] }),
            };
        await save.mutateAsync({
          workspaceId,
          agentId,
          databaseId: connection.id,
          body: {
            level: reading ? "read" : "none",
            ...(reading && Object.keys(policy).length > 0 && { policy }),
          },
        });
        form.clear();
        tables.clear();
        outcome.done(t("dbx.saved", { name: connection.label }));
      } catch (error) {
        failure.failed(error);
      }
    });
  return (
    <li className="source">
      <form
        className="section-form"
        aria-label={connection.label}
        aria-busy={change.busy}
        onFocusCapture={change.onFocusCapture}
        onSubmit={(event) => {
          event.preventDefault();
          if (edit && !invalid) submit();
        }}
      >
        <div className="source__head">
          <div className="source__who">
            <strong>{connection.label}</strong>
            <span className="page__muted">{`${connection.username}@${connection.host}/${connection.database}`}</span>
          </div>
          <Checkbox
            checked={reads}
            disabled={locked}
            label={t("dbx.reads")}
            aria-label={t("dbx.readsFor", { name: connection.label })}
            onCheckedChange={(on) => form.pick("reads", on === true)}
          />
        </div>
        {reads && (
          <>
            <fieldset className="source__fieldset">
              <legend>{t("dbx.tables")}</legend>
              {tablePicker}
            </fieldset>
            <div className="source__grid">
              <Field label={t("dbx.hidden")} hint={t("dbx.hiddenHint")} error={problems.hidden}>
                <Textarea
                  rows={3}
                  value={hidden}
                  disabled={locked}
                  onChange={(e) => form.pick("hidden", e.target.value)}
                />
              </Field>
              <Field label={t("dbx.queries")} hint={t("dbx.queriesHint")} error={problems.queries}>
                <Input
                  inputMode="numeric"
                  value={queries}
                  disabled={locked}
                  onChange={(e) => form.pick("queries", e.target.value)}
                />
              </Field>
              <Field label={t("dbx.timeout")}>
                <Select
                  size="sm"
                  value={String(timeout)}
                  disabled={locked}
                  onValueChange={(next) =>
                    form.pick("timeout", TIMEOUTS.find((each) => String(each) === next) ?? 30)
                  }
                >
                  {TIMEOUTS.map((each) => (
                    <SelectItem key={each} value={String(each)}>
                      {t("dbx.seconds", { count: each })}
                    </SelectItem>
                  ))}
                </Select>
              </Field>
            </div>
          </>
        )}
        {reads && edit && link !== undefined && unset(link) && (
          <Callout tone="info" role="status">
            {t("dbx.suggested")}
          </Callout>
        )}
        {changedMeanwhile && (
          <Callout tone="warning" role="status">
            {t("dbx.changedMeanwhile")}
          </Callout>
        )}
        {failure.error !== null && (
          <Callout tone="danger" role="alert">
            {describe(failure.error)}
          </Callout>
        )}
        {edit && (
          <div className="section-form__actions">
            <Button
              type="submit"
              size="sm"
              variant="primary"
              disabled={invalid || !tablesReady}
              loading={change.busy}
            >
              {t("dbx.save")}
            </Button>
          </div>
        )}
      </form>
    </li>
  );
}

/* ---------- GitHub repositories ---------- */

const REPOSITORY_READS = ["listAgentRepositories"] as const;

function Repositories({ agent, workspaceId, rights }: Props) {
  const t = useMessages("agents");
  const saved = useApiQuery("listAgentRepositories", { workspaceId, agentId: agent.id });
  const available = useApiQuery("listGithubRepositories", { workspaceId });
  if (saved.isPending || available.isPending) return <PartLoading />;
  if (saved.isError || available.isError)
    return (
      <PartError
        title={t("repo.failed")}
        error={saved.error ?? available.error}
        onRetry={() => void Promise.all([saved.refetch(), available.refetch()])}
      />
    );
  if (!available.data.connected && saved.data.length === 0)
    return <EmptyState title={t("repo.none")} description={t("repo.noneBody")} />;
  return (
    <RepositoryForm
      key={`${workspaceId}/${agent.id}`}
      workspaceId={workspaceId}
      agentId={agent.id}
      saved={saved.data}
      accounts={available.data.accounts}
      edit={rights.editAll}
    />
  );
}

type RepoScope = "all" | "some";
/** How the server reads an agent's list (github-app.ts repoRefusal): empty is no limit at all. */
const scopeOf = (list: readonly string[]): RepoScope => (list.length === 0 ? "all" : "some");

function RepositoryForm({
  workspaceId,
  agentId,
  saved,
  accounts,
  edit,
}: {
  workspaceId: string;
  agentId: string;
  saved: string[];
  accounts: { login: string; repositories: { fullName: string; private: boolean }[] }[];
  edit: boolean;
}) {
  const t = useMessages("agents");
  const describe = useErrorMessage("agents");
  const outcome = useOutcome();
  const client = useVanrClient();
  const change = useOneChange();
  const failure = useSaveFailure(workspaceId, REPOSITORY_READS);
  // An empty list reaches every repository, so it is a choice of its own ("no limit"), never what is left
  // after unticking: the web never turns a narrowing into a widening.
  const savedScope = scopeOf(saved);
  const form = usePicks({ scope: savedScope });
  const scope = form.shown.scope;
  const picked = useToggles(savedScope === "some" ? saved : []);
  const chosen = picked.shown;
  const [notice, setNotice] = useState<"keepOne" | "becameAll" | "becameSome" | null>(null);
  const save = useApiMutation("setAgentRepositories", {
    invalidates: () => [{ method: "listAgentRepositories" as const, args: { workspaceId, agentId } }],
  });
  const known = new Set(
    accounts.flatMap((account) => [`${account.login}/*`, ...account.repositories.map((r) => r.fullName)]),
  );
  // Entries GitHub no longer lists (saved, or kept from the person's ticks) stay visible, so a save never
  // sends or drops them unseen.
  const elsewhere = [...new Set([...saved, ...(scope === "some" ? chosen : [])])].filter(
    (entry) => !known.has(entry),
  );
  const locked = !edit || change.busy;
  const limited = scope === "some";
  // "No limit" set by someone else while the person has ticks on screen: their ticks stay, as their own
  // choice, with a word on what changed; nothing reaches every repository without them choosing it.
  const pending = picked.changed || form.picks.scope !== undefined;
  const before = useRef({ savedScope, limited, pending, chosen });
  useEffect(() => {
    const was = before.current;
    if (was.savedScope === "some" && savedScope === "all" && was.limited && was.pending) {
      form.keep("scope", "some");
      picked.keep(was.chosen);
      setNotice("becameAll");
    }
  });
  useEffect(() => {
    before.current = { savedScope, limited, pending, chosen };
  });
  const tooMany = limited && chosen.size > POLICY.repositories;
  const empty = limited && chosen.size === 0;
  const toggle = (entry: string, on: boolean) => {
    // Unticking the last one would save an empty list, which reaches everything.
    if (!on && chosen.size === 1 && chosen.has(entry)) {
      setNotice("keepOne");
      return;
    }
    setNotice(null);
    picked.toggle(entry, on);
  };
  const box = (entry: string, label: ReactNode, under?: string) => (
    <li key={entry}>
      <Checkbox
        checked={!limited || chosen.has(entry) || (under !== undefined && chosen.has(under))}
        disabled={locked || !limited || (under !== undefined && chosen.has(under))}
        label={label}
        onCheckedChange={(on) => toggle(entry, on === true)}
      />
    </li>
  );
  const submit = () =>
    change.run(async () => {
      failure.clear();
      try {
        const fresh = await client.call("listAgentRepositories", { workspaceId, agentId });
        let repositories: string[] = [];
        if (!limited && form.picks.scope !== "all" && scopeOf(fresh) === "some") {
          // The form showed no limit only because that was saved; someone has limited it since. Taking
          // their limit away needs the person to choose "no limit" themselves.
          setNotice("becameSome");
          await failure.reload();
          return;
        }
        if (!limited && form.picks.scope === undefined) {
          // Nothing changed and no limit is what is saved: nothing is written, so a limit someone saves
          // between this read and a write can't be undone by it.
          outcome.done(t("repo.saved"));
          return;
        }
        if (limited) {
          // Someone set "no limit" meanwhile: the person's ticks stay on screen as their own choice, and
          // nothing is sent until they save again or pick "no limit" too.
          if (savedScope === "some" && scopeOf(fresh) === "all") {
            form.keep("scope", "some");
            picked.keep(chosen);
            setNotice("becameAll");
            await failure.reload();
            return;
          }
          // Narrowing from no limit while someone else set a limit: their limit joins the person's ticks on
          // screen, and nothing is sent until the person has seen both and saves again.
          if (savedScope === "all" && scopeOf(fresh) === "some") {
            setNotice("becameSome");
            await failure.reload();
            return;
          }
          // The person's ticks over the repositories saved now, not over the ones this screen loaded with.
          repositories = [...picked.over(scopeOf(fresh) === "some" ? fresh : [])];
          if (repositories.length === 0) {
            setNotice("keepOne");
            await failure.reload();
            return;
          }
        }
        // More than the server keeps is its refusal to give, not a cut made here.
        await save.mutateAsync({ workspaceId, agentId, body: { repositories } });
        form.clear();
        picked.clear();
        setNotice(null);
        outcome.done(t("repo.saved"));
      } catch (error) {
        failure.failed(error);
      }
    });
  return (
    <form
      className="section-form"
      aria-label={t("repo.title")}
      aria-busy={change.busy}
      onFocusCapture={change.onFocusCapture}
      onSubmit={(event) => {
        event.preventDefault();
        if (edit && !tooMany && !empty) submit();
      }}
    >
      <RadioGroup
        aria-label={t("repo.scope")}
        value={scope}
        disabled={locked}
        onValueChange={(next) => {
          setNotice(null);
          form.pick("scope", next === "all" ? "all" : "some");
        }}
      >
        <Radio value="all" label={t("repo.scopeAll")} hint={t("repo.scopeAllHint")} />
        <Radio value="some" label={t("repo.scopeSome")} />
      </RadioGroup>
      {accounts.map((account) => (
        <fieldset key={account.login} className="source__fieldset">
          <legend>{account.login}</legend>
          <ul className="source__tables">
            {box(`${account.login}/*`, t("repo.everyOf", { owner: account.login }))}
            {account.repositories.map((repository) =>
              box(
                repository.fullName,
                <>
                  <code>{repository.fullName}</code>
                  {repository.private && <span className="page__muted"> {t("repo.private")}</span>}
                </>,
                `${account.login}/*`,
              ),
            )}
          </ul>
        </fieldset>
      ))}
      {elsewhere.length > 0 && (
        <fieldset className="source__fieldset">
          <legend>{t("repo.elsewhere")}</legend>
          <ul className="source__tables">{elsewhere.map((entry) => box(entry, <code>{entry}</code>))}</ul>
        </fieldset>
      )}
      {(notice !== null || empty) && (
        <Callout tone={notice === "becameAll" || notice === "becameSome" ? "warning" : "info"} role="status">
          {t(
            notice === "becameAll"
              ? "repo.becameAll"
              : notice === "becameSome"
                ? "repo.becameSome"
                : "repo.keepOne",
          )}
        </Callout>
      )}
      {tooMany && (
        <Callout tone="danger" role="alert">
          {t("repo.tooMany", { max: POLICY.repositories, count: chosen.size })}
        </Callout>
      )}
      {failure.error !== null && (
        <Callout tone="danger" role="alert">
          {describe(failure.error)}
        </Callout>
      )}
      {edit && (
        <div className="section-form__actions">
          <Button type="submit" size="sm" variant="primary" disabled={tooMany || empty} loading={change.busy}>
            {t("repo.save")}
          </Button>
        </div>
      )}
    </form>
  );
}
