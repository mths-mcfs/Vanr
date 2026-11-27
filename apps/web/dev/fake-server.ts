// A stand-in for the Vanr server, for developing and testing the web without one. It is a layer
// over the client's own fake (`@vanr/client/testing`), which already answers the account,
// workspace and channel routes with the server's error envelope. This file adds only what that
// fake lacks and the web needs: the sign-in service, the waitlist, invitations, the overview, the
// notice counts, agents and their runs, sessions by cookie, the server's side of the real-time
// socket, and a way to force any state (an error, a held answer, a busy server, an ended session,
// a dropped connection). The Drive and the search live in `fake-files.ts`, bases in `fake-bases.ts`. It is never part of the
// production build.
import { endpoints, type FetchLike, type MethodName, type SocketLike } from "@vanr/client";
import { type FakeServer as ClientFake, createFakeServer, FakeSocket } from "@vanr/client/testing";
import type * as T from "@vanr/contract";
import { z } from "zod";
import { AUTH_ROUTES, type AuthMethod } from "../src/api/auth.ts";
import { FakeBases } from "./fake-bases.ts";
import { FakeFiles } from "./fake-files.ts";

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
  agents: FakeAgent[] = [];
  runs: FakeRun[] = [];
  invitations: FakeInvitation[] = [];
  waitlist: { email: string; token: string; confirmed: boolean }[] = [];
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
  /** Bases: tables, views, rows and relations. */
  readonly bases: FakeBases;
  private readonly fileOperations: ReturnType<FakeFiles["operations"]>;
  private readonly accounts = new Map<string, Account>();
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly sessions = new Map<string, string>();
  private readonly forced = new Map<FakeMethod, { answer: Forced; times: number }>();
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
    this.fileOperations = { ...this.files.operations(), ...this.bases.operations() };
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
  force(method: FakeMethod, forced: Forced, times = 1): void {
    this.forced.set(method, { answer: forced, times });
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
    if (forced !== undefined) {
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
      const badge = scope.workspaceId === "workspace_birchwood" && scope.user.id === "usr_ana" ? 3 : 0;
      const counts: T.NotificationCounts = {
        actionNeeded: badge,
        all: badge + 4,
        badge,
        fyi: 4,
        mentions: 1,
        reactions: 2,
        unread: badge + 4,
        waiting: badge,
      };
      return reply(200, counts);
    },
    listAgents: (params, session) => {
      const scope = this.scope(params, session);
      if ("status" in scope) return scope;
      const agents: T.Agent[] = this.agents
        .filter((candidate) => candidate.workspaceId === scope.workspaceId)
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
