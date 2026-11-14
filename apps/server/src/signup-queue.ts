// Closed sign-up on a new installation: deciding that a person is the first user and creating them must be
// one step, so the requests that may create that user go one at a time (the server is a single instance per
// database, so a queue in the process is enough). The queue faces the internet, so it only holds the
// decision and the creation: the body is read and checked before, the wait and the section have deadlines,
// a client that gives up leaves without running, and the queue has a maximum size. Once the installation has
// a user, nobody can be the first one, so the request skips the queue (the sign-up hook still decides it).
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
}

export const SIGNUP_QUEUE_LIMITS: SignupQueueLimits = {
  maxBodyBytes: 16 * 1024,
  bodyMs: 10_000,
  waitMs: 10_000,
  sectionMs: 15_000,
  maxWaiting: 32,
};

const RETRY_AFTER_S = 5;

const refusal = (status: 408 | 413 | 503, code: string, message: string) =>
  Response.json(errorBody(code, message), {
    status,
    headers: status === 503 ? { "retry-after": String(RETRY_AFTER_S) } : undefined,
  });

const busy = () => refusal(503, "signup_busy", "Sign-up is busy; try again in a few seconds");

/** The answer for the sign-up requests of a closed installation (the others go straight to Better Auth). */
export function signupGate(deps: Pick<AppDeps, "db" | "auth">, limits: SignupQueueLimits) {
  const queue = oneAtATime(limits);
  return async (req: Request): Promise<Response> => {
    const read = await readBody(req, limits);
    if (read instanceof Response) return read;
    const buffered = new Request(req.url, { method: req.method, headers: req.headers, body: read });
    const [row] = await deps.db.select({ n: count() }).from(schema.users);
    if ((row?.n ?? 0) > 0) return deps.auth.handler(buffered);
    return queue(() => deps.auth.handler(buffered), req.signal);
  };
}

/** The whole body within the size and time limits, or the refusal. A GET (an OAuth callback) has none. */
async function readBody(req: Request, limits: SignupQueueLimits): Promise<Uint8Array | null | Response> {
  if (!req.body) return null;
  const tooLarge = () => refusal(413, "payload_too_large", "The request body is too large");
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
      if (next === "late") return refusal(408, "request_timeout", "The request body took too long");
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
    let timer: ReturnType<typeof setTimeout> | undefined;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      clearTimeout(timer);
      next();
    };
    const late = new Promise<"late">((resolve) => {
      timer = setTimeout(() => resolve("late"), limits.sectionMs);
    });
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
