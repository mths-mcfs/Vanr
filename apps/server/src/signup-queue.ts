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
  /** When a body's, a wait's and a turn's deadline pass (tests replace them with clocks of their own). */
  bodyDeadline: (ms: number) => Deadline;
  waitDeadline: (ms: number) => Deadline;
  sectionDeadline: (ms: number) => Deadline;
  /**
   * How long the first user's creation may wait for the database before the server reports it: past it,
   * an error is logged once per period and the health check says sign-up waits for the database.
   */
  stuckInsertMs: number;
  /** Runs `check` every `ms` until the returned stop is called (tests tick it themselves). */
  every: (ms: number, check: () => void) => () => void;
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
  bodyDeadline: realDeadline,
  waitDeadline: realDeadline,
  sectionDeadline: realDeadline,
  stuckInsertMs: 60_000,
  every: (ms, check) => {
    const timer = setInterval(check, ms);
    timer.unref();
    return () => clearInterval(timer);
  },
};

const RETRY_AFTER_S = 5;

const rejection = (status: 408 | 413 | 503, code: string, message: string) =>
  Response.json(errorBody(code, message), {
    status,
    headers: status === 503 ? { "retry-after": String(RETRY_AFTER_S) } : undefined,
  });

const busy = () => rejection(503, "signup_busy", "Sign-up is busy; try again in a few seconds");

/**
 * The first user's place on a new installation:
 * - `free`: nobody is becoming the first user;
 * - `deciding`: a section took it and hasn't reached the INSERT yet (reading, checking, hashing the
 *   password). Past the section's deadline the place can be taken back, and that is safe: right before the
 *   INSERT the sign-up hook checks that this section still owns the place, and throws when it lost it;
 * - `inserting`: the hook passed and the INSERT went out. The place stays until the database answers
 *   (success or error): no deadline frees it, since nobody can tell whether that INSERT will still land.
 */
type Place =
  | { kind: "free" }
  | { kind: "deciding"; section: number; since: number }
  | { kind: "inserting"; section: number; since: number };

/** A section's turn at the first user's place. */
export interface PlaceTurn {
  /** Runs the section's work; when it really ends, the place (in whatever state it is) goes back. */
  run<T>(work: () => Promise<T>): Promise<T>;
  /** The section's deadline passed: the place is taken back if the section is still deciding. */
  expire(): void;
}

/** What `/api/v1/health` says about sign-up. */
export type SignupHealth = { status: "ok" } | { status: "waiting_for_database"; waitingSeconds: number };

export class FirstUserPlace {
  private place: Place = { kind: "free" };
  private sections = 0;
  private readonly current = new AsyncLocalStorage<number>();

  constructor(private readonly now: () => number = Date.now) {}

  /** A section starts on an empty installation: it takes the place (`deciding`), or null when it is held. */
  begin(): PlaceTurn | null {
    if (this.place.kind !== "free") return null;
    const id = ++this.sections;
    this.place = { kind: "deciding", section: id, since: this.now() };
    const mine = () => this.place.kind !== "free" && this.place.section === id;
    return {
      run: (work) => {
        const run = this.current.run(id, work);
        run
          .finally(() => {
            if (mine()) this.place = { kind: "free" };
          })
          .catch(() => {});
        return run;
      },
      expire: () => {
        if (this.place.kind === "deciding" && this.place.section === id) this.place = { kind: "free" };
      },
    };
  }

  /**
   * Right before the INSERT of the first user (the sign-up hook): true when the calling section still owns
   * the place while deciding, and then the place moves to `inserting`. One synchronous step: nothing can
   * take the place between the check and the move.
   */
  claimInsert(): boolean {
    const id = this.current.getStore();
    if (this.place.kind !== "deciding" || this.place.section !== id) return false;
    this.place = { kind: "inserting", section: id, since: this.now() };
    return true;
  }

  /** How long the first user's INSERT has been waiting for the database, or null when none is. */
  insertingForMs(): number | null {
    return this.place.kind === "inserting" ? this.now() - this.place.since : null;
  }

  health(stuckInsertMs: number): SignupHealth {
    const ms = this.insertingForMs();
    return ms !== null && ms > stuckInsertMs
      ? { status: "waiting_for_database", waitingSeconds: Math.floor(ms / 1000) }
      : { status: "ok" };
  }
}

/**
 * The sign-up decision of a closed installation, at the hook right before the user's INSERT. On an empty
 * installation the first user's place decides (a pending invite doesn't need it); otherwise only an invite
 * lets a person in.
 */
export async function signupDecision(
  place: FirstUserPlace,
  input: { users: () => Promise<number>; invited: () => Promise<boolean> },
): Promise<"allow" | "closed" | "busy"> {
  const empty = (await input.users()) === 0;
  if (empty && place.claimInsert()) return "allow";
  if (await input.invited()) return "allow";
  return empty ? "busy" : "closed";
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
    return queue((whenLate) => {
      const turn = firstUser.begin();
      // Another section holds the first user's place: try again once it ends.
      if (!turn) return Promise.resolve(busy());
      whenLate(() => turn.expire());
      return turn.run(() => deps.auth.handler(buffered));
    }, req.signal);
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
  const deadline = limits.bodyDeadline(limits.bodyMs);
  const late = deadline.passed.then(() => "late" as const);
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
    deadline.cancel();
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
  /** A task gets a way to hear its own deadline pass. */
  type Task = (whenLate: (fn: () => void) => void) => Promise<Response>;
  const runNow = async (task: Task): Promise<Response> => {
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
    let onLate = () => {};
    const work = task((fn) => {
      onLate = fn;
    });
    try {
      const out = await Promise.race([work, late]);
      if (out !== "late") return out;
      log.error("signup.section_timed_out", { ms: limits.sectionMs });
      onLate();
      work.catch(() => {});
      return busy();
    } finally {
      release();
    }
  };
  return (task: Task, signal: AbortSignal): Promise<Response> => {
    if (!running) return runNow(task);
    if (waiting.length >= limits.maxWaiting) return Promise.resolve(busy());
    return new Promise<Response>((resolve) => {
      const deadline = limits.waitDeadline(limits.waitMs);
      const leave = (answer: Response) => {
        const i = waiting.indexOf(turn);
        if (i >= 0) waiting.splice(i, 1);
        deadline.cancel();
        signal.removeEventListener("abort", gaveUp);
        resolve(answer);
      };
      const gaveUp = () => leave(new Response(null, { status: 499 }));
      const turn = () => {
        deadline.cancel();
        signal.removeEventListener("abort", gaveUp);
        resolve(runNow(task));
      };
      deadline.passed.then(() => {
        if (waiting.includes(turn)) leave(busy());
      });
      signal.addEventListener("abort", gaveUp, { once: true });
      waiting.push(turn);
    });
  };
}
