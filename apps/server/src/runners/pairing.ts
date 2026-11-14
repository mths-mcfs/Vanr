// Pairing by device code (RFC 8628). The runner asks for a code; the person confirms it on /connect, choosing
// the workspace; the runner fetches the device credential. It only exists sealed between the confirmation and
// the fetch, and after that the database keeps only its hash (it rotates on every session, see credentials.ts).
import { can, type Runner, type RunnerPairing } from "@vanr/contract";
import { schema } from "@vanr/engine/db";
import { newId, newToken, sha256Hex } from "@vanr/engine/ids";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import type { AppDeps, WorkspaceMember } from "../context";
import { forbidden, HttpError } from "../http";
import { newCredential } from "./credentials";
import { canManageRunner, runnerSealer, toRunner } from "./runners";

const { runnerPairings, runners, runnerSessions, members, workspaces } = schema;

export const PAIRING_TTL_S = 600;
export const POLL_INTERVAL_S = 3;
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export const pairingStartInput = z.object({
  name: z.string().trim().max(80).optional(),
  os: z.string().trim().min(1).max(40),
  arch: z.string().trim().min(1).max(40),
  hostname: z.string().trim().min(1).max(200),
  version: z.string().trim().min(1).max(40),
  previousRunnerId: z.string().max(64).optional(),
});

/** Normalizes what the person typed or the `?code=`: uppercase, without separators or ambiguous letters. */
export const normalizeUserCode = (raw: string) =>
  raw
    .toUpperCase()
    .split("")
    .filter((c) => CODE_ALPHABET.includes(c))
    .join("")
    .slice(0, 12);

function userCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
}

const invalid = () => new HttpError(404, "runner.pairing_invalid", "This code expired or was already used");

export async function startPairing(deps: AppDeps, input: z.infer<typeof pairingStartInput>) {
  const deviceCode = newToken(32);
  const expiresAt = new Date(deps.now().getTime() + PAIRING_TTL_S * 1000);
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = userCode();
    const inserted = await deps.db
      .insert(runnerPairings)
      .values({
        userCode: code,
        deviceCodeHash: sha256Hex(deviceCode),
        name: input.name ?? "",
        os: input.os,
        arch: input.arch,
        hostname: input.hostname,
        version: input.version,
        previousRunnerId: input.previousRunnerId ?? null,
        expiresAt,
      })
      .onConflictDoNothing()
      .returning({ userCode: runnerPairings.userCode });
    if (inserted.length)
      return {
        deviceCode,
        userCode: code,
        verificationUrl: `${deps.config.publicUrl}/connect?code=${code}`,
        expiresIn: PAIRING_TTL_S,
        interval: POLL_INTERVAL_S,
      };
  }
  throw new HttpError(503, "runner.pairing_busy", "Try again in a moment");
}

type PollResult =
  | {
      status: 200;
      body: { token: string; runnerId: string; name: string; workspace: { id: string; name: string } };
    }
  | {
      status: 400;
      body: { error: "authorization_pending" | "slow_down" | "access_denied" | "expired_token" };
    };

export async function pollPairing(deps: AppDeps, deviceCode: string): Promise<PollResult> {
  const [row] = await deps.db
    .select()
    .from(runnerPairings)
    .where(eq(runnerPairings.deviceCodeHash, sha256Hex(deviceCode)));
  const now = deps.now();
  if (!row || row.status === "claimed" || row.expiresAt <= now)
    return { status: 400, body: { error: "expired_token" } };
  if (row.status === "denied") return { status: 400, body: { error: "access_denied" } };
  if (row.status === "pending") {
    const tooSoon =
      row.lastPollAt && now.getTime() - row.lastPollAt.getTime() < (row.intervalSeconds - 1) * 1000;
    await deps.db
      .update(runnerPairings)
      .set({ lastPollAt: now, ...(tooSoon ? { intervalSeconds: row.intervalSeconds + 5 } : {}) })
      .where(eq(runnerPairings.userCode, row.userCode));
    return { status: 400, body: { error: tooSoon ? "slow_down" : "authorization_pending" } };
  }
  // approved: handed over once only.
  const [claimed] = await deps.db
    .update(runnerPairings)
    .set({ status: "claimed", tokenSealed: null })
    .where(and(eq(runnerPairings.userCode, row.userCode), eq(runnerPairings.status, "approved")))
    .returning();
  if (!claimed || !row.tokenSealed || !row.runnerId || !row.workspaceId)
    return { status: 400, body: { error: "expired_token" } };
  const [runner] = await deps.db.select().from(runners).where(eq(runners.id, row.runnerId));
  const [workspace] = await deps.db.select().from(workspaces).where(eq(workspaces.id, row.workspaceId));
  return {
    status: 200,
    body: {
      token: runnerSealer(deps).open(row.tokenSealed),
      runnerId: row.runnerId,
      name: runner?.name ?? row.name,
      workspace: { id: row.workspaceId, name: workspace?.name ?? "" },
    },
  };
}

