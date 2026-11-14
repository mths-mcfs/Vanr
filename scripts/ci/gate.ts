// Decides whether a CI run passed, from the `needs` context of the final job.
// Usage: NEEDS_JSON='${{ toJSON(needs) }}' bun scripts/ci/gate.ts <required-job>...

const JOB_RESULTS = ["success", "failure", "cancelled", "skipped"] as const;
export type JobResult = (typeof JOB_RESULTS)[number];

export type JobVerdict = { job: string; result: JobResult | "missing"; passed: boolean };

export type GateOutcome =
  | { kind: "malformed"; reason: string }
  | { kind: "evaluated"; passed: boolean; jobs: JobVerdict[] };

type ParseResult = { ok: true; needs: Map<string, JobResult> } | { ok: false; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJobResult(value: unknown): value is JobResult {
  return typeof value === "string" && (JOB_RESULTS as readonly string[]).includes(value);
}

export function parseNeeds(raw: string | undefined): ParseResult {
  if (raw === undefined || raw.trim() === "") return { ok: false, reason: "needs JSON is empty" };
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "needs JSON is not valid JSON" };
  }
  if (!isRecord(data)) return { ok: false, reason: "needs JSON must be an object of jobs" };
  const needs = new Map<string, JobResult>();
  for (const [job, entry] of Object.entries(data)) {
    if (!isRecord(entry)) return { ok: false, reason: `job "${job}" must be an object` };
    const result = entry.result;
    if (!isJobResult(result)) {
      return { ok: false, reason: `job "${job}" has an unknown result: ${JSON.stringify(result)}` };
    }
    needs.set(job, result);
  }
  return { ok: true, needs };
}

export function gate(raw: string | undefined, required: readonly string[]): GateOutcome {
  if (required.length === 0) return { kind: "malformed", reason: "no required jobs given" };
  const parsed = parseNeeds(raw);
  if (!parsed.ok) return { kind: "malformed", reason: parsed.reason };

  const names = [...new Set([...required, ...parsed.needs.keys()])].sort();
  const jobs = names.map((job): JobVerdict => {
    const result = parsed.needs.get(job) ?? "missing";
    return { job, result, passed: result === "success" };
  });
  return { kind: "evaluated", passed: jobs.every((j) => j.passed), jobs };
}

export function report(outcome: GateOutcome): string[] {
  if (outcome.kind === "malformed") return [`FAIL ${outcome.reason}`];
  const lines = outcome.jobs.map((j) => `${j.passed ? "ok  " : "FAIL"} ${j.job}: ${j.result}`);
  lines.push(outcome.passed ? "ci: passed" : "ci: failed");
  return lines;
}

if (import.meta.main) {
  const outcome = gate(process.env.NEEDS_JSON, process.argv.slice(2));
  for (const line of report(outcome)) console.log(line);
  process.exit(outcome.kind === "evaluated" && outcome.passed ? 0 : 1);
}
