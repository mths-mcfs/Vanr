// The top of a page: its folder, tags, other titles and the properties the workspace defines. Whoever
// may edit the page changes them in place (Enter or leaving the field saves, Escape goes back);
// everyone else reads them. A value goes through `updateWikiPageMeta` on the page's version, tried
// once more on the fresh version when someone saved in between. A new property is a new definition
// of the workspace's set (`setWikiProps`), then a value on the page.
import { useApiQuery } from "@vanr/client/react";
import type { WikiPage, WikiPropDef } from "@vanr/contract";
import {
  Button,
  Checkbox,
  Icon,
  Input,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
  Select,
  SelectItem,
} from "@vanr/ui";
import { Plus, X } from "lucide-react";
import { type ReactNode, useState } from "react";
import { useLocale, useMessages } from "../../../i18n/react.tsx";
import { FOLDER_MAX, parseList, TAG_LENGTH, TAGS_MAX, useActorName } from "../shared.tsx";

/** The types a new property may take here. */
const NEW_TYPES = [
  "text",
  "number",
  "select",
  "multi_select",
  "status",
  "date",
  "checkbox",
  "person",
  "url",
] as const;
type NewType = (typeof NEW_TYPES)[number];
const COMPUTED = new Set(["created_time", "creator", "edited_time", "editor"]);
const UNSHOWN = new Set(["formula", "relation", "rollup"]);

