import { Dialog as DialogPrimitive } from "radix-ui";
import type { ComponentPropsWithRef, ReactNode } from "react";
import { cx } from "../internal/cx.ts";

export const Drawer = DialogPrimitive.Root;
export const DrawerTrigger = DialogPrimitive.Trigger;
export const DrawerClose = DialogPrimitive.Close;

export type DrawerContentProps = Omit<ComponentPropsWithRef<typeof DialogPrimitive.Content>, "title"> & {
  /** Names the panel for assistive tech; not shown. */
  title: ReactNode;
  side?: "left" | "right";
};

/**
 * A panel that slides in from an edge over the page, for navigation on a small screen. Escape and a
 * press outside close it, and focus stays inside while it is open.
 */
export function DrawerContent({ title, side = "left", children, className, ...props }: DrawerContentProps) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="vr-dialog__overlay" />
      <DialogPrimitive.Content
        {...props}
        aria-describedby={undefined}
        data-side={side}
        className={cx("vr-drawer", className)}
      >
        <DialogPrimitive.Title className="vr-visually-hidden">{title}</DialogPrimitive.Title>
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}
