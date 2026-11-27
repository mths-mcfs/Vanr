// The four ways a view shows rows. The grid edits cells in place and opens a row from its title; the
// board needs a group and moves a card to another column by dragging it (or by its own control); the
// list shows up to four properties and a gallery card two, or six when large. Each one opens a row's panel
// and adds a row.
import type { BasePropDef, BaseRelationTarget, BaseRow, BaseTable, BaseView } from "@vanr/contract";
import { Button, Icon } from "@vanr/ui";
import { Maximize2, Plus } from "lucide-react";
import { useState } from "react";
import { useMessages } from "../../../i18n/react.tsx";
import { CellEditor, CellValue } from "./cells.tsx";
import {
  type CellContext,
  cellText,
  groupable,
  groupKeyOf,
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
  groups: { key: string | null; count: number }[] | undefined;
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

export function TableView(props: ViewProps) {
  const t = useMessages("files");
  const { table, view, rows } = props;
  const columns = viewColumns(table, view.config);
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
        <tbody>
          {rows.map((row) => {
            const title = titleOf(table, row);
            return (
              <tr key={row.id}>
                {columns.map((def) => (
                  <td key={def.id} className={isTabular(def) ? "bases__num" : undefined}>
                    {def.id === table.titlePropId ? (
                      <div className="bases__title-cell">
                        <CellEditor
                          {...props}
                          def={def}
                          row={row}
                          rowTitle={title}
                          onSave={(value) => props.onSave(row, def.id, value)}
                        />
                        <Button
                          size="sm"
                          variant="ghost"
                          icon={<Icon icon={Maximize2} />}
                          aria-label={t("row.open", { title: title === "" ? t("row.untitled") : title })}
                          onClick={() => props.onOpen(row)}
                        />
                      </div>
                    ) : (
                      <CellEditor
                        {...props}
                        def={def}
                        row={row}
                        rowTitle={title}
                        onSave={(value) => props.onSave(row, def.id, value)}
                      />
                    )}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
      <Button size="sm" variant="ghost" icon={<Icon icon={Plus} />} onClick={() => props.onNewRow()}>
        {t("row.new")}
      </Button>
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

export function ListView(props: ViewProps) {
  const t = useMessages("files");
  const shown = others(props).slice(0, 4);
  return (
    <>
      <ul className="bases__items" aria-label={props.name}>
        {props.rows.map((row) => (
          <li key={row.id} className="bases__item">
            <Card props={props} row={row} shown={shown} />
          </li>
        ))}
      </ul>
      <Button size="sm" variant="ghost" icon={<Icon icon={Plus} />} onClick={() => props.onNewRow()}>
        {t("row.new")}
      </Button>
    </>
  );
}

export function GalleryView(props: ViewProps) {
  const t = useMessages("files");
  const shown = others(props).slice(0, props.view.config.cardSize === "large" ? 6 : 2);
  return (
    <>
      <ul className="bases__gallery" aria-label={props.name}>
        {props.rows.map((row) => (
          <li key={row.id} className="bases__card">
            <Card props={props} row={row} shown={shown} />
          </li>
        ))}
      </ul>
      <Button size="sm" variant="ghost" icon={<Icon icon={Plus} />} onClick={() => props.onNewRow()}>
        {t("row.new")}
      </Button>
    </>
  );
}

export function BoardView(props: ViewProps) {
  const t = useMessages("files");
  const { table, view, rows } = props;
  const [dragging, setDragging] = useState<string | null>(null);
  const def = table.defs.find((each) => each.id === view.config.groupBy?.prop);
  if (def === undefined) return <p className="page__muted">{t("board.needsGroup")}</p>;
  const movable = groupable(def);
  const keys: (string | null)[] =
    def.type === "select" || def.type === "status"
      ? [...(def.options ?? []).map((option) => option.id), null]
      : def.type === "checkbox"
        ? ["true", "false"]
        : [...new Set(rows.map((row) => groupKeyOf(def, row)))];
  const shown = others(props)
    .filter((each) => each.id !== def.id)
    .slice(0, 3);
  const label = (key: string | null) => {
    if (key === null) return t("board.none", { prop: def.name });
    if (def.type === "checkbox") return key === "true" ? t("board.checked") : t("board.unchecked");
    if (def.type === "select" || def.type === "status") return optionName(def, key);
    const sample = rows.find((row) => groupKeyOf(def, row) === key);
    return sample === undefined ? key : cellText(def, sample, props.context);
  };
  const move = (row: BaseRow, key: string | null) => {
    const value = valueForGroup(def, key);
    if (value !== undefined && groupKeyOf(def, row) !== key) props.onSave(row, def.id, value);
  };
  return (
    <section className="bases__board" aria-label={props.name}>
      {keys.map((key) => {
        const inColumn = rows.filter((row) => groupKeyOf(def, row) === key);
        if (view.config.groupBy?.hideEmpty === true && inColumn.length === 0) return null;
        return (
          <section
            key={key ?? "none"}
            className="bases__column"
            aria-label={label(key)}
            data-color={
              key !== null && (def.type === "select" || def.type === "status")
                ? optionColor(def, key)
                : undefined
            }
            onDragOver={(event) => {
              if (movable && dragging !== null) event.preventDefault();
            }}
            onDrop={(event) => {
              event.preventDefault();
              const row = rows.find((each) => each.id === dragging);
              setDragging(null);
              if (row !== undefined) move(row, key);
            }}
          >
            <h3 className="bases__column-title">
              {label(key)} <span className="files__meta">{inColumn.length}</span>
            </h3>
            <ul className="bases__cards">
              {inColumn.map((row) => (
                <li
                  key={row.id}
                  className="bases__card"
                  draggable={movable}
                  data-testid={`card-${row.id}`}
                  onDragStart={() => setDragging(row.id)}
                  onDragEnd={() => setDragging(null)}
                >
                  <Card props={props} row={row} shown={shown} />
                  {movable && (
                    <select
                      className="bases__select bases__card-move"
                      aria-label={t("board.move", { title: titleOf(table, row) || t("row.untitled") })}
                      value={key ?? ""}
                      onChange={(event) => move(row, event.target.value === "" ? null : event.target.value)}
                    >
                      {keys.map((each) => (
                        <option key={each ?? "none"} value={each ?? ""}>
                          {label(each)}
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
                onClick={() => {
                  const value = valueForGroup(def, key);
                  props.onNewRow(value === undefined || value === null ? undefined : { [def.id]: value });
                }}
              >
                {t("row.new")}
              </Button>
            )}
          </section>
        );
      })}
    </section>
  );
}
