// The four ways a view shows rows. The grid edits cells in place and opens a row from its title; the
// board needs a group and moves a card to another column by dragging it (or by its own control); the
// list shows up to four properties and a gallery card two, or six when large. With a group, each one
// shows a section per group with its count and a new row that starts in that group when it can.
import type { BasePropDef, BaseRelationTarget, BaseRow, BaseTable, BaseView } from "@vanr/contract";
import { Button, Icon } from "@vanr/ui";
import { Maximize2, Plus } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useState } from "react";
import { useMessages } from "../../../i18n/react.tsx";
import { CellEditor, CellValue } from "./cells.tsx";
import {
  type CellContext,
  cellText,
  groupable,
  groupKeyOf,
  groupRows,
  isComputed,
  isTabular,
  optionColor,
  optionName,
  valueForGroup,
  viewColumns,
} from "./model.ts";

export type ViewProps = {
  workspaceId: string;
  table: BaseTable;
  view: BaseView;
  rows: BaseRow[];
  context: CellContext;
  relationTargets: readonly BaseRelationTarget[];
  onOpen: (row: BaseRow) => void;
  onSave: (row: BaseRow, propId: string, value: unknown) => void;
  onNewRow: (props?: Record<string, unknown>) => void;
  /** The grid's column headers open their property. */
  onEditProperty: (def: BasePropDef) => void;
  /** The view's name as shown (a nameless view goes by its type). */
  name: string;
};

const titleOf = (table: BaseTable, row: BaseRow) => {
  const value = row.props[table.titlePropId];
  return typeof value === "string" ? value : "";
};

type Group = {
  key: string | null;
  label: string;
  rows: BaseRow[];
  color: string | undefined;
  newProps: Record<string, unknown> | undefined;
};

/** The view's groups, or one group of every row when it has none. */
function useGroups(props: ViewProps): { def: BasePropDef | undefined; groups: Group[]; every: Group[] } {
  const t = useMessages("files");
  const def = props.table.defs.find((each) => each.id === props.view.config.groupBy?.prop);
  if (def === undefined) {
    const all = [{ key: null, label: "", rows: props.rows, color: undefined, newProps: undefined }];
    return { def, groups: all, every: all };
  }
  const label = (key: string | null, rows: BaseRow[]) => {
    if (key === null) return t("board.none", { prop: def.name });
    if (def.type === "checkbox") return key === "true" ? t("board.checked") : t("board.unchecked");
    if (def.type === "select" || def.type === "status") return optionName(def, key);
    const sample = rows[0];
    return sample === undefined ? key : cellText(def, sample, props.context);
  };
  const every = groupRows(def, props.rows).map((group) => {
    const value = groupable(def) ? valueForGroup(def, group.key) : undefined;
    return {
      ...group,
      label: label(group.key, group.rows),
      color:
        group.key !== null && (def.type === "select" || def.type === "status")
          ? optionColor(def, group.key)
          : undefined,
      newProps: value === undefined || value === null ? undefined : { [def.id]: value },
    };
  });
  const groups = every.filter(
    (group) => props.view.config.groupBy?.hideEmpty !== true || group.rows.length > 0,
  );
  return { def, groups, every };
}

/** A group's heading: its name, how many rows, and a new row that starts in it. */
function GroupHead({ group, onNewRow }: { group: Group; onNewRow: ViewProps["onNewRow"] }) {
  const t = useMessages("files");
  return (
    <div className="bases__group-head" data-color={group.color}>
      <h3 className="bases__column-title">
        {group.label} <span className="files__meta">{group.rows.length}</span>
      </h3>
      <Button
        size="sm"
        variant="ghost"
        icon={<Icon icon={Plus} />}
        aria-label={t("row.newIn", { group: group.label })}
        onClick={() => onNewRow(group.newProps)}
      />
    </div>
  );
}

/** Delete or Backspace on a focused cell that is not a text field empties it. */
const clearOnDelete =
  (def: BasePropDef, save: (value: unknown) => void) => (event: KeyboardEvent<HTMLTableCellElement>) => {
    if (event.key !== "Delete" && event.key !== "Backspace") return;
    if (isComputed(def)) return;
    // Only the control that edits this cell counts: not the button that opens the row, not a text
    // field (where the keys edit the text), not a dialog opened from the cell.
    const target = event.target as HTMLElement;
    if (!event.currentTarget.contains(target) || target.dataset.cellEditor !== "clearable") return;
    event.preventDefault();
    save(def.type === "checkbox" ? false : null);
  };

