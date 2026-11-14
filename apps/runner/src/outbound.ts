// Every frame the runner sends is assembled here, from raw data: the free-text fields of the frame (text,
// result, output, tool input, file name, diff, error message, session) go through the secret mask, then every
// string is cut to its limit in the protocol schema, and the frame is validated with that schema before it
// leaves. An invalid frame does not leave: a minimal valid frame of the same type, with the error, goes instead.
// Protocol fields (type, id, number, enum, keys the protocol defines) are never masked.
import { type JobSnapshot, type RunnerFrame, runnerFrame } from "@vanr/engine/runner-protocol";
import type { z } from "zod";
import { maskSecrets } from "./secrets";

export type Masks = [string, string][];

/**
 * - `text`: free text, masked here.
 * - `stream`: free text masked by the stream masker that produced it (output that arrives in pieces, where a
 *   secret can be split between two of them); here it is only cut.
 * - `deep`: a value of any shape (a tool input), every string in it masked here, keys included.
 * - `op`: the data of a request's result, masked by the op that made it (see OP_RESULTS).
 * - `protocol`: a field the protocol defines; never masked.
 */
export type FieldKind = "text" | "stream" | "deep" | "op" | "protocol";

const P = "protocol" as const;
const T = "text" as const;
/** The fields of a job snapshot, inside `job.done` and `hello.jobs[]`. */
const snapshotFields = (at: string): Record<string, FieldKind> => ({
  [`${at}jobId`]: P,
  [`${at}result`]: T,
  [`${at}files[]`]: T,
  [`${at}session`]: T,
  [`${at}startedAt`]: P,
  [`${at}endedAt`]: P,
  [`${at}denied[]`]: T,
  [`${at}usage.model`]: T,
  [`${at}diff`]: T,
  [`${at}blocked[]`]: T,
});
const cliFields = {
  "cli.claude_code.version": P,
  "cli.claude_code.plan": P,
  "cli.codex.version": P,
  "cli.codex.plan": P,
} as const;
const accessFields = { "access.folders[].path": P, "access.folders[].agents[]": P } as const;

/** Each frame type the runner sends and every field of it that is a string or a value of any shape. */
export const FRAME_FIELDS: Record<RunnerFrame["type"], Record<string, FieldKind>> = {
  hello: {
    session: P,
    token: P,
    version: P,
    os: P,
    arch: P,
    hostname: P,
    workDir: P,
    ...accessFields,
    ...cliFields,
    // The snapshots of the journal: assembled (and masked) when the job ended.
    ...snapshotFields("jobs[]."),
    "sandbox.reason": P,
    "features[]": P,
  },
  pong: {},
  result: { id: P, data: "op", "error.message": T },
  output: { id: P, chunk: "stream" },
  "job.event": { jobId: P, line: T, "files[]": T, at: P },
  "job.done": snapshotFields("job."),
  "runner.state": {},
  "cli.changed": cliFields,
  "harness.event": { id: P, "event.text": T },
  "harness.tool": { id: P, callId: P, name: P, input: "deep" },
  "access.changed": accessFields,
  "sandbox.changed": { "sandbox.reason": P },
  "live_view.frame": { agentId: P, data: P, url: T },
  "live_view.stream_ended": { agentId: P },
};

