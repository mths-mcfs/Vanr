import { describe, expect, test } from "bun:test";
import {
  ALL_CONNECTIONS,
  actionCredential,
  type ChannelRule,
  credentialsFor,
  effectiveLevel,
  serviceKey,
} from "./action-credential";

describe("action credential: level by workspace and channel", () => {
  const rules: ChannelRule[] = [
    { channelId: "ch_fin", connectionId: "con_stripe", level: "approval" },
    { channelId: "ch_fin", connectionId: ALL_CONNECTIONS, level: "read" },
    { channelId: "ch_rh", connectionId: "con_linear", level: "off" },
  ];

  test("with no rule in the channel, the workspace level applies", () => {
    expect(effectiveLevel("write", rules, "ch_geral", ["con_linear"])).toEqual({
      level: "write",
      ask: false,
    });
    expect(effectiveLevel("read", rules, "ch_geral", ["con_linear"])).toEqual({ level: "read", ask: false });
  });

  test("a channel only restricts: the strictest of the connection rule and the * rule wins", () => {
    // `*` = read beats the connection's `approval`.
    expect(effectiveLevel("write", rules, "ch_fin", ["con_stripe"])).toEqual({ level: "read", ask: false });
    expect(effectiveLevel("write", rules, "ch_rh", ["con_linear"])).toBeNull();
    expect(effectiveLevel("write", rules, "ch_rh", ["con_stripe"])).toEqual({ level: "write", ask: false });
  });

  test("a channel never widens what the workspace did not grant", () => {
    const open: ChannelRule[] = [{ channelId: "c", connectionId: "x", level: "approval" }];
    expect(effectiveLevel(null, open, "c", ["x"])).toBeNull();
    expect(effectiveLevel("read", open, "c", ["x"])).toEqual({ level: "read", ask: true });
    expect(effectiveLevel("write", open, "c", ["x"])).toEqual({ level: "write", ask: true });
  });

  test("a rule set on one account of a service applies to the other account of the same service", () => {
    const rules: ChannelRule[] = [{ channelId: "c", connectionId: "con_workspace_linear", level: "off" }];
    // The agent got its own Linear account: the rule on the workspace account still applies to it.
    expect(effectiveLevel("write", rules, "c", ["con_agente_linear", "con_workspace_linear"])).toBeNull();
    expect(effectiveLevel("write", rules, "c", ["con_agente_linear"])).toEqual({
      level: "write",
      ask: false,
    });
  });

  test("fuzz: the effective level never exceeds the workspace's or the channel's", () => {
    const levels = ["off", "read", "approval"] as const;
    let seed = 7;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    for (let i = 0; i < 500; i++) {
      const workspace = (["read", "write", null] as const)[rnd(3)] ?? null;
      const rs: ChannelRule[] = Array.from({ length: rnd(4) }, () => ({
        channelId: ["a", "b"][rnd(2)] ?? "a",
        connectionId: ["x", "y", ALL_CONNECTIONS][rnd(3)] ?? "x",
        level: levels[rnd(3)] ?? "off",
      }));
      const out = effectiveLevel(workspace, rs, "a", ["x"]);
      const applicable = rs.filter(
        (r) => r.channelId === "a" && (r.connectionId === "x" || r.connectionId === "*"),
      );
      if (!workspace || applicable.some((r) => r.level === "off")) expect(out).toBeNull();
      else {
        expect(out).not.toBeNull();
        if (workspace === "read" || applicable.some((r) => r.level === "read"))
          expect(out?.level).toBe("read");
        if (applicable.some((r) => r.level === "approval") && !applicable.some((r) => r.level === "read"))
          expect(out?.ask).toBe(true);
      }
    }
  });
});

describe("action credential: which credential applies to the agent", () => {
  const cands = [
    { id: "workspace_linear", key: "linear", agentId: null },
    { id: "workspace_notion", key: "notion", agentId: null },
    { id: "lia_linear", key: "linear", agentId: "ag_lia" },
    { id: "rui_notion", key: "notion", agentId: "ag_rui" },
  ];

  test("the agent's own account replaces the workspace's for the same service", () => {
    expect(credentialsFor(cands, "ag_lia").map((c) => c.id)).toEqual(["workspace_notion", "lia_linear"]);
  });

  test("another agent's own account never shows up", () => {
    expect(credentialsFor(cands, "ag_rui").map((c) => c.id)).toEqual(["workspace_linear", "rui_notion"]);
    expect(credentialsFor(cands, "ag_novo").map((c) => c.id)).toEqual([
      "workspace_linear",
      "workspace_notion",
    ]);
  });

  test("the key of a custom MCP is its address, without trailing slash and case-insensitive", () => {
    expect(serviceKey({ connector: "custom", custom: true, serverUrl: "https://X.test/mcp/" })).toBe(
      serviceKey({ connector: "custom", custom: true, serverUrl: "https://x.test/mcp" }),
    );
    expect(serviceKey({ connector: "linear", custom: false, serverUrl: "https://mcp.linear.app" })).toBe(
      "linear",
    );
  });
});

describe("action credential: the requester's credential never gets in", () => {
  test("the requester's connection, mailbox or database is rejected", () => {
    for (const kind of ["connection", "mailbox", "database"] as const)
      expect(() =>
        actionCredential({
          agentId: "ag",
          requesterId: "u1",
          credential: { kind, id: "x", owner: "requester", label: "Ana" },
        }),
      ).toThrow(/requester/);
  });

  test("the person's own environment plan passes; the requester is kept only for audit", () => {
    expect(
      actionCredential({
        agentId: "ag",
        requesterId: "u1",
        credential: { kind: "environment_plan", id: "m1", owner: "requester", label: "Mac da Ana" },
      }),
    ).toEqual({
      actorAgentId: "ag",
      actingFor: "u1",
      credential: { kind: "environment_plan", id: "m1", owner: "requester", label: "Mac da Ana" },
    });
    expect(
      actionCredential({
        agentId: "ag",
        requesterId: null,
        credential: { kind: "connection", id: "c", owner: "agent", label: "Linear da Lia" },
      }).actingFor,
    ).toBeNull();
  });
});
