// The workspace's skills: the shared catalog agents draw on, and which ones every new agent gets.
// Everyone reads the catalog and exports a skill as its SKILL.md; whoever manages agents writes one,
// imports one from GitHub, edits, imports again and deletes. The first skills show at once; the rest
// open with "Show all", where a search filters by name and description.
import { useApiMutation, useApiQuery, useVanrClient } from "@vanr/client/react";
import type { Skill, SkillDetail } from "@vanr/contract";
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
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
} from "@vanr/ui";
import { Download, Plus, RefreshCw } from "lucide-react";
import { type FormEvent, type ReactNode, useState } from "react";
import { useRouteParams } from "../../app/navigation.tsx";
import { ScreenError, ScreenLoading, useDocumentTitle, useErrorMessage } from "../../app/screens.tsx";
import { useMessages } from "../../i18n/react.tsx";
import {
  PartError,
  PartLoading,
  SKILL_BODY_MAX,
  SKILL_DESCRIPTION_MAX,
  SKILL_NAME_MAX,
  SKILL_NAME_RE,
  useAgentRights,
  useOutcome,
} from "./shared.tsx";

/** How many skills show before "Show all". */
export const SHORT_LIST = 6;
const URL_MAX = 500;

/** The skills whose name or description holds the words typed, ignoring case. */
export function filterSkills(skills: readonly Skill[], query: string): Skill[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return skills.filter((skill) => {
    const text = `${skill.name} ${skill.description}`.toLowerCase();
    return words.every((word) => text.includes(word));
  });
}

type Editing = { kind: "new" } | { kind: "edit"; id: string };

export function SkillsScreen() {
  const { workspaceId } = useRouteParams("skills");
  // Another workspace starts over: nothing opened in one stays open in the next.
  return <Catalog key={workspaceId} workspaceId={workspaceId} />;
}

function Catalog({ workspaceId }: { workspaceId: string }) {
  const t = useMessages("agents");
  const shell = useMessages("shell");
  const rights = useAgentRights(workspaceId);
  const skills = useApiQuery("listSkills", { workspaceId });
  const [all, setAll] = useState(false);
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<Editing | null>(null);
  useDocumentTitle(shell("route.skills"));

  if (skills.isPending) return <ScreenLoading />;
  if (skills.isError) {
    return (
      <ScreenError
        title={t("skills.failed")}
        error={skills.error}
        onRetry={() => void skills.refetch()}
        namespace="agents"
      />
    );
  }
  const add = rights.manage && (
    <Button variant="primary" icon={<Plus size={16} />} onClick={() => setEditing({ kind: "new" })}>
      {t("skills.add")}
    </Button>
  );
  const shown = all ? filterSkills(skills.data, query) : skills.data.slice(0, SHORT_LIST);
  return (
    <div className="page page--wide">
      <header className="agents-head">
        <div>
          <h1 className="page__title">{shell("route.skills")}</h1>
          <p className="page__muted">{t("skills.lead")}</p>
        </div>
        {skills.data.length > 0 && add}
      </header>
      {skills.data.length === 0 ? (
        <EmptyState
          className="page__narrow"
          title={t("skills.empty")}
          description={t(rights.manage ? "skills.emptyBody" : "skills.emptyAsk")}
          action={add || undefined}
        />
      ) : (
        <>
          {all && (
            <Field label={t("skills.search")}>
              <Input type="search" value={query} onChange={(event) => setQuery(event.target.value)} />
            </Field>
          )}
          {shown.length === 0 ? (
            <p className="page__muted" role="status">
              {t("skills.noMatch", { query: query.trim() })}
            </p>
          ) : (
            <ul className="skill-list" aria-label={shell("route.skills")}>
              {shown.map((skill) => (
                <SkillRow
                  key={skill.id}
                  skill={skill}
                  workspaceId={workspaceId}
                  manage={rights.manage}
                  onEdit={() => setEditing({ kind: "edit", id: skill.id })}
                />
              ))}
            </ul>
          )}
          {skills.data.length > SHORT_LIST && (
            <div>
              <Button variant="ghost" onClick={() => setAll(!all)}>
                {all ? t("skills.showFewer") : t("skills.showAll", { count: skills.data.length })}
              </Button>
            </div>
          )}
        </>
      )}
      {rights.manage && editing !== null && (
        <SkillDialog editing={editing} workspaceId={workspaceId} onClose={() => setEditing(null)} />
      )}
    </div>
  );
}

