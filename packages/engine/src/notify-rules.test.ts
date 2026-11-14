import { describe, expect, test } from "bun:test";
import type { NotificationSettings } from "@vanr/contract";
import {
  classify,
  DEFAULT_SETTINGS,
  dueAt,
  notificationWorkState,
  requestOf,
  silenceUntil,
  wantsChannel,
} from "./notify-rules";

const s = (patch: Partial<NotificationSettings> = {}): NotificationSettings => ({
  ...DEFAULT_SETTINGS,
  ...patch,
});

describe("classify", () => {
  test("default: an open request, a DM and a mention need you; the rest is FYI", () => {
    expect(classify({ kind: "approval", waiting: true }, [])).toEqual({
      tab: "action_needed",
      critical: true,
      reason: "approval_requested",
      ruleId: null,
    });
    expect(classify({ kind: "dm", waiting: false }, []).tab).toBe("action_needed");
    expect(classify({ kind: "mention", waiting: false }, []).tab).toBe("action_needed");
    for (const kind of [
      "reaction",
      "thread_followup",
      "issue_progress",
      "routine_alert",
      "debate_synthesis",
    ] as const)
      expect(classify({ kind, waiting: false }, []).tab).toBe("fyi");
  });

  test("critical only with an open request and a critical reason (approval, question, failure)", () => {
    expect(classify({ kind: "question_for_you", waiting: true }, []).critical).toBe(true);
    expect(classify({ kind: "question_for_you", reason: "secret_prompt", waiting: true }, []).critical).toBe(
      false,
    );
    expect(classify({ kind: "approval", waiting: false }, []).critical).toBe(false);
    expect(classify({ kind: "debate_turn", waiting: true, priority: "critical" }, []).critical).toBe(true);
    expect(classify({ kind: "dm", waiting: false, priority: "critical" }, [])).toMatchObject({
      tab: "action_needed",
      critical: false,
    });
  });

  test("the first matching rule wins; an open request ignores rules; the requested priority applies without a rule", () => {
    const rules = [
      { id: "a", channelId: "c1", agentId: "g1", tab: "action_needed" as const },
      { id: "b", channelId: "c1", tab: "fyi" as const },
      { id: "c", kind: "reaction" as const, tab: "action_needed" as const },
    ];
    expect(classify({ kind: "mention", waiting: false, channelId: "c1", agentId: "g1" }, rules).ruleId).toBe(
      "a",
    );
    expect(
      classify({ kind: "mention", waiting: false, channelId: "c1", agentId: "g2" }, rules),
    ).toMatchObject({
      tab: "fyi",
      ruleId: "b",
    });
    expect(classify({ kind: "reaction", waiting: false }, rules)).toMatchObject({
      tab: "action_needed",
      ruleId: "c",
    });
    expect(classify({ kind: "approval", waiting: true, channelId: "c1" }, rules)).toMatchObject({
      tab: "action_needed",
      ruleId: null,
    });
    expect(classify({ kind: "issue_progress", waiting: false, priority: "action_needed" }, []).tab).toBe(
      "action_needed",
    );
    expect(classify({ kind: "mention", waiting: false, priority: "fyi" }, []).tab).toBe("fyi");
  });
});

describe("wantsChannel (conservative default)", () => {
  const needs = { tab: "action_needed" as const, waiting: false, kind: "mention" as const, channelId: "c1" };
  const open = { tab: "action_needed" as const, waiting: true, kind: "approval" as const, channelId: null };
  test("push on 'Action needed', email only on an open request, 'FYI' never goes out", () => {
    expect(wantsChannel("push", needs, s())).toBe(true);
    expect(wantsChannel("email", needs, s())).toBe(false);
    expect(wantsChannel("email", open, s())).toBe(true);
    expect(wantsChannel("push", { ...needs, tab: "fyi" }, s({ kinds: { mention: { push: true } } }))).toBe(
      false,
    );
  });
  test("master switch, kind and channel", () => {
    expect(wantsChannel("push", needs, s({ push: false }))).toBe(false);
    expect(wantsChannel("email", needs, s({ kinds: { mention: { email: true } } }))).toBe(true);
    expect(wantsChannel("email", needs, s({ email: false, kinds: { mention: { email: true } } }))).toBe(
      false,
    );
    expect(wantsChannel("push", needs, s({ channels: { c1: { push: false } } }))).toBe(false);
    // A muted channel beats a kind turned on.
    expect(
      wantsChannel(
        "push",
        needs,
        s({ channels: { c1: { push: false } }, kinds: { mention: { push: true } } }),
      ),
    ).toBe(false);
    expect(wantsChannel("email", needs, s({ channels: { c1: { email: true } } }))).toBe(true);
  });
});

