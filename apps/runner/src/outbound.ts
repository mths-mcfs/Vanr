// Every frame the runner sends is assembled here. The rule is to mask: every string of the frame, at any depth,
// goes through the secret mask, except
//   (a) a value of a closed set the protocol schema defines (a literal, an enum, the discriminator of a union),
//       derived from the schema itself and kept only when the value is one of that set; and
//   (b) an id the runner generated or the server sent in its request, listed in EXEMPT_IDS with the reason.
// Keys of an object the protocol defines are not data and stay; keys of a free value (a tool input) are masked.
// A field new in the protocol is masked without anyone listing it. Then every string and list is cut to its
// limit in the schema, and the frame is validated with that schema before it leaves. A frame that still fails
// becomes the minimal valid frame of its type (built from the ids and the error only, masked the same way), or
// is not sent, as INVALID says for each type.
import { type JobSnapshot, type RunnerFrame, runnerFrame } from "@vanr/engine/runner-protocol";
import type { z } from "zod";
import { maskSecrets, StreamMasker } from "./secrets";

export type Masks = [string, string][];

/**
 * (b): the strings that go as they are, by `type:path`. Each is an id the runner made or the server sent: it
 * is how the server matches the frame to what it asked, and the runner did not read it from a CLI, a file or a
 * page.
 */
export const EXEMPT_IDS: Record<string, string> = {
  "hello:session": "the single-use session the server issued for this connection",
  "hello:jobs[].jobId": "the job id the server chose in job.start",
  "result:id": "the request id the server sent",
  "output:id": "the request id the server sent",
  "harness.event:id": "the request id the server sent",
  "harness.tool:id": "the request id the server sent",
  "harness.tool:callId": "made by the runner (randomUUID) for this tool call",
  "job.event:jobId": "the job id the server chose in job.start",
  "job.done:job.jobId": "the job id the server chose in job.start",
  "live_view.frame:agentId": "the agent id the server sent with the request",
  "live_view.stream_ended:agentId": "the agent id the server sent with the request",
};

/**
 * The free values (`z.unknown()`) whose keys stay: `result.data` is the result of an op, whose keys are the
 * result interfaces of the protocol (ExecResult, ReadResult, …), not data. Every string in it is masked.
 */
export const PROTOCOL_KEYS = new Set(["result:data"]);

// ---- the schema ----

type Def = {
  type: string;
  shape?: Record<string, z.ZodType>;
  element?: z.ZodType;
  innerType?: z.ZodType;
  options?: z.ZodType[];
  discriminator?: string;
  values?: unknown[];
  entries?: Record<string, unknown>;
  checks?: { _zod: { def: { check: string; maximum?: number } } }[];
};
const defOf = (s: z.ZodType) => (s as unknown as { _zod: { def: Def } })._zod.def;
const WRAPPERS = new Set(["optional", "nullable", "default", "prefault", "readonly", "catch", "nonoptional"]);

/** The closed set of a literal or an enum schema, or `null` when the schema is not one. */
function closedSet(schema: z.ZodType): unknown[] | null {
  const d = defOf(schema);
  if (d.type === "literal") return d.values ?? [];
  if (d.type === "enum") return Object.values(d.entries ?? {});
  return null;
}

/** The values a union option takes at `key` (its discriminator). */
function valuesAt(option: z.ZodType, key: string): unknown[] {
  const d = defOf(option);
  if (d.type === "object") {
    const at = d.shape?.[key];
    return at ? (closedSet(at) ?? []) : [];
  }
  if (d.type === "union") return (d.options ?? []).flatMap((o) => valuesAt(o, key));
  return [];
}

