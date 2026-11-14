// Who may do what, by workspace role. Clients use it to hide controls; the server decides.
import type { Role } from "./workspaces.ts";

/** Roles from the lowest to the highest; each role holds every permission of the roles below it. */
const LADDER = ["member", "admin", "owner"] as const satisfies readonly Role[];

const from = (lowest: Role): readonly Role[] => LADDER.slice(LADDER.indexOf(lowest));

export const PERMISSIONS = {
  configure: from("admin"),
  create_channels: from("member"),
  manage_agents: from("admin"),
  manage_credentials: from("admin"),
  manage_members: from("admin"),
  manage_owners: from("owner"),
  post: from("member"),
  read: from("member"),
  view_usage: from("admin"),
} as const satisfies Record<string, readonly Role[]>;

export const can = (role: Role, permission: keyof typeof PERMISSIONS): boolean =>
  PERMISSIONS[permission].includes(role);
