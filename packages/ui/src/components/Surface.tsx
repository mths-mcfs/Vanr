import { createElement, type HTMLAttributes, type Ref } from "react";
import { cx } from "../internal/cx.ts";

export type SurfaceVariant = "card" | "panel" | "row";

export type SurfaceProps = HTMLAttributes<HTMLElement> & {
  ref?: Ref<HTMLElement>;
  /** card: a bordered block on the page. panel: a sunken region. row: one line of a list. */
  variant?: SurfaceVariant;
  as?: "div" | "section" | "article" | "li" | "aside";
  /** Row only: highlights on hover; put the actual link or button inside. */
  interactive?: boolean;
  /** Row only: marks the current item. */
  selected?: boolean;
};

export function Surface({
  variant = "card",
  as = "div",
  interactive = false,
  selected = false,
  className,
  ...props
}: SurfaceProps) {
  return createElement(as, {
    ...props,
    "data-interactive": interactive || undefined,
    "data-selected": selected || undefined,
    className: cx("vr-surface", `vr-surface--${variant}`, className),
  });
}
