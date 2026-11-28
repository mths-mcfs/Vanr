// The conversation's routes the client's fake lacks: a channel's directory (who can be mentioned),
// opening a direct message, the live runs of a channel, a run with its saved steps, and stopping a
// run. Who may stop a run follows the real server: whoever manages agents, the agent's owner, or the
// person who asked for the run. A run that already ended answers 409 `run.already_ended`. Tests start
// a run with `startRun` and drive it with the fake server's `emit`. Never part of the production build.
import type * as T from "@vanr/contract";
import type { FilesHost, FilesReply } from "./fake-files.ts";

type Scope = { workspaceId: string; user: T.User; role: T.Role };
type Room = { id: string; workspaceId: string; visibility: string; memberIds: string[] };

export type ChatHost = FilesHost & {
  channels: () => (Room & Omit<T.Channel, "isMember" | "unreadCount">)[];
  people: (workspaceId: string) => { userId: string; name: string; handle: string }[];
  agents: (workspaceId: string) => T.Agent[];
  dms: (workspaceId: string) => T.DirectMessage[];
};

type StoredRun = { workspaceId: string; active: T.ActiveRun | null; run: T.Run; steps: T.RunStep[] };

const reply = (status: number, body: unknown): FilesReply => ({ status, body });
const fail = (status: number, code: string, message: string) => reply(status, { error: { code, message } });
const manages = (role: T.Role) => role === "owner" || role === "admin";

export class FakeChat {
  runs: StoredRun[] = [];

  constructor(private readonly host: ChatHost) {}

  /** A run of an agent in a channel, live until `endRun`. */
  startRun(input: {
    workspaceId: string;
    runId: string;
    agentId: string;
    channelId: string;
    initiatedBy: string | null;
    threadId?: string | null;
  }): T.ActiveRun {
    const at = this.host.now().toISOString();
    const active: T.ActiveRun = {
      agentId: input.agentId,
      browser: false,
      channelId: input.channelId,
      initiatedBy: input.initiatedBy,
      lastPingAt: at,
      runId: input.runId,
      sourceMessageId: null,
      startedAt: at,
      status: "running",
      threadId: input.threadId ?? null,
    };
    this.runs.push({
      workspaceId: input.workspaceId,
      active,
      steps: [],
      run: {
        id: input.runId,
        agentId: input.agentId,
        blockedRepo: null,
        cachedTokens: 0,
        channelId: input.channelId,
        costUsd: 0,
        createdAt: at,
        error: null,
        errorCode: null,
        errorVars: null,
        finishedAt: null,
        inputTokens: 0,
        outputTokens: 0,
        repo: null,
        sourceMessageId: null,
        status: "running",
        threadId: input.threadId ?? null,
        what: "",
      },
    });
    return active;
  }

  /** Ends a run, keeping its saved steps. */
  endRun(runId: string, steps: T.RunStep[] = []): void {
    const stored = this.runs.find((each) => each.run.id === runId);
    if (stored === undefined) return;
    stored.active = null;
    stored.steps = steps;
    stored.run = { ...stored.run, status: "done", finishedAt: this.host.now().toISOString() };
  }

  private room(scope: Scope, channelId: unknown): Room | undefined {
    const room = this.host
      .channels()
      .find((each) => each.id === channelId && each.workspaceId === scope.workspaceId);
    if (room === undefined) return undefined;
    // A private channel answers as if it did not exist to someone who is not in it.
    if (room.visibility === "private" && !room.memberIds.includes(scope.user.id)) return undefined;
    return room;
  }