const newId = (prefix: string) => `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;

export type MetaWrite = {
  props?: Record<string, unknown>;
  tags?: string[];
  altTitles?: string[];
  agentEdits?: "direct" | "propose";
};

type Props = {
  workspaceId: string;
  page: WikiPage;
  defs: WikiPropDef[];
  editable: boolean;
  busy: boolean;
  onMeta: (write: MetaWrite) => Promise<unknown>;
  onMove: (folder: string) => Promise<unknown>;
  /** Saves the workspace's definitions; false when that failed (the failure is already shown). */
  onDefs: (defs: WikiPropDef[]) => Promise<boolean>;
};

/** A text field that saves on Enter or on leaving it, and goes back on Escape. */
function InlineText({
  label,
  value,
  editable,
  maxLength,
  type = "text",
  onSave,
}: {
  label: string;
  value: string;
  editable: boolean;
  maxLength?: number;
  type?: "text" | "number" | "url" | "date";
  onSave: (next: string) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft !== null && draft !== value) onSave(draft);
    setDraft(null);
  };
  return (
    <Input
      size="sm"
      type={type}
      aria-label={label}
      value={draft ?? value}
      readOnly={!editable}
      {...(maxLength !== undefined && { maxLength })}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commit();
        } else if (event.key === "Escape") setDraft(null);
      }}
    />
  );
}

/** A list of short words (tags, other titles): Enter or a comma adds, Backspace on an empty field removes the last. */
function WordList({
  label,
  words,
  editable,
  prefix = "",
  maxCount,
  maxLength,
  onChange,
}: {
  label: string;
  words: string[];
  editable: boolean;
  prefix?: string;
  maxCount?: number;
  maxLength?: number;
  onChange: (next: string[]) => void;
}) {
  const t = useMessages("wiki");
  const [draft, setDraft] = useState("");
  const add = () => {
    const more = parseList(draft).filter((word) => !words.includes(word));
    setDraft("");
    if (more.length > 0) onChange([...words, ...more].slice(0, maxCount));
  };
  return (
    <div className="wiki-props__words">
      <ul className="wiki-props__chips" aria-label={label}>
        {words.map((word) => (
          <li key={word} className="wiki-props__chip">
            {prefix}
            {word}
            {editable && (
              <button
                type="button"
                className="wiki-props__remove"
                aria-label={t("props.remove", { name: word })}
                onClick={() => onChange(words.filter((each) => each !== word))}
              >
                <Icon icon={X} size="sm" />
              </button>
            )}
          </li>
        ))}
      </ul>
      {editable && (
        <Input
          size="sm"
          aria-label={t("props.add", { name: label })}
          value={draft}
          {...(maxLength !== undefined && { maxLength })}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={add}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === ",") {
              event.preventDefault();
              add();
            } else if (event.key === "Escape") setDraft("");
            else if (event.key === "Backspace" && draft === "" && words.length > 0)
              onChange(words.slice(0, -1));
          }}
        />
      )}
    </div>
  );
}

export function PropsBar({ workspaceId, page, defs, editable, busy, onMeta, onMove, onDefs }: Props) {
  const t = useMessages("wiki");
  const { locale } = useLocale();
  const name = useActorName(workspaceId);
  const members = useApiQuery("listMembers", { workspaceId });
  const agents = useApiQuery("listAgents", { workspaceId });
  // Properties without a value stay in the menu until someone adds them.
  const [added, setAdded] = useState<string[]>([]);
  const [creating, setCreating] = useState<{ name: string; type: NewType } | null>(null);
  const shown = defs.filter(
    (def) =>
      !UNSHOWN.has(def.type) && (COMPUTED.has(def.type) || def.id in page.props || added.includes(def.id)),
  );
  const addable = defs.filter((def) => !UNSHOWN.has(def.type) && !shown.includes(def));
  const setValue = (def: WikiPropDef, value: unknown) => void onMeta({ props: { [def.id]: value } });
  const first = page.history.at(-1);
  const date = (iso: string) =>
    new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(iso));

  const valueField = (def: WikiPropDef): ReactNode => {
    const value = page.props[def.id];
    const label = def.name;
    switch (def.type) {
      case "created_time":
        return first === undefined ? null : <span>{date(first.at)}</span>;
      case "creator":
        return first === undefined ? null : <span>{name(first.author)}</span>;
      case "edited_time":
        return <span>{date(page.updatedAt)}</span>;
      case "editor":
        return <span>{name(page.updatedBy)}</span>;
      case "checkbox":
        return (
          <Checkbox
            label={label}
            className="wiki-props__check"
            checked={value === true}
            disabled={!editable}
            onCheckedChange={(checked) => setValue(def, checked === true)}
          />
        );
      case "number":
        return (
          <InlineText
            label={label}
            type="number"
            editable={editable}
            value={typeof value === "number" ? String(value) : ""}
            onSave={(next) => setValue(def, next.trim() === "" ? null : Number(next))}
          />
        );
      case "date": {
        const start =
          typeof value === "object" && value !== null && "start" in value ? String(value.start) : "";
        return (
          <InlineText
            label={label}
            type="date"
            editable={editable}
            value={start.slice(0, 10)}
            // A time stored with the date (from the API or an import) stays when only the day changes.
            onSave={(next) => setValue(def, next === "" ? null : { start: `${next}${start.slice(10)}` })}
          />
        );
      }
      case "select":
      case "status": {
        const picker = (
          <Select
            size="sm"
            aria-label={label}
            disabled={!editable}
            value={typeof value === "string" ? value : ""}
            placeholder={t("props.none")}
            onValueChange={(next) => setValue(def, next)}
          >
            {(def.options ?? []).map((option) => (
              <SelectItem key={option.id} value={option.id}>
                {option.name}
              </SelectItem>
            ))}
          </Select>
        );
        return (
          <div className="wiki-props__words">
            {picker}
            {editable && (
              <InlineText
                label={t("props.newOption", { name: label })}
                editable
                value=""
                onSave={(text) => {
                  const optionName = text.trim();
                  if (optionName === "") return;
                  const known = def.options?.find((option) => option.name === optionName);
                  if (known !== undefined) {
                    setValue(def, known.id);
                    return;
                  }
                  // A new option is saved on the definition first, then picked.
                  const option = { id: newId("opt"), name: optionName };
                  const options = [...(def.options ?? []), option];
                  void onDefs(defs.map((each) => (each.id === def.id ? { ...def, options } : each))).then(
                    (saved) => {
                      if (saved) setValue(def, option.id);
                    },
                  );
                }}
              />
            )}
          </div>
        );
      }
      case "multi_select": {
        const ids = Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
        const byName = new Map((def.options ?? []).map((option) => [option.name, option.id]));
        const names = ids.map((id) => def.options?.find((option) => option.id === id)?.name ?? id);
        return (
          <WordList
            label={label}
            words={names}
            editable={editable}
            onChange={(next) => {
              // A new name is a new option of the definition, saved before the value.
              const fresh = next.filter((each) => !byName.has(each));
              const options = [
                ...(def.options ?? []),
                ...fresh.map((each) => ({ id: newId("opt"), name: each })),
              ];
              const ids = next.map((each) => options.find((option) => option.name === each)?.id ?? each);
              const save = async () => {
                // A value never points at an option whose definition did not save.
                if (
                  fresh.length > 0 &&
                  !(await onDefs(defs.map((each) => (each.id === def.id ? { ...def, options } : each))))
                )
                  return;
                await onMeta({ props: { [def.id]: ids } });
              };
              void save();
            }}
          />
        );
      }
      case "person": {
        const actors = Array.isArray(value)
          ? value.filter(
              (each): each is { type: "person" | "agent"; id: string } =>
                typeof each === "object" && each !== null && "id" in each && "type" in each,
            )
          : [];
        const known = new Set(actors.map((actor) => `${actor.type}:${actor.id}`));
        const choices = [
          ...(members.data ?? []).map((member) => ({
            type: "person" as const,
            id: member.userId,
            name: member.name,
          })),
          ...(agents.data ?? []).map((agent) => ({ type: "agent" as const, id: agent.id, name: agent.name })),
        ].filter((choice) => !known.has(`${choice.type}:${choice.id}`));
        return (
          <div className="wiki-props__words">
            <ul className="wiki-props__chips" aria-label={label}>
              {actors.map((actor) => (
                <li key={`${actor.type}:${actor.id}`} className="wiki-props__chip">
                  {name(actor)}
                  {editable && (
                    <button
                      type="button"
                      className="wiki-props__remove"
                      aria-label={t("props.remove", { name: name(actor) })}
                      onClick={() =>
                        setValue(
                          def,
                          actors.filter((each) => each.type !== actor.type || each.id !== actor.id),
                        )
                      }
                    >
                      <Icon icon={X} size="sm" />
                    </button>
                  )}
                </li>
              ))}
            </ul>
            {editable && choices.length > 0 && (
              <Select
                size="sm"
                aria-label={t("props.add", { name: label })}
                value=""
                placeholder={t("props.addPerson")}
                onValueChange={(key) => {
                  const choice = choices.find((each) => `${each.type}:${each.id}` === key);
                  if (choice !== undefined) setValue(def, [...actors, { type: choice.type, id: choice.id }]);
                }}
              >
                {choices.map((choice) => (
                  <SelectItem key={`${choice.type}:${choice.id}`} value={`${choice.type}:${choice.id}`}>
                    {choice.name}
                  </SelectItem>
                ))}
              </Select>
            )}
          </div>
        );
      }
      case "file":
        return <span>{t("props.files", { count: Array.isArray(value) ? value.length : 0 })}</span>;
      default:
        return (
          <InlineText
            label={label}
            type={def.type === "url" ? "url" : "text"}
            editable={editable}
            value={typeof value === "string" ? value : ""}
            onSave={(next) => setValue(def, next.trim() === "" ? null : next.trim())}
          />
        );
    }
  };

  return (
    <section className="wiki-props" aria-label={t("props.label")} aria-busy={busy}>
      <dl className="wiki-props__list">
        <div className="wiki-props__row">
          <dt>{t("props.folder")}</dt>
          <dd>
            <InlineText
              label={t("props.folder")}
              editable={editable}
              value={page.folder}
              maxLength={FOLDER_MAX}
              onSave={(next) => void onMove(next.trim())}
            />
          </dd>
        </div>
        <div className="wiki-props__row">
          <dt>{t("props.tags")}</dt>
          <dd>
            <WordList
              label={t("props.tags")}
              words={page.tags}
              prefix="#"
              editable={editable}
              maxCount={TAGS_MAX}
              maxLength={TAG_LENGTH}
              onChange={(tags) => void onMeta({ tags })}
            />
          </dd>
        </div>
        <div className="wiki-props__row">
          <dt>{t("props.altTitles")}</dt>
          <dd>
            <WordList
              label={t("props.altTitles")}
              words={page.altTitles}
              editable={editable}
              onChange={(altTitles) => void onMeta({ altTitles })}
            />
          </dd>
        </div>
        {shown.map((def) => (
          <div key={def.id} className="wiki-props__row">
            <dt>{def.name}</dt>
            <dd>{valueField(def)}</dd>
          </div>
        ))}
      </dl>
      {editable && creating === null && (
        <Menu>
          <MenuTrigger asChild>
            <Button size="sm" variant="ghost" icon={<Icon icon={Plus} />}>
              {t("props.addProperty")}
            </Button>
          </MenuTrigger>
          <MenuContent>
            {addable.map((def) => (
              <MenuItem key={def.id} onSelect={() => setAdded((list) => [...list, def.id])}>
                {def.name}
              </MenuItem>
            ))}
            {addable.length > 0 && <MenuSeparator />}
            <MenuItem onSelect={() => setCreating({ name: "", type: "text" })}>
              {t("props.newProperty")}
            </MenuItem>
          </MenuContent>
        </Menu>
      )}
      {creating !== null && (
        <form
          className="wiki-props__new"
          onSubmit={(event) => {
            event.preventDefault();
            const label = creating.name.trim();
            if (label === "") return;
            const id = newId("prop");
            void onDefs([...defs, { id, name: label, type: creating.type }]).then((saved) => {
              if (!saved) return;
              setAdded((list) => [...list, id]);
              setCreating(null);
            });
          }}
        >
          <Input
            size="sm"
            aria-label={t("props.newName")}
            placeholder={t("props.newName")}
            value={creating.name}
            onChange={(event) => setCreating({ ...creating, name: event.target.value })}
          />
          <Select
            size="sm"
            aria-label={t("props.newType")}
            value={creating.type}
            onValueChange={(type) => {
              const picked = NEW_TYPES.find((each) => each === type);
              if (picked !== undefined) setCreating({ ...creating, type: picked });
            }}
          >
            {NEW_TYPES.map((type) => (
              <SelectItem key={type} value={type}>
                {t(`props.type.${type}`)}
              </SelectItem>
            ))}
          </Select>
          <Button size="sm" type="submit" variant="primary" disabled={creating.name.trim() === ""}>
            {t("props.create")}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setCreating(null)}>
            {t("props.cancel")}
          </Button>
        </form>
      )}
    </section>
  );
}
