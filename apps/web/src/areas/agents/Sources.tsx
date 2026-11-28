// The workspace's mailboxes, databases and GitHub repositories, as far as one agent may use them: on its
// Access tab, under what it reaches. A mailbox is read only or read and write, with the senders and
// folders it may read, the recipients it may write to, how many messages a day, whether it may send
// to those recipients without asking and whether it may delete. A database is read only, with the
// tables it may query, the columns it never sees and a daily query limit. Everyone in the workspace reads
// these; whoever manages agents changes them. The mailboxes and databases themselves are connected in
// the workspace settings.
import { isApiError } from "@vanr/client";
import { useApiMutation, useApiQuery } from "@vanr/client/react";
import type {
  AgentDatabase,
  AgentDetail,
  AgentMailbox,
  DatabaseConnection,
  DatabaseTable,
  MailAccount,
  MailLevel,
} from "@vanr/contract";
import { Button, Callout, Checkbox, EmptyState, Field, Input, Select, SelectItem, Textarea } from "@vanr/ui";
import { type ReactNode, useState } from "react";
import { useErrorMessage } from "../../app/screens.tsx";
import { useMessages } from "../../i18n/react.tsx";
import { useLatch } from "../control/connections/shared.tsx";
import { readLimit } from "../work/limits.ts";
import { type AgentRights, PartError, PartLoading, Section, useOutcome } from "./shared.tsx";

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

/** A list typed one per line or separated by commas, trimmed, without blanks or repeats. */
export const listOf = (text: string) => [
  ...new Set(
    text
      .split(/[\n,]+/)
      .map((each) => each.trim())
      .filter((each) => each !== ""),
  ),
];

/** The first entry that is not an address or an @domain, or undefined when every one is. */
export const badAddress = (list: readonly string[]) =>
  list.find((each) => each.length > POLICY.addressChars || !(ADDRESS.test(each) || DOMAIN.test(each)));

/** A table as the server names it: each part quoted only when SQL needs it. */
const quoted = (name: string) => (/^[a-z_][a-z0-9_]*$/.test(name) ? name : `"${name.replace(/"/g, '""')}"`);
export const tableName = (table: DatabaseTable) => `${quoted(table.schema)}.${quoted(table.name)}`;

