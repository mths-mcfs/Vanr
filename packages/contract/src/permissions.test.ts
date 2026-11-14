import { expect, test } from "bun:test";
import { PERMISSIONS } from "./permissions.ts";
import type { Role } from "./workspaces.ts";

test("each permission lists the roles that hold it, lowest first", () => {
  const everyone: Role[] = ["member", "admin", "owner"];
  const admins: Role[] = ["admin", "owner"];
  expect(PERMISSIONS).toEqual({
    configure: admins,
    create_channels: everyone,
    manage_agents: admins,
    manage_credentials: admins,
    manage_members: admins,
    manage_owners: ["owner"],
    post: everyone,
    read: everyone,
    view_usage: admins,
  });
});
