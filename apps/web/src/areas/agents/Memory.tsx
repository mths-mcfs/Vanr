// What the agent remembers. The short notes sit in three tabs (facts and decisions, lessons and
// preferences, archived), pinned first and then the most recently changed; the search matches the subject
// or the text, ignoring case. Whoever edits the agent rewrites a note, pins it, archives or restores it, and
// takes back a person's edit. Notes come back when the agent records one and again every minute, since
// memories written in channels the person does not follow send them no event. The memory page adds the
// agent's memory files under the same notes.
import { useApiMutation, useApiQuery } from "@vanr/client/react";
import type { AgentDetail, Memory } from "@vanr/contract";
import {
  AgentSigil,
  Button,
  Chip,
  Dialog,
  DialogContent,
  EmptyState,
  Field,
  Input,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
} from "@vanr/ui";
import { ArrowLeft } from "lucide-react";
import { type ReactNode, useState } from "react";
import { AppLink, useRouteParams } from "../../app/navigation.tsx";
import { ScreenLoading, useDocumentTitle } from "../../app/screens.tsx";
import { useLocale, useMessages } from "../../i18n/react.tsx";
import { type AgentRights, PartError, PartLoading, Section, useAgentRights, useOutcome } from "./shared.tsx";

export const MEMORY_REFRESH_MS = 60_000;
export const MEMORY_TEXT_MAX = 4000;
const GROUPS = ["known", "learned", "archived"] as const;
type Group = (typeof GROUPS)[number];

const groupOf = (memory: Memory): Group =>
  memory.archived ? "archived" : memory.kind === "fact" || memory.kind === "decision" ? "known" : "learned";

