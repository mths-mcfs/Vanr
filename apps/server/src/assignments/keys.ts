// Fixed keys of the engine: a repeated step finds the same row, the same job and the same fix item.
import { createHash } from "node:crypto";

const hash = (s: string, n = 22) => createHash("sha256").update(s).digest("base64url").slice(0, n);

/** ID of the work (assignment, item, attempt): repeated, it is the same row. */
export const workIdOf = (assignmentId: string, itemId: string, n: number) =>
  `aw_${hash(`${assignmentId}|${itemId}|${n}`)}`;
/** ID of the work's job: the runner rejects a repeated ID, so a repeated step does not run twice. */
export const jobIdOf = (workId: string) => `aj_${workId.slice(3)}`;
export const workIdOfJob = (jobId: string) => (jobId.startsWith("aj_") ? `aw_${jobId.slice(3)}` : null);
/**
 * ID of the round's fix item (fixed: a repeated round does not create another). With `epoch` (the item's
 * rounds were reset), round 1 is a different one: without it, the new fix would land on the old, finished one.
 */
export function fixIdOf(itemId: string, epoch: number, round: number): string {
  const tag = epoch ? `e${epoch}-fix${round}` : `fix${round}`;
  const id = `${itemId}-${tag}`;
  return id.length <= 40 ? id : `fix-${hash(itemId, 12)}-${tag}`;
}
