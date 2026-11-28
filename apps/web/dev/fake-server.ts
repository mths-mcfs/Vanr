// A stand-in for the Vanr server, for developing and testing the web without one. It is a layer
// over the client's own fake (`@vanr/client/testing`), which already answers the account,
// workspace and channel routes with the server's error envelope. This file adds only what that
// fake lacks and the web needs: the sign-in service, the waitlist, invitations, the overview, the
// settings, members' roles and storage, the inbox and its preferences, agents and their runs,
// sessions by cookie, the server's side of the real-time
// socket, and a way to force any state (an error, a held answer, a busy server, an ended session,
// a dropped connection). The Drive and the search live in `fake-files.ts`, bases in `fake-bases.ts`, the wiki in `fake-wiki.ts`, the agents' team, profile, lab and skills in `fake-agents.ts`, their memory and identity in `fake-agent-access.ts`, runners and pairing in `fake-runners.ts`. It is never part of the
// production build.
import { endpoints, type FetchLike, type MethodName, type SocketLike } from "@vanr/client";
import { type FakeServer as ClientFake, createFakeServer, FakeSocket } from "@vanr/client/testing";
import type * as T from "@vanr/contract";
import { can } from "@vanr/contract";
import { z } from "zod";
import { AUTH_ROUTES, type AuthMethod } from "../src/api/auth.ts";
import { FakeAgentAccess } from "./fake-agent-access.ts";
import { FakeAgents } from "./fake-agents.ts";
import { FakeBases } from "./fake-bases.ts";
import { FakeControl } from "./fake-control.ts";
import { FakeFiles } from "./fake-files.ts";
import { FakeRunners } from "./fake-runners.ts";
import { FakeWiki } from "./fake-wiki.ts";

/** Any operation the web calls: one of the client's, or one of the sign-in service's. */
export type FakeMethod = MethodName | AuthMethod;

type Account = { password: string; emailVerified: boolean };
type FakeAgent = T.Agent & { workspaceId: string };
type FakeRun = T.WorkingRun & { workspaceId: string };
type FakeInvitation = {
  token: string;
  workspaceId: string;
  email: string | null;
  role: T.Role;
  invitedBy: string | null;
  expiresAt: Date;
  status: "accepted" | "pending" | "revoked";
  requestedNew: boolean;
};
type FakeNotification = T.AppNotification & { workspaceId: string; userId: string };
type FakeStorage = { config: T.StorageConfig; keys: { accessKeyId: string; secretAccessKey: string } | null };
type FakeMail = { to: string; kind: "reset" | "verify" | "waitlist"; token: string };

/** How a forced answer looks. `envelope` picks the server's error body; the default follows the path. */
export type Forced =
  | {
      kind: "error";
      status: number;
      code: string;
      message?: string;
      /** The Retry-After header, as seconds or as the text to send. */
      retryAfter?: number | string;
      envelope?: boolean;
    }
  /** No answer at all, as when the network is down. */
  | { kind: "offline" };

/** The session cookie of one browser. Two tabs of a browser share one jar. */
export type CookieJar = { session: string | undefined };
export const newJar = (): CookieJar => ({ session: undefined });

type Reply = {
  status: number;
  body: unknown;
  retryAfter?: number | string;
  setSession?: string | null;
  /** Raw bytes instead of JSON: a file's content. */
  bytes?: { data: Uint8Array; type: string };
};

export const EXAMPLE_PASSWORD = "birch-and-tar";
const DAY_MS = 86_400_000;
const SAMPLE_TIME = "2026-11-02T09:00:00.000Z";
const PASSWORD_MIN = 8;
const HOUR_MS = 3_600_000;
const NOTICE_PAGE = 50;
const ROLES = ["member", "admin", "owner"] as const;
const FILTERS = ["action_needed", "all", "fyi", "mentions", "reactions", "unread", "waiting"] as const;

/** What a person who never changed their preferences gets (the server's defaults, in English). */
export const DEFAULT_NOTIFICATION_SETTINGS: T.NotificationSettings = {
  push: true,
  email: true,
  emailDelayMinutes: 15,
  kinds: {},
  channels: {},
  quietHours: { enabled: false, start: "22:00", end: "08:00" },
  dndUntil: null,
  rules: [],
  locale: "en",
};

/** A bucket the fake "reaches": the S3 endpoints whose host is this one pass the connection test. */
export const FAKE_BUCKET_HOST = "bucket.vanr.test";

/** The seeds. `team`: a running installation. `closed`: the same with sign-up by invitation. `empty`: no account yet. */
export type SeedName = "team" | "closed" | "empty";

const reply = (status: number, body: unknown, extra: Partial<Reply> = {}): Reply => ({
  status,
  body,
  ...extra,
});
// The envelope of the routes this file adds; the routes the client's fake has answer with its own.
const envelope = (status: number, code: string, message: string, params?: Record<string, unknown>) =>
  reply(status, { error: params ? { code, message, params } : { code, message } });
/** The sign-in service's error body. */
const authError = (status: number, code: string, message: string) => reply(status, { code, message });
const unauthorized = () => envelope(401, "unauthorized", "Sign in to continue");
const notFound = (what = "Not found") => envelope(404, "not_found", what);
const invalid = () => envelope(400, "invalid_request", "Invalid body");

const email = z.string().trim().toLowerCase().pipe(z.email());
const Bodies = {
  signIn: z.object({ email, password: z.string() }),
  signUp: z.object({ name: z.string().trim().min(1), email, password: z.string() }),
  requestPasswordReset: z.object({ email, redirectTo: z.string() }),
  resetPassword: z.object({ token: z.string(), newPassword: z.string() }),
  verifyEmail: z.object({ token: z.string() }),
  sendVerificationEmail: z.object({ email, callbackURL: z.string() }),
  createWaitlist: z.object({ email, locale: z.string().max(10).optional() }),
  confirmWaitlist: z.object({ token: z.string().min(10).max(200) }),
  invitation: z.object({ invitationId: z.string() }),
  workspace: z.object({ workspaceId: z.string() }),
  settings: z.object({
    name: z.string().trim().min(1).max(80).optional(),
    context: z.string().max(20_000).optional(),
    timezone: z.string().min(1).max(64).optional(),
    approvalReviewer: z.boolean().optional(),
  }),
  me: z.object({
    name: z.string().trim().min(1).max(80).optional(),
    handle: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z0-9][a-z0-9_-]{1,31}$/)
      .optional(),
    timezone: z.string().min(1).max(64).nullable().optional(),
  }),
  member: z.object({ memberId: z.string(), role: z.enum(ROLES).optional() }),
  invite: z.object({ email, role: z.enum(ROLES) }),
  invitationId: z.object({ invitationId: z.string() }),
  s3: z.object({
    endpoint: z.string().trim().min(1).max(500),
    region: z.string().max(64),
    bucket: z.string().trim().min(3).max(63),
    prefix: z.string().max(200).nullable(),
    pathAddressing: z.boolean(),
    accessKeyId: z.string().trim().min(1).max(200).optional(),
    secretAccessKey: z.string().trim().min(1).max(200).optional(),
  }),
  storage: z.object({ kind: z.enum(["builtin", "s3"]) }),
  notification: z.object({ notificationId: z.string() }),
  notices: z.object({
    filter: z.enum(FILTERS).default("all"),
    cursor: z.coerce.number().int().min(0).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(NOTICE_PAGE),
  }),
};
const Frame = z.object({ type: z.string(), channelId: z.string().optional() });

type Route = { name: FakeMethod; verb: string; pattern: RegExp; names: string[] };

function compile(name: FakeMethod, verb: string, path: string): Route {
  const names: string[] = [];
  const base = path.split("?")[0] ?? "";
  const pattern = base.replace(/:([A-Za-z]\w*)/g, (_, param: string) => {
    names.push(param);
    return "([^/]+)";
  });
  return { name, verb, pattern: new RegExp(`^${pattern}$`), names };
}

const isMethod = (name: string): name is MethodName => name in endpoints;
const isAuthMethod = (name: string): name is AuthMethod => name in AUTH_ROUTES;

const ROUTES: Route[] = [
  ...Object.entries(AUTH_ROUTES).flatMap(([name, route]) =>
    isAuthMethod(name) ? [compile(name, route.verb, route.path)] : [],
  ),
  ...Object.entries(endpoints).flatMap(([name, endpoint]) =>
    isMethod(name) ? [compile(name, endpoint.verb, endpoint.path)] : [],
  ),
];

