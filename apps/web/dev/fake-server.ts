// A stand-in for the Vanr server, for developing and testing the web without one. It answers the
// operations in src/api/methods.ts from memory, with example data in English, and lets a test or
// a person force any state: an error, a held (slow) answer, a busy server, an ended session, a
// dropped connection. It is never part of the production build.
import { z } from "zod";
import { type ApiMethod, METHODS } from "../src/api/methods.ts";
import type { Verb } from "../src/api/transport.ts";
import { ACCESS_ENDED_CODE, type SocketHandle, type SocketHandlers } from "../src/realtime/connection.ts";

type Role = "admin" | "member" | "owner";
type FakeUser = { id: string; name: string; email: string; password: string; emailVerified: boolean };
type FakeWorkspace = { id: string; name: string; context: string; approvalsWaitingFor: string[] };
type FakeMember = { workspaceId: string; userId: string; role: Role };
type FakeAgent = { id: string; workspaceId: string; name: string; handle: string; busy: boolean };
type FakeInvitation = {
  token: string;
  workspaceId: string;
  email: string | null;
  role: Role;
  invitedBy: string | null;
  expiresAt: Date;
  status: "accepted" | "pending" | "revoked";
  requestedNew: boolean;
};
type FakeMail = { to: string; kind: "reset" | "verify" | "waitlist"; token: string };

export type FakeState = {
  signupOpen: boolean;
  users: FakeUser[];
  workspaces: FakeWorkspace[];
  members: FakeMember[];
  agents: FakeAgent[];
  invitations: FakeInvitation[];
  waitlist: { email: string; token: string; confirmed: boolean }[];
};

/** How a forced answer looks. `envelope` picks the server's error body; the default follows the path. */
export type Forced =
  | { kind: "error"; status: number; code: string; message?: string; retryAfter?: number; envelope?: boolean }
  /** No answer at all, as when the network is down. */
  | { kind: "offline" };

export type FakeRequest = {
  verb: Verb;
  path: string;
  query?: Record<string, string>;
  body?: unknown;
  /** The session cookie's value, when the caller has one. */
  session?: string | undefined;
};

export type FakeResponse = {
  status: number;
  body: unknown;
  retryAfter?: number;
  /** A new session cookie value, or null to clear it. */
  setSession?: string | null;
};

/** Thrown for a forced `offline`: the caller turns it into a network failure. */
export class FakeOffline extends Error {}

export const EXAMPLE_PASSWORD = "birch-and-tar";
const DAY_MS = 86_400_000;

/** The seeds. `team`: a running installation. `closed`: the same with sign-up by invitation. `empty`: no account yet. */
export type SeedName = "team" | "closed" | "empty";