/** The notes of one tab that match the search: pinned first, then the most recently changed. */
export function notesIn(memories: readonly Memory[], group: Group, query: string): Memory[] {
  const q = query.trim().toLowerCase();
  return memories
    .filter((memory) => groupOf(memory) === group)
    .filter((memory) => q === "" || `${memory.about ?? ""} ${memory.text}`.toLowerCase().includes(q))
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

export function MemoryScreen() {
  const t = useMessages("agents");
  const { workspaceId, agentId } = useRouteParams("agentMemory");
  const agent = useApiQuery("getAgent", { workspaceId, agentId });
  const rights = useAgentRights(workspaceId, agent.data);
  useDocumentTitle(
    agent.data === undefined ? t("memory.title") : t("memory.pageTitle", { name: agent.data.name }),
  );
  if (agent.isPending) return <ScreenLoading />;
  if (agent.isError) {
    return (
      <div className="page">
        <h1 className="page__title">{t("memory.title")}</h1>
        <PartError title={t("profile.failed")} error={agent.error} onRetry={() => void agent.refetch()} />
      </div>
    );
  }
  return (
    <div className="page page--wide agent-page">
      <AppLink className="app-link agent-back" route="agent" params={{ workspaceId, agentId }}>
        <ArrowLeft size={16} aria-hidden="true" /> {t("memory.back", { name: agent.data.name })}
      </AppLink>
      <header className="agent-cover">
        <AgentSigil agentId={agentId} name="" aria-hidden="true" size="lg" />
        <h1 className="page__title">{t("memory.pageTitle", { name: agent.data.name })}</h1>
      </header>
      <MemoryPanel agent={agent.data} workspaceId={workspaceId} rights={rights} />
      <MemoryFiles agent={agent.data} workspaceId={workspaceId} />
    </div>
  );
}

export function MemoryPanel({
  agent,
  workspaceId,
  rights,
}: {
  agent: AgentDetail;
  workspaceId: string;
  rights: AgentRights;
}) {
  const t = useMessages("agents");
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<Group>("known");
  const memories = useApiQuery(
    "listAgentMemories",
    { workspaceId, agentId: agent.id, query: {} },
    { refetchInterval: MEMORY_REFRESH_MS },
  );
  let body: ReactNode;
  if (memories.isPending) body = <PartLoading />;
  else if (memories.isError)
    body = (
      <PartError title={t("memory.failed")} error={memories.error} onRetry={() => void memories.refetch()} />
    );
  else {
    const notes = memories.data.filter((memory) => memory.path === null);
    body = (
      <>
        <Field label={t("memory.search")}>
          <Input type="search" value={query} onChange={(event) => setQuery(event.target.value)} />
        </Field>
        <Tabs value={tab} onValueChange={(next) => setTab(GROUPS.find((group) => group === next) ?? "known")}>
          <TabsList aria-label={t("memory.title")}>
            {GROUPS.map((group) => (
              <TabsTrigger key={group} value={group}>
                {t(`memory.tab.${group}`, { count: notesIn(notes, group, "").length })}
              </TabsTrigger>
            ))}
          </TabsList>
          {GROUPS.map((group) => {
            const shown = notesIn(notes, group, query);
            const total = notesIn(notes, group, "").length;
            return (
              <TabsContent key={group} value={group}>
                {total === 0 ? (
                  <p className="page__muted">{t(`memory.empty.${group}`)}</p>
                ) : shown.length === 0 ? (
                  <p className="page__muted" role="status">
                    {t("memory.noMatch", { query: query.trim() })}
                  </p>
                ) : (
                  <ul className="memory-list" aria-label={t(`memory.tab.${group}`, { count: total })}>
                    {shown.map((memory) => (
                      <Note
                        key={memory.id}
                        memory={memory}
                        agentId={agent.id}
                        workspaceId={workspaceId}
                        editable={rights.editLook}
                      />
                    ))}
                  </ul>
                )}
              </TabsContent>
            );
          })}
        </Tabs>
      </>
    );
  }
  return (
    <Section title={t("memory.title")} help={t("memory.help")}>
      {body}
    </Section>
  );
}

function Note({
  memory,
  agentId,
  workspaceId,
  editable,
}: {
  memory: Memory;
  agentId: string;
  workspaceId: string;
  editable: boolean;
}) {
  const t = useMessages("agents");
  const { locale } = useLocale();
  const outcome = useOutcome();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(memory.text);
  // The version the edit started from: a save on top of another change is refused, not written over it.
  const [base, setBase] = useState(memory.sha256);
  const [history, setHistory] = useState(false);
  const invalidates = () => [{ method: "listAgentMemories" as const, args: { workspaceId, agentId } }];
  const rewrite = useApiMutation("updateMemory", { invalidates });
  const pin = useApiMutation("setMemoryPinned", { invalidates });
  const archive = useApiMutation("setMemoryArchived", { invalidates });
  const revert = useApiMutation("revertMemory", { invalidates });
  const busy = rewrite.isPending || pin.isPending || archive.isPending || revert.isPending;
  const args = { workspaceId, memoryId: memory.id };
  const when = new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(memory.updatedAt));
  const label = memory.about ?? memory.text.slice(0, 40);
  return (
    <li className="memory-note">
      {editing ? (
        <form
          className="section-form"
          aria-label={t("memory.edit", { about: label })}
          onSubmit={(event) => {
            event.preventDefault();
            if (text.trim() === "") return;
            rewrite.mutate(
              { ...args, body: { text: text.trim(), expectedSha256: base } },
              {
                onSuccess: () => {
                  setEditing(false);
                  outcome.done(t("memory.saved"));
                },
                onError: outcome.failed,
              },
            );
          }}
        >
          <Field label={t("memory.text")}>
            <Textarea
              rows={3}
              value={text}
              disabled={rewrite.isPending}
              maxLength={MEMORY_TEXT_MAX}
              onChange={(event) => setText(event.target.value)}
            />
          </Field>
          <div className="section-form__actions">
            <Button variant="ghost" onClick={() => setEditing(false)}>
              {t("instructions.discard")}
            </Button>
            <Button type="submit" variant="primary" disabled={text.trim() === ""} loading={rewrite.isPending}>
              {t("memory.save")}
            </Button>
          </div>
        </form>
      ) : (
        <p className="memory-note__text">{memory.text}</p>
      )}
      <p className="memory-note__meta">
        <Chip>{t(`memory.kind.${memory.kind}`)}</Chip>
        {memory.pinned && <Chip>{t("memory.pinned")}</Chip>}
        {memory.verified && <Chip>{t("memory.verified")}</Chip>}
        {memory.untrustedSource && <Chip>{t("memory.untrusted")}</Chip>}
        {memory.about !== null && <span>{t("memory.about", { about: memory.about })}</span>}
        {memory.origin?.channel != null && <span>#{memory.origin.channel}</span>}
        <span className="page__muted">{when}</span>
        {memory.uses > 0 && <span className="page__muted">{t("memory.uses", { count: memory.uses })}</span>}
      </p>
      <div className="memory-note__actions">
        <Button variant="ghost" size="sm" onClick={() => setHistory(true)}>
          {t("memory.history")}
        </Button>
        {editable && !editing && (
          <>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => {
                // The draft starts from the note as it is now, not as it was when the list first loaded.
                setText(memory.text);
                setBase(memory.sha256);
                setEditing(true);
              }}
            >
              {t("memory.editAction")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() =>
                pin.mutate({ ...args, body: { pinned: !memory.pinned } }, { onError: outcome.failed })
              }
            >
              {t(memory.pinned ? "memory.unpin" : "memory.pin")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() =>
                archive.mutate(
                  { ...args, body: { archived: !memory.archived } },
                  {
                    onSuccess: () =>
                      outcome.done(t(memory.archived ? "memory.restored" : "memory.archivedDone")),
                    onError: outcome.failed,
                  },
                )
              }
            >
              {t(memory.archived ? "memory.restore" : "memory.archive")}
            </Button>
            {memory.editorUserId !== null && (
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() =>
                  revert.mutate(args, {
                    onSuccess: () => outcome.done(t("memory.reverted")),
                    onError: outcome.failed,
                  })
                }
              >
                {t("memory.revert")}
              </Button>
            )}
          </>
        )}
      </div>
      {history && <History memory={memory} workspaceId={workspaceId} onClose={() => setHistory(false)} />}
    </li>
  );
}

