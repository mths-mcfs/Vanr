// A durable claim on an effect, in `effect_keys`: whoever is about to do something that costs or goes out (a debate
// turn's paid model call) claims its key first, and only the claim's holder records the result or lets the
// key go. A claim is held while its holder lives: a token of this process, younger than the lease. The server runs
// one instance per database (instance-lock.ts), so a pending claim of another process is one a fall cut, and the
// next attempt takes it over at once instead of waiting the lease out. A claim settled `done` keeps its output, so
// an attempt resumed after the effect returned reuses that output instead of doing it again.
import { schema } from "@vanr/engine/db";
import { newId } from "@vanr/engine/ids";
import { and, eq, isNull } from "drizzle-orm";
import type { AppDeps } from "./context";

const { effectKeys } = schema;

type Db = AppDeps["db"];
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** This process: a token that doesn't start with it belongs to a server that is gone. */
const PROCESS = newId("proc");

export type ClaimOutput = { content: string; isError: boolean };

export type Claim =
  /** This attempt holds the key: it does the effect, then settles or releases. */
  | { token: string }
  /** An earlier attempt did it: its recorded output (null when it recorded none). */
  | { done: ClaimOutput | null }
  /** A live attempt holds the key. */
  | "held";

/** Claims `key`. Two claims at once take it once: the insert and the takeover are both conditional. */
export async function claim(
  db: Db | Tx,
  input: {
    key: string;
    workspaceId: string;
    tool: string;
    leaseMs: number;
    now: Date;
  },
): Promise<Claim> {
  const { key, now } = input;
  const [prior] = await db.select().from(effectKeys).where(eq(effectKeys.key, key));
  if (prior?.status === "done") return { done: prior.output ?? null };
  if (prior && live(prior.runId, prior.createdAt, input.leaseMs, now)) return "held";
  const token = `${PROCESS}.${newId("clm")}`;
  if (!prior) {
    const [fresh] = await db
      .insert(effectKeys)
      .values({
        key,
        workspaceId: input.workspaceId,
        tool: input.tool,
        runId: token,
        status: "pending",
        createdAt: now,
      })
      .onConflictDoNothing()
      .returning({ key: effectKeys.key });
    return fresh ? { token } : "held";
  }
  // A dead holder's claim (or a `failed` one): taken over only while it is still the one read here.
  const [taken] = await db
    .update(effectKeys)
    .set({ runId: token, status: "pending", output: null, createdAt: now })
    .where(and(eq(effectKeys.key, key), eq(effectKeys.status, prior.status), sameToken(prior.runId)))
    .returning({ key: effectKeys.key });
  return taken ? { token } : "held";
}

/** Records the effect's output under the claim (only while this attempt holds it). */
export async function settle(db: Db | Tx, key: string, token: string, output: ClaimOutput): Promise<void> {
  await db
    .update(effectKeys)
    .set({ status: "done", output })
    .where(and(eq(effectKeys.key, key), eq(effectKeys.runId, token)));
}

/** Lets the key go: only this attempt's claim (past the lease another attempt may hold it now). */
export async function release(db: Db | Tx, key: string, token: string): Promise<void> {
  await db.delete(effectKeys).where(and(eq(effectKeys.key, key), eq(effectKeys.runId, token)));
}

/** Drops the key once what it recorded is no longer needed (the effect's result landed where it goes). */
export async function forget(db: Db | Tx, key: string): Promise<void> {
  await db.delete(effectKeys).where(eq(effectKeys.key, key));
}

function live(token: string | null, at: Date, leaseMs: number, now: Date): boolean {
  return !!token?.startsWith(`${PROCESS}.`) && now.getTime() - at.getTime() < leaseMs;
}

const sameToken = (token: string | null) =>
  token === null ? isNull(effectKeys.runId) : eq(effectKeys.runId, token);
