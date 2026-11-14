import type { ComponentPropsWithRef } from "react";
import { cx } from "../internal/cx.ts";
import { useFieldControl } from "./Field.tsx";

export type InputProps = Omit<ComponentPropsWithRef<"input">, "size"> & {
  size?: "sm" | "md" | "lg";
  /** Renders the value in the mono face: ids, tokens, paths. */
  mono?: boolean;
};

export function Input({ size = "md", mono = false, className, ...props }: InputProps) {
  const wiring = useFieldControl(props);
  return (
    <input
      {...props}
      {...wiring}
      className={cx("vr-control", "vr-input", `vr-control--${size}`, mono && "vr-control--mono", className)}
    />
  );
}

export type TextareaProps = ComponentPropsWithRef<"textarea"> & {
  mono?: boolean;
};

export function Textarea({ mono = false, rows = 3, className, ...props }: TextareaProps) {
  const wiring = useFieldControl(props);
  return (
    <textarea
      {...props}
      {...wiring}
      rows={rows}
      className={cx("vr-control", "vr-textarea", mono && "vr-control--mono", className)}
    />
  );
}
