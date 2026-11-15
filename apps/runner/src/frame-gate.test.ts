import { describe, expect, test } from "bun:test";
import { FrameGate } from "./frame-gate";

function fakeClock() {
  let now = 10_000;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let next = 1;
  return {
    now: () => now,
    setTimeout(fn: () => void, ms: number) {
      const id = next++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout(id: unknown) {
      timers.delete(id as number);
    },
    advance(ms: number) {
      now += ms;
      for (const [id, t] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
        if (t.at > now) continue;
        timers.delete(id);
        t.fn();
      }
    },
    pending: () => timers.size,
  };
}

describe("FrameGate", () => {
  test("a frame that arrives early goes out when the interval is up, and only the newest", () => {
    const clock = fakeClock();
    const out: string[] = [];
    const gate = new FrameGate<string>(1, (f) => out.push(f), clock);
    gate.offer("a");
    expect(out).toEqual(["a"]);
    clock.advance(200);
    gate.offer("b");
    clock.advance(200);
    gate.offer("c");
    expect(out).toEqual(["a"]);
    // The page stopped changing after "c": the last state still arrives.
    clock.advance(600);
    expect(out).toEqual(["a", "c"]);
    expect(clock.pending()).toBe(0);
  });

  test("the first frame taken on the spot counts for the interval, and does not go out after a newer one", () => {
    const clock = fakeClock();
    const out: string[] = [];
    const gate = new FrameGate<string>(1, (f) => out.push(f), clock);
    gate.first("photo");
    clock.advance(100);
    gate.offer("a");
    expect(out).toEqual(["photo"]);
    clock.advance(900);
    expect(out).toEqual(["photo", "a"]);

    const late = new FrameGate<string>(1, (f) => out.push(f), clock);
    late.offer("screencast");
    late.first("old photo");
    expect(out.slice(2)).toEqual(["screencast"]);
  });

  test("more frames per second while in control", () => {
    const clock = fakeClock();
    const out: string[] = [];
    const gate = new FrameGate<string>(1, (f) => out.push(f), clock);
    gate.offer("a");
    gate.setFps(15);
    clock.advance(70);
    gate.offer("b");
    expect(out).toEqual(["a", "b"]);
  });

  test("stopping drops the held frame and the timer", () => {
    const clock = fakeClock();
    const out: string[] = [];
    const gate = new FrameGate<string>(1, (f) => out.push(f), clock);
    gate.offer("a");
    gate.offer("b");
    gate.stop();
    clock.advance(2000);
    expect(out).toEqual(["a"]);
    expect(clock.pending()).toBe(0);
    // A late frame or a slow capture, after the end: they do not go out.
    gate.offer("c");
    gate.first("photo");
    clock.advance(2000);
    expect(out).toEqual(["a"]);
    expect(clock.pending()).toBe(0);
  });
});