/** Every operation the fake server knows by name. */
export const FAKE_METHODS: readonly FakeMethod[] = ROUTES.map((route) => route.name);

const agent = (id: string, workspaceId: string, name: string, ownerUserId: string): FakeAgent => ({
  id,
  workspaceId,
  name,
  handle: name.toLowerCase(),
  advisor: null,
  appearance: { adornment: "none", color: "cobalt", eyes: "round" },
  archivedAt: null,
  audience: { mode: "everyone", userIds: [] },
  busy: false,
  createdAt: SAMPLE_TIME,
  harness: { environment: null, kind: "model", model: "claude-haiku-5-5" },
  instructions: "",
  model: "claude-haiku-5-5",
  ownerUserId,
  reachable: true,
  role: "assistant",
  testModel: false,
});

const run = (agentId: string, workspaceId: string, what: string): FakeRun => ({
  agentId,
  workspaceId,
  channelId: "ch_general",
  runId: `run_${agentId}`,
  startedAt: SAMPLE_TIME,
  status: "running",
  threadId: null,
  what,
});

/** The socket the server hands a browser: the client's test socket, answered by this server. */
class ServedSocket extends FakeSocket {
  readonly channels = new Set<string>();
  constructor(
    url: string,
    readonly workspaceId: string,
    readonly userId: string,
    private readonly gone: (socket: ServedSocket) => void,
  ) {
    super(url);
  }
  override send(data: string): void {
    super.send(data);
    const frame = Frame.safeParse(this.sent.at(-1));
    if (!frame.success) return;
    const { type, channelId } = frame.data;
    if (type === "ping") this.push({ type: "pong" });
    else if (type === "subscribe" && channelId !== undefined) {
      this.channels.add(channelId);
      this.push({ type: "subscribed", channelId });
    } else if (type === "unsubscribe" && channelId !== undefined) {
      this.channels.delete(channelId);
      this.push({ type: "unsubscribed", channelId });
    }
  }
  /** The browser closed it. */
  override close(code?: number, reason?: string): void {
    super.close(code, reason);
    this.gone(this);
  }
}

export type FakeServerOptions = {
  seed?: SeedName;
  now?: () => Date;
  /** Waits before answering an operation made slow with `slow()`. Tests leave it out and use `hold()`. */
  sleep?: (ms: number) => Promise<void>;
};

export class FakeServer {
  /** The client's fake: users, workspaces, members, channels and messages live in its state. */
  inner: ClientFake;
  signupOpen = true;
  /** Each workspace's direct messages, by workspace id; their channels may be in its channel list too. */
  dms = new Map<string, T.DirectMessage[]>();
  agents: FakeAgent[] = [];
  runs: FakeRun[] = [];
  invitations: FakeInvitation[] = [];
  waitlist: { email: string; token: string; confirmed: boolean }[] = [];
  /** Each workspace's settings, by workspace id. */
  settings = new Map<string, T.WorkspaceSettings>();
  /** Where each workspace keeps its files, by workspace id. */
  storage = new Map<string, FakeStorage>();
  /** Everyone's notices, newest first. */
  notifications: FakeNotification[] = [];
  /** Notification preferences, by `${workspaceId}/${userId}`. */
  notificationSettings = new Map<string, T.NotificationSettings>();
  /** Approvals waiting, as the ids of the people they wait for, by workspace. */
  approvals = new Map<string, string[]>();
  /** Every email the server "sent", newest last. */
  readonly mail: FakeMail[] = [];
  /** Every call that reached an operation, in order, with its path, query and body fields together. */
  readonly calls: { method: FakeMethod; params: Record<string, unknown> }[] = [];
  /** Every socket the browser itself closed, in order, with the code it closed it with. */
  readonly closed: { workspaceId: string; code: number | undefined }[] = [];
  /** How many sockets browsers asked for, accepted or not. */
  socketsAsked = 0;
  readonly files: FakeFiles;
  readonly bases: FakeBases;
  readonly wiki: FakeWiki;
  readonly control: FakeControl;
  readonly agentWork: FakeAgents;
  readonly agentAccess: FakeAgentAccess;
  readonly runnerWork: FakeRunners;
  private readonly fileOperations: ReturnType<FakeFiles["operations"]>;
  private readonly accounts = new Map<string, Account>();
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly sessions = new Map<string, string>();
  private readonly forced = new Map<
    FakeMethod,
    { answer: Forced; times: number; when: ((params: Record<string, unknown>) => boolean) | undefined }
  >();
  private readonly held = new Map<FakeMethod, Promise<void>>();
  private readonly delayed = new Map<FakeMethod, Promise<void>>();
  private readonly slowed = new Map<FakeMethod, number>();
  private readonly sockets = new Set<ServedSocket>();
  private blocking = false;
  private counter = 0;

  constructor(options: FakeServerOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? (() => Promise.resolve());
    this.inner = createFakeServer({ empty: true, actingUser: null, now: this.now });
    const host: ConstructorParameters<typeof FakeFiles>[0] = {
      now: this.now,
      id: (prefix) => this.id(prefix),
      scope: (params, session) => {
        const scope = this.scope(params, session);
        if ("status" in scope) return scope;
        const role = this.memberOf(scope.workspaceId, scope.user.id)?.role ?? "member";
        return { ...scope, role };
      },
      emit: (workspaceId, event) => this.emit(workspaceId, event),
    };
    this.files = new FakeFiles(host);
    this.bases = new FakeBases(host);
    this.wiki = new FakeWiki({
      ...host,
      nameOf: (id) => this.state.users.find((user) => user.id === id)?.name,
    });
    this.control = new FakeControl({
      ...host,
      agentOwner: (agentId) => this.agents.find((candidate) => candidate.id === agentId)?.ownerUserId,
      agentWorkspace: (agentId) => this.agents.find((candidate) => candidate.id === agentId)?.workspaceId,
      isMember: (workspaceId, userId) => this.memberOf(workspaceId, userId) !== undefined,
      channel: (channelId) => this.state.channels.find((candidate) => candidate.id === channelId),
      channelWorkspace: (channelId) =>
        this.state.channels.find((candidate) => candidate.id === channelId)?.workspaceId,
      messages: () => this.state.messages,
      emitTo: (workspaceId, event, channelId) => this.emit(workspaceId, event, channelId),
    });
    // The lab's cases and test runs are one store with the control center's (a proposal's evaluation
    // runs the same cases): the agents' fake reads and writes the control fake's lists.
    this.agentWork = new FakeAgents({
      ...host,
      agents: () => this.agents,
      people: (workspaceId) => this.state.members.filter((member) => member.workspaceId === workspaceId),
      busy: (agentId) => this.runs.some((run) => run.agentId === agentId),
      cases: (agentId) => {
        let cases = this.control.testCases.get(agentId);
        if (cases === undefined) {
          cases = [];
          this.control.testCases.set(agentId, cases);
        }
        return cases;
      },
      evals: () => this.control.evals,
    });
    this.agentAccess = new FakeAgentAccess({
      ...host,
      agents: () => this.agents,
      readsChannel: (userId, channelId) => {
        const channel = this.state.channels.find((candidate) => candidate.id === channelId);
        return (
          channel !== undefined && (channel.visibility === "public" || channel.memberIds.includes(userId))
        );
      },
      channelExists: (channelId) => this.state.channels.some((candidate) => candidate.id === channelId),
    });
    this.runnerWork = new FakeRunners({
      ...host,
      agents: () => this.agents,
      user: (session) => this.userOf(session),
      roles: (userId) =>
        this.state.members.filter((member) => member.userId === userId).map((member) => member.role),
    });
    this.fileOperations = {
      ...this.files.operations(),
      ...this.bases.operations(),
      ...this.wiki.operations(),
      ...this.control.operations(),
      ...this.agentWork.operations(),
      ...this.agentAccess.operations(),
      ...this.runnerWork.operations(),
    };
    // A proposal's evaluation stays the control fake's; the lab's own run (a candidate text) is the agents'.
    const proposalEval = this.control.operations().createAgentEval;
    const labEval = this.fileOperations.createAgentEval;
    if (proposalEval !== undefined && labEval !== undefined) {
      this.fileOperations.createAgentEval = (params, session, raw) =>
        params.proposalId !== undefined ? proposalEval(params, session) : labEval(params, session, raw);
    }
    this.seed(options.seed ?? "team");
  }

