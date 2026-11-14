import { expect, test } from "bun:test";
import { opArgs, type RunnerFrame, runnerFrame } from "@vanr/engine/runner-protocol";
import { assemble, FRAME_FIELDS, frameSchemas, maskDeep, OP_RESULTS, schemaFields } from "./outbound";
import { secretTextForms } from "./secrets";
import { seeded } from "./testing/random";

// The table of outbound.ts is the source of the mask: every frame type of the protocol and every string (or
// any-shape) field of it is in the table, marked free text or protocol. A frame type or a field that enters the
// protocol without a mark fails here, before it can reach the server unmasked.
test("every frame of the protocol and every text field of it is marked in the table", () => {
  const schemas = frameSchemas();
  expect([...schemas.keys()].sort()).toEqual(Object.keys(FRAME_FIELDS).sort());
  for (const [type, list] of schemas) {
    const paths = new Set<string>();
    for (const s of list) for (const path of schemaFields(s).keys()) paths.add(path);
    const marked = Object.keys(FRAME_FIELDS[type as RunnerFrame["type"]]);
    expect([type, [...paths].sort()]).toEqual([type, marked.sort()]);
  }
  expect(Object.keys(OP_RESULTS).sort()).toEqual(Object.keys(opArgs).sort());
});

test("the table, summed up: frames and free-text fields", () => {
  const types = Object.keys(FRAME_FIELDS);
  const free = Object.values(FRAME_FIELDS).flatMap((f) => Object.values(f).filter((k) => k !== "protocol"));
  console.log(
    `[table] ${types.length} frame types, ${free.length} free-text fields (text, stream, deep, op)`,
  );
  expect(types.length).toBe(14);
});

const SECRETS = ["abcd-SECRET-0001", "line one\nline two", 'quo"te\\back', "AAAA"];
const MASKS = SECRETS.map((v, i): [string, string] => [v, `[secret:S${i}]`]);

test("property: an assembled frame is always valid and holds no secret in any of its text forms", () => {
  const r = seeded(20261114);
  const pieces = [...SECRETS.flatMap(secretTextForms), "x", " ", "é", "\n", "[", "😀"];
  const text = (max: number) => {
    let s = "";
    const n = r.int(4, "size") === 0 ? 2000 : r.int(40, "pieces");
    for (let i = 0; i < n && s.length < max * 2; i++) s += r.pick(pieces, "piece");
    return s;
  };
  const nested = (depth: number): unknown =>
    depth === 0 ? text(50) : r.int(2, "branch") ? [nested(depth - 1)] : { [text(10)]: nested(depth - 1) };
  let frames = 0;
  for (let i = 0; i < 3000; i++) {
    const kind = r.int(6, "frame");
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
              startedAt: "2026-11-14T00:00:00.000Z",
              endedAt: "2026-11-14T00:00:01.000Z",
              denied: Array.from({ length: r.int(5) }, () => text(2500)),
              usage: {
                model: text(300),
                inputTokens: 1234,
                outputTokens: 1,
                cachedTokens: 0,
                cacheWriteTokens: 0,
                costUsd: null,
              },
              diff: text(1000),
              blocked: Array.from({ length: r.int(3) }, () => text(300)),
            },
          }
        : kind === 1
          ? {
              type: "job.event",
              jobId: "job_00000001",
              kind: "line",
              line: text(5000),
              files: [text(2000)],
              at: "x",
            }
          : kind === 2
            ? { type: "result", id: "req_1", ok: false, error: { code: "internal", message: text(3000) } }
            : kind === 3
              ? { type: "harness.event", id: "req_1", event: { kind: "text", text: text(200) } }
              : kind === 4
                ? {
                    type: "harness.tool",
                    id: "req_1",
                    callId: "c1",
                    name: "remember",
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
    const out = assemble(frame, MASKS);
    expect(out).not.toBeNull();
    expect(runnerFrame.safeParse(out).success).toBe(true);
    const sent = JSON.stringify(out);
    // The JSON of the frame escapes each secret: its escaped form must not be there either.
    for (const v of SECRETS)
      for (const f of secretTextForms(v))
        expect([v, sent.includes(JSON.stringify(f).slice(1, -1))]).toEqual([v, false]);
    if (out?.type === "job.done") expect(out.job.usage?.inputTokens).toBe(1234);
    frames++;
  }
  const spread = r.spread("frame");
  console.log(
    `[frames] ${frames} frames by type ${JSON.stringify(spread)}, depths 0-89 ${JSON.stringify(r.spread("depth").length)} values`,
  );
  expect(Math.min(...spread)).toBeGreaterThan(300);
});

test("a number equal to a secret is not masked: a number is not text (decision)", () => {
  const out = assemble(
    {
      type: "job.done",
      job: {
        jobId: "job_00000001",
        status: "done",
        exitCode: 0,
        result: "1234",
        files: [],
        session: null,
        startedAt: null,
        endedAt: null,
        denied: [],
        blocked: [],
        usage: {
          model: null,
          inputTokens: 1234,
          outputTokens: 0,
          cachedTokens: 0,
          cacheWriteTokens: 0,
          costUsd: null,
        },
      },
    },
    [["1234", "[secret:N]"]],
  );
  expect(out?.type === "job.done" && [out.job.result, out.job.usage?.inputTokens]).toEqual([
    "[secret:N]",
    1234,
  ]);
});

test("a value nested a hundred thousand times is masked without recursion, cut at a fixed depth", () => {
  let deep: unknown = "abcd-SECRET-0001";
  for (let i = 0; i < 100_000; i++) deep = [deep];
  const out = JSON.stringify(maskDeep(deep, MASKS));
  expect(out).toContain("[too deep]");
  expect(out).not.toContain("abcd-SECRET-0001");
});

test("an invalid frame does not leave: its minimal valid form goes, with the error", () => {
  const out = assemble(
    {
      type: "job.done",
      job: {
        jobId: "x".repeat(100),
        status: "done",
        exitCode: 0.5,
        result: null,
        files: [],
        session: null,
        startedAt: null,
        endedAt: null,
        denied: [],
        blocked: [],
      },
    },
    [],
  );
  expect(out?.type === "job.done" && out.job.status).toBe("failed");
  expect(runnerFrame.safeParse(out).success).toBe(true);
});
