/*
 * The web's route table, and the contract every area of the app builds on.
 *
 * The shell owns this file, the router, the session, the real-time connection, the message loader,
 * `apps/web/package.json`, the `web` CI job and the exports of `@vanr/ui`. An area owns its folder
 * and its messages, and nothing else. An area never adds a top-level route, opens a socket, handles
 * a 401 or calls `fetch`.
 *
 * How an area plugs in
 * --------------------
 * 1. Folder. `src/areas/<area>/`, named after the area in AREAS below. Its entry is `module.ts`:
 *
 *      export const screens: AreaScreens<"wiki"> = { wiki: WikiIndex, wikiPage: WikiPage };
 *
 *    A route the area has not built yet is simply left out: the shell renders the plain "not part
 *    of this build" screen in its place. `areas/agents` is the worked example to copy.
 *
 * 2. Routes. Every path of the web is already in ROUTES, with its parameters and the area that
 *    fills it. Fill the ids reserved for your area. Link and navigate by id, never by string:
 *
 *      <AppLink route="wikiPage" params={{ workspaceId, pageId }}>…</AppLink>
 *      const go = useGo(); go("wikiPage", { workspaceId, pageId });
 *      const { workspaceId, pageId } = useRouteParams("wikiPage");
 *
 *    Query-string state is read with `useSearch(schema)`, which validates it with a zod schema.
 *    A path that is missing here is a change to this table, made by the shell.
 *
 * 3. Loading. The router imports `areas/<area>/module.ts` on the first visit to any of the area's
 *    routes, so each area is its own chunk. Split further inside the area with `lazy()` if needed.
 *
 * 4. Data. Call the server through `useApi()`, `useApiQuery(method, params)` and
 *    `useApiMutation(method)` from `src/api`. Method names and parameters follow the server's
 *    operation ids. Results are validated before they reach a screen, and every failure is an
 *    `ApiError` with `status`, `code`, `message` and `retryable`. Cache keys come from
 *    `queryKey(method, params)` and from nowhere else; invalidate with `useInvalidate()`.
 *    A method the area needs is added to `src/api/methods.ts` with its schema.
 *
 * 5. Session. Nothing to do. A 401 on any call, or the real-time connection closing with 4401,
 *    sends the person to sign in and brings them back to the same address. A form that should
 *    survive that keeps its text in `useDraft(id)`; drafts are dropped when someone else signs in.
 *    Never keep a password or a secret in a draft.
 *
 * 6. Real time. The shell holds the one connection of the open workspace. Listen with
 *    `useRealtimeEvent("message.posted", handler)`, refetch with
 *    `useInvalidateOn(["run.completed"], "listAgents", { workspaceId })`, follow a channel with
 *    `useChannelSubscription(channelId)`. After a reconnect every query is refetched: an event is
 *    only a signal, never the source of truth.
 *
 * 7. Messages. One namespace per area, named after the area: `src/messages/<area>/en.ts` and
 *    `pt-BR.ts`, loaded on demand by `useMessages("<area>")`. No interface text is written in a
 *    component. The parity test fails when a key or a placeholder exists in one language only.
 *    Server errors are shown with `useErrorMessage()`, which looks the `code` up in `errors`.
 *
 * 8. States. A screen that loads data shows `<ScreenLoading />` while pending, `<ScreenError />`
 *    (what failed and a retry) on failure, and an `<EmptyState />` that says what belongs there
 *    and how to add it. A render error is caught by the shell's route boundary.
 *
 * 9. Components. Anything two areas would want lives in `@vanr/ui`, added by the shell.
 *
 * 10. Tests. `*.test.tsx` next to the screen, run with `bun test` from `apps/web`. Render with
 *    `renderApp()` from `test/app.tsx` against the fake server in `dev/fake-server.ts`, and assert
 *    what a person sees and does (roles and labels), never classes or structure. Assertions on
 *    Portuguese text go in a `*.pt-BR.test.tsx` file.
 */

/** The areas of the app. `account` and `shell` belong to the shell; each of the others to one team. */
export const AREAS = [
  "account",
  "shell",
  "chat",
  "agents",
  "wiki",
  "files",
  "work",
  "debates",
  "control",
] as const;
export type Area = (typeof AREAS)[number];

/**
 * Who may open a route.
 * - public: anyone, signed in or not.
 * - guest: the sign-in screens; someone already signed in is sent onward.
 * - signedIn: needs a session, but no workspace.
 * - member: needs a session and membership of the workspace in the path; rendered inside the frame.
 */
export type Access = "public" | "guest" | "signedIn" | "member";

type RouteSpec = { readonly path: string; readonly area: Area; readonly access: Access };

/** The path every workspace route starts with. */
export const WORKSPACE_PREFIX = "/workspace/$workspaceId";

const account = <P extends string>(path: P, access: Exclude<Access, "member">) =>
  ({ path, area: "account", access }) as const;
const inWorkspace = <P extends string, A extends Area>(path: P, area: A) =>
  ({
    path: `${WORKSPACE_PREFIX}${path}` as `${typeof WORKSPACE_PREFIX}${P}`,
    area,
    access: "member",
  }) as const;

