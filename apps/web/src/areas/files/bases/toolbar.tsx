// What a view shows: conditions joined by "all" or "any", up to ten sorts, one group, and which
// properties are visible. Every choice is saved in the view, so everyone who opens it sees the same.
import type { BaseFilterCondition, BaseSort, BaseTable, BaseViewConfig } from "@vanr/contract";
import { Button, Dialog, DialogContent } from "@vanr/ui";
import { useState } from "react";
import { useLookup, useMessages } from "../../../i18n/react.tsx";
import {
  flatFilter,
  isHidden,
  newCondition,
  operatorsFor,
  takesNoValue,
  toFilter,
  toggleColumn,
} from "./model.ts";

export type Panel = "filter" | "sort" | "group" | "properties";
const SORTS_MAX = 10;

export function ViewPanel({
  panel,
  table,
  config,
  onChange,
  onClose,
}: {
  panel: Panel;
  table: BaseTable;
  config: BaseViewConfig;
  onChange: (config: BaseViewConfig) => void;
  onClose: () => void;
}) {
  const t = useMessages("files");
  const common = useMessages("common");
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent title={t(`panel.${panel}`)} closeLabel={common("action.close")}>
        {panel === "filter" && <FilterPanel table={table} config={config} onChange={onChange} />}
        {panel === "sort" && <SortPanel table={table} config={config} onChange={onChange} />}
        {panel === "group" && <GroupPanel table={table} config={config} onChange={onChange} />}
        {panel === "properties" && <PropertiesPanel table={table} config={config} onChange={onChange} />}
      </DialogContent>
    </Dialog>
  );
}

type PanelProps = { table: BaseTable; config: BaseViewConfig; onChange: (config: BaseViewConfig) => void };

/** A condition's value, by what the operator and the property need. */
function ConditionValue({
  table,
  condition,
  onChange,
}: {
  table: BaseTable;
  condition: BaseFilterCondition;
  onChange: (condition: BaseFilterCondition) => void;
}) {
  const t = useMessages("files");
  const def = table.defs.find((each) => each.id === condition.prop);
  if (def === undefined || takesNoValue(condition.op)) return null;
  const label = t("filter.value", { prop: def.name });
  if (def.type === "checkbox") {
    return (
      <select
        className="bases__select"
        aria-label={label}
        value={condition.value === true ? "true" : "false"}
        onChange={(event) => onChange({ ...condition, value: event.target.value === "true" })}
      >
        <option value="true">{t("board.checked")}</option>
        <option value="false">{t("board.unchecked")}</option>
      </select>
    );
  }
  if (def.options !== undefined) {
    return (
      <select
        className="bases__select"
        aria-label={label}
        value={typeof condition.value === "string" ? condition.value : ""}
        onChange={(event) => onChange({ ...condition, value: event.target.value })}
      >
        {def.options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.name}
          </option>
        ))}
      </select>
    );
  }
  if (def.type === "person" || def.type === "creator" || def.type === "editor") {
    return <span className="files__meta">{t("filter.me")}</span>;
  }
  const number = def.type === "number";
  return (
    <input
      className="bases__input bases__input--boxed"
      aria-label={label}
      inputMode={number ? "decimal" : undefined}
      type={def.type === "date" ? "date" : "text"}
      value={
        typeof condition.value === "string" || typeof condition.value === "number"
          ? String(condition.value)
          : ""
      }
      onChange={(event) => {
        const text = event.target.value;
        if (def.type === "date")
          return onChange({ ...condition, value: text === "" ? { rel: "today" } : text });
        onChange({ ...condition, value: number ? Number(text.replace(",", ".")) || 0 : text });
      }}
    />
  );
}

function FilterPanel({ table, config, onChange }: PanelProps) {
  const t = useMessages("files");
  const lookup = useLookup("files");
  const { mode, conditions } = flatFilter(config.filter);
  const write = (nextMode: "and" | "or", next: BaseFilterCondition[]) =>
    onChange({ ...config, filter: toFilter(nextMode, next) });
  const first = table.defs[0];
  return (
    <div className="files__stack">
      {conditions.length > 1 && (
        <label className="bases__inline">
          {t("filter.match")}
          <select
            className="bases__select"
            value={mode}
            onChange={(event) => write(event.target.value as "and" | "or", conditions)}
          >
            <option value="and">{t("filter.all")}</option>
            <option value="or">{t("filter.any")}</option>
          </select>
        </label>
      )}
      {conditions.length === 0 && <p className="page__muted">{t("filter.none")}</p>}
      <ul className="bases__conditions" aria-label={t("panel.filter")}>
        {conditions.map((condition, index) => {
          const def = table.defs.find((each) => each.id === condition.prop);
          const replace = (next: BaseFilterCondition) =>
            write(
              mode,
              conditions.map((each, at) => (at === index ? next : each)),
            );
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: a condition has no id; it is its place in the list.
            <li key={index} className="bases__condition">
              <select
                className="bases__select"
                aria-label={t("filter.prop", { n: index + 1 })}
                value={condition.prop}
                onChange={(event) => {
                  const next = table.defs.find((each) => each.id === event.target.value);
                  if (next !== undefined) replace(newCondition(next));
                }}
              >
                {table.defs.map((each) => (
                  <option key={each.id} value={each.id}>
                    {each.name}
                  </option>
                ))}
              </select>
              {def !== undefined && (
                <select
                  className="bases__select"
                  aria-label={t("filter.op", { n: index + 1 })}
                  value={condition.op}
                  onChange={(event) => replace({ ...condition, op: event.target.value })}
                >
                  {operatorsFor(def).map((op) => (
                    <option key={op} value={op}>
                      {lookup(`op.${op}`) ?? op}
                    </option>
                  ))}
                </select>
              )}
              <ConditionValue table={table} condition={condition} onChange={replace} />
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  write(
                    mode,
                    conditions.filter((_, at) => at !== index),
                  )
                }
              >
                {t("filter.remove")}
              </Button>
            </li>
          );
        })}
      </ul>
      {first !== undefined && (
        <Button size="sm" onClick={() => write(mode, [...conditions, newCondition(first)])}>
          {t("filter.add")}
        </Button>
      )}
    </div>
  );
}

