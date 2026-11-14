import type { Role } from "@vanr/contract";
import type { BlobStore } from "@vanr/engine/blobs";
import type { Db } from "@vanr/engine/db";
import type { Sealer } from "@vanr/engine/seal";
import type { SqlConnector } from "@vanr/engine/sqlconn";
import type { UsageLedger } from "@vanr/engine/usage";
import type { Context } from "hono";
import type { Auth } from "./auth";
import type { Config } from "./config";
import { unauthorized } from "./http";
import type { Mailer } from "./mailer";
import type { PushSender } from "./push";
import type { Hub } from "./realtime/hub";
import type { RunnerHub } from "./runners/hub";

/** Everything the routes need. Each slice of the server adds what it uses. */
export interface AppDeps {
  config: Config;
  db: Db;
  auth: Auth;
  mailer: Mailer;
  /** Files; the Drive's go to the workspace's S3 once it configured one. */
  blobs: BlobStore;
  /** The server's own storage (the source of a migration to S3). */
  localBlobs: BlobStore;
  now: () => Date;
  /** Real time: who is connected and where each event goes. */
  hub: Hub;
  /**
   * Usage ledger and cap: every model call reserves before and records after. Routines, assignments,
   * debates and teams use it through here, with their own scopes.
   */
  ledger: UsageLedger;
  /** Cipher of the API keys kept in the database. */
  sealer: Sealer;
  /** Outgoing requests (GitHub). Tests replace it with a fake one. */
  fetchExternal: typeof fetch;
  /** Connection to the databases workspaces connect (a real Postgres; PGlite in the tests). */
  sql: SqlConnector;
  /** Paired runners connected now and the RPC with them. */
  runners: RunnerHub;
  /** Web Push (VAPID): public key and encrypted sending. */
  push: PushSender;
}

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  image: string | null;
}

export interface WorkspaceMember {
  workspaceId: string;
  userId: string;
  role: Role;
  handle: string;
}

export type AppEnv = {
  Variables: {
    deps: AppDeps;
    user: SessionUser | null;
    /** Set by the middleware of /api/v1/workspaces/:workspaceId. */
    member: WorkspaceMember | null;
  };
};

export type Ctx = Context<AppEnv>;

export function requireUser(c: Ctx): SessionUser {
  const user = c.get("user");
  if (!user) throw unauthorized();
  return user;
}
