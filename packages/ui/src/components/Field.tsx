import { CircleAlert } from "lucide-react";
import {
  type AriaAttributes,
  type ComponentPropsWithRef,
  createContext,
  type ReactNode,
  useContext,
  useId,
} from "react";
import { cx } from "../internal/cx.ts";
import { Icon } from "./Icon.tsx";

type FieldContextValue = {
  controlId: string;
  labelId: string;
  describedBy: string | undefined;
  invalid: boolean;
  required: boolean;
  disabled: boolean;
};

const FieldContext = createContext<FieldContextValue | null>(null);

/** The wiring a control needs from its Field: id, description ids and validity. */
export type FieldControlProps = {
  id?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: AriaAttributes["aria-invalid"];
  "aria-labelledby"?: string;
  required?: boolean;
  disabled?: boolean;
};

/**
 * Merges the Field wiring with the control's own props. The control's explicit props win, and
 * its own aria-describedby is kept alongside the Field's hint and error.
 */
export function useFieldControl(own: FieldControlProps, options: { labelledBy?: boolean } = {}) {
  const field = useContext(FieldContext);
  if (field === null) return own;
  const describedBy = [field.describedBy, own["aria-describedby"]].filter(Boolean).join(" ") || undefined;
  return {
    id: own.id ?? field.controlId,
    "aria-describedby": describedBy,
    "aria-invalid": own["aria-invalid"] ?? (field.invalid || undefined),
    "aria-labelledby": own["aria-labelledby"] ?? (options.labelledBy ? field.labelId : undefined),
    required: own.required ?? (field.required || undefined),
    disabled: own.disabled ?? (field.disabled || undefined),
  };
}

export type FieldProps = Omit<ComponentPropsWithRef<"div">, "children"> & {
  label: ReactNode;
  hint?: ReactNode;
  /** Shown under the control and announced with it. Marks the control invalid. */
  error?: ReactNode;
  required?: boolean;
  disabled?: boolean;
  /** Text after the label for required fields, such as "required" or "obrigatório". */
  requiredLabel?: string;
  /** Id for the control. Generated when left out. */
  controlId?: string;
  children: ReactNode;
};

export function Field({
  label,
  hint,
  error,
  required = false,
  disabled = false,
  requiredLabel,
  controlId,
  children,
  className,
  ...props
}: FieldProps) {
  const generated = useId();
  const id = controlId ?? `${generated}-control`;
  const labelId = `${generated}-label`;
  const hintId = hint === undefined ? undefined : `${generated}-hint`;
  const errorId = error === undefined || error === null || error === false ? undefined : `${generated}-error`;
  const value: FieldContextValue = {
    controlId: id,
    labelId,
    describedBy: [hintId, errorId].filter(Boolean).join(" ") || undefined,
    invalid: errorId !== undefined,
    required,
    disabled,
  };
  return (
    <div
      {...props}
      className={cx("vr-field", className)}
      data-invalid={value.invalid || undefined}
      data-disabled={disabled || undefined}
    >
      <label className="vr-field__label" id={labelId} htmlFor={id}>
        {label}
        {required && requiredLabel !== undefined && (
          <span className="vr-field__required">{requiredLabel}</span>
        )}
      </label>
      <FieldContext.Provider value={value}>{children}</FieldContext.Provider>
      {hintId !== undefined && (
        <p className="vr-field__hint" id={hintId}>
          {hint}
        </p>
      )}
      {errorId !== undefined && (
        <p className="vr-field__error" id={errorId}>
          <Icon icon={CircleAlert} size="sm" className="vr-field__error-icon" />
          <span>{error}</span>
        </p>
      )}
    </div>
  );
}
