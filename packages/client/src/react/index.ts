// @vanr/client/react: provider, query and mutation hooks over the client, and cache invalidation driven by
// the realtime events.
export {
  type ApiMutationOptions,
  type ApiQueryOptions,
  QUERY_RETRIES,
  shouldRetry,
  useApiMutation,
  useApiQuery,
  useRealtime,
  useRealtimeEvent,
  useVanrClient,
} from "./hooks.ts";
export { INVALIDATION, type InvalidationRule, invalidateForEvent, keysForEvent } from "./invalidation.ts";
export { KEY_ROOT, type KeyPrefix, prefixKey, type QueryKeyOf, queryKey } from "./keys.ts";
export { VanrProvider, type VanrProviderProps } from "./provider.tsx";
