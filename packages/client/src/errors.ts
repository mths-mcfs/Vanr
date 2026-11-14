// The one error every client call rejects with, whatever went wrong: the server said no, the network
// dropped, the deadline passed, the caller canceled, or the answer wasn't what the contract promises.
import { SERVER_ERROR_CODES } from "./error-codes.ts";

export type ServerErrorCode = (typeof SERVER_ERROR_CODES)[number];

/**
 * Failures that happen on this side of the wire. `network`, `timeout` and `canceled` are codes the server
 * table already has; `invalid_response` exists only in the client (the answer broke the contract).
 */
export type ClientErrorCode = "canceled" | "invalid_response" | "network" | "timeout";

/** `http_<status>`: the server failed without the error envelope, or with a code this client doesn't know. */
export type ErrorCode = ClientErrorCode | ServerErrorCode | `http_${number}`;

const KNOWN: ReadonlySet<string> = new Set(SERVER_ERROR_CODES);

export const isServerErrorCode = (code: string): code is ServerErrorCode => KNOWN.has(code);

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const RETRYABLE_CODES: ReadonlySet<string> = new Set([
  "network",
  "timeout",
  "rate_limit",
  "overloaded",
  "offline",
  "unreachable",
]);

export interface ApiErrorInit {
  /** HTTP status; 0 when no response arrived (network, timeout, canceled). */
  status: number;
  code: ErrorCode;
  message: string;
  /** The code exactly as the server sent it (differs from `code` only when the code is unknown here). */
  rawCode?: string;
  params?: Record<string, unknown>;
  cause?: unknown;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly rawCode: string;
  readonly params: Record<string, unknown> | undefined;
  /** Trying the same call again later can succeed (a dropped connection, a busy server, a deadline). */
  readonly retryable: boolean;

  constructor(init: ApiErrorInit) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = "ApiError";
    this.status = init.status;
    this.code = init.code;
    this.rawCode = init.rawCode ?? init.code;
    this.params = init.params;
    this.retryable = RETRYABLE_CODES.has(this.code) || RETRYABLE_STATUS.has(init.status);
  }
}

export const isApiError = (err: unknown): err is ApiError => err instanceof ApiError;
