// Usage ledger in Postgres. It passes the same `ledgerContract` as the in-memory reference,
// on PGlite and on a real Postgres.
//
// The cap's atomicity comes from the counter row: `reserve` locks (`FOR UPDATE`) the counter of each
// scope, in key order to avoid deadlocks, adds spent + open reservations and only then records the
// reservation. Parallel reservations of the same scope go through one at a time.
import { type Db, schema } from "@vanr/engine/db";
import { newId } from "@vanr/engine/ids";
import {
  type BudgetScope,
  type ModelCall,
  type PriceBook,
  periodKey,
  periodStart,
  RESERVATION_TTL_MS,
  type Reservation,
  type UsageLedger,
  usageLines,
} from "@vanr/engine/usage";
import { and, eq, gt, gte, lt, sql } from "drizzle-orm";

const { usageLines: lines, usageReservations, usageReservationScopes, budgetCounters, runs } = schema;

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

const toMicros = (amountUsd: number) => Math.round(amountUsd * 1_000_000);

/**
 * Bounds of what enters the ledger. One reservation or call above $10,000, or above 100 million tokens in
 * one field, is a bug or an attack, not usage; a negative or non-finite value would lower the spending (a
 * negative reservation frees room under the cap). Both are rejected before touching the database. A cap only
 * has to be a finite number of at least 0.
 */
export const LEDGER_LIMITS = { maxUsd: 10_000, maxTokens: 100_000_000 } as const;

const TOKEN_FIELDS = [
  "inputTokens",
  "cachedTokens",
  "cacheWrite5mTokens",
  "cacheWrite1hTokens",
  "outputTokens",
] as const;

function assertUsd(name: string, value: number) {
  if (!Number.isFinite(value) || value < 0 || value > LEDGER_LIMITS.maxUsd)
    throw new RangeError(`${name} must be a number between 0 and ${LEDGER_LIMITS.maxUsd} (got ${value})`);
}

/** The call's lines, rejected when a count or a cost is negative, non-finite, fractional or absurd. */
function checkedLines(book: PriceBook, call: ModelCall) {
  const out = usageLines(book, call);
  for (const line of out) {
    for (const field of TOKEN_FIELDS) {
      const n = line[field];
      if (!Number.isSafeInteger(n) || n < 0 || n > LEDGER_LIMITS.maxTokens)
        throw new RangeError(
          `${field} must be a whole number between 0 and ${LEDGER_LIMITS.maxTokens} (got ${n})`,
        );
    }
    assertUsd("costUsd", line.costUsd);
  }
  return out;
}
const scopeKey = (s: Pick<BudgetScope, "kind" | "id">) => `${s.kind}:${s.id}`;

/**
 * Spending of a scope before the period's counter existed. Only read when the counter is born, before
 * any new row goes into it (`settle` locks the counters before recording the rows).
 *   Agent in the month: `runs.cost_usd` (the ledger was born in the middle of the month).
 *   Channel in the month: the channel's ledger rows in the month (spending from before the cap, or from before this code).
 */
async function legacySpent(tx: Tx, scope: BudgetScope, at: Date): Promise<number> {
  if (scope.period !== "month" || (scope.kind !== "agent" && scope.kind !== "channel")) return 0;
  const from = periodStart(scope, at) as Date;
  const to = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1));
  if (scope.kind === "channel") {
    const [row] = await tx
      .select({ cost: sql<number | string | null>`sum(${lines.costMicros})` })
      .from(lines)
      .where(and(eq(lines.channelId, scope.id), gte(lines.at, from), lt(lines.at, to)));
    return Number(row?.cost ?? 0) / 1_000_000;
  }
  const [row] = await tx
    .select({ cost: sql<number | string | null>`sum(${runs.costUsd})` })
    .from(runs)
    .where(and(eq(runs.agentId, scope.id), gte(runs.createdAt, from), lt(runs.createdAt, to)));
  return Number(row?.cost ?? 0);
}

/**
 * What the workspace scope counts, in micros: every ledger row of the workspace in the month whatever scopes its call
 * went through (an agent's run reserves only its own), but the platform's embeddings (`platformEmbedding`); and a
 * run of the month with a cost and no ledger row (from before the ledger), once. Its counter row is only the lock
 * that makes the reservations of the scope go one at a time.
 */
