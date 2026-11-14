import {
  CircleCheck,
  CirclePause,
  LoaderCircle,
  type LucideIcon,
  MessageCircleQuestionMark,
  OctagonX,
  ShieldQuestionMark,
} from "lucide-react";
import type { ComponentPropsWithRef } from "react";
import { cx } from "../internal/cx.ts";
import { Icon } from "./Icon.tsx";

/** Where an agent's piece of work stands. */
export type WorkStatus = "running" | "awaiting-approval" | "awaiting-reply" | "failed" | "done" | "paused";

const STATUS_ICON: Record<WorkStatus, LucideIcon> = {
  running: LoaderCircle,
  "awaiting-approval": ShieldQuestionMark,
  "awaiting-reply": MessageCircleQuestionMark,
  failed: OctagonX,
  done: CircleCheck,
  paused: CirclePause,
};

export const WORK_STATUSES = Object.keys(STATUS_ICON) as WorkStatus[];

export type StatusBadgeProps = Omit<ComponentPropsWithRef<"span">, "children"> & {
  status: WorkStatus;
  /** The visible status text, in the interface language. */
  label: string;
};

export function StatusBadge({ status, label, className, ...props }: StatusBadgeProps) {
  return (
    <span {...props} data-status={status} className={cx("vr-status", className)}>
      <Icon icon={STATUS_ICON[status]} size="sm" className="vr-status__icon" />
      <span>{label}</span>
    </span>
  );
}
