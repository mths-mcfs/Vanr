import { ContextMenu as ContextPrimitive, DropdownMenu as DropdownPrimitive } from "radix-ui";
import type { ComponentPropsWithRef, ReactNode } from "react";
import { cx } from "../internal/cx.ts";

type ItemExtras = {
  /** Leading icon, usually an <Icon />. */
  icon?: ReactNode;
  /** Keyboard shortcut hint, usually a <Kbd />. */
  shortcut?: ReactNode;
  tone?: "default" | "danger";
};

function ItemInner({ icon, shortcut, children }: ItemExtras & { children: ReactNode }) {
  return (
    <>
      {icon !== undefined && <span className="vr-menu-item__icon">{icon}</span>}
      <span className="vr-menu-item__label">{children}</span>
      {shortcut !== undefined && <span className="vr-menu-item__end">{shortcut}</span>}
    </>
  );
}

/* Dropdown menu */

export const Menu = DropdownPrimitive.Root;
export const MenuTrigger = DropdownPrimitive.Trigger;

export type MenuContentProps = ComponentPropsWithRef<typeof DropdownPrimitive.Content>;

export function MenuContent({ className, sideOffset = 4, align = "start", ...props }: MenuContentProps) {
  return (
    <DropdownPrimitive.Portal>
      <DropdownPrimitive.Content
        {...props}
        sideOffset={sideOffset}
        align={align}
        className={cx("vr-popover", "vr-menu", className)}
      />
    </DropdownPrimitive.Portal>
  );
}

export type MenuItemProps = ComponentPropsWithRef<typeof DropdownPrimitive.Item> & ItemExtras;

export function MenuItem({ icon, shortcut, tone = "default", children, className, ...props }: MenuItemProps) {
  return (
    <DropdownPrimitive.Item {...props} data-tone={tone} className={cx("vr-menu-item", className)}>
      <ItemInner icon={icon} shortcut={shortcut}>
        {children}
      </ItemInner>
    </DropdownPrimitive.Item>
  );
}

export function MenuLabel({ className, ...props }: ComponentPropsWithRef<typeof DropdownPrimitive.Label>) {
  return <DropdownPrimitive.Label {...props} className={cx("vr-menu-label", className)} />;
}

export function MenuSeparator({
  className,
  ...props
}: ComponentPropsWithRef<typeof DropdownPrimitive.Separator>) {
  return <DropdownPrimitive.Separator {...props} className={cx("vr-menu-separator", className)} />;
}

/* Context menu */

export const ContextMenu = ContextPrimitive.Root;
export const ContextMenuTrigger = ContextPrimitive.Trigger;

export type ContextMenuContentProps = ComponentPropsWithRef<typeof ContextPrimitive.Content>;

export function ContextMenuContent({ className, ...props }: ContextMenuContentProps) {
  return (
    <ContextPrimitive.Portal>
      <ContextPrimitive.Content {...props} className={cx("vr-popover", "vr-menu", className)} />
    </ContextPrimitive.Portal>
  );
}

export type ContextMenuItemProps = ComponentPropsWithRef<typeof ContextPrimitive.Item> & ItemExtras;

export function ContextMenuItem({
  icon,
  shortcut,
  tone = "default",
  children,
  className,
  ...props
}: ContextMenuItemProps) {
  return (
    <ContextPrimitive.Item {...props} data-tone={tone} className={cx("vr-menu-item", className)}>
      <ItemInner icon={icon} shortcut={shortcut}>
        {children}
      </ItemInner>
    </ContextPrimitive.Item>
  );
}

export function ContextMenuLabel({
  className,
  ...props
}: ComponentPropsWithRef<typeof ContextPrimitive.Label>) {
  return <ContextPrimitive.Label {...props} className={cx("vr-menu-label", className)} />;
}

export function ContextMenuSeparator({
  className,
  ...props
}: ComponentPropsWithRef<typeof ContextPrimitive.Separator>) {
  return <ContextPrimitive.Separator {...props} className={cx("vr-menu-separator", className)} />;
}
