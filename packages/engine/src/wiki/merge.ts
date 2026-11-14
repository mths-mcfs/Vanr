// Three-way merge by line, to reconcile a draft with a version published after it.
// base = version the draft started from; ours = the draft; theirs = the new version. Changes on
// different lines are combined, even when they touch (one ends where the other starts: they go in
// text order). A conflict is a change that crosses the other one, or both sides inserting at the same
// point, unless the two are identical.
import { diffLines } from "diff";

interface Hunk {
  /** Base lines replaced: [start, end). A pure insertion has start === end. */
  start: number;
  end: number;
  lines: string[];
}

const toLines = (s: string) => (s === "" ? [] : s.split(/(?<=\n)/));

function hunks(base: string, other: string): Hunk[] {
  const out: Hunk[] = [];
  let at = 0;
  let open: Hunk | null = null;
  for (const c of diffLines(base, other)) {
    const lines = toLines(c.value);
    if (!c.added && !c.removed) {
      if (open) out.push(open);
      open = null;
      at += lines.length;
      continue;
    }
    open ??= { start: at, end: at, lines: [] };
    if (c.removed) {
      open.end += lines.length;
      at += lines.length;
    } else open.lines.push(...lines);
  }
  if (open) out.push(open);
  return out;
}

const same = (a: Hunk, b: Hunk) =>
  a.start === b.start && a.end === b.end && a.lines.join("") === b.lines.join("");

const insertion = (h: Hunk) => h.start === h.end;

/** They cross: shared base ranges, an insertion inside the other's range, or insertions at the same point. */
const clash = (a: Hunk, b: Hunk) =>
  (a.start < b.end && b.start < a.end) || (insertion(a) && insertion(b) && a.start === b.start);

/** Without a trailing newline, appending text becomes a change of the last line (and a needless conflict). */
const withEol = (s: string) => (s === "" || s.endsWith("\n") ? s : `${s}\n`);

export type MergeResult = { ok: true; text: string } | { ok: false; conflicts: number };

export function merge3(rawBase: string, rawOurs: string, rawTheirs: string): MergeResult {
  if (rawOurs === rawBase || rawOurs === rawTheirs) return { ok: true, text: rawTheirs };
  if (rawTheirs === rawBase) return { ok: true, text: rawOurs };
  const [base, ours, theirs] = [withEol(rawBase), withEol(rawOurs), withEol(rawTheirs)];
  const a = hunks(base, ours);
  const b = hunks(base, theirs);
  const all = [...a.map((h) => ({ h, side: 0 })), ...b.map((h) => ({ h, side: 1 }))].sort(
    (x, y) => x.h.start - y.h.start || x.h.end - y.h.end,
  );
  const baseLines = toLines(base);
  const out: string[] = [];
  let at = 0;
  let conflicts = 0;
  for (let i = 0; i < all.length; ) {
    // Group: changes that cross any change in the group. Changes from the same side never cross (the diff merges them).
    const first = all[i] as (typeof all)[number];
    const group = [first];
    let end = first.h.end;
    for (i++; i < all.length; i++) {
      const next = all[i] as (typeof all)[number];
      if (!group.some((g) => clash(g.h, next.h))) break;
      group.push(next);
      end = Math.max(end, next.h.end);
    }
    const [x, y] = group as [(typeof all)[number], (typeof all)[number] | undefined];
    let lines: string[];
    if (!y) lines = x.h.lines;
    else if (group.length === 2 && x.side !== y.side && same(x.h, y.h)) lines = x.h.lines;
    else {
      conflicts++;
      continue;
    }
    out.push(...baseLines.slice(at, first.h.start), ...lines);
    at = end;
  }
  if (conflicts) return { ok: false, conflicts };
  out.push(...baseLines.slice(at));
  return { ok: true, text: out.join("") };
}
