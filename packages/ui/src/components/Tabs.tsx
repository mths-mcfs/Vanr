import { Tabs as TabsPrimitive } from "radix-ui";
import type { ComponentPropsWithRef } from "react";
import { cx } from "../internal/cx.ts";

export const Tabs = TabsPrimitive.Root;

export function TabsList({ className, ...props }: ComponentPropsWithRef<typeof TabsPrimitive.List>) {
  return <TabsPrimitive.List {...props} className={cx("vr-tabs__list", className)} />;
}

export function TabsTrigger({ className, ...props }: ComponentPropsWithRef<typeof TabsPrimitive.Trigger>) {
  return <TabsPrimitive.Trigger {...props} className={cx("vr-tabs__trigger", className)} />;
}

export function TabsContent({ className, ...props }: ComponentPropsWithRef<typeof TabsPrimitive.Content>) {
  return <TabsPrimitive.Content {...props} className={cx("vr-tabs__content", className)} />;
}
