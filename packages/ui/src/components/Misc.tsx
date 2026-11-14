import type { ComponentPropsWithRef, ReactNode } from "react";
import { cx } from "../internal/cx.ts";

export type KbdProps = ComponentPropsWithRef<"kbd">;

export function Kbd({ className, ...props }: KbdProps) {
  return <kbd {...props} className={cx("vr-kbd", className)} />;
}

export type EmptyStateProps = Omit<ComponentPropsWithRef<"div">, "title"> & {
  title: ReactNode;
  description?: ReactNode;
  /** Usually an <Icon size="lg" />. */
  icon?: ReactNode;
  /** The next step, usually a primary <Button />. */
  action?: ReactNode;
};

export function EmptyState({ title, description, icon, action, className, ...props }: EmptyStateProps) {
  return (
    <div {...props} className={cx("vr-empty", className)}>
      {icon !== undefined && <span className="vr-empty__icon">{icon}</span>}
      <p className="vr-empty__title">{title}</p>
      {description !== undefined && <p className="vr-empty__description">{description}</p>}
      {action !== undefined && <div className="vr-empty__action">{action}</div>}
    </div>
  );
}
