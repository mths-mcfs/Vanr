// Structured log, one JSON object per line, on stderr. No console.log scattered around.
import { pgCode } from "./db-errors";

type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const isLevel = (v: string | undefined): v is Level => v !== undefined && Object.hasOwn(ORDER, v);
const envLevel = process.env.LOG_LEVEL;
const threshold = ORDER[isLevel(envLevel) ? envLevel : "info"];

/**
 * A failed query's message is `Failed query: <sql>\nparams: <values>` (Drizzle): the SQL keeps its
 * placeholders, but the values are what the user typed (a password hash, a token, an email). They never reach
 * the log: everything from `params:` on is cut, in the message and in the stack that repeats it.
 */
const PARAMS = /\nparams:[\s\S]*$/;
export const withoutParams = (message: string) => message.replace(PARAMS, "\nparams: [redacted]");

function serializeError(err: Error) {
  const message = withoutParams(err.message);
  let stack = err.stack;
  if (stack && message !== err.message) {
    const head = `${err.name}: ${err.message}`;
    // The stack starts with the message; when it doesn't, it is dropped rather than risk the values.
    stack = stack.startsWith(head) ? `${err.name}: ${message}${stack.slice(head.length)}` : undefined;
  }
  const code = pgCode(err);
  return { name: err.name, message, stack, ...(code ? { code } : {}) };
}

function write(level: Level, msg: string, fields?: Record<string, unknown>) {
  if (ORDER[level] < threshold) return;
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...fields }, (_k, v) =>
    v instanceof Error ? serializeError(v) : v,
  );
  process.stderr.write(`${line}\n`);
}

export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) => write("debug", msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => write("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => write("warn", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => write("error", msg, fields),
};