  /** People, workspaces and memberships, as the client's fake keeps them. */
  get state() {
    return this.inner.state;
  }

  /* ---------- data ---------- */

  private seed(name: SeedName): void {
    this.signupOpen = name === "team";
    this.files.files = [];
    this.files.uploads = [];
    this.bases.bases = [];
    this.wiki.pages = [];
    this.wiki.reads = [];
    this.wiki.defs = new Map();
    this.control.approvals = [];
    this.control.rules = [];
    this.control.proposals = [];
    this.control.stats = [];
    this.control.questions = [];
    this.control.testCases = new Map();
    this.control.evals = [];
    this.agentWork.clear();
    this.agentAccess.clear();
    this.runnerWork.clear();
    if (name === "empty") return;
    const inDays = (days: number) => new Date(this.now().getTime() + days * DAY_MS);
    const people: [string, string, string][] = [
      ["usr_ana", "Ana Beatriz Souza", "ana@birchwood.example"],
      ["usr_jonas", "Jonas Lind", "jonas@birchwood.example"],
      ["usr_iris", "Íris Valença", "iris@birchwood.example"],
      ["usr_tomas", "Tomás Eriksen", "tomas@birchwood.example"],
      ["usr_noor", "Noor Haddad", "noor@elsewhere.example"],
    ];
    for (const [id, personName, address] of people) {
      this.addUser(id, personName, address, EXAMPLE_PASSWORD, true);
    }
    this.state.workspaces.push(
      {
        id: "workspace_birchwood",
        name: "Birchwood Labs",
        context: "We build tools for small print shops.",
        logo: null,
        settings: { timezone: "Europe/Lisbon" },
      },
      {
        id: "workspace_nightshift",
        name: "Night Shift",
        context: "",
        logo: null,
        settings: { timezone: "UTC" },
      },
    );
    this.enroll("workspace_birchwood", "usr_ana", "owner");
    this.enroll("workspace_birchwood", "usr_jonas", "admin");
    this.enroll("workspace_birchwood", "usr_iris", "member");
    this.enroll("workspace_birchwood", "usr_tomas", "member");
    this.enroll("workspace_nightshift", "usr_jonas", "owner");
    this.enroll("workspace_nightshift", "usr_ana", "member");
    const birchwoodPeople = ["usr_ana", "usr_jonas", "usr_iris", "usr_tomas"];
    for (const [id, channelName, isGeneral] of [
      ["ch_general", "general", true],
      ["ch_print", "print-queue", false],
    ] as const) {
      this.state.channels.push({
        id,
        workspaceId: "workspace_birchwood",
        name: channelName,
        topic: "",
        isGeneral,
        visibility: "public",
        budgetPerMonthUsd: null,
        createdAt: SAMPLE_TIME,
        memberIds: [...birchwoodPeople],
      });
    }
    this.notifications = this.seedNotifications();
    this.approvals.set("workspace_birchwood", ["usr_ana", "usr_ana"]);
    this.state.channels.push({
      id: "ch_design",
      workspaceId: "workspace_birchwood",
      name: "design",
      topic: "",
      isGeneral: false,
      visibility: "public",
      budgetPerMonthUsd: null,
      createdAt: SAMPLE_TIME,
      memberIds: ["usr_ana", "usr_jonas", "usr_iris", "usr_tomas"],
    });
    this.files.seed();
    this.bases.seed();
    this.wiki.seed();
    this.agentWork.seed();
    this.agentAccess.seed();
    this.runnerWork.seed();
    this.agents = [
      agent("agt_scout", "workspace_birchwood", "Scout", "usr_ana"),
      agent("agt_ledger", "workspace_birchwood", "Ledger", "usr_ana"),
      agent("agt_tally", "workspace_birchwood", "Tally", "usr_jonas"),
      agent("agt_fjell", "workspace_nightshift", "Fjell", "usr_jonas"),
    ];
    this.runs = [
      run("agt_scout", "workspace_birchwood", "Drafting the release notes"),
      run("agt_ledger", "workspace_birchwood", "Reconciling the October invoices"),
    ];
    this.control.seed();
    const invitation = (
      token: string,
      address: string | null,
      invitedBy: string,
      days: number,
      status: FakeInvitation["status"] = "pending",
    ): FakeInvitation => ({
      token,
      workspaceId: "workspace_birchwood",
      email: address,
      role: "member",
      invitedBy,
      expiresAt: inDays(days),
      status,
      requestedNew: false,
    });
    this.invitations = [
      invitation("inv-mel-pending", "mel@birchwood.example", "usr_ana", 7),
      invitation("inv-open-link", null, "usr_jonas", 3),
      invitation("inv-expired", "late@birchwood.example", "usr_ana", -1),
      invitation("inv-used", "iris@birchwood.example", "usr_ana", 5, "accepted"),
    ];
    this.waitlist = [
      { email: "patient@elsewhere.example", token: "waitlist-token-patient", confirmed: false },
    ];
  }

  /** Ana's inbox in Birchwood: two open requests, a mention and a DM, then what is only worth knowing. */
  private seedNotifications(): FakeNotification[] {
    const ago = (hours: number) => new Date(this.now().getTime() - hours * HOUR_MS).toISOString();
    const notice = (
      id: string,
      fields: Partial<T.AppNotification> &
        Pick<T.AppNotification, "kind" | "reason" | "tab" | "actors" | "latest" | "source">,
      hoursAgo: number,
    ): FakeNotification => ({
      id,
      workspaceId: "workspace_birchwood",
      userId: "usr_ana",
      count: 1,
      createdAt: ago(hoursAgo),
      updatedAt: ago(hoursAgo),
      critical: false,
      doneAt: null,
      mutedUntil: null,
      readAt: null,
      remindAt: null,
      ruleId: null,
      savedAt: null,
      waiting: false,
      workState: null,
      ...fields,
    });
    const agentActor = (id: string): T.ActorRef => ({ type: "agent", id });
    const person = (id: string): T.ActorRef => ({ type: "person", id });
    return [
      notice(
        "ntf_approval",
        {
          kind: "approval",
          reason: "approval_requested",
          tab: "action_needed",
          waiting: true,
          critical: true,
          actors: [agentActor("agt_ledger")],
          latest: { title: "Send the October invoices" },
          source: { approvalId: "apr_invoices" },
        },
        1,
      ),
      notice(
        "ntf_question",
        {
          kind: "question_for_you",
          reason: "question_raised",
          tab: "action_needed",
          waiting: true,
          actors: [agentActor("agt_scout")],
          latest: { text: "Should the release notes mention the new paper sizes?" },
          source: { channelId: "ch_general", label: "#general" },
        },
        2,
      ),
      notice(
        "ntf_mention",
        {
          kind: "mention",
          reason: "mentioned",
          tab: "action_needed",
          actors: [person("usr_jonas")],
          latest: { text: "@ana can you look at the stuck job in the queue?" },
          source: { channelId: "ch_print", messageId: "msg_stuck", label: "#print-queue" },
        },
        3,
      ),
      notice(
        "ntf_dm",
        {
          kind: "dm",
          reason: "dm",
          tab: "action_needed",
          actors: [person("usr_iris")],
          latest: { text: "Lunch on Friday?" },
          source: { channelId: "dm_iris", dmId: "dm_iris" },
        },
        4,
      ),
      notice(
        "ntf_reaction",
        {
          kind: "reaction",
          reason: "reacted",
          tab: "fyi",
          actors: [person("usr_tomas")],
          latest: { emojis: ["🎉"], quote: "The new cutter is in." },
          source: { channelId: "ch_general", messageId: "msg_cutter", label: "#general" },
        },
        26,
      ),
      notice(
        "ntf_reaction_old",
        {
          kind: "reaction",
          reason: "reacted",
          tab: "fyi",
          actors: [person("usr_jonas"), person("usr_iris")],
          count: 2,
          latest: { emojis: ["👍"], quote: "Shipping labels are printed." },
          source: { channelId: "ch_print", messageId: "msg_labels", label: "#print-queue" },
        },
        72,
      ),
      notice(
        "ntf_finished",
        {
          kind: "assignment_finished",
          reason: "assignment_finished",
          tab: "fyi",
          workState: "done",
          actors: [agentActor("agt_scout")],
          latest: { title: "Draft the release notes" },
          source: { assignmentId: "asg_notes" },
        },
        96,
      ),
      notice(
        "ntf_routine",
        {
          kind: "routine_report",
          reason: "routine_report",
          tab: "fyi",
          actors: [agentActor("agt_tally")],
          latest: { title: "Weekly paper stock" },
          source: { routineId: "rtn_stock" },
        },
        240,
      ),
    ];
  }

