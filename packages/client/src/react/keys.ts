// Cache keys, scoped to a client: ["vanr", clientScope, "listChannelMessages", { workspaceId,
// channelId, query }]. A prefix (the method and part of the arguments) matches every query under it, which
// is how an event invalidates "every page of this channel's messages" at once.
import type { MethodName } from "../api/index.ts";
import type { ArgsOf, VanrClient } from "../client.ts";

export const KEY_ROOT = "vanr";
const scopes = new WeakMap<VanrClient, number>();
let nextScope = 0;

/** Use a new client when changing identity, even when reusing the QueryClient. */
export function clientKey(client: VanrClient) {
  const scope = scopes.get(client) ?? ++nextScope;
  scopes.set(client, scope);
  return [KEY_ROOT, scope] as const;
}

export type QueryKeyOf<K extends MethodName> = readonly [
  typeof KEY_ROOT,
  number,
  K,
  ArgsOf<K> | Record<never, never>,
];

export function queryKey<K extends MethodName>(
  client: VanrClient,
  method: K,
  args?: ArgsOf<K>,
): QueryKeyOf<K> {
  return [...clientKey(client), method, args ?? {}];
}

/** A method and, optionally, the arguments every matching query must have. */
export interface KeyPrefix {
  method: MethodName;
  args?: Record<string, unknown>;
}

export function prefixKey(client: VanrClient, prefix: KeyPrefix): readonly unknown[] {
  const root = [...clientKey(client), prefix.method];
  return prefix.args ? [...root, prefix.args] : root;
}
