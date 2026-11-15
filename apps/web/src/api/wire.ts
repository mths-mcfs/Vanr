// How the web's calls leave the browser: which fetch, which server and what goes with every call.
// main.tsx picks it once; the client and the sign-in calls are both built over it.
import type { FetchLike } from "@vanr/client";

export type WebTransport = {
  /** Origin of the server; empty for the page's own. */
  baseUrl: string;
  fetch: FetchLike;
  /** Sent with every call: the interface language, so the server writes emails in it. */
  headers: () => Record<string, string>;
};

export type FetchTransportOptions = {
  baseUrl?: string;
  fetch?: FetchLike;
  locale?: () => string;
};

/** The browser's fetch, with the session cookie and the interface language. */
export function createFetchTransport(options: FetchTransportOptions = {}): WebTransport {
  const send: FetchLike = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
  return {
    baseUrl: (options.baseUrl ?? "").replace(/\/+$/, ""),
    fetch: (url, init) => send(url, { ...init, credentials: "include" }),
    headers: () => {
      const headers: Record<string, string> = {};
      const locale = options.locale?.();
      if (locale !== undefined) headers["accept-language"] = locale;
      return headers;
    },
  };
}
