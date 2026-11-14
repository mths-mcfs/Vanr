// A clock the test moves by hand.
import type { Clock } from "../src/platform/clock.tsx";

export type ManualClock = Clock & {
  /** Moves time forward, running every timer that comes due, in order. */
  advance: (ms: number) => void;
  /** How many timers are waiting. */
  pending: () => number;
};

export function manualClock(start = Date.UTC(2026, 10, 14, 12)): ManualClock {
  let now = start;
  let timers: { at: number; run: () => void }[] = [];
  return {
    now: () => now,
    after(ms, run) {
      const timer = { at: now + ms, run };
      timers.push(timer);
      return () => {
        timers = timers.filter((candidate) => candidate !== timer);
      };
    },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const next = timers.filter((timer) => timer.at <= end).sort((a, b) => a.at - b.at)[0];
        if (next === undefined) break;
        timers = timers.filter((timer) => timer !== next);
        now = next.at;
        next.run();
      }
      now = end;
    },
    pending: () => timers.length,
  };
}