describe("quiet", () => {
  const at = (iso: string) => new Date(iso);
  test("do not disturb until the set time; an expired one does not count", () => {
    expect(
      silenceUntil(s({ dndUntil: "2026-10-22T15:00:00Z" }), "UTC", at("2026-10-22T14:00:00Z"))?.toISOString(),
    ).toBe("2026-10-22T15:00:00.000Z");
    expect(
      silenceUntil(s({ dndUntil: "2026-10-22T13:00:00Z" }), "UTC", at("2026-10-22T14:00:00Z")),
    ).toBeNull();
  });

  test("a window that crosses midnight, in the person's time zone", () => {
    const quiet = s({ quietHours: { enabled: true, start: "22:00", end: "08:00" } });
    // 23:00 in São Paulo (UTC-3) = 02:00 UTC; it ends at 08:00 local = 11:00 UTC.
    expect(silenceUntil(quiet, "America/Sao_Paulo", at("2026-10-23T02:00:00Z"))?.toISOString()).toBe(
      "2026-10-23T11:00:00.000Z",
    );
    expect(silenceUntil(quiet, "America/Sao_Paulo", at("2026-10-22T15:00:00Z"))).toBeNull();
    // Off, or start = end: no quiet.
    expect(
      silenceUntil(
        s({ quietHours: { enabled: false, start: "00:00", end: "23:59" } }),
        "UTC",
        at("2026-10-22T12:00:00Z"),
      ),
    ).toBeNull();
    expect(
      silenceUntil(
        s({ quietHours: { enabled: true, start: "08:00", end: "08:00" } }),
        "UTC",
        at("2026-10-22T08:30:00Z"),
      ),
    ).toBeNull();
  });

  test("daylight saving switch (New York, 2026-11-01): the end is 08:00 on the new clock", () => {
    const quiet = s({ quietHours: { enabled: true, start: "22:00", end: "08:00" } });
    // 23:00 EDT on 10/31 = 03:00 UTC; at 02:00 the clock goes back to 01:00 (EST, UTC-5).
    expect(silenceUntil(quiet, "America/New_York", at("2026-11-01T03:00:00Z"))?.toISOString()).toBe(
      "2026-11-01T13:00:00.000Z",
    );
  });

  test("an invalid time zone falls back to UTC; do not disturb and window: the later end wins", () => {
    const quiet = s({
      quietHours: { enabled: true, start: "00:00", end: "06:00" },
      dndUntil: "2026-10-22T09:00:00Z",
    });
    expect(silenceUntil(quiet, "Lua/Base", at("2026-10-22T01:00:00Z"))?.toISOString()).toBe(
      "2026-10-22T09:00:00.000Z",
    );
  });

  test("dueAt: critical goes now; the rest waits for the quiet; email adds the delay", () => {
    const now = at("2026-10-22T14:00:00Z");
    const dnd = s({ dndUntil: "2026-10-22T16:00:00Z" });
    expect(dueAt("push", { critical: true }, dnd, "UTC", now).toISOString()).toBe("2026-10-22T14:00:00.000Z");
    expect(dueAt("push", { critical: false }, dnd, "UTC", now).toISOString()).toBe(
      "2026-10-22T16:00:00.000Z",
    );
    expect(dueAt("email", { critical: true }, s(), "UTC", now).toISOString()).toBe(
      "2026-10-22T14:15:00.000Z",
    );
  });
});

describe("the request behind the notice", () => {
  test("requestOf reads the groupKey of each source", () => {
    expect(requestOf("approval:a1")).toEqual({ type: "approval", id: "a1" });
    expect(requestOf("question:q1")).toEqual({ type: "question", id: "q1" });
    expect(requestOf("secret:s1")).toEqual({ type: "secret", id: "s1" });
    expect(requestOf("intervention:h1")).toEqual({ type: "intervention", id: "h1" });
    expect(requestOf("debate_turn:t1")).toEqual({ type: "debate_turn", debateId: "t1" });
    expect(requestOf("assignment:m1:approval:msg1")).toEqual({
      type: "assignment_command",
      assignmentId: "m1",
      messageId: "msg1",
    });
    expect(requestOf("assignment:m1:ask:msg2")).toEqual({ type: "assignment", assignmentId: "m1" });
    expect(requestOf("mention:x")).toBeNull();
    expect(requestOf("approval:")).toBeNull();
  });

  test("state shown in the inbox", () => {
    expect(notificationWorkState({ kind: "approval", waiting: true })).toBe("blocked_on_you");
    expect(notificationWorkState({ kind: "routine_alert", waiting: false })).toBe("failed");
    expect(notificationWorkState({ kind: "assignment_finished", waiting: false })).toBe("done");
    expect(notificationWorkState({ kind: "mention", waiting: false })).toBeNull();
  });
});
