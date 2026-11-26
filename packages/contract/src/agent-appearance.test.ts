import { expect, test } from "bun:test";
import {
  AGENT_BODIES,
  AGENT_EXTRAS,
  AGENT_MOUTHS,
  type AgentBody,
  type AgentExtra,
  type AgentMouth,
} from "./index.ts";

// Compile-time: every value of each union is in its list (the lists' `satisfies` covers the other direction).
type Covers<List extends readonly string[], Union extends string> = [Exclude<Union, List[number]>] extends [
  never,
]
  ? true
  : false;
const covered: [
  Covers<typeof AGENT_BODIES, AgentBody>,
  Covers<typeof AGENT_MOUTHS, AgentMouth>,
  Covers<typeof AGENT_EXTRAS, AgentExtra>,
] = [true, true, true];

test("each appearance list holds every option once, with the bare look first", () => {
  expect(covered).toEqual([true, true, true]);
  for (const list of [AGENT_BODIES, AGENT_MOUTHS, AGENT_EXTRAS]) expect(new Set(list).size).toBe(list.length);
  expect([AGENT_BODIES[0], AGENT_MOUTHS[0], AGENT_EXTRAS[0]]).toEqual(["bubble", "none", "none"]);
});