  operations(): Record<string, (params: Record<string, unknown>, session: string | undefined) => FilesReply> {
    const within =
      (handler: (scope: Scope, params: Record<string, unknown>) => FilesReply) =>
      (params: Record<string, unknown>, session: string | undefined) => {
        const scope = this.host.scope(params, session);
        return "status" in scope ? scope : handler(scope, params);
      };
    const notFound = () => fail(404, "not_found", "Channel not found");
    return {
      getChannelDirectory: within((scope, params) => {
        const room = this.room(scope, params.channelId);
        if (room === undefined) return notFound();
        const people = this.host
          .people(scope.workspaceId)
          .filter((person) => room.memberIds.includes(person.userId))
          .map((person) => ({ id: person.userId, type: "person", name: person.name, handle: person.handle }));
        const agents = this.host
          .agents(scope.workspaceId)
          .filter((agent) => agent.archivedAt === null)
          .map((agent) => ({
            id: agent.id,
            type: "agent",
            name: agent.name,
            handle: agent.handle,
            autoAnswer: false,
          }));
        return reply(200, { members: [...agents, ...people] });
      }),
      listChannelActiveRuns: within((scope, params) => {
        if (this.room(scope, params.channelId) === undefined) return notFound();
        const runs = this.runs.flatMap((each) =>
          each.workspaceId === scope.workspaceId && each.active?.channelId === params.channelId
            ? [each.active]
            : [],
        );
        return reply(200, { runs });
      }),
      getRun: within((scope, params) => {
        const stored = this.runs.find(
          (each) => each.workspaceId === scope.workspaceId && each.run.id === params.runId,
        );
        if (stored === undefined || this.room(scope, stored.run.channelId) === undefined)
          return fail(404, "not_found", "Run not found");
        return reply(200, { run: stored.run, steps: stored.steps });
      }),
      cancelRun: within((scope, params) => {
        const stored = this.runs.find(
          (each) => each.workspaceId === scope.workspaceId && each.run.id === params.runId,
        );
        if (stored === undefined) return fail(404, "not_found", "Run not found");
        if (stored.active === null) return fail(409, "run.already_ended", "This run already finished");
        const owner = this.host
          .agents(scope.workspaceId)
          .find((agent) => agent.id === stored.run.agentId)?.ownerUserId;
        const allowed =
          manages(scope.role) || owner === scope.user.id || stored.active.initiatedBy === scope.user.id;
        if (!allowed) return fail(403, "forbidden", "Forbidden");
        const { channelId, agentId, threadId } = stored.active;
        this.endRun(stored.run.id);
        stored.run = { ...stored.run, status: "canceled" };
        this.host.emit(scope.workspaceId, {
          type: "run.stopped",
          runId: stored.run.id,
          agentId,
          channelId,
          threadId,
        });
        return reply(204, null);
      }),
      createDm: within((scope, params) => {
        const agentId = typeof params.agentId === "string" ? params.agentId : undefined;
        const userId = typeof params.userId === "string" ? params.userId : undefined;
        const otherId = agentId ?? userId;
        const existing = this.host
          .dms(scope.workspaceId)
          .find(
            (dm) => dm.with.id === otherId && dm.with.type === (agentId === undefined ? "person" : "agent"),
          );
        if (existing !== undefined) return reply(200, { channelId: existing.channelId });
        const name =
          agentId !== undefined
            ? this.host.agents(scope.workspaceId).find((agent) => agent.id === agentId)?.name
            : this.host.people(scope.workspaceId).find((person) => person.userId === userId)?.name;
        if (otherId === undefined || name === undefined) return fail(404, "not_found", "Member not found");
        const channelId = this.host.id("dm");
        const memberIds =
          userId === undefined || userId === scope.user.id ? [scope.user.id] : [scope.user.id, userId];
        this.host.channels().push({
          id: channelId,
          workspaceId: scope.workspaceId,
          name: `dm-${channelId}`,
          topic: "",
          isGeneral: false,
          visibility: "private",
          budgetPerMonthUsd: null,
          createdAt: this.host.now().toISOString(),
          memberIds,
        });
        this.host.dms(scope.workspaceId).push({
          channelId,
          unread: 0,
          with: { id: otherId, name, type: agentId === undefined ? "person" : "agent" },
        });
        return reply(200, { channelId });
      }),
    };
  }
}
