import { Check, ChevronDown } from "lucide-react";
import { Select as SelectPrimitive } from "radix-ui";
import type { ComponentPropsWithRef, ReactNode } from "react";
import { cx } from "../internal/cx.ts";
import { useFieldControl } from "./Field.tsx";
import { Icon } from "./Icon.tsx";

type RootProps = ComponentPropsWithRef<typeof SelectPrimitive.Root>;

export type SelectProps = Omit<ComponentPropsWithRef<typeof SelectPrimitive.Trigger>, "children" | "dir"> & {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  name?: string;
  required?: boolean;
  disabled?: boolean;
  /** Shown while nothing is selected. */
  placeholder?: ReactNode;
  size?: "sm" | "md" | "lg";
  dir?: RootProps["dir"];
  /** <SelectItem /> elements. */
  children: ReactNode;
};

export function Select({
  value,
  defaultValue,
  onValueChange,
  open,
  defaultOpen,
  onOpenChange,
  name,
  required,
  disabled,
  placeholder,
  size = "md",
  dir,
  children,
  className,
  ...triggerProps
}: SelectProps) {
  const wiring = useFieldControl({ ...triggerProps, required, disabled });
  return (
    <SelectPrimitive.Root
      {...(value !== undefined && { value })}
      {...(defaultValue !== undefined && { defaultValue })}
      {...(onValueChange !== undefined && { onValueChange })}
      {...(open !== undefined && { open })}
      {...(defaultOpen !== undefined && { defaultOpen })}
      {...(onOpenChange !== undefined && { onOpenChange })}
      {...(name !== undefined && { name })}
      {...(dir !== undefined && { dir })}
      required={wiring.required ?? false}
      disabled={wiring.disabled ?? false}
    >
      <SelectPrimitive.Trigger
        {...triggerProps}
        id={wiring.id}
        aria-describedby={wiring["aria-describedby"]}
        aria-invalid={wiring["aria-invalid"]}
        className={cx("vr-control", "vr-select", `vr-control--${size}`, className)}
      >
        <SelectPrimitive.Value placeholder={placeholder} />
        <SelectPrimitive.Icon className="vr-select__chevron">
          <Icon icon={ChevronDown} size="sm" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content className="vr-popover vr-select__content" position="popper" sideOffset={4}>
          <SelectPrimitive.Viewport className="vr-select__viewport">{children}</SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}

export type SelectItemProps = ComponentPropsWithRef<typeof SelectPrimitive.Item>;

export function SelectItem({ children, className, ...props }: SelectItemProps) {
  return (
    <SelectPrimitive.Item {...props} className={cx("vr-menu-item", "vr-select__item", className)}>
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
      <SelectPrimitive.ItemIndicator className="vr-menu-item__end">
        <Icon icon={Check} size="sm" />
      </SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
  );
}
