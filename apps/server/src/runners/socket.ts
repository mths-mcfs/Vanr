// The runners' WebSocket (`/api/v1/runners/connect`). The runner has 10 s to send the `hello` with the
// single-use session (taken with the device credential, see credentials.ts); after that the connection
// serves RPC, job events and the runner's state, for up to 24 h. A new connection of the same runner
// replaces the previous one (`rejected: replaced`).
import { schema } from "@vanr/engine/db";
import {
  BROWSER_GUARD_FEATURE,
  HEARTBEAT_MS,
  type HelloFrame,
  type RejectReason,
  RUNNER_PROTOCOL,
  type RunnerFrame,
  runnerFrame,
  type ServerFrame,
} from "@vanr/engine/runner-protocol";
import { eq } from "drizzle-orm";
import type { AppDeps } from "../context";
import { log } from "../logger";
import { onLiveViewFrame, onLiveViewStreamEnded } from "./browser-live";
import { CONNECTION_MAX_MS, consumeSession } from "./credentials";
import type { RunnerSocket, RunnerSocketData } from "./hub";
import { applyJobEvent, finishJob } from "./jobs";
import { agentsUsing, runnerSealer } from "./runners";
import { offeredUpdate } from "./update";

const { runners } = schema;
const HELLO_TIMEOUT_MS = 10_000;
const MAX_FRAME = 4 * 1024 * 1024;

export const runnerSocketData = (): RunnerSocketData => ({
  kind: "runner",
  runnerId: null,
  workspaceId: null,
  lastFrameAt: Date.now(),
  helloTimer: null,
  pingTimer: null,
  closed: false,
});

/** Every frame the server sends a runner is built from the protocol's types. */
function sendFrame(ws: RunnerSocket, frame: ServerFrame) {
  ws.send(JSON.stringify(frame));
}

function reject(ws: RunnerSocket, reason: RejectReason, message: string) {
  try {
    sendFrame(ws, { type: "rejected", reason, message });
  } finally {
    ws.close(4001, reason);
  }
}

export function runnerOpen(_deps: AppDeps, ws: RunnerSocket) {
  ws.data.helloTimer = setTimeout(() => {
    if (!ws.data.runnerId) ws.close(4002, "no hello");
  }, HELLO_TIMEOUT_MS);
}

export async function runnerMessage(deps: AppDeps, ws: RunnerSocket, raw: string | Buffer) {
  ws.data.lastFrameAt = Date.now();
  const text = typeof raw === "string" ? raw : raw.toString("utf8");
  if (text.length > MAX_FRAME) return ws.close(1009, "frame too large");
  let frame: RunnerFrame;
  try {
    frame = runnerFrame.parse(JSON.parse(text));
  } catch {
    if (!ws.data.runnerId) return ws.close(4003, "bad hello");
    log.warn("runner.bad_frame", { runnerId: ws.data.runnerId });
    return;
  }
  if (!ws.data.runnerId) {
    if (frame.type !== "hello") return ws.close(4003, "hello first");
    return hello(deps, ws, frame);
  }
  // A connection the server cut, or one another connection of the same runner replaced, changes nothing.
  if (!deps.runners.isCurrent(ws)) return;
  const runnerId = ws.data.runnerId;
  const workspaceId = ws.data.workspaceId as string;
  switch (frame.type) {
    case "hello":
      return;
    case "pong":
      return;
    case "result":
      deps.runners.onResult(ws, frame);
      return;
    case "output":
      deps.runners.onOutput(ws, frame);
      return;
    case "harness.event":
      deps.runners.onHarnessEvent(ws, frame);
      return;
    case "harness.tool":
      deps.runners.onHarnessTool(ws, frame);
      return;
    case "cli.changed": {
      const [row] = await deps.db
        .update(runners)
        .set({ cli: frame.cli, updatedAt: deps.now() })
        .where(eq(runners.id, runnerId))
        .returning({ name: runners.name });
      deps.hub.toWorkspace(workspaceId, { type: "runner.updated", runnerId, name: row?.name ?? "" });
      return;
    }
    case "job.event":
      await applyJobEvent(deps, runnerId, frame);
      return;
    case "job.done":
      // finishJob changes only a job of this runner; the ack goes to the sender alone (it forgets the job).
      await finishJob(deps, runnerId, frame.job);
      deps.runners.send(runnerId, { type: "job.ack", jobId: frame.job.jobId });
      return;
    case "runner.state": {
      await deps.db
        .update(runners)
        .set({ paused: frame.paused, updatedAt: deps.now() })
        .where(eq(runners.id, runnerId));
      deps.hub.toWorkspace(workspaceId, { type: "runner.pause_changed", runnerId, paused: frame.paused });
      return;
    }
    case "sandbox.changed": {
      await deps.db
        .update(runners)
        .set({ sandbox: frame.sandbox, updatedAt: deps.now() })
        .where(eq(runners.id, runnerId));
      deps.hub.toWorkspace(workspaceId, { type: "runner.sandbox_changed", runnerId, sandbox: frame.sandbox });
      return;
    }
    case "access.changed": {
      await deps.db
        .update(runners)
        .set({ access: frame.access, updatedAt: deps.now() })
        .where(eq(runners.id, runnerId));
      deps.hub.toWorkspace(workspaceId, { type: "runner.access", runnerId, access: frame.access });
      return;
    }
    case "live_view.frame":
      onLiveViewFrame(deps, runnerId, frame);
      return;
    case "live_view.stream_ended":
      onLiveViewStreamEnded(deps, runnerId, frame);
      return;
  }
}

