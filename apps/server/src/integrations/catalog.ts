// Catalog of connectors and scopes. Every catalog connector is a remote MCP server of the
// vendor itself: the connection keeps the address and the credential, and the tools come from the server.
// Built-in scopes: a read/write pair per area of the agent's own tools.
import type { ConnectorCatalog, ConnectorDef } from "@vanr/contract";

export interface CatalogEntry {
  id: string;
  label: string;
  description: string;
  category: string;
  /** Address of the vendor's remote MCP. */
  serverUrl: string;
  /** How it authenticates: OAuth with dynamic client registration, API key or both. */
  auth: readonly ("oauth" | "api_key")[];
  accentColor: string;
}

// Public addresses of each vendor's MCP servers (Oct 2026), written down without calling them
// (there was no network where this list was made).
export const CATALOG: readonly CatalogEntry[] = [
  {
    id: "github",
    label: "GitHub",
    description: "Issues, pull requests and code",
    category: "dev",
    serverUrl: "https://api.githubcopilot.com/mcp/",
    auth: ["api_key"],
    accentColor: "#24292f",
  },
  {
    id: "linear",
    label: "Linear",
    description: "Issues, projects and cycles",
    category: "work",
    serverUrl: "https://mcp.linear.app/mcp",
    auth: ["oauth", "api_key"],
    accentColor: "#5e6ad2",
  },
  {
    id: "notion",
    label: "Notion",
    description: "Pages and databases",
    category: "docs",
    serverUrl: "https://mcp.notion.com/mcp",
    auth: ["oauth"],
    accentColor: "#191919",
  },
  {
    id: "sentry",
    label: "Sentry",
    description: "Errors and performance issues",
    category: "dev",
    serverUrl: "https://mcp.sentry.dev/mcp",
    auth: ["oauth"],
    accentColor: "#362d59",
  },
  {
    id: "stripe",
    label: "Stripe",
    description: "Customers, payments and invoices",
    category: "finance",
    serverUrl: "https://mcp.stripe.com",
    auth: ["oauth", "api_key"],
    accentColor: "#635bff",
  },
];

export const catalogEntry = (id: string) => CATALOG.find((c) => c.id === id) ?? null;

/** Built-in area → tools per level. The ones not listed here always apply (conversation). */
export const BUILTIN_AREAS = {
  context: {
    read: ["search"],
    write: ["remember", "edit_memory", "forget", "memory", "propose_workspace_memory_change"],
  },
  drive: {
    read: ["list_drive_files", "read_drive_file"],
    write: ["create_drive_file", "update_drive_file", "share_drive_file"],
  },
  issues: { read: ["list_issues"], write: ["create_issue", "update_issue", "comment_issue"] },
  calendar: { read: ["list_events", "find_available_time"], write: ["propose_calendar_event"] },
  wiki: {
    read: ["open_wiki_page"],
    write: ["add_wiki_page", "update_wiki_page", "link_to_wiki", "propose_wiki_edit"],
  },
  skills: { read: ["use_skill", "open_skill_file"], write: [] },
  schedule: {
    read: ["list_reminders", "list_routines"],
    write: ["schedule_reminder", "delete_reminder", "schedule_routine", "update_routine"],
  },
  debate: { read: ["read_debate"], write: ["open_debate", "post_in_debate"] },
  bases: { read: ["list_bases", "read_base_schema", "query_base"], write: ["upsert_base_rows"] },
} as const satisfies Record<string, { read: readonly string[]; write: readonly string[] }>;

export type BuiltinArea = keyof typeof BUILTIN_AREAS;

const AREA_LABELS: Record<BuiltinArea, string> = {
  context: "Memory and context",
  drive: "Drive",
  issues: "Tasks",
  calendar: "Calendar",
  wiki: "Wiki",
  skills: "Skills",
  schedule: "Reminders and routines",
  debate: "Debate",
  bases: "Databases",
};

export const BUILTIN_SCOPES: { id: string; label: string; access: "read" | "write" }[] = Object.entries(
  BUILTIN_AREAS,
).flatMap(([area, levels]) => [
  { id: `${area}:read`, label: `${AREA_LABELS[area as BuiltinArea]}: read`, access: "read" as const },
  ...(levels.write.length
    ? [
        {
          id: `${area}:write`,
          label: `${AREA_LABELS[area as BuiltinArea]}: change`,
          access: "write" as const,
        },
      ]
    : []),
]);

/** Built-in scope that allows the tool; null = conversation tool, always allowed. */
export function builtinScopeOf(tool: string): string | null {
  for (const [area, levels] of Object.entries(BUILTIN_AREAS)) {
    if ((levels.read as readonly string[]).includes(tool)) return `${area}:read`;
    if ((levels.write as readonly string[]).includes(tool)) return `${area}:write`;
  }
  return null;
}

/** Scopes of a connection: catalog `<id>:read|write`; own MCP `custom:<connection>:read|write`. */
export const connectionScopes = (row: { id: string; connector: string; custom: boolean }) => {
  const base = row.custom ? `custom:${row.id}` : row.connector;
  return { read: `${base}:read`, write: `${base}:write` };
};

/** An action that moves money, deletes or publishes: always asks for approval. */
export const SENSITIVE_TOOL =
  /(delete|remove|destroy|merge|deploy|publish|send|transfer|refund|pay|charge|cancel)/i;

export function catalogResponse(oauthReady: boolean): ConnectorCatalog {
  const connectors: ConnectorDef[] = CATALOG.map((c) => ({
    id: c.id,
    label: c.label,
    description: c.description,
    category: c.category,
    available: true,
    kind: "hosted_mcp",
    auth: c.auth.includes("oauth") ? "oauth" : "api_key",
    authMethods: [...c.auth],
    oauthReady: oauthReady && c.auth.includes("oauth"),
    askServerUrl: false,
    serverUrl: c.serverUrl,
    iconUrl: null,
    accentColor: c.accentColor,
    scopes: [
      { id: `${c.id}:read`, label: "Read", access: "read" },
      { id: `${c.id}:write`, label: "Change", access: "write" },
    ],
    tools: [],
  }));
  return { connectors, nativeScopes: BUILTIN_SCOPES };
}