/** Where the data of each op's result is masked (the `op` kind of `result.data`). */
export const OP_RESULTS = {
  exec: "stdout and stderr: the stream mask of ops.ts (Capture), before the cut",
  read: "content: the byte mask of ops.ts (maskBytesPrefix), before the cut, in every encoding",
  write: "path only, the one the agent asked for",
  list: "entry names: maskSecrets in ops.ts",
  "job.start": "job id and folder only",
  "harness.turn": "text: masked here (assembleResult)",
  "job.status": "a job snapshot assembled by Jobs.view",
  "job.cancel": "a boolean",
  "job.output": "lines of output.log, masked when they were written",
  "secret.prepare": "a public key",
  "secret.store": "a boolean",
  "secret.list": "secret names and targets, the person's own labels",
  "secret.remove": "a boolean",
  "access.reduce": "the runner's access config",
  "browser.open": "browserMasker in cdp.ts (title, text, URLs, dialogs, tabs)",
  "browser.act": "browserMasker in cdp.ts (title, text, URLs, dialogs, tabs)",
  "browser.inspect": "browserMasker in cdp.ts (label, href, form action, URL)",
  "browser.close": "a boolean",
  "live_view.start": "the stream state",
  "live_view.stop": "the stream state",
  "live_view.input": "a count",
  "browser.policy": "a boolean",
} as const;

/** A request's result data for the server: the ops that do not mask their own text are masked here. */
export function maskResult(op: keyof typeof OP_RESULTS, data: unknown, masks: Masks): unknown {
  if (op === "harness.turn" && data !== null && typeof data === "object" && "text" in data) {
    if (typeof data.text === "string") return { ...data, text: maskSecrets(data.text, masks) };
  }
  return data;
}

const DEPTH_MAX = 64;
const TOO_DEEP = "[too deep]";

/**
 * Each string of a value masked, keys included, without recursion: below `DEPTH_MAX` levels a value becomes
 * a marker instead of being walked (a CLI or a model can send a list nested a hundred thousand times).
 */
export function maskDeep(value: unknown, masks: Masks): unknown {
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
        const key = maskSecrets(k, masks);
        stack.push({ from: item, set: (v) => (out[key] = v), depth: depth + 1 });
      }
    }
  }
  return root.v;
}

// ---- the schema's limits ----

type Def = {
  type: string;
  shape?: Record<string, z.ZodType>;
  element?: z.ZodType;
  innerType?: z.ZodType;
  options?: z.ZodType[];
};
const defOf = (s: z.ZodType) => (s as unknown as { _zod: { def: Def } })._zod.def;

/** The string and unknown fields of a frame schema, by path, with the string limit (`null`: none). */
export function schemaFields(
  schema: z.ZodType,
  path = "",
  out = new Map<string, number | null | "unknown">(),
) {
  const d = defOf(schema);
  if (d.type === "object")
    for (const [k, v] of Object.entries(d.shape ?? {})) schemaFields(v, path ? `${path}.${k}` : k, out);
  else if (d.type === "array" && d.element) schemaFields(d.element, `${path}[]`, out);
  else if (
    ["optional", "nullable", "default", "prefault", "readonly", "catch"].includes(d.type) &&
    d.innerType
  )
    schemaFields(d.innerType, path, out);
  else if (d.type === "union") for (const o of d.options ?? []) schemaFields(o, path, out);
  else if (d.type === "string") out.set(path, (schema as unknown as { maxLength: number | null }).maxLength);
  else if (d.type === "unknown" || d.type === "any" || d.type === "record") out.set(path, "unknown");
  return out;
}

/** Each frame schema of the protocol by type (the two `result` frames merged). */
export function frameSchemas(): Map<string, z.ZodType[]> {
  const out = new Map<string, z.ZodType[]>();
  const add = (s: z.ZodType) => {
    const d = defOf(s);
    if (d.type === "union") return d.options?.forEach(add);
    const type = (defOf(d.shape?.type as z.ZodType) as unknown as { values: string[] }).values[0] as string;
    out.set(type, [...(out.get(type) ?? []), s]);
  };
  add(runnerFrame);
  return out;
}

const LIMITS = new Map<string, Map<string, number | null | "unknown">>();
for (const [type, schemas] of frameSchemas()) {
  const fields = new Map<string, number | null | "unknown">();
  for (const s of schemas) for (const [k, v] of schemaFields(s)) fields.set(k, v);
  LIMITS.set(type, fields);
}

// ---- assembly ----

