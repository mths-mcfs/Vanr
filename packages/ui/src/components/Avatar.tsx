import { Avatar as AvatarPrimitive } from "radix-ui";
import type { ComponentPropsWithRef } from "react";
import { cx } from "../internal/cx.ts";

export type AvatarSize = "sm" | "md" | "lg";

export type AvatarProps = Omit<ComponentPropsWithRef<typeof AvatarPrimitive.Root>, "children"> & {
  /** The person's name: the accessible name and the source of the initials. */
  name: string;
  src?: string;
  size?: AvatarSize;
};

/** Up to two initials: first and last word, so "Ana Beatriz Souza" becomes "AS". */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const first = words[0];
  if (first === undefined) return "?";
  const last = words.length > 1 ? words[words.length - 1] : undefined;
  const letters = [first, last].map((word) => (word === undefined ? "" : (Array.from(word)[0] ?? "")));
  return letters.join("").toLocaleUpperCase();
}

/** A person. Round, with a photo or initials; agents use <AgentSigil /> instead. */
export function Avatar({ name, src, size = "md", className, ...props }: AvatarProps) {
  return (
    <AvatarPrimitive.Root
      {...props}
      role="img"
      aria-label={name}
      className={cx("vr-avatar", `vr-avatar--${size}`, className)}
    >
      {src !== undefined && <AvatarPrimitive.Image className="vr-avatar__image" src={src} alt="" />}
      <AvatarPrimitive.Fallback className="vr-avatar__initials" aria-hidden="true">
        {initials(name)}
      </AvatarPrimitive.Fallback>
    </AvatarPrimitive.Root>
  );
}
