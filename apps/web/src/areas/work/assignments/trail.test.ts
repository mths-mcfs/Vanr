import { describe, expect, test } from "bun:test";
import type { AssignmentEvent } from "@vanr/contract";
import { askOlder, EMPTY_TRAIL, type TrailState, withLatest, withOlder } from "./trail.ts";

const SIZE = 50;
const event = (seq: number): AssignmentEvent => ({
  actor: { type: "agent", id: "agt_scout" },
  at: "2026-11-14T10:00:00.000Z",
  data: {},
  itemId: null,
  kind: "item_done",
  seq,
});
const range = (from: number, count: number) => Array.from({ length: count }, (_, at) => from + at);

/** One assignment's events as the server pages them: newest first, `before` a seq, up to SIZE. */
function source(seqs: number[]) {
  const all = [...seqs];
  const page = (before?: number) =>
    all
      .filter((seq) => before === undefined || seq < before)
      .sort((a, b) => b - a)
      .slice(0, SIZE)
      .map(event);
  return { all, page, add: (more: number[]) => all.push(...more) };
}

/** The panel over a source: it reads the latest page, and the older one while one is asked. */
function panel(server: ReturnType<typeof source>) {
  let state: TrailState = EMPTY_TRAIL;
  const refetch = () => {
    state = withLatest(state, server.page(), SIZE);
    const before = state.before;
    if (before !== undefined) state = withOlder(state, server.page(before), before, SIZE);
  };
  const older = () => {
    state = askOlder(state);
    const before = state.before;
    if (before !== undefined) state = withOlder(state, server.page(before), before, SIZE);
  };
  const drain = () => {
    let clicks = 0;
    while (!state.complete && clicks < 20) {
      older();
      clicks += 1;
    }
    return clicks;
  };
  const shown = () => state.events.map((each) => each.seq);
  refetch();
  return { refetch, older, drain, shown, state: () => state };
}

/** Every event, once, newest first, and nothing left to ask for. */
const whole = (view: ReturnType<typeof panel>, server: ReturnType<typeof source>) => {
  expect(view.shown()).toEqual([...server.all].sort((a, b) => b - a));
  expect(view.state().complete).toBe(true);
};

describe("the trail's pages", () => {
  for (const count of [0, 1, 50, 51, 101]) {
    test(`${count} events load whole, one page after another`, () => {
      const server = source(range(301, count));
      const view = panel(server);
      view.drain();
      whole(view, server);
    });
  }

  test("a short trail that grows past a page while open asks for nothing more", () => {
    const server = source(range(1, 30));
    const view = panel(server);
    expect(view.state().complete).toBe(true);
    server.add(range(31, 25));
    view.refetch();
    whole(view, server);
  });

  test("events that arrive while an older page is shown join it", () => {
    const server = source(range(1, 101));
    const view = panel(server);
    view.older();
    for (const seq of range(102, 3)) {
      server.add([seq]);
      view.refetch();
    }
    view.drain();
    whole(view, server);
  });

  for (const [start, jump, olderFirst] of [
    [55, 60, false],
    [55, 60, true],
    [120, 70, true],
  ] as const) {
    test(`${jump} events at once over ${start}${olderFirst ? " with an older page shown" : ""} leave no gap`, () => {
      const server = source(range(1, start));
      const view = panel(server);
      if (olderFirst) view.older();
      server.add(range(start + 1, jump));
      view.refetch();
      view.drain();
      whole(view, server);
    });
  }

  test("an older page asked before the trail started again belongs to none of it", () => {
    const server = source(range(1, 120));
    let state = withLatest(EMPTY_TRAIL, server.page(), SIZE);
    state = askOlder(state);
    const asked = state.before ?? 0;
    server.add(range(121, 70));
    state = withLatest(state, server.page(), SIZE);
    expect(state.before).toBeUndefined();
    expect(withOlder(state, server.page(asked), asked, SIZE)).toBe(state);
  });
});
