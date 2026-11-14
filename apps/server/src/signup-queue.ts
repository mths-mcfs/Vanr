// Closed sign-up on a new installation: deciding that a person is the first user and creating them must be
// one step, so the requests that may create that user go one at a time (the server is a single instance per
// database, so a queue in the process is enough). The queue faces the internet, so it only holds the
// decision and the creation: the body is read and checked before, the wait and the section have deadlines,
// a client that gives up leaves without running, and the queue has a maximum size. Once the installation has
// a user, nobody can be the first one, so the request skips the queue (the sign-up hook still decides it).
import { AsyncLocalStorage } from "node:async_hooks";
import { schema } from "@vanr/engine/db";
import { count } from "drizzle-orm";
import type { AppDeps } from "./context";
import { errorBody } from "./http";
import { log } from "./logger";

export interface SignupQueueLimits {
  /** A sign-up body is a name, an email and a password: a few hundred bytes. */
  maxBodyBytes: number;
  /** Time to receive the whole body; a slow or mute client gets 408 and never enters the queue. */
  bodyMs: number;
  /** Time a request may wait for its turn before 503 with Retry-After. */
  waitMs: number;
  /** Time a turn may take (normally a password hash and two queries); past it the next request goes. */
  sectionMs: number;
  /** Requests that may wait at once; past it, 503 with Retry-After without waiting. */
  maxWaiting: number;
  /** When a turn's deadline passes (tests replace it with a clock of their own). */
  sectionDeadline: (ms: number) => Deadline;
}

/** A deadline that resolves when it passes, unless cancelled before. */
export interface Deadline {
  passed: Promise<void>;
  cancel(): void;
}

const realDeadline = (ms: number): Deadline => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const passed = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return { passed, cancel: () => clearTimeout(timer) };
};

export const SIGNUP_QUEUE_LIMITS: SignupQueueLimits = {
  maxBodyBytes: 16 * 1024,
  bodyMs: 10_000,
  waitMs: 10_000,
  sectionMs: 15_000,
  maxWaiting: 32,
  sectionDeadline: realDeadline,
};

const RETRY_AFTER_S = 5;

const rejection = (status: 408 | 413 | 503, code: string, message: string) =>
  Response.json(errorBody(code, message), {
    status,
    headers: status === 503 ? { "retry-after": String(RETRY_AFTER_S) } : undefined,
  });

const busy = () => rejection(503, "signup_busy", "Sign-up is busy; try again in a few seconds");

/** The first user's place on a new installation: free, or taken by one identified sign-up section. */
type Place = { kind: "free" } | { kind: "taken"; section: number };

/**
 * The first user's place. A section that is let in as the first user takes it, and the place goes back
 * only when THAT section's work really ends (it created the user, and the count is no longer zero; or it
 * failed, and the place is free again), never when its deadline passes. While it is taken, any other
 * sign-up on an empty installation is turned away to try again.
 */
export class FirstUserPlace {
  private place: Place = { kind: "free" };
  private sections = 0;
  private readonly current = new AsyncLocalStorage<number>();

  /** Runs one sign-up section; the place it takes is given back when its work settles. */
  section<T>(work: () => Promise<T>): Promise<T> {
    const id = ++this.sections;
    const run = this.current.run(id, work);
    run
      .finally(() => {
        if (this.place.kind === "taken" && this.place.section === id) this.place = { kind: "free" };
      })
      .catch(() => {});
    return run;
  }

  /** The calling section takes the place; false when another section holds it, or outside any section. */
  take(): boolean {
    const id = this.current.getStore();
    if (id === undefined) return false;
    if (this.place.kind === "taken" && this.place.section !== id) return false;
    this.place = { kind: "taken", section: id };
    return true;
  }
}

/** The answer for the sign-up requests of a closed installation (the others go straight to Better Auth). */
export function signupGate(
  deps: Pick<AppDeps, "db" | "auth">,
  limits: SignupQueueLimits,
  firstUser: FirstUserPlace,
) {
  const queue = oneAtATime(limits);
  return async (req: Request): Promise<Response> => {
    const read = await readBody(req, limits);
    if (read instanceof Response) return read;
    const buffered = new Request(req.url, { method: req.method, headers: req.headers, body: read });
    const [row] = await deps.db.select({ n: count() }).from(schema.users);
    if ((row?.n ?? 0) > 0) return deps.auth.handler(buffered);
    return queue(() => firstUser.section(() => deps.auth.handler(buffered)), req.signal);
  };
}

/** The whole body within the size and time limits, or the rejection. A GET (an OAuth callback) has none. */
async function readBody(req: Request, limits: SignupQueueLimits): Promise<Uint8Array | null | Response> {
  if (!req.body) return null;
  const tooLarge = () => rejection(413, "payload_too_large", "The request body is too large");
  if (Number(req.headers.get("content-length") ?? 0) > limits.maxBodyBytes) return tooLarge();
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"late">((resolve) => {
    timer = setTimeout(() => resolve("late"), limits.bodyMs);
  });
  try {
    for (;;) {
      const next = await Promise.race([reader.read(), late]);
      if (next === "late") return rejection(408, "request_timeout", "The request body took too long");
      if (next.done) break;
      size += next.value.byteLength;
      if (size > limits.maxBodyBytes) return tooLarge();
      chunks.push(next.value);
    }
  } finally {
    clearTimeout(timer);
    reader.cancel().catch(() => {});
  }
  const body = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    body.set(c, at);
    at += c.byteLength;
  }
  return body;
}

/**
 * Runs one task at a time, in arrival order. A task waits at most `waitMs` and runs at most `sectionMs`
 * (past it the next one goes); a task whose client gave up while waiting never runs.
 */
function oneAtATime(limits: SignupQueueLimits) {
  let running = false;
  const waiting: (() => void)[] = [];
  const next = () => {
    running = false;
    waiting.shift()?.();
  };
  const runNow = async (task: () => Promise<Response>): Promise<Response> => {
    running = true;
    const deadline = limits.sectionDeadline(limits.sectionMs);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      deadline.cancel();
      next();
    };
    const late = deadline.passed.then(() => "late" as const);
    const work = task();
    try {
      const out = await Promise.race([work, late]);
      if (out !== "late") return out;
      log.error("signup.section_timed_out", { ms: limits.sectionMs });
      work.catch(() => {});
      return busy();
    } finally {
      release();
    }
  };
  return (task: () => Promise<Response>, signal: AbortSignal): Promise<Response> => {
    if (!running) return runNow(task);
    if (waiting.length >= limits.maxWaiting) return Promise.resolve(busy());
    return new Promise<Response>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const leave = (answer: Response) => {
        const i = waiting.indexOf(turn);
        if (i >= 0) waiting.splice(i, 1);
        clearTimeout(timer);
        signal.removeEventListener("abort", gaveUp);
        resolve(answer);
      };
      const gaveUp = () => leave(new Response(null, { status: 499 }));
      const turn = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", gaveUp);
        resolve(runNow(task));
      };
      timer = setTimeout(() => leave(busy()), limits.waitMs);
      signal.addEventListener("abort", gaveUp, { once: true });
      waiting.push(turn);
    });
  };
}