function maxOf(schema: z.ZodType): number | null {
  for (const c of defOf(schema).checks ?? [])
    if (c._zod.def.check === "max_length") return c._zod.def.maximum ?? null;
  return null;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

// ---- the walk ----

const DEPTH_MAX = 64;
const TOO_DEEP = "[too deep]";

/**
 * A free value (one the schema does not describe) with each string masked, keys too unless `keepKeys`, without
 * recursion: below `DEPTH_MAX` levels a value becomes a marker (a CLI can send a list nested 100,000 times).
 */
export function maskDeep(value: unknown, masks: Masks, keepKeys = false): unknown {
  const root: { v: unknown } = { v: value };
  const stack: { from: unknown; set: (v: unknown) => void; depth: number }[] = [
    { from: value, set: (v) => (root.v = v), depth: 0 },
  ];
  while (stack.length) {
    const { from, set, depth } = stack.pop() as (typeof stack)[number];
    if (typeof from === "string") set(maskSecrets(from, masks));
    else if (from === null || typeof from !== "object") set(from);
    else if (depth >= DEPTH_MAX) set(TOO_DEEP);
    else if (Array.isArray(from)) {
      const out: unknown[] = new Array(from.length);
      set(out);
      from.forEach((item, i) => {
        stack.push({ from: item, set: (v) => (out[i] = v), depth: depth + 1 });
      });
    } else {
      const out: Record<string, unknown> = {};
      set(out);
      for (const [k, item] of Object.entries(from)) {
        const key = keepKeys ? k : maskSecrets(k, masks);
        stack.push({ from: item, set: (v) => (out[key] = v), depth: depth + 1 });
      }
    }
  }
  return root.v;
}

interface Walk {
  type: string;
  masks: Masks;
}

const join = (path: string, key: string) => (path ? `${path}.${key}` : key);

/** The value shaped by its schema: masked by default, exempt per (a) and (b), cut to the schema's limits. */
function walk(schema: z.ZodType, value: unknown, path: string, w: Walk): unknown {
  const d = defOf(schema);
  if (WRAPPERS.has(d.type) && d.innerType)
    return value === undefined || value === null ? value : walk(d.innerType, value, path, w);
  const set = closedSet(schema);
  if (set) return set.includes(value) ? value : maskDeep(value, w.masks);
  switch (d.type) {
    case "string": {
      if (typeof value !== "string") return maskDeep(value, w.masks);
      if (`${w.type}:${path}` in EXEMPT_IDS) return value;
      const max = maxOf(schema);
      const masked = maskSecrets(value, w.masks);
      return max === null ? masked : masked.slice(0, max);
    }
    case "object": {
      if (!isRecord(value)) return maskDeep(value, w.masks);
      const shape = d.shape ?? {};
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) {
        const field = Object.hasOwn(shape, k) ? shape[k] : undefined;
        if (field) out[k] = walk(field, v, join(path, k), w);
        else out[maskSecrets(k, w.masks)] = maskDeep(v, w.masks);
      }
      return out;
    }
    case "array": {
      if (!Array.isArray(value) || !d.element) return maskDeep(value, w.masks);
      const max = maxOf(schema);
      const items = max === null ? value : value.slice(0, max);
      const element = d.element;
      return items.map((item) => walk(element, item, `${path}[]`, w));
    }
    case "union": {
      const options = d.options ?? [];
      const key = d.discriminator;
      const option =
        key !== undefined && isRecord(value)
          ? options.find((o) => valuesAt(o, key).includes(value[key]))
          : options.find((o) => o.safeParse(value).success);
      return option ? walk(option, value, path, w) : maskDeep(value, w.masks);
    }
    case "number":
    case "boolean":
    case "bigint":
    case "null":
    case "undefined":
      // A number is not text and stays; anything else in its place is masked like a free value.
      if (typeof value === "string") return maskSecrets(value, w.masks);
      return value !== null && typeof value === "object" ? maskDeep(value, w.masks) : value;
    default:
      return maskDeep(value, w.masks, PROTOCOL_KEYS.has(`${w.type}:${path}`));
  }
}

/** The frame with every string masked (but the exemptions) and cut; not validated yet. */
function shapeFrame(frame: unknown, masks: Masks): unknown {
  const type = isRecord(frame) && typeof frame.type === "string" ? frame.type : "";
  return walk(runnerFrame, frame, "", { type, masks });
}

// ---- the exemptions, listed (for the tests and the review) ----

