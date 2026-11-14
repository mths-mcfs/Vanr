import type { Catalog } from "../../i18n/format.ts";

/**
 * The text of each error, by the `code` the server sends. A code without an entry shows the
 * server's own message; `fallback` covers an error without one.
 */
export default {
  fallback: "That did not work. Try again.",
  "network.unreachable": "Vanr could not be reached. Check your connection and try again.",
  "response.malformed": "The server answered in a way this version does not understand. Reload the page.",
  "client.unexpected": "Something went wrong on this page. Try again.",
  unauthorized: "Your session ended. Sign in again.",
  forbidden: "You don't have permission to do that.",
  not_found: "That no longer exists.",
  invalid_request: "The server did not accept that request.",
  internal: "The server ran into a problem. Try again.",
  http_503: "The server is busy.",
  invalid_email_or_password: "That email and password don't match.",
  user_already_exists: "There is already an account with this email. Sign in instead.",
  user_already_exists_use_another_email: "There is already an account with this email. Sign in instead.",
  password_too_short: "Use at least 8 characters.",
  password_too_long: "Keep it to 128 characters or fewer.",
  invalid_token: "This link has expired or was already used.",
  signup_closed: "Sign-up is by invitation here. Ask a workspace admin for one.",
  signup_busy: "Another sign-up is creating the first account.",
  already_member: "This person is already a member.",
  "invitation.used": "This invitation was already used.",
  "invitation.wrong_email": "This invitation is for another email.",
} as const satisfies Catalog;
