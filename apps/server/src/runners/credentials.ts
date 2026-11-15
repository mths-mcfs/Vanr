// Runner credentials. The device credential (`rrt_`, only its hash in the database) serves only to get a
// session at `POST /api/v1/runners/session`; the session (`rst_`) lasts 2 minutes and is good once, in the
// WebSocket's `hello`. Every session taken rotates the credential: the new one goes in the same response and
// stays pending (a response lost on the way doesn't lock the runner out, which tries again with the current
// one). When the session is used in the `hello`, the runner proved it got the new one: it becomes the current
// one and the previous becomes "old". The old one showing up again means someone has a copy: the runner is revoked on the spot.
// Revoking (by the person or for reuse) drops the WebSocket and deletes the sessions; the runner stays in the
// list until it is paired again.
import { schema } from "@vanr/engine/db";
import { newToken, sha256Hex } from "@vanr/engine/ids";
import { and, eq, gt, isNull, lt, or, sql } from "drizzle-orm";
import type { AppDeps } from "../context";
import { HttpError } from "../http";
import { log } from "../logger";
import { endLiveViewsOf } from "./browser-live";
import { cancelRunnerRequests, publishRunnerRequests } from "./requests";
import type { RunnerRow } from "./runners";

const { runners, runnerSessions } = schema;

const SESSION_TTL_S = 120;
/** A connection past this and the server asks for another (which takes a new session and rotates the credential). */
export const CONNECTION_MAX_MS = 24 * 3600_000;

export const newCredential = () => `rrt_${newToken(32)}`;
const newSession = () => `rst_${newToken(32)}`;

/** A rejection in the format the runner understands (401: invalid credential; 403: revoked or removed). */
const rejected = (status: 401 | 403, code: string, message: string) => new HttpError(status, code, message);

export async function revokeRunner(
  deps: AppDeps,
  row: Pick<RunnerRow, "id" | "workspaceId">,
  reason: "manual" | "reuse",
): Promise<void> {
  const now = deps.now();
  // The hashes stay: the current, the pending and the old one now get "revoked" (403), not "not paired".
  const closed = await deps.db.transaction(async (tx) => {
    await tx
      .update(runners)
      .set({ revokedAt: now, revokedReason: reason, updatedAt: now })
      .where(eq(runners.id, row.id));
    await tx.delete(runnerSessions).where(eq(runnerSessions.runnerId, row.id));
    return cancelRunnerRequests(tx, now, row.id);
  });
  deps.runners.close(row.id, {
    type: "rejected",
    reason: "revoked",
    message:
      reason === "reuse"
        ? "This runner's credential was used from somewhere else; pair it again"
        : "This runner's access was revoked; pair it again",
  });
  endLiveViewsOf(deps, row.id);
  await publishRunnerRequests(deps, closed);
  deps.hub.toWorkspace(row.workspaceId, { type: "runner.revoked", runnerId: row.id, reason });
  log.warn("runner.revoked", { runnerId: row.id, reason });
}

/** Exchanges the device credential for a session and a new credential. */
export async function mintSession(
  deps: AppDeps,
  credential: string,
): Promise<{ session: string; credential: string; expiresIn: number }> {
  if (!/^rrt_[A-Za-z0-9_-]{16,200}$/.test(credential))
    throw rejected(401, "runner.invalid_token", "This runner is not paired; pair it again");
  const hash = sha256Hex(credential);
  const [row] = await deps.db
    .select()
    .from(runners)
    .where(
      or(eq(runners.tokenHash, hash), eq(runners.tokenPendingHash, hash), eq(runners.tokenPrevHash, hash)),
    );
  if (!row) throw rejected(401, "runner.invalid_token", "This runner is not paired; pair it again");
  if (row.removedAt) throw rejected(403, "runner.revoked", "This runner was removed from the workspace");
  if (row.revokedAt) throw rejected(403, "runner.revoked", "This runner's access was revoked; pair it again");
  if (row.tokenPrevHash === hash) {
    // The credential that was already replaced came back: there is another copy out there. Revoke everything.
    await revokeRunner(deps, row, "reuse");
    throw rejected(
      403,
      "runner.revoked",
      "This runner's credential was used from somewhere else; pair it again",
    );
  }
  const now = deps.now();
  const next = newCredential();
  // Used the pending one: it becomes the current one and the current becomes the old. Used the current: only the pending changes.
  const promote = row.tokenPendingHash === hash;
  return deps.db.transaction(async (tx) => {
    const updated = await tx
      .update(runners)
      .set({
        ...(promote ? { tokenHash: hash, tokenPrevHash: row.tokenHash } : {}),
        tokenPendingHash: sha256Hex(next),
        credentialRotatedAt: now,
        updatedAt: now,
      })
      // Two sessions at once with the same credential: only one rotates (the pending one is part of the state read,
      // or both would pass when the current one doesn't change, and the runner would keep a credential nobody holds).
      .where(
        and(
          eq(runners.id, row.id),
          eq(runners.tokenHash, row.tokenHash),
          sql`${runners.tokenPendingHash} is not distinct from ${row.tokenPendingHash}`,
          isNull(runners.revokedAt),
          isNull(runners.removedAt),
        ),
      )
      .returning({ id: runners.id });
    if (updated.length === 0) throw new HttpError(409, "runner.busy", "Try again in a moment");
    const session = newSession();
    await tx
      .delete(runnerSessions)
      .where(and(eq(runnerSessions.runnerId, row.id), lt(runnerSessions.expiresAt, now)));
    await tx.insert(runnerSessions).values({
      tokenHash: sha256Hex(session),
      runnerId: row.id,
      credentialHash: sha256Hex(next),
      expiresAt: new Date(now.getTime() + SESSION_TTL_S * 1000),
    });
    return { session, credential: next, expiresIn: SESSION_TTL_S };
  });
}

/** Spends the `hello` session: good once, within the deadline, for a runner that isn't revoked. */
export async function consumeSession(deps: AppDeps, session: string): Promise<RunnerRow | null> {
  const now = deps.now();
  return deps.db.transaction(async (tx) => {
    const [candidate] = await tx
      .select()
      .from(runnerSessions)
      .where(eq(runnerSessions.tokenHash, sha256Hex(session)));
    if (!candidate) return null;
    // Lock the runner before the session, in the same order as issuance and revocation.
    const [active] = await tx
      .select()
      .from(runners)
      .where(and(eq(runners.id, candidate.runnerId), isNull(runners.revokedAt), isNull(runners.removedAt)))
      .for("update");
    if (!active || (candidate.credentialHash && active.tokenPendingHash !== candidate.credentialHash))
      return null;
    const [used] = await tx
      .update(runnerSessions)
      .set({ usedAt: now })
      .where(
        and(
          eq(runnerSessions.tokenHash, sha256Hex(session)),
          isNull(runnerSessions.usedAt),
          gt(runnerSessions.expiresAt, now),
        ),
      )
      .returning({ runnerId: runnerSessions.runnerId, credentialHash: runnerSessions.credentialHash });
    if (!used) return null;
    if (!used.credentialHash) return active;
    const [row] = await tx
      .update(runners)
      .set({
        tokenPrevHash: active.tokenHash,
        tokenHash: used.credentialHash,
        tokenPendingHash: null,
        credentialRotatedAt: now,
      })
      .where(eq(runners.id, active.id))
      .returning();
    return row ?? null;
  });
}
