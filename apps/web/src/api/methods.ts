// The server operations the web calls: name, verb, path, parameters and the schema of the answer.
// Names and paths follow the server's operation ids. An area that needs another operation adds
// one entry here; nothing else in the API layer changes.
//
// Parameters named in the path fill it; the others go in the query string of a GET or DELETE and
// in the JSON body of anything else.
import type {
  InvitationPreview,
  Me,
  NotificationCounts,
  Role,
  User,
  Workspace,
  WorkspaceOverview,
  WorkspaceSummary,
} from "@vanr/contract";
import { z } from "zod";
import type { Verb } from "./transport.ts";

export type MethodSpec<Params, Result> = {
  readonly verb: Verb;
  readonly path: string;
  /**
   * False for the operations that work without a session (sign in, sign up, invitation preview):
   * a 401 from them is an ordinary error, not the end of a session.
   */
  readonly session: boolean;
  readonly result: z.ZodType<Result>;
  /** Carries the parameter type; never called. */
  readonly params?: (params: Params) => void;
};

type Shape<Result> = Omit<MethodSpec<never, Result>, "params" | "session"> & { session?: boolean };

/** One operation. `define<Params>()({ ... })` so the result type is inferred from the schema. */
const define =
  <Params = void>() =>
  <Result>(shape: Shape<Result>): MethodSpec<Params, Result> => ({ session: true, ...shape });

/** For operations whose answer the web does not read. */
const Nothing = z.unknown().transform((): void => undefined);

const RoleSchema = z.enum(["admin", "member", "owner"]) satisfies z.ZodType<Role>;

const UserSchema = z.object({
  id: z.string(),
  email: z.string(),
  image: z.string().nullable(),
  name: z.string(),
}) satisfies z.ZodType<User>;

const WorkspaceSummarySchema = z.object({
  id: z.string(),
  logo: z.string().nullable(),
  name: z.string(),
  role: RoleSchema,
}) satisfies z.ZodType<WorkspaceSummary>;

const MeSchema = z.object({
  user: UserSchema,
  workspaces: z.array(WorkspaceSummarySchema),
}) satisfies z.ZodType<Me>;

const AuthConfigSchema = z.object({
  socialProviders: z.object({ google: z.boolean(), github: z.boolean(), apple: z.boolean() }),
  /** Anyone may create an account. When false, only the first person and invitees may. */
  signupOpen: z.boolean(),
  /** The installation has no account yet: whoever signs up first owns it. */
  firstRun: z.boolean(),
});
export type AuthConfig = z.infer<typeof AuthConfigSchema>;

const InvitationPreviewSchema = z.object({
  email: z.string().nullable(),
  expiresAt: z.string(),
  invitedByName: z.string().nullable(),
  role: RoleSchema,
  workspaceId: z.string(),
  workspaceName: z.string(),
}) satisfies z.ZodType<InvitationPreview>;

const WorkspaceSchema = z.object({
  id: z.string(),
  context: z.string(),
  logo: z.string().nullable(),
  name: z.string(),
}) satisfies z.ZodType<Workspace>;

const OverviewSchema = z.object({
  agents: z.number(),
  budgetSpentPct: z.number(),
  myApprovalQueue: z.number(),
  people: z.number(),
}) satisfies z.ZodType<WorkspaceOverview>;

const NotificationCountsSchema = z.object({
  actionNeeded: z.number(),
  all: z.number(),
  badge: z.number(),
  fyi: z.number(),
  mentions: z.number(),
  reactions: z.number(),
  unread: z.number(),
  waiting: z.number(),
}) satisfies z.ZodType<NotificationCounts>;

/** What the frame reads of an agent. The agents area extends this when it builds its screens. */
const AgentSummarySchema = z.object({
  id: z.string(),
  archivedAt: z.string().nullable(),
  /** The agent is in the middle of a run right now. */
  busy: z.boolean(),
  handle: z.string(),
  name: z.string(),
});
export type AgentSummary = z.infer<typeof AgentSummarySchema>;

