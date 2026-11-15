import { describe, expect, test } from "bun:test";
import {
  AREAS,
  fillPath,
  href,
  paramNames,
  REDIRECTS,
  ROUTE_IDS,
  ROUTES,
  SETTINGS_SECTIONS,
  WORKSPACE_PREFIX,
} from "./routes.ts";

describe("the route table", () => {
  test("every workspace route starts with the one workspace prefix", () => {
    for (const id of ROUTE_IDS) {
      const { path, access } = ROUTES[id];
      expect(path.startsWith(WORKSPACE_PREFIX), `${id}: ${path}`).toBe(access === "member");
    }
  });

  test("no path uses another spelling of the workspace segment", () => {
    for (const id of ROUTE_IDS) {
      expect(ROUTES[id].path, id).not.toMatch(/^\/(w|ws|workspaces)(\/|$)/);
    }
  });

  test("no two routes share a path", () => {
    const paths = ROUTE_IDS.map((id) => ROUTES[id].path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  test("no two routes differ only by the name of a parameter", () => {
    const shapes = ROUTE_IDS.map((id) => ROUTES[id].path.replace(/\$[A-Za-z0-9]+/g, "$"));
    expect(new Set(shapes).size).toBe(shapes.length);
  });

  test("parameters are named after their resource, never generically", () => {
    for (const id of ROUTE_IDS) {
      for (const name of paramNames(ROUTES[id].path)) {
        expect(name, `${id}: $${name}`).not.toMatch(/^(id|slug|key|param)$/i);
      }
    }
  });

  test("every area but the frame's own has at least one route", () => {
    const used = new Set(ROUTE_IDS.map((id) => ROUTES[id].area));
    expect([...AREAS].filter((area) => !used.has(area))).toEqual([]);
  });

  test("the addresses the server writes in emails exist", () => {
    expect(ROUTES.invitation.path).toBe("/invite/$token");
    expect(ROUTES.runnerPairing.path).toBe("/connect");
    expect(ROUTES.root.path).toBe("/");
    expect(href("settings", { workspaceId: "workspace_1", section: "members" })).toBe(
      "/workspace/workspace_1/settings/members",
    );
  });

  test("redirects lead to paths that exist, with the same parameters", () => {
    const shape = (path: string) => path.replace(/\$[A-Za-z0-9]+/g, "$");
    const shapes = new Set(ROUTE_IDS.map((id) => shape(ROUTES[id].path)));
    for (const { from, to } of REDIRECTS) {
      const target = shape(to).replace(/\/(general|members)$/, "/$");
      expect(shapes.has(target), to).toBe(true);
      expect(paramNames(from)).toEqual(paramNames(to));
      expect(shapes.has(shape(from)), `${from} is also a route`).toBe(false);
    }
  });

  test("every settings section belongs to an area", () => {
    for (const area of Object.values(SETTINGS_SECTIONS)) expect(AREAS).toContain(area);
    expect(Object.keys(SETTINGS_SECTIONS)).toContain("general");
  });
});

describe("href", () => {
  test("fills and encodes the parameters", () => {
    expect(href("channel", { workspaceId: "workspace_1", channelId: "ch a/b" })).toBe(
      "/workspace/workspace_1/channel/ch%20a%2Fb",
    );
  });

  test("the workspace home has no trailing slash", () => {
    expect(href("home", { workspaceId: "workspace_1" })).toBe("/workspace/workspace_1");
  });

  test("appends the query string, skipping undefined values", () => {
    expect(href("login", {}, { redirect: "/onboarding", reason: undefined })).toBe(
      "/login?redirect=%2Fonboarding",
    );
  });

  test("a missing parameter is an error, not a broken address", () => {
    expect(() => fillPath("/workspace/$workspaceId", {})).toThrow('route parameter "workspaceId" is missing');
    expect(() => fillPath("/workspace/$workspaceId", { workspaceId: "" })).toThrow();
  });
});
