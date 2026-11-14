// Cache keys, derived from the method and its arguments: ["vanr", "listChannelMessages", { workspaceId,
// channelId, query }]. A prefix (the method and part of the arguments) matches every query under it, which
// is how an event invalidates "every page of this channel's messages" at once.
import type { MethodName } from "../api/index.ts";
import type { ArgsOf } from "../client.ts";

export const KEY_ROOT = "vanr";

export type QueryKeyOf<K extends MethodName> = readonly [
  typeof KEY_ROOT,
  K,
  ArgsOf<K> | Record<never, never>,
];

export function queryKey<K extends MethodName>(method: K, args?: ArgsOf<K>): QueryKeyOf<K> {
  return [KEY_ROOT, method, args ?? {}];
}

/** A method and, optionally, the arguments every matching query must have. */
export interface KeyPrefix {
  method: MethodName;
  args?: Record<string, unknown>;
}

export function prefixKey(prefix: KeyPrefix): readonly unknown[] {
  return prefix.args ? [KEY_ROOT, prefix.method, prefix.args] : [KEY_ROOT, prefix.method];
}