  private addUser(
    id: string,
    name: string,
    address: string,
    password: string,
    emailVerified: boolean,
  ): T.User {
    const user: T.User = { id, name, email: address, image: null };
    this.state.users.push(user);
    this.accounts.set(id, { password, emailVerified });
    return user;
  }

  /** Makes a person a member of a workspace. */
  enroll(workspaceId: string, userId: string, role: T.Role): void {
    const user = this.state.users.find((candidate) => candidate.id === userId);
    if (user === undefined) throw new Error(`fake server: no user ${userId}`);
    this.state.members.push({
      workspaceId,
      userId,
      name: user.name,
      email: user.email,
      handle: user.email.split("@")[0] ?? userId,
      image: null,
      avatarUrl: null,
      role,
      timezone: "UTC",
      online: false,
      lastOnlineAt: null,
      memberSince: SAMPLE_TIME,
    });
  }

  /** Whether the account with this email has confirmed it. */
  emailVerified(address: string): boolean {
    const user = this.state.users.find((candidate) => candidate.email === address);
    return (user && this.accounts.get(user.id)?.emailVerified) === true;
  }

  /* ---------- forcing states ---------- */

  /** Starts over from a seed: data, sessions, forced answers and sockets. */
  reset(seed: SeedName): void {
    this.dropConnections();
    this.inner = createFakeServer({ empty: true, actingUser: null, now: this.now });
    this.agents = [];
    this.runs = [];
    this.invitations = [];
    this.waitlist = [];
    this.settings.clear();
    this.storage.clear();
    this.notifications = [];
    this.dms.clear();
    this.notificationSettings.clear();
    this.approvals.clear();
    this.accounts.clear();
    this.sessions.clear();
    this.forced.clear();
    this.held.clear();
    this.delayed.clear();
    this.slowed.clear();
    this.mail.length = 0;
    this.calls.length = 0;
    this.closed.length = 0;
    this.socketsAsked = 0;
    this.blocking = false;
    this.seed(seed);
  }

  /** The next `times` calls of an operation get this answer instead of the real one. */
  force(
    method: FakeMethod,
    forced: Forced,
    times = 1,
    /** Only the calls whose path, query and body fields match get the answer. */
    when?: (params: Record<string, unknown>) => boolean,
  ): void {
    this.forced.set(method, { answer: forced, times, when });
  }

  /** Lifts a forced answer that has calls left. */
  unforce(method: FakeMethod): void {
    this.forced.delete(method);
  }

