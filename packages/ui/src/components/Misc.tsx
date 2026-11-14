import { CircleAlert } from "lucide-react";
import type { ComponentPropsWithRef, ReactNode } from "react";
import { cx } from "../internal/cx.ts";
import { Icon } from "./Icon.tsx";
import { TONE_ICON, type Tone } from "./tone.ts";

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

export type ErrorStateProps = Omit<ComponentPropsWithRef<"div">, "title"> & {
  /** What failed, in the person's words: "The agents could not be loaded". */
  title: ReactNode;
  /** Why, when it is known. */
  description?: ReactNode;
  /** The way out, usually a <Button /> that tries again. */
  action?: ReactNode;
};

/** A view that failed to load. Announced when it appears; pair it with a retry. */
export function ErrorState({ title, description, action, className, ...props }: ErrorStateProps) {
  return (
    <div {...props} role="alert" className={cx("vr-error-state", className)}>
      <Icon icon={CircleAlert} className="vr-error-state__icon" />
      <div className="vr-error-state__text">
        <p className="vr-error-state__title">{title}</p>
        {description !== undefined && <p className="vr-error-state__description">{description}</p>}
        {action !== undefined && <div className="vr-error-state__action">{action}</div>}
      </div>
    </div>
  );
}

export type BannerProps = ComponentPropsWithRef<"div"> & {
  tone?: Tone;
  /** One button at the end of the strip. */
  action?: ReactNode;
};

/** A strip across the top of a region for a condition that affects all of it, such as a lost connection. */
export function Banner({ tone = "warning", action, children, className, ...props }: BannerProps) {
  return (
    <div {...props} role="status" data-tone={tone} className={cx("vr-banner", className)}>
      <Icon icon={TONE_ICON[tone]} className="vr-banner__icon" />
      <div className="vr-banner__text">{children}</div>
      {action !== undefined && <div className="vr-banner__action">{action}</div>}
    </div>
  );
}
