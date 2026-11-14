import { Check, Minus } from "lucide-react";
import {
  Checkbox as CheckboxPrimitive,
  RadioGroup as RadioPrimitive,
  Switch as SwitchPrimitive,
} from "radix-ui";
import { type ComponentPropsWithRef, type ReactNode, useId } from "react";
import { cx } from "../internal/cx.ts";
import { useFieldControl } from "./Field.tsx";
import { Icon } from "./Icon.tsx";

type Labelled = {
  /** Visible label next to the control. */
  label: ReactNode;
  /** Secondary line under the label. */
  hint?: ReactNode;
};

function ChoiceLabel({ htmlFor, label, hint, hintId }: Labelled & { htmlFor: string; hintId: string }) {
  return (
    <span className="vr-choice__text">
      <label className="vr-choice__label" htmlFor={htmlFor}>
        {label}
      </label>
      {hint !== undefined && (
        <span className="vr-choice__hint" id={hintId}>
          {hint}
        </span>
      )}
    </span>
  );
}

function useChoiceIds(own: { id?: string; "aria-describedby"?: string }, hint: ReactNode) {
  const generated = useId();
  const hintId = `${generated}-hint`;
  const describedBy = [own["aria-describedby"], hint === undefined ? undefined : hintId]
    .filter(Boolean)
    .join(" ");
  return { id: own.id ?? `${generated}-control`, hintId, describedBy: describedBy || undefined };
}

export type CheckboxProps = Omit<ComponentPropsWithRef<typeof CheckboxPrimitive.Root>, "children"> & Labelled;

export function Checkbox({ label, hint, className, ...props }: CheckboxProps) {
  const ids = useChoiceIds(props, hint);
  const wiring = useFieldControl({ ...props, id: ids.id, "aria-describedby": ids.describedBy });
  return (
    <span className={cx("vr-choice", className)} data-disabled={wiring.disabled || undefined}>
      <CheckboxPrimitive.Root
        {...props}
        {...wiring}
        id={ids.id}
        aria-labelledby={undefined}
        className="vr-checkbox"
      >
        <CheckboxPrimitive.Indicator className="vr-checkbox__indicator">
          <Icon icon={props.checked === "indeterminate" ? Minus : Check} size="sm" />
        </CheckboxPrimitive.Indicator>
      </CheckboxPrimitive.Root>
      <ChoiceLabel htmlFor={ids.id} label={label} hint={hint} hintId={ids.hintId} />
    </span>
  );
}

export type SwitchProps = Omit<ComponentPropsWithRef<typeof SwitchPrimitive.Root>, "children"> & Labelled;

export function Switch({ label, hint, className, ...props }: SwitchProps) {
  const ids = useChoiceIds(props, hint);
  const wiring = useFieldControl({ ...props, id: ids.id, "aria-describedby": ids.describedBy });
  return (
    <span
      className={cx("vr-choice", "vr-choice--switch", className)}
      data-disabled={wiring.disabled || undefined}
    >
      <SwitchPrimitive.Root
        {...props}
        {...wiring}
        id={ids.id}
        aria-labelledby={undefined}
        className="vr-switch"
      >
        <SwitchPrimitive.Thumb className="vr-switch__thumb" />
      </SwitchPrimitive.Root>
      <ChoiceLabel htmlFor={ids.id} label={label} hint={hint} hintId={ids.hintId} />
    </span>
  );
}

export type RadioGroupProps = ComponentPropsWithRef<typeof RadioPrimitive.Root>;

/** A set of <Radio /> options. Inside a Field, the Field label names the group. */
export function RadioGroup({ className, ...props }: RadioGroupProps) {
  const wiring = useFieldControl(props, { labelledBy: true });
  return <RadioPrimitive.Root {...props} {...wiring} className={cx("vr-radio-group", className)} />;
}

export type RadioProps = Omit<ComponentPropsWithRef<typeof RadioPrimitive.Item>, "children"> & Labelled;

export function Radio({ label, hint, className, ...props }: RadioProps) {
  const ids = useChoiceIds(props, hint);
  return (
    <span className={cx("vr-choice", className)} data-disabled={props.disabled || undefined}>
      <RadioPrimitive.Item {...props} id={ids.id} aria-describedby={ids.describedBy} className="vr-radio">
        <RadioPrimitive.Indicator className="vr-radio__dot" />
      </RadioPrimitive.Item>
      <ChoiceLabel htmlFor={ids.id} label={label} hint={hint} hintId={ids.hintId} />
    </span>
  );
}
