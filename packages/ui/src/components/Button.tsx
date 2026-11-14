import type { ComponentPropsWithRef, MouseEvent, ReactNode } from "react";
import { cx } from "../internal/cx.ts";
import { Spinner } from "./Spinner.tsx";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

type BaseProps = Omit<ComponentPropsWithRef<"button">, "children"> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a spinner, keeps the width and blocks clicks while staying focusable. */
  loading?: boolean;
};

type LabelledButton = BaseProps & {
  children: ReactNode;
  /** Leading icon, usually an <Icon />. */
  icon?: ReactNode;
};

type IconOnlyButton = BaseProps & {
  children?: undefined;
  icon: ReactNode;
  /** An icon-only button has no visible text, so it needs an accessible name. */
  "aria-label": string;
};

export type ButtonProps = LabelledButton | IconOnlyButton;

export function Button({
  variant = "secondary",
  size = "md",
  loading = false,
  icon,
  children,
  className,
  type = "button",
  onClick,
  ...props
}: ButtonProps) {
  const iconOnly = children === undefined;
  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    if (loading) {
      event.preventDefault();
      return;
    }
    onClick?.(event);
  };
  return (
    <button
      {...props}
      type={type}
      onClick={handleClick}
      aria-busy={loading || undefined}
      aria-disabled={loading || props["aria-disabled"] || undefined}
      data-loading={loading || undefined}
      className={cx(
        "vr-button",
        `vr-button--${variant}`,
        `vr-button--${size}`,
        iconOnly && "vr-button--icon",
        className,
      )}
    >
      <span className="vr-button__content">
        {icon !== undefined && <span className="vr-button__icon">{icon}</span>}
        {!iconOnly && <span className="vr-button__label">{children}</span>}
      </span>
      {loading && <Spinner className="vr-button__spinner" size={size === "lg" ? "md" : "sm"} />}
    </button>
  );
}
