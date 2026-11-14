// Workspace roles as a runtime list, for validating input (`z.enum(ROLES)`). The permission table itself
// (`PERMISSIONS`, `can`) and the `Role` type live in @vanr/contract, shared by the server and the web app.
import type { Role } from "@vanr/contract";

export const ROLES = ["owner", "admin", "member"] as const satisfies readonly Role[];
