// Account, sign-up waitlist and server health: the calls that come before (or without) a workspace.
import * as C from "../contract-schemas.ts";
import { endpoint as e } from "../endpoint.ts";
import { AuthConfig, Health, Ok } from "./shapes.ts";

export const account = {
  getHealth: e("GET", "/api/v1/health", Health),
  getAuthConfig: e("GET", "/api/v1/auth/config", AuthConfig),
  /** null when nobody is signed in. */
  getMe: e("GET", "/api/v1/me", C.Me).orNullOn(401),
  createWaitlist: e("POST", "/api/v1/waitlist", Ok).body<{ email: string; locale?: string }>(),
  confirmWaitlist: e("POST", "/api/v1/waitlist/confirm", Ok).body<{ token: string }>(),
};