type WorkspaceScope = { workspaceId: string };

export const METHODS = {
  // The sign-in service. Its operations have no id in the server's table; these names are the web's.
  signIn: define<{ email: string; password: string }>()({
    verb: "POST",
    path: "/api/auth/sign-in/email",
    session: false,
    result: Nothing,
  }),
  signUp: define<{ name: string; email: string; password: string }>()({
    verb: "POST",
    path: "/api/auth/sign-up/email",
    session: false,
    result: Nothing,
  }),
  signOut: define()({ verb: "POST", path: "/api/auth/sign-out", session: false, result: Nothing }),
  requestPasswordReset: define<{ email: string; redirectTo: string }>()({
    verb: "POST",
    path: "/api/auth/request-password-reset",
    session: false,
    result: Nothing,
  }),
  resetPassword: define<{ token: string; newPassword: string }>()({
    verb: "POST",
    path: "/api/auth/reset-password",
    session: false,
    result: Nothing,
  }),
  verifyEmail: define<{ token: string }>()({
    verb: "GET",
    path: "/api/auth/verify-email",
    session: false,
    result: Nothing,
  }),
  sendVerificationEmail: define<{ email: string; callbackURL: string }>()({
    verb: "POST",
    path: "/api/auth/send-verification-email",
    session: false,
    result: Nothing,
  }),

  // Account.
  getAuthConfig: define()({
    verb: "GET",
    path: "/api/v1/auth/config",
    session: false,
    result: AuthConfigSchema,
  }),
  getMe: define()({ verb: "GET", path: "/api/v1/me", result: MeSchema }),
  createWaitlist: define<{ email: string; locale: string }>()({
    verb: "POST",
    path: "/api/v1/waitlist",
    session: false,
    result: Nothing,
  }),
  confirmWaitlist: define<{ token: string }>()({
    verb: "POST",
    path: "/api/v1/waitlist/confirm",
    session: false,
    result: Nothing,
  }),

  // Invitations, by the token in the link.
  getInvitation: define<{ invitationId: string }>()({
    verb: "GET",
    path: "/api/v1/invitations/:invitationId",
    session: false,
    result: InvitationPreviewSchema,
  }),
  acceptInvitation: define<{ invitationId: string }>()({
    verb: "POST",
    path: "/api/v1/invitations/:invitationId/accept",
    result: z.object({ workspaceId: z.string() }),
  }),
  requestInvitationNew: define<{ invitationId: string }>()({
    verb: "POST",
    path: "/api/v1/invitations/:invitationId/request-new",
    session: false,
    result: Nothing,
  }),

  // Workspaces.
  createWorkspace: define<{ name: string; context?: string; timezone: string }>()({
    verb: "POST",
    path: "/api/v1/workspaces",
    result: z.object({ workspace: WorkspaceSchema }),
  }),
  getOverview: define<WorkspaceScope>()({
    verb: "GET",
    path: "/api/v1/workspaces/:workspaceId/overview",
    result: OverviewSchema,
  }),
  listNotificationCounts: define<WorkspaceScope>()({
    verb: "GET",
    path: "/api/v1/workspaces/:workspaceId/notifications/counts",
    result: NotificationCountsSchema,
  }),
  listAgents: define<WorkspaceScope>()({
    verb: "GET",
    path: "/api/v1/workspaces/:workspaceId/agents",
    result: z.object({ agents: z.array(AgentSummarySchema) }),
  }),
} as const;

export type ApiMethod = keyof typeof METHODS;
export const API_METHODS = Object.keys(METHODS) as ApiMethod[];

export type ParamsOf<M extends ApiMethod> =
  (typeof METHODS)[M] extends MethodSpec<infer P, unknown> ? P : never;
export type ResultOf<M extends ApiMethod> =
  (typeof METHODS)[M] extends MethodSpec<never, infer R> ? R : never;
