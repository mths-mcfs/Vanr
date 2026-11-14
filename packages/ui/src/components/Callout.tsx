import type { ComponentPropsWithRef, ReactNode } from "react";
import { cx } from "../internal/cx.ts";
import { Icon } from "./Icon.tsx";
import { TONE_ICON, type Tone } from "./tone.ts";

export type CalloutProps = Omit<ComponentPropsWithRef<"div">, "title"> & {
  tone?: Tone;
  title?: ReactNode;
  /** Buttons or links under the text. */
  actions?: ReactNode;
};

export function Callout({ tone = "info", title, actions, children, className, ...props }: CalloutProps) {
  return (
    <div {...props} data-tone={tone} className={cx("vr-callout", className)}>
      <Icon icon={TONE_ICON[tone]} className="vr-callout__icon" />
      <div className="vr-callout__text">
        {title !== undefined && <p className="vr-callout__title">{title}</p>}
        {children !== undefined && <div className="vr-callout__body">{children}</div>}
        {actions !== undefined && <div className="vr-callout__actions">{actions}</div>}
      </div>
    </div>
  );
}
