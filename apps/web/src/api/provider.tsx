// Puts the client within reach of `@vanr/client/react` and the sign-in calls within reach of the
// account screens.
import { VanrProvider } from "@vanr/client/react";
import { createContext, type ReactNode, useContext } from "react";
import type { AuthApi } from "./auth.ts";
import type { WebApi } from "./web-api.ts";

const AuthContext = createContext<AuthApi | null>(null);

export function ApiProvider({ api, children }: { api: WebApi; children: ReactNode }) {
  return (
    <AuthContext.Provider value={api.auth}>
      <VanrProvider client={api.client}>{children}</VanrProvider>
    </AuthContext.Provider>
  );
}

/** The sign-in service's calls. Only the account screens and the session use them. */
export function useAuth(): AuthApi {
  const auth = useContext(AuthContext);
  if (auth === null) throw new Error("useAuth must be used inside <ApiProvider>");
  return auth;
}