export async function workspaceSpent(tx: Tx | Db, scope: BudgetScope, at: Date): Promise<number> {
  const from = periodStart(scope, at) ?? new Date(0);
  const to =
    scope.period === "month" ? new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1)) : null;
  const [row] = await tx
    .select({ cost: sql<number | string | null>`sum(${lines.costMicros})` })
    .from(lines)
    .where(
      and(
        eq(lines.workspaceId, scope.id),
        gte(lines.at, from),
        to ? lt(lines.at, to) : undefined,
        sql`not (${lines.source} = 'embedding' or (${lines.source} = 'search' and ${lines.userId} is null))`,
      ),
    );
  const [legacy] = await tx
    .select({ cost: sql<number | string | null>`sum(${runs.costUsd})` })
    .from(runs)
    .where(
      and(
        eq(runs.workspaceId, scope.id),
        gte(runs.createdAt, from),
        to ? lt(runs.createdAt, to) : undefined,
        sql`not exists (select 1 from ${lines} where ${lines.runId} = ${runs.id})`,
      ),
    );
  return Number(row?.cost ?? 0) + toMicros(Number(legacy?.cost ?? 0));
}

/** Counter of the scope in the period, locked until the end of the transaction; born with the legacy spending. */
async function lockCounter(tx: Tx, workspaceId: string, scope: BudgetScope, at: Date): Promise<number> {
  const key = { scope: scopeKey(scope), period: periodKey(scope, at) };
  const where = and(eq(budgetCounters.scope, key.scope), eq(budgetCounters.period, key.period));
  const select = () => tx.select().from(budgetCounters).where(where).for("update");
  let [row] = await select();
  if (!row) {
    const seed = toMicros(await legacySpent(tx, scope, at));
    // Two transactions can get here together: the second waits for the first on the conflict and does not write.
    await tx
      .insert(budgetCounters)
      .values({ ...key, workspaceId, spentMicros: seed })
      .onConflictDoNothing();
    [row] = await select();
  }
  return row?.spentMicros ?? 0;
}

const byKey = (scopes: readonly BudgetScope[]) =>
  [...scopes].sort((a, b) => (scopeKey(a) < scopeKey(b) ? -1 : 1));

/**
 * Locks (and creates, with the seed) the counters before recording the call's rows: the channel's seed
 * reads the ledger, and a counter born after the rows would count the same call twice.
 */
async function lockCounters(tx: Tx, workspaceId: string, scopes: readonly BudgetScope[], at: Date) {
  for (const scope of byKey(scopes)) await lockCounter(tx, workspaceId, scope, at);
}

async function addSpent(
  tx: Tx,
  workspaceId: string,
  scopes: readonly BudgetScope[],
  at: Date,
  micros: number,
) {
  for (const scope of byKey(scopes)) {
    await lockCounter(tx, workspaceId, scope, at);
    await tx
      .update(budgetCounters)
      .set({ spentMicros: sql`${budgetCounters.spentMicros} + ${micros}` })
      .where(and(eq(budgetCounters.scope, scopeKey(scope)), eq(budgetCounters.period, periodKey(scope, at))));
  }
}

async function writeLines(
  tx: Tx,
  book: PriceBook,
  call: ModelCall,
  reservationId: string | null,
): Promise<number> {
  const out = checkedLines(book, call);
  if (out.length === 0) return 0;
  const inserted = await tx
    .insert(lines)
    .values(
      out.map((l) => ({
        id: newId("use"),
        workspaceId: l.workspaceId,
        agentId: l.agentId,
        userId: l.userId,
        channelId: l.channelId ?? null,
        assignmentId: l.assignmentId ?? null,
        runId: l.runId,
        reservationId,
        seq: l.seq,
        source: l.source,
        iteration: l.iteration,
        model: l.model,
        inputTokens: l.inputTokens,
        cachedTokens: l.cachedTokens,
        cacheWrite5mTokens: l.cacheWrite5mTokens,
        cacheWrite1hTokens: l.cacheWrite1hTokens,
        outputTokens: l.outputTokens,
        batch: !!l.batch,
        speed: l.speed,
        inferenceGeo: l.inferenceGeo,
        serviceTier: l.serviceTier,
        keySource: l.keySource ?? "platform",
        costMicros: toMicros(l.costUsd),
        priceVersion: l.priceVersion,
        at: l.at,
      })),
    )
    .onConflictDoNothing()
    .returning({ cost: lines.costMicros });
  return inserted.reduce((sum, r) => sum + r.cost, 0);
}

