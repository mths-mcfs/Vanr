import { CircleAlert } from "lucide-react";
import {
  type AriaAttributes,
  Children,
  type ComponentPropsWithRef,
  createContext,
  Fragment,
  isValidElement,
  type ReactNode,
  useContext,
  useId,
} from "react";
import { cx } from "../internal/cx.ts";
import { Icon } from "./Icon.tsx";

/**
 * How a package control relates to a Field label: "labelable" controls (Input, Textarea, Select,
 * Checkbox, Switch) can be the target of `<label for>`; a "group" control (RadioGroup) is named
 * by aria-labelledby.
 */
export type FieldRole = "labelable" | "group";

/** Marks a component as a package control the Field can find among its children. */
export function markFieldControl<T extends object>(component: T, role: FieldRole): T {
  Object.defineProperty(component, FIELD_ROLE, { value: role });
  return component;
}

const FIELD_ROLE = Symbol.for("vanr.fieldRole");

function fieldRoleOf(type: unknown): FieldRole | undefined {
  if ((typeof type !== "function" && typeof type !== "object") || type === null) return undefined;
  const role: unknown = Reflect.get(type, FIELD_ROLE);
  return role === "labelable" || role === "group" ? role : undefined;
}

type FoundControl = { role: FieldRole; id: string | undefined };

/**
 * The package controls among a Field's children. It looks through plain elements and fragments
 * only: a control rendered inside another component is out of sight, and gets no id from the Field.
 */
function findControls(children: ReactNode, found: FoundControl[] = []): FoundControl[] {
  for (const child of Children.toArray(children)) {
    if (!isValidElement<{ id?: unknown; children?: ReactNode }>(child)) continue;
    const role = fieldRoleOf(child.type);
    if (role !== undefined) {
      found.push({ role, id: typeof child.props.id === "string" ? child.props.id : undefined });
    } else if (typeof child.type === "string" || child.type === Fragment) {
      findControls(child.props.children, found);
    }
  }
  return found;
}

/**
 * single: one labelable control, the target of the Field's `<label for>`.
 * group: a radio group, or several controls; the Field label names them, no control takes its id.
 * unseen: no package control in sight; `for` only comes from an explicit controlId.
 */
type FieldMode = "single" | "group" | "unseen";

type FieldContextValue = {
  mode: FieldMode;
  /** The id the single control must use. */
  controlId: string | undefined;
  labelId: string;
  /** Hint and error ids, for controls that carry the description themselves. */
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
 * Merges the Field wiring with the control's own props.
 * - id: the single control takes the Field's id; any other control keeps its own.
 * - aria-describedby: the caller's is kept and the Field's hint and error are added (in a group
 *   the group element carries them instead).
 * - aria-labelledby: the caller's is kept; the Field label is added whenever it would otherwise
 *   not name the control (a group control, a text control in a group, or when the caller's
 *   aria-labelledby would override the `<label for>`). A choice control in a group keeps its own
 *   visible label and is not named by the Field.
 */
export function useFieldControl(
  own: FieldControlProps,
  options: { kind: "text" | "choice" | "group" } = { kind: "text" },
) {
  const field = useContext(FieldContext);
  if (field === null) return own;
  const caller = own["aria-labelledby"];
  const namedByField =
    field.mode === "single" ? caller !== undefined : options.kind === "group" || options.kind === "text";
  return {
    id: field.mode === "single" ? field.controlId : own.id,
    "aria-describedby":
      field.mode === "group" && options.kind !== "group"
        ? own["aria-describedby"]
        : joinIds(field.describedBy, own["aria-describedby"]),
    "aria-invalid": own["aria-invalid"] ?? (field.invalid || undefined),
    "aria-labelledby": namedByField ? joinIds(field.labelId, caller) : caller,
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
  /**
   * Id for the control. It wins over the control's own id. Needed when the control is not one of
   * this package's, or sits inside another component, so the label can still point at it.
   */
  controlId?: string;
  children: ReactNode;
};

/**
 * Labels one control, or names a group of them.
 *
 * Rule: with exactly one labelable package control in sight, the Field label is its `<label for>`
 * and the control's id is the explicit controlId, else the control's own id, else a generated one;
 * with a RadioGroup or more than one control, the Field label names a fieldset (or the radio
 * group) by aria-labelledby and every control keeps its own id and label. An element that is not a
 * package control never lends its id: for anything else, pass controlId.
 */
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
  const controls = findControls(children);
  const only = controls.length === 1 ? controls[0] : undefined;
  const mode: FieldMode = only?.role === "labelable" ? "single" : controls.length === 0 ? "unseen" : "group";
  const id = mode === "single" ? (controlId ?? only?.id ?? `${generated}-control`) : controlId;
  const labelId = `${generated}-label`;
  const hintId = hint === undefined ? undefined : `${generated}-hint`;
  const errorId = error === undefined || error === null || error === false ? undefined : `${generated}-error`;
  const describedBy = joinIds(hintId, errorId);
  const value: FieldContextValue = {
    mode,
    controlId: id,
    labelId,
    describedBy,
    invalid: errorId !== undefined,
    required,
    disabled,
  };
  const labelContent = (
    <>
      {label}
      {required && requiredLabel !== undefined && <span className="vr-field__required">{requiredLabel}</span>}
    </>
  );
  // Several controls get a fieldset (an implicit role="group") to carry the name and description;
  // a lone RadioGroup already is a group.
  const wrapInGroup = mode === "group" && controls.length > 1;
  return (
    <div
      {...props}
      className={cx("vr-field", className)}
      data-invalid={value.invalid || undefined}
      data-disabled={disabled || undefined}
    >
      {mode === "group" ? (
        <span className="vr-field__label" id={labelId}>
          {labelContent}
        </span>
      ) : (
        <label className="vr-field__label" id={labelId} htmlFor={id}>
          {labelContent}
        </label>
      )}
      <FieldContext.Provider value={value}>
        {wrapInGroup ? (
          <fieldset className="vr-field__group" aria-labelledby={labelId} aria-describedby={describedBy}>
            {children}
          </fieldset>
        ) : (
          children
        )}
      </FieldContext.Provider>
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
