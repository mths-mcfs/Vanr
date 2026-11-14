import { CircleAlert } from "lucide-react";
import {
  type AriaAttributes,
  Children,
  type ComponentPropsWithRef,
  createContext,
  isValidElement,
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

/** Joins id lists, skipping empty values; undefined when nothing is left. */
export function joinIds(...ids: Array<string | false | null | undefined>): string | undefined {
  return ids.filter(Boolean).join(" ") || undefined;
}

/**
 * Merges the Field wiring with the control's own props. The control's own id wins (and the Field
 * points its label at it). The caller's aria-describedby and aria-labelledby are added to the
 * Field's, never dropped: a caller's aria-labelledby would otherwise silence the Field label.
 */
export function useFieldControl(own: FieldControlProps, options: { labelledBy?: boolean } = {}) {
  const field = useContext(FieldContext);
  if (field === null) return own;
  const callerLabelledBy = own["aria-labelledby"];
  return {
    id: own.id ?? field.controlId,
    "aria-describedby": joinIds(field.describedBy, own["aria-describedby"]),
    "aria-invalid": own["aria-invalid"] ?? (field.invalid || undefined),
    "aria-labelledby":
      options.labelledBy || callerLabelledBy !== undefined
        ? joinIds(field.labelId, callerLabelledBy)
        : undefined,
    required: own.required ?? (field.required || undefined),
    disabled: own.disabled ?? (field.disabled || undefined),
  };
}

/** The id a lone child control brings with it, so the Field label can point at it. */
function childControlId(children: ReactNode): string | undefined {
  const nodes = Children.toArray(children);
  const only = nodes.length === 1 ? nodes[0] : undefined;
  if (isValidElement<{ id?: unknown }>(only) && typeof only.props.id === "string") return only.props.id;
  return undefined;
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
  /**
   * Id for the control. When left out, the Field uses the id of its only child control, or
   * generates one. A control wrapped in other elements needs this to keep its label.
   */
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
  const id = childControlId(children) ?? controlId ?? `${generated}-control`;
  const labelId = `${generated}-label`;
  const hintId = hint === undefined ? undefined : `${generated}-hint`;
  const errorId = error === undefined || error === null || error === false ? undefined : `${generated}-error`;
  const value: FieldContextValue = {
    controlId: id,
    labelId,
    describedBy: joinIds(hintId, errorId),
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
