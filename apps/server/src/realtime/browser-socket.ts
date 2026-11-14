// The browser's WebSocket: /api/v1/realtime?workspaceId=. It authenticates by the session cookie, checks that
// the person is a member of the workspace and only lets them subscribe to a channel they can read.
import { schema } from "@vanr/engine/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { canReadChannel } from "../channels";
import type { AppDeps } from "../context";
import { errorBody } from "../http";
import { log } from "../logger";
import {
  liveViewDetach,
  liveViewInput,
  liveViewSubscribe,
  liveViewUnsubscribe,
} from "../runners/browser-live";
import type { BrowserSocket, BrowserSocketData } from "./hub";

/** A typing notice goes away on its own after this; the client sends one at most every 3 s. */
const TYPING_TTL_MS = 6000;
const TYPING_MIN_GAP_MS = 2000;
const MAX_FRAME = 64 * 1024;

const ClientFrame = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ping") }),
  z.object({ type: z.literal("subscribe"), channelId: z.string().min(1).max(64) }),
  z.object({ type: z.literal("unsubscribe"), channelId: z.string().min(1).max(64) }),
  z.object({ type: z.literal("typing"), channelId: z.string().min(1).max(64) }),
  z.object({ type: z.literal("live_view.subscribe"), agentId: z.string().min(1).max(64) }),
  z.object({ type: z.literal("live_view.unsubscribe"), agentId: z.string().min(1).max(64) }),
  z.object({
    type: z.literal("live_view.input"),
    agentId: z.string().min(1).max(64),
    events: z.array(z.record(z.string(), z.unknown())).max(100),
  }),
]);
type ClientFrame = z.infer<typeof ClientFrame>;

/** The upgrade's outcome: the socket's data or the error response. */
type UpgradeCheck = { ok: true; data: BrowserSocketData } | { ok: false; response: Response };

export async function checkBrowserUpgrade(
  deps: AppDeps,
  req: Request,
  trustedOrigins: string[],
): Promise<UpgradeCheck> {
  const fail = (status: number, code: string, message: string) => ({
    ok: false as const,
    response: Response.json(errorBody(code, message), { status }),
  });
  // The session cookie goes with any WebSocket: without checking the origin, another site would open the
  // connection on the person's behalf.
  const origin = req.headers.get("origin");
  if (origin && !trustedOrigins.includes(origin)) return fail(403, "forbidden", "Origin not allowed");
  const workspaceId = new URL(req.url).searchParams.get("workspaceId");
  if (!workspaceId) return fail(400, "invalid_request", "Missing workspaceId");
  const session = await deps.auth.api.getSession({ headers: req.headers });
  if (!session) return fail(401, "unauthorized", "Sign in to continue");
  const userId = session.user.id;
  const [m] = await deps.db
    .select({ userId: schema.members.userId })
    .from(schema.members)
    .where(and(eq(schema.members.workspaceId, workspaceId), eq(schema.members.userId, userId)));
  if (!m) return fail(404, "not_found", "Workspace not found");
  return {
    ok: true,
    data: { kind: "browser", workspaceId, userId, channels: new Set(), lastTypingAt: new Map() },
  };
}

export function browserOpen(deps: AppDeps, ws: BrowserSocket) {
  deps.hub.add(ws);
  ws.send(JSON.stringify({ type: "ready", workspaceId: ws.data.workspaceId, userId: ws.data.userId }));
  void deps.db
    .update(schema.members)
    .set({ lastOnlineAt: deps.now() })
    .where(
      and(eq(schema.members.workspaceId, ws.data.workspaceId), eq(schema.members.userId, ws.data.userId)),
    )
    .catch((err) => log.warn("ws.seen_failed", { err }));
}

export function browserClose(deps: AppDeps, ws: BrowserSocket) {
  deps.hub.remove(ws);
  liveViewDetach(deps, ws);
  void deps.db
    .update(schema.members)
    .set({ lastOnlineAt: deps.now() })
    .where(
      and(eq(schema.members.workspaceId, ws.data.workspaceId), eq(schema.members.userId, ws.data.userId)),
    )
    .catch((err) => log.warn("ws.seen_failed", { err }));
}

export async function browserMessage(deps: AppDeps, ws: BrowserSocket, raw: string | Buffer) {
  const text = typeof raw === "string" ? raw : raw.toString("utf8");
  if (text.length > MAX_FRAME) return reply(ws, { type: "error", code: "frame_too_large" });
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return reply(ws, { type: "error", code: "invalid_frame" });
  }
  const frame = ClientFrame.safeParse(parsed);
  if (!frame.success) return reply(ws, { type: "error", code: "invalid_frame" });
  await handle(deps, ws, frame.data);
}

async function handle(deps: AppDeps, ws: BrowserSocket, frame: ClientFrame) {
  const { workspaceId, userId } = ws.data;
  switch (frame.type) {
    case "ping":
      return reply(ws, { type: "pong" });
    case "subscribe": {
      if (!(await canReadChannel(deps.db, { workspaceId, userId, channelId: frame.channelId }))) {
        return reply(ws, { type: "error", code: "forbidden", channelId: frame.channelId });
      }
      deps.hub.subscribe(ws, frame.channelId);
      return reply(ws, { type: "subscribed", channelId: frame.channelId });
    }
    case "unsubscribe":
      deps.hub.unsubscribe(ws, frame.channelId);
      return reply(ws, { type: "unsubscribed", channelId: frame.channelId });
    case "typing": {
      if (!ws.data.channels.has(frame.channelId)) {
        return reply(ws, { type: "error", code: "not_subscribed", channelId: frame.channelId });
      }
      const at = deps.now().getTime();
      const last = ws.data.lastTypingAt.get(frame.channelId) ?? 0;
      if (at - last < TYPING_MIN_GAP_MS) return;
      ws.data.lastTypingAt.set(frame.channelId, at);
      deps.hub.toChannel(
        frame.channelId,
        { type: "person.typing", userId, ttlMs: TYPING_TTL_MS },
        { exceptUserId: userId },
      );
      return;
    }
    case "live_view.subscribe":
      return liveViewSubscribe(deps, ws, frame.agentId);
    case "live_view.unsubscribe":
      return liveViewUnsubscribe(deps, ws, frame.agentId);
    case "live_view.input":
      return liveViewInput(deps, ws, frame.agentId, frame.events);
    default: {
      const _exhaustive: never = frame;
      return _exhaustive;
    }
  }
}

function reply(ws: BrowserSocket, frame: Record<string, unknown>) {
  ws.send(JSON.stringify(frame));
}
