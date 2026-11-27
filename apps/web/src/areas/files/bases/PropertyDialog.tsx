// A property of a table, new or changed: name, type and what the type needs (options and their colors,
// the status groups, a number's format, a date's time, the table a relation links to, what a rollup
// works out over a relation, and a formula with its result previewed on the first row as the person
// types, from the same engine the server runs). The title property keeps its type and stays.
import { useApiQuery } from "@vanr/client/react";
import type {
  Base,
  BasePropDef,
  BasePropOption,
  BasePropType,
  BaseRollupFn,
  BaseRow,
  BaseTable,
} from "@vanr/contract";
import { FUNCTION_NAMES } from "@vanr/engine/formula/functions";
import { ROLLUP_FNS } from "@vanr/engine/props";
import { Button, Dialog, DialogContent, Field, Input, Textarea } from "@vanr/ui";
import { type ComponentPropsWithoutRef, useDeferredValue, useId, useMemo, useState } from "react";
import { useLocale, useLookup, useMessages } from "../../../i18n/react.tsx";
import { useClock } from "../../../platform/clock.tsx";
import { formulaByName, type Names, OPTION_COLORS, previewOf, typeKey } from "./model.ts";

export const PROPERTY_TYPES: readonly BasePropType[] = [
  "text",
  "number",
  "select",
  "multi_select",
  "status",
  "date",
  "checkbox",
  "person",
  "url",
  "file",
  "relation",
  "rollup",
  "formula",
  "created_time",
  "creator",
  "edited_time",
  "editor",
];
const WITH_OPTIONS = new Set<BasePropType>(["select", "multi_select", "status"]);
const FORMATS = ["plain", "percent", "currency_brl", "currency_usd"] as const;
const GROUPS = ["todo", "inProgress", "done"] as const;
export const NAME_MAX = 100;
const FORMULA_MAX = 10_000;
const SHOWN_ERRORS = 3;

let sequence = 0;
const newId = (prefix: string) => {
  sequence += 1;
  return `${prefix}_${Date.now().toString(36)}${sequence.toString(36)}`;
};

/** A native choice under a label, wired the way the package's fields are. */
function SelectField({
  label,
  hint,
  children,
  ...props
}: { label: string; hint?: string } & ComponentPropsWithoutRef<"select">) {
  const id = useId();
  return (
    <Field label={label} controlId={id} {...(hint !== undefined && { hint })}>
      <select {...props} id={id} className="bases__select bases__select--field">
        {children}
      </select>
    </Field>
  );
}