export function TableView(props: ViewProps) {
  const t = useMessages("files");
  const { table, view } = props;
  const columns = viewColumns(table, view.config);
  const { def: grouped, groups } = useGroups(props);
  const row = (each: BaseRow) => {
    const title = titleOf(table, each);
    return (
      <tr key={each.id}>
        {columns.map((def) => {
          const save = (value: unknown) => props.onSave(each, def.id, value);
          const editor = <CellEditor {...props} def={def} row={each} rowTitle={title} onSave={save} />;
          return (
            <td
              key={def.id}
              className={isTabular(def) ? "bases__num" : undefined}
              onKeyDown={clearOnDelete(def, save)}
            >
              {def.id === table.titlePropId ? (
                <div className="bases__title-cell">
                  {editor}
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<Icon icon={Maximize2} />}
                    aria-label={t("row.open", { title: title === "" ? t("row.untitled") : title })}
                    onClick={() => props.onOpen(each)}
                  />
                </div>
              ) : (
                editor
              )}
            </td>
          );
        })}
      </tr>
    );
  };
  return (
    <div className="bases__scroll">
      <table className="bases__grid" aria-label={props.name}>
        <thead>
          <tr>
            {columns.map((def) => (
              <th key={def.id} scope="col" className={isTabular(def) ? "bases__num" : undefined}>
                <button
                  type="button"
                  className="bases__header"
                  aria-label={t("property.editNamed", { name: def.name })}
                  onClick={() => props.onEditProperty(def)}
                >
                  {def.name}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        {grouped === undefined ? (
          <tbody>{props.rows.map(row)}</tbody>
        ) : (
          groups.map((group) => (
            <tbody key={group.key ?? "none"} aria-label={group.label}>
              <tr>
                <th scope="rowgroup" colSpan={columns.length}>
                  <GroupHead group={group} onNewRow={props.onNewRow} />
                </th>
              </tr>
              {group.rows.map(row)}
            </tbody>
          ))
        )}
      </table>
      {grouped === undefined && (
        <Button size="sm" variant="ghost" icon={<Icon icon={Plus} />} onClick={() => props.onNewRow()}>
          {t("row.new")}
        </Button>
      )}
    </div>
  );
}

function Card({ props, row, shown }: { props: ViewProps; row: BaseRow; shown: BasePropDef[] }) {
  const t = useMessages("files");
  const title = titleOf(props.table, row);
  return (
    <>
      <button type="button" className="bases__card-title" onClick={() => props.onOpen(row)}>
        {title === "" ? t("row.untitled") : title}
      </button>
      {shown.map((def) =>
        cellText(def, row, props.context) === "" ? null : (
          <span key={def.id} className="bases__card-prop">
            <span className="vr-visually-hidden">{def.name}: </span>
            <CellValue def={def} row={row} context={props.context} />
          </span>
        ),
      )}
    </>
  );
}

const others = (props: ViewProps) =>
  viewColumns(props.table, props.view.config).filter((def) => def.id !== props.table.titlePropId);

/** List and gallery: the same rows as items or cards, one section per group when there are groups. */
function Items({
  props,
  className,
  itemClass,
  shown,
}: {
  props: ViewProps;
  className: string;
  itemClass: string;
  shown: BasePropDef[];
}) {
  const t = useMessages("files");
  const { def: grouped, groups } = useGroups(props);
  const items = (rows: BaseRow[], label: string): ReactNode => (
    <ul className={className} aria-label={label}>
      {rows.map((row) => (
        <li key={row.id} className={itemClass}>
          <Card props={props} row={row} shown={shown} />
        </li>
      ))}
    </ul>
  );
  if (grouped === undefined) {
    return (
      <>
        {items(props.rows, props.name)}
        <Button size="sm" variant="ghost" icon={<Icon icon={Plus} />} onClick={() => props.onNewRow()}>
          {t("row.new")}
        </Button>
      </>
    );
  }
  return (
    <>
      {groups.map((group) => (
        <section key={group.key ?? "none"} className="bases__group" aria-label={group.label}>
          <GroupHead group={group} onNewRow={props.onNewRow} />
          {items(group.rows, group.label)}
        </section>
      ))}
    </>
  );
}

export function ListView(props: ViewProps) {
  return (
    <Items props={props} className="bases__items" itemClass="bases__item" shown={others(props).slice(0, 4)} />
  );
}

export function GalleryView(props: ViewProps) {
  const shown = others(props).slice(0, props.view.config.cardSize === "large" ? 6 : 2);
  return <Items props={props} className="bases__gallery" itemClass="bases__card" shown={shown} />;
}

export function BoardView(props: ViewProps) {
  const t = useMessages("files");
  const { table, rows } = props;
  const [dragging, setDragging] = useState<string | null>(null);
  const { def, groups, every } = useGroups(props);
  if (def === undefined) return <p className="page__muted">{t("board.needsGroup")}</p>;
  const movable = groupable(def);
  const shown = others(props)
    .filter((each) => each.id !== def.id)
    .slice(0, 3);
  const move = (row: BaseRow, key: string | null) => {
    const value = valueForGroup(def, key);
    if (value !== undefined && groupKeyOf(def, row) !== key) props.onSave(row, def.id, value);
  };
  return (
    <section className="bases__board" aria-label={props.name}>
      {groups.map((group) => (
        <section
          key={group.key ?? "none"}
          className="bases__column"
          aria-label={group.label}
          data-color={group.color}
          onDragOver={(event) => {
            if (movable && dragging !== null) event.preventDefault();
          }}
          onDrop={(event) => {
            event.preventDefault();
            const row = rows.find((each) => each.id === dragging);
            setDragging(null);
            if (row !== undefined) move(row, group.key);
          }}
        >
          <h3 className="bases__column-title">
            {group.label} <span className="files__meta">{group.rows.length}</span>
          </h3>
          <ul className="bases__cards">
            {group.rows.map((row) => (
              <li
                key={row.id}
                className="bases__card"
                draggable={movable}
                onDragStart={() => setDragging(row.id)}
                onDragEnd={() => setDragging(null)}
              >
                <Card props={props} row={row} shown={shown} />
                {movable && (
                  <select
                    className="bases__select bases__card-move"
                    aria-label={t("board.move", { title: titleOf(table, row) || t("row.untitled") })}
                    value={group.key ?? ""}
                    onChange={(event) => move(row, event.target.value === "" ? null : event.target.value)}
                  >
                    {every.map((each) => (
                      <option key={each.key ?? "none"} value={each.key ?? ""}>
                        {each.label}
                      </option>
                    ))}
                  </select>
                )}
              </li>
            ))}
          </ul>
          {movable && (
            <Button
              size="sm"
              variant="ghost"
              icon={<Icon icon={Plus} />}
              onClick={() => props.onNewRow(group.newProps)}
            >
              {t("row.new")}
            </Button>
          )}
        </section>
      ))}
    </section>
  );
}
