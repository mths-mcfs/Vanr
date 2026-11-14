// An in-memory Vanr server behind a fetch function: account, workspaces, channels and messages, with the
// real error envelope. For the client's own tests and for building the web app before the server lands.
//
//   const server = createFakeServer();
//   const client = createClient({ fetch: server.fetch });
//
// Routes the table knows but this fake doesn't implement answer 501; unknown paths answer 404
// `route_not_found`, like the server.
import type * as T from "@vanr/contract";
import { endpoints, type MethodName } from "../api/index.ts";
import { pathParamNames } from "../endpoint.ts";
import type { ServerErrorCode } from "../errors.ts";
import * as s from "../schema.ts";

class Fail extends Error {
  constructor(
    readonly status: number,
    readonly code: ServerErrorCode,
    message: string,
    readonly params?: Record<string, unknown>,
  ) {
    super(message);
  }
}

interface Request {
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
}

type Handler = (req: Request) => unknown;

export interface FakeState {
  users: T.User[];
  workspaces: (T.Workspace & { settings: { timezone: string } })[];
  members: (T.Person & { workspaceId: string })[];
  channels: (Omit<T.Channel, "isMember" | "unreadCount"> & { workspaceId: string; memberIds: string[] })[];
  messages: T.Message[];
  /** Per person and channel: id of the last message they read. */
  reads: Map<string, string>;
}

export interface FakeServerOptions {
  /** Who is signed in; null answers 401 to everything that needs a session. Default: the first seed user. */
  actingUser?: string | null;
  /** Starts empty instead of with the sample workspace. */
  empty?: boolean;
  /** Clock for createdAt fields (tests pass a fixed one). */
  now?: () => Date;
}

export interface FakeServer {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  state: FakeState;
  signIn(userId: string | null): void;
  /** Ids from the sample data, for tests. */
  sample: { workspaceId: string; defaultChannelId: string; userId: string };
}

const SAMPLE_TIME = "2026-11-02T09:00:00.000Z";

function person(user: T.User, role: T.Role, handle: string, timezone: string, workspaceId: string) {
  return {
    workspaceId,
    userId: user.id,
    name: user.name,
    email: user.email,
    handle,
    image: null,
    avatarUrl: null,
    role,
    timezone,
    online: false,
    lastOnlineAt: null,
    memberSince: SAMPLE_TIME,
  };
}

function emptyMessage(
  fields: Pick<T.Message, "author" | "body" | "channelId" | "createdAt" | "id">,
): T.Message {
  return {
    actions: [],
    agentMentionIds: [],
    clientId: null,
    editedAt: null,
    memories: [],
    meta: {},
    reactions: [],
    receipts: { claimedBy: [], handled: [], viewedBy: [] },
    replyCount: 0,
    runId: null,
    threadId: null,
    usage: null,
    ...fields,
  };
}

