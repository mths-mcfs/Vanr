// Where to send someone after signing in. The address comes from the query string, so it is
// untrusted: only a path inside the web is accepted.
import { ROUTES } from "../routes.ts";

/** Screens nobody should be sent back to after signing in. */
const NEVER_RETURN_TO: readonly string[] = [
  ROUTES.login.path,
  ROUTES.signup.path,
  ROUTES.forgotPassword.path,
  ROUTES.resetPassword.path,
];

const BASE = "https://vanr.invalid";

/** The path, query and hash of `value` when it is an address inside the web; undefined otherwise. */
export function safeRedirect(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) return undefined;
  // Browsers treat a backslash like a slash, and drop tabs and line breaks from an address.
  if (/[\\\t\n\r]/.test(value)) return undefined;
  let url: URL;
  try {
    url = new URL(value, BASE);
  } catch {
    return undefined;
  }
  if (url.origin !== BASE) return undefined;
  if (NEVER_RETURN_TO.includes(url.pathname)) return undefined;
  return `${url.pathname}${url.search}${url.hash}`;
}
