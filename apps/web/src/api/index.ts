// The API layer's public surface, and the ONE place where the wire is chosen. When the shared
// client package is on main, replace `createFetchTransport(...)` below with an adapter over it;
// no screen, hook or test outside this folder changes.
import { type Api, type ApiOptions, createApi } from "./api.ts";
import { createFetchTransport, type FetchTransportOptions } from "./transport.ts";

export function createWebApi(options: ApiOptions & FetchTransportOptions = {}): Api {
  const { onSessionEnded, ...wire } = options;
  return createApi(createFetchTransport(wire), onSessionEnded === undefined ? {} : { onSessionEnded });
}

export { type Api, type ApiOptions, type CallOptions, createApi } from "./api.ts";
export { ApiError, isApiError, toApiError } from "./error.ts";
export { methodKey, type QueryKey, queryKey } from "./keys.ts";
export {
  type AgentSummary,
  API_METHODS,
  type ApiMethod,
  type AuthConfig,
  METHODS,
  type ParamsOf,
  type ResultOf,
} from "./methods.ts";
export { ApiProvider, useApi, useApiMutation, useApiQuery, useInvalidate } from "./react.tsx";
export { createFetchTransport, type Transport, type TransportRequest, type Verb } from "./transport.ts";
