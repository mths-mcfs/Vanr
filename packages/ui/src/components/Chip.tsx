import { Check, X } from "lucide-react";
import type { ComponentPropsWithRef, ReactNode } from "react";
import { cx } from "../internal/cx.ts";
import { Icon } from "./Icon.tsx";

type StaticChip = Omit<ComponentPropsWithRef<"span">, "children"> & {
  children: ReactNode;
  icon?: ReactNode;
  selected?: undefined;
  onSelectedChange?: undefined;
  onRemove?: undefined;
  removeLabel?: undefined;
  disabled?: undefined;
};

type SelectableChip = Omit<ComponentPropsWithRef<"button">, "children" | "onChange"> & {
  children: ReactNode;
  icon?: ReactNode;
  /** A toggle filter: renders a button with aria-pressed and a check mark while selected. */
  selected: boolean;
  onSelectedChange: (selected: boolean) => void;
  onRemove?: undefined;
  removeLabel?: undefined;
};

type RemovableChip = Omit<ComponentPropsWithRef<"span">, "children"> & {
  children: ReactNode;
  icon?: ReactNode;
  selected?: undefined;
  onSelectedChange?: undefined;
  onRemove: () => void;
  /** Accessible name of the remove button, e.g. "Remove Design". */
  removeLabel: string;
  disabled?: boolean;
};

export type ChipProps = StaticChip | SelectableChip | RemovableChip;

export function Chip(props: ChipProps) {
  if (props.selected !== undefined) {
    const { selected, onSelectedChange, icon, children, className, onClick, ...rest } = props;
    return (
      <button
        type="button"
        {...rest}
        aria-pressed={selected}
        className={cx("vr-chip", "vr-chip--selectable", className)}
        onClick={(event) => {
          onClick?.(event);
          if (!event.defaultPrevented) onSelectedChange(!selected);
        }}
      >
        {selected ? (
          <span className="vr-chip__icon">
            <Icon icon={Check} size="sm" />
          </span>
        ) : (
          icon !== undefined && <span className="vr-chip__icon">{icon}</span>
        )}
        <span className="vr-chip__label">{children}</span>
      </button>
    );
  }
  if (props.onRemove !== undefined) {
    const { onRemove, removeLabel, disabled, icon, children, className, ...rest } = props;
    return (
      <span {...rest} className={cx("vr-chip", className)} data-disabled={disabled || undefined}>
        {icon !== undefined && <span className="vr-chip__icon">{icon}</span>}
        <span className="vr-chip__label">{children}</span>
        <button
          type="button"
          className="vr-chip__remove"
          aria-label={removeLabel}
          disabled={disabled}
          onClick={onRemove}
        >
          <Icon icon={X} size="sm" />
        </button>
      </span>
    );
  }
  const { icon, children, className, ...rest } = props;
  return (
    <span {...rest} className={cx("vr-chip", className)}>
      {icon !== undefined && <span className="vr-chip__icon">{icon}</span>}
      <span className="vr-chip__label">{children}</span>
    </span>
  );
}
