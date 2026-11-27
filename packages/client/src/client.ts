// createClient: one object with every API method, built over its own transport (no global state).

import { type Endpoints, endpoints, type MethodName } from "./api/index.ts";
import type { CallArgs, Caller, CallOptions, CallResult } from "./endpoint.ts";
import { createTransport, type Transport, type TransportOptions } from "./http.ts";

export type ClientOptions = TransportOptions;

/** Every method, by name: `api.listChannels({ workspaceId })`. */
export type Api = { [K in MethodName]: Caller<Endpoints[K]> };

export type ArgsOf<K extends MethodName> = CallArgs<Endpoints[K]>;
export type ResultOf<K extends MethodName> = CallResult<Endpoints[K]>;

export interface VanrClient {
  readonly api: Api;
  readonly transport: Transport;
  /** Calls a method by name (what the React layer uses to derive cache keys from the name). */
  call<K extends MethodName>(
    method: K,
    args: ArgsOf<K> | undefined,
    options?: CallOptions,
  ): Promise<ResultOf<K>>;
}

export function createClient(options: ClientOptions = {}): VanrClient {
  const transport = createTransport(options);
  const call = (method: MethodName, args: object | undefined, callOptions?: CallOptions) =>
    transport.call(endpoints[method], args ? { ...args } : undefined, callOptions);
  const api: Record<string, (args?: object, callOptions?: CallOptions) => Promise<unknown>> = {};
  for (const method of Object.keys(endpoints) as MethodName[]) {
    api[method] = (args, callOptions) => call(method, args, callOptions);
  }
  return {
    // The functions above are exactly the endpoints' callers; the mapped type is what TS can't follow.
    api: api as unknown as Api,
    transport,
    call: <K extends MethodName>(method: K, args: ArgsOf<K> | undefined, callOptions?: CallOptions) =>
      call(method, args, callOptions) as Promise<ResultOf<K>>,
  };
}
