// Drive files: versions, uploads and trash.

import type { ActorRef } from "./common.ts";

export interface FileRef {
  id: string;
  deleted: boolean;
  title: string;
  version: number;
}

export type FileKind = "diagram" | "diff" | "document" | "file" | "html" | "table";

export type FileContent =
  | { kind: "document"; markdown: string }
  | { columns: string[]; kind: "table"; rows: string[][] }
  | { files: { patch: string; path: string }[]; kind: "diff" }
  | { kind: "diagram"; mermaid: string }
  | { html: string; kind: "html" }
  | {
      /** The type the uploader declared. */
      contentType: string;
      /** The type detected from the first bytes (the server serves it with this one); null = unknown binary. */
      detectedType: string | null;
      extract: ExtractStatus;
      extractError: string | null;
      /** PDF preview (converted Office document). */
      hasPreview: boolean;
      hasThumb: boolean;
      kind: "file";
      name: string;
      size: number;
      text: string | null;
      /** Pages of extracted text (PDF, slides, sheets). */
      totalPages: number;
    };

/** Extraction queue for the version: text per page and thumbnail. */
export type ExtractStatus = "failed" | "none" | "pending" | "ready" | "working";

export interface File {
  id: string;
  channelId: string | null;
  createdAt: string;
  createdBy: ActorRef;
  deletable: boolean;
  /** Drive listing: the current version has a thumbnail. */
  hasThumb?: boolean;
  kind: FileKind;
  threadId: string | null;
  title: string;
  updatedAt: string;
  updatedBy: ActorRef;
  version: number;
}

export interface FileDetail extends File {
  content: FileContent;
  editable: boolean;
  viewVersion: number;
}

export interface TrashedFile {
  id: string;
  createdBy: ActorRef;
  deletedAt: string;
  expungeAt: string;
  kind: FileKind;
  title: string;
}

export interface UploadSession {
  id: string;
  expiresAt: string;
  /** Completed: the file that was created or updated. */
  fileId: string | null;
  /** Next byte the server expects. */
  offset: number;
  /** Maximum size of each part. */
  partSize: number;
  size: number;
  status: "completing" | "done" | "open";
}
