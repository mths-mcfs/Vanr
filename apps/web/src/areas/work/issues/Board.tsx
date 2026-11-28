// The board: one column per board column, its cards in board order. A card moves by dragging it, or
// from the keyboard with its move button: Space picks it up, the arrows carry it across columns and
// up or down, Space drops it and Escape puts it back. Each step is announced. The card is drawn where
// it is going while it is carried, so what is seen is what will be saved.
import type { Issue, IssueColumn } from "@vanr/contract";
import { Chip } from "@vanr/ui";
import { GripVertical } from "lucide-react";
import { type DragEvent, type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { AppLink } from "../../../app/navigation.tsx";
import { useMessages } from "../../../i18n/react.tsx";
import {
  type Actors,
  CriteriaMark,
  PriorityMark,
  positionBetween,
  StageDot,
  useColumnName,
} from "./shared.tsx";

/** Where a card goes: its column and its position there. */
export type Move = { columnId: string; boardPosition: number };

/** A card being carried from the keyboard: the column and the slot it would drop into. */
type Carry = { issueId: string; column: number; slot: number; from: { column: number; slot: number } };

const byPosition = (a: Issue, b: Issue) => a.boardPosition - b.boardPosition || b.number - a.number;

/** The cards of each column, in order, without the one being carried. */
function lanes(columns: IssueColumn[], issues: Issue[], without?: string): Issue[][] {
  return columns.map((column) =>
    issues.filter((issue) => issue.columnId === column.id && issue.id !== without).sort(byPosition),
  );
}

/** The position that puts a card at `slot` among `cards` (which do not include it). */
function positionAt(cards: Issue[], slot: number): number {
  return positionBetween(cards[slot - 1]?.boardPosition, cards[slot]?.boardPosition);
}

export function Board({
  workspaceId,
  columns,
  issues,
  actors,
  onMove,
}: {
  workspaceId: string;
  columns: IssueColumn[];
  issues: Issue[];
  actors: Actors;
  onMove: (issue: Issue, to: Move) => void;
}) {
  const t = useMessages("work");
  const columnName = useColumnName();
  const hint = useId();
  const [carry, setCarry] = useState<Carry | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [said, setSaid] = useState("");
  const board = useRef<HTMLDivElement>(null);

  const carried = carry === null ? undefined : issues.find((issue) => issue.id === carry.issueId);
  const rest = lanes(columns, issues, carried?.id);
  // While carried, the card is drawn in the slot it would drop into.
  const drawn = rest.map((cards, index) =>
    carry !== null && carried !== undefined && carry.column === index
      ? [...cards.slice(0, carry.slot), carried, ...cards.slice(carry.slot)]
      : cards,
  );

  // A carried card changes column, so its button is a new element: focus follows it.
  useEffect(() => {
    if (carry === null) return;
    const button = board.current?.querySelector<HTMLButtonElement>(`[data-grab="${carry.issueId}"]`);
    if (button !== null && button !== undefined && document.activeElement !== button) button.focus();
  }, [carry]);

  /** What a step says: the card's column, and its place there counting itself. */
  const where = (issue: Issue, column: number, slot: number) => {
    const target = columns[column];
    const others = issues.filter((each) => each.columnId === target?.id && each.id !== issue.id);
    return {
      number: issue.number,
      column: target === undefined ? "" : columnName(target),
      position: slot + 1,
      total: others.length + 1,
    };
  };

  const keyDown = (issue: Issue, column: number, slot: number) => (event: KeyboardEvent) => {
    const key = event.key;
    if (carry === null || carry.issueId !== issue.id) {
      if (key !== " " && key !== "Enter") return;
      event.preventDefault();
      setCarry({ issueId: issue.id, column, slot, from: { column, slot } });
      setSaid(t("board.picked", where(issue, column, slot)));
      return;
    }
    let next = { column: carry.column, slot: carry.slot };
    if (key === "ArrowLeft" || key === "ArrowRight") {
      const to = carry.column + (key === "ArrowLeft" ? -1 : 1);
      if (to < 0 || to >= columns.length) return;
      next = { column: to, slot: Math.min(carry.slot, rest[to]?.length ?? 0) };
    } else if (key === "ArrowUp" || key === "ArrowDown") {
      const to = carry.slot + (key === "ArrowUp" ? -1 : 1);
      if (to < 0 || to > (rest[carry.column]?.length ?? 0)) return;
      next = { column: carry.column, slot: to };
    } else if (key === " " || key === "Enter") {
      event.preventDefault();
      setCarry(null);
      setSaid(t("board.dropped", where(issue, carry.column, carry.slot)));
      const target = columns[carry.column];
      const moved = carry.column !== carry.from.column || carry.slot !== carry.from.slot;
      if (target !== undefined && moved) {
        onMove(issue, {
          columnId: target.id,
          boardPosition: positionAt(rest[carry.column] ?? [], carry.slot),
        });
      }
      return;
    } else if (key === "Escape") {
      event.preventDefault();
      setCarry(null);
      const home = columns[carry.from.column];
      setSaid(
        t("board.cancelled", { number: issue.number, column: home === undefined ? "" : columnName(home) }),
      );
      return;
    } else return;
    event.preventDefault();
    setCarry({ ...carry, ...next });
    setSaid(t("board.moving", where(issue, next.column, next.slot)));
  };

  /** The slot under the pointer: before the first card whose middle is below it. */
  const slotUnder = (event: DragEvent<HTMLElement>, cards: Issue[]): number => {
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>("[data-card]")].filter(
      (item) => item.dataset.card !== dragging,
    );
    const index = items.findIndex((item) => {
      const box = item.getBoundingClientRect();
      return event.clientY < box.top + box.height / 2;
    });
    return index < 0 ? cards.length : index;
  };

  const drop = (column: number) => (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    const id = event.dataTransfer.getData("text/plain") || dragging;
    setDragging(null);
    const issue = issues.find((each) => each.id === id);
    const target = columns[column];
    if (issue === undefined || target === undefined) return;
    const cards = lanes(columns, issues, issue.id)[column] ?? [];
    onMove(issue, { columnId: target.id, boardPosition: positionAt(cards, slotUnder(event, cards)) });
  };

  return (
    <div className="work-board" ref={board}>
      <p id={hint} className="vr-visually-hidden">
        {t("board.grabHint")}
      </p>
      <p className="vr-visually-hidden" role="status" aria-live="assertive">
        {said}
      </p>
      {columns.map((column, index) => {
        const cards = drawn[index] ?? [];
        const name = columnName(column);
        return (
          <section
            key={column.id}
            className={`work-lane work-lane--${column.stage}`}
            aria-label={t("board.column", { name, count: cards.length })}
            onDragOver={(event) => {
              if (dragging !== null) event.preventDefault();
            }}
            onDrop={drop(index)}
          >
            <header className="work-lane__head">
              <StageDot stage={column.stage} />
              <h2 className="work-lane__name">{name}</h2>
              <span className="work-lane__count" aria-hidden="true">
                {cards.length}
              </span>
            </header>
            {cards.length === 0 ? (
              <p className="work-lane__empty">{t("board.emptyColumn")}</p>
            ) : (
              <ol className="work-lane__cards">
                {cards.map((issue, slot) => {
                  const lifted = carry?.issueId === issue.id || dragging === issue.id;
                  return (
                    <li
                      key={issue.id}
                      data-card={issue.id}
                      className={lifted ? "work-card is-lifted" : "work-card"}
                      draggable
                      onDragStart={(event) => {
                        event.dataTransfer.setData("text/plain", issue.id);
                        event.dataTransfer.effectAllowed = "move";
                        setDragging(issue.id);
                      }}
                      onDragEnd={() => setDragging(null)}
                    >
                      <div className="work-card__top">
                        <span className="work-card__number">#{issue.number}</span>
                        <PriorityMark priority={issue.priority} />
                        <button
                          type="button"
                          className="work-card__grab"
                          data-grab={issue.id}
                          aria-label={t("board.grab", { number: issue.number })}
                          aria-describedby={hint}
                          aria-pressed={carry?.issueId === issue.id}
                          onKeyDown={keyDown(issue, index, slot)}
                          onBlur={() => {
                            if (carry?.issueId !== issue.id) return;
                            // Focus leaving the carried card (a click elsewhere) puts it back.
                            requestAnimationFrame(() => {
                              const still = board.current?.querySelector(`[data-grab="${issue.id}"]`);
                              if (still !== document.activeElement) setCarry(null);
                            });
                          }}
                        >
                          <GripVertical size={14} aria-hidden="true" />
                        </button>
                      </div>
                      <AppLink
                        className="work-card__title"
                        route="issue"
                        params={{ workspaceId, issueSeq: String(issue.number) }}
                        draggable={false}
                      >
                        {issue.title}
                      </AppLink>
                      <div className="work-card__foot">
                        <CriteriaMark criteria={issue.criteria} />
                        {issue.assignee !== null && (
                          <span className="work-card__who">{actors.name(issue.assignee)}</span>
                        )}
                        {issue.work?.state === "working" && <Chip>{t("issues.agentWorking")}</Chip>}
                        {issue.work?.state === "blocked" && <Chip>{t("issues.agentBlocked")}</Chip>}
                      </div>
                    </li>
                  );
                })}
              </ol>
            )}
          </section>
        );
      })}
    </div>
  );
}
