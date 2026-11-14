// The browser's WebSocket: /api/v1/realtime?workspaceId=. It authenticates by the session cookie, checks that
// the person is a member of the workspace and only lets them subscribe to a channel they can read.
import { schema } from "@vanr/engine/db";
import { and, eq, gt } from "drizzle-orm";
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
  recheckLiveViews,
} from "../runners/browser-live";
import type { BrowserSocket, BrowserSocketData } from "./hub";

/** A typing notice goes away on its own after this; the client sends one at most every 3 s. */
const TYPING_TTL_MS = 6000;
const TYPING_MIN_GAP_MS = 2000;
/** The biggest frame a browser may send, in bytes as it came on the wire (UTF-8). */
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
    data: {
      kind: "browser",
      workspaceId,
      userId,
      sessionId: session.session.id,
      channels: new Set(),
      lastTypingAt: new Map(),
    },
  };
}

/**
 * How often every open socket is checked again: its session (expired or ended where no hook told us), its
 * membership, the private channels it follows and the agents it watches. A frame that has an effect is checked
 * before it is taken, so this bounds only what the socket still receives.
 */
export const REVALIDATE_MS = 15_000;

/**
 * The right that opened the socket still holds: its session exists and hasn't expired (by the server's clock)
 * and the person is still a member of the workspace. Otherwise the socket is cut at once.
 */
async function stillAllowed(deps: AppDeps, ws: BrowserSocket): Promise<boolean> {
  const { sessions, members } = schema;
  const [row] = await deps.db
    .select({ id: sessions.id })
    .from(sessions)
    .innerJoin(
      members,
      and(eq(members.userId, sessions.userId), eq(members.workspaceId, ws.data.workspaceId)),
    )
    .where(
      and(
        eq(sessions.id, ws.data.sessionId),
        eq(sessions.userId, ws.data.userId),
        gt(sessions.expiresAt, deps.now()),
      ),
    );
  if (row) return true;
  deps.hub.cut(ws, 4401, "access ended");
  return false;
}

/** The sweep (every REVALIDATE_MS): every socket's right, the private channels it follows, the agents it watches. */
export async function revalidateBrowsers(deps: AppDeps): Promise<void> {
  for (const ws of deps.hub.sockets()) {
    if (!(await stillAllowed(deps, ws))) continue;
    const { workspaceId, userId } = ws.data;
    for (const channelId of [...ws.data.channels]) {
      if (await canReadChannel(deps.db, { workspaceId, userId, channelId })) continue;
      deps.hub.unsubscribe(ws, channelId);
      reply(ws, { type: "unsubscribed", channelId });
    }
  }
  await recheckLiveViews(deps);
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
  // The size on the wire, before decoding: a text frame arrives as a string, its UTF-8 length is the bytes sent.
  const bytes = typeof raw === "string" ? Buffer.byteLength(raw, "utf8") : raw.byteLength;
  if (bytes > MAX_FRAME) return reply(ws, { type: "error", code: "frame_too_large" });
  const text = typeof raw === "string" ? raw : raw.toString("utf8");
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
  // A frame with an effect is taken only while the right that opened the socket still holds.
  const effect =
    frame.type !== "ping" && frame.type !== "unsubscribe" && frame.type !== "live_view.unsubscribe";
  if (effect && !(await stillAllowed(deps, ws))) return;
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
      // Still able to read it now (a person who left a private channel doesn't type in it until the sweep).
      if (!(await canReadChannel(deps.db, { workspaceId, userId, channelId: frame.channelId }))) {
        deps.hub.unsubscribe(ws, frame.channelId);
        return reply(ws, { type: "error", code: "forbidden", channelId: frame.channelId });
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
      // Still allowed to see that agent (its audience may have changed since the watch began).
      await recheckLiveViews(deps, ws);
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
