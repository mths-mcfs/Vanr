import { describe, expect, test } from "bun:test";
import type { PlanItemStatus } from "@vanr/contract";
import { runs } from "./db/schema/agents";
import { assignments, type PlanItemStatusRow } from "./db/schema/assignments";
import { debates } from "./db/schema/content";
import { runnerJobs } from "./db/schema/runners";
import { routineExecutions } from "./db/schema/work";
import {
  activitiesFromSteps,
  assignmentWorkState,
  debateWorkState,
  jobWorkState,
  planItemWorkState,
  routineRunWorkState,
  runWorkState,
  WORK_STATE_VISUAL,
  WORK_STATES,
} from "./work-state";

describe("work states", () => {
  test("every status stored in the database has a state (the type's list is the schema's)", () => {
    for (const s of runs.status.enumValues) expect(WORK_STATES).toContain(runWorkState(s));
    for (const s of assignments.status.enumValues)
      expect(WORK_STATES).toContain(assignmentWorkState(s, { waitingOnPerson: false }));
    // The plan is jsonb: the list comes from the row type, and the type here has to be the same.
    const plan: readonly PlanItemStatusRow[] = ["todo", "doing", "blocked_on_you", "done", "dropped"];
    const same: PlanItemStatusRow extends PlanItemStatus
      ? PlanItemStatus extends PlanItemStatusRow
        ? true
        : false
      : false = true;
    expect(same).toBe(true);
    for (const s of plan) expect(WORK_STATES).toContain(planItemWorkState(s));
    for (const s of runnerJobs.status.enumValues) expect(WORK_STATES).toContain(jobWorkState(s));
    for (const s of routineExecutions.status.enumValues)
      expect(WORK_STATES).toContain(routineRunWorkState(s));
    for (const s of debates.status.enumValues)
      expect(WORK_STATES).toContain(debateWorkState(s, { waitingPerson: false }));
  });

  test("color by role: blue agent, amber waiting on you, green done, red failed", () => {
    expect(WORK_STATE_VISUAL.running.tone).toBe("agent");
    expect(WORK_STATE_VISUAL.blocked_on_you.tone).toBe("waiting");
    expect(WORK_STATE_VISUAL.done.tone).toBe("done");
    expect(WORK_STATE_VISUAL.failed.tone).toBe("danger");
    expect(Object.keys(WORK_STATE_VISUAL).sort()).toEqual([...WORK_STATES].sort());
  });

  test("an assignment waiting on a decision is blocked on you; paused is stopped; a skipped routine is not", () => {
    expect(assignmentWorkState("active", { waitingOnPerson: true })).toBe("blocked_on_you");
    expect(assignmentWorkState("wrapping_up", { waitingOnPerson: false })).toBe("blocked_on_you");
    expect(assignmentWorkState("paused", { waitingOnPerson: false })).toBe("stopped");
    expect(assignmentWorkState("active", { waitingOnPerson: false, stale: true })).toBe("stopped");
    expect(routineRunWorkState("skipped")).toBe("stopped");
    expect(runWorkState("paused_for_approval")).toBe("blocked_on_you");
  });
});

describe("activities from the steps", () => {
  const at = "2026-10-22T10:00:00Z";
  test("speech, tool with result, question and final answer", () => {
    const acts = activitiesFromSteps("r1", [
      { seq: 1, kind: "text", at, data: { text: "vou ver" } },
      { seq: 2, kind: "tool_call", at, data: { name: "read_wiki_page", toolUseId: "t1" } },
      { seq: 3, kind: "tool_result", at, data: { toolUseId: "t1", isError: false } },
      { seq: 4, kind: "tool_call", at, data: { name: "ask_user", toolUseId: "t2" } },
      { seq: 5, kind: "tool_result", at, data: { toolUseId: "t2" } },
      { seq: 6, kind: "text", at, data: { text: "pronto" } },
    ]);
    expect(acts.map((a) => a.kind)).toEqual(["thought", "action", "elicitation", "response"]);
    expect(acts[1]).toMatchObject({ tool: "read_wiki_page", ok: true });
  });

  test("a failed run ends in error and the last speech does not become the answer", () => {
    const acts = activitiesFromSteps(
      "r1",
      [
        { seq: 1, kind: "text", at, data: { text: "tentando" } },
        { seq: 2, kind: "tool_call", at, data: { name: "browser_open", toolUseId: "t1" } },
        { seq: 3, kind: "tool_result", at, data: { toolUseId: "t1", isError: true } },
      ],
      true,
    );
    expect(acts.map((a) => a.kind)).toEqual(["thought", "action", "error"]);
    expect(acts[1]?.ok).toBe(false);
  });
});
