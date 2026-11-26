import type { ComponentPropsWithRef } from "react";
import { cx } from "../internal/cx.ts";

export type SpinnerProps = Omit<ComponentPropsWithRef<"span">, "children"> & {
  size?: "sm" | "md" | "lg";
  /** Announced to screen readers. Leave it out when the surrounding control already says it is busy. */
  label?: string;
};

export function Spinner({ size = "md", label, className, ...props }: SpinnerProps) {
  return (
    <span
      {...props}
      className={cx("vr-spinner", `vr-spinner--${size}`, className)}
      {...(label === undefined ? { "aria-hidden": true } : { role: "status" })}
    >
      <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <rect className="vr-spinner__track" x="1.5" y="1.5" width="13" height="13" rx="1.5" />
        <rect className="vr-spinner__head" x="1.5" y="1.5" width="13" height="13" rx="1.5" pathLength="100" />
      </svg>
      {label !== undefined && <span className="vr-visually-hidden">{label}</span>}
    </span>
  );
}

export type SkeletonProps = Omit<ComponentPropsWithRef<"span">, "children"> & {
  shape?: "line" | "block" | "circle";
};

/** Placeholder for content that is loading. Decorative: mark the loading region with aria-busy instead. */
export function Skeleton({ shape = "line", className, ...props }: SkeletonProps) {
  return (
    <span {...props} aria-hidden="true" className={cx("vr-skeleton", `vr-skeleton--${shape}`, className)} />
  );
}
