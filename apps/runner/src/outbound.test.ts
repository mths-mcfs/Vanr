import { expect, test } from "bun:test";
import { type RunnerFrame, runnerFrame } from "@vanr/engine/runner-protocol";
import type { z } from "zod";
import { RunnerClient } from "./client";
import { assemble, EXEMPT_IDS, framePaths, INVALID, maskDeep, PROTOCOL_KEYS } from "./outbound";
import { secretTextForms } from "./secrets";
import { seeded } from "./testing/random";

// The judge of the mask does not use any list: a generator walks the protocol's zod schema of each frame the
// runner sends, plants a secret in each string position (one at a time, then all of them), sends the frame by
// the client's real `send` (the one the socket uses) and looks for the secret in the JSON that would go out.
// Where it is left, the position must be an id the runner keeps on purpose (EXEMPT_IDS), and each of those
// must be a plain string field of the schema.

const SECRET = 'Zq9"x\\y\nTAIL-7731';
const MASKS: [string, string][] = [[SECRET, "[secret:S]"]];
const FORMS = secretTextForms(SECRET);

type Def = {
  type: string;
  shape?: Record<string, z.ZodType>;
  element?: z.ZodType;
  innerType?: z.ZodType;
  options?: z.ZodType[];
  values?: unknown[];
  entries?: Record<string, unknown>;
  checks?: { _zod: { def: { check: string; minimum?: number; format?: string } } }[];
};
const defOf = (s: z.ZodType) => (s as unknown as { _zod: { def: Def } })._zod.def;
const WRAPPERS = new Set(["optional", "nullable", "default", "prefault", "readonly", "catch", "nonoptional"]);

/** A string position of a schema: its path and whether the schema closes it to a set (literal, enum). */
interface Position {
  path: string;
  closed: boolean;
}

/** A value of `schema`, valid where nothing is planted, with `plant(path)` in each string position it names. */
function generate(
  schema: z.ZodType,
  path: string,
  plant: (path: string) => string | undefined,
  positions: Position[],
): unknown {
  const d = defOf(schema);
  const at = (k: string) => (path ? `${path}.${k}` : k);
  if (WRAPPERS.has(d.type) && d.innerType) return generate(d.innerType, path, plant, positions);
  if (d.type === "literal" || d.type === "enum") {
    positions.push({ path, closed: true });
    const values = d.type === "literal" ? (d.values ?? []) : Object.values(d.entries ?? {});
    return plant(path) ?? values[0];
  }
  switch (d.type) {
    case "string": {
      positions.push({ path, closed: false });
      const planted = plant(path);
      if (planted !== undefined) return planted;
      const checks = (d.checks ?? []).map((c) => c._zod.def);
      if (checks.some((c) => c.format === "regex")) return "example.com";
      const min = checks.find((c) => c.check === "min_length")?.minimum ?? 1;
      return "v".repeat(Math.max(min, 1));
    }
    case "number":
      return 1;
    case "boolean":
      return false;
    case "object": {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(d.shape ?? {})) out[k] = generate(v, at(k), plant, positions);
      return out;
    }
    case "array":
      return d.element ? [generate(d.element, `${path}[]`, plant, positions)] : [];
    case "union":
      return generate((d.options ?? [])[0] as z.ZodType, path, plant, positions);
    default: {
      // A free value: a key, a value and a nested list, each a position.
      positions.push({ path: `${path}{key}`, closed: false }, { path: `${path}{}`, closed: false });
      return {
        [plant(`${path}{key}`) ?? "k"]: plant(`${path}{}`) ?? "v",
        list: [[plant(`${path}{}`) ?? "w"]],
      };
    }
  }
}

/** Each frame schema the runner sends, the two `result` frames apart. */
function frameSchemas(): z.ZodType[] {
  const out: z.ZodType[] = [];
  const add = (s: z.ZodType) => {
    const d = defOf(s);
    if (d.type === "union") for (const o of d.options ?? []) add(o);
    else out.push(s);
  };
  add(runnerFrame);
  return out;
}

/** The client's real `send`, on a socket that keeps what it was given. */
function client() {
  const sent: string[] = [];
  const c = Object.create(RunnerClient.prototype) as Record<string, unknown>;
  Object.assign(c, {
    ws: { readyState: WebSocket.OPEN, send: (s: string) => sent.push(s) },
    knownMasks: new Map(),
    log: () => {},
    opts: { log: () => {} },
  });
  const send = Reflect.get(c, "send") as (frame: RunnerFrame, masks: [string, string][]) => boolean;
  return { send: (frame: RunnerFrame) => send.call(c, frame, MASKS), sent };
}

const leaks = (json: string) => FORMS.some((f) => json.includes(JSON.stringify(f).slice(1, -1)));
const typeOf = (schema: z.ZodType) => {
  const t = defOf(defOf(schema).shape?.type as z.ZodType);
  return String((t.values ?? [])[0]);
};

