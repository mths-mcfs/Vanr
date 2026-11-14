// Queries and mutations over the client, keyed by method and arguments.
import {
  type UseMutationOptions,
  type UseQueryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import type { MethodName } from "../api/index.ts";
import type { ArgsOf, ResultOf, VanrClient } from "../client.ts";
import { ApiError } from "../errors.ts";
import type { BrowserEventName } from "../realtime/events.ts";
import type { RealtimeClient, RealtimeEvent } from "../realtime/socket.ts";
import { type KeyPrefix, prefixKey, type QueryKeyOf, queryKey } from "./keys.ts";
import { useVanrContext } from "./provider.tsx";

/** Retries a failed query only when trying again can help, up to this many times. */
export const QUERY_RETRIES = 3;

export const shouldRetry = (failureCount: number, error: unknown): boolean =>
  error instanceof ApiError && error.retryable && failureCount < QUERY_RETRIES;

export function useVanrClient(): VanrClient {
  return useVanrContext().client;
}

export function useRealtime(): RealtimeClient | null {
  return useVanrContext().realtime;
}

export type ApiQueryOptions<K extends MethodName> = Omit<
  UseQueryOptions<ResultOf<K>, ApiError, ResultOf<K>, QueryKeyOf<K>>,
  "queryFn" | "queryKey"
>;

/** `useApiQuery("listChannels", { workspaceId })`. Pass `enabled: false` while an argument is unknown. */
export function useApiQuery<K extends MethodName>(
  method: K,
  args: ArgsOf<K> | undefined,
  options?: ApiQueryOptions<K>,
) {
  const client = useVanrClient();
  return useQuery({
    retry: shouldRetry,
    ...options,
    queryKey: queryKey(method, args),
    queryFn: ({ signal }) => client.call(method, args, { signal }),
  });
}

export type ApiMutationOptions<K extends MethodName> = Omit<
  UseMutationOptions<ResultOf<K>, ApiError, ArgsOf<K>>,
  "mutationFn"
> & {
  /** What the change made stale; refetched after it succeeds, before `onSuccess`. */
  invalidates?: (args: ArgsOf<K>, result: ResultOf<K>) => KeyPrefix[];
};

/** `useApiMutation("createChannel").mutate({ workspaceId, body })`. */
export function useApiMutation<K extends MethodName>(method: K, options: ApiMutationOptions<K> = {}) {
  const client = useVanrClient();
  const qc = useQueryClient();
  const { invalidates, onSuccess, ...rest } = options;
  return useMutation({
    ...rest,
    mutationFn: (args: ArgsOf<K>) => client.call(method, args),
    onSuccess: async (...params: Parameters<NonNullable<typeof onSuccess>>) => {
      const [result, args] = params;
      if (invalidates) {
        await Promise.all(
          invalidates(args, result).map((p) => qc.invalidateQueries({ queryKey: prefixKey(p) })),
        );
      }
      await onSuccess?.(...params);
    },
  });
}

/** Runs `handler` for each event of this type while mounted (the latest handler, without resubscribing). */
export function useRealtimeEvent<E extends BrowserEventName>(
  type: E,
  handler: (event: RealtimeEvent<E>) => void,
) {
  const realtime = useRealtime();
  const latest = useRef(handler);
  latest.current = handler;
  useEffect(() => {
    if (!realtime) return;
    return realtime.on(type, (event) => latest.current(event));
  }, [realtime, type]);
}