/** Every string path of each frame type, with what the walk does with it: `masked`, `closed` (a) or `id` (b). */
export function framePaths(): Map<string, Map<string, "masked" | "closed" | "id" | "free">> {
  const out = new Map<string, Map<string, "masked" | "closed" | "id" | "free">>();
  const visit = (
    type: string,
    schema: z.ZodType,
    path: string,
    into: Map<string, "masked" | "closed" | "id" | "free">,
  ) => {
    const d = defOf(schema);
    if (WRAPPERS.has(d.type) && d.innerType) return visit(type, d.innerType, path, into);
    if (closedSet(schema)) return void into.set(path, "closed");
    if (d.type === "string") into.set(path, `${type}:${path}` in EXEMPT_IDS ? "id" : "masked");
    else if (d.type === "object")
      for (const [k, v] of Object.entries(d.shape ?? {})) visit(type, v, join(path, k), into);
    else if (d.type === "array" && d.element) visit(type, d.element, `${path}[]`, into);
    else if (d.type === "union") for (const o of d.options ?? []) visit(type, o, path, into);
    else if (!["number", "boolean", "bigint", "null", "undefined"].includes(d.type)) into.set(path, "free");
  };
  for (const option of frameOptions()) {
    const type = String(valuesAt(option, "type")[0]);
    const into = out.get(type) ?? new Map();
    visit(type, option, "", into);
    out.set(type, into);
  }
  return out;
}

/** Each object schema of a frame (the two `result` frames apart). */
function frameOptions(): z.ZodType[] {
  const out: z.ZodType[] = [];
  const add = (s: z.ZodType) => {
    const d = defOf(s);
    if (d.type === "union") for (const o of d.options ?? []) add(o);
    else out.push(s);
  };
  add(runnerFrame);
  return out;
}

/** The most jobs a `hello` carries (the rest goes as `job.done` after the welcome). */
export const HELLO_JOBS_MAX = (() => {
  const hello = frameOptions().find((o) => valuesAt(o, "type").includes("hello"));
  const jobs = hello && defOf(hello).shape?.jobs;
  return (jobs && maxOf(jobs)) ?? 200;
})();

// ---- an invalid frame ----

const ID_MAX = 64;
const idOf = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 && v.length <= ID_MAX ? v : null;
const field = (frame: unknown, key: string): unknown => (isRecord(frame) ? frame[key] : undefined);

/**
 * What goes in place of an invalid frame, by type. First the frame is repaired: only the part that failed goes
 * (an item of a list, an optional field, a nullable one set to null), the rest stays as it is, since the server
 * stores what it gets (a hello overwrites the environment's row, a job.done finishes the task). What cannot be
 * repaired becomes the form below, built only from the frame's ids and the error; `null`: the frame is dropped
 * and the runner goes on (the log says it). A frame over the socket's size limit is invalid too (see fit).
 */
export const INVALID: Record<RunnerFrame["type"], string> = {
  hello:
    "each failing field neutral (unknown, none, paused); a failing job leaves the hello and goes after the welcome",
  pong: "a pong with at = 0",
  result:
    "an internal error with the request id; dropped without a valid id (the server's request times out)",
  output: "a stderr piece that says a piece could not be sent",
  "job.event": "a line that says the event could not be sent",
  "job.done":
    "the failing field dropped (usage, diff, an item); the job failed with the error only without a valid status",
  "runner.state": "dropped; the state goes again in the next hello",
  "cli.changed": "the failing CLI left out; dropped if nothing is left",
  "harness.event": "a text that says the event could not be sent",
  "harness.tool": "the tool call with an empty input",
  "access.changed": "the failing folder left out; no access if the tools fail",
  "sandbox.changed": "the sandbox unavailable, with the error as the reason",
  "live_view.frame": "dropped; the next frame replaces it",
  "live_view.stream_ended": "the stream ended with reason error; dropped without a valid agent id",
};

const NO_TOOLS = { claude: false, codex: false, commands: false, browser: false };
/** The neutral value of each field of a hello, for the one that fails. */
const HELLO_NEUTRAL: Record<string, unknown> = {
  version: "unknown",
  protocol: 0,
  os: "unknown",
  arch: "unknown",
  hostname: "unknown",
  workDir: null,
  paused: true,
  access: { folders: [], tools: NO_TOOLS },
  browser: false,
  executors: [],
  cli: {},
  jobs: [],
  sandbox: { state: "unavailable", engine: null, reason: null },
  features: [],
};

// The values of `process.platform` and `process.arch`: a closed set Node defines.
const OS_NAMES = new Set([
  "aix",
  "android",
  "cygwin",
  "darwin",
  "freebsd",
  "haiku",
  "linux",
  "netbsd",
  "openbsd",
  "sunos",
  "win32",
]);
const ARCH_NAMES = new Set([
  "arm",
  "arm64",
  "ia32",
  "loong64",
  "mips",
  "mipsel",
  "ppc",
  "ppc64",
  "riscv64",
  "s390",
  "s390x",
  "x64",
]);
const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

