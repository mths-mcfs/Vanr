import { X } from "lucide-react";
import { AlertDialog as AlertPrimitive, Dialog as DialogPrimitive } from "radix-ui";
import type { ComponentPropsWithRef, ReactNode } from "react";
import { cx } from "../internal/cx.ts";
import { Button } from "./Button.tsx";
import { Icon } from "./Icon.tsx";

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export type DialogContentProps = Omit<ComponentPropsWithRef<typeof DialogPrimitive.Content>, "title"> & {
  title: ReactNode;
  description?: ReactNode;
  /** Accessible name of the close button, in the interface language. */
  closeLabel: string;
  /** Buttons at the bottom, usually a cancel and a primary action. */
  footer?: ReactNode;
  size?: "sm" | "md" | "lg";
};

export function DialogContent({
  title,
  description,
  closeLabel,
  footer,
  size = "md",
  children,
  className,
  ...props
}: DialogContentProps) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="vr-dialog__overlay" />
      <DialogPrimitive.Content
        {...props}
        {...(description === undefined && { "aria-describedby": undefined })}
        className={cx("vr-dialog", `vr-dialog--${size}`, className)}
      >
        <header className="vr-dialog__header">
          <DialogPrimitive.Title className="vr-dialog__title">{title}</DialogPrimitive.Title>
          <DialogPrimitive.Close asChild>
            <Button variant="ghost" size="sm" icon={<Icon icon={X} />} aria-label={closeLabel} />
          </DialogPrimitive.Close>
        </header>
        {description !== undefined && (
          <DialogPrimitive.Description className="vr-dialog__description">
            {description}
          </DialogPrimitive.Description>
        )}
        {children !== undefined && <div className="vr-dialog__body">{children}</div>}
        {footer !== undefined && <footer className="vr-dialog__footer">{footer}</footer>}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export type ConfirmDialogProps = {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Element that opens the dialog, rendered as-is. */
  trigger?: ReactNode;
  title: ReactNode;
  description: ReactNode;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void;
  /** "danger" for actions that delete or cannot be undone. */
  tone?: "default" | "danger";
  /** Keeps the dialog open with a busy confirm button while the action runs. */
  confirming?: boolean;
};

/** Asks before an action. Escape and the cancel button close it; focus starts on cancel. */
export function ConfirmDialog({
  open,
  defaultOpen,
  onOpenChange,
  trigger,
  title,
  description,
  confirmLabel,
  cancelLabel,
  onConfirm,
  tone = "default",
  confirming = false,
}: ConfirmDialogProps) {
  return (
    <AlertPrimitive.Root
      {...(open !== undefined && { open })}
      {...(defaultOpen !== undefined && { defaultOpen })}
      {...(onOpenChange !== undefined && { onOpenChange })}
    >
      {trigger !== undefined && <AlertPrimitive.Trigger asChild>{trigger}</AlertPrimitive.Trigger>}
      <AlertPrimitive.Portal>
        <AlertPrimitive.Overlay className="vr-dialog__overlay" />
        <AlertPrimitive.Content className="vr-dialog vr-dialog--sm" data-tone={tone}>
          <header className="vr-dialog__header">
            <AlertPrimitive.Title className="vr-dialog__title">{title}</AlertPrimitive.Title>
          </header>
          <AlertPrimitive.Description className="vr-dialog__description">
            {description}
          </AlertPrimitive.Description>
          <footer className="vr-dialog__footer">
            <AlertPrimitive.Cancel asChild>
              <Button variant="secondary">{cancelLabel}</Button>
            </AlertPrimitive.Cancel>
            <Button
              variant={tone === "danger" ? "danger" : "primary"}
              loading={confirming}
              onClick={onConfirm}
            >
              {confirmLabel}
            </Button>
          </footer>
        </AlertPrimitive.Content>
      </AlertPrimitive.Portal>
    </AlertPrimitive.Root>
  );
}
