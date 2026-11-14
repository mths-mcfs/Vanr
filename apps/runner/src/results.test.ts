import { expect, test } from "bun:test";
import type { RunnerAccess } from "@vanr/contract";
import {
  type BrowserActResult,
  type BrowserInspectResult,
  type HarnessTurnResult,
  opArgs,
  type RunnerOp,
  type StoredSecretInfo,
} from "@vanr/engine/runner-protocol";
import type { Jobs } from "./jobs";
import type { execOp, listOp, readOp, writeOp } from "./ops";
import { PROTOCOL_KEYS } from "./outbound";
import type { SecretStore } from "./secrets";

// The keys of an op's result go as they are (outbound.ts, PROTOCOL_KEYS): they are the keys of the result
// interfaces of the protocol. That holds only while no result has keys that come from data. The results are
// TypeScript interfaces (the engine has no zod schema for them), so the check is on their types: the
// typecheck fails here when a result gains a record of free keys (an index signature, `Record`, `any`,
// `unknown`) and no mask rule names it.

/** The result of each op, from the code that makes it (or the engine's interface, for the browser). */
type OpResults = {
  exec: Awaited<ReturnType<typeof execOp>>;
  read: Awaited<ReturnType<typeof readOp>>;
  write: Awaited<ReturnType<typeof writeOp>>;
  list: Awaited<ReturnType<typeof listOp>>;
  "job.start": Awaited<ReturnType<Jobs["start"]>>;
  "job.status": ReturnType<Jobs["status"]>;
  "job.cancel": ReturnType<Jobs["cancel"]>;
  "job.output": ReturnType<Jobs["output"]>;
  "secret.prepare": Awaited<ReturnType<SecretStore["prepare"]>>;
  "secret.store": Awaited<ReturnType<SecretStore["store"]>>;
  "secret.list": { secrets: StoredSecretInfo[] };
  "secret.remove": ReturnType<SecretStore["remove"]>;
  "access.reduce": { access: RunnerAccess };
  "harness.turn": HarnessTurnResult;
  "browser.open": BrowserActResult;
  "browser.act": BrowserActResult;
  "browser.inspect": BrowserInspectResult;
  "browser.close": { closed: boolean };
  "live_view.start": { streaming: boolean; fps: number };
  "live_view.stop": { streaming: boolean };
  "browser.policy": { applied: boolean | number };
  "live_view.input": { applied: number };
};

type IsAny<T> = 0 extends 1 & T ? true : false;
type Leaf = string | number | boolean | bigint | null | undefined;
/**
 * `true` when some key of a value of type T, at any depth (inside lists, unions and optional fields too), comes
 * from data rather than from the type. No depth limit: a type that recurses forever makes the typecheck fail,
 * which is failing closed.
 */
type FreeKeys<T> =
  IsAny<T> extends true
    ? true
    : unknown extends T
      ? true
      : T extends Leaf
        ? false
        : T extends readonly (infer E)[]
          ? FreeKeys<E>
          : T extends object
            ? string extends keyof T
              ? true
              : number extends keyof T
                ? true
                : symbol extends keyof T
                  ? true
                  : true extends { [K in keyof T]-?: FreeKeys<T[K]> }[keyof T]
                    ? true
                    : false
            : false;

/** Ops whose result may have free keys because a mask rule for those keys exists (none today). */
type KeyRules = never;

type Free = { [K in keyof OpResults]: FreeKeys<OpResults[K]> extends false ? never : K }[keyof OpResults];
// Fails to typecheck, naming the op, when a result gains free keys without a rule.
const noFreeKeys: [Exclude<Free, KeyRules>] extends [never] ? true : Exclude<Free, KeyRules> = true;
// Every op has its result listed: a new op fails here until it is.
const listed: { [K in RunnerOp]: K extends keyof OpResults ? true : never } = Object.fromEntries(
  Object.keys(opArgs).map((k) => [k, true]),
) as { [K in RunnerOp]: true };

// The check itself sees free keys (so a pass above is not a check that sees nothing).
const seesRecord: FreeKeys<{ a: { b: Record<string, string> } }> = true;
const seesUnknown: FreeKeys<{ a: unknown[] }> = true;
const seesIndex: FreeKeys<{ a: { [k: string]: number } }> = true;
const seesNone: FreeKeys<{ a: { b: string; c: number[] } | null }> = false;
type Nest<T, N extends unknown[] = []> = N["length"] extends 20 ? T : { a?: Nest<T, [...N, 0]> | null };
const seesDeep: FreeKeys<Nest<{ list: { b: Record<string, string> }[] }>> = true;
const seesDeepNone: FreeKeys<Nest<{ list: { b: string }[] }>> = false;

test("no op result has keys that come from data, and every op's result is checked", () => {
  expect(noFreeKeys).toBe(true);
  expect(Object.keys(listed).sort()).toEqual(Object.keys(opArgs).sort());
  expect([seesRecord, seesUnknown, seesIndex, seesNone, seesDeep, seesDeepNone]).toEqual([
    true,
    true,
    true,
    false,
    true,
    false,
  ]);
  expect([...PROTOCOL_KEYS]).toEqual(["result:data"]);
});