export function PropertyDialog({
  workspaceId,
  base,
  table,
  def,
  sample,
  names,
  saving,
  error,
  onClose,
  onSave,
  onDelete,
}: {
  workspaceId: string;
  base: Base;
  table: BaseTable;
  /** null: a new property. */
  def: BasePropDef | null;
  sample: BaseRow | null;
  names: Names;
  saving: boolean;
  error: string | null;
  onClose: () => void;
  onSave: (def: BasePropDef) => void;
  onDelete?: () => void;
}) {
  const t = useMessages("files");
  const common = useMessages("common");
  const isTitle = def?.id === table.titlePropId;
  const [name, setName] = useState(def?.name ?? "");
  const [type, setType] = useState<BasePropType>(def?.type ?? "text");
  const [options, setOptions] = useState<BasePropOption[]>(def?.options ?? []);
  const [groups, setGroups] = useState(def?.groups);
  const [format, setFormat] = useState(def?.numberFormat ?? "plain");
  const [withTime, setWithTime] = useState(def?.withTime === true);
  const [relationTable, setRelationTable] = useState(def?.relation?.tableId ?? "");
  const [rollup, setRollup] = useState(
    def?.rollup ?? { relationPropId: "", targetPropId: "", fn: "count" as BaseRollupFn },
  );
  const [expression, setExpression] = useState(() =>
    def?.formula === undefined ? "" : formulaByName(def.formula.expression, table.defs),
  );
  const trimmed = name.trim();
  const taken = table.defs.some(
    (other) => other.id !== def?.id && other.name.trim().toLowerCase() === trimmed.toLowerCase(),
  );
  const incomplete =
    (type === "relation" && relationTable === "") ||
    (type === "rollup" && (rollup.relationPropId === "" || rollup.targetPropId === ""));
  const formId = useId();

  const changeType = (next: BasePropType) => {
    setType(next);
    if (next === "status" && groups === undefined) {
      const fresh =
        options.length > 0
          ? options
          : GROUPS.map((group) => ({ id: newId("opt"), name: t(`property.group.${group}`) }));
      setOptions(fresh);
      setGroups(
        options.length > 0
          ? { todo: fresh.map((option) => option.id), inProgress: [], done: [] }
          : { todo: [fresh[0]?.id ?? ""], inProgress: [fresh[1]?.id ?? ""], done: [fresh[2]?.id ?? ""] },
      );
    }
  };

  const save = () => {
    const out: BasePropDef = { id: def?.id ?? newId("prop"), name: trimmed, type };
    if (WITH_OPTIONS.has(type)) {
      out.options = options
        .filter((option) => option.name.trim() !== "")
        .map((option) => ({ ...option, name: option.name.trim() }));
      if (type === "status") {
        const ids = new Set(out.options.map((option) => option.id));
        const current = groups ?? { todo: [], inProgress: [], done: [] };
        const placed = new Set([...current.todo, ...current.inProgress, ...current.done]);
        out.groups = {
          todo: [
            ...current.todo.filter((id) => ids.has(id)),
            ...out.options.filter((option) => !placed.has(option.id)).map((option) => option.id),
          ],
          inProgress: current.inProgress.filter((id) => ids.has(id)),
          done: current.done.filter((id) => ids.has(id)),
        };
      }
    }
    if (type === "number" && format !== "plain") out.numberFormat = format;
    if (type === "date" && withTime) out.withTime = true;
    if (type === "relation") out.relation = { tableId: relationTable };
    if (type === "rollup")
      out.rollup = {
        relationPropId: rollup.relationPropId,
        targetPropId: rollup.targetPropId,
        fn: rollup.fn,
      };
    if (type === "formula") out.formula = { expression };
    onSave(out);
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        size={type === "formula" ? "lg" : "md"}
        title={def === null ? t("property.new") : t("property.edit", { name: def.name })}
        closeLabel={common("action.close")}
        footer={
          <>
            {def !== null && onDelete !== undefined && !isTitle && (
              <Button variant="danger" onClick={onDelete} disabled={saving}>
                {t("property.delete")}
              </Button>
            )}
            <Button variant="ghost" onClick={onClose}>
              {common("action.cancel")}
            </Button>
            <Button
              variant="primary"
              type="submit"
              form={formId}
              loading={saving}
              disabled={trimmed === "" || taken || incomplete}
            >
              {t("property.save")}
            </Button>
          </>
        }
      >
        <form
          id={formId}
          className="files__stack"
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          <Field label={t("property.name")} required {...(taken && { error: t("property.taken") })}>
            <Input value={name} maxLength={NAME_MAX} onChange={(event) => setName(event.target.value)} />
          </Field>
          <SelectField
            label={t("property.type")}
            {...(isTitle && { hint: t("property.titleLocked") })}
            value={type}
            disabled={isTitle}
            onChange={(event) => changeType(event.target.value as BasePropType)}
          >
            {PROPERTY_TYPES.map((each) => (
              <option key={each} value={each}>
                {t(`type.${each}`)}
              </option>
            ))}
          </SelectField>
          {type === "number" && (
            <SelectField
              label={t("property.format")}
              value={format}
              onChange={(event) => setFormat(event.target.value as (typeof FORMATS)[number])}
            >
              {FORMATS.map((each) => (
                <option key={each} value={each}>
                  {t(`format.${each}`)}
                </option>
              ))}
            </SelectField>
          )}
          {type === "date" && (
            <label className="bases__choice">
              <input
                type="checkbox"
                checked={withTime}
                onChange={(event) => setWithTime(event.target.checked)}
              />
              {t("property.withTime")}
            </label>
          )}
          {WITH_OPTIONS.has(type) && (
            <OptionsEditor
              type={type}
              options={options}
              groups={groups}
              onChange={(nextOptions, nextGroups) => {
                setOptions(nextOptions);
                setGroups(nextGroups);
              }}
            />
          )}
          {type === "relation" && (
            <RelationTarget workspaceId={workspaceId} value={relationTable} onChange={setRelationTable} />
          )}
          {type === "rollup" && (
            <RollupEditor
              workspaceId={workspaceId}
              base={base}
              table={table}
              value={rollup}
              onChange={setRollup}
            />
          )}
          {type === "formula" && (
            <FormulaEditor
              value={expression}
              onChange={setExpression}
              table={table}
              {...(def !== null && { selfId: def.id })}
              sample={sample}
              names={names}
            />
          )}
          {error !== null && (
            <p className="bases__error" role="alert">
              {error}
            </p>
          )}
        </form>
      </DialogContent>
    </Dialog>
  );
}

