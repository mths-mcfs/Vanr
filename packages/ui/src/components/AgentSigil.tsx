import type { ComponentPropsWithRef } from "react";
import { cx } from "../internal/cx.ts";

type Point = readonly [number, number];
type Segment = readonly [Point, Point];

// Nodes of a 3 x 3 grid inside a 24 x 24 box. The middle column is the stave every sigil has.
const L = 5;
const M = 12;
const R = 19;

/** Strokes a sigil can add to its stave: branches like a rune's, plus short side staves. */
const BRANCHES: readonly Segment[] = [
  [
    [M, L],
    [L, M],
  ],
  [
    [M, L],
    [R, M],
  ],
  [
    [M, M],
    [L, L],
  ],
  [
    [M, M],
    [R, L],
  ],
  [
    [M, M],
    [L, R],
  ],
  [
    [M, M],
    [R, R],
  ],
  [
    [M, R],
    [L, M],
  ],
  [
    [M, R],
    [R, M],
  ],
  [
    [L, L],
    [L, M],
  ],
  [
    [L, M],
    [L, R],
  ],
  [
    [R, L],
    [R, M],
  ],
  [
    [R, M],
    [R, R],
  ],
  [
    [L, L],
    [M, L],
  ],
  [
    [M, L],
    [R, L],
  ],
  [
    [L, M],
    [M, M],
  ],
  [
    [M, M],
    [R, M],
  ],
  [
    [L, R],
    [M, R],
  ],
  [
    [M, R],
    [R, R],
  ],
];

/** FNV-1a over the id's UTF-16 code units. */
function hash(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32: a small seeded generator, so the same id always draws the same sigil. */
function generator(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The SVG path of an agent's sigil: the stave and three or four branches, picked from the id. */
export function sigilPath(agentId: string): string {
  const next = generator(hash(agentId));
  const count = next() < 0.4 ? 3 : 4;
  const pool = BRANCHES.map((_, index) => index);
  const picked: number[] = [];
  while (picked.length < count && pool.length > 0) {
    const [index] = pool.splice(Math.floor(next() * pool.length), 1);
    if (index !== undefined) picked.push(index);
  }
  picked.sort((a, b) => a - b);
  const strokes = picked.map((index) => {
    const segment = BRANCHES[index];
    if (segment === undefined) return "";
    const [[x1, y1], [x2, y2]] = segment;
    return `M${x1} ${y1}L${x2} ${y2}`;
  });
  return [`M${M} ${L}V${R}`, ...strokes].join("");
}

export type AgentSigilProps = Omit<ComponentPropsWithRef<"span">, "children"> & {
  /** Stable agent id. The drawing is derived from it. */
  agentId: string;
  /** The agent's name, used as the accessible name. */
  name: string;
  size?: "sm" | "md" | "lg";
};

/** An agent. A square tile with a rune-like mark; people use the round <Avatar /> instead. */
export function AgentSigil({ agentId, name, size = "md", className, ...props }: AgentSigilProps) {
  return (
    <span {...props} role="img" aria-label={name} className={cx("vr-sigil", `vr-sigil--${size}`, className)}>
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d={sigilPath(agentId)} />
      </svg>
    </span>
  );
}
