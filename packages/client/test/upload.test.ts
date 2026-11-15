// Resumable upload against a scripted server: parts in order, recovery after a dropped part, a moved
// offset after a 409, and no retry for an error the request itself caused.
import { describe, expect, test } from "bun:test";
import type * as T from "@vanr/contract";
import type { Clock } from "../src/clock.ts";
import { ApiError } from "../src/errors.ts";
import { uploadInParts } from "../src/upload.ts";

/** Fires timers on the next microtask, so retries don't wait real time. */
const instantClock: Clock = {
  now: () => 0,
  setTimer: (fn) => {
    queueMicrotask(fn);
    return () => {};
  },
};

const session = (offset: number, size: number): T.UploadSession => ({
  id: "up_1",
  expiresAt: "2026-11-15T00:00:00.000Z",
  fileId: null,
  offset,
  partSize: 4,
  size,
  status: "open",
});

const detail = { id: "file_1" } as unknown as T.FileDetail;

function fakeApi(file: Blob, failOn: (call: number, offset: number) => ApiError | null) {
  let stored = 0;
  let calls = 0;
  const parts: number[] = [];
  return {
    parts,
    api: {
      createFileUpload: async () => session(0, file.size),
      getFileUpload: async () => session(stored, file.size),
      completeFileUpload: async () => detail,
      replaceFileUpload: async (args: { query?: { offset: number }; body: Blob }) => {
        const offset = args.query?.offset ?? -1;
        const err = failOn(calls++, offset);
        if (err) throw err;
        if (offset !== stored)
          throw new ApiError({
            status: 409,
            code: "upload.offset_mismatch",
            message: "",
            params: { offset: stored },
          });
        parts.push(offset);
        stored += args.body.size;
        return session(stored, file.size);
      },
    },
  };
}