function History({
  memory,
  workspaceId,
  onClose,
}: {
  memory: Memory;
  workspaceId: string;
  onClose: () => void;
}) {
  const t = useMessages("agents");
  const common = useMessages("common");
  const { locale } = useLocale();
  const versions = useApiQuery("listMemoryVersions", { workspaceId, memoryId: memory.id });
  const when = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" });
  let body: ReactNode;
  if (versions.isPending) body = <PartLoading />;
  else if (versions.isError)
    body = (
      <PartError
        title={t("memory.historyFailed")}
        error={versions.error}
        onRetry={() => void versions.refetch()}
      />
    );
  else
    body = (
      <ol className="agent-history" aria-label={t("memory.history")}>
        {[...versions.data]
          .sort((a, b) => b.seq - a.seq)
          .map((version) => (
            <li key={version.id} className="agent-history__item">
              <div className="agent-history__line">
                <strong>{t("history.version", { seq: version.seq })}</strong>
                <span>{t(`memory.op.${version.op}`)}</span>
                <span className="page__muted">{when.format(new Date(version.createdAt))}</span>
              </div>
              <p>{version.text}</p>
            </li>
          ))}
      </ol>
    );
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent size="lg" closeLabel={common("action.close")} title={t("memory.historyTitle")}>
        {body}
      </DialogContent>
    </Dialog>
  );
}

/** The agent's memory files (`clients/acme.md`), read-only here. */
function MemoryFiles({ agent, workspaceId }: { agent: AgentDetail; workspaceId: string }) {
  const t = useMessages("agents");
  const memories = useApiQuery(
    "listAgentMemories",
    { workspaceId, agentId: agent.id, query: {} },
    { refetchInterval: MEMORY_REFRESH_MS },
  );
  const files = (memories.data ?? []).filter((memory) => memory.path !== null && !memory.archived);
  if (!memories.isSuccess) return null;
  return (
    <Section title={t("memory.files")} help={t("memory.filesHelp")}>
      {files.length === 0 ? (
        <EmptyState title={t("memory.filesEmpty")} />
      ) : (
        <ul className="memory-list" aria-label={t("memory.files")}>
          {files.map((file) => (
            <li key={file.id} className="memory-note">
              <details>
                <summary>
                  <code>{file.path}</code>
                </summary>
                <p className="memory-note__text">{file.text}</p>
              </details>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
