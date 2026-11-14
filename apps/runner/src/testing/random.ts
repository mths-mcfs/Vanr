// A seeded generator for the property tests (xorshift32), with a count of what it produced: the tests print
// and check the spread of cuts and choices, so a generator that degenerates (always the same cut) fails.
export function seeded(seed: number) {
  let state = seed >>> 0 || 1;
  const counts = new Map<string, Map<number, number>>();
  const next = () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state;
  };
  return {
    /** An integer in [0, n), counted under `label`. */
    int(n: number, label = "int"): number {
      const v = next() % n;
      const c = counts.get(label) ?? new Map<number, number>();
      c.set(v, (c.get(v) ?? 0) + 1);
      counts.set(label, c);
      return v;
    },
    pick<T>(items: readonly T[], label = "pick"): T {
      return items[this.int(items.length, label)] as T;
    },
    /** How often each value came out, per label, from the smallest value up. */
    spread(label: string): number[] {
      const c = counts.get(label) ?? new Map<number, number>();
      const max = Math.max(-1, ...c.keys());
      return Array.from({ length: max + 1 }, (_, i) => c.get(i) ?? 0);
    },
  };
}
