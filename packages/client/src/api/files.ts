// The workspace's files: versions, text extraction, uploads (simple and resumable), downloads and trash.
import type * as T from "@vanr/contract";
import * as C from "../contract-schemas.ts";
import { DOWNLOAD, endpoint as e, NOTHING } from "../endpoint.ts";
import * as s from "../schema.ts";
import { FileLink, FileText, FileVersion } from "./shapes.ts";

/** Content written in the app (everything but an uploaded file). */
export type WrittenContent = Exclude<T.FileContent, { kind: "file" }>;

export interface UploadFileBody {
  file: { blob: Blob; fileName: string };
  title?: string;
  channelId?: string;
  threadId?: string;
}

export interface StartUploadBody {
  fileName: string;
  size: number;
  contentType?: string;
  title?: string;
  channelId?: string;
  threadId?: string;
  note?: string;
  /** Uploading a new version of this file instead of a new file. */
  fileId?: string;
  /** The version the new one replaces; another current version fails with `file.version_conflict`. */
  parentVersion?: number;
  sha256?: string;
}

export const files = {
  listFiles: e("GET", "/api/v1/workspaces/:workspaceId/files", s.field("files", s.array(C.File))).query<{
    q?: string;
    kind?: T.FileKind;
    channelId?: string;
    authorKind?: "agent" | "person";
    authorId?: string;
  }>(),
  getFile: e("GET", "/api/v1/workspaces/:workspaceId/files/:fileId", C.FileDetail).query<{
    version?: number;
  }>(),
  createFile: e("POST", "/api/v1/workspaces/:workspaceId/files", C.FileDetail).body<{
    title: string;
    content: WrittenContent;
    channelId?: string;
    threadId?: string;
    note?: string;
  }>(),
  createFileVersion: e("POST", "/api/v1/workspaces/:workspaceId/files/:fileId/versions", C.FileDetail).body<{
    content: WrittenContent;
    parentVersion: number;
    note?: string;
    title?: string;
  }>(),
  listFileVersions: e(
    "GET",
    "/api/v1/workspaces/:workspaceId/files/:fileId/versions",
    s.field("versions", s.array(FileVersion)),
  ),
  getFileText: e("GET", "/api/v1/workspaces/:workspaceId/files/:fileId/text", FileText).query<{
    version?: number;
  }>(),
  /** A short-lived link to the file's bytes (for opening it outside the app). */
  getFileDownload: e("GET", "/api/v1/workspaces/:workspaceId/files/:fileId/download", FileLink).query<{
    version?: number;
  }>(),
  getFileBlob: e("GET", "/api/v1/workspaces/:workspaceId/files/:fileId/blob", DOWNLOAD).query<{
    version?: number;
    format?: "download" | "inline";
    variant?: "original" | "preview" | "thumb";
  }>(),
  deleteFile: e("DELETE", "/api/v1/workspaces/:workspaceId/files/:fileId", NOTHING),
  restoreFile: e("POST", "/api/v1/workspaces/:workspaceId/files/:fileId/restore", C.FileDetail),
  getFileTrash: e(
    "GET",
    "/api/v1/workspaces/:workspaceId/files/trash",
    s.field("files", s.array(C.TrashedFile)),
  ),

  /** One request with the whole file (multipart). For big files use the resumable upload. */
  uploadFile: e("POST", "/api/v1/workspaces/:workspaceId/files/files", C.FileDetail).form<UploadFileBody>(),
  uploadFileVersion: e("POST", "/api/v1/workspaces/:workspaceId/files/:fileId/files", C.FileDetail).form<{
    file: { blob: Blob; fileName: string };
    note?: string;
  }>(),
  createFileUpload: e(
    "POST",
    "/api/v1/workspaces/:workspaceId/files/uploads",
    C.UploadSession,
  ).body<StartUploadBody>(),
  getFileUpload: e("GET", "/api/v1/workspaces/:workspaceId/files/uploads/:uploadId", C.UploadSession),
  /** One part, starting at `offset`; 409 `upload.offset_mismatch` carries the right offset in `params`. */
  replaceFileUpload: e("PUT", "/api/v1/workspaces/:workspaceId/files/uploads/:uploadId", C.UploadSession)
    .bytes()
    .query<{ offset: number }>(),
  completeFileUpload: e(
    "POST",
    "/api/v1/workspaces/:workspaceId/files/uploads/:uploadId/complete",
    C.FileDetail,
  ),
  deleteFileUpload: e("DELETE", "/api/v1/workspaces/:workspaceId/files/uploads/:uploadId", NOTHING),
};