async function hello(deps: AppDeps, ws: RunnerSocket, frame: HelloFrame) {
  // Version before credential: an old runner sends the token in the `hello` and must gain nothing from it.
  if (frame.protocol !== RUNNER_PROTOCOL)
    return reject(ws, "outdated", "This runner is out of date; install it again");
  const row = frame.session ? await consumeSession(deps, frame.session) : null;
  // After each wait the socket may have closed (the close handler already ran): nothing is registered or armed.
  const gone = () => {
    if (!ws.data.closed && ws.readyState === 1) return false;
    log.info("runner.hello_abandoned", { runnerId: row?.id ?? null });
    return true;
  };
  if (gone()) return;
  if (!row) return reject(ws, "invalid_token", "This session is not valid; the runner gets a new one");
  if (row.removedAt) return reject(ws, "revoked", "This runner was removed from the workspace");
  if (row.revokedAt) return reject(ws, "revoked", "This runner's access was revoked; pair it again");
  if (ws.data.helloTimer) clearTimeout(ws.data.helloTimer);
  ws.data.runnerId = row.id;
  ws.data.workspaceId = row.workspaceId;
  const previous = deps.runners.register(row.id, ws);
  if (previous) reject(previous, "replaced", "This runner connected again from another process");
  // A revocation between the session and the registration: it already closed the connections that existed, this one is new.
  const [now] = await deps.db
    .select({ revokedAt: runners.revokedAt, removedAt: runners.removedAt })
    .from(runners)
    .where(eq(runners.id, row.id));
  if (gone()) return;
  if (!now || now.revokedAt || now.removedAt)
    return reject(ws, "revoked", "This runner's access was revoked; pair it again");
  const accessChanged = JSON.stringify(row.access) !== JSON.stringify(frame.access);
  await deps.db
    .update(runners)
    .set({
      os: frame.os,
      arch: frame.arch,
      hostname: frame.hostname,
      runnerRelease: frame.version,
      workDir: frame.workDir,
      access: frame.access,
      executors: frame.executors,
      cli: frame.cli,
      // A runner without the browser guard (network proxy and the rule before the load) gets no browser.
      browser: frame.browser && frame.features.includes(BROWSER_GUARD_FEATURE),
      paused: frame.paused,
      sandbox: frame.sandbox,
      lastOnlineAt: deps.now(),
      disconnectedAt: null,
      updatedAt: deps.now(),
    })
    .where(eq(runners.id, row.id));
  if (gone()) return;
  const agents = await agentsUsing(deps.db, [row.id]);
  const update = await offeredUpdate(deps, frame.version);
  if (gone() || !deps.runners.isCurrent(ws)) return;
  sendFrame(ws, {
    type: "welcome",
    runnerId: row.id,
    name: row.name,
    heartbeatMs: HEARTBEAT_MS,
    storeKey: runnerSealer(deps).open(row.storeKey),
    agents: agents.map((a) => ({ id: a.id, handle: a.handle, name: a.name })),
    ...update,
  });
  const openedAt = Date.now();
  ws.data.pingTimer = setInterval(() => {
    if (Date.now() - ws.data.lastFrameAt > HEARTBEAT_MS * 2) {
      ws.close(4004, "no pong");
      return;
    }
    // A connection that lasted too long: the runner reconnects, takes a new session and rotates the credential.
    if (Date.now() - openedAt > CONNECTION_MAX_MS) {
      ws.close(4005, "session expired");
      return;
    }
    sendFrame(ws, { type: "ping", at: Date.now() });
  }, HEARTBEAT_MS);
  deps.hub.toWorkspace(row.workspaceId, { type: "runner.presence_changed", runnerId: row.id, online: true });
  if (JSON.stringify(row.sandbox) !== JSON.stringify(frame.sandbox))
    deps.hub.toWorkspace(row.workspaceId, {
      type: "runner.sandbox_changed",
      runnerId: row.id,
      sandbox: frame.sandbox,
    });
  if (accessChanged)
    deps.hub.toWorkspace(row.workspaceId, { type: "runner.access", runnerId: row.id, access: frame.access });
  for (const t of frame.jobs) {
    await finishJob(deps, row.id, t);
    if (t.status !== "running" && t.status !== "queued")
      deps.runners.send(row.id, { type: "job.ack", jobId: t.jobId });
  }
  log.info("runner.connected", { runnerId: row.id, version: frame.version });
}

export async function runnerClose(deps: AppDeps, ws: RunnerSocket) {
  ws.data.closed = true;
  if (ws.data.helloTimer) clearTimeout(ws.data.helloTimer);
  if (ws.data.pingTimer) clearInterval(ws.data.pingTimer);
  if (!deps.runners.unregister(ws)) return;
  const runnerId = ws.data.runnerId as string;
  const now = deps.now();
  await deps.db
    .update(runners)
    .set({ lastOnlineAt: now, disconnectedAt: now })
    .where(eq(runners.id, runnerId));
  deps.hub.toWorkspace(ws.data.workspaceId as string, {
    type: "runner.presence_changed",
    runnerId,
    online: false,
  });
}