/** A whole number typed in a field, inside its bounds; the empty text is `empty`. */
function countOf<E>(
  text: string,
  bounds: { min: number; max: number; step: 1 },
  empty: E,
): number | E | undefined {
  return text.trim() === "" ? empty : readLimit(text, bounds, ".");
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
  const usable = accounts.data.filter((account) => account.status !== "pending");
  if (usable.length === 0) return <EmptyState title={t("mbx.none")} description={t("mbx.noneBody")} />;
  return (
    <ul className="source-list" aria-label={t("mbx.title")}>
      {usable.map((account) => {
        const box = boxes.data.find((each) => each.accountId === account.id);
        return (
          <MailboxForm
            // A save that changes what the server keeps starts the form over from its answer.
            key={`${workspaceId}/${account.id}/${JSON.stringify(box ?? null)}`}
            workspaceId={workspaceId}
            agentId={agent.id}
            account={account}
            box={box}
            edit={rights.editAll}
          />
        );
      })}
    </ul>
  );
}

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
  const latch = useLatch();
  const policy = box?.policy;
  const [level, setLevel] = useState<MailLevel>(box?.level ?? "none");
  const [senders, setSenders] = useState((policy?.senderAllowlist ?? []).join("\n"));
  const [folders, setFolders] = useState((policy?.folders ?? []).join("\n"));
  const [lookback, setLookback] = useState(policy?.lookbackDays == null ? "" : String(policy.lookbackDays));
  const [recipients, setRecipients] = useState((policy?.recipientAllowlist ?? []).join("\n"));
  const [sends, setSends] = useState(String(policy?.sendsPerDay ?? 25));
  const [autoSend, setAutoSend] = useState(policy?.autoSend ?? false);
  const [deletable, setDeletable] = useState(box?.deletable ?? false);
  const save = useApiMutation("replaceAgentMail", {
    invalidates: () => [
      { method: "getAgentMail" as const, args: { workspaceId, agentId } },
      { method: "listMailAccounts" as const, args: { workspaceId } },
    ],
  });
  const reading = level !== "none";
  const writing = level === "read_write";
  const senderList = listOf(senders);
  const folderList = listOf(folders);
  const recipientList = listOf(recipients);
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
  const locked = !edit || save.isPending;
  return (
    <li className="source">
      <form
        className="section-form"
        aria-label={
          account.label === account.address ? account.address : `${account.label} (${account.address})`
        }
        onSubmit={(event) => {
          event.preventDefault();
          if (!edit || invalid) return;
          latch(() =>
            save
              .mutateAsync({
                workspaceId,
                agentId,
                mailId: account.id,
                body: {
                  level,
                  ...(writing && { deletable }),
                  ...(reading && {
                    policy: {
                      senderAllowlist: senderList,
                      folders: folderList,
                      lookbackDays: lookbackDays ?? null,
                      ...(writing && {
                        recipientAllowlist: recipientList,
                        sendsPerDay: sendsPerDay ?? 0,
                        autoSend: autoSend && !noRecipients,
                      }),
                    },
                  }),
                },
              })
              .then(() => outcome.done(t("mbx.saved", { address: account.address }))),
          );
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
            onValueChange={(next) => setLevel(MAIL_LEVELS.find((each) => each === next) ?? "none")}
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
                onChange={(e) => setSenders(e.target.value)}
              />
            </Field>
            <Field label={t("mbx.folders")} hint={t("mbx.foldersHint")} error={problems.folders}>
              <Textarea
                rows={2}
                value={folders}
                disabled={locked}
                onChange={(e) => setFolders(e.target.value)}
              />
            </Field>
            <Field label={t("mbx.lookback")} hint={t("mbx.lookbackHint")} error={problems.lookback}>
              <Input
                inputMode="numeric"
                value={lookback}
                disabled={locked}
                onChange={(e) => setLookback(e.target.value)}
              />
            </Field>
            {writing && (
              <>
                <Field label={t("mbx.recipients")} hint={t("mbx.recipientsHint")} error={problems.recipients}>
                  <Textarea
                    rows={2}
                    value={recipients}
                    disabled={locked}
                    onChange={(e) => setRecipients(e.target.value)}
                  />
                </Field>
                <Field label={t("mbx.sends")} hint={t("mbx.sendsHint")} error={problems.sends}>
                  <Input
                    inputMode="numeric"
                    value={sends}
                    disabled={locked}
                    onChange={(e) => setSends(e.target.value)}
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
              onCheckedChange={(on) => setAutoSend(on === true)}
            />
            <Checkbox
              checked={deletable}
              disabled={locked}
              label={t("mbx.deletable")}
              hint={t("mbx.deletableHint")}
              onCheckedChange={(on) => setDeletable(on === true)}
            />
          </div>
        )}
        {save.isError && (
          <Callout tone="danger" role="alert">
            {describe(save.error)}
          </Callout>
        )}
        {edit && (
          <div className="section-form__actions">
            <Button type="submit" size="sm" variant="primary" disabled={invalid} loading={save.isPending}>
              {t("mbx.save")}
            </Button>
          </div>
        )}
      </form>
    </li>
  );
}

/* ---------- databases ---------- */

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
      {connections.data.map((connection) => {
        const link = links.data.find((each) => each.connectionId === connection.id);
        return (
          <DatabaseForm
            key={`${workspaceId}/${connection.id}/${JSON.stringify(link ?? null)}`}
            workspaceId={workspaceId}
            agentId={agent.id}
            connection={connection}
            link={link}
            edit={rights.editAll}
          />
        );
      })}
    </ul>
  );
}

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
  const latch = useLatch();
  const [reads, setReads] = useState((link?.level ?? "none") === "read");
  const [tables, setTables] = useState<ReadonlySet<string> | null>(
    link === undefined ? null : new Set(link.policy.tables),
  );
  const [hidden, setHidden] = useState(
    (link?.policy.maskedColumns ?? connection.hiddenSuggestion).join("\n"),
  );
  const [queries, setQueries] = useState(
    link === undefined ? "200" : link.policy.queriesPerDay === null ? "" : String(link.policy.queriesPerDay),
  );
  const [timeout, setTimeoutSeconds] = useState<(typeof TIMEOUTS)[number]>(link?.policy.timeoutSeconds ?? 30);
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
  const locked = !edit || save.isPending;
  const allTables = listed.data?.map(tableName) ?? [];
  // Before the first save, every table there is now is checked: the server's own default.
  const chosen = tables ?? new Set(allTables);
  const toggle = (name: string, on: boolean) => {
    const next = new Set(chosen);
    if (on) next.add(name);
    else next.delete(name);
    setTables(next);
  };
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
  else if (allTables.length === 0) tablePicker = <p className="page__muted">{t("dbx.noTablesThere")}</p>;
  else
    tablePicker = (
      <ul className="source__tables" aria-label={t("dbx.tables")}>
        {allTables.map((name) => (
          <li key={name}>
            <Checkbox
              checked={chosen.has(name)}
              disabled={locked}
              label={<code>{name}</code>}
              onCheckedChange={(on) => toggle(name, on === true)}
            />
          </li>
        ))}
      </ul>
    );
  const tablesReady = !edit || !reads || listed.isSuccess;
  return (
    <li className="source">
      <form
        className="section-form"
        aria-label={connection.label}
        onSubmit={(event) => {
          event.preventDefault();
          if (!edit || invalid) return;
          latch(() =>
            save
              .mutateAsync({
                workspaceId,
                agentId,
                databaseId: connection.id,
                body: {
                  level: reads ? "read" : "none",
                  ...(reads && {
                    policy: {
                      maskedColumns: columns,
                      queriesPerDay: queriesPerDay ?? null,
                      timeoutSeconds: timeout,
                      // The tables go only once the list is known; otherwise the saved ones stay.
                      ...(listed.isSuccess && { tables: [...chosen] }),
                    },
                  }),
                },
              })
              .then(() => outcome.done(t("dbx.saved", { name: connection.label }))),
          );
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
            onCheckedChange={(on) => setReads(on === true)}
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
                  onChange={(e) => setHidden(e.target.value)}
                />
              </Field>
              <Field label={t("dbx.queries")} hint={t("dbx.queriesHint")} error={problems.queries}>
                <Input
                  inputMode="numeric"
                  value={queries}
                  disabled={locked}
                  onChange={(e) => setQueries(e.target.value)}
                />
              </Field>
              <Field label={t("dbx.timeout")}>
                <Select
                  size="sm"
                  value={String(timeout)}
                  disabled={locked}
                  onValueChange={(next) =>
                    setTimeoutSeconds(TIMEOUTS.find((each) => String(each) === next) ?? 30)
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
        {save.isError && (
          <Callout tone="danger" role="alert">
            {describe(save.error)}
          </Callout>
        )}
        {edit && (
          <div className="section-form__actions">
            <Button
              type="submit"
              size="sm"
              variant="primary"
              disabled={invalid || !tablesReady}
              loading={save.isPending}
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
      key={`${workspaceId}/${saved.data.join(",")}`}
      workspaceId={workspaceId}
      agentId={agent.id}
      saved={saved.data}
      accounts={available.data.accounts}
      edit={rights.editAll}
    />
  );
}

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
  const latch = useLatch();
  const [chosen, setChosen] = useState<ReadonlySet<string>>(() => new Set(saved));
  const save = useApiMutation("setAgentRepositories", {
    invalidates: () => [{ method: "listAgentRepositories" as const, args: { workspaceId, agentId } }],
  });
  const known = new Set(
    accounts.flatMap((account) => [`${account.login}/*`, ...account.repositories.map((r) => r.fullName)]),
  );
  // Saved entries GitHub no longer lists stay visible, so a save never drops them unseen.
  const elsewhere = saved.filter((entry) => !known.has(entry));
  const toggle = (entry: string, on: boolean) => {
    const next = new Set(chosen);
    if (on) next.add(entry);
    else next.delete(entry);
    setChosen(next);
  };
  const locked = !edit || save.isPending;
  const box = (entry: string, label: ReactNode, under?: string) => (
    <li key={entry}>
      <Checkbox
        checked={chosen.has(entry) || (under !== undefined && chosen.has(under))}
        disabled={locked || (under !== undefined && chosen.has(under))}
        label={label}
        onCheckedChange={(on) => toggle(entry, on === true)}
      />
    </li>
  );
  return (
    <form
      className="section-form"
      aria-label={t("repo.title")}
      onSubmit={(event) => {
        event.preventDefault();
        if (!edit) return;
        latch(() =>
          save
            .mutateAsync({
              workspaceId,
              agentId,
              body: { repositories: [...chosen].slice(0, POLICY.repositories) },
            })
            .then(() => outcome.done(t("repo.saved"))),
        );
      }}
    >
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
      {save.isError && (
        <Callout tone="danger" role="alert">
          {describe(save.error)}
        </Callout>
      )}
      {edit && (
        <div className="section-form__actions">
          <Button type="submit" size="sm" variant="primary" loading={save.isPending}>
            {t("repo.save")}
          </Button>
        </div>
      )}
    </form>
  );
}
