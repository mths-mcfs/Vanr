// The live runs of every conversation of the open workspace, kept outside the screens. Leaving a
// conversation in the middle of a run and coming back shows the run where it is, text and steps
// included: while a channel has a live run, its events are still followed, and once its runs end the
// channel is let go. A reload starts over from the server's list.
import type { RealtimeClient } from "@vanr/client";
import type { ActiveRun } from "@vanr/contract";
import type { Clock } from "../../platform/clock.tsx";
import { followChannel } from "../../realtime/react.tsx";
import { applyRunEvent, type LiveRun, prune, type RunEvent, type RunEventBase, reconcile } from "./live.ts";

const RUN_EVENTS = [
  "run.status_changed",
  "run.text_delta",
  "run.thinking",
  "run.commentary",
  "run.tool_call",
  "run.tool_result",
  "run.completed",
  "run.stopped",
  "run.idle",
  "run.agent_unavailable",
  "delegation.started",
  "delegation.completed",
] as const;

const ENDING: ReadonlySet<string> = new Set(["run.completed", "run.stopped", "run.idle"]);

/** The runs of one channel. */
export class ChannelRuns {
  runs: readonly LiveRun[] = [];
  /** Runs known to have ended: a list read before the end never brings one back. */
  private readonly ended = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private release: (() => void) | null = null;

  constructor(
    private readonly realtime: RealtimeClient,
    private readonly channelId: string,
    private readonly clock: Clock,
  ) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  snapshot = () => this.runs;

  apply(base: RunEventBase, event: RunEvent): void {
    // A late event of a run that ended never brings it back.
    if (base.runId !== undefined && this.ended.has(base.runId)) return;
    if (base.runId !== undefined && ENDING.has(event.type)) this.ended.add(base.runId);
    this.set(applyRunEvent(this.runs, base, event, this.clock.now()));
  }

  list(active: readonly ActiveRun[], readAt: number): void {
    this.set(reconcile(this.runs, active, readAt, this.ended));
  }

  /** Drops everything of the channel: the person can no longer read it. */
  forget(): void {
    this.ended.clear();
    this.set([]);
  }

  private set(next: readonly LiveRun[]): void {
    const runs = prune(next, this.clock.now());
    if (runs === this.runs) return;
    this.runs = runs;
    // While a run is live the channel stays followed, so nothing it says is missed off screen.
    const live = runs.some((run) => run.endedAt === null);
    if (live && this.release === null) this.release = followChannel(this.realtime, this.channelId);
    if (!live && this.release !== null) {
      this.release();
      this.release = null;
    }
    for (const listener of this.listeners) listener();
  }
}

type Workspace = { channels: Map<string, ChannelRuns>; clock: Clock };
const workspaces = new WeakMap<RealtimeClient, Workspace>();

/** The runs of a channel on this connection; the first call starts listening to the run events. */
export function channelRuns(realtime: RealtimeClient, channelId: string, clock: Clock): ChannelRuns {
  let workspace = workspaces.get(realtime);
  if (workspace === undefined) {
    const created: Workspace = { channels: new Map(), clock };
    workspace = created;
    workspaces.set(realtime, created);
    for (const type of RUN_EVENTS) {
      realtime.on(type, (event) => {
        const payload: Record<string, unknown> = { ...event.payload };
        const channelId =
          typeof payload.channelId === "string"
            ? payload.channelId
            : event.scope.kind === "channel"
              ? event.scope.channelId
              : undefined;
        const agentId = typeof payload.agentId === "string" ? payload.agentId : undefined;
        const runId = typeof payload.runId === "string" ? payload.runId : undefined;
        // A delegation names only its run: the channel is the one that run lives in.
        const home =
          channelId ??
          [...created.channels.entries()].find(([, each]) =>
            each.runs.some((run) => run.runId === runId),
          )?.[0];
        if (home === undefined || agentId === undefined) return;
        const threadId = payload.threadId;
        channelRuns(realtime, home, created.clock).apply(
          {
            agentId,
            ...(runId !== undefined && { runId }),
            ...((typeof threadId === "string" || threadId === null) && { threadId }),
          },
          { ...payload, type } as RunEvent,
        );
      });
    }
  }
  let runs = workspace.channels.get(channelId);
  if (runs === undefined) {
    runs = new ChannelRuns(realtime, channelId, workspace.clock);
    workspace.channels.set(channelId, runs);
  }
  return runs;
}

/** Drops a channel's live runs, when the person lost the channel. */
export function forgetChannelRuns(realtime: RealtimeClient, channelId: string): void {
  workspaces.get(realtime)?.channels.get(channelId)?.forget();
}
