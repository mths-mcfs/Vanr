import { expect, test } from "bun:test";
import { can, PERMISSIONS } from "./index.ts";
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

test("can exposes role-based permission checks through the public entry point", () => {
  expect(can("member", "read")).toBe(true);
  expect(can("member", "create_channels")).toBe(true);
  expect(can("member", "configure")).toBe(false);
  expect(can("admin", "configure")).toBe(true);
  expect(can("admin", "manage_owners")).toBe(false);
  expect(can("owner", "manage_owners")).toBe(true);
});