export function postgresLedger(db: Db, book: PriceBook): UsageLedger {
  return {
    async reserve({ workspaceId, scopes, estimateUsd, at }) {
      assertUsd("estimateUsd", estimateUsd);
      for (const { limitUsd } of scopes)
        if (!Number.isFinite(limitUsd) || limitUsd < 0)
          throw new RangeError(`limitUsd must be a finite number of at least 0 (got ${limitUsd})`);
      const estimate = Math.ceil(estimateUsd * 1_000_000);
      return db.transaction(async (tx) => {
        for (const scope of byKey(scopes)) {
          const counted = await lockCounter(tx, workspaceId, scope, at);
          const spent = scope.kind === "workspace" ? await workspaceSpent(tx, scope, at) : counted;
          const [open] = await tx
            .select({ sum: sql<number | string | null>`sum(${usageReservations.estimateMicros})` })
            .from(usageReservationScopes)
            .innerJoin(usageReservations, eq(usageReservations.id, usageReservationScopes.reservationId))
            .where(
              and(
                eq(usageReservationScopes.scope, scopeKey(scope)),
                eq(usageReservationScopes.period, periodKey(scope, at)),
                eq(usageReservations.status, "open"),
                gt(usageReservations.expiresAt, at),
              ),
            );
          const reserved = Number(open?.sum ?? 0);
          if (spent + reserved + estimate > toMicros(scope.limitUsd))
            return {
              ok: false as const,
              scope,
              spentUsd: spent / 1_000_000,
              reservedUsd: reserved / 1_000_000,
              limitUsd: scope.limitUsd,
            };
        }
        const reservation: Reservation = {
          id: newId("res"),
          workspaceId,
          scopes,
          estimateUsd,
          at,
          expiresAt: new Date(at.getTime() + RESERVATION_TTL_MS),
        };
        await tx.insert(usageReservations).values({
          id: reservation.id,
          workspaceId,
          estimateMicros: estimate,
          scopes: scopes.map((s) => ({ ...s })),
          at,
          expiresAt: reservation.expiresAt,
        });
        if (scopes.length)
          await tx
            .insert(usageReservationScopes)
            .values(
              scopes.map((s) => ({
                reservationId: reservation.id,
                scope: scopeKey(s),
                period: periodKey(s, at),
              })),
            )
            .onConflictDoNothing();
        return { ok: true as const, reservation };
      });
    },

    async settle(reservation, call) {
      checkedLines(book, call);
      return db.transaction(async (tx) => {
        const [claimed] = await tx
          .update(usageReservations)
          .set({ status: "settled" })
          .where(and(eq(usageReservations.id, reservation.id), eq(usageReservations.status, "open")))
          .returning({ id: usageReservations.id });
        const cost = usageLines(book, call).reduce((sum, l) => sum + l.costUsd, 0);
        // Already recorded (or released): repeating does not record again.
        if (!claimed) return { costUsd: cost };
        await lockCounters(tx, reservation.workspaceId, reservation.scopes, call.at);
        const micros = await writeLines(tx, book, call, reservation.id);
        await addSpent(tx, reservation.workspaceId, reservation.scopes, call.at, micros);
        return { costUsd: cost };
      });
    },

    async release(reservation) {
      await db
        .update(usageReservations)
        .set({ status: "released" })
        .where(and(eq(usageReservations.id, reservation.id), eq(usageReservations.status, "open")));
    },

    async record(call, scopes) {
      checkedLines(book, call);
      return db.transaction(async (tx) => {
        await lockCounters(tx, call.workspaceId, scopes, call.at);
        const micros = await writeLines(tx, book, call, null);
        await addSpent(tx, call.workspaceId, scopes, call.at, micros);
        return { costUsd: micros / 1_000_000 };
      });
    },

    async spent(scope, at) {
      if (scope.kind === "workspace") return (await workspaceSpent(db, scope, at)) / 1_000_000;
      const [row] = await db
        .select({ spent: budgetCounters.spentMicros })
        .from(budgetCounters)
        .where(
          and(eq(budgetCounters.scope, scopeKey(scope)), eq(budgetCounters.period, periodKey(scope, at))),
        );
      if (row) return row.spent / 1_000_000;
      return db.transaction((tx) => legacySpent(tx, scope, at));
    },
  };
}

/** Reservations recorded or released more than a day ago serve no purpose anymore: drop them. */
export async function purgeReservations(db: Db, now: Date): Promise<void> {
  const before = new Date(now.getTime() - 24 * 60 * 60_000);
  await db.delete(usageReservations).where(lt(usageReservations.expiresAt, before));
}
