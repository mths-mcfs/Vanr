// Live view frames at the requested rate (fps). Chrome's screencast only sends a frame when the
// page changes: a frame that arrives early is held (only the newest) and goes out when the
// interval is up. Dropping it would leave the screen frozen on a stale state when the page stops changing
// right after a click.

interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
}

const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
};

export class FrameGate<F> {
  private last = 0;
  private started = false;
  private stopped = false;
  private held: F | null = null;
  private timer: unknown = null;

  constructor(
    private fps: number,
    private readonly emit: (frame: F) => void,
    private readonly clock: Clock = realClock,
  ) {}

  setFps(fps: number): void {
    this.fps = fps;
  }

  offer(frame: F): void {
    if (this.stopped) return;
    const wait = this.last + 1000 / this.fps - this.clock.now();
    if (wait <= 0 && this.timer === null) {
      this.send(frame);
      return;
    }
    this.held = frame;
    if (this.timer !== null) return;
    this.timer = this.clock.setTimeout(
      () => {
        this.timer = null;
        const next = this.held;
        this.held = null;
        if (next !== null) this.send(next);
      },
      Math.max(0, wait),
    );
  }

  /**
   * The first frame, taken the moment the stream starts. It sometimes arrives after the screencast:
   * then it is older than what already went out and is left out.
   */
  first(frame: F): void {
    if (this.started || this.stopped) return;
    this.send(frame);
  }

  /** Stops for good: whatever arrives later (a late frame, a slow capture) does not go out. */
  stop(): void {
    this.stopped = true;
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
    this.held = null;
  }

  private send(frame: F): void {
    this.started = true;
    this.last = this.clock.now();
    this.emit(frame);
  }
}