export function seedState(name: SeedName, now: Date): FakeState {
  if (name === "empty") {
    return {
      signupOpen: false,
      users: [],
      workspaces: [],
      members: [],
      agents: [],
      invitations: [],
      waitlist: [],
    };
  }
  const user = (id: string, name: string, email: string): FakeUser => ({
    id,
    name,
    email,
    password: EXAMPLE_PASSWORD,
    emailVerified: true,
  });
  const inDays = (days: number) => new Date(now.getTime() + days * DAY_MS);
  return {
    signupOpen: name === "team",
    users: [
      user("usr_ana", "Ana Beatriz Souza", "ana@birchwood.example"),
      user("usr_jonas", "Jonas Lind", "jonas@birchwood.example"),
      user("usr_iris", "Íris Valença", "iris@birchwood.example"),
      user("usr_tomas", "Tomás Eriksen", "tomas@birchwood.example"),
      user("usr_noor", "Noor Haddad", "noor@elsewhere.example"),
    ],
    workspaces: [
      {
        id: "workspace_birchwood",
        name: "Birchwood Labs",
        context: "We build tools for small print shops.",
        approvalsWaitingFor: ["usr_ana", "usr_ana"],
      },
      { id: "workspace_nightshift", name: "Night Shift", context: "", approvalsWaitingFor: [] },
    ],
    members: [
      { workspaceId: "workspace_birchwood", userId: "usr_ana", role: "owner" },
      { workspaceId: "workspace_birchwood", userId: "usr_jonas", role: "admin" },
      { workspaceId: "workspace_birchwood", userId: "usr_iris", role: "member" },
      { workspaceId: "workspace_birchwood", userId: "usr_tomas", role: "member" },
      { workspaceId: "workspace_nightshift", userId: "usr_jonas", role: "owner" },
      { workspaceId: "workspace_nightshift", userId: "usr_ana", role: "member" },
    ],
    agents: [
      { id: "agt_scout", workspaceId: "workspace_birchwood", name: "Scout", handle: "scout", busy: true },
      { id: "agt_ledger", workspaceId: "workspace_birchwood", name: "Ledger", handle: "ledger", busy: true },
      { id: "agt_tally", workspaceId: "workspace_birchwood", name: "Tally", handle: "tally", busy: false },
      { id: "agt_fjell", workspaceId: "workspace_nightshift", name: "Fjell", handle: "fjell", busy: false },
    ],
    invitations: [
      {
        token: "inv-mel-pending",
        workspaceId: "workspace_birchwood",
        email: "mel@birchwood.example",
        role: "member",
        invitedBy: "usr_ana",
        expiresAt: inDays(7),
        status: "pending",
        requestedNew: false,
      },
      {
        token: "inv-open-link",
        workspaceId: "workspace_birchwood",
        email: null,
        role: "member",
        invitedBy: "usr_jonas",
        expiresAt: inDays(3),
        status: "pending",
        requestedNew: false,
      },
      {
        token: "inv-expired",
        workspaceId: "workspace_birchwood",
        email: "late@birchwood.example",
        role: "member",
        invitedBy: "usr_ana",
        expiresAt: inDays(-1),
        status: "pending",
        requestedNew: false,
      },
      {
        token: "inv-used",
        workspaceId: "workspace_birchwood",
        email: "iris@birchwood.example",
        role: "member",
        invitedBy: "usr_ana",
        expiresAt: inDays(5),
        status: "accepted",
        requestedNew: false,
      },
    ],
    waitlist: [{ email: "patient@elsewhere.example", token: "waitlist-token-patient", confirmed: false }],
  };
}

const answer = (status: number, body: unknown, extra: Partial<FakeResponse> = {}): FakeResponse => ({
  status,
  body,
  ...extra,
});
const envelope = (status: number, code: string, message: string, params?: Record<string, unknown>) =>
  answer(status, { error: params ? { code, message, params } : { code, message } });
/** The sign-in service's error body. */
const authError = (status: number, code: string, message: string) => answer(status, { code, message });
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
  createWorkspace: z.object({
    name: z.string().trim().min(1),
    context: z.string().optional(),
    timezone: z.string().min(1),
  }),
  workspace: z.object({ workspaceId: z.string() }),
};

const PASSWORD_MIN = 8;

type Route = { method: ApiMethod; verb: Verb; pattern: RegExp; names: string[] };

const ROUTES: Route[] = Object.entries(METHODS).map(([method, spec]) => {
  const names: string[] = [];
  const pattern = spec.path.replace(/:([A-Za-z][A-Za-z0-9]*)/g, (_, name: string) => {
    names.push(name);
    return "([^/]+)";
  });
  // The key was read from METHODS, so it names an operation.
  return { method: method as ApiMethod, verb: spec.verb, pattern: new RegExp(`^${pattern}$`), names };
});

type OpenSocket = { workspaceId: string; userId: string; handlers: SocketHandlers; channels: Set<string> };

export type FakeServerOptions = {
  seed?: SeedName;
  now?: () => Date;
  /** Waits before answering an operation made slow with `slow()`. Tests leave it out and use `hold()`. */
  sleep?: (ms: number) => Promise<void>;
};

export class FakeServer {
  state: FakeState;
  /** Every email the server "sent", newest last. */
  readonly mail: FakeMail[] = [];
  /** Every call that reached an operation, in order. */
  readonly calls: { method: ApiMethod; params: Record<string, unknown> }[] = [];
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly sessions = new Map<string, string>();
  private readonly forced = new Map<ApiMethod, { answer: Forced; times: number }>();
  private readonly held = new Map<ApiMethod, Promise<void>>();
  private readonly slowed = new Map<ApiMethod, number>();
  private readonly sockets = new Set<OpenSocket>();
  private blocking = false;
  private counter = 0;

  constructor(options: FakeServerOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? (() => Promise.resolve());
    this.state = seedState(options.seed ?? "team", this.now());
  }

  /* ---------- forcing states ---------- */

