// The live view of the agent's browser. Who watches gets 1 frame per second; who took the control through an
// active intervention gets 15 and sends mouse and keyboard. The runner only streams while someone watches; the
// last one to leave ends the stream a moment later. Both directions are rate limited here: frames past the
// stream's rate are dropped before they fan out to the watchers, and so is input past `INPUT_RATE`.

import type { RunnerAccess } from "@vanr/contract";
import { type Db, schema } from "@vanr/engine/db";
import { and, eq } from "drizzle-orm";
import type { AppDeps } from "../context";
import { log } from "../logger";
import type { BrowserSocket } from "../realtime/hub";
import { canTalkTo } from "../runtime/route";
import { openIntervention, policyFor } from "./browser-guard";
import { withPlanOwner } from "./plans";
import { interventionSession } from "./requests";
import { personMayUseRunner } from "./runners";

const { agents, runners } = schema;
const WATCH_FPS = 1;
const CONTROL_FPS = 15;
const UNWATCH_GRACE_MS = 1500;
/** Input messages a socket may send per second to the stream it controls (each one up to 100 events). */
const INPUT_RATE = 30;

/** A token bucket: `rate` tokens a second, at most `burst` kept. */
interface Bucket {
  tokens: number;
  at: number;
}

const bucket = (burst: number, at: number): Bucket => ({ tokens: burst, at });

function take(b: Bucket, now: number, rate: number, burst: number): boolean {
  b.tokens = Math.min(burst, b.tokens + (Math.max(0, now - b.at) / 1000) * rate);
  b.at = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

/** Frames a stream forwards per second: its rate, with one frame of slack for the network's jitter. */
const frameBurst = (fps: number) => fps + 1;

interface Stream {
  runnerId: string;
  workspaceId: string;
  watchers: Set<BrowserSocket>;
  /** null: an active stream lost its runner connection; zero: not streaming. */
  fps: number | null;
  seq: number;
  stopTimer: ReturnType<typeof setTimeout> | null;
  /**
   * The last frame sent. The screencast only sends a frame when the page changes: who starts watching a page
   * that stands still gets this one, or they would have no image.
   */
  lastFrame: Record<string, unknown> | null;
  /** The runner's frames: a runner sending faster than the stream's rate doesn't flood the watchers. */
  frames: Bucket;
  /**
   * The newest frame dropped by the rate, sent once the rate allows: the page may stand still after it, and the
   * watchers would keep an older image.
   */
  held: LiveFrame | null;
  heldTimer: ReturnType<typeof setTimeout> | null;
  /** Each controlling socket's input. */
  inputs: WeakMap<BrowserSocket, Bucket>;
}

const streams = new Map<string, Stream>();

const send = (ws: BrowserSocket, frame: Record<string, unknown>) => {
  try {
    ws.send(
      JSON.stringify(String(frame.type).startsWith("live_view.") ? { type: "event", event: frame } : frame),
    );
  } catch {
    // the socket is closing
  }
};

/** Who has the control now: the person of the active intervention. */
async function controllerOf(db: Db, agentId: string, now: Date): Promise<string | null> {
  const h = await openIntervention(db, agentId, now);
  return h?.status === "active" ? h.controllingUserId : null;
}

async function status(deps: AppDeps, agentId: string) {
  const h = await openIntervention(deps.db, agentId, deps.now());
  return {
    type: "live_view.status",
    agentId,
    mode: h?.status === "active" ? "control" : "watch",
    controllingUserId: h?.status === "active" ? h.controllingUserId : null,
    intervention: h ? { id: h.id, status: h.status } : null,
  };
}

export async function liveViewSubscribe(deps: AppDeps, ws: BrowserSocket, agentId: string) {
  const [agent] = await deps.db
    .select()
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.workspaceId, ws.data.workspaceId)));
  if (!agent || !canTalkTo(await withPlanOwner(deps.db, agent), ws.data.userId))
    return send(ws, { type: "live_view.unavailable", agentId, reason: "forbidden" });
  if (!agent.environmentId)
    return send(ws, { type: "live_view.unavailable", agentId, reason: "no_environment" });
  const [runner] = await deps.db.select().from(runners).where(eq(runners.id, agent.environmentId));
  if (!runner || runner.removedAt)
    return send(ws, { type: "live_view.unavailable", agentId, reason: "no_environment" });
  // Watching the browser is using the runner: its screen is the paired person's.
  if (!(await personMayUseRunner(deps.db, ws.data, runner)))
    return send(ws, { type: "live_view.unavailable", agentId, reason: "forbidden" });
  if (!deps.runners.isOnline(runner.id))
    return send(ws, { type: "live_view.unavailable", agentId, reason: "offline" });
  if (!runner.browser || !runner.access.tools.browser)
    return send(ws, { type: "live_view.unavailable", agentId, reason: "unavailable" });
  let s = streams.get(agentId);
  // The checks above awaited: a stream opened meanwhile on another runner (the agent moved) isn't the one allowed.
  if (s && s.runnerId !== runner.id)
    return send(ws, { type: "live_view.unavailable", agentId, reason: "no_environment" });
  if (!s) {
    s = {
      runnerId: runner.id,
      workspaceId: runner.workspaceId,
      watchers: new Set(),
      fps: 0,
      seq: 0,
      stopTimer: null,
      lastFrame: null,
      frames: bucket(frameBurst(WATCH_FPS), deps.now().getTime()),
      held: null,
      heldTimer: null,
      inputs: new WeakMap(),
    };
    streams.set(agentId, s);
  }
  if (s.stopTimer) {
    clearTimeout(s.stopTimer);
    s.stopTimer = null;
  }
  s.watchers.add(ws);
  send(ws, await status(deps, agentId));
  if (s.lastFrame) send(ws, s.lastFrame);
  await refreshStream(deps, agentId);
}