  /** Calls of an operation wait until `release()`: the "sending" state, without a clock. */
  hold(method: FakeMethod): { release: () => void } {
    let release = () => {};
    this.held.set(
      method,
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    return {
      release: () => {
        this.held.delete(method);
        release();
      },
    };
  }

  /**
   * Calls of an operation are answered at once, but the answer only arrives on `release()`: an
   * answer that was right when the server gave it and reaches the browser late.
   */
  delay(method: FakeMethod): { release: () => void } {
    let release = () => {};
    this.delayed.set(
      method,
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    return {
      release: () => {
        this.delayed.delete(method);
        release();
      },
    };
  }

  /** Calls of an operation take `ms` to answer (with the `sleep` given to the constructor). */
  slow(method: FakeMethod, ms: number): void {
    if (ms <= 0) this.slowed.delete(method);
    else this.slowed.set(method, ms);
  }

  /** Every session ends: the next call answers 401 and open sockets close with 4401. */
  expireSessions(): void {
    this.sessions.clear();
    for (const socket of [...this.sockets]) this.dropSocket(socket, 4401);
  }

  /** Signs a seeded person in and returns the session cookie value. */
  sessionFor(userId: string): string {
    const token = this.id("session");
    this.sessions.set(token, userId);
    return token;
  }

  userOf(session: string | undefined): T.User | undefined {
    const userId = session === undefined ? undefined : this.sessions.get(session);
    return this.state.users.find((user) => user.id === userId);
  }

  /* ---------- real time ---------- */

  /** The socket factory of a browser: what the client's real-time connection opens its socket with. */
  socketFactory(jar: CookieJar): (url: string) => SocketLike {
    return (url) => {
      this.socketsAsked += 1;
      const workspaceId = new URL(url, "ws://vanr.test").searchParams.get("workspaceId") ?? "";
      const user = this.userOf(jar.session);
      const socket = new ServedSocket(url, workspaceId, user?.id ?? "", (gone) => {
        if (this.sockets.delete(gone)) this.closed.push({ workspaceId, code: gone.closedWith?.code });
      });
      if (this.blocking || user === undefined || this.memberOf(workspaceId, user.id) === undefined) {
        // A blocked or rejected upgrade reaches the browser as an abnormal close.
        queueMicrotask(() => socket.drop(user === undefined && !this.blocking ? 4401 : 1006));
        return socket;
      }
      this.sockets.add(socket);
      queueMicrotask(() => {
        if (this.sockets.has(socket)) socket.open({ userId: user.id, workspaceId });
      });
      return socket;
    };
  }

  private dropSocket(socket: ServedSocket, code: number): void {
    if (this.sockets.delete(socket)) socket.drop(code);
  }

  /** Sends an event to everyone in a workspace, or to the followers of one channel. */
  emit(workspaceId: string, event: { type: string } & Record<string, unknown>, channelId?: string): void {
    for (const socket of this.sockets) {
      if (socket.workspaceId !== workspaceId) continue;
      if (channelId === undefined) socket.push({ type: "event", scope: "workspace", event });
      else if (socket.channels.has(channelId)) socket.push({ type: "event", channelId, event });
    }
  }

  /** Closes every socket the way a lost network does. */
  dropConnections(): void {
    for (const socket of [...this.sockets]) this.dropSocket(socket, 1006);
  }

  /** While true, every new socket fails to open: the connection stays lost. */
  blockConnections(block: boolean): void {
    this.blocking = block;
  }

  /** The sockets that are open: the channels each follows and every frame its browser sent. */
  openSockets(): {
    workspaceId: string;
    userId: string;
    channels: string[];
    sent: Record<string, unknown>[];
  }[] {
    return [...this.sockets].map((socket) => ({
      workspaceId: socket.workspaceId,
      userId: socket.userId,
      channels: [...socket.channels].sort(),
      sent: socket.sent,
    }));
  }

  /** An agent starts or stops a run. With `announce`, the workspace hears about it, as it would. */
  setAgentBusy(agentId: string, busy: boolean, announce = true): void {
    const found = this.agents.find((candidate) => candidate.id === agentId);
    if (found === undefined) throw new Error(`fake server: no agent ${agentId}`);
    this.runs = this.runs.filter((candidate) => candidate.agentId !== agentId);
    if (busy) this.runs.push(run(agentId, found.workspaceId, "Working"));
    if (announce) {
      this.emit(found.workspaceId, {
        type: "run.status_changed",
        agentId,
        status: busy ? "running" : "done",
      });
    }
  }

  /* ---------- requests ---------- */

  /** The fetch of a browser: every call the web makes goes through it, with the browser's cookie. */
  fetch(jar: CookieJar): FetchLike {
    return (url, init) => {
      const signal = init.signal ?? undefined;
      const aborted = () => new DOMException("The operation was aborted", "AbortError");
      if (signal?.aborted) return Promise.reject(aborted());
      const answer = this.respond(url, init, jar);
      if (signal === undefined) return answer;
      // The browser gives up the moment it is told to; the server carries on with what it received.
      answer.catch(() => {});
      return new Promise<Response>((resolve, reject) => {
        signal.addEventListener("abort", () => reject(aborted()), { once: true });
        answer.then(resolve, reject);
      });
    };
  }

  private async respond(url: string, init: RequestInit, jar: CookieJar): Promise<Response> {
    const target = new URL(url, "http://vanr.test");
    const verb = (init.method ?? "GET").toUpperCase();
    // A fixed segment wins over a parameter, as on the server: `/files/trash` is not file "trash".
    const route = ROUTES.filter(
      (candidate) => candidate.verb === verb && candidate.pattern.test(target.pathname),
    ).sort((a, b) => a.names.length - b.names.length)[0];
    // An address outside the table gets the client fake's own "no such route".
    if (route === undefined) return this.inner.fetch(url, init);
    const params: Record<string, unknown> = Object.fromEntries(target.searchParams);
    if (typeof init.body === "string" && init.body !== "") {
      let body: unknown;
      try {
        body = JSON.parse(init.body);
      } catch {
        body = undefined;
      }
      if (typeof body === "object" && body !== null) Object.assign(params, body);
    }
    const match = route.pattern.exec(target.pathname);
    route.names.forEach((name, index) => {
      params[name] = decodeURIComponent(match?.[index + 1] ?? "");
    });
    this.calls.push({ method: route.name, params });

    await this.held.get(route.name);
    const slow = this.slowed.get(route.name);
    if (slow !== undefined) await this.sleep(slow);

    const forced = this.forced.get(route.name);
    if (forced !== undefined && (forced.when === undefined || forced.when(params))) {
      if (forced.times <= 1) this.forced.delete(route.name);
      else forced.times -= 1;
      // What fetch does when the network is down.
      if (forced.answer.kind === "offline") throw new TypeError("Failed to fetch");
      const { status, code, message = "Forced by the fake server", retryAfter } = forced.answer;
      const asEnvelope = forced.answer.envelope ?? !isAuthMethod(route.name);
      const answer = asEnvelope
        ? envelope(status, code, message)
        : authError(status, code.toUpperCase(), message);
      return this.send(retryAfter === undefined ? answer : { ...answer, retryAfter }, jar);
    }

    const answer = await this.answer(route, params, url, init, jar);
    await this.delayed.get(route.name);
    return answer;
  }

  private async answer(
    route: Route,
    params: Record<string, unknown>,
    url: string,
    init: RequestInit,
    jar: CookieJar,
  ): Promise<Response> {
    const own = this.operations[route.name];
    if (own !== undefined) return this.send(own(params, jar.session), jar);
    const drive = this.fileOperations[route.name];
    if (drive !== undefined) return this.send(drive(params, jar.session, init.body), jar);

    // Everything else is the client fake's, acting as whoever this browser is signed in as.
    this.inner.signIn(this.userOf(jar.session)?.id ?? null);
    const answer = await this.inner.fetch(url, init);
    if (route.name !== "getAuthConfig" || !answer.ok) return answer;
    // The client's fake always says sign-up is open; this one can be closed.
    const config: unknown = await answer.json();
    return Response.json({
      ...(typeof config === "object" ? config : {}),
      signupOpen: this.signupOpen || this.state.users.length === 0,
    });
  }

  private send(answer: Reply, jar: CookieJar): Response {
    if (answer.setSession !== undefined) jar.session = answer.setSession ?? undefined;
    if (answer.bytes !== undefined) {
      return new Response(new Blob([new Uint8Array(answer.bytes.data)]), {
        status: answer.status,
        headers: { "content-type": answer.bytes.type },
      });
    }
    const headers = new Headers({ "content-type": "application/json" });
    if (answer.retryAfter !== undefined) headers.set("retry-after", String(answer.retryAfter));
    const empty = answer.status === 204 || answer.body === null;
    return new Response(empty ? null : JSON.stringify(answer.body), { status: answer.status, headers });
  }

  private id(prefix: string): string {
    this.counter += 1;
    return `${prefix}_${this.counter.toString(36).padStart(4, "0")}`;
  }

  private memberOf(workspaceId: string, userId: string) {
    return this.state.members.find(
      (member) => member.workspaceId === workspaceId && member.userId === userId,
    );
  }

  private invitationState(invitation: FakeInvitation): "accepted" | "expired" | "pending" | "revoked" {
    if (invitation.status !== "pending") return invitation.status;
    return invitation.expiresAt.getTime() <= this.now().getTime() ? "expired" : "pending";
  }

  private mayCreateAccount(address: string): boolean {
    if (this.signupOpen || this.state.users.length === 0) return true;
    return this.invitations.some(
      (invitation) => invitation.email === address && this.invitationState(invitation) === "pending",
    );
  }

  /** A member-only operation that also needs a permission: the caller's role joins the scope. */
  private allowed(
    params: Record<string, unknown>,
    session: string | undefined,
    permission: Parameters<typeof can>[1],
  ): { workspaceId: string; user: T.User; role: T.Role } | Reply {
    const scope = this.scope(params, session);
    if ("status" in scope) return scope;
    const role = this.memberOf(scope.workspaceId, scope.user.id)?.role ?? "member";
    if (!can(role, permission)) return envelope(403, "forbidden", "Forbidden");
    return { ...scope, role };
  }

  /** The notices a person sees now: not done, not snoozed, newest first. */
  private inbox(workspaceId: string, userId: string): FakeNotification[] {
    const now = this.now().getTime();
    return this.notifications
      .filter(
        (notice) =>
          notice.workspaceId === workspaceId &&
          notice.userId === userId &&
          notice.doneAt === null &&
          (notice.mutedUntil === null || Date.parse(notice.mutedUntil) <= now),
      )
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }

  private inFilter(notice: FakeNotification, filter: T.NotificationFilter): boolean {
    switch (filter) {
      case "all":
        return true;
      case "action_needed":
        return notice.tab === "action_needed";
      case "fyi":
        return notice.tab === "fyi";
      case "mentions":
        return notice.kind === "mention";
      case "reactions":
        return notice.kind === "reaction";
      case "unread":
        return notice.readAt === null;
      case "waiting":
        return notice.waiting;
    }
  }

  /** The counts the server sends with every page (see NotificationCounts in the contract). */
  noticeCounts(workspaceId: string, userId: string): T.NotificationCounts {
    const seen = this.inbox(workspaceId, userId);
    const count = (keep: (notice: FakeNotification) => boolean) => seen.filter(keep).length;
    const pending = (notice: FakeNotification) =>
      notice.tab === "action_needed" && (notice.waiting || notice.readAt === null);
    return {
      actionNeeded: count(pending),
      all: seen.length,
      badge: count((notice) => pending(notice) && notice.kind !== "approval"),
      fyi: count((notice) => notice.tab === "fyi" && notice.readAt === null),
      // As the server counts them: every mention and reaction in the inbox, read or not.
      mentions: count((notice) => notice.kind === "mention"),
      reactions: count((notice) => notice.kind === "reaction"),
      unread: count((notice) => notice.readAt === null),
      waiting: count((notice) => notice.waiting),
    };
  }

  /** One of the caller's own notices, changed by `apply`; `apply` may answer with an error instead. */
  private changeNotice(
    params: Record<string, unknown>,
    session: string | undefined,
    apply: (notice: FakeNotification, body: Record<string, unknown>) => Reply | undefined,
  ): Reply {
    const scope = this.scope(params, session);
    if ("status" in scope) return scope;
    const body = Bodies.notification.safeParse(params);
    if (!body.success) return invalid();
    const notice = this.notifications.find(
      (candidate) =>
        candidate.id === body.data.notificationId &&
        candidate.workspaceId === scope.workspaceId &&
        candidate.userId === scope.user.id,
    );
    if (notice === undefined) return notFound("Notification not found");
    const refused = apply(notice, params);
    if (refused !== undefined) return refused;
    notice.updatedAt = this.now().toISOString();
    const { workspaceId: _w, userId: _u, ...rest } = notice;
    return reply(200, rest);
  }

  /** A workspace's settings; one created after the seed starts from its name, context and time zone. */
  private settingsOf(workspaceId: string): T.WorkspaceSettings | undefined {
    const saved = this.settings.get(workspaceId);
    if (saved !== undefined) return saved;
    const workspace = this.state.workspaces.find((candidate) => candidate.id === workspaceId);
    if (workspace === undefined) return undefined;
    const fresh: T.WorkspaceSettings = {
      name: workspace.name,
      context: workspace.context,
      timezone: workspace.settings.timezone,
      agentBudgetDefaultUsd: 20,
      approvalReviewer: false,
      primaryCredentialId: null,
    };
    this.settings.set(workspaceId, fresh);
    return fresh;
  }

  private preferencesOf(workspaceId: string, userId: string): T.NotificationSettings {
    return this.notificationSettings.get(`${workspaceId}/${userId}`) ?? DEFAULT_NOTIFICATION_SETTINGS;
  }

  private storageOf(workspaceId: string): FakeStorage {
    let stored = this.storage.get(workspaceId);
    if (stored === undefined) {
      stored = { config: { kind: "builtin", s3: null, transfer: null }, keys: null };
      this.storage.set(workspaceId, stored);
    }
    return stored;
  }

  /** The keys a bucket form gives: both new ones, or the saved pair when both are left out. */
  private storageKeys(
    workspaceId: string,
    input: { accessKeyId?: string | undefined; secretAccessKey?: string | undefined },
  ): NonNullable<FakeStorage["keys"]> | undefined {
    if (input.accessKeyId !== undefined && input.secretAccessKey !== undefined) {
      return { accessKeyId: input.accessKeyId, secretAccessKey: input.secretAccessKey };
    }
    return this.storageOf(workspaceId).keys ?? undefined;
  }

  /** The connection test: every step passes on FAKE_BUCKET_HOST; elsewhere the first write is refused. */
  private probeBucket(endpoint: string): T.StorageTestResult {
    let host = "";
    try {
      host = new URL(endpoint).host;
    } catch {
      host = "";
    }
    const steps = ["write", "read", "list", "delete"] as const;
    if (host === FAKE_BUCKET_HOST) return { ok: true, steps: steps.map((step) => ({ step, ok: true })) };
    return {
      ok: false,
      steps: [{ step: "write", ok: false, error: "AccessDenied: the bucket refused the write" }],
    };
  }

  /** A member-only operation: the workspace id and the caller, or the error answer. */
  private scope(
    params: Record<string, unknown>,
    session: string | undefined,
  ): { workspaceId: string; user: T.User } | Reply {
    const user = this.userOf(session);
    if (user === undefined) return unauthorized();
    const parsed = Bodies.workspace.safeParse(params);
    if (!parsed.success) return invalid();
    if (this.memberOf(parsed.data.workspaceId, user.id) === undefined) {
      return notFound("Workspace not found");
    }
    return { workspaceId: parsed.data.workspaceId, user };
  }

  /** The operations the client's fake does not have. */
  private readonly operations: Partial<
    Record<FakeMethod, (params: Record<string, unknown>, session: string | undefined) => Reply>
  > = {
    signIn: (params) => {
      const body = Bodies.signIn.safeParse(params);
      if (!body.success) return authError(400, "INVALID_EMAIL", "Invalid email");
      const user = this.state.users.find((candidate) => candidate.email === body.data.email);
      if (user === undefined || this.accounts.get(user.id)?.password !== body.data.password) {
        return authError(401, "INVALID_EMAIL_OR_PASSWORD", "Invalid email or password");
      }
      return reply(200, { redirect: false, user: { id: user.id } }, { setSession: this.sessionFor(user.id) });
    },
    signUp: (params) => {
      const body = Bodies.signUp.safeParse(params);
      if (!body.success) return authError(400, "INVALID_EMAIL", "Invalid email");
      if (body.data.password.length < PASSWORD_MIN) {
        return authError(400, "PASSWORD_TOO_SHORT", "Password too short");
      }
      if (this.state.users.some((user) => user.email === body.data.email)) {
        return authError(422, "USER_ALREADY_EXISTS", "User already exists");
      }
      if (!this.mayCreateAccount(body.data.email)) {
        return authError(403, "SIGNUP_CLOSED", "Sign-up is closed. Ask a workspace admin for an invite.");
      }
      const user = this.addUser(this.id("usr"), body.data.name, body.data.email, body.data.password, false);
      this.mail.push({ to: user.email, kind: "verify", token: `verify-${user.id}` });
      return reply(200, { user: { id: user.id } }, { setSession: this.sessionFor(user.id) });
    },
    signOut: (_params, session) => {
      if (session !== undefined) this.sessions.delete(session);
      return reply(200, { success: true }, { setSession: null });
    },
    requestPasswordReset: (params) => {
      const body = Bodies.requestPasswordReset.safeParse(params);
      if (!body.success) return authError(400, "INVALID_EMAIL", "Invalid email");
      const user = this.state.users.find((candidate) => candidate.email === body.data.email);
      // The answer is the same whether or not the account exists.
      if (user !== undefined) this.mail.push({ to: user.email, kind: "reset", token: `reset-${user.id}` });
      return reply(200, { status: true });
    },
    resetPassword: (params) => {
      const body = Bodies.resetPassword.safeParse(params);
      const sent = body.success
        ? this.mail.find((mail) => mail.kind === "reset" && mail.token === body.data.token)
        : undefined;
      const user = this.state.users.find((candidate) => candidate.email === sent?.to);
      const account = user && this.accounts.get(user.id);
      if (!body.success || sent === undefined || account === undefined) {
        return authError(400, "INVALID_TOKEN", "Invalid token");
      }
      if (body.data.newPassword.length < PASSWORD_MIN) {
        return authError(400, "PASSWORD_TOO_SHORT", "Password too short");
      }
      account.password = body.data.newPassword;
      this.mail.splice(this.mail.indexOf(sent), 1);
      return reply(200, { status: true });
    },
    verifyEmail: (params) => {
      const body = Bodies.verifyEmail.safeParse(params);
      const sent = body.success
        ? this.mail.find((mail) => mail.kind === "verify" && mail.token === body.data.token)
        : undefined;
      const user = this.state.users.find((candidate) => candidate.email === sent?.to);
      const account = user && this.accounts.get(user.id);
      // The real service answers 401 here; it is not the end of a session.
      if (sent === undefined || account === undefined)
        return authError(401, "INVALID_TOKEN", "Invalid token");
      account.emailVerified = true;
      this.mail.splice(this.mail.indexOf(sent), 1);
      return reply(200, { status: true });
    },
    sendVerificationEmail: (params) => {
      const body = Bodies.sendVerificationEmail.safeParse(params);
      if (!body.success) return authError(400, "INVALID_EMAIL", "Invalid email");
      const user = this.state.users.find((candidate) => candidate.email === body.data.email);
      if (user !== undefined) {
        this.mail.push({ to: user.email, kind: "verify", token: `verify-${this.id("mail")}` });
      }
      return reply(200, { status: true });
    },

    createWaitlist: (params) => {
      const body = Bodies.createWaitlist.safeParse(params);
      if (!body.success) return invalid();
      let entry = this.waitlist.find((candidate) => candidate.email === body.data.email);
      if (entry === undefined) {
        entry = { email: body.data.email, token: `waitlist-token-${this.id("wl")}`, confirmed: false };
        this.waitlist.push(entry);
      }
      if (!entry.confirmed) this.mail.push({ to: entry.email, kind: "waitlist", token: entry.token });
      return reply(200, { ok: true });
    },
    confirmWaitlist: (params) => {
      const body = Bodies.confirmWaitlist.safeParse(params);
      if (!body.success) return invalid();
      const entry = this.waitlist.find((candidate) => candidate.token === body.data.token);
      if (entry === undefined) return notFound("Confirmation link not found");
      entry.confirmed = true;
      return reply(200, { ok: true });
    },

    getDms: (params, session) => {
      const scope = this.scope(params, session);
      if ("status" in scope) return scope;
      return reply(200, { dms: this.dms.get(scope.workspaceId) ?? [] });
    },
    getInvitation: (params, session) => {
      const body = Bodies.invitation.safeParse(params);
      if (!body.success) return invalid();
      const invitation = this.invitations.find((candidate) => candidate.token === body.data.invitationId);
      const state = invitation === undefined ? undefined : this.invitationState(invitation);
      const user = this.userOf(session);
      const member =
        invitation !== undefined &&
        user !== undefined &&
        this.memberOf(invitation.workspaceId, user.id) !== undefined;
      if (invitation === undefined || (state !== "pending" && !member)) {
        if (state === "accepted") return envelope(410, "invitation.used", "Invitation already used");
        return notFound("Invitation not found or expired");
      }
      const workspace = this.state.workspaces.find((candidate) => candidate.id === invitation.workspaceId);
      const inviter = this.state.users.find((candidate) => candidate.id === invitation.invitedBy);
      const preview: T.InvitationPreview = {
        workspaceId: invitation.workspaceId,
        workspaceName: workspace?.name ?? "",
        email: invitation.email,
        role: invitation.role,
        invitedByName: inviter?.name ?? null,
        expiresAt: invitation.expiresAt.toISOString(),
      };
      return reply(200, preview);
    },
    acceptInvitation: (params, session) => {
      const user = this.userOf(session);
      if (user === undefined) return unauthorized();
      const body = Bodies.invitation.safeParse(params);
      if (!body.success) return invalid();
      const invitation = this.invitations.find((candidate) => candidate.token === body.data.invitationId);
      if (invitation === undefined) return notFound("Invitation not found or expired");
      const joined = reply(200, { workspaceId: invitation.workspaceId });
      if (this.memberOf(invitation.workspaceId, user.id) !== undefined) return joined;
      if (this.invitationState(invitation) !== "pending") return notFound("Invitation not found or expired");
      if (invitation.email !== null && invitation.email !== user.email) {
        return envelope(403, "invitation.wrong_email", "This invitation is for another email", {
          email: invitation.email,
        });
      }
      if (invitation.email !== null) invitation.status = "accepted";
      this.enroll(invitation.workspaceId, user.id, invitation.role);
      return joined;
    },
    requestInvitationNew: (params) => {
      const body = Bodies.invitation.safeParse(params);
      if (!body.success) return invalid();
      const invitation = this.invitations.find((candidate) => candidate.token === body.data.invitationId);
      if (invitation === undefined || invitation.status === "accepted") {
        return notFound("Invitation not found or expired");
      }
      invitation.requestedNew = true;
      return reply(204, null);
    },

    getOverview: (params, session) => {
      const scope = this.scope(params, session);
      if ("status" in scope) return scope;
      const here = <Row extends { workspaceId: string }>(rows: Row[]) =>
        rows.filter((row) => row.workspaceId === scope.workspaceId);
      const overview: T.WorkspaceOverview = {
        people: here(this.state.members).length,
        agents: here(this.agents).length,
        myApprovalQueue: (this.approvals.get(scope.workspaceId) ?? []).filter((id) => id === scope.user.id)
          .length,
        budgetSpentPct: scope.workspaceId === "workspace_birchwood" ? 38 : 0,
      };
      return reply(200, overview);
    },
    listNotificationCounts: (params, session) => {
      const scope = this.scope(params, session);
      if ("status" in scope) return scope;
      return reply(200, this.noticeCounts(scope.workspaceId, scope.user.id));
    },
    listNotifications: (params, session) => {
      const scope = this.scope(params, session);
      if ("status" in scope) return scope;
      const query = Bodies.notices.safeParse(params);
      if (!query.success) return invalid();
      const { filter, cursor = 0, limit } = query.data;
      const all = this.inbox(scope.workspaceId, scope.user.id).filter((notice) =>
        this.inFilter(notice, filter),
      );
      const items = all.slice(cursor, cursor + limit).map(({ workspaceId: _w, userId: _u, ...rest }) => rest);
      const next = cursor + limit < all.length ? String(cursor + limit) : null;
      return reply(200, {
        items,
        nextCursor: next,
        counts: this.noticeCounts(scope.workspaceId, scope.user.id),
      });
    },
    markNotificationRead: (params, session) =>
      this.changeNotice(params, session, (notice, body) => {
        notice.readAt = body.read === false ? null : this.now().toISOString();
        return undefined;
      }),
    completeNotification: (params, session) =>
      this.changeNotice(params, session, (notice, body) => {
        notice.doneAt = body.done === false ? null : this.now().toISOString();
        return undefined;
      }),
    saveNotification: (params, session) =>
      this.changeNotice(params, session, (notice, body) => {
        notice.savedAt = body.saved === false ? null : this.now().toISOString();
        return undefined;
      }),
    snoozeNotification: (params, session) =>
      this.changeNotice(params, session, (notice, body) => {
        const until = typeof body.until === "string" ? body.until : null;
        if (until !== null && !Number.isFinite(Date.parse(until))) return invalid();
        if (until !== null && Date.parse(until) <= this.now().getTime()) {
          return envelope(400, "notification.snooze_past", "Snooze must end in the future");
        }
        notice.mutedUntil = until;
        return undefined;
      }),
    remindNotification: (params, session) =>
      this.changeNotice(params, session, (notice, body) => {
        const at = typeof body.at === "string" ? body.at : null;
        if (at !== null && !Number.isFinite(Date.parse(at))) return invalid();
        if (at !== null && Date.parse(at) <= this.now().getTime()) {
          return envelope(400, "notification.remind_past", "Reminder must be in the future");
        }
        notice.remindAt = at;
        return undefined;
      }),
    markNotificationAllRead: (params, session) => {
      const scope = this.scope(params, session);
      if ("status" in scope) return scope;
      const filter = z.enum(FILTERS).default("all").safeParse(params.filter);
      if (!filter.success) return invalid();
      const read = this.inbox(scope.workspaceId, scope.user.id).filter(
        (notice) => notice.readAt === null && this.inFilter(notice, filter.data),
      );
      for (const notice of read) notice.readAt = this.now().toISOString();
      return reply(200, { ids: read.map((notice) => notice.id) });
    },
    getNotificationSettings: (params, session) => {
      const scope = this.scope(params, session);
      if ("status" in scope) return scope;
      return reply(200, this.preferencesOf(scope.workspaceId, scope.user.id));
    },
    setNotificationSettings: (params, session) => {
      const scope = this.scope(params, session);
      if ("status" in scope) return scope;
      const { workspaceId: _w, ...body } = params;
      const settings = { ...DEFAULT_NOTIFICATION_SETTINGS, ...body } as T.NotificationSettings;
      if (!Array.isArray(settings.rules) || settings.rules.length > 50) return invalid();
      this.notificationSettings.set(`${scope.workspaceId}/${scope.user.id}`, settings);
      return reply(200, settings);
    },

    getSettings: (params, session) => {
      const scope = this.scope(params, session);
      if ("status" in scope) return scope;
      return reply(200, this.settingsOf(scope.workspaceId));
    },
    updateSettings: (params, session) => {
      const scope = this.allowed(params, session, "configure");
      if ("status" in scope) return scope;
      const body = Bodies.settings.safeParse(params);
      if (!body.success) return invalid();
      const current = this.settingsOf(scope.workspaceId);
      if (current === undefined) return notFound("Workspace not found");
      const next = {
        ...current,
        ...Object.fromEntries(Object.entries(body.data).filter(([, v]) => v !== undefined)),
      };
      this.settings.set(scope.workspaceId, next);
      const workspace = this.state.workspaces.find((candidate) => candidate.id === scope.workspaceId);
      if (workspace !== undefined) {
        workspace.name = next.name;
        workspace.context = next.context;
        workspace.settings.timezone = next.timezone;
      }
      return reply(200, next);
    },
    updateMe: (params, session) => {
      const scope = this.scope(params, session);
      if ("status" in scope) return scope;
      const body = Bodies.me.safeParse(params);
      if (!body.success) return invalid();
      const member = this.memberOf(scope.workspaceId, scope.user.id);
      if (member === undefined) return notFound();
      const { name, handle, timezone } = body.data;
      if (
        handle !== undefined &&
        handle !== member.handle &&
        this.state.members.some((other) => other.workspaceId === scope.workspaceId && other.handle === handle)
      ) {
        return envelope(409, "handle.taken", "This handle is taken", { handle });
      }
      if (name !== undefined) {
        scope.user.name = name;
        for (const row of this.state.members) if (row.userId === scope.user.id) row.name = name;
      }
      if (handle !== undefined) member.handle = handle;
      if (timezone !== undefined) member.timezone = timezone;
      const { workspaceId: _w, ...person } = member;
      return reply(200, person);
    },
    updateMember: (params, session) => {
      const scope = this.allowed(params, session, "manage_members");
      if ("status" in scope) return scope;
      const body = Bodies.member.safeParse(params);
      if (!body.success || body.data.role === undefined) return invalid();
      const target = this.memberOf(scope.workspaceId, body.data.memberId);
      if (target === undefined) return notFound("Member not found");
      if (target.userId === scope.user.id)
        return envelope(403, "forbidden", "You can't change your own role");
      if ((target.role === "owner" || body.data.role === "owner") && scope.role !== "owner") {
        return envelope(403, "forbidden", "Only owners can promote or demote owners");
      }
      target.role = body.data.role;
      return reply(204, null);
    },
    deleteMember: (params, session) => {
      const scope = this.allowed(params, session, "manage_members");
      if ("status" in scope) return scope;
      const body = Bodies.member.safeParse(params);
      if (!body.success) return invalid();
      const target = this.memberOf(scope.workspaceId, body.data.memberId);
      if (target === undefined) return notFound("Member not found");
      if (target.role === "owner" && scope.role !== "owner") {
        return envelope(403, "forbidden", "Only owners can remove owners");
      }
      this.state.members.splice(this.state.members.indexOf(target), 1);
      return reply(204, null);
    },
    listInvitations: (params, session) => {
      const scope = this.allowed(params, session, "manage_members");
      if ("status" in scope) return scope;
      const invitations: T.Invitation[] = this.invitations
        .filter(
          (invitation) =>
            invitation.workspaceId === scope.workspaceId && this.invitationState(invitation) === "pending",
        )
        .map((invitation) => ({
          id: invitation.token,
          email: invitation.email,
          role: invitation.role,
          invitedBy: invitation.invitedBy,
          createdAt: SAMPLE_TIME,
          expiresAt: invitation.expiresAt.toISOString(),
        }));
      return reply(200, { invitations });
    },
    createInvitation: (params, session) => {
      const scope = this.allowed(params, session, "manage_members");
      if ("status" in scope) return scope;
      const body = Bodies.invite.safeParse(params);
      if (!body.success) return invalid();
      if (body.data.role === "owner" && scope.role !== "owner")
        return envelope(403, "forbidden", "Forbidden");
      if (
        this.state.members.some((m) => m.workspaceId === scope.workspaceId && m.email === body.data.email)
      ) {
        return envelope(409, "already_member", "This person is already a member");
      }
      const invitation: FakeInvitation = {
        token: this.id("inv"),
        workspaceId: scope.workspaceId,
        email: body.data.email,
        role: body.data.role,
        invitedBy: scope.user.id,
        expiresAt: new Date(this.now().getTime() + 7 * DAY_MS),
        status: "pending",
        requestedNew: false,
      };
      this.invitations.push(invitation);
      return reply(200, {
        invitation: {
          id: invitation.token,
          email: invitation.email,
          role: invitation.role,
          invitedBy: invitation.invitedBy,
          createdAt: this.now().toISOString(),
          expiresAt: invitation.expiresAt.toISOString(),
        },
        url: `https://vanr.test/invite/${invitation.token}`,
      });
    },
    createInvitationBulk: (params, session) => {
      const scope = this.allowed(params, session, "manage_members");
      if ("status" in scope) return scope;
      const body = z
        .object({ emails: z.array(z.string()).min(1).max(100), role: z.enum(ROLES) })
        .safeParse(params);
      if (!body.success) return invalid();
      if (body.data.role === "owner" && scope.role !== "owner")
        return envelope(403, "forbidden", "Forbidden");
      const results: T.BatchInviteResult[] = [];
      const seen = new Set<string>();
      for (const raw of body.data.emails) {
        const address = raw.trim().toLowerCase();
        if (address === "" || seen.has(address)) continue;
        seen.add(address);
        if (!email.safeParse(address).success) {
          results.push({ email: address, status: "bad_email" });
        } else if (
          this.state.members.some((m) => m.workspaceId === scope.workspaceId && m.email === address)
        ) {
          results.push({ email: address, status: "already_member" });
        } else if (
          this.invitations.some(
            (invitation) =>
              invitation.workspaceId === scope.workspaceId &&
              invitation.email === address &&
              this.invitationState(invitation) === "pending",
          )
        ) {
          results.push({ email: address, status: "already_invited" });
        } else {
          const token = this.id("inv");
          this.invitations.push({
            token,
            workspaceId: scope.workspaceId,
            email: address,
            role: body.data.role,
            invitedBy: scope.user.id,
            expiresAt: new Date(this.now().getTime() + 7 * DAY_MS),
            status: "pending",
            requestedNew: false,
          });
          results.push({ email: address, status: "invited", url: `https://vanr.test/invite/${token}` });
        }
      }
      return reply(200, { results });
    },
    deleteInvitation: (params, session) => {
      const scope = this.allowed(params, session, "manage_members");
      if ("status" in scope) return scope;
      const body = Bodies.invitationId.safeParse(params);
      if (!body.success) return invalid();
      const invitation = this.invitations.find(
        (candidate) =>
          candidate.token === body.data.invitationId && candidate.workspaceId === scope.workspaceId,
      );
      if (invitation === undefined) return notFound("Invitation not found");
      invitation.status = "revoked";
      return reply(204, null);
    },

    getStorage: (params, session) => {
      const scope = this.allowed(params, session, "configure");
      if ("status" in scope) return scope;
      return reply(200, this.storageOf(scope.workspaceId).config);
    },
    testStorage: (params, session) => {
      const scope = this.allowed(params, session, "configure");
      if ("status" in scope) return scope;
      const body = Bodies.s3.safeParse(params);
      if (!body.success) return invalid();
      const keys = this.storageKeys(scope.workspaceId, body.data);
      if (keys === undefined)
        return envelope(400, "storage.credentials_missing", "Enter the access key and the secret");
      return reply(200, this.probeBucket(body.data.endpoint));
    },
    setStorage: (params, session) => {
      const scope = this.allowed(params, session, "configure");
      if ("status" in scope) return scope;
      const kind = Bodies.storage.safeParse(params);
      if (!kind.success) return invalid();
      const stored = this.storageOf(scope.workspaceId);
      if (kind.data.kind === "builtin") {
        stored.config = { ...stored.config, kind: "builtin" };
        return reply(200, stored.config);
      }
      const body = Bodies.s3.safeParse(params.s3);
      if (!body.success) return invalid();
      const keys = this.storageKeys(scope.workspaceId, body.data);
      if (keys === undefined)
        return envelope(400, "storage.credentials_missing", "Enter the access key and the secret");
      const test = this.probeBucket(body.data.endpoint);
      if (!test.ok) {
        return envelope(400, "storage.bucket_check_failed", "The bucket did not pass the test", {
          steps: test.steps,
        });
      }
      const { accessKeyId: _key, secretAccessKey: _secret, ...s3 } = body.data;
      const preview = (key: string) => `…${key.slice(-4)}`;
      stored.keys = keys;
      stored.config = {
        kind: "s3",
        s3: {
          ...s3,
          prefix: s3.prefix === null || s3.prefix.trim() === "" ? null : s3.prefix.trim(),
          accessKeyIdPreview: preview(keys.accessKeyId),
          secretPreview: preview(keys.secretAccessKey),
        },
        transfer: stored.config.transfer,
      };
      return reply(200, stored.config);
    },
    migrateStorage: (params, session) => {
      const scope = this.allowed(params, session, "configure");
      if ("status" in scope) return scope;
      const stored = this.storageOf(scope.workspaceId);
      if (stored.config.kind !== "s3") return envelope(409, "storage.unavailable", "Save a bucket first");
      const transfer: T.StorageMigration = { status: "running", copied: 0, total: 12, error: null };
      stored.config = { ...stored.config, transfer };
      return reply(200, transfer);
    },
    listStorageMigrationStatus: (params, session) => {
      const scope = this.allowed(params, session, "configure");
      if ("status" in scope) return scope;
      return reply(200, this.storageOf(scope.workspaceId).config.transfer);
    },

    listAgents: (params, session) => {
      const scope = this.scope(params, session);
      if ("status" in scope) return scope;
      // As on the server: an archived agent leaves the list (its row and its handle stay).
      const agents: T.Agent[] = this.agents
        .filter((candidate) => candidate.workspaceId === scope.workspaceId && candidate.archivedAt === null)
        .map(({ workspaceId: _workspace, ...rest }) => ({
          ...rest,
          busy: this.runs.some((candidate) => candidate.agentId === rest.id),
        }));
      return reply(200, { agents });
    },
    listActiveRuns: (params, session) => {
      const scope = this.scope(params, session);
      if ("status" in scope) return scope;
      const runs: T.WorkingRun[] = this.runs
        .filter((candidate) => candidate.workspaceId === scope.workspaceId)
        .map(({ workspaceId: _workspace, ...rest }) => rest);
      return reply(200, { runs });
    },
  };
}