function OptionsEditor({
  type,
  options,
  groups,
  onChange,
}: {
  type: BasePropType;
  options: BasePropOption[];
  groups: BasePropDef["groups"];
  onChange: (options: BasePropOption[], groups: BasePropDef["groups"]) => void;
}) {
  const t = useMessages("files");
  const groupOf = (id: string) => GROUPS.find((group) => groups?.[group].includes(id)) ?? "todo";
  const setGroup = (id: string, group: (typeof GROUPS)[number]) => {
    if (groups === undefined) return;
    const next = {
      todo: groups.todo.filter((each) => each !== id),
      inProgress: groups.inProgress.filter((each) => each !== id),
      done: groups.done.filter((each) => each !== id),
    };
    next[group] = [...next[group], id];
    onChange(options, next);
  };
  const patch = (index: number, change: Partial<BasePropOption>) =>
    onChange(
      options.map((option, at) => (at === index ? { ...option, ...change } : option)),
      groups,
    );
  return (
    <fieldset className="bases__fieldset">
      <legend>{t("property.options")}</legend>
      <ul className="bases__option-list">
        {options.map((option, index) => (
          <li key={option.id} className="bases__option-row">
            <Input
              aria-label={t("property.optionName", { n: index + 1 })}
              value={option.name}
              maxLength={NAME_MAX}
              onChange={(event) => patch(index, { name: event.target.value })}
            />
            <select
              className="bases__select"
              aria-label={t("property.optionColor", { n: index + 1 })}
              value={option.color ?? "neutral"}
              onChange={(event) => patch(index, { color: event.target.value })}
            >
              {OPTION_COLORS.map((color) => (
                <option key={color} value={color}>
                  {t(`color.${color}`)}
                </option>
              ))}
            </select>
            {type === "status" && (
              <select
                className="bases__select"
                aria-label={t("property.optionGroup", { n: index + 1 })}
                value={groupOf(option.id)}
                onChange={(event) => setGroup(option.id, event.target.value as (typeof GROUPS)[number])}
              >
                {GROUPS.map((group) => (
                  <option key={group} value={group}>
                    {t(`property.group.${group}`)}
                  </option>
                ))}
              </select>
            )}
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                onChange(
                  options.filter((_, at) => at !== index),
                  groups,
                )
              }
            >
              {t("property.removeOption")}
            </Button>
          </li>
        ))}
      </ul>
      <Button
        size="sm"
        onClick={() => {
          const id = newId("opt");
          onChange(
            [...options, { id, name: "" }],
            groups === undefined ? groups : { ...groups, todo: [...groups.todo, id] },
          );
        }}
      >
        {t("property.addOption")}
      </Button>
    </fieldset>
  );
}

/** The table a relation links to: the source of any base of the workspace. */
function RelationTarget({
  workspaceId,
  value,
  onChange,
}: {
  workspaceId: string;
  value: string;
  onChange: (tableId: string) => void;
}) {
  const t = useMessages("files");
  const bases = useApiQuery("listBases", { workspaceId });
  const sources = (bases.data ?? []).filter((each) => each.kind === "database" && each.tableId !== null);
  return (
    <SelectField
      label={t("property.relationTo")}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    >
      <option value="">{t("property.chooseBase")}</option>
      {sources.map((each) => (
        <option key={each.id} value={each.tableId ?? ""}>
          {each.title}
        </option>
      ))}
    </SelectField>
  );
}

type Rollup = NonNullable<BasePropDef["rollup"]>;

/** A rollup: a relation of this table, a property of the linked table, and what to work out over it. */
function RollupEditor({
  workspaceId,
  base,
  table,
  value,
  onChange,
}: {
  workspaceId: string;
  base: Base;
  table: BaseTable;
  value: Rollup;
  onChange: (rollup: Rollup) => void;
}) {
  const t = useMessages("files");
  const relations = table.defs.filter((def) => def.type === "relation");
  const relation = relations.find((def) => def.id === value.relationPropId);
  const target = base.relationTargets.find((each) => each.tableId === relation?.relation?.tableId);
  const linked = useApiQuery(
    "getBase",
    { workspaceId, baseId: target?.databaseId ?? "" },
    { enabled: target !== undefined },
  );
  const targetDefs = linked.data?.tables.find((each) => each.id === target?.tableId)?.defs ?? [];
  if (relations.length === 0) return <p className="page__muted">{t("property.rollupNeedsRelation")}</p>;
  return (
    <div className="files__stack">
      <SelectField
        label={t("property.rollupRelation")}
        value={value.relationPropId}
        onChange={(event) => onChange({ ...value, relationPropId: event.target.value, targetPropId: "" })}
      >
        <option value="">{t("property.chooseRelation")}</option>
        {relations.map((def) => (
          <option key={def.id} value={def.id}>
            {def.name}
          </option>
        ))}
      </SelectField>
      <SelectField
        label={t("property.rollupProperty")}
        value={value.targetPropId}
        disabled={targetDefs.length === 0}
        onChange={(event) => onChange({ ...value, targetPropId: event.target.value })}
      >
        <option value="">{t("property.chooseProperty")}</option>
        {targetDefs.map((def) => (
          <option key={def.id} value={def.id}>
            {def.name}
          </option>
        ))}
      </SelectField>
      <SelectField
        label={t("property.rollupFunction")}
        value={value.fn}
        onChange={(event) => onChange({ ...value, fn: event.target.value as BaseRollupFn })}
      >
        {ROLLUP_FNS.map((fn) => (
          <option key={fn} value={fn}>
            {t(`rollup.${fn}`)}
          </option>
        ))}
      </SelectField>
    </div>
  );
}

