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
  messages: () => T.Message[];
};

type StoredRun = { workspaceId: string; active: T.ActiveRun | null; run: T.Run; steps: T.RunStep[] };

const reply = (status: number, body: unknown): FilesReply => ({ status, body });
const fail = (status: number, code: string, message: string) => reply(status, { error: { code, message } });
const manages = (role: T.Role) => role === "owner" || role === "admin";

export class FakeChat {
  runs: StoredRun[] = [];
  /** Threads with a record: one was answered or followed. Ids are their first message's. */
  threads: T.ThreadInfo[] = [];
  /** Who follows each thread, by thread id: following is each person's own. */
  followers = new Map<string, Set<string>>();
  /** Corrections sent to agents' answers, newest last. */
  feedback: { messageId: string; body: string }[] = [];

  /** A thread's record, made from its first message as the server makes it. */
  thread(rootId: string, by: string, fields: Partial<T.ThreadInfo> = {}): T.ThreadInfo {
    const existing = this.threads.find((each) => each.id === rootId);
    if (existing !== undefined) return existing;
    const root = this.host.messages().find((message) => message.id === rootId);
    const room = this.host.channels().find((each) => each.id === root?.channelId);
    const at = this.host.now().toISOString();
    const info: T.ThreadInfo = {
      id: rootId,
      actionNeeded: false,
      assignment: null,
      channelId: root?.channelId ?? "",
      channelName: room?.name ?? "",
      context: {
        channelId: root?.channelId ?? "",
        count: 0,
        lastMessageId: null,
        moved: false,
        omittedMessageIds: [],
        rootMessageId: rootId,
      },
      createdBy: { type: "person", id: by },
      firstReplyAt: null,
      following: false,
      lastMessage: null,
      lastTouchedAt: at,
      manageable: false,
      opener: root?.author ?? { type: "person", id: by },
      openingText: root?.body ?? "",
      participants: [],
      replyCount: this.host.messages().filter((message) => message.threadId === rootId).length,
      resolvedSuggestion: false,
      state: "open",
      title: "",
      venue: "channel",
      working: false,
      ...fields,
    };
    this.threads.push(info);
    return info;
  }

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
    const readableThread = (scope: Scope, threadId: unknown) => {
      const info = this.threads.find((each) => each.id === threadId);
      return info === undefined || this.room(scope, info.channelId) === undefined ? undefined : info;
    };
    // Whoever started a thread, or whoever configures the workspace, manages it.
    const shown = (scope: Scope, info: T.ThreadInfo): T.ThreadInfo => ({
      ...info,
      following: this.followers.get(info.id)?.has(scope.user.id) ?? false,
      manageable:
        (info.createdBy.type === "person" && info.createdBy.id === scope.user.id) || manages(scope.role),
    });
    return {
      listChannelMessages: within((scope, params) => {
        const room = this.room(scope, params.channelId);
        if (room === undefined) return notFound();
        const threadId = typeof params.threadId === "string" ? params.threadId : null;
        const limit = Math.min(Number(params.limit ?? 100) || 100, 200);
        let list = this.host.messages().filter((m) => m.channelId === room.id && m.threadId === threadId);
        if (typeof params.before === "string") {
          const at = list.findIndex((m) => m.id === params.before);
          if (at >= 0) list = list.slice(0, at);
        }
        list = list.slice(-limit);
        // In a thread, its first message comes before the first page.
        const root = threadId === null ? undefined : this.host.messages().find((m) => m.id === threadId);
        // As on the server: only a root of this very channel, and only a root (not a reply).
        if (
          root !== undefined &&
          root.channelId === room.id &&
          root.threadId === null &&
          params.before === undefined
        )
          list = [root, ...list];
        return reply(200, { messages: list });
      }),
      getThread: within((scope, params) => {
        const info = readableThread(scope, params.threadId);
        return info === undefined
          ? fail(404, "not_found", "Thread not found")
          : reply(200, shown(scope, info));
      }),
      listThreads: within((scope, params) => {
        const tab = typeof params.tab === "string" ? params.tab : "all";
        const q = typeof params.q === "string" ? params.q.toLowerCase() : "";
        const list = this.threads.filter(
          (info) =>
            this.room(scope, info.channelId) !== undefined &&
            (tab === "all"
              ? info.state !== "archived"
              : tab === "working"
                ? info.working
                : tab === "assignments"
                  ? info.assignment !== null
                  : info.state === tab) &&
            (params.actionNeeded === undefined || info.actionNeeded) &&
            (params.mine === undefined || info.createdBy.id === scope.user.id) &&
            (q === "" || info.title.toLowerCase().includes(q) || info.openingText.toLowerCase().includes(q)),
        );
        const limit = Number(params.limit ?? 30) || 30;
        const start = typeof params.cursor === "string" ? Number(params.cursor) : 0;
        const page = list.slice(start, start + limit);
        const next = start + limit < list.length ? String(start + limit) : null;
        return reply(200, { threads: page.map((info) => shown(scope, info)), nextCursor: next });
      }),
      followThread: within((scope, params) => {
        const root = this.host.messages().find((m) => m.id === params.threadId && m.threadId === null);
        if (root === undefined || this.room(scope, root.channelId) === undefined)
          return fail(404, "not_found", "Thread not found");
        this.thread(root.id, scope.user.id);
        this.followers.set(root.id, new Set(this.followers.get(root.id)).add(scope.user.id));
        return reply(200, { threadId: root.id, following: true });
      }),
      unfollowThread: within((scope, params) => {
        const info = readableThread(scope, params.threadId);
        if (info === undefined) return fail(404, "not_found", "Thread not found");
        this.followers.get(info.id)?.delete(scope.user.id);
        return reply(200, { threadId: info.id, following: false });
      }),
      runActionOnThread: within((scope, params) => {
        const info = readableThread(scope, params.threadId);
        if (info === undefined) return fail(404, "not_found", "Thread not found");
        if (!shown(scope, info).manageable)
          return fail(403, "forbidden", "Only who started the thread or an admin can change it");
        const next = { close: "closed", reopen: "open", unarchive: "open", archive: "archived" } as const;
        const state = next[params.action as keyof typeof next];
        if (state === undefined) return fail(400, "invalid_request", "Unknown action");
        info.state = state;
        return reply(200, shown(scope, info));
      }),
      createMessageFeedback: within((scope, params) => {
        const target = this.host.messages().find((m) => m.id === params.messageId);
        if (target === undefined || this.room(scope, target.channelId) === undefined)
          return fail(404, "not_found", "Message not found");
        if (target.author.type !== "agent")
          return fail(400, "invalid_request", "Only agent replies take feedback");
        const body = typeof params.body === "string" ? params.body.trim() : "";
        if (body === "" || body.length > 4000)
          return fail(400, "invalid_request", "Feedback must be 1 to 4000 characters");
        this.feedback.push({ messageId: target.id, body });
        return reply(200, target);
      }),
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
        // A direct message is the caller's with the other side: someone else's with the same person is not it.
        const isMine = (channelId: string) =>
          this.host
            .channels()
            .find((each) => each.id === channelId)
            ?.memberIds.includes(scope.user.id) ?? false;
        const existing = this.host
          .dms(scope.workspaceId)
          .find(
            (dm) =>
              dm.with.id === otherId &&
              dm.with.type === (agentId === undefined ? "person" : "agent") &&
              isMine(dm.channelId),
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
