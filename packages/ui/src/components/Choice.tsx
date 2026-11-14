import { Check, Minus } from "lucide-react";
import {
  Checkbox as CheckboxPrimitive,
  RadioGroup as RadioPrimitive,
  Switch as SwitchPrimitive,
} from "radix-ui";
import { type ComponentPropsWithRef, type ReactNode, useId, useState } from "react";
import { cx } from "../internal/cx.ts";
import { joinIds, markFieldControl, useFieldControl } from "./Field.tsx";
import { Icon } from "./Icon.tsx";

type Labelled = {
  /** Visible label next to the control. */
  label: ReactNode;
  /** Secondary line under the label. */
  hint?: ReactNode;
};

type ChoiceIds = { id: string; labelId: string; hintId: string };

function ChoiceLabel({ ids, label, hint }: Labelled & { ids: ChoiceIds }) {
  return (
    <span className="vr-choice__text">
      <label className="vr-choice__label" id={ids.labelId} htmlFor={ids.id}>
        {label}
      </label>
      {hint !== undefined && (
        <span className="vr-choice__hint" id={ids.hintId}>
          {hint}
        </span>
      )}
    </span>
  );
}

type OwnAria = { id?: string; "aria-describedby"?: string; "aria-labelledby"?: string };

/**
 * Ids and names for a control with its own inline label. The inline label always names the
 * control; a caller's aria-labelledby (and, inside a Field, the Field label) is added after it.
 * The hint joins the caller's and the Field's descriptions.
 */
function useChoiceWiring<P extends OwnAria & { required?: boolean; disabled?: boolean }>(
  own: P,
  hint: ReactNode,
  options: { inField: boolean },
) {
  const generated = useId();
  const labelId = `${generated}-label`;
  const hintId = `${generated}-hint`;
  const describedBy = joinIds(own["aria-describedby"], hint !== undefined && hintId);
  const field = useFieldControl({ ...own, "aria-describedby": describedBy }, { kind: "choice" });
  const wiring = options.inField ? field : { ...own, "aria-describedby": describedBy };
  const id = wiring.id ?? `${generated}-control`;
  const extra = wiring["aria-labelledby"];
  return {
    ids: { id, labelId, hintId },
    aria: {
      id,
      "aria-describedby": wiring["aria-describedby"],
      "aria-labelledby": extra === undefined ? undefined : joinIds(labelId, extra),
      ...(options.inField && {
        "aria-invalid": field["aria-invalid"],
        required: field.required,
        disabled: field.disabled,
      }),
    },
  };
}

export type CheckboxProps = Omit<ComponentPropsWithRef<typeof CheckboxPrimitive.Root>, "children"> & Labelled;

export function Checkbox({
  label,
  hint,
  className,
  checked,
  defaultChecked,
  onCheckedChange,
  ...props
}: CheckboxProps) {
  const { ids, aria } = useChoiceWiring(props, hint, { inField: true });
  const disabled = aria.disabled ?? props.disabled;
  // Mirror the uncontrolled value so the glyph follows the real state in both modes.
  const [uncontrolled, setUncontrolled] = useState<CheckboxPrimitive.CheckedState>(defaultChecked ?? false);
  const state = checked ?? uncontrolled;
  return (
    <span className={cx("vr-choice", className)} data-disabled={disabled || undefined}>
      <CheckboxPrimitive.Root
        {...props}
        {...aria}
        {...(checked !== undefined && { checked })}
        {...(defaultChecked !== undefined && { defaultChecked })}
        onCheckedChange={(next) => {
          if (checked === undefined) setUncontrolled(next);
          onCheckedChange?.(next);
        }}
        className="vr-checkbox"
      >
        <CheckboxPrimitive.Indicator className="vr-checkbox__indicator">
          <Icon icon={state === "indeterminate" ? Minus : Check} size="sm" />
        </CheckboxPrimitive.Indicator>
      </CheckboxPrimitive.Root>
      <ChoiceLabel ids={ids} label={label} hint={hint} />
    </span>
  );
}

export type SwitchProps = Omit<ComponentPropsWithRef<typeof SwitchPrimitive.Root>, "children"> & Labelled;

export function Switch({ label, hint, className, ...props }: SwitchProps) {
  const { ids, aria } = useChoiceWiring(props, hint, { inField: true });
  const disabled = aria.disabled ?? props.disabled;
  return (
    <span className={cx("vr-choice", "vr-choice--switch", className)} data-disabled={disabled || undefined}>
      <SwitchPrimitive.Root {...props} {...aria} className="vr-switch">
        <SwitchPrimitive.Thumb className="vr-switch__thumb" />
      </SwitchPrimitive.Root>
      <ChoiceLabel ids={ids} label={label} hint={hint} />
    </span>
  );
}

export type RadioGroupProps = ComponentPropsWithRef<typeof RadioPrimitive.Root>;

/** A set of <Radio /> options. Inside a Field, the Field label names the group. */
export function RadioGroup({ className, ...props }: RadioGroupProps) {
  const wiring = useFieldControl(props, { kind: "group" });
  return <RadioPrimitive.Root {...props} {...wiring} className={cx("vr-radio-group", className)} />;
}

export type RadioProps = Omit<ComponentPropsWithRef<typeof RadioPrimitive.Item>, "children"> & Labelled;

/** One option of a RadioGroup. The group, not the option, takes the Field's id and description. */
export function Radio({ label, hint, className, ...props }: RadioProps) {
  const { ids, aria } = useChoiceWiring(props, hint, { inField: false });
  return (
    <span className={cx("vr-choice", className)} data-disabled={props.disabled || undefined}>
      <RadioPrimitive.Item {...props} {...aria} className="vr-radio">
        <RadioPrimitive.Indicator className="vr-radio__dot" />
      </RadioPrimitive.Item>
      <ChoiceLabel ids={ids} label={label} hint={hint} />
    </span>
  );
}

markFieldControl(Checkbox, "labelable");
markFieldControl(Switch, "labelable");
markFieldControl(RadioGroup, "group");
