// Difference between two versions of a page: by line, and by word inside a changed line.
// Long unchanged stretches become a "gap" with the count, as in GitHub's diff.
import { diffLines, diffWordsWithSpace } from "diff";

export type DiffPart = { kind: "same" | "add" | "del"; text: string };
export type DiffLine = { kind: "same" | "add" | "del"; text: string; parts?: DiffPart[] };
export type DiffRow = DiffLine | { kind: "gap"; count: number };

const splitLines = (value: string) => {
  const lines = value.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
};

/** Lines of the difference, with `context` unchanged lines around each change. */
export function diffText(
  before: string,
  after: string,
  context = 3,
): { rows: DiffRow[]; added: number; removed: number } {
  const all: DiffLine[] = [];
  let added = 0;
  let removed = 0;
  const changes = diffLines(before, after);
  for (let i = 0; i < changes.length; i++) {
    const c = changes[i];
    if (!c) continue;
    const next = changes[i + 1];
    // A block of lines replaced by another of the same size: marks the words that changed.
    if (c.removed && next?.added) {
      const del = splitLines(c.value);
      const add = splitLines(next.value);
      removed += del.length;
      added += add.length;
      if (del.length === add.length) {
        for (let k = 0; k < del.length; k++) {
          const words = diffWordsWithSpace(del[k] ?? "", add[k] ?? "");
          all.push({
            kind: "del",
            text: del[k] ?? "",
            parts: words
              .filter((w) => !w.added)
              .map((w) => ({ kind: w.removed ? "del" : "same", text: w.value })),
          });
          all.push({
            kind: "add",
            text: add[k] ?? "",
            parts: words
              .filter((w) => !w.removed)
              .map((w) => ({ kind: w.added ? "add" : "same", text: w.value })),
          });
        }
      } else {
        for (const t of del) all.push({ kind: "del", text: t });
        for (const t of add) all.push({ kind: "add", text: t });
      }
      i++;
      continue;
    }
    const kind = c.added ? "add" : c.removed ? "del" : "same";
    const lines = splitLines(c.value);
    if (kind === "add") added += lines.length;
    if (kind === "del") removed += lines.length;
    for (const t of lines) all.push({ kind, text: t });
  }
  // Collapses what is far from any change.
  const near = all.map(() => false);
  all.forEach((l, i) => {
    if (l.kind === "same") return;
    for (let k = Math.max(0, i - context); k <= Math.min(all.length - 1, i + context); k++) near[k] = true;
  });
  const rows: DiffRow[] = [];
  let gap = 0;
  all.forEach((l, i) => {
    if (near[i]) {
      if (gap) rows.push({ kind: "gap", count: gap });
      gap = 0;
      rows.push(l);
    } else gap++;
  });
  if (gap) rows.push({ kind: "gap", count: gap });
  return { rows, added, removed };
}
