// The Drive's upload queue: one file at a time, each in parts over a resumable session. Pausing cuts
// the connection and keeps the session; going on starts from the offset the server holds. The session
// is remembered in the browser by workspace, name, size and modification date, so after a reload the
// same file picked again goes on from where it stopped. Leaving the screen cuts the connections and
// keeps the sessions.
import { type ApiError, isApiError, uploadInParts } from "@vanr/client";
import { useVanrClient } from "@vanr/client/react";
import type { FileDetail, UploadSession } from "@vanr/contract";
import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { useRuntime } from "../../../app/context.tsx";
import { readStored, STORAGE_KEYS, writeStored } from "../../../platform/storage.ts";

/** The largest file the resumable upload takes. */
export const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024;

export type UploadState = "queued" | "sending" | "paused" | "done" | "failed" | "tooBig";

export type UploadItem = {
  readonly id: string;
  readonly file: File;
  readonly state: UploadState;
  readonly sent: number;
  readonly error?: ApiError | undefined;
};

/** Whether the item still has work to do (and so can be paused or canceled). */
export const isLive = (item: UploadItem) =>
  item.state === "queued" || item.state === "sending" || item.state === "paused";

/**
 * The browser's key for a file and where it goes: the same file picked again after a reload for the
 * same place has the same key; for another file (a new version of it) it is another upload.
 */
export const fileKey = (workspaceId: string, file: File, target: UploadTarget = {}) =>
  `${workspaceId}:${target.fileId ?? "new"}:${file.name}:${file.size}:${file.lastModified}`;

const Saved = z.record(z.string(), z.string());

/** The queue's next state after an event: a pure function, so the order of events is easy to test. */
export type QueueEvent =
  | { type: "add"; items: UploadItem[] }
  | { type: "patch"; id: string; patch: Partial<Omit<UploadItem, "id" | "file">> }
  | { type: "remove"; id: string }
  | { type: "clearFinished" };

export function queueReducer(items: readonly UploadItem[], event: QueueEvent): UploadItem[] {
  switch (event.type) {
    case "add":
      return [...items, ...event.items];
    case "patch":
      return items.map((item) => (item.id === event.id ? { ...item, ...event.patch } : item));
    case "remove":
      return items.filter((item) => item.id !== event.id);
    case "clearFinished":
      return items.filter(isLive);
  }
}

/** The next item to send: none while one is sending, otherwise the first one waiting. */
export function nextToSend(items: readonly UploadItem[]): UploadItem | undefined {
  if (items.some((item) => item.state === "sending")) return undefined;
  return items.find((item) => item.state === "queued");
}

let sequence = 0;
/** New queue items for picked files; a file over the limit is refused here, before any call. */
export function newItems(files: readonly File[]): UploadItem[] {
  return files.map((file) => {
    sequence += 1;
    return {
      id: `upload-${sequence}`,
      file,
      sent: 0,
      state: file.size > MAX_UPLOAD_BYTES ? "tooBig" : "queued",
    };
  });
}

export type UploadTarget = {
  /** A new version of this file instead of a new file. */
  fileId?: string;
  /** The version the new one replaces. */
  parentVersion?: number;
};

export function useUploadQueue(workspaceId: string, onDone: (file: FileDetail) => void) {
  const client = useVanrClient();
  const { store } = useRuntime();
  const [items, setItems] = useState<UploadItem[]>([]);
  const dispatch = useCallback(
    (event: QueueEvent) => setItems((current) => queueReducer(current, event)),
    [],
  );
  const controllers = useRef(new Map<string, AbortController>());
  const sessions = useRef(new Map<string, UploadSession>());
  const targets = useRef(new Map<string, UploadTarget>());
  const done = useRef(onDone);
  done.current = onDone;

  const remember = useCallback(
    (key: string, sessionId: string | null) => {
      const all = readStored(store, STORAGE_KEYS.uploads, Saved) ?? {};
      if (sessionId === null) delete all[key];
      else all[key] = sessionId;
      writeStored(store, STORAGE_KEYS.uploads, Object.keys(all).length === 0 ? undefined : all);
    },
    [store],
  );

  const send = useCallback(
    async (item: UploadItem) => {
      const target = targets.current.get(item.id) ?? {};
      const key = fileKey(workspaceId, item.file, target);
      const controller = new AbortController();
      controllers.current.set(item.id, controller);
      dispatch({ type: "patch", id: item.id, patch: { state: "sending", error: undefined } });
      try {
        // A session from this tab (paused) or from before a reload (kept in the browser).
        let resume = sessions.current.get(item.id);
        const before = readStored(store, STORAGE_KEYS.uploads, Saved)?.[key];
        if (resume === undefined && before !== undefined) {
          resume = await client.api
            .getFileUpload({ workspaceId, uploadId: before }, { signal: controller.signal })
            .catch(() => undefined);
          // A finished session is kept too: completing it again gives back the file it made, instead of
          // a second file when the answer to the first completion was lost.
          if (resume === undefined || resume.offset > item.file.size) resume = undefined;
        }
        const detail = await uploadInParts(
          client.api,
          workspaceId,
          item.file,
          {
            fileName: item.file.name,
            ...(item.file.type !== "" && { contentType: item.file.type }),
            ...target,
          },
          {
            ...(resume !== undefined && { resume }),
            signal: controller.signal,
            onSession: (session) => {
              sessions.current.set(item.id, session);
              remember(key, session.id);
            },
            onProgress: ({ sent }) => dispatch({ type: "patch", id: item.id, patch: { sent } }),
          },
        );
        remember(key, null);
        sessions.current.delete(item.id);
        dispatch({ type: "patch", id: item.id, patch: { state: "done", sent: item.file.size } });
        done.current(detail);
      } catch (cause) {
        if (controller.signal.aborted) return;
        const error = isApiError(cause) ? cause : undefined;
        dispatch({ type: "patch", id: item.id, patch: { state: "failed", error } });
      } finally {
        controllers.current.delete(item.id);
      }
    },
    [client, workspaceId, store, remember, dispatch],
  );

  useEffect(() => {
    const next = nextToSend(items);
    if (next !== undefined) void send(next);
  }, [items, send]);

  useEffect(() => {
    const open = controllers.current;
    return () => {
      for (const controller of open.values()) controller.abort();
    };
  }, []);

  /** Drops what the queue keeps for an item and the session it opened on the server. */
  const forget = (id: string) => {
    const item = items.find((candidate) => candidate.id === id);
    const session = sessions.current.get(id);
    if (item !== undefined) remember(fileKey(workspaceId, item.file, targets.current.get(id)), null);
    sessions.current.delete(id);
    targets.current.delete(id);
    if (session !== undefined && session.status === "open") {
      void client.api.deleteFileUpload({ workspaceId, uploadId: session.id }).catch(() => undefined);
    }
  };

  return {
    items,
    add(files: readonly File[], target: UploadTarget = {}) {
      const added = newItems(files);
      for (const item of added) targets.current.set(item.id, target);
      dispatch({ type: "add", items: added });
    },
    pause(id: string) {
      controllers.current.get(id)?.abort();
      dispatch({ type: "patch", id, patch: { state: "paused" } });
    },
    resume(id: string) {
      dispatch({ type: "patch", id, patch: { state: "queued", error: undefined } });
    },
    cancel(id: string) {
      controllers.current.get(id)?.abort();
      forget(id);
      dispatch({ type: "remove", id });
    },
    clearFinished() {
      // A failed upload may have left its session open on the server; it goes with the item.
      for (const item of items) if (item.state === "failed") forget(item.id);
      dispatch({ type: "clearFinished" });
    },
  };
}
