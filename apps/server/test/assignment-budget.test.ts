import { expect, test } from "bun:test";
import { openDb } from "@vanr/engine/db";
import { createSealer } from "@vanr/engine/seal";
import { sql } from "drizzle-orm";
import { assignmentScope, assignmentUsage } from "../src/assignments/budget";
import { loadConfig } from "../src/config";
import { postgresLedger } from "../src/usage-ledger";

test("uncapped assignment spending counts toward a new cap; queued jobs contribute no time", async () => {
  const { db, close } = await openDb({ kind: "pglite", dataDir: null });
  try {
    const at = new Date("2026-11-14T12:00:00Z");
    await db.execute(sql`insert into workspaces (id, name) values ('w1', 'Scratch')`);
    await db.execute(sql`
      insert into agents (id, workspace_id, name, handle, model, owner_user_id, appearance)
        values ('a1', 'w1', 'Agent', 'agent', 'm', 'u1', '{"color":"blue","eyes":"dots","adornment":"none"}');
    `);
    const row = { id: "as1", limits: { dollars: null as number | null, minutes: null, steps: null } };
    const ledger = postgresLedger(db, {
      at: () => ({ input: 2, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }),
    });
    const deps = {
      db,
      ledger,
      now: () => at,
      config: loadConfig({ DATA_DIR: "memory" }),
      sealer: createSealer("test", "test"),
      hub: { toChannel() {}, toWorkspace() {} },
    };
    const request = { workspaceId: "w1", estimateUsd: 2, at };
    const scope = assignmentScope(row);
    const reserved = await ledger.reserve({ ...request, scopes: scope ? [scope] : [] });
    if (!reserved.ok) throw new Error("unexpected rejection");
    await ledger.settle(reserved.reservation, {
      workspaceId: "w1",
      agentId: null,
      userId: null,
      runId: null,
      assignmentId: row.id,
      source: "assignment",
      model: "m",
      usage: { inputTokens: 1_000_000, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0 },
      at,
    });
    await db.execute(sql`
      insert into runner_jobs (id, workspace_id, runner_id, agent_id, assignment_id, title, executor, prompt,
        status, created_at, started_at, ended_at) values
        ('j1','w1','r1','a1','as1','Job','shell','true','queued','2026-11-14 10:00Z',null,null),
        ('j2','w1','r1','a1','as1','Job','shell','true','running','2026-11-14 10:00Z','2026-11-14 11:50Z',null);
    `);
    expect(await assignmentUsage(deps, row)).toMatchObject({ dollars: 2, minutes: 10 });
    row.limits.dollars = 1;
    expect((await ledger.reserve({ ...request, scopes: [assignmentScope(row)], estimateUsd: 0.5 })).ok).toBe(
      false,
    );
  } finally {
    await close();
  }
});
