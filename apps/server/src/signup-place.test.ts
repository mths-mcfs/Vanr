// The first user's place under generated interleavings (fixed seed): sections that take their turns one at a
// time, deadlines that pass at any moment, reads, hashes and INSERTs that answer in any order, INSERTs that
// succeed or fail. The decision is the server's own (`signupDecision`), with the place it uses. On an
// installation that started empty, never two users without an invite.
import { describe, expect, test } from "bun:test";
import { FirstUserPlace, signupDecision } from "./signup-queue";

/** mulberry32: a small seeded generator, so a failing interleaving can be replayed by its seed. */
function random(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Outcome {
  users: number;
  inserts: number;
  steps: number;
}

/** One interleaving of `sections` sign-ups. */
async function interleaving(seed: number, sections: number): Promise<Outcome> {
  const rnd = random(seed);
  const place = new FirstUserPlace(() => 0);
  let users = 0;
  let inserts = 0;
  /** Steps waiting for the scheduler to let them go on. */
  const waiting: (() => void)[] = [];
  const step = () =>
    new Promise<void>((resolve) => {
      waiting.push(resolve);
    });
  const settled: Promise<unknown>[] = [];
  let next = 0;
  /** The turn running now and whether its deadline already passed. */
  type Running = { expire(): void; ended: boolean; late: boolean };
  const turnNow: { current: Running | null } = { current: null };

  const startNext = () => {
    if (next >= sections) {
      turnNow.current = null;
      return;
    }
    next++;
    const turn = place.begin();
    if (!turn) {
      // The place is held: this sign-up is turned away at once, and the next one gets the turn.
      startNext();
      return;
    }
    const me = { expire: () => turn.expire(), ended: false, late: false };
    turnNow.current = me;
    const work = turn.run(async () => {
      await step(); // reading and hashing the password
      const decision = await signupDecision(place, {
        // The database reads the count, and the answer arrives later: by then it may be stale.
        users: async () => {
          const seen = users;
          await step();
          return seen;
        },
        invited: async () => false,
      });
      if (decision !== "allow") return;
      inserts++;
      await step(); // the INSERT, until the database answers
      if (rnd() < 0.5) throw new Error("insert failed");
      users++;
      expect(users).toBeLessThanOrEqual(1);
    });
    settled.push(
      work
        .catch(() => {})
        .finally(() => {
          me.ended = true;
          if (turnNow.current === me) startNext();
        }),
    );
  };

  startNext();
  let steps = 0;
  for (; steps < 10_000; steps++) {
    await Promise.resolve();
    const current = turnNow.current;
    const canExpire = current !== null && !current.late && !current.ended;
    if (waiting.length === 0 && !canExpire) break;
    if (canExpire && (waiting.length === 0 || rnd() < 0.2)) {
      // The running turn's deadline passes: the queue moves on, the late work goes on by itself.
      if (current) {
        current.late = true;
        current.expire();
        startNext();
      }
      continue;
    }
    const i = Math.floor(rnd() * waiting.length);
    const [go] = waiting.splice(i, 1);
    go?.();
    for (let k = 0; k < 5; k++) await Promise.resolve();
  }
  await Promise.all(settled);
  return { users, inserts, steps };
}

describe("the first user's place under generated interleavings", () => {
  test("never two users created without an invite, and a failed first lets a later one in", async () => {
    const runs = 3_000;
    let withUser = 0;
    let secondTries = 0;
    for (let seed = 1; seed <= runs; seed++) {
      const out = await interleaving(seed, 4);
      expect(out.users).toBeLessThanOrEqual(1);
      if (out.users === 1) withUser++;
      if (out.inserts > 1) secondTries++;
    }
    // The generator reached both kinds of ending, and runs where a first INSERT failed and another followed.
    expect(withUser).toBeGreaterThan(0);
    expect(withUser).toBeLessThan(runs);
    expect(secondTries).toBeGreaterThan(0);
    console.log(
      `interleavings: ${runs}, ending with one user: ${withUser}, with a second INSERT after a failure: ${secondTries}`,
    );
  });
});
