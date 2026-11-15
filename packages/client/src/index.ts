// @vanr/client: the typed HTTP client for every Vanr route, the realtime connection and the error type.
// The React layer is `@vanr/client/react`; the in-memory server for tests is `@vanr/client/testing`.
export type * from "./api/agents.ts";
export type * from "./api/assignments.ts";
export type * from "./api/bases.ts";
export type * from "./api/chat.ts";
export type * from "./api/control.ts";
export type * from "./api/debates.ts";
export type * from "./api/files.ts";
export { AREAS, type Area, type Endpoints, endpoints, type MethodName } from "./api/index.ts";
export type * from "./api/runners.ts";
export type * from "./api/shapes.ts";
export type * from "./api/wiki.ts";
export type * from "./api/work.ts";
export type * from "./api/workspaces.ts";
export {
  type Api,
  type ArgsOf,
  type ClientOptions,
  createClient,
  type ResultOf,
  type VanrClient,
} from "./client.ts";
export { type Clock, systemClock } from "./clock.ts";
export type { CallOptions, Download, Verb } from "./endpoint.ts";
export {
  ApiError,
  type ClientErrorCode,
  type ErrorCode,
  isApiError,
  type ServerErrorCode,
} from "./errors.ts";
export { DEFAULT_TIMEOUT_MS, type FetchLike } from "./http.ts";
export {
  BROWSER_EVENTS,
  type BrowserEventName,
  type EventPayload,
  isBrowserEvent,
  NOT_BROWSER_EVENTS,
} from "./realtime/events.ts";
export {
  type AnyRealtimeEvent,
  CLOSE_REMOVED,
  CLOSE_SESSION_ENDED,
  createRealtime,
  type EventScope,
  RealtimeClient,
  type RealtimeEvent,
  type RealtimeOptions,
  type RealtimeStatus,
  reconnectDelay,
  type SocketLike,
} from "./realtime/socket.ts";
export { type UploadOptions, type UploadProgress, uploadInParts } from "./upload.ts";
