// The narrow API the web's screens call: one function per server operation, with named parameters
// and an answer that was validated before it is returned. Built over a Transport, so the wire
// (fetch today, the shared client package later) is chosen in index.ts and nowhere else.
import { type ApiError, malformed, toApiError } from "./error.ts";
import {
  API_METHODS,
  type ApiMethod,
  METHODS,
  type MethodSpec,
  type ParamsOf,
  type ResultOf,
} from "./methods.ts";
import type { Transport, TransportRequest, Verb } from "./transport.ts";

export type CallOptions = { signal?: AbortSignal };

/** The generic form of a call: `call("listAgents", { workspaceId })`. The hooks use it. */
export type ApiCall = <M extends ApiMethod>(
  method: M,
  params: ParamsOf<M>,
  options?: CallOptions,
) => Promise<ResultOf<M>>;

/** One function per operation (`api.getMe()`, `api.listAgents({ workspaceId })`), plus `call`. */
export type Api = {
  readonly [M in ApiMethod]: (params: ParamsOf<M>, options?: CallOptions) => Promise<ResultOf<M>>;
} & { readonly call: ApiCall };

export type ApiOptions = {
  /**
   * Called when an operation that needs a session answers 401: the session ended. The call still
   * rejects, so the screen that made it leaves its busy state.
   */
  onSessionEnded?: (error: ApiError) => void;
};

const PATH_PARAM = /:([A-Za-z][A-Za-z0-9]*)/g;

/** Splits the parameters into the filled path and what is left for the query string or the body. */
export function buildRequest(
  spec: { verb: Verb; path: string },
  params: Record<string, unknown>,
): Pick<TransportRequest, "verb" | "path" | "query" | "body"> {
  const rest = { ...params };
  const path = spec.path.replace(PATH_PARAM, (_, name: string) => {
    const value = rest[name];
    if (typeof value !== "string" || value === "") throw new Error(`parameter "${name}" is missing`);
    delete rest[name];
    return encodeURIComponent(value);
  });
  const left = Object.entries(rest).filter(([, value]) => value !== undefined);
  if (spec.verb === "GET" || spec.verb === "DELETE") {
    if (left.length === 0) return { verb: spec.verb, path };
    return {
      verb: spec.verb,
      path,
      query: Object.fromEntries(left.map(([key, value]) => [key, String(value)])),
    };
  }
  return { verb: spec.verb, path, body: Object.fromEntries(left) };
}

export function createApi(transport: Transport, options: ApiOptions = {}): Api {
  const run = async (method: ApiMethod, params: unknown, callOptions?: CallOptions): Promise<unknown> => {
    const spec: MethodSpec<never, unknown> = METHODS[method];
    let raw: unknown;
    try {
      raw = await transport.request({
        ...buildRequest(spec, isRecord(params) ? params : {}),
        ...(callOptions?.signal !== undefined && { signal: callOptions.signal }),
      });
    } catch (cause) {
      if (callOptions?.signal?.aborted) throw cause;
      const error = toApiError(cause);
      if (error.status === 401 && spec.session) options.onSessionEnded?.(error);
      throw error;
    }
    const parsed = spec.result.safeParse(raw);
    if (!parsed.success) throw malformed(method);
    return parsed.data;
  };
  // `run` validated the answer with the operation's own schema, which is what ResultOf<M> is
  // inferred from; these two casts only restore the link between a method name and its types.
  const call = run as ApiCall;
  const functions = Object.fromEntries(
    API_METHODS.map((method) => [
      method,
      (params: unknown, callOptions?: CallOptions) => run(method, params, callOptions),
    ]),
  );
  return { ...functions, call } as Api;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
