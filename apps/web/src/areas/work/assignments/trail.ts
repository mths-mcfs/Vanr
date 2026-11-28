// The trail as the panel holds it: the events shown, newest first and one after another with no gap, the
// page asked for below them, and whether its first event is already there. The seq counts every
// assignment's events, so only the pages tell what is left: one that comes back short reached the start.
import type { AssignmentEvent } from "@vanr/contract";

export type TrailState = {
  events: AssignmentEvent[];
  /** The seq the older page was asked below, while one is shown or loading. */
  before: number | undefined;
  /** Whether the shown events reach the trail's first one. */
  complete: boolean;
};

export const EMPTY_TRAIL: TrailState = { events: [], before: undefined, complete: false };

const merge = (shown: AssignmentEvent[], got: AssignmentEvent[]) =>
  [...shown, ...got.filter((event) => !shown.some((each) => each.seq === event.seq))].sort(
    (a, b) => b.seq - a.seq,
  );

/**
 * A new latest page. Touching what is shown, it adds to it. A full page newer than all of it leaves a
 * gap (50 or more arrived between two reads, as after a reconnect): the trail starts again from that
 * page, so the older ones load in order below it instead of jumping the missing ones.
 */
export function withLatest(state: TrailState, page: AssignmentEvent[], size: number): TrailState {
  const full = page.length >= size;
  if (state.events.length === 0) return { events: merge([], page), before: undefined, complete: !full };
  const newest = state.events[0]?.seq ?? 0;
  const oldestOfPage = Math.min(...page.map((event) => event.seq));
  if (full && oldestOfPage > newest) return { events: merge([], page), before: undefined, complete: false };
  return { ...state, events: merge(state.events, page), complete: state.complete || !full };
}

/** Asks for the page below what is shown. */
export function askOlder(state: TrailState): TrailState {
  const oldest = state.events[state.events.length - 1]?.seq;
  return oldest === undefined ? state : { ...state, before: oldest };
}

/** The page below `before` came: it adds to the trail, and a short one reaches its start. */
export function withOlder(
  state: TrailState,
  page: AssignmentEvent[],
  before: number,
  size: number,
): TrailState {
  // An answer to a page asked before the trail started again belongs to none of it.
  if (state.before !== before) return state;
  return { ...state, events: merge(state.events, page), complete: state.complete || page.length < size };
}