describe("uploadInParts", () => {
  test("sends every part in order and reports progress", async () => {
    const file = new Blob(["0123456789"]);
    const { api, parts } = fakeApi(file, () => null);
    const progress: number[] = [];
    const out = await uploadInParts(
      api,
      "w",
      file,
      { fileName: "a.txt" },
      { onProgress: (p) => progress.push(p.sent) },
    );
    expect(out).toBe(detail);
    expect(parts).toEqual([0, 4, 8]);
    expect(progress).toEqual([0, 4, 8, 10]);
  });

  test("after a dropped part it asks the server where it stopped and goes on", async () => {
    const file = new Blob(["0123456789"]);
    const network = new ApiError({ status: 0, code: "network", message: "down" });
    const { api, parts } = fakeApi(file, (call) => (call === 1 ? network : null));
    await uploadInParts(api, "w", file, { fileName: "a.txt" }, { clock: instantClock });
    expect(parts).toEqual([0, 4, 8]);
  });

  test("a 409 with another offset reconciles with the server", async () => {
    const file = new Blob(["0123456789"]);
    const { api, parts } = fakeApi(file, () => null);
    // Resuming from a stale session: the server already has 4 bytes.
    await api.replaceFileUpload({ query: { offset: 0 }, body: file.slice(0, 4) });
    parts.length = 0;
    const options = { resume: session(0, file.size), clock: instantClock };
    await uploadInParts(api, "w", file, { fileName: "a.txt" }, options);
    expect(parts).toEqual([4, 8]);
  });

  test("an error the request caused is thrown at once", async () => {
    const file = new Blob(["0123456789"]);
    const tooLarge = new ApiError({ status: 413, code: "upload.part_too_large", message: "" });
    let tries = 0;
    const { api } = fakeApi(file, () => {
      tries++;
      return tooLarge;
    });
    await expect(uploadInParts(api, "w", file, { fileName: "a.txt" }, { clock: instantClock })).rejects.toBe(
      tooLarge,
    );
    expect(tries).toBe(1);
  });

  test.each([false, true])("offset conflicts exhaust retries (cyclic: %s)", async (cyclic) => {
    const file = new Blob(["0123456789"]);
    let tries = 0;
    const waits: number[] = [];
    const { api } = fakeApi(file, () => {
      tries++;
      return new ApiError({
        status: 409,
        code: tries > 6 ? "upload.closed" : "upload.offset_mismatch",
        message: "",
        params: { offset: cyclic ? (tries % 2) * 4 : 0 },
      });
    });
    let gets = 0;
    api.getFileUpload = async () => session(cyclic ? (++gets % 2) * 4 : 0, file.size);
    const retryWaitMs = (n: number) => {
      waits.push(n);
      return 0;
    };
    const options = { clock: instantClock, retries: 2, retryWaitMs };
    const uploading = uploadInParts(api, "w", file, { fileName: "a.txt" }, options);
    await expect(uploading).rejects.toMatchObject({ code: "upload.offset_mismatch" });
    expect(tries).toBe(cyclic ? 4 : 3);
    expect(waits).toEqual(cyclic ? [1, 1, 2] : [1, 2]);
  });

  test("confirmed progress renews the retry budget after each lost part response", async () => {
    const file = new Blob(["0123456789"]);
    const { api, parts } = fakeApi(file, () => null);
    const replace = api.replaceFileUpload;
    api.replaceFileUpload = async (args) => {
      await replace(args);
      throw new ApiError({ status: 0, code: "network", message: "response lost" });
    };
    await expect(
      uploadInParts(api, "w", file, { fileName: "a.txt" }, { clock: instantClock, retries: 1 }),
    ).resolves.toBe(detail);
    expect(parts).toEqual([0, 4, 8]);
  });

  test("gives up after the retry limit, and the limit is what stops it", async () => {
    const file = new Blob(["0123456789"]);
    const network = new ApiError({ status: 0, code: "network", message: "down" });
    let tries = 0;
    const { api } = fakeApi(file, () => {
      tries++;
      return network;
    });
    await expect(
      uploadInParts(api, "w", file, { fileName: "a.txt" }, { clock: instantClock, retries: 2 }),
    ).rejects.toBe(network);
    expect(tries).toBe(3);
  });
});

describe("uploadInParts failures", () => {
  test("a raw error from a part comes out as a network ApiError once the retries run out", async () => {
    const file = new Blob(["0123456789"]);
    const { api } = fakeApi(file, () => null);
    const raw = new TypeError("socket hang up");
    const failing = { ...api, replaceFileUpload: async () => Promise.reject(raw) };
    const err = await uploadInParts(
      failing,
      "w",
      file,
      { fileName: "a.txt" },
      { clock: instantClock, retries: 1 },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ code: "network", retryable: true, cause: raw });
  });

  test("an abort in the middle of a part is canceled, not retried", async () => {
    const file = new Blob(["0123456789"]);
    const { api } = fakeApi(file, () => null);
    const controller = new AbortController();
    let parts = 0;
    const hanging = {
      ...api,
      replaceFileUpload: () => {
        parts++;
        controller.abort();
        return Promise.reject(new TypeError("aborted"));
      },
    };
    const err = await uploadInParts(
      hanging,
      "w",
      file,
      { fileName: "a.txt" },
      { signal: controller.signal },
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "canceled", retryable: false });
    expect(parts).toBe(1);
  });

  test("parts go one at a time (the next starts only after the previous answered)", async () => {
    const file = new Blob(["0123456789"]);
    const { api } = fakeApi(file, () => null);
    let inFlight = 0;
    let most = 0;
    const counting = {
      ...api,
      replaceFileUpload: async (args: { query?: { offset: number }; body: Blob }) => {
        inFlight++;
        most = Math.max(most, inFlight);
        await Promise.resolve();
        inFlight--;
        return api.replaceFileUpload(args);
      },
    };
    await uploadInParts(counting, "w", file, { fileName: "a.txt" });
    expect(most).toBe(1);
  });
});
