import { describe, expect, test } from "bun:test";
import { gate, report } from "./gate.ts";

const REQUIRED = ["lint", "test"];

function needs(results: Record<string, string>): string {
  return JSON.stringify(
    Object.fromEntries(Object.entries(results).map(([job, result]) => [job, { result, outputs: {} }])),
  );
}

function passed(raw: string | undefined, required: readonly string[] = REQUIRED): boolean {
  const outcome = gate(raw, required);
  return outcome.kind === "evaluated" && outcome.passed;
}

describe("gate", () => {
  test("passes when every required job succeeded", () => {
    expect(passed(needs({ lint: "success", test: "success" }))).toBe(true);
  });

  test.each(["failure", "cancelled", "skipped"])("fails when a required job is %s", (result) => {
    expect(passed(needs({ lint: "success", test: result }))).toBe(false);
  });

  test("fails when a required job is missing from needs", () => {
    const outcome = gate(needs({ lint: "success" }), REQUIRED);
    expect(outcome).toEqual({
      kind: "evaluated",
      passed: false,
      jobs: [
        { job: "lint", result: "success", passed: true },
        { job: "test", result: "missing", passed: false },
      ],
    });
  });

  test("fails when a job outside the required list did not succeed", () => {
    expect(passed(needs({ lint: "success", test: "success", extra: "failure" }))).toBe(false);
  });

  test("fails when no required jobs are given", () => {
    expect(gate(needs({ lint: "success" }), [])).toEqual({
      kind: "malformed",
      reason: "no required jobs given",
    });
  });

  test.each([
    ["undefined", undefined],
    ["empty", ""],
    ["invalid JSON", "{lint:"],
    ["null", "null"],
    ["an array", "[]"],
    ["a string", '"success"'],
    ["a job that is not an object", '{"lint":"success","test":"success"}'],
    ["a job without result", '{"lint":{"result":"success"},"test":{}}'],
    ["an unknown result", needs({ lint: "success", test: "neutral" })],
    ["a non-string result", '{"lint":{"result":"success"},"test":{"result":1}}'],
  ])("reports malformed input: %s", (_, raw) => {
    const outcome = gate(raw, REQUIRED);
    expect(outcome.kind).toBe("malformed");
    expect(report(outcome)[0]).toStartWith("FAIL ");
  });
});

describe("report", () => {
  test("prints one line per job and a summary", () => {
    expect(report(gate(needs({ test: "failure", lint: "success" }), REQUIRED))).toEqual([
      "ok   lint: success",
      "FAIL test: failure",
      "ci: failed",
    ]);
  });
});

describe("cli", () => {
  async function run(env: Record<string, string>, args: string[]) {
    const proc = Bun.spawn([process.execPath, `${import.meta.dir}/gate.ts`, ...args], {
      env: { PATH: process.env.PATH ?? "", ...env },
      stdout: "pipe",
    });
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return { out, code };
  }

  test("exits 0 when the run passed", async () => {
    const { out, code } = await run({ NEEDS_JSON: needs({ lint: "success", test: "success" }) }, REQUIRED);
    expect(code).toBe(0);
    expect(out).toBe("ok   lint: success\nok   test: success\nci: passed\n");
  });

  test("exits 1 when a job failed", async () => {
    const { code } = await run({ NEEDS_JSON: needs({ lint: "success", test: "cancelled" }) }, REQUIRED);
    expect(code).toBe(1);
  });

  test("exits 1 when the env var is missing", async () => {
    const { out, code } = await run({}, REQUIRED);
    expect(code).toBe(1);
    expect(out).toBe("FAIL needs JSON is empty\n");
  });
});