test("schema-driven: a secret planted in any string position of any frame does not go out, but in an id", () => {
  const counts: Record<string, number> = {};
  const leaked = new Set<string>();
  let frames = 0;
  for (const schema of frameSchemas()) {
    const type = typeOf(schema);
    const positions: Position[] = [];
    generate(schema, "", () => undefined, positions);
    const plain = generate(schema, "", () => undefined, []);
    expect([type, runnerFrame.safeParse(plain).success]).toEqual([type, true]);
    counts[type] = (counts[type] ?? 0) + positions.length;
    const tries: ((path: string) => string | undefined)[] = [];
    for (const form of FORMS) {
      for (const p of positions) tries.push((path) => (path === p.path ? form : undefined));
      tries.push(() => form);
    }
    for (const plant of tries) {
      const { send, sent } = client();
      const frame = generate(schema, "", plant, []) as RunnerFrame;
      send(frame);
      frames++;
      for (const json of sent) {
        expect(runnerFrame.safeParse(JSON.parse(json)).success).toBe(true);
        if (!leaks(json)) continue;
        // Which position kept it: plant it alone in each and see.
        for (const p of positions) {
          const one = client();
          one.send(generate(schema, "", (path) => (path === p.path ? SECRET : undefined), []) as RunnerFrame);
          if (one.sent.some(leaks)) leaked.add(`${type}:${p.path}`);
        }
      }
    }
  }
  console.log(
    `[schema] ${frames} frames sent; string positions planted by type ${JSON.stringify(counts)}; kept: ${[...leaked].sort().join(", ")}`,
  );
  // What kept the secret is exactly the list of ids (and the keys of an op's result), nothing else.
  const allowed = [...Object.keys(EXEMPT_IDS), ...[...PROTOCOL_KEYS].map((k) => `${k}{key}`)];
  expect([...leaked].sort()).toEqual(allowed.sort());
  expect(Object.keys(counts).length).toBe(14);
});

test("each id kept as it is names a plain string field of the schema; every other string is masked", () => {
  const paths = framePaths();
  for (const key of Object.keys(EXEMPT_IDS)) {
    const [type, path] = key.split(/:(.*)/s) as [string, string];
    expect([key, paths.get(type)?.get(path)]).toEqual([key, "id"]);
  }
  // A closed-set position keeps only a value of its set: a secret equal to one goes as the protocol word.
  const { send, sent } = client();
  send({ type: "output", id: "req_1", stream: "stdout", chunk: "stdout" });
  const MASK_STDOUT: [string, string][] = [["stdout", "[secret:O]"]];
  expect(JSON.parse(sent[0] as string)).toMatchObject({ stream: "stdout" });
  expect(assemble({ type: "output", id: "req_1", stream: "stdout", chunk: "stdout" }, MASK_STDOUT)).toEqual({
    type: "output",
    id: "req_1",
    stream: "stdout",
    chunk: "[secret:O]",
  });
});

test("every frame type, invalid, becomes its minimal valid form or is dropped, as INVALID says", () => {
  const long = "x".repeat(100);
  const cases: [RunnerFrame["type"], unknown, "minimal" | "dropped"][] = [
    [
      "hello",
      {
        type: "hello",
        version: "1",
        protocol: 2.5,
        os: "l",
        arch: "x",
        hostname: "h",
        workDir: null,
        paused: false,
        access: { folders: [], tools: { claude: true, codex: false, commands: true, browser: false } },
        browser: false,
        executors: [],
        jobs: [],
      },
      "minimal",
    ],
    ["pong", { type: "pong", at: "now" }, "minimal"],
    ["result", { type: "result", id: "req_1", ok: false, error: { code: "nope", message: "m" } }, "minimal"],
    ["result", { type: "result", id: long, ok: true, data: 1 }, "dropped"],
    ["output", { type: "output", id: "req_1", stream: "stdout", chunk: 5 }, "minimal"],
    ["job.event", { type: "job.event", jobId: "job_1", kind: "line", line: "l", at: 5 }, "minimal"],
    [
      "job.done",
      {
        type: "job.done",
        job: {
          jobId: "job_1",
          status: "done",
          exitCode: 0.5,
          result: null,
          files: [],
          session: null,
          startedAt: null,
          endedAt: null,
        },
      },
      "minimal",
    ],
    ["runner.state", { type: "runner.state", paused: "yes" }, "dropped"],
    [
      "cli.changed",
      { type: "cli.changed", cli: { codex: { version: "1", login: "maybe", plan: null } } },
      "minimal",
    ],
    ["harness.event", { type: "harness.event", id: "req_1", event: { kind: "other", text: "t" } }, "minimal"],
    ["harness.tool", { type: "harness.tool", id: "req_1", callId: "c1", name: 5, input: 1 }, "minimal"],
    [
      "access.changed",
      {
        type: "access.changed",
        access: {
          folders: [{ path: "", agents: [] }],
          tools: { claude: true, codex: true, commands: true, browser: true },
        },
      },
      "minimal",
    ],
    [
      "sandbox.changed",
      { type: "sandbox.changed", sandbox: { state: "on", engine: "other", reason: null } },
      "minimal",
    ],
    [
      "live_view.frame",
      { type: "live_view.frame", agentId: "agt_1", data: "Zm9v", width: 0.5, height: 1 },
      "dropped",
    ],
    [
      "live_view.stream_ended",
      { type: "live_view.stream_ended", agentId: "agt_1", reason: "gone" },
      "minimal",
    ],
  ];
  const seen = new Set<string>();
  for (const [type, frame, expected] of cases) {
    seen.add(type);
    const out = assemble(frame as RunnerFrame, MASKS);
    if (expected === "dropped") expect([type, out]).toEqual([type, null]);
    else {
      expect([type, out?.type]).toEqual([type, type]);
      expect([type, runnerFrame.safeParse(out).success]).toEqual([type, true]);
    }
  }
  expect([...seen].sort()).toEqual(Object.keys(INVALID).sort());
  // Access and the sandbox fail closed.
  const access = assemble(cases[11]?.[1] as RunnerFrame, []);
  expect(access?.type === "access.changed" && access.access.tools).toEqual({
    claude: false,
    codex: false,
    commands: false,
    browser: false,
  });
});