export function liveViewUnsubscribe(deps: AppDeps, ws: BrowserSocket, agentId: string) {
  const s = streams.get(agentId);
  if (!s) return;
  s.watchers.delete(ws);
  if (s.watchers.size > 0 || s.stopTimer) return;
  s.stopTimer = setTimeout(() => {
    if (s.watchers.size > 0) return;
    dropHeld(s);
    streams.delete(agentId);
    void deps.runners
      .call(s.runnerId, "live_view.stop", {}, { agent: { id: agentId, handle: "" }, timeoutMs: 10_000 })
      .catch(() => {});
  }, UNWATCH_GRACE_MS);
}

/** Takes the socket out of every stream (the tab closed). */
export function liveViewDetach(deps: AppDeps, ws: BrowserSocket) {
  for (const [agentId, s] of streams) if (s.watchers.has(ws)) liveViewUnsubscribe(deps, ws, agentId);
}

/** Fits the frame rate to the intervention's state (control = 15 fps) and tells who watches. */
export async function refreshStream(deps: AppDeps, agentId: string) {
  const s = streams.get(agentId);
  if (!s || s.watchers.size === 0) return;
  const fps = (await controllerOf(deps.db, agentId, deps.now())) ? CONTROL_FPS : WATCH_FPS;
  const st = await status(deps, agentId);
  for (const w of s.watchers) send(w, st);
  if (fps === s.fps) return;
  s.fps = fps;
  // A new stream (or a new rate) starts with a full budget.
  s.frames = bucket(frameBurst(fps), deps.now().getTime());
  const [agent] = await deps.db.select({ handle: agents.handle }).from(agents).where(eq(agents.id, agentId));
  try {
    const policy = await policyFor(deps, agentId, s.runnerId, fps === CONTROL_FPS ? "person" : "agent");
    await deps.runners.call(
      s.runnerId,
      "live_view.start",
      { fps, policy },
      { agent: { id: agentId, handle: agent?.handle ?? "" }, timeoutMs: 20_000 },
    );
  } catch (err) {
    if (s.fps === fps) s.fps = 0;
    for (const w of s.watchers) send(w, { type: "live_view.unavailable", agentId, reason: "unavailable" });
    log.warn("live_view.stream_failed", { err, agentId });
  }
}

