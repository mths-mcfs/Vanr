// Reading and editing one cell. Text and links save on leaving the field or on Enter, and Escape puts
// the old value back; a number takes a comma or a dot and refuses anything that is not a finite number;
// a choice saves when picked; several choices (options, people, files, linked rows) are picked in a
// dialog and saved together; dates take a start and keep a day as a day. Computed values only show.
import { useApiQuery, useVanrClient } from "@vanr/client/react";
import type { ActorRef, BaseLinkedRow, BasePropDef, BaseRelationTarget, BaseRow } from "@vanr/contract";
import { Button, Callout, Dialog, DialogContent, Input } from "@vanr/ui";
import { useEffect, useState } from "react";
import { useLocale, useMessages } from "../../../i18n/react.tsx";
import {
  type CellContext,
  cellText,
  computedError,
  isComputed,
  optionColor,
  optionName,
  rawCell,
  relationIds,
} from "./model.ts";

/** The longest text a title or a text cell takes. */
export const TEXT_MAX = 2000;
const PICKER_LIMIT = 30;

export type CellProps = {
  workspaceId: string;
  def: BasePropDef;
  row: BaseRow;
  context: CellContext;
  /** The row's title, to name the control ("Status of Wash"). */
  rowTitle: string;
  relationTargets: readonly BaseRelationTarget[];
  onSave: (value: unknown) => void;
};

/** A cell as text, with the options drawn as colored marks and a formula's error named. */
export function CellValue({ def, row, context }: Pick<CellProps, "def" | "row" | "context">) {
  const t = useMessages("files");
  const value = rawCell(def, row);
  const failed = isComputed(def) ? computedError(value) : null;
  if (failed !== null) return <span className="bases__error">{t("cell.error")}</span>;
  if ((def.type === "select" || def.type === "status") && typeof value === "string") {
    return <Option def={def} id={value} />;
  }
  if (def.type === "multi_select" && Array.isArray(value)) {
    return (
      <span className="bases__options">
        {value.map((id) => (
          <Option key={String(id)} def={def} id={String(id)} />
        ))}
      </span>
    );
  }
  if (def.type === "url" && typeof value === "string" && /^https?:\/\//i.test(value)) {
    return (
      <a className="app-link" href={value} target="_blank" rel="noreferrer noopener">
        {value}
      </a>
    );
  }
  return <span>{cellText(def, row, context)}</span>;
}

function Option({ def, id }: { def: BasePropDef; id: string }) {
  return (
    <span className="bases__option" data-color={optionColor(def, id)}>
      {optionName(def, id)}
    </span>
  );
}

/** The control that edits a cell in place, by the property's type. */
export function CellEditor(props: CellProps) {
  const t = useMessages("files");
  const { def, row, rowTitle, onSave } = props;
  const label = t("cell.label", { prop: def.name, row: rowTitle === "" ? t("row.untitled") : rowTitle });
  const value = rawCell(def, row);
  if (isComputed(def)) return <CellValue def={def} row={row} context={props.context} />;
  switch (def.type) {
    case "text":
    case "url":
      return <TextCell label={label} value={typeof value === "string" ? value : ""} onSave={onSave} />;
    case "number":
      return <NumberCell label={label} value={typeof value === "number" ? value : null} onSave={onSave} />;
    case "checkbox":
      return (
        <input
          type="checkbox"
          className="bases__check"
          aria-label={label}
          checked={value === true}
          onChange={(event) => onSave(event.target.checked)}
        />
      );
    case "select":
    case "status":
      return (
        <select
          className="bases__select"
          aria-label={label}
          value={typeof value === "string" ? value : ""}
          onChange={(event) => onSave(event.target.value === "" ? null : event.target.value)}
        >
          <option value="">{t("cell.none")}</option>
          {(def.options ?? []).map((option) => (
            <option key={option.id} value={option.id}>
              {option.name}
            </option>
          ))}
        </select>
      );
    case "date":
      return <DateCell label={label} def={def} value={value} onSave={onSave} />;
    case "multi_select":
    case "person":
    case "file":
    case "relation":
      return <PickCell {...props} label={label} />;
    default:
      return <CellValue def={def} row={row} context={props.context} />;
  }
}

