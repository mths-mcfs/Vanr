// How screens reach the API: the provider and the hooks that tie operations to the query cache.
import {
  type UseMutationOptions,
  type UseQueryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { createContext, type ReactNode, useCallback, useContext } from "react";
import type { Api } from "./api.ts";
import type { ApiError } from "./error.ts";
import { methodKey, queryKey } from "./keys.ts";
import type { ApiMethod, ParamsOf, ResultOf } from "./methods.ts";

const ApiContext = createContext<Api | null>(null);

export function ApiProvider({ api, children }: { api: Api; children: ReactNode }) {
  return <ApiContext.Provider value={api}>{children}</ApiContext.Provider>;
}

export function useApi(): Api {
  const api = useContext(ApiContext);
  if (api === null) throw new Error("useApi must be used inside <ApiProvider>");
  return api;
}

type QueryExtras<M extends ApiMethod> = Omit<UseQueryOptions<ResultOf<M>, ApiError>, "queryKey" | "queryFn">;

/** Reads from the server through the cache. The key is `queryKey(method, params)`. */
export function useApiQuery<M extends ApiMethod>(method: M, params: ParamsOf<M>, options?: QueryExtras<M>) {
  const api = useApi();
  return useQuery<ResultOf<M>, ApiError>({
    ...options,
    queryKey: queryKey(method, params),
    queryFn: ({ signal }) => api.call(method, params, { signal }),
  });
}

/** Writes to the server. Mutations are never retried on their own. */
export function useApiMutation<M extends ApiMethod>(
  method: M,
  options?: Omit<UseMutationOptions<ResultOf<M>, ApiError, ParamsOf<M>>, "mutationFn">,
) {
  const api = useApi();
  return useMutation<ResultOf<M>, ApiError, ParamsOf<M>>({
    ...options,
    mutationFn: (params) => api.call(method, params),
  });
}

/** Marks cached answers stale: one call when `params` is given, every call of the method otherwise. */
export function useInvalidate() {
  const client = useQueryClient();
  return useCallback(
    <M extends ApiMethod>(method: M, params?: ParamsOf<M>) =>
      client.invalidateQueries({
        queryKey: params === undefined ? methodKey(method) : queryKey(method, params),
      }),
    [client],
  );
}