  /** Starts over from a seed: data, sessions, forced answers and sockets. */
  reset(seed: SeedName): void {
    this.state = seedState(seed, this.now());
    this.sessions.clear();
    this.forced.clear();
    this.held.clear();
    this.slowed.clear();
    this.mail.length = 0;
    this.calls.length = 0;
    this.blocking = false;
    this.dropConnections();
  }

  /** The next `times` calls of an operation get this answer instead of the real one. */
  force(method: ApiMethod, forced: Forced, times = 1): void {
    this.forced.set(method, { answer: forced, times });
  }

  /** Calls of an operation wait until `release()`: the "sending" state, without a clock. */
  hold(method: ApiMethod): { release: () => void } {
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

  /** Calls of an operation take `ms` to answer (with the `sleep` given to the constructor). */
  slow(method: ApiMethod, ms: number): void {
    if (ms <= 0) this.slowed.delete(method);
    else this.slowed.set(method, ms);
  }

  /** Every session ends: the next call answers 401 and open sockets close with 4401. */
  expireSessions(): void {
    this.sessions.clear();
    for (const socket of [...this.sockets]) this.closeSocket(socket, ACCESS_ENDED_CODE);
  }

  /** Signs a seeded person in and returns the session cookie value. */
  sessionFor(userId: string): string {
    const token = this.id("session");
    this.sessions.set(token, userId);
    return token;
  }

  userOf(session: string | undefined): FakeUser | undefined {
    const userId = session === undefined ? undefined : this.sessions.get(session);
    return this.state.users.find((user) => user.id === userId);
  }

  /* ---------- real time ---------- */

  /** Opens a socket as the server would after the upgrade. Blocked while `blockConnections(true)`. */
  connect(workspaceId: string, session: string | undefined, handlers: SocketHandlers): SocketHandle {
    const user = this.userOf(session);
    const member = user !== undefined && this.memberOf(workspaceId, user.id) !== undefined;
    if (this.blocking || !member || user === undefined) {
      // A blocked upgrade reaches the browser as an abnormal close.
      queueMicrotask(() => handlers.close(1006));
      return { send: () => {}, close: () => {} };
    }
    const socket: OpenSocket = { workspaceId, userId: user.id, handlers, channels: new Set() };
    this.sockets.add(socket);
    queueMicrotask(() => {
      if (!this.sockets.has(socket)) return;
      handlers.open();
      handlers.message(JSON.stringify({ type: "ready", workspaceId, userId: user.id }));
    });
    return {
      send: (text) => this.receive(socket, text),
      close: () => void this.sockets.delete(socket),
    };
  }

  private receive(socket: OpenSocket, text: string): void {
    const Frame = z.object({ type: z.string(), channelId: z.string().optional() });
    let frame: z.infer<typeof Frame>;
    try {
      frame = Frame.parse(JSON.parse(text));
    } catch {
      socket.handlers.message(JSON.stringify({ type: "error", code: "invalid_frame" }));
      return;
    }
    const reply = (value: unknown) => socket.handlers.message(JSON.stringify(value));
    if (frame.type === "ping") reply({ type: "pong" });
    else if (frame.type === "subscribe" && frame.channelId !== undefined) {
      socket.channels.add(frame.channelId);
      reply({ type: "subscribed", channelId: frame.channelId });
    } else if (frame.type === "unsubscribe" && frame.channelId !== undefined) {
      socket.channels.delete(frame.channelId);
      reply({ type: "unsubscribed", channelId: frame.channelId });
    }
  }

  private closeSocket(socket: OpenSocket, code: number): void {
    if (this.sockets.delete(socket)) socket.handlers.close(code);
  }

  /** Sends an event to everyone in a workspace, or to the followers of one channel. */
  emit(workspaceId: string, event: { type: string } & Record<string, unknown>, channelId?: string): void {
    for (const socket of this.sockets) {
      if (socket.workspaceId !== workspaceId) continue;
      if (channelId === undefined) {
        socket.handlers.message(JSON.stringify({ type: "event", scope: "workspace", event }));
      } else if (socket.channels.has(channelId)) {
        socket.handlers.message(JSON.stringify({ type: "event", channelId, event }));
      }
    }
  }

  /** Closes every socket the way a lost network does. */
  dropConnections(): void {
    for (const socket of [...this.sockets]) this.closeSocket(socket, 1006);
  }

  /** While true, every new socket fails to open: the connection stays lost. */
  blockConnections(block: boolean): void {
    this.blocking = block;
  }

  /** How many sockets are open, and the channels each follows. */
  openSockets(): { workspaceId: string; userId: string; channels: string[] }[] {
    return [...this.sockets].map((socket) => ({
      workspaceId: socket.workspaceId,
      userId: socket.userId,
      channels: [...socket.channels].sort(),
    }));
  }

  /** An agent starts or stops working, and the workspace hears about it. */
  setAgentBusy(agentId: string, busy: boolean): void {
    const agent = this.state.agents.find((candidate) => candidate.id === agentId);
    if (agent === undefined) throw new Error(`fake server: no agent ${agentId}`);
    agent.busy = busy;
    this.emit(agent.workspaceId, { type: "run.status_changed", agentId, status: busy ? "running" : "idle" });
  }

  /* ---------- requests ---------- */

  async handle(request: FakeRequest): Promise<FakeResponse> {
    const route = ROUTES.find(
      (candidate) => candidate.verb === request.verb && candidate.pattern.test(request.path),
    );
    if (route === undefined) return envelope(404, "route_not_found", "No such route");
    const match = route.pattern.exec(request.path);
    const params: Record<string, unknown> = { ...request.query };
    if (typeof request.body === "object" && request.body !== null) Object.assign(params, request.body);
    route.names.forEach((name, index) => {
      params[name] = decodeURIComponent(match?.[index + 1] ?? "");
    });
    this.calls.push({ method: route.method, params });

    await this.held.get(route.method);
    const slow = this.slowed.get(route.method);
    if (slow !== undefined) await this.sleep(slow);

    const forced = this.forced.get(route.method);
    if (forced !== undefined) {
      if (forced.times <= 1) this.forced.delete(route.method);
      else forced.times -= 1;
      if (forced.answer.kind === "offline") throw new FakeOffline("forced offline");
      const { status, code, message = "Forced by the fake server", retryAfter } = forced.answer;
      const asEnvelope = forced.answer.envelope ?? !request.path.startsWith("/api/auth/");
      const response = asEnvelope
        ? envelope(status, code, message)
        : authError(status, code.toUpperCase(), message);
      return retryAfter === undefined ? response : { ...response, retryAfter };
    }
    return this.operations[route.method](params, request.session);
  }

  private id(prefix: string): string {
    this.counter += 1;
    return `${prefix}_${this.counter.toString(36).padStart(4, "0")}`;
  }

  private memberOf(workspaceId: string, userId: string): FakeMember | undefined {
    return this.state.members.find(
      (member) => member.workspaceId === workspaceId && member.userId === userId,
    );
  }

  private invitationState(invitation: FakeInvitation): "accepted" | "expired" | "pending" | "revoked" {
    if (invitation.status !== "pending") return invitation.status;
    return invitation.expiresAt.getTime() <= this.now().getTime() ? "expired" : "pending";
  }

  private mayCreateAccount(address: string): boolean {
    if (this.state.signupOpen || this.state.users.length === 0) return true;
    return this.state.invitations.some(
      (invitation) => invitation.email === address && this.invitationState(invitation) === "pending",
    );
  }

  /** A member-only operation: the workspace and the caller's membership, or the error answer. */
  private scope(
    params: Record<string, unknown>,
    session: string | undefined,
  ): { workspace: FakeWorkspace; user: FakeUser } | FakeResponse {
    const user = this.userOf(session);
    if (user === undefined) return unauthorized();
    const parsed = Bodies.workspace.safeParse(params);
    if (!parsed.success) return invalid();
    const workspace = this.state.workspaces.find((candidate) => candidate.id === parsed.data.workspaceId);
    if (workspace === undefined || this.memberOf(workspace.id, user.id) === undefined) {
      return notFound("Workspace not found");
    }
    return { workspace, user };
  }

  private readonly operations: Record<
    ApiMethod,
    (params: Record<string, unknown>, session: string | undefined) => FakeResponse
  > = {
    signIn: (params) => {
      const body = Bodies.signIn.safeParse(params);
      if (!body.success) return authError(400, "INVALID_EMAIL", "Invalid email");
      const user = this.state.users.find((candidate) => candidate.email === body.data.email);
      if (user === undefined || user.password !== body.data.password) {
        return authError(401, "INVALID_EMAIL_OR_PASSWORD", "Invalid email or password");
      }
      return answer(
        200,
        { redirect: false, user: { id: user.id } },
        { setSession: this.sessionFor(user.id) },
      );
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
      const user: FakeUser = { id: this.id("usr"), ...body.data, emailVerified: false };
      this.state.users.push(user);
      this.mail.push({ to: user.email, kind: "verify", token: `verify-${user.id}` });
      return answer(200, { user: { id: user.id } }, { setSession: this.sessionFor(user.id) });
    },
    signOut: (_params, session) => {
      if (session !== undefined) this.sessions.delete(session);
      return answer(200, { success: true }, { setSession: null });
    },
    requestPasswordReset: (params) => {
      const body = Bodies.requestPasswordReset.safeParse(params);
      if (!body.success) return authError(400, "INVALID_EMAIL", "Invalid email");
      const user = this.state.users.find((candidate) => candidate.email === body.data.email);
      // The answer is the same whether or not the account exists.
      if (user !== undefined) this.mail.push({ to: user.email, kind: "reset", token: `reset-${user.id}` });
      return answer(200, { status: true });
    },
    resetPassword: (params) => {
      const body = Bodies.resetPassword.safeParse(params);
      const sent = body.success
        ? this.mail.find((mail) => mail.kind === "reset" && mail.token === body.data.token)
        : undefined;
      const user = this.state.users.find((candidate) => candidate.email === sent?.to);
      if (!body.success || sent === undefined || user === undefined) {
        return authError(400, "INVALID_TOKEN", "Invalid token");
      }
      if (body.data.newPassword.length < PASSWORD_MIN) {
        return authError(400, "PASSWORD_TOO_SHORT", "Password too short");
      }
      user.password = body.data.newPassword;
      this.mail.splice(this.mail.indexOf(sent), 1);
      return answer(200, { status: true });
    },
    verifyEmail: (params) => {
      const body = Bodies.verifyEmail.safeParse(params);
      const sent = body.success
        ? this.mail.find((mail) => mail.kind === "verify" && mail.token === body.data.token)
        : undefined;
      const user = this.state.users.find((candidate) => candidate.email === sent?.to);
      // The real service answers 401 here; it is not the end of a session.
      if (sent === undefined || user === undefined) return authError(401, "INVALID_TOKEN", "Invalid token");
      user.emailVerified = true;
      this.mail.splice(this.mail.indexOf(sent), 1);
      return answer(200, { status: true });
    },
    sendVerificationEmail: (params) => {
      const body = Bodies.sendVerificationEmail.safeParse(params);
      if (!body.success) return authError(400, "INVALID_EMAIL", "Invalid email");
      const user = this.state.users.find((candidate) => candidate.email === body.data.email);
      if (user !== undefined)
        this.mail.push({ to: user.email, kind: "verify", token: `verify-${this.id("mail")}` });
      return answer(200, { status: true });
    },

    getAuthConfig: () =>
      answer(200, {
        socialProviders: { google: false, github: false, apple: false },
        signupOpen: this.state.signupOpen,
        firstRun: this.state.users.length === 0,
      }),
    getMe: (_params, session) => {
      const user = this.userOf(session);
      if (user === undefined) return unauthorized();
      const workspaces = this.state.members
        .filter((member) => member.userId === user.id)
        .flatMap((member) => {
          const workspace = this.state.workspaces.find((candidate) => candidate.id === member.workspaceId);
          return workspace === undefined
            ? []
            : [{ id: workspace.id, name: workspace.name, role: member.role, logo: null }];
        });
      return answer(200, {
        user: { id: user.id, name: user.name, email: user.email, image: null },
        workspaces,
      });
    },
    createWaitlist: (params) => {
      const body = Bodies.createWaitlist.safeParse(params);
      if (!body.success) return invalid();
      let entry = this.state.waitlist.find((candidate) => candidate.email === body.data.email);
      if (entry === undefined) {
        entry = { email: body.data.email, token: `waitlist-token-${this.id("wl")}`, confirmed: false };
        this.state.waitlist.push(entry);
      }
      if (!entry.confirmed) this.mail.push({ to: entry.email, kind: "waitlist", token: entry.token });
      return answer(200, { ok: true });
    },
    confirmWaitlist: (params) => {
      const body = Bodies.confirmWaitlist.safeParse(params);
      if (!body.success) return invalid();
      const entry = this.state.waitlist.find((candidate) => candidate.token === body.data.token);
      if (entry === undefined) return notFound("Confirmation link not found");
      entry.confirmed = true;
      return answer(200, { ok: true });
    },

    getInvitation: (params, session) => {
      const body = Bodies.invitation.safeParse(params);
      if (!body.success) return invalid();
      const invitation = this.state.invitations.find(
        (candidate) => candidate.token === body.data.invitationId,
      );
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
      return answer(200, {
        workspaceId: invitation.workspaceId,
        workspaceName: workspace?.name ?? "",
        email: invitation.email,
        role: invitation.role,
        invitedByName: inviter?.name ?? null,
        expiresAt: invitation.expiresAt.toISOString(),
      });
    },
    acceptInvitation: (params, session) => {
      const user = this.userOf(session);
      if (user === undefined) return unauthorized();
      const body = Bodies.invitation.safeParse(params);
      if (!body.success) return invalid();
      const invitation = this.state.invitations.find(
        (candidate) => candidate.token === body.data.invitationId,
      );
      if (invitation === undefined) return notFound("Invitation not found or expired");
      const joined = answer(200, { workspaceId: invitation.workspaceId });
      if (this.memberOf(invitation.workspaceId, user.id) !== undefined) return joined;
      if (this.invitationState(invitation) !== "pending") return notFound("Invitation not found or expired");
      if (invitation.email !== null && invitation.email !== user.email) {
        return envelope(403, "invitation.wrong_email", "This invitation is for another email", {
          email: invitation.email,
        });
      }
      if (invitation.email !== null) invitation.status = "accepted";
      this.state.members.push({
        workspaceId: invitation.workspaceId,
        userId: user.id,
        role: invitation.role,
      });
      return joined;
    },
    requestInvitationNew: (params) => {
      const body = Bodies.invitation.safeParse(params);
      if (!body.success) return invalid();
      const invitation = this.state.invitations.find(
        (candidate) => candidate.token === body.data.invitationId,
      );
      if (invitation === undefined || invitation.status === "accepted") {
        return notFound("Invitation not found or expired");
      }
      invitation.requestedNew = true;
      return answer(204, null);
    },

    createWorkspace: (params, session) => {
      const user = this.userOf(session);
      if (user === undefined) return unauthorized();
      const body = Bodies.createWorkspace.safeParse(params);
      if (!body.success) return invalid();
      const workspace: FakeWorkspace = {
        id: this.id("workspace"),
        name: body.data.name,
        context: body.data.context ?? "",
        approvalsWaitingFor: [],
      };
      this.state.workspaces.push(workspace);
      this.state.members.push({ workspaceId: workspace.id, userId: user.id, role: "owner" });
      return answer(201, {
        workspace: { id: workspace.id, name: workspace.name, context: workspace.context, logo: null },
      });
    },
    getOverview: (params, session) => {
      const scope = this.scope(params, session);
      if ("status" in scope) return scope;
      const inWorkspace = <T extends { workspaceId: string }>(rows: T[]) =>
        rows.filter((row) => row.workspaceId === scope.workspace.id);
      return answer(200, {
        people: inWorkspace(this.state.members).length,
        agents: inWorkspace(this.state.agents).length,
        myApprovalQueue: scope.workspace.approvalsWaitingFor.filter((userId) => userId === scope.user.id)
          .length,
        budgetSpentPct: scope.workspace.id === "workspace_birchwood" ? 38 : 0,
      });
    },
    listNotificationCounts: (params, session) => {
      const scope = this.scope(params, session);
      if ("status" in scope) return scope;
      const badge = scope.workspace.id === "workspace_birchwood" && scope.user.id === "usr_ana" ? 3 : 0;
      return answer(200, {
        actionNeeded: badge,
        all: badge + 4,
        badge,
        fyi: 4,
        mentions: 1,
        reactions: 2,
        unread: badge + 4,
        waiting: badge,
      });
    },
    listAgents: (params, session) => {
      const scope = this.scope(params, session);
      if ("status" in scope) return scope;
      return answer(200, {
        agents: this.state.agents
          .filter((agent) => agent.workspaceId === scope.workspace.id)
          .map(({ id, name, handle, busy }) => ({ id, name, handle, busy, archivedAt: null })),
      });
    },
  };
}