function TextCell({
  label,
  value,
  onSave,
}: {
  label: string;
  value: string;
  onSave: (value: unknown) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    if (draft !== value) onSave(draft);
  };
  return (
    <input
      className="bases__input"
      aria-label={label}
      value={draft}
      maxLength={TEXT_MAX}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") {
          setDraft(value);
          event.currentTarget.blur();
        }
      }}
    />
  );
}

/** A number typed with a comma or a dot: null when empty, undefined when it is not a finite number. */
export function parseNumber(text: string): number | null | undefined {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed.replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : undefined;
}

/** A number as the person types it in the interface language: a comma in Portuguese, never grouped. */
export function formatEditable(n: number, locale: string): string {
  return new Intl.NumberFormat(locale, { useGrouping: false, maximumFractionDigits: 20 }).format(n);
}

function NumberCell({
  label,
  value,
  onSave,
}: {
  label: string;
  value: number | null;
  onSave: (value: unknown) => void;
}) {
  const { locale } = useLocale();
  const shown = value === null ? "" : formatEditable(value, locale);
  const [draft, setDraft] = useState(shown);
  useEffect(() => setDraft(shown), [shown]);
  const commit = () => {
    const parsed = parseNumber(draft);
    if (parsed === undefined) return setDraft(shown);
    if (parsed !== value) onSave(parsed);
  };
  return (
    <input
      className="bases__input bases__input--number"
      inputMode="decimal"
      aria-label={label}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") {
          setDraft(shown);
          event.currentTarget.blur();
        }
      }}
    />
  );
}

/** An instant as the local "YYYY-MM-DDTHH:mm" a datetime field shows (the field has no time zone). */
export function localInstant(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function DateCell({
  label,
  def,
  value,
  onSave,
}: {
  label: string;
  def: BasePropDef;
  value: unknown;
  onSave: (value: unknown) => void;
}) {
  const range =
    typeof value === "object" && value !== null ? (value as { start?: string; end?: string }) : {};
  const withTime = def.withTime === true;
  const shown =
    range.start === undefined ? "" : withTime ? localInstant(range.start) : range.start.slice(0, 10);
  return (
    <input
      className="bases__input"
      type={withTime ? "datetime-local" : "date"}
      aria-label={label}
      value={shown}
      onChange={(event) => {
        const next = event.target.value;
        if (next === "") return onSave(null);
        const start = withTime ? new Date(next).toISOString() : next;
        onSave(range.end === undefined ? { start } : { start, end: range.end });
      }}
    />
  );
}

type Choice = { id: string; name: string };

/** Several choices: options, people and agents, files or rows of another table, picked in a dialog. */
function PickCell(props: CellProps & { label: string }) {
  const t = useMessages("files");
  const common = useMessages("common");
  const { def, row, label, onSave } = props;
  const [open, setOpen] = useState(false);
  const value = rawCell(def, row);
  const text = cellText(def, row, props.context);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <button type="button" className="bases__pick" aria-label={label} onClick={() => setOpen(true)}>
        {def.type === "multi_select" ? <CellValue def={def} row={row} context={props.context} /> : text}
        {text === "" && <span className="bases__placeholder">{t("cell.choose")}</span>}
      </button>
      {open && (
        <DialogContent title={label} closeLabel={common("action.close")}>
          <Picker
            {...props}
            initial={def.type === "person" ? actorIds(value) : relationIds(value)}
            onDone={(ids) => {
              setOpen(false);
              onSave(def.type === "person" ? ids.map(toActor) : ids);
            }}
          />
        </DialogContent>
      )}
    </Dialog>
  );
}

const actorIds = (value: unknown) =>
  Array.isArray(value)
    ? value.flatMap((each: unknown) =>
        typeof each === "object" && each !== null && "type" in each && "id" in each
          ? [`${(each as ActorRef).type}:${(each as ActorRef).id}`]
          : [],
      )
    : [];
const toActor = (key: string): ActorRef => {
  const [type, ...rest] = key.split(":");
  return { type: type === "agent" ? "agent" : "person", id: rest.join(":") };
};

