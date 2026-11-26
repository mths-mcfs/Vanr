import type { ComponentPropsWithRef } from "react";
import { cx } from "../internal/cx.ts";

const NAME = "Vanr";

export type WordmarkProps = Omit<ComponentPropsWithRef<"span">, "children"> & {
  /** full: mark and name. mark: the mark alone, for tight spots like a favicon or a collapsed sidebar. */
  variant?: "full" | "mark";
  size?: "sm" | "md" | "lg";
};

/**
 * The Vanr mark: a V cut through by a stave, the same stroke grammar as an agent sigil, with the
 * joint marked in the accent.
 */
function Mark() {
  return (
    <svg className="vr-wordmark__mark" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path className="vr-wordmark__strokes" d="M5 4L12 19L19 4M12 4V19" />
      <rect className="vr-wordmark__joint" x="10" y="17" width="4" height="4" />
    </svg>
  );
}

export function Wordmark({ variant = "full", size = "md", className, ...props }: WordmarkProps) {
  return (
    <span
      {...props}
      className={cx("vr-wordmark", `vr-wordmark--${size}`, className)}
      {...(variant === "mark" && { role: "img", "aria-label": NAME })}
    >
      <Mark />
      {variant === "full" && <span className="vr-wordmark__name">{NAME}</span>}
    </span>
  );
}
