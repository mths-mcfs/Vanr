// Time as the client sees it: deadlines, reconnection waits and the socket's keep-alive all go through a
// Clock, so tests drive time by hand instead of waiting for it.

export interface Clock {
  now(): number;
  /** Runs `fn` once after `ms`; the returned function cancels it. */
  setTimer(fn: () => void, ms: number): () => void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimer: (fn, ms) => {
    const handle = setTimeout(fn, ms);
    return () => clearTimeout(handle);
  },
};

/** A clock that only moves when told to. `advance` fires every timer that falls due, in order. */
export class ManualClock implements Clock {
  private time = 0;
  private seq = 0;
  private timers = new Map<number, { at: number; fn: () => void }>();

  now(): number {
    return this.time;
  }

  setTimer(fn: () => void, ms: number): () => void {
    const id = this.seq++;
    this.timers.set(id, { at: this.time + Math.max(0, ms), fn });
    return () => {
      this.timers.delete(id);
    };
  }

  /** Pending timers, soonest first (for assertions). */
  pending(): number[] {
    return [...this.timers.values()].map((t) => t.at - this.time).sort((a, b) => a - b);
  }

  advance(ms: number): void {
    const end = this.time + ms;
    for (;;) {
      let next: [number, { at: number; fn: () => void }] | null = null;
      for (const entry of this.timers)
        if (entry[1].at <= end && (!next || entry[1].at < next[1].at)) next = entry;
      if (!next) break;
      this.timers.delete(next[0]);
      this.time = next[1].at;
      next[1].fn();
    }
    this.time = end;
  }
}