/** Marks the part of the formula an error points at. */
function MarkedAt({ source, at }: { source: string; at: [number, number] }) {
  const start = Math.max(0, Math.min(at[0], source.length));
  const end = Math.max(start + 1, Math.min(at[1], source.length));
  return (
    <code className="bases__formula-mark">
      {source.slice(0, start)}
      <mark>{source.slice(start, end) || " "}</mark>
      {source.slice(end)}
    </code>
  );
}

export function FormulaEditor({
  value,
  onChange,
  table,
  selfId,
  sample,
  names,
}: {
  value: string;
  onChange: (value: string) => void;
  table: BaseTable;
  selfId?: string;
  sample: BaseRow | null;
  names: Names;
}) {
  const t = useMessages("files");
  const lookup = useLookup("files");
  const { locale } = useLocale();
  const clock = useClock();
  const deferred = useDeferredValue(value);
  const preview = useMemo(
    () =>
      previewOf(deferred, table.defs, sample, {
        now: clock.now(),
        names,
        locale,
        ...(selfId !== undefined && { selfId }),
      }),
    [deferred, table.defs, sample, names, locale, selfId, clock],
  );
  const insert = (snippet: string) =>
    onChange(value === "" ? snippet : `${value}${value.endsWith(" ") ? "" : " "}${snippet}`);
  const typeLabel = (type: string) => lookup(`formula.type.${typeKey(type)}`) ?? type;
  const id = useId();
  return (
    <div className="files__stack">
      <Field label={t("formula.label")} hint={t("formula.help")}>
        <Textarea
          className="bases__formula"
          value={value}
          spellCheck={false}
          rows={4}
          maxLength={FORMULA_MAX}
          aria-describedby={id}
          onChange={(event) => onChange(event.target.value)}
        />
      </Field>
      <output id={id} className="bases__preview" aria-live="polite">
        {preview.kind === "errors" ? (
          <ul className="bases__formula-errors">
            {preview.errors.slice(0, SHOWN_ERRORS).map((each) => (
              <li key={`${each.code}:${each.at[0]}`}>
                <strong>
                  {lookup(`formula.error.${each.code}`, { name: String(each.detail?.name ?? "") }) ??
                    t("formula.error.other", { code: each.code })}
                </strong>
                <MarkedAt source={deferred} at={each.at} />
              </li>
            ))}
          </ul>
        ) : (
          <>
            <span>{t("formula.result", { type: typeLabel(preview.type) })}</span>
            <span>
              {preview.kind === "runtime"
                ? (lookup(`formula.runtime.${preview.code}`) ??
                  t("formula.error.other", { code: preview.code }))
                : sample === null
                  ? t("formula.noSample")
                  : t("formula.preview", { value: preview.text === "" ? "—" : preview.text })}
            </span>
          </>
        )}
      </output>
      <details className="bases__refs">
        <summary>{t("formula.properties")}</summary>
        <div className="bases__chips">
          {table.defs
            .filter((def) => def.id !== selfId)
            .map((def) => (
              <button
                key={def.id}
                type="button"
                className="files__operator"
                onClick={() => insert(`prop("${def.name}")`)}
              >
                {def.name}
              </button>
            ))}
        </div>
      </details>
      <details className="bases__refs">
        <summary>{t("formula.functions")}</summary>
        <div className="bases__chips">
          {FUNCTION_NAMES.map((fn) => (
            <button key={fn} type="button" className="files__operator" onClick={() => insert(`${fn}(`)}>
              {fn}
            </button>
          ))}
        </div>
      </details>
    </div>
  );
}