/** Applies `fn` to the value at `path` (`a.b[].c`) inside `obj`, in place; missing parts are skipped. */
function update(obj: unknown, path: string[], fn: (v: unknown) => unknown): void {
  const [head, ...rest] = path;
  if (head === undefined || obj === null || typeof obj !== "object") return;
  const many = head.endsWith("[]");
  const key = many ? head.slice(0, -2) : head;
  const holder = obj as Record<string, unknown>;
  if (!(key in holder)) return;
  if (many) {
    const list = holder[key];
    if (!Array.isArray(list)) return;
    if (rest.length) for (const item of list) update(item, rest, fn);
    else holder[key] = list.map(fn);
  } else if (rest.length) update(holder[key], rest, fn);
  else holder[key] = fn(holder[key]);
}

const cut = (max: number | null | "unknown") => (v: unknown) =>
  typeof v === "string" && typeof max === "number" ? v.slice(0, max) : v;

/** The frame with its free text masked and its strings cut; not validated yet. */
function shape(frame: RunnerFrame, masks: Masks): RunnerFrame {
  const out = structuredClone(frame);
  const limits = LIMITS.get(frame.type) ?? new Map();
  for (const [path, kind] of Object.entries(FRAME_FIELDS[frame.type])) {
    const segments = path.split(".");
    const max = limits.get(path) ?? null;
    if (kind === "text")
      update(out, segments, (v) => cut(max)(typeof v === "string" ? maskSecrets(v, masks) : v));
    else if (kind === "deep") update(out, segments, (v) => maskDeep(v, masks));
    else if (kind === "stream") update(out, segments, cut(max));
  }
  return out;
}

const issueOf = (e: z.ZodError) => {
  const i = e.issues[0];
  return i ? `${i.path.join(".")}: ${i.message}` : "invalid frame";
};

/** The minimal valid frame of the same type that goes out in place of an invalid one, or `null` (nothing goes). */
function fallback(frame: RunnerFrame, issue: string): RunnerFrame | null {
  const why = `The runner could not send this ${frame.type} (${issue})`.slice(0, 2000);
  switch (frame.type) {
    case "result":
      return {
        type: "result",
        id: frame.id.slice(0, 64),
        ok: false,
        error: { code: "internal", message: why },
      };
    case "job.done":
      return {
        type: "job.done",
        job: {
          jobId: frame.job.jobId.slice(0, 64),
          status: "failed",
          exitCode: null,
          result: why,
          files: [],
          session: null,
          startedAt: frame.job.startedAt,
          endedAt: frame.job.endedAt,
          denied: [],
          blocked: [],
        },
      };
    case "job.event":
      return {
        type: "job.event",
        jobId: frame.jobId.slice(0, 64),
        kind: "line",
        line: why.slice(0, 4000),
        at: frame.at,
      };
    case "harness.event":
      return { type: "harness.event", id: frame.id.slice(0, 64), event: { kind: "text", text: why } };
    case "harness.tool":
      return { ...frame, input: {} };
    default:
      return null;
  }
}

/**
 * The frame as it goes to the server: masked with `masks` where the table says, cut to the schema, valid. A
 * frame that still fails the schema becomes its minimal valid form (or `null`: it is not sent).
 */
export function assemble(frame: RunnerFrame, masks: Masks): RunnerFrame | null {
  const shaped = shape(frame, masks);
  const parsed = runnerFrame.safeParse(shaped);
  if (parsed.success) return shaped;
  const minimal = fallback(shaped, issueOf(parsed.error));
  return minimal && runnerFrame.safeParse(minimal).success ? minimal : null;
}

/** A job snapshot as it goes to the server (in `job.done`, `hello` and `job.status`), masked and valid. */
export function assembleSnapshot(job: JobSnapshot, masks: Masks): JobSnapshot {
  const frame = assemble({ type: "job.done", job }, masks);
  if (frame?.type !== "job.done") throw new Error("a job.done frame always assembles");
  return frame.job;
}
