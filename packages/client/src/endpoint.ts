// How a client method is declared: verb, path, what it sends and what it answers. The parameters of a
// call come from the path itself (`:workspaceId` becomes `{ workspaceId: string }`), plus `body` and
// `query` when the endpoint takes them, so every method has the same named-arguments shape.
import type { AnySchema, Schema } from "./schema.ts";
import * as s from "./schema.ts";

export type Verb = "DELETE" | "GET" | "PATCH" | "POST" | "PUT";

type Empty = Record<never, never>;
type Flatten<T> = { [K in keyof T]: T[K] };

/** `{ workspaceId: string; channelId: string }` from `/workspaces/:workspaceId/channels/:channelId`. */
export type PathParams<P extends string> = P extends `${infer Base}?${string}`
  ? PathParams<Base>
  : P extends `${string}:${infer Name}/${infer Rest}`
    ? { [K in Name]: string } & PathParams<`/${Rest}`>
    : P extends `${string}:${infer Name}`
      ? { [K in Name]: string }
      : Empty;

/** A value a multipart form field can hold. A Blob without a name goes as `blob`. */
export type FormValue = string | number | boolean | Blob | { blob: Blob; fileName: string } | undefined;
export type FormFields = Record<string, FormValue>;

export type QueryValue = string | number | boolean | readonly string[] | null | undefined;
export type QueryParams = Record<string, QueryValue>;

/** A file the server streams back. `body` is read once; `blob()` reads it whole. */
export interface Download {
  body: ReadableStream<Uint8Array>;
  contentType: string | null;
  /** From Content-Length; null when the server streams without it. */
  size: number | null;
  /** From Content-Disposition, when the server names the file. */
  fileName: string | null;
  blob(): Promise<Blob>;
}

export type Reply<R> = { kind: "json"; schema: Schema<R> } | { kind: "none" } | { kind: "download" };
export type Send = "bytes" | "form" | "json" | "none";

export interface Endpoint<P extends string = string, B = never, Q = never, R = unknown> {
  readonly verb: Verb;
  readonly path: P;
  readonly send: Send;
  readonly reply: Reply<R>;
  /** Statuses that mean "there is none" and resolve to null instead of failing (`getMe` on 401). */
  readonly nullOn: readonly number[];
  /** Phantom: carries the body and query types to the call signature. */
  readonly __io?: (body: B, query: Q) => R;
}

/** Any endpoint, whatever its types (what the transport and the route-table test take). */
export interface AnyEndpoint {
  readonly verb: Verb;
  readonly path: string;
  readonly send: Send;
  readonly reply: { kind: "json"; schema: AnySchema } | { kind: "none" } | { kind: "download" };
  readonly nullOn: readonly number[];
}

/** The answer has no body worth reading (204, or `{ ok: true }`). */
export const NOTHING = { kind: "none" } as const;
/** The answer is a file, handed over as a stream. */
export const DOWNLOAD = { kind: "download" } as const;

class Builder<P extends string, B, Q, R> implements Endpoint<P, B, Q, R> {
  declare readonly __io?: (body: B, query: Q) => R;
  constructor(
    readonly verb: Verb,
    readonly path: P,
    readonly reply: Reply<R>,
    readonly send: Send = "none",
    readonly nullOn: readonly number[] = [],
  ) {}
  /** Sends `body` as JSON. */
  body<NB>(): Builder<P, NB, Q, R> {
    return new Builder<P, NB, Q, R>(this.verb, this.path, this.reply, "json", this.nullOn);
  }
  /** Sends `body` as multipart/form-data (one field per key). */
  form<NB extends { [K in keyof NB]: FormValue }>(): Builder<P, NB, Q, R> {
    return new Builder<P, NB, Q, R>(this.verb, this.path, this.reply, "form", this.nullOn);
  }
  /** Sends `body` as raw bytes (application/octet-stream). */
  bytes(): Builder<P, Blob, Q, R> {
    return new Builder<P, Blob, Q, R>(this.verb, this.path, this.reply, "bytes", this.nullOn);
  }
  /** Takes optional query-string parameters. */
  query<NQ extends { [K in keyof NQ]: QueryValue }>(): Builder<P, B, NQ, R> {
    return new Builder<P, B, NQ, R>(this.verb, this.path, this.reply, this.send, this.nullOn);
  }
  /** Resolves to null when the server answers one of these statuses. */
  orNullOn(...statuses: number[]): Builder<P, B, Q, R | null> {
    // The reply's schema never sees the null: the transport returns it before reading the body.
    const reply: Reply<R | null> =
      this.reply.kind === "json" ? { kind: "json", schema: s.nullable(this.reply.schema) } : this.reply;
    return new Builder<P, B, Q, R | null>(this.verb, this.path, reply, this.send, statuses);
  }
}

export function endpoint<const P extends string, R>(
  verb: Verb,
  path: P,
  reply: Schema<R>,
): Builder<P, never, never, R>;
export function endpoint<const P extends string>(
  verb: Verb,
  path: P,
  reply: typeof NOTHING,
): Builder<P, never, never, void>;
export function endpoint<const P extends string>(
  verb: Verb,
  path: P,
  reply: typeof DOWNLOAD,
): Builder<P, never, never, Download>;
export function endpoint<P extends string, R>(
  verb: Verb,
  path: P,
  reply: Schema<R> | typeof NOTHING | typeof DOWNLOAD,
): Builder<P, never, never, R> {
  const r: Reply<R> = "check" in reply ? { kind: "json", schema: reply } : reply;
  return new Builder(verb, path, r);
}

type BodyArg<B> = [B] extends [never] ? Empty : { body: B };
type QueryArg<Q> = [Q] extends [never] ? Empty : { query?: Q };

export type CallArgs<E> =
  E extends Endpoint<infer P, infer B, infer Q, infer _R>
    ? Flatten<PathParams<P> & BodyArg<B> & QueryArg<Q>>
    : never;
export type CallResult<E> = E extends Endpoint<string, infer _B, infer _Q, infer R> ? R : never;

export interface CallOptions {
  signal?: AbortSignal;
  /** Overrides the client's deadline for this call, in milliseconds. */
  timeoutMs?: number;
}

/** The function a client exposes for an endpoint; the arguments are optional when the endpoint takes none. */
export type Caller<E> = keyof CallArgs<E> extends never
  ? (args?: CallArgs<E>, options?: CallOptions) => Promise<CallResult<E>>
  : (args: CallArgs<E>, options?: CallOptions) => Promise<CallResult<E>>;

/** Path parameter names in order (`["workspaceId", "channelId"]`). */
export function pathParamNames(path: string): string[] {
  return [...(path.split("?")[0] ?? "").matchAll(/:([A-Za-z]\w*)/g)].map((m) => m[1] ?? "");
}
