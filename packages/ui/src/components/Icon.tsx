import type { LucideIcon } from "lucide-react";
import type { ComponentPropsWithRef } from "react";
import { cx } from "../internal/cx.ts";

export type IconSize = "sm" | "md" | "lg";

const PIXELS: Record<IconSize, number> = { sm: 14, md: 16, lg: 20 };

export type IconProps = Omit<ComponentPropsWithRef<"svg">, "children"> & {
  icon: LucideIcon;
  size?: IconSize;
  /** Accessible name. Without it the icon is decorative and hidden from assistive tech. */
  label?: string;
};

export function Icon({ icon: Glyph, size = "md", label, className, ...props }: IconProps) {
  const a11y =
    label === undefined ? { "aria-hidden": true as const } : { role: "img" as const, "aria-label": label };
  return (
    <Glyph
      {...props}
      {...a11y}
      className={cx("vr-icon", className)}
      width={PIXELS[size]}
      height={PIXELS[size]}
      strokeWidth={1.75}
      absoluteStrokeWidth
      focusable="false"
    />
  );
}
