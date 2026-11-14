// The one rule for cache keys: [method name, parameters]. Nothing else builds a key.
import type { ApiMethod, ParamsOf } from "./methods.ts";

export type QueryKey = readonly [method: string, params: Record<string, unknown>];

/** Parameters without undefined values and in a stable order, so equal calls share a key. */
function normalize(params: unknown): Record<string, unknown> {
  const entries = Object.entries(typeof params === "object" && params !== null ? params : {}).filter(
    ([, value]) => value !== undefined,
  );
  return Object.fromEntries(entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** The cache key of one call. */
export function queryKey<M extends ApiMethod>(method: M, params?: ParamsOf<M>): QueryKey {
  return [method, normalize(params)];
}

/** The key prefix of every call of a method, whatever its parameters: for invalidating them all. */
export function methodKey(method: ApiMethod): readonly [string] {
  return [method];
}