/**
 * The hello of a runner that does not know its secrets yet (it just started, or every read failed): nothing in
 * it is text from outside. Closed values, numbers and booleans stay; the version, the system and the features
 * stay only when they are what the runner itself makes (a version number, a Node platform, a known feature);
 * the session is the server's. The host name, the work folder, the folders, the CLI states, the sandbox's
 * reason and the jobs go neutral, and the real hello follows once the secrets are read (a new connection: the
 * server reads only the first hello of each one).
 */
export function neutralHello(
  frame: Extract<RunnerFrame, { type: "hello" }>,
  features: readonly string[],
): RunnerFrame {
  return {
    type: "hello",
    ...(frame.session !== undefined ? { session: frame.session } : {}),
    version: VERSION_RE.test(frame.version) ? frame.version : "unknown",
    protocol: frame.protocol,
    os: OS_NAMES.has(frame.os) ? frame.os : "unknown",
    arch: ARCH_NAMES.has(frame.arch) ? frame.arch : "unknown",
    hostname: "unknown",
    workDir: null,
    paused: frame.paused,
    access: { folders: [], tools: frame.access.tools },
    browser: frame.browser,
    executors: frame.executors,
    cli: {},
    jobs: [],
    sandbox: { ...frame.sandbox, reason: null },
    features: frame.features.filter((f) => features.includes(f)),
  };
}

function minimal(type: string, frame: unknown, why: string): unknown {
  const id = idOf(field(frame, "id"));
  const at = new Date().toISOString();
  switch (type) {
    case "pong":
      return { type, at: 0 };
    case "result":
      return id && { type, id, ok: false, error: { code: "internal", message: why } };
    case "output":
      return id && { type, id, stream: "stderr", chunk: `[${why}]` };
    case "job.event": {
      const jobId = idOf(field(frame, "jobId"));
      return jobId && { type, jobId, kind: "line", line: why, at };
    }
    case "job.done": {
      const jobId = idOf(field(field(frame, "job"), "jobId"));
      return (
        jobId && {
          type,
          job: {
            jobId,
            status: "failed",
            exitCode: null,
            result: why,
            files: [],
            session: null,
            startedAt: null,
            endedAt: at,
            denied: [],
            blocked: [],
          },
        }
      );
    }
    case "harness.event":
      return id && { type, id, event: { kind: "text", text: why } };
    case "harness.tool": {
      const callId = idOf(field(frame, "callId"));
      const name = field(frame, "name");
      return (
        id && callId && { type, id, callId, name: typeof name === "string" ? name : "unknown", input: {} }
      );
    }
    case "access.changed":
      return { type, access: { folders: [], tools: NO_TOOLS } };
    case "sandbox.changed":
      return { type, sandbox: { state: "unavailable", engine: null, reason: why } };
    case "live_view.stream_ended": {
      const agentId = idOf(field(frame, "agentId"));
      return agentId && { type, agentId, reason: "error" };
    }
    default:
      return null;
  }
}

/** The frame's own schema (the option of the union its `type`, and `ok`, choose). */
function optionOf(frame: unknown): z.ZodType | undefined {
  return frameOptions().find(
    (o) =>
      valuesAt(o, "type").includes(field(frame, "type")) &&
      (valuesAt(o, "ok").length === 0 || valuesAt(o, "ok").includes(field(frame, "ok"))),
  );
}

type Fix =
  | { holder: unknown[]; key: number; how: "remove" }
  | { holder: Record<string, unknown>; key: string; how: "delete" | "null" }
  | { holder: Record<string, unknown>; key: string; how: "set"; value: unknown };

/**
 * Where the part of `frame` at an issue's path can be taken out: the deepest item of a list, optional field
 * (or field with a default) or nullable field on the way. A job that fails leaves a hello whole, and a hello's
 * field with no such place becomes its neutral value. `null`: nothing to take out (the frame is replaced).
 */