async function pendingRequest(deps: AppDeps, raw: string) {
  const code = normalizeUserCode(raw);
  const [row] = await deps.db.select().from(runnerPairings).where(eq(runnerPairings.userCode, code));
  if (row?.status !== "pending" || row.expiresAt <= deps.now()) throw invalid();
  return row;
}

export async function describePairing(deps: AppDeps, raw: string, userId: string): Promise<RunnerPairing> {
  const row = await pendingRequest(deps, raw);
  let reconnect: RunnerPairing["reconnect"] = null;
  if (row.previousRunnerId) {
    const [m] = await deps.db
      .select({ runner: runners, role: members.role })
      .from(runners)
      .innerJoin(members, and(eq(members.workspaceId, runners.workspaceId), eq(members.userId, userId)))
      .where(and(eq(runners.id, row.previousRunnerId), isNull(runners.removedAt)));
    // The same rule as confirmPairing: only who manages the runner reuses it; everyone else pairs another one.
    if (m && canManageRunner({ userId, role: m.role }, m.runner)) {
      reconnect = { runnerId: m.runner.id, workspaceId: m.runner.workspaceId };
    }
  }
  return {
    userCode: row.userCode,
    name: row.name || row.hostname,
    os: row.os,
    arch: row.arch,
    hostname: row.hostname,
    coarseLocation: null,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    reconnect,
  };
}

export async function confirmPairing(
  deps: AppDeps,
  member: WorkspaceMember,
  raw: string,
  input: { name?: string },
): Promise<Runner> {
  const row = await pendingRequest(deps, raw);
  const token = newCredential();
  const sealer = runnerSealer(deps);
  const [previous] = row.previousRunnerId
    ? await deps.db
        .select()
        .from(runners)
        .where(
          and(
            eq(runners.id, row.previousRunnerId),
            eq(runners.workspaceId, member.workspaceId),
            isNull(runners.removedAt),
          ),
        )
    : [];
  const reconnect = previous && canManageRunner(member, previous) ? previous : null;
  const runnerId = reconnect?.id ?? newId("rnr");
  // Approving and swapping the credential together: if the code was already used, the old runner keeps its own.
  await deps.db.transaction(async (tx) => {
    const approved = await tx
      .update(runnerPairings)
      .set({
        status: "approved",
        workspaceId: member.workspaceId,
        runnerId,
        signedOffBy: member.userId,
        tokenSealed: sealer.seal(token),
      })
      .where(and(eq(runnerPairings.userCode, row.userCode), eq(runnerPairings.status, "pending")))
      .returning({ userCode: runnerPairings.userCode });
    if (approved.length === 0) throw invalid();
    if (reconnect) {
      // Reconnecting the same runner: a new credential (the pending one and the old one die, a revocation
      // ends) and the same secrets key (they keep opening).
      await tx
        .update(runners)
        .set({
          tokenHash: sha256Hex(token),
          tokenPendingHash: null,
          tokenPrevHash: null,
          revokedAt: null,
          revokedReason: null,
          credentialRotatedAt: deps.now(),
          updatedAt: deps.now(),
        })
        .where(eq(runners.id, reconnect.id));
      await tx.delete(runnerSessions).where(eq(runnerSessions.runnerId, reconnect.id));
    } else {
      const storeKey = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
      await tx.insert(runners).values({
        id: runnerId,
        workspaceId: member.workspaceId,
        name: (input.name?.trim() || row.name || row.hostname).slice(0, 80),
        os: row.os,
        arch: row.arch,
        hostname: row.hostname,
        runnerRelease: row.version,
        tokenHash: sha256Hex(token),
        credentialRotatedAt: deps.now(),
        storeKey: sealer.seal(storeKey),
        pairedByUserId: member.userId,
      });
    }
  });
  if (reconnect)
    deps.runners.close(reconnect.id, { type: "rejected", reason: "replaced", message: "Paired again" });
  const [runner] = await deps.db.select().from(runners).where(eq(runners.id, runnerId));
  if (!runner) throw invalid();
  deps.hub.toWorkspace(member.workspaceId, { type: "runner.paired", runnerId });
  return toRunner(deps, runner, member);
}

/**
 * Denying a request also requires being able to pair in some workspace: without that, any account holding the
 * code (it shows in the terminal and in the URL) could break someone else's pairing.
 */
export async function denyPairing(deps: AppDeps, raw: string, userId: string): Promise<void> {
  const roles = await deps.db.select({ role: members.role }).from(members).where(eq(members.userId, userId));
  if (!roles.some((m) => can(m.role, "post")))
    throw forbidden("Only who can pair runners can deny a request");
  const row = await pendingRequest(deps, raw);
  await deps.db
    .update(runnerPairings)
    .set({ status: "denied" })
    .where(and(eq(runnerPairings.userCode, row.userCode), eq(runnerPairings.status, "pending")));
}

/** Pairing requires being able to post in the workspace (the same the pairing page asks to show the workspace). */
export const canPair = (member: WorkspaceMember) => can(member.role, "post");
