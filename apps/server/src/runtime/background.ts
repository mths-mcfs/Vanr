// Background work the server keeps track of (notification delivery, and later debate rounds and routines):
// `settle` waits for it, inclusive of work that starts while it waits, and stopping the server waits for
// what is running. The error of one piece of work is logged and breaks nothing.
import { log } from "../logger";

export class BackgroundWork {
  private readonly running = new Set<Promise<unknown>>();

  track(work: Promise<unknown>, what: string): void {
    const tracked: Promise<unknown> = work
      .catch((err) => log.error("runtime.background_failed", { what, err }))
      .finally(() => this.running.delete(tracked));
    this.running.add(tracked);
  }

  /** Waits until nothing is running, including work tracked during the wait. */
  async settle(): Promise<void> {
    while (this.running.size > 0) await Promise.allSettled([...this.running]);
  }

  /** The server stops: waits for the work in progress. */
  stop(): Promise<void> {
    return this.settle();
  }
}
