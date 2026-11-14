// Narrowing for JSON the runner did not write itself (CLI output lines, local socket messages): an object
// with unknown fields, read field by field with a type check, never cast to a shape.

export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The object itself, or an empty one when `v` is not an object. */
export const record = (v: unknown): Record<string, unknown> => (isRecord(v) ? v : {});

/** `JSON.parse` of a line that must be an object; `null` when it is not JSON or not an object. */
export function parseRecord(raw: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(raw);
    return isRecord(v) ? v : null;
  } catch {
    return null;
  }
}