function fixAt(frame: Record<string, unknown>, path: PropertyKey[]): Fix | null {
  if (
    frame.type === "hello" &&
    path[0] === "jobs" &&
    typeof path[1] === "number" &&
    Array.isArray(frame.jobs)
  )
    return { holder: frame.jobs, key: path[1], how: "remove" };
  let schema = optionOf(frame);
  let holder: unknown = frame;
  let best: Fix | null = null;
  for (const key of path) {
    if (!schema || holder === null || typeof holder !== "object") break;
    let d = defOf(schema);
    while (WRAPPERS.has(d.type) && d.innerType) d = defOf(d.innerType);
    const child = d.type === "object" ? d.shape?.[String(key)] : d.type === "array" ? d.element : undefined;
    if (Array.isArray(holder) && typeof key === "number") best = { holder, key, how: "remove" };
    else if (isRecord(holder) && typeof key === "string")
      for (
        let c = child ? defOf(child) : undefined;
        c && WRAPPERS.has(c.type);
        c = c.innerType && defOf(c.innerType)
      ) {
        if (c.type === "optional" || c.type === "default") best = { holder, key, how: "delete" };
        else if (c.type === "nullable") best = { holder, key, how: "null" };
      }
    holder = (holder as Record<PropertyKey, unknown>)[key as string];
    schema = child;
  }
  if (best) return best;
  const top = path[0];
  if (frame.type === "hello" && typeof top === "string" && top in HELLO_NEUTRAL)
    return { holder: frame, key: top, how: "set", value: structuredClone(HELLO_NEUTRAL[top]) };
  return null;
}

/**
 * Takes out, in one pass, the place of every issue (the items of a list are filtered at once, from the last),
 * and goes again until the frame is valid or nothing is left to take out. No count limits it: each pass takes
 * something out of a finite frame.
 */
function repair(frame: Record<string, unknown>): RunnerFrame | null {
  for (;;) {
    const parsed = runnerFrame.safeParse(frame);
    if (parsed.success) return parsed.data;
    const fixes: Fix[] = [];
    for (const issue of parsed.error.issues) {
      const fix = fixAt(frame, issue.path);
      if (!fix) return null;
      fixes.push(fix);
    }
    const removals = new Map<unknown[], Set<number>>();
    for (const fix of fixes) {
      if (fix.how === "remove")
        removals.set(fix.holder, (removals.get(fix.holder) ?? new Set()).add(fix.key));
      else if (fix.how === "delete") delete fix.holder[fix.key];
      else if (fix.how === "null") fix.holder[fix.key] = null;
      else if (fix.how === "set") fix.holder[fix.key] = fix.value;
    }
    for (const [list, at] of removals) for (const i of [...at].sort((a, b) => b - a)) list.splice(i, 1);
  }
}

function validated(shaped: unknown): RunnerFrame | null {
  const parsed = runnerFrame.safeParse(shaped);
  return parsed.success ? parsed.data : null;
}

/**
 * The value as `JSON.stringify` would put it on the wire, read back: what is validated is what goes. An
 * `undefined` field goes away, `NaN` and `Infinity` become null, a Date its text, a Map `{}`, a BigInt its
 * digits (JSON throws on it). `null` when it cannot be serialized at all (a cycle).
 */
function toWire(value: unknown): unknown {
  try {
    const json = JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    return json === undefined ? null : JSON.parse(json);
  } catch {
    return null;
  }
}

/**
 * The frame as it goes to the server: as the wire will carry it, masked (all but the exemptions), cut to the
 * schema, valid. A frame that still fails the schema is repaired or replaced as INVALID says for its type (or
 * `null`: it is not sent).
 */
export function assemble(frame: RunnerFrame, masks: Masks): RunnerFrame | null {
  const wire = toWire(frame);
  const shaped = wire === null ? null : shapeFrame(wire, masks);
  const parsed = runnerFrame.safeParse(shaped);
  if (parsed.success) return parsed.data;
  // The error text names where the frame failed and how, not the value; it is masked like any other text.
  const issue = parsed.error.issues[0];
  const why = `The runner could not send this ${frame.type} (${issue ? `${issue.path.join(".")}: ${issue.code}` : "invalid"})`;
  if (isRecord(shaped)) {
    const repaired = repair(shaped);
    // A cli.changed with nothing left would erase what the server knows: it does not go.
    if (shaped.type === "cli.changed")
      return repaired?.type === "cli.changed" && Object.keys(repaired.cli).length ? repaired : null;
    if (repaired) return repaired;
  }
  const fallback = minimal(frame.type, frame, why);
  return fallback ? validated(shapeFrame(toWire(fallback), masks)) : null;
}