/** A small workspace with two people, three channels and a short conversation. */
function sampleState(): FakeState {
  const ada: T.User = { id: "user_ada", email: "ada@harbor.example", image: null, name: "Ada Park" };
  const sam: T.User = { id: "user_sam", email: "sam@harbor.example", image: null, name: "Sam Rivera" };
  const workspaceId = "workspace_harbor";
  const channel = (id: string, name: string, topic: string, isGeneral: boolean, memberIds: string[]) => ({
    id,
    workspaceId,
    name,
    topic,
    isGeneral,
    visibility: "public" as const,
    budgetPerMonthUsd: null,
    createdAt: SAMPLE_TIME,
    memberIds,
  });
  const at = (minute: number) => `2026-11-02T09:${String(minute).padStart(2, "0")}:00.000Z`;
  const by = (id: string): T.ActorRef => ({ id, type: "person" });
  return {
    users: [ada, sam],
    workspaces: [
      {
        id: workspaceId,
        name: "Harbor Labs",
        context: "A small team building tide sensors.",
        logo: null,
        settings: { timezone: "Europe/Lisbon" },
      },
    ],
    members: [
      person(ada, "owner", "ada", "Europe/Lisbon", workspaceId),
      person(sam, "member", "sam", "America/Toronto", workspaceId),
    ],
    channels: [
      channel("ch_general", "general", "Anything for the whole team", true, [ada.id, sam.id]),
      channel("ch_firmware", "firmware", "Sensor firmware and releases", false, [ada.id, sam.id]),
      channel("ch_field", "field-tests", "Notes from the pier", false, [sam.id]),
    ],
    messages: [
      emptyMessage({
        id: "msg_1",
        channelId: "ch_general",
        author: by(ada.id),
        body: "Morning! Pier test at 2pm.",
        createdAt: at(1),
      }),
      emptyMessage({
        id: "msg_2",
        channelId: "ch_general",
        author: by(sam.id),
        body: "I'll bring the spare buoy.",
        createdAt: at(4),
      }),
      emptyMessage({
        id: "msg_3",
        channelId: "ch_firmware",
        author: by(sam.id),
        body: "v0.9 flashes fine on rev B.",
        createdAt: at(7),
      }),
    ],
    reads: new Map(),
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const errorResponse = (status: number, code: string, message: string, params?: Record<string, unknown>) =>
  json({ error: params ? { code, message, params } : { code, message } }, status);

function bodyOf<V>(schema: s.Schema<V>, body: unknown): V {
  const r = schema.check(body, "$");
  if (!r.ok)
    throw new Fail(400, "invalid_request", "Invalid body", {
      path: r.issue.path,
      expected: r.issue.expected,
    });
  return r.value;
}

function compile(path: string): { re: RegExp; names: string[] } {
  const base = path.split("?")[0] ?? "";
  const names = pathParamNames(base);
  const re = new RegExp(
    `^${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/:[A-Za-z]\w*/g, "([^/]+)")}$`,
  );
  return { re, names };
}

const ROUTES = Object.entries(endpoints).map(([name, ep]) => ({ name, ep, ...compile(ep.path) }));

export function createFakeServer(options: FakeServerOptions = {}): FakeServer {
  const state: FakeState = options.empty
    ? { users: [], workspaces: [], members: [], channels: [], messages: [], reads: new Map() }
    : sampleState();
  let me: string | null =
    options.actingUser === undefined ? (state.users[0]?.id ?? null) : options.actingUser;
  const now = options.now ?? (() => new Date());
  let seq = 100;
  const newId = (prefix: string) => `${prefix}${seq++}`;

  const user = () => {
    const u = state.users.find((x) => x.id === me);
    if (!u) throw new Fail(401, "unauthorized", "Sign in to continue");
    return u;
  };
  const membership = (workspaceId: string | undefined) => {
    const u = user();
    const m = state.members.find((x) => x.workspaceId === workspaceId && x.userId === u.id);
    if (!m) throw new Fail(404, "not_found", "Workspace not found");
    return m;
  };
  const channelIn = (req: Request) => {
    const m = membership(req.params.workspaceId);
    const c = state.channels.find((x) => x.id === req.params.channelId && x.workspaceId === m.workspaceId);
    if (!c || (c.visibility === "private" && !c.memberIds.includes(m.userId))) {
      throw new Fail(404, "not_found", "Channel not found");
    }
    return { m, c };
  };
  const unread = (userId: string, channelId: string) => {
    const lastRead = state.reads.get(`${userId}:${channelId}`);
    const list = state.messages.filter((x) => x.channelId === channelId && x.threadId === null);
    const from = lastRead ? list.findIndex((x) => x.id === lastRead) + 1 : 0;
    return list.slice(from).filter((x) => x.author.id !== userId).length;
  };
  const toChannel = (c: FakeState["channels"][number], userId: string): T.Channel => ({
    id: c.id,
    name: c.name,
    topic: c.topic,
    isGeneral: c.isGeneral,
    visibility: c.visibility,
    budgetPerMonthUsd: c.budgetPerMonthUsd,
    createdAt: c.createdAt,
    isMember: c.memberIds.includes(userId),
    unreadCount: c.memberIds.includes(userId) ? unread(userId, c.id) : 0,
  });
  const workspaceOf = (id: string | undefined) => {
    const w = state.workspaces.find((x) => x.id === id);
    if (!w) throw new Fail(404, "not_found", "Workspace not found");
    return w;
  };
  const toWorkspace = (w: FakeState["workspaces"][number]): T.Workspace => ({
    id: w.id,
    name: w.name,
    context: w.context,
    logo: w.logo,
  });
  const messageIn = (req: Request) => {
    const m = membership(req.params.workspaceId);
    const msg = state.messages.find((x) => x.id === req.params.messageId);
    const c = msg && state.channels.find((x) => x.id === msg.channelId && x.workspaceId === m.workspaceId);
    if (!msg || !c) throw new Fail(404, "not_found", "Message not found");
    return { m, msg };
  };
  const reactionsOf = (msg: T.Message) => ({ reactions: msg.reactions });

  const handlers: Partial<Record<MethodName, Handler>> = {
    getHealth: () => ({
      status: "ok",
      version: "0.0.0-fake",
      edition: "community",
      database: "ok",
      modules: [],
    }),
    getAuthConfig: () => ({
      socialProviders: { google: false, github: false, apple: false },
      signupOpen: true,
      firstRun: state.users.length === 0,
    }),
    getMe: () => {
      const u = user();
      const workspaces = state.members
        .filter((m) => m.userId === u.id)
        .map((m) => ({ ...toWorkspace(workspaceOf(m.workspaceId)), role: m.role }))
        .map(({ id, name, logo, role }) => ({ id, name, logo, role }));
      return { user: u, workspaces };
    },
    createWorkspace: ({ body }) => {
      const u = user();
      const input = bodyOf(
        s.object({ name: s.string, context: s.optional(s.string), timezone: s.optional(s.string) }),
        body,
      );
      if (!input.name.trim()) throw new Fail(400, "invalid_request", "A workspace needs a name");
      const w = {
        id: newId("workspace_"),
        name: input.name.trim(),
        context: input.context ?? "",
        logo: null,
        settings: { timezone: input.timezone ?? "UTC" },
      };
      state.workspaces.push(w);
      state.members.push(
        person(u, "owner", u.name.split(" ")[0]?.toLowerCase() ?? "me", w.settings.timezone, w.id),
      );
      const general = {
        id: newId("ch_"),
        workspaceId: w.id,
        name: "general",
        topic: "",
        isGeneral: true,
        visibility: "public" as const,
        budgetPerMonthUsd: null,
        createdAt: now().toISOString(),
        memberIds: [u.id],
      };
      state.channels.push(general);
      return { workspace: toWorkspace(w), defaultChannelId: general.id };
    },
    getWorkspace: (req) => toWorkspace(workspaceOf(membership(req.params.workspaceId).workspaceId)),
    updateWorkspace: (req) => {
      const m = membership(req.params.workspaceId);
      if (m.role === "member") throw new Fail(403, "forbidden", "Only admins can change the workspace");
      const input = bodyOf(s.object({ name: s.optional(s.string), context: s.optional(s.string) }), req.body);
      const w = workspaceOf(m.workspaceId);
      if (input.name !== undefined) w.name = input.name;
      if (input.context !== undefined) w.context = input.context;
      return null;
    },
    listMembers: (req) => {
      const m = membership(req.params.workspaceId);
      return {
        members: state.members
          .filter((x) => x.workspaceId === m.workspaceId)
          .map(({ avatarUrl, email, handle, image, name, role, timezone, userId }) => ({
            avatarUrl,
            email,
            handle,
            image,
            name,
            role,
            timezone,
            userId,
          })),
      };
    },
    getPeople: (req) => {
      const m = membership(req.params.workspaceId);
      return {
        people: state.members
          .filter((x) => x.workspaceId === m.workspaceId)
          .map(({ workspaceId: _w, ...p }) => p),
      };
    },
    listChannels: (req) => {
      const m = membership(req.params.workspaceId);
      return {
        channels: state.channels
          .filter(
            (c) =>
              c.workspaceId === m.workspaceId &&
              (c.visibility === "public" || c.memberIds.includes(m.userId)),
          )
          .map((c) => toChannel(c, m.userId)),
      };
    },
    createChannel: (req) => {
      const m = membership(req.params.workspaceId);
      const input = bodyOf(
        s.object({ name: s.string, topic: s.optional(s.string), visibility: s.literal("private", "public") }),
        req.body,
      );
      const name = input.name.trim().toLowerCase().replace(/\s+/g, "-");
      if (!/^[a-z0-9][a-z0-9_-]{0,79}$/.test(name))
        throw new Fail(400, "invalid_request", "Use letters, digits and dashes");
      if (state.channels.some((c) => c.workspaceId === m.workspaceId && c.name === name)) {
        throw new Fail(409, "channel.name_taken", "A channel with that name already exists", { name });
      }
      const c = {
        id: newId("ch_"),
        workspaceId: m.workspaceId,
        name,
        topic: input.topic ?? "",
        isGeneral: false,
        visibility: input.visibility,
        budgetPerMonthUsd: null,
        createdAt: now().toISOString(),
        memberIds: [m.userId],
      };
      state.channels.push(c);
      return toChannel(c, m.userId);
    },
    updateChannel: (req) => {
      const { m, c } = channelIn(req);
      const input = bodyOf(
        s.object({
          name: s.optional(s.string),
          topic: s.optional(s.string),
          budgetPerMonthUsd: s.optional(s.nullable(s.number)),
        }),
        req.body,
      );
      if (input.name !== undefined && c.isGeneral)
        throw new Fail(409, "channel.general", "#general keeps its name");
      if (input.name !== undefined) c.name = input.name;
      if (input.topic !== undefined) c.topic = input.topic;
      if (input.budgetPerMonthUsd !== undefined) c.budgetPerMonthUsd = input.budgetPerMonthUsd;
      return toChannel(c, m.userId);
    },
    joinChannel: (req) => {
      const { m, c } = channelIn(req);
      if (!c.memberIds.includes(m.userId)) c.memberIds.push(m.userId);
      return null;
    },
    markChannelRead: (req) => {
      const { m, c } = channelIn(req);
      const last = state.messages.filter((x) => x.channelId === c.id && x.threadId === null).at(-1);
      if (last) state.reads.set(`${m.userId}:${c.id}`, last.id);
      return null;
    },
    listChannelMembers: (req) => {
      const { c } = channelIn(req);
      return { members: c.memberIds.map((id) => ({ id, type: "person" })) };
    },
    listChannelMessages: (req) => {
      const { c } = channelIn(req);
      const threadId = req.query.get("threadId");
      const before = req.query.get("before");
      const limit = Math.min(Math.max(Number(req.query.get("limit") ?? 50) || 50, 1), 200);
      let list = state.messages.filter((x) => x.channelId === c.id && x.threadId === (threadId || null));
      if (before) {
        const i = list.findIndex((x) => x.id === before);
        if (i >= 0) list = list.slice(0, i);
      }
      return { messages: list.slice(-limit) };
    },
    createChannelMessage: (req) => {
      const { m, c } = channelIn(req);
      if (!c.memberIds.includes(m.userId)) throw new Fail(403, "forbidden", "Join the channel to post");
      const input = bodyOf(
        s.object({
          body: s.string,
          clientId: s.string,
          threadId: s.optional(s.string),
          replyTo: s.optional(s.string),
        }),
        req.body,
      );
      if (!input.body.trim()) throw new Fail(400, "invalid_request", "The message is empty");
      // A retried post (same clientId) is stored once.
      const existing = state.messages.find((x) => x.clientId === input.clientId && x.author.id === m.userId);
      if (existing) return existing;
      const msg = {
        ...emptyMessage({
          id: newId("msg_"),
          channelId: c.id,
          author: { id: m.userId, type: "person" },
          body: input.body,
          createdAt: now().toISOString(),
        }),
        clientId: input.clientId,
        threadId: input.threadId ?? null,
      };
      state.messages.push(msg);
      return msg;
    },
    listMessageReactions: (req) => reactionsOf(messageIn(req).msg),
    createMessageReaction: (req) => {
      const { m, msg } = messageIn(req);
      const { reaction } = bodyOf(s.object({ reaction: s.string }), req.body);
      const r = msg.reactions.find((x) => x.reaction === reaction);
      if (!r) msg.reactions.push({ reaction, count: 1, userIds: [m.userId], agentIds: [] });
      else if (!r.userIds.includes(m.userId)) {
        r.userIds.push(m.userId);
        r.count++;
      }
      return reactionsOf(msg);
    },
    clearMessageReactions: (req) => {
      const { m, msg } = messageIn(req);
      const reaction = req.query.get("reaction");
      const r = msg.reactions.find((x) => x.reaction === reaction);
      if (r?.userIds.includes(m.userId)) {
        r.userIds = r.userIds.filter((id) => id !== m.userId);
        r.count--;
        if (r.count === 0) msg.reactions = msg.reactions.filter((x) => x !== r);
      }
      return reactionsOf(msg);
    },
  };

  async function handle(url: string, init: RequestInit): Promise<Response> {
    const u = new URL(url, "http://fake.vanr");
    const verb = (init.method ?? "GET").toUpperCase();
    const matches = ROUTES.filter((r) => r.ep.verb === verb && r.re.test(u.pathname));
    if (matches.length === 0)
      return errorResponse(404, "route_not_found", `No route for ${verb} ${u.pathname}`);
    const route = matches.find((r) => handlers[r.name as MethodName]) ?? matches[0];
    const handler = route && handlers[route.name as MethodName];
    if (!route || !handler)
      return errorResponse(501, "route_not_found", `The fake server doesn't implement ${route?.name}`);
    const values = route.re.exec(u.pathname)?.slice(1) ?? [];
    const params: Record<string, string> = {};
    route.names.forEach((name, i) => {
      params[name] = decodeURIComponent(values[i] ?? "");
    });
    let body: unknown;
    if (typeof init.body === "string" && init.body) {
      try {
        body = JSON.parse(init.body);
      } catch {
        return errorResponse(400, "invalid_request", "Body is not valid JSON");
      }
    }
    try {
      const out = handler({ params, query: u.searchParams, body });
      return out === null || out === undefined ? new Response(null, { status: 204 }) : json(out);
    } catch (err) {
      if (err instanceof Fail) return errorResponse(err.status, err.code, err.message, err.params);
      return errorResponse(500, "internal", "The fake server failed");
    }
  }

  const general = state.channels.find((c) => c.isGeneral);
  return {
    fetch: async (url, init) => handle(url, init),
    state,
    signIn: (userId) => {
      me = userId;
    },
    sample: {
      workspaceId: state.workspaces[0]?.id ?? "",
      defaultChannelId: general?.id ?? "",
      userId: state.users[0]?.id ?? "",
    },
  };
}