export const ROUTES = {
  // Account. `/invite/$token`, `/connect` and `/?confirm=` are addresses the server writes in emails.
  root: account("/", "public"),
  login: account("/login", "guest"),
  signup: account("/signup", "guest"),
  forgotPassword: account("/forgot-password", "guest"),
  resetPassword: account("/reset-password", "public"),
  verifyEmail: account("/verify-email", "public"),
  invitation: account("/invite/$token", "public"),
  onboarding: account("/onboarding", "signedIn"),
  runnerPairing: { path: "/connect", area: "agents", access: "signedIn" },

  // Shell, inside a workspace.
  home: inWorkspace("", "shell"),
  notifications: inWorkspace("/notifications", "shell"),
  notificationSettings: inWorkspace("/notifications/settings", "shell"),
  search: inWorkspace("/search", "files"),
  settings: inWorkspace("/settings/$section", "shell"),

  // Chat.
  channel: inWorkspace("/channel/$channelId", "chat"),
  dmPerson: inWorkspace("/dm/person/$userId", "chat"),
  dmAgent: inWorkspace("/dm/agent/$agentId", "chat"),
  threads: inWorkspace("/threads", "chat"),
  thread: inWorkspace("/threads/$threadId", "chat"),

  // Agents and runners.
  agents: inWorkspace("/agents", "agents"),
  agentNew: inWorkspace("/agents/new", "agents"),
  agent: inWorkspace("/agents/$agentId", "agents"),
  agentMemory: inWorkspace("/agents/$agentId/memory", "agents"),
  skills: inWorkspace("/skills", "agents"),
  runner: inWorkspace("/settings/runners/$runnerId", "agents"),

  // Wiki.
  wiki: inWorkspace("/wiki", "wiki"),
  wikiPage: inWorkspace("/wiki/$pageId", "wiki"),

  // Files and bases.
  files: inWorkspace("/files", "files"),
  bases: inWorkspace("/bases", "files"),
  base: inWorkspace("/bases/$baseId", "files"),
  baseRow: inWorkspace("/bases/$baseId/rows/$rowId", "files"),

  // Work.
  assignments: inWorkspace("/assignments", "work"),
  assignment: inWorkspace("/assignments/$assignmentId", "work"),
  issues: inWorkspace("/issues", "work"),
  issue: inWorkspace("/issues/$issueSeq", "work"),
  routines: inWorkspace("/routines", "work"),
  calendar: inWorkspace("/calendar", "work"),

  // Debates.
  debates: inWorkspace("/debates", "debates"),
  debate: inWorkspace("/debates/$debateId", "debates"),

  // Control.
  approvals: inWorkspace("/approvals", "control"),
  proposals: inWorkspace("/proposals", "control"),
} as const satisfies Record<string, RouteSpec>;

export type RouteId = keyof typeof ROUTES;
export const ROUTE_IDS = Object.keys(ROUTES) as RouteId[];

/** The route ids an area fills. */
export type RouteIdOf<A extends Area> = {
  [Id in RouteId]: (typeof ROUTES)[Id]["area"] extends A ? Id : never;
}[RouteId];

type ParamNames<Path extends string> = Path extends `${string}$${infer Rest}`
  ? Rest extends `${infer Name}/${infer Tail}`
    ? Name | ParamNames<`/${Tail}`>
    : Rest
  : never;

/** The path parameters of a route, by name. A route without parameters takes an empty object. */
export type ParamsOf<Id extends RouteId> = { [Name in ParamNames<(typeof ROUTES)[Id]["path"]>]: string };

/**
 * The sections of `/workspace/$workspaceId/settings/$section` and the area that fills each one.
 * `general` is where `/settings` lands.
 */
export const SETTINGS_SECTIONS = {
  general: "shell",
  profile: "shell",
  members: "shell",
  storage: "shell",
  runners: "agents",
  connectors: "control",
  "data-sources": "control",
  access: "control",
  usage: "control",
} as const satisfies Record<string, Area>;
export type SettingsSection = keyof typeof SETTINGS_SECTIONS;

/** Old or shortened addresses and where they lead. Same parameters on both sides. */
export const REDIRECTS = [
  { from: `${WORKSPACE_PREFIX}/settings`, to: `${WORKSPACE_PREFIX}/settings/general` },
  { from: `${WORKSPACE_PREFIX}/members`, to: `${WORKSPACE_PREFIX}/settings/members` },
] as const;

const PARAM = /\$([A-Za-z][A-Za-z0-9]*)/g;

/** The parameter names of a path, in order. */
export function paramNames(path: string): string[] {
  return [...path.matchAll(PARAM)].map((match) => match[1] ?? "");
}

type Search = Record<string, string | number | boolean | undefined>;

/** Fills a path's parameters, each one encoded, and appends the query string. */
export function fillPath(path: string, params: Record<string, string>, search?: Search): string {
  const filled = path.replace(PARAM, (_, name: string) => {
    const value = params[name];
    if (value === undefined || value === "") throw new Error(`route parameter "${name}" is missing`);
    return encodeURIComponent(value);
  });
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(search ?? {})) {
    if (value !== undefined) query.set(key, String(value));
  }
  const text = query.toString();
  return `${filled === "" ? "/" : filled}${text === "" ? "" : `?${text}`}`;
}

/** The address of a route. */
export function href<Id extends RouteId>(id: Id, params: ParamsOf<Id>, search?: Search): string {
  return fillPath(ROUTES[id].path, params, search);
}
