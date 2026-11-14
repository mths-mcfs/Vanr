// Values read from the address: where to send someone after signing in, and the tokens of the links
// the server emails. All of it is typed by whoever wrote the link, so it is checked here, in one
// place, and nothing here throws: an address that will not do counts as absent, and a token that
// will not do as an invalid link, which the screens already know how to show.
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
  // A path with a broken escape (`/invite/%`) is no address the router could open.
  if (decoded(url.pathname) === undefined) return undefined;
  return `${url.pathname}${url.search}${url.hash}`;
}

/** `text` with its percent-escapes resolved, or undefined when one of them is broken. */
function decoded(text: string): string | undefined {
  try {
    return decodeURIComponent(text);
  } catch {
    return undefined;
  }
}

/** The longest token a link may carry; the server's own are a fraction of this. */
export const LINK_TOKEN_MAX = 512;

/**
 * A token from a link (invitation, password reset, email or waitlist confirmation), or undefined
 * when the value cannot be one: not text, empty, too long, or with a space or a control character.
 */
export function linkToken(value: unknown): string | undefined {
  if (typeof value !== "string" || value === "" || value.length > LINK_TOKEN_MAX) return undefined;
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x20 || code === 0x7f) return undefined;
  }
  return value;
}

/** The invitation token in an address like `/invite/<token>`, when the person came from one. */
export function invitationTokenIn(address: unknown): string | undefined {
  const match = /^\/invite\/([^/?#]+)/.exec(safeRedirect(address) ?? "");
  return match?.[1] === undefined ? undefined : linkToken(decoded(match[1]));
}

/** The parts of an address inside the web, for the router; undefined when it is not one. */
export function addressParts(
  address: string,
): { path: string; search: Record<string, string>; hash: string } | undefined {
  if (!address.startsWith("/") || address.startsWith("//")) return undefined;
  let url: URL;
  try {
    url = new URL(address, BASE);
  } catch {
    return undefined;
  }
  if (url.origin !== BASE || decoded(url.pathname) === undefined) return undefined;
  return { path: url.pathname, search: Object.fromEntries(url.searchParams), hash: url.hash.slice(1) };
}