function SkillRow({
  skill,
  workspaceId,
  manage,
  onEdit,
}: {
  skill: Skill;
  workspaceId: string;
  manage: boolean;
  onEdit: () => void;
}) {
  const t = useMessages("agents");
  const outcome = useOutcome();
  const { api } = useVanrClient();
  const [deleting, setDeleting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const refetch = () => [{ method: "listSkills" as const, args: { workspaceId } }];
  const reimport = useApiMutation("reimportSkill", {
    invalidates: () => [
      ...refetch(),
      { method: "getSkill" as const, args: { workspaceId, skillId: skill.id } },
    ],
  });
  const remove = useApiMutation("deleteSkill", { invalidates: refetch });
  const download = async () => {
    setExporting(true);
    try {
      const md = await api.getSkillSkillMd({ workspaceId, skillId: skill.id });
      const url = URL.createObjectURL(new Blob([md.markdown], { type: "text/markdown" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `${md.name}.md`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      outcome.failed(error);
    } finally {
      setExporting(false);
    }
  };
  return (
    <li className="skill-row">
      <div className="skill-row__text">
        <p className="skill-row__name">
          <strong>{skill.name}</strong>
          <Chip>{t(`skill.source.${skill.source}`)}</Chip>
          <span className="page__muted">{t("skill.version", { version: skill.version })}</span>
          {skill.autoGrantNewAgents && <Chip>{t("skill.default")}</Chip>}
        </p>
        {skill.description !== "" && <p className="page__muted">{skill.description}</p>}
        {skill.problems.length > 0 && (
          <ul className="agent-plain" aria-label={t("skill.problems", { name: skill.name })}>
            {skill.problems.map((problem) => (
              <li key={problem} className="agent-error">
                {problem}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="skill-row__actions">
        <Button
          variant="ghost"
          size="sm"
          icon={<Download size={16} />}
          loading={exporting}
          aria-label={t("skill.export", { name: skill.name })}
          onClick={() => void download()}
        />
        {manage && (
          <>
            {skill.source === "github" && (
              <Button
                variant="ghost"
                size="sm"
                icon={<RefreshCw size={16} />}
                loading={reimport.isPending}
                aria-label={t("skill.reimport", { name: skill.name })}
                onClick={() =>
                  reimport.mutate(
                    { workspaceId, skillId: skill.id },
                    {
                      onSuccess: () => outcome.done(t("skill.reimported", { name: skill.name })),
                      onError: outcome.failed,
                    },
                  )
                }
              />
            )}
            <Button variant="secondary" size="sm" disabled={reimport.isPending} onClick={onEdit}>
              {t("skill.edit")}
            </Button>
            <Button variant="ghost" size="sm" disabled={reimport.isPending} onClick={() => setDeleting(true)}>
              {t("skill.delete")}
            </Button>
            <ConfirmDialog
              open={deleting}
              onOpenChange={setDeleting}
              tone="danger"
              title={t("skill.deleteTitle", { name: skill.name })}
              description={t("skill.deleteBody")}
              confirmLabel={t("skill.delete")}
              cancelLabel={t("instructions.discard")}
              confirming={remove.isPending}
              onConfirm={() =>
                remove.mutate(
                  { workspaceId, skillId: skill.id },
                  {
                    onSuccess: () => {
                      setDeleting(false);
                      outcome.done(t("skill.deleted", { name: skill.name }));
                    },
                    onError: (error) => {
                      setDeleting(false);
                      outcome.failed(error);
                    },
                  },
                )
              }
            />
          </>
        )}
      </div>
    </li>
  );
}

function SkillDialog({
  editing,
  workspaceId,
  onClose,
}: {
  editing: Editing;
  workspaceId: string;
  onClose: () => void;
}) {
  const t = useMessages("agents");
  const common = useMessages("common");
  const detail = useApiQuery(
    "getSkill",
    { workspaceId, skillId: editing.kind === "edit" ? editing.id : "" },
    { enabled: editing.kind === "edit" },
  );
  let body: ReactNode;
  if (editing.kind === "new") body = <NewSkill workspaceId={workspaceId} onDone={onClose} />;
  else if (detail.isPending) body = <PartLoading />;
  else if (detail.isError)
    body = (
      <PartError title={t("skill.loadFailed")} error={detail.error} onRetry={() => void detail.refetch()} />
    );
  // A newer version (saved or imported again meanwhile) starts the form over from it.
  else
    body = (
      <SkillForm key={detail.data.version} workspaceId={workspaceId} skill={detail.data} onDone={onClose} />
    );
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        size="lg"
        closeLabel={common("action.close")}
        title={t(editing.kind === "new" ? "skill.newTitle" : "skill.editTitle")}
      >
        {body}
      </DialogContent>
    </Dialog>
  );
}

function NewSkill({ workspaceId, onDone }: { workspaceId: string; onDone: () => void }) {
  const t = useMessages("agents");
  const describe = useErrorMessage("agents");
  const outcome = useOutcome();
  const [url, setUrl] = useState("");
  const importing = useApiMutation("importSkill", {
    invalidates: () => [{ method: "listSkills" as const, args: { workspaceId } }],
  });
  return (
    <Tabs defaultValue="write">
      <TabsList aria-label={t("skill.newTitle")}>
        <TabsTrigger value="write">{t("skill.write")}</TabsTrigger>
        <TabsTrigger value="import">{t("skill.import")}</TabsTrigger>
      </TabsList>
      <TabsContent value="write">
        <SkillForm workspaceId={workspaceId} skill={null} onDone={onDone} />
      </TabsContent>
      <TabsContent value="import">
        <form
          className="section-form"
          aria-label={t("skill.import")}
          onSubmit={(event) => {
            event.preventDefault();
            if (url.trim() === "") return;
            importing.mutate(
              { workspaceId, body: { url: url.trim() } },
              {
                onSuccess: (skill) => {
                  outcome.done(t("skill.imported", { name: skill.name }));
                  onDone();
                },
              },
            );
          }}
        >
          <Field label={t("skill.url")} hint={t("skill.urlHint")}>
            <Input
              type="url"
              value={url}
              maxLength={URL_MAX}
              placeholder="https://github.com/…"
              onChange={(event) => setUrl(event.target.value)}
            />
          </Field>
          {importing.isError && (
            <Callout tone="danger" role="alert">
              {describe(importing.error)}
            </Callout>
          )}
          <div className="section-form__actions">
            <Button
              type="submit"
              variant="primary"
              disabled={url.trim() === ""}
              loading={importing.isPending}
            >
              {t("skill.importAction")}
            </Button>
          </div>
        </form>
      </TabsContent>
    </Tabs>
  );
}

function SkillForm({
  workspaceId,
  skill,
  onDone,
}: {
  workspaceId: string;
  skill: SkillDetail | null;
  onDone: () => void;
}) {
  const t = useMessages("agents");
  const describe = useErrorMessage("agents");
  const outcome = useOutcome();
  const [name, setName] = useState(skill?.name ?? "");
  const [description, setDescription] = useState(skill?.description ?? "");
  const [text, setText] = useState(skill?.body ?? "");
  const [auto, setAuto] = useState(skill?.autoGrantNewAgents ?? false);
  const invalidates = () => [{ method: "listSkills" as const, args: { workspaceId } }];
  const create = useApiMutation("createSkill", { invalidates });
  const update = useApiMutation("updateSkill", {
    invalidates: (args) => [
      ...invalidates(),
      { method: "getSkill" as const, args: { workspaceId, skillId: args.skillId } },
    ],
  });
  const failed = create.error ?? update.error;
  const nameWrong = name.trim() !== "" && !SKILL_NAME_RE.test(name.trim());
  const valid = name.trim() !== "" && !nameWrong && description.trim() !== "" && text.trim() !== "";
  const body = { name: name.trim(), description: description.trim(), body: text, autoGrantNewAgents: auto };
  const done = (saved: SkillDetail) => {
    outcome.done(t("skill.saved", { name: saved.name }));
    onDone();
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!valid) return;
    if (skill === null) create.mutate({ workspaceId, body }, { onSuccess: done });
    else update.mutate({ workspaceId, skillId: skill.id, body }, { onSuccess: done });
  };
  const skipped = skill?.files.filter((file) => file.status === "skipped") ?? [];
  return (
    <form className="section-form" aria-label={t("skill.write")} onSubmit={submit}>
      {skill?.source === "github" && (
        <Callout tone="warning">{t("skill.importedFrom", { url: skill.sourceUrl ?? "" })}</Callout>
      )}
      <Field label={t("skill.name")} error={nameWrong ? t("skill.nameWrong") : undefined}>
        <Input value={name} maxLength={SKILL_NAME_MAX} onChange={(event) => setName(event.target.value)} />
      </Field>
      <Field label={t("skill.description")} hint={t("skill.descriptionHint")}>
        <Textarea
          rows={2}
          value={description}
          maxLength={SKILL_DESCRIPTION_MAX}
          onChange={(event) => setDescription(event.target.value)}
        />
      </Field>
      <Field label={t("skill.body")}>
        <Textarea
          rows={12}
          mono
          value={text}
          maxLength={SKILL_BODY_MAX}
          onChange={(event) => setText(event.target.value)}
        />
      </Field>
      <Switch label={t("skill.auto")} hint={t("skill.autoHint")} checked={auto} onCheckedChange={setAuto} />
      {skill !== null && skill.files.length > 0 && (
        <div className="page__section">
          <h3 className="page__heading">{t("skill.files")}</h3>
          <ul className="agent-plain" aria-label={t("skill.files")}>
            {skill.files.map((file) => (
              <li key={file.path}>
                <code>{file.path}</code>
                {file.status === "skipped" && <span className="page__muted"> · {t("skill.skipped")}</span>}
              </li>
            ))}
          </ul>
          {skipped.length > 0 && (
            <p className="page__muted">{t("skill.skippedHint", { count: skipped.length })}</p>
          )}
        </div>
      )}
      {failed !== null && (
        <Callout tone="danger" role="alert">
          {describe(failed)}
        </Callout>
      )}
      <div className="section-form__actions">
        <Button
          type="submit"
          variant="primary"
          disabled={!valid}
          loading={create.isPending || update.isPending}
        >
          {t("skill.save")}
        </Button>
      </div>
    </form>
  );
}