function Picker(props: CellProps & { initial: string[]; onDone: (ids: string[]) => void }) {
  const t = useMessages("files");
  const common = useMessages("common");
  const [chosen, setChosen] = useState(props.initial);
  const [query, setQuery] = useState("");
  const choices = useChoices(props, query.trim());
  const searchable = props.def.type === "file" || props.def.type === "relation";
  return (
    <div className="bases__picker">
      {searchable && (
        <Input
          type="search"
          aria-label={t("cell.search")}
          placeholder={t("cell.search")}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      )}
      {choices.state === "failed" ? (
        <Callout
          tone="danger"
          role="alert"
          actions={
            <Button size="sm" onClick={choices.retry}>
              {common("action.retry")}
            </Button>
          }
        >
          {t("cell.failed")}
        </Callout>
      ) : choices.state === "loading" ? (
        <p className="page__muted" role="status">
          {t("cell.loading")}
        </p>
      ) : choices.items.length === 0 ? (
        <p className="page__muted">{t("cell.nothing")}</p>
      ) : (
        <ul className="bases__choices" aria-label={t("cell.choices")}>
          {choices.items.map((choice) => (
            <li key={choice.id}>
              <label className="bases__choice">
                <input
                  type="checkbox"
                  checked={chosen.includes(choice.id)}
                  onChange={(event) =>
                    setChosen(
                      event.target.checked ? [...chosen, choice.id] : chosen.filter((id) => id !== choice.id),
                    )
                  }
                />
                {choice.name}
              </label>
            </li>
          ))}
        </ul>
      )}
      <div className="files__actions">
        <Button variant="primary" onClick={() => props.onDone(chosen)}>
          {t("cell.done")}
        </Button>
      </div>
    </div>
  );
}

/** What a picker offers, by the property's type. */
function useChoices(
  props: CellProps,
  query: string,
): { state: "loading" | "ready" | "failed"; items: Choice[]; retry?: () => void } {
  const { def, workspaceId } = props;
  const client = useVanrClient();
  const members = useApiQuery("listMembers", { workspaceId }, { enabled: def.type === "person" });
  const agents = useApiQuery("listAgents", { workspaceId }, { enabled: def.type === "person" });
  const files = useApiQuery(
    "listFiles",
    { workspaceId, ...(query !== "" && { query: { q: query } }) },
    { enabled: def.type === "file" },
  );
  const target = props.relationTargets.find((each) => each.tableId === def.relation?.tableId);
  const [rows, setRows] = useState<{ items: Choice[]; linked: Record<string, BaseLinkedRow> } | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (def.type !== "relation" || target === undefined) return;
    const controller = new AbortController();
    void client.api
      .createBaseTableQuery(
        {
          workspaceId,
          baseId: target.databaseId,
          tableId: target.tableId,
          body: { limit: PICKER_LIMIT, ...(query !== "" && { search: query }) },
        },
        { signal: controller.signal },
      )
      .then((result) =>
        setRows({
          items: result.rows.map((each) => ({
            id: each.id,
            name: String(each.props[target.titlePropId] ?? ""),
          })),
          linked: result.linked ?? {},
        }),
      )
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    setFailed(false);
    return () => controller.abort();
  }, [client, workspaceId, def.type, target, query, attempt]);
  const retry = () => setAttempt((n) => n + 1);

  switch (def.type) {
    case "multi_select":
      return {
        state: "ready",
        items: (def.options ?? []).map((option) => ({ id: option.id, name: option.name })),
      };
    case "person":
      if (members.isPending || agents.isPending) return { state: "loading", items: [] };
      return {
        state: "ready",
        items: [
          ...(members.data ?? []).map((member) => ({ id: `person:${member.userId}`, name: member.name })),
          ...(agents.data ?? []).map((agent) => ({ id: `agent:${agent.id}`, name: agent.name })),
        ],
      };
    case "file":
      if (files.isPending) return { state: "loading", items: [] };
      return {
        state: "ready",
        items: (files.data ?? []).slice(0, PICKER_LIMIT).map((file) => ({ id: file.id, name: file.title })),
      };
    case "relation":
      if (failed) return { state: "failed", items: [], retry };
      return rows === null ? { state: "loading", items: [] } : { state: "ready", items: rows.items };
    default:
      return { state: "ready", items: [] };
  }
}
