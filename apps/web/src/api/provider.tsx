// Puts the client within reach of `@vanr/client/react` and the sign-in calls within reach of the
// account screens. The client is the one of the open session generation: when it changes, every
// screen is handed the new one and reads from the new one's part of the cache.
import { VanrProvider } from "@vanr/client/react";
import { createContext, type ReactNode, useContext, useSyncExternalStore } from "react";
import type { AuthApi } from "./auth.ts";
import type { WebApi } from "./web-api.ts";

const AuthContext = createContext<AuthApi | null>(null);

export function ApiProvider({ api, children }: { api: WebApi; children: ReactNode }) {
  const current = () => api.client;
  const client = useSyncExternalStore(api.subscribe, current, current);
  return (
    <AuthContext.Provider value={api.auth}>
      <VanrProvider client={client}>{children}</VanrProvider>
    </AuthContext.Provider>
  );
}

/** The sign-in service's calls. Only the account screens and the session use them. */
export function useAuth(): AuthApi {
  const auth = useContext(AuthContext);
  if (auth === null) throw new Error("useAuth must be used inside <ApiProvider>");
  return auth;
}
