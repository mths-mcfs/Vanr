// How a call reaches the server. The Api (api.ts) is written against this interface, so swapping
// the transport (this fetch one for the shared client package) never touches a screen.
import { ApiError, errorFromResponse, unreachable } from "./error.ts";

export type Verb = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type TransportRequest = {
  verb: Verb;
  /** Path from the origin, already filled: `/api/v1/workspaces/ws_1/agents`. */
  path: string;
  query?: Record<string, string>;
  /** Sent as JSON. */
  body?: unknown;
  signal?: AbortSignal;
};

export interface Transport {
  /** The parsed JSON body of a 2xx answer (null when it has none). Rejects with an ApiError. */
  request(request: TransportRequest): Promise<unknown>;
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export type FetchTransportOptions = {
  /** Origin of the server; empty for the page's own origin. */
  baseUrl?: string;
  fetch?: FetchLike;
  /** The interface language, sent so the server writes emails in it. */
  locale?: () => string;
};

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.trim() === "") return null;
  try {
    const data: unknown = JSON.parse(text);
    return data;
  } catch {
    return undefined;
  }
}

/** JSON over fetch with the session cookie. */
export function createFetchTransport(options: FetchTransportOptions = {}): Transport {
  const send: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const baseUrl = options.baseUrl ?? "";
  return {
    async request({ verb, path, query, body, signal }) {
      const search = new URLSearchParams(query).toString();
      const headers: Record<string, string> = { accept: "application/json" };
      if (body !== undefined) headers["content-type"] = "application/json";
      const locale = options.locale?.();
      if (locale !== undefined) headers["accept-language"] = locale;
      let response: Response;
      try {
        response = await send(`${baseUrl}${path}${search === "" ? "" : `?${search}`}`, {
          method: verb,
          headers,
          credentials: "include",
          ...(body !== undefined && { body: JSON.stringify(body) }),
          ...(signal !== undefined && { signal }),
        });
      } catch (cause) {
        // An aborted call is the caller's own doing; let it see the abort.
        if (signal?.aborted) throw cause;
        throw unreachable();
      }
      const parsed = await readBody(response);
      if (!response.ok) {
        throw errorFromResponse({
          status: response.status,
          body: parsed,
          retryAfter: response.headers.get("retry-after"),
        });
      }
      if (parsed === undefined) {
        throw new ApiError({ status: 502, code: "response.malformed", message: "Response is not JSON" });
      }
      return parsed;
    },
  };
}
