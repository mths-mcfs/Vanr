// The live runs of a conversation from their events, and against the server's list of active runs.
import { describe, expect, test } from "bun:test";
import type { ActiveRun } from "@vanr/contract";
import {
  applyRunEvent,
  isQuiet,
  LANDING_MS,
  type LiveRun,
  QUIET_AFTER_MS,
  reconcile,
  showing,
} from "./live.ts";

const base = { runId: "run_1", agentId: "agt_scout", threadId: null };
const play = (events: Parameters<typeof applyRunEvent>[2][], start: readonly LiveRun[] = [], now = 1000) =>
  events.reduce<readonly LiveRun[]>((runs, event) => applyRunEvent(runs, base, event, now), start);

const row = (fields: Partial<ActiveRun> = {}): ActiveRun => ({
  agentId: "agt_scout",
  browser: false,
  channelId: "ch_general",
  initiatedBy: "usr_ana",
  lastPingAt: "2026-11-14T12:00:00.000Z",
  runId: "run_1",
  sourceMessageId: null,
  startedAt: "2026-11-14T12:00:00.000Z",
  status: "running",
  threadId: null,
  ...fields,
});

describe("a live run", () => {
  test("text streams in order; a repeated or older delta is dropped", () => {
    const [run] = play([
      { type: "run.text_delta", seq: 0, text: "a" },
      { type: "run.text_delta", seq: 1, text: "b" },
      { type: "run.text_delta", seq: 1, text: "b" },
      { type: "run.text_delta", seq: 0, text: "a" },
    ]);
    expect(run?.text).toBe("ab");
  });

  test("a note takes the turn's text; a tool call, its result and its close land on one step", () => {
    const [run] = play([
      { type: "run.text_delta", seq: 0, text: "Looking" },
      { type: "run.commentary", text: "Looking" },
      { type: "run.tool_call", toolUseId: "tu_1", tool: "search", detail: "kiln" },
      { type: "run.tool_call", toolUseId: "tu_1", tool: "search", detail: "kiln" },
      { type: "run.tool_result", toolUseId: "tu_1", text: "boom", isError: true },
      { type: "run.tool_call", toolUseId: "tu_1", tool: null },
    ]);
    expect(run?.text).toBe("");
    expect(run?.steps).toEqual([
      { kind: "note", key: "note-0", text: "Looking" },
      {
        kind: "tool",
        key: "tu_1",
        tool: "search",
        detail: "kiln",
        input: null,
        output: "boom",
        isError: true,
        running: false,
      },
    ]);
  });

  test("a stop removes it; an answer keeps it until the answer shows or a while passes", () => {
    expect(play([{ type: "run.status_changed", status: "running" }, { type: "run.stopped" }])).toEqual([]);
    const ended = play([
      { type: "run.status_changed", status: "running" },
      { type: "run.completed", messageId: "msg_9" },
    ]);
    expect(ended[0]?.answerId).toBe("msg_9");
    // Late events of an ended run change nothing.
    expect(play([{ type: "run.text_delta", seq: 5, text: "late" }], ended)).toEqual(ended);
    expect(showing(ended, new Set(), 1000)).toHaveLength(1);
    expect(showing(ended, new Set(["msg_9"]), 1000)).toHaveLength(0);
    expect(showing(ended, new Set(), 1000 + LANDING_MS)).toHaveLength(0);
  });

  test("an event without a run id changes nothing", () => {
    expect(applyRunEvent([], { agentId: "agt_scout" }, { type: "run.text_delta", text: "x" }, 0)).toEqual([]);
  });

  test("quiet after a few minutes without an event", () => {
    const [run] = play([{ type: "run.status_changed", status: "running" }]);
    if (run === undefined) throw new Error("no run");
    expect(isQuiet(run, 1000 + QUIET_AFTER_MS - 1)).toBe(false);
    expect(isQuiet(run, 1000 + QUIET_AFTER_MS)).toBe(true);
  });
});

describe("the server's list of active runs", () => {
  test("adds the runs it lists, and drops the ones it lacks unless they are newer than it", () => {
    const heard = play([{ type: "run.text_delta", seq: 0, text: "hi" }], [], 5000);
    expect(reconcile(heard, [], 4000)).toHaveLength(1);
    expect(reconcile(heard, [], 6000)).toEqual([]);
    const listed = reconcile([], [row({ status: "paused_for_approval" })], 0);
    expect(listed[0]).toMatchObject({
      runId: "run_1",
      status: "paused_for_approval",
      initiatedBy: "usr_ana",
    });
    // A run already streaming keeps its text when the list names it.
    expect(reconcile(heard, [row()], 6000)[0]?.text).toBe("hi");
  });

  test("a run that ended is never brought back by a list read before the end", () => {
    const stopped = play([{ type: "run.status_changed", status: "running" }, { type: "run.stopped" }]);
    expect(reconcile(stopped, [row()], 0, new Set(["run_1"]))).toEqual([]);
  });

  test("the list says where a run is: a run first heard without its thread moves to it", () => {
    const heard = play([{ type: "run.text_delta", seq: 0, text: "hi" }]);
    expect(reconcile(heard, [row({ threadId: "msg_root" })], 0)[0]?.threadId).toBe("msg_root");
  });
});