export async function liveViewInput(
  deps: AppDeps,
  ws: BrowserSocket,
  agentId: string,
  events: Record<string, unknown>[],
) {
  const s = streams.get(agentId);
  if (!s?.watchers.has(ws)) return send(ws, { type: "error", code: "not_watching", agentId });
  const intervention = await openIntervention(deps.db, agentId, deps.now());
  if (
    intervention?.status !== "active" ||
    intervention.controllingUserId !== ws.data.userId ||
    interventionSession(deps, intervention.id) !== ws.data.sessionId
  )
    return send(ws, { type: "error", code: "not_in_control", agentId });
  const now = deps.now().getTime();
  let b = s.inputs.get(ws);
  if (!b) {
    b = bucket(INPUT_RATE, now);
    s.inputs.set(ws, b);
  }
  if (!take(b, now, INPUT_RATE, INPUT_RATE)) return send(ws, { type: "error", code: "rate_limit", agentId });
  // Only who has the control gets here. The runner already has the rule with the person driving, from the
  // driver notice (`pushPolicy`); input that reaches it after they hand back doesn't count.
  void deps.runners
    .call(
      s.runnerId,
      "live_view.input",
      { events: events.slice(0, 100) },
      { agent: { id: agentId, handle: "" }, timeoutMs: 10_000 },
    )
    .catch(() => {});
}

type LiveFrame = { agentId: string; data: string; width: number; height: number; url?: string };

function emitFrame(s: Stream, frame: LiveFrame) {
  s.seq += 1;
  const out = {
    type: "live_view.frame",
    agentId: frame.agentId,
    seq: s.seq,
    data: frame.data,
    metadata: { deviceWidth: frame.width, deviceHeight: frame.height, url: frame.url ?? null },
  };
  s.lastFrame = out;
  for (const w of s.watchers) send(w, out);
}

function dropHeld(s: Stream) {
  if (s.heldTimer) clearTimeout(s.heldTimer);
  s.heldTimer = null;
  s.held = null;
}

export function onLiveViewFrame(deps: AppDeps, runnerId: string, frame: LiveFrame) {
  const s = streams.get(frame.agentId);
  if (!s || s.runnerId !== runnerId) return;
  const fps = s.fps || WATCH_FPS;
  if (take(s.frames, deps.now().getTime(), fps, frameBurst(fps))) {
    dropHeld(s);
    return emitFrame(s, frame);
  }
  s.held = frame;
  if (s.heldTimer) return;
  const wait = Math.ceil(((1 - s.frames.tokens) / fps) * 1000);
  s.heldTimer = setTimeout(() => {
    s.heldTimer = null;
    const held = s.held;
    if (!held || streams.get(held.agentId) !== s) return;
    onLiveViewFrame(deps, runnerId, held);
  }, wait);
}

export function onLiveViewStreamEnded(
  _deps: AppDeps,
  runnerId: string,
  frame: { agentId: string; reason: "stopped" | "closed" | "error" },
) {
  const s = streams.get(frame.agentId);
  if (!s || s.runnerId !== runnerId) return;
  s.fps = 0;
  s.lastFrame = null;
  dropHeld(s);
  for (const w of s.watchers)
    send(w, { type: "live_view.ended", agentId: frame.agentId, reason: frame.reason });
}

/**
 * The server is stopping: every stream is dropped and every pending stop is canceled, so no timer outlives it.
 * The runners' connections close right after (RunnerHub.closeAll), which ends their streams.
 */
export function dropAllLiveViews() {
  for (const s of streams.values()) {
    if (s.stopTimer) clearTimeout(s.stopTimer);
    dropHeld(s);
  }
  streams.clear();
}