/** A job snapshot as it goes to the server (in `job.done`, `hello` and `job.status`), masked and valid. */
export function assembleSnapshot(job: JobSnapshot, masks: Masks): JobSnapshot {
  const frame = assemble({ type: "job.done", job }, masks);
  if (frame?.type !== "job.done") throw new Error("a job.done frame with a valid job id always assembles");
  return frame.job;
}

// ---- the size of a frame ----

/**
 * The most a frame takes on the socket, in bytes. The server closes the runner's socket over 4 MiB
 * (its `MAX_FRAME` for this socket counts characters: a byte count is never smaller).
 */
export const FRAME_BYTES_MAX = 4 * 1024 * 1024;
/** What the jobs of a hello may take, with room for the rest; the jobs that do not fit go after the welcome. */
export const HELLO_JOBS_BYTES = 1024 * 1024;
const CUT_MARK = "\n[cut by the runner: the frame was over the size limit]";
const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v));

/** The longest string of a value, where it is, without recursion. */
function longest(
  value: unknown,
): { holder: Record<PropertyKey, unknown>; key: PropertyKey; size: number } | null {
  let best: { holder: Record<PropertyKey, unknown>; key: PropertyKey; size: number } | null = null;
  const stack: unknown[] = [value];
  while (stack.length) {
    const v = stack.pop();
    if (v === null || typeof v !== "object") continue;
    for (const [k, item] of Object.entries(v)) {
      if (typeof item === "string") {
        const size = item.length;
        if (!best || size > best.size)
          best = { holder: v as Record<PropertyKey, unknown>, key: Array.isArray(v) ? Number(k) : k, size };
      } else if (item !== null && typeof item === "object") stack.push(item);
    }
  }
  return best;
}

/**
 * A valid frame over the size limit, made to fit, or `null`: a hello leaves its last jobs out (they go after
 * the welcome), a result becomes `too_large`, a browser frame is dropped (the next one replaces it), and any
 * other frame has its longest strings cut, marked, until it fits (a job.done with a huge diff goes with the
 * diff cut, not lost).
 */
function fit(frame: RunnerFrame, masks: Masks): RunnerFrame | null {
  if (frame.type === "live_view.frame") return null;
  if (frame.type === "result")
    return assemble(
      {
        type: "result",
        id: frame.id,
        ok: false,
        error: { code: "too_large", message: "The result was over the frame size limit" },
      },
      masks,
    );
  const out = structuredClone(frame);
  if (out.type === "hello") while (out.jobs.length && bytes(out) > FRAME_BYTES_MAX) out.jobs.pop();
  for (let i = 0; i < 64 && bytes(out) > FRAME_BYTES_MAX; i++) {
    const at = longest(out);
    if (!at || at.size <= CUT_MARK.length) break;
    const text = at.holder[at.key as string] as string;
    at.holder[at.key as string] = text.slice(0, Math.floor(text.length / 2)) + CUT_MARK;
  }
  const parsed = runnerFrame.safeParse(out);
  return parsed.success && bytes(parsed.data) <= FRAME_BYTES_MAX ? parsed.data : null;
}

/**
 * The one way a frame becomes what goes on the socket: assembled (masked, cut, valid), serialized, and made
 * to fit the socket's size limit. `null`: nothing goes.
 */
export function serialize(frame: RunnerFrame, masks: Masks): string | null {
  const out = assemble(frame, masks);
  if (!out) return null;
  const json = JSON.stringify(out);
  if (Buffer.byteLength(json) <= FRAME_BYTES_MAX) return json;
  const fitted = fit(out, masks);
  return fitted ? JSON.stringify(fitted) : null;
}

// ---- flows ----

/**
 * Frames that carry pieces of one text (the text deltas of a harness turn, the output of a command, the lines
 * of a job) go through one stream masker per flow, so a secret split between two frames does not go out in
 * either; `end` gives the tail it held, which goes before the flow's last frame. The masks are read again at
 * each piece (`masks()`): a secret that appears in the middle of a flow masks what comes after it.
 */
export class Flows {
  private readonly open = new Map<string, StreamMasker>();

  constructor(private readonly masks: () => Masks) {}

  push(key: string, text: string): string {
    let m = this.open.get(key);
    if (!m) {
      m = new StreamMasker(this.masks);
      this.open.set(key, m);
    }
    return m.push(text);
  }

  end(key: string): string {
    const m = this.open.get(key);
    this.open.delete(key);
    return m ? m.end() : "";
  }

  keys(): string[] {
    return [...this.open.keys()];
  }
}