test("the error text of a minimal frame is masked like any text (a secret equal to a field name)", () => {
  const out = assemble(
    {
      type: "job.done",
      job: {
        jobId: "job_00000001",
        status: "done",
        exitCode: 0,
        result: "ok",
        files: [],
        session: null,
        startedAt: null,
        endedAt: null,
        denied: [],
        blocked: [],
        usage: {
          model: null,
          inputTokens: 1e20,
          outputTokens: 0,
          cachedTokens: 0,
          cacheWriteTokens: 0,
          costUsd: null,
        },
      },
    },
    [["inputTokens", "[secret:S]"]],
  );
  expect(out?.type === "job.done" && out.job.status).toBe("failed");
  expect(JSON.stringify(out)).not.toContain("inputTokens");
});

test("property: an assembled frame is always valid and holds no secret in any of its text forms", () => {
  const secrets = ["abcd-SECRET-0001", "line one\nline two", 'quo"te\\back', "AAAA"];
  const masks = secrets.map((v, i): [string, string] => [v, `[secret:S${i}]`]);
  const r = seeded(20261114);
  const pieces = [...secrets.flatMap(secretTextForms), "x", " ", "é", "\n", "[", "😀"];
  const text = (max: number) => {
    let s = "";
    const n = r.int(4, "size") === 0 ? 2000 : r.int(40, "pieces");
    for (let i = 0; i < n && s.length < max * 2; i++) s += r.pick(pieces, "piece");
    return s;
  };
  const nested = (depth: number): unknown =>
    depth === 0 ? text(50) : r.int(2, "branch") ? [nested(depth - 1)] : { [text(10)]: nested(depth - 1) };
  let frames = 0;
  for (let i = 0; i < 2000; i++) {
    const kind = r.int(5, "frame");
    const frame: RunnerFrame =
      kind === 0
        ? {
            type: "job.done",
            job: {
              jobId: "job_00000001",
              status: "done",
              exitCode: 0,
              result: text(25_000),
              files: Array.from({ length: r.int(5) }, () => text(1500)),
              session: text(400),
              startedAt: text(10),
              endedAt: null,
              denied: [],
              usage: {
                model: text(300),
                inputTokens: 1234,
                outputTokens: 1,
                cachedTokens: 0,
                cacheWriteTokens: 0,
                costUsd: null,
              },
              diff: text(1000),
              blocked: [],
            },
          }
        : kind === 1
          ? {
              type: "result",
              id: "req_1",
              ok: true,
              data: {
                text: text(3000),
                model: text(50),
                entries: Array.from({ length: r.int(4) }, () => ({ name: text(80), kind: "file" })),
              },
            }
          : kind === 2
            ? {
                type: "cli.changed",
                cli: { claude_code: { version: text(100), login: "subscription", plan: text(60) } },
              }
            : kind === 3
              ? {
                  type: "harness.tool",
                  id: "req_1",
                  callId: "c1",
                  name: text(300),
                  input: nested(r.int(90, "depth")),
                }
              : {
                  type: "live_view.frame",
                  agentId: "agt_1",
                  data: "Zm9v",
                  width: 1,
                  height: 1,
                  url: text(5000),
                };
    const out = assemble(frame, masks);
    expect(runnerFrame.safeParse(out).success).toBe(true);
    const sent = JSON.stringify(out);
    for (const v of secrets)
      for (const f of secretTextForms(v))
        expect([v, sent.includes(JSON.stringify(f).slice(1, -1))]).toEqual([v, false]);
    if (out?.type === "job.done") expect(out.job.usage?.inputTokens).toBe(1234);
    frames++;
  }
  console.log(`[frames] ${frames} frames by type ${JSON.stringify(r.spread("frame"))}`);
  expect(Math.min(...r.spread("frame"))).toBeGreaterThan(300);
});

test("a value nested a hundred thousand times is masked without recursion, cut at a fixed depth", () => {
  let deep: unknown = "abcd-SECRET-0001";
  for (let i = 0; i < 100_000; i++) deep = [deep];
  const out = JSON.stringify(maskDeep(deep, [["abcd-SECRET-0001", "[secret:S]"]]));
  expect(out).toContain("[too deep]");
  expect(out).not.toContain("abcd-SECRET-0001");
});