function SortPanel({ table, config, onChange }: PanelProps) {
  const t = useMessages("files");
  const sorts = config.sorts ?? [];
  const write = (next: BaseSort[]) => onChange({ ...config, sorts: next });
  const unused = table.defs.find((def) => !sorts.some((sort) => sort.prop === def.id));
  return (
    <div className="files__stack">
      {sorts.length === 0 && <p className="page__muted">{t("sort.none")}</p>}
      <ol className="bases__conditions" aria-label={t("panel.sort")}>
        {sorts.map((sort, index) => (
          <li key={sort.prop} className="bases__condition">
            <select
              className="bases__select"
              aria-label={t("sort.prop", { n: index + 1 })}
              value={sort.prop}
              onChange={(event) =>
                write(sorts.map((each, at) => (at === index ? { ...each, prop: event.target.value } : each)))
              }
            >
              {table.defs.map((def) => (
                <option key={def.id} value={def.id}>
                  {def.name}
                </option>
              ))}
            </select>
            <select
              className="bases__select"
              aria-label={t("sort.dir", { n: index + 1 })}
              value={sort.dir}
              onChange={(event) =>
                write(
                  sorts.map((each, at) =>
                    at === index ? { ...each, dir: event.target.value as "asc" | "desc" } : each,
                  ),
                )
              }
            >
              <option value="asc">{t("sort.asc")}</option>
              <option value="desc">{t("sort.desc")}</option>
            </select>
            <Button size="sm" variant="ghost" onClick={() => write(sorts.filter((_, at) => at !== index))}>
              {t("filter.remove")}
            </Button>
          </li>
        ))}
      </ol>
      {unused !== undefined && sorts.length < SORTS_MAX && (
        <Button size="sm" onClick={() => write([...sorts, { prop: unused.id, dir: "asc" }])}>
          {t("sort.add")}
        </Button>
      )}
    </div>
  );
}

function GroupPanel({ table, config, onChange }: PanelProps) {
  const t = useMessages("files");
  const choices = table.defs.filter(
    (def) => def.type !== "multi_select" && def.type !== "file" && def.type !== "relation",
  );
  const [hideEmpty, setHideEmpty] = useState(config.groupBy?.hideEmpty === true);
  const prop = config.groupBy?.prop ?? "";
  return (
    <div className="files__stack">
      <label className="bases__inline">
        {t("group.by")}
        <select
          className="bases__select"
          value={prop}
          onChange={(event) =>
            onChange({
              ...config,
              groupBy: event.target.value === "" ? null : { prop: event.target.value, hideEmpty },
            })
          }
        >
          <option value="">{t("group.none")}</option>
          {choices.map((def) => (
            <option key={def.id} value={def.id}>
              {def.name}
            </option>
          ))}
        </select>
      </label>
      {prop !== "" && (
        <label className="bases__choice">
          <input
            type="checkbox"
            checked={hideEmpty}
            onChange={(event) => {
              setHideEmpty(event.target.checked);
              onChange({ ...config, groupBy: { prop, hideEmpty: event.target.checked } });
            }}
          />
          {t("group.hideEmpty")}
        </label>
      )}
    </div>
  );
}

function PropertiesPanel({ table, config, onChange }: PanelProps) {
  const t = useMessages("files");
  return (
    <ul className="bases__conditions" aria-label={t("panel.properties")}>
      {table.defs.map((def) => (
        <li key={def.id}>
          <label className="bases__choice">
            <input
              type="checkbox"
              checked={!isHidden(config, def.id)}
              disabled={def.id === table.titlePropId}
              onChange={() => onChange(toggleColumn(table, config, def.id))}
            />
            {def.name}
          </label>
        </li>
      ))}
    </ul>
  );
}
