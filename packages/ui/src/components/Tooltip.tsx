import { Tooltip as TooltipPrimitive } from "radix-ui";
import type { ReactElement, ReactNode } from "react";

export type TooltipProps = {
  /** The tooltip text. Supplements the trigger's name; never the only way to learn what it does. */
  content: ReactNode;
  /** A single focusable element. */
  children: ReactElement;
  side?: "top" | "right" | "bottom" | "left";
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Milliseconds before it opens on hover. Keyboard focus opens it right away. */
  delay?: number;
};

export function Tooltip({
  content,
  children,
  side = "top",
  open,
  defaultOpen,
  onOpenChange,
  delay = 400,
}: TooltipProps) {
  return (
    <TooltipPrimitive.Provider delayDuration={delay} skipDelayDuration={200}>
      <TooltipPrimitive.Root
        {...(open !== undefined && { open })}
        {...(defaultOpen !== undefined && { defaultOpen })}
        {...(onOpenChange !== undefined && { onOpenChange })}
      >
        <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content className="vr-tooltip" side={side} sideOffset={6} collisionPadding={8}>
            {content}
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}
