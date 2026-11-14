// The web's API layer is the shared client: screens call the server with the hooks of
// `@vanr/client/react` and nothing in this folder declares a method, a path or a schema of the
// server's table. What lives here is the little the client does not have:
//
// - wire.ts: the fetch every call leaves through (cookie, language);
// - web-api.ts: the client built over it, and the one place a 401 is noticed;
// - auth.ts: the sign-in service's seven calls, which are not in the server's table;
// - provider.tsx: the provider that hands both to the screens.
export {
  AUTH_PREFIX,
  AUTH_ROUTES,
  type AuthApi,
  type AuthMethod,
  authError,
  parseRetryAfter,
} from "./auth.ts";
export { ApiProvider, useAuth } from "./provider.tsx";
export { createWebApi, type WebApi, watchSession } from "./web-api.ts";
export { createFetchTransport, type FetchTransportOptions, type WebTransport } from "./wire.ts";
