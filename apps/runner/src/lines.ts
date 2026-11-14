// Line-delimited JSON from the CLIs and the MCP socket, read against the schema of what each reader expects.
import { z } from "zod";

/** A line parsed with `schema`; `null` when it is not JSON or does not have that shape. */
export function parseLine<T extends z.ZodType>(schema: T, raw: string): z.output<T> | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Fields the readers treat leniently: a value of another type reads as missing, `""` or `0`. */
export const maybe = {
  string: z.string().optional().catch(undefined),
  text: z.string().catch(""),
  number: z.number().catch(0),
  boolean: z.boolean().optional().catch(undefined),
};
