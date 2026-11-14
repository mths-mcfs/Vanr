// Usage ledger contract test. Every UsageLedger implementation runs it: the in-memory one
// (usage.test.ts) and the Postgres one in the server.
import { describe, expect, test } from "bun:test";
import type { Usage } from "./models/types";
import {
  type BudgetScope,
  type ModelCall,
  type PriceBook,
  RESERVATION_TTL_MS,
  type UsageLedger,
} from "./usage";

/**
 * A fixed, round price for the contract's arithmetic: 1 USD per million input tokens on model `m`; the
 * advisor `adv` charges 2 USD per million output tokens.
 */
export const CONTRACT_PRICES: PriceBook = {
  at: (model) =>
    model === "m"
      ? { input: 1, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, version: "m@contract" }
      : model === "adv"
        ? { input: 0, output: 2, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, version: "adv@contract" }
        : null,
};

const usd = (n: number): Usage => ({
  inputTokens: n * 1_000_000,
  outputTokens: 0,
  cachedTokens: 0,
  cacheWriteTokens: 0,
});

export function ledgerContract(name: string, make: () => Promise<UsageLedger> | UsageLedger) {
  const at = new Date("2026-10-15T12:00:00Z");
  const agent: BudgetScope = { kind: "agent", id: "ag1", limitUsd: 1, period: "month" };
  const call = (n: number, when = at): ModelCall => ({
    workspaceId: "o1",
    agentId: "ag1",
    userId: "u1",
    runId: "r1",
    source: "chat",
    model: "m",
    usage: usd(n),
    at: when,
  });

  describe(`usage ledger: ${name}`, () => {
    test("a reservation above the limit is rejected with the reason", async () => {
      const ledger = await make();
      const r = await ledger.reserve({ workspaceId: "o1", scopes: [agent], estimateUsd: 1.5, at });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.scope.kind).toBe("agent");
    });

    test("10 parallel reservations of 0.3 with limit 1: exactly 3 pass", async () => {
      const ledger = await make();
      const results = await Promise.all(
        Array.from({ length: 10 }, () =>
          ledger.reserve({ workspaceId: "o1", scopes: [agent], estimateUsd: 0.3, at }),
        ),
      );
      expect(results.filter((r) => r.ok).length).toBe(3);
    });

    test("settle records the real cost and frees the reservation; repeating it does not record twice", async () => {
      const ledger = await make();
      const r = await ledger.reserve({ workspaceId: "o1", scopes: [agent], estimateUsd: 0.9, at });
      if (!r.ok) throw new Error("reservation rejected");
      expect((await ledger.settle(r.reservation, call(0.2))).costUsd).toBeCloseTo(0.2);
      await ledger.settle(r.reservation, call(0.2));
      expect(await ledger.spent(agent, at)).toBeCloseTo(0.2);
      // 0.2 spent + 0.8 new = 1: it fits.
      expect((await ledger.reserve({ workspaceId: "o1", scopes: [agent], estimateUsd: 0.8, at })).ok).toBe(
        true,
      );
    });

    test("release frees the reservation at no cost", async () => {
      const ledger = await make();
      const r = await ledger.reserve({ workspaceId: "o1", scopes: [agent], estimateUsd: 1, at });
      if (!r.ok) throw new Error("reservation rejected");
      await ledger.release(r.reservation);
      expect(await ledger.spent(agent, at)).toBe(0);
      expect((await ledger.reserve({ workspaceId: "o1", scopes: [agent], estimateUsd: 1, at })).ok).toBe(
        true,
      );
    });

    test("several scopes: a rejection in one reserves in none of the others", async () => {
      const ledger = await make();
      const channel: BudgetScope = { kind: "channel", id: "c1", limitUsd: 0.5, period: "month" };
      const r = await ledger.reserve({ workspaceId: "o1", scopes: [agent, channel], estimateUsd: 0.6, at });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.scope.kind).toBe("channel");
      expect((await ledger.reserve({ workspaceId: "o1", scopes: [agent], estimateUsd: 1, at })).ok).toBe(
        true,
      );
    });

    test("advisor on a line of its own: the cost adds up the iterations, each at its model's price", async () => {
      const ledger = await make();
      const r = await ledger.reserve({ workspaceId: "o1", scopes: [agent], estimateUsd: 1, at });
      if (!r.ok) throw new Error("reservation rejected");
      const withAdvisor: ModelCall = {
        ...call(0),
        usage: {
          ...usd(0.1),
          iterations: [
            { type: "message", inputTokens: 100_000, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
            {
              type: "advisor_message",
              model: "adv",
              inputTokens: 0,
              cachedTokens: 0,
              cacheWriteTokens: 0,
              outputTokens: 50_000,
            },
          ],
        },
      };
      // 0.1 for the executor + 50k output at 2/M = 0.1 for the advisor.
      expect((await ledger.settle(r.reservation, withAdvisor)).costUsd).toBeCloseTo(0.2);
      expect(await ledger.spent(agent, at)).toBeCloseTo(0.2);
    });

    test("an expired reservation (the process died between reserve and write) does not hold the cap", async () => {
      const ledger = await make();
      expect((await ledger.reserve({ workspaceId: "o1", scopes: [agent], estimateUsd: 1, at })).ok).toBe(
        true,
      );
      const later = new Date(at.getTime() + RESERVATION_TTL_MS + 1000);
      expect(
        (await ledger.reserve({ workspaceId: "o1", scopes: [agent], estimateUsd: 1, at: later })).ok,
      ).toBe(true);
    });

    test("record writes without a reservation or a limit; the spend counts for later reservations", async () => {
      const ledger = await make();
      expect((await ledger.record(call(1.5), [agent])).costUsd).toBeCloseTo(1.5);
      expect(await ledger.spent(agent, at)).toBeCloseTo(1.5);
      expect((await ledger.reserve({ workspaceId: "o1", scopes: [agent], estimateUsd: 0.01, at })).ok).toBe(
        false,
      );
      // The environment's plan: the line exists, the cost is 0.
      expect((await ledger.record({ ...call(5), keySource: "plan" }, [agent])).costUsd).toBe(0);
      expect(await ledger.spent(agent, at)).toBeCloseTo(1.5);
    });

    test("last month's spend does not count in the current month", async () => {
      const ledger = await make();
      const before = new Date("2026-09-30T23:00:00Z");
      const r = await ledger.reserve({ workspaceId: "o1", scopes: [agent], estimateUsd: 1, at: before });
      if (!r.ok) throw new Error("reservation rejected");
      await ledger.settle(r.reservation, call(1, before));
      expect(await ledger.spent(agent, at)).toBe(0);
      expect(await ledger.spent(agent, before)).toBeCloseTo(1);
    });
  });
}
