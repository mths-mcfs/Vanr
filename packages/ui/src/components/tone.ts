import { CircleAlert, CircleCheck, Info, type LucideIcon, TriangleAlert } from "lucide-react";

export type Tone = "info" | "success" | "warning" | "danger";

/** Each tone has its own glyph so it never depends on color alone. */
export const TONE_ICON: Record<Tone, LucideIcon> = {
  info: Info,
  success: CircleCheck,
  warning: TriangleAlert,
  danger: CircleAlert,
};