/** Tells the watchers the agent's live view ended and drops the stream (the runner is told to stop when online). */
export function endLiveView(deps: AppDeps, agentId: string) {
  const s = streams.get(agentId);
  if (!s) return;
  if (s.stopTimer) clearTimeout(s.stopTimer);
  dropHeld(s);
  streams.delete(agentId);
  for (const w of s.watchers) send(w, { type: "live_view.ended", agentId, reason: "closed" });
  if (deps.runners.isOnline(s.runnerId))
    void deps.runners
      .call(s.runnerId, "live_view.stop", {}, { agent: { id: agentId, handle: "" }, timeoutMs: 10_000 })
      .catch(() => {});
}

/** Every live view streamed by this runner ends (it was revoked, removed or lost its browser). */
export function endLiveViewsOf(deps: AppDeps, runnerId: string) {
  for (const [agentId, s] of [...streams]) if (s.runnerId === runnerId) endLiveView(deps, agentId);
}

/** Only an active screencast needs resuming when its connection ends or is replaced. */
export function resetLiveViewsOf(runnerId: string) {
  for (const s of streams.values())
    if (s.runnerId === runnerId) {
      if (s.fps !== 0) s.fps = null;
      s.lastFrame = null;
      dropHeld(s);
    }
}

/** Both the notification and the management result report the same change; apply each reduction once. */
export async function updateRunnerAccess(deps: AppDeps, runnerId: string, access: RunnerAccess) {
  const workspaceId = await deps.db.transaction(async (tx) => {
    const [runner] = await tx.select().from(runners).where(eq(runners.id, runnerId)).for("update");
    if (!runner) return null;
    const toolsReduced = (["browser", "claude", "codex", "commands"] as const).some(
      (tool) => runner.access.tools[tool] && !access.tools[tool],
    );
    const foldersReduced = runner.access.folders.some((folder) => {
      const grants = access.folders.filter((grant) => grant.path === folder.path);
      if (folder.agents.length === 0) return !grants.some((grant) => grant.agents.length === 0);
      return folder.agents.some(
        (id) => !grants.some((grant) => grant.agents.length === 0 || grant.agents.includes(id)),
      );
    });
    await tx.update(runners).set({ access, updatedAt: deps.now() }).where(eq(runners.id, runnerId));
    if (toolsReduced || foldersReduced) {
      // The runner announces the change before answering the access.reduce that made it.
      deps.runners.cancelPending(runnerId, undefined, "access.reduce");
      if (!access.tools.browser) endLiveViewsOf(deps, runnerId);
    }
    return runner.workspaceId;
  });
  if (workspaceId) deps.hub.toWorkspace(workspaceId, { type: "runner.access", runnerId, access });
}

/**
 * Checks each stream against the database now: a stream whose agent is gone or moved to another runner ends, and
 * a watcher who may no longer see the agent (left its audience, another workspace) stops watching. `only`
 * limits the watchers checked to one socket (before it sends a frame).
 */
export async function recheckLiveViews(deps: AppDeps, only?: BrowserSocket) {
  for (const [agentId, s] of [...streams]) {
    if (only && !s.watchers.has(only)) continue;
    const [agent] = await deps.db.select().from(agents).where(eq(agents.id, agentId));
    if (!agent || agent.environmentId !== s.runnerId) {
      endLiveView(deps, agentId);
      continue;
    }
    const [runner] = await deps.db.select().from(runners).where(eq(runners.id, s.runnerId));
    if (!runner || runner.removedAt || runner.revokedAt || !runner.browser || !runner.access.tools.browser) {
      endLiveView(deps, agentId);
      continue;
    }
    const talker = await withPlanOwner(deps.db, agent);
    for (const w of [...s.watchers]) {
      if (only && w !== only) continue;
      if (
        w.data.workspaceId === agent.workspaceId &&
        canTalkTo(talker, w.data.userId) &&
        (await personMayUseRunner(deps.db, w.data, runner))
      )
        continue;
      liveViewUnsubscribe(deps, w, agentId);
      send(w, { type: "live_view.unavailable", agentId, reason: "forbidden" });
    }
    if (s.fps === null && deps.runners.isOnline(s.runnerId)) await refreshStream(deps, agentId);
  }
}
