// Resumable upload: opens (or resumes) an upload session, sends the file in parts in order, and after a
// dropped connection asks the server where it stopped and goes on from there. A 409 with another offset
// (another tab sent the same part) is reconciled with the server; other request errors are not retried.
import type * as T from "@vanr/contract";
import type { StartUploadBody } from "./api/files.ts";
import type { Api } from "./client.ts";
import { type Clock, systemClock } from "./clock.ts";
import { ApiError } from "./errors.ts";

export interface UploadProgress {
  sent: number;
  total: number;
}

export interface UploadOptions {
  /** A session from before (the page reloaded): continues from the offset the server kept. */
  resume?: T.UploadSession;
  /** Called with each new session state (store it to resume later). */
  onSession?: (session: T.UploadSession) => void;
  onProgress?: (progress: UploadProgress) => void;
  signal?: AbortSignal;
  /** Consecutive failures of the same part before giving up. */
  retries?: number;
  /** Wait before retry number `attempt` (1-based). */
  retryWaitMs?: (attempt: number) => number;
  clock?: Clock;
}

export const UPLOAD_RETRIES = 6;
export const UPLOAD_BACKOFF_CAP_MS = 30_000;
export const uploadBackoff = (attempt: number) => Math.min(UPLOAD_BACKOFF_CAP_MS, 500 * 2 ** attempt);

type UploadApi = Pick<Api, "completeFileUpload" | "createFileUpload" | "getFileUpload" | "replaceFileUpload">;

function wait(clock: Clock, ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new ApiError({ status: 0, code: "canceled", message: "Canceled" }));
    const cancel = clock.setTimer(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      cancel();
      reject(new ApiError({ status: 0, code: "canceled", message: "Canceled" }));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Anything a part's call throws, as the client's one error (a raw error counts as the network failing). */
const asApiError = (err: unknown): ApiError =>
  err instanceof ApiError
    ? err
    : new ApiError({ status: 0, code: "network", message: "The upload failed on the way", cause: err });

const retryable = (err: unknown) => asApiError(err).retryable;

/** The right offset a 409 `upload.offset_mismatch` carries, when it carries one. */
function mismatchOffset(err: unknown): number | null {
  if (!(err instanceof ApiError) || err.code !== "upload.offset_mismatch") return null;
  const v = err.params?.offset;
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
}

export async function uploadInParts(
  api: UploadApi,
  workspaceId: string,
  file: Blob,
  start: Omit<StartUploadBody, "size">,
  options: UploadOptions = {},
): Promise<T.FileDetail> {
  try {
    return await sendParts(api, workspaceId, file, start, options);
  } catch (err) {
    // Whatever went wrong comes out as the one error; an abort by the caller is always `canceled`.
    if (options.signal?.aborted && !(err instanceof ApiError && err.code === "canceled")) {
      throw new ApiError({ status: 0, code: "canceled", message: "Canceled", cause: err });
    }
    throw asApiError(err);
  }
}

async function sendParts(
  api: UploadApi,
  workspaceId: string,
  file: Blob,
  start: Omit<StartUploadBody, "size">,
  options: UploadOptions = {},
): Promise<T.FileDetail> {
  const retries = options.retries ?? UPLOAD_RETRIES;
  const backoff = options.retryWaitMs ?? uploadBackoff;
  const clock = options.clock ?? systemClock;
  const signal = options.signal;
  const call = signal ? { signal } : undefined;

  let session =
    options.resume ??
    (await api.createFileUpload({ workspaceId, body: { ...start, size: file.size } }, call));
  options.onSession?.(session);
  let offset = session.offset;
  let confirmedOffset = offset;
  let failures = 0;
  options.onProgress?.({ sent: offset, total: file.size });

  while (offset < file.size) {
    const end = Math.min(offset + session.partSize, file.size);
    try {
      session = await api.replaceFileUpload(
        { workspaceId, uploadId: session.id, body: file.slice(offset, end), query: { offset } },
        call,
      );
      options.onSession?.(session);
      offset = session.offset;
      if (offset > confirmedOffset) {
        confirmedOffset = offset;
        failures = 0;
      }
      options.onProgress?.({ sent: offset, total: file.size });
    } catch (err) {
      if (signal?.aborted) throw err;
      const moved = mismatchOffset(err);
      if ((moved === null && !retryable(err)) || ++failures > retries) throw err;
      await wait(clock, backoff(failures), signal);
      // The part may have arrived before the connection dropped: the server says where it stopped.
      try {
        session = await api.getFileUpload({ workspaceId, uploadId: session.id }, call);
        if (session.offset > confirmedOffset) {
          confirmedOffset = session.offset;
          failures = 0;
        }
        offset = session.offset;
        options.onProgress?.({ sent: offset, total: file.size });
      } catch (statusErr) {
        if (!retryable(statusErr)) throw statusErr;
      }
    }
  }
  return api.completeFileUpload({ workspaceId, uploadId: session.id }, call);
}
