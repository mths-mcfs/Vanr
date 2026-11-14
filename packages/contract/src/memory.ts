// Agent memory: items, versions and reviews.

import type { ActorRef } from "./common.ts";

export interface ConsolidatedMemoryItem {
  action: "drop" | "keep" | "merge" | "rewrite";
  path: string | null;
  reason: string;
  /** Ids of the source items. */
  sources: string[];
  text: string;
  /** At least one source came from an untrusted origin. */
  untrustedSource: boolean;
}

/** New set proposed for the agent's memory. Nothing changes until it is applied. */
export interface MemoryConsolidation {
  id: string;
  agentId: string;
  /** Items read and items active in the store (reading is capped). */
  covered: number;
  createdAt: string;
  decidedAt: string | null;
  error: string | null;
  items: ConsolidatedMemoryItem[];
  status: "applied" | "discarded" | "failed" | "ready" | "running";
  total: number;
}

export type MemoryKind = "decision" | "fact" | "lesson" | "preference";

/** Memory store: the agent's, the person's (only they see it) or the workspace's (the agent only reads). */
export type MemoryScope = "agent" | "person" | "workspace";

export interface MemoryOrigin {
  at: string;
  by: ActorRef | null;
  channel: string | null;
  name: string | null;
  /** Run that wrote it (agent write). */
  runId?: string | null;
  /** What outside content the run had read when it wrote (flag A). */
  untrusted?: string[];
}

export interface Memory {
  id: string;
  about: string | null;
  /** Owner in the agent store; writer in the person store; null in the workspace store. */
  agentId: string | null;
  archived: boolean;
  createdAt: string;
  editorUserId: string | null;
  kind: MemoryKind;
  lastUsedAt: string | null;
  origin: MemoryOrigin | null;
  /** File in the store (`clients/acme.md`); null for short notes saved by `remember`. */
  path: string | null;
  pinned: boolean;
  replaces: string | null;
  scope: MemoryScope;
  /** SHA-256 of the text: send it back in `updateMemory` so you do not overwrite someone else's change. */
  sha256: string;
  source: string | null;
  text: string;
  untrustedSource: boolean;
  updatedAt: string;
  uses: number;
  verified: boolean;
}

/** An immutable version of a memory item: the whole state after the change. */
export interface MemoryVersion {
  id: string;
  approvedByUserId: string | null;
  archived: boolean;
  author: { id: string | null; type: "agent" | "person" | "system" };
  createdAt: string;
  memoryId: string;
  op: "archive" | "create" | "initial" | "rename" | "restore" | "unarchive" | "update";
  path: string | null;
  reason: string;
  restoredFromSeq: number | null;
  runId: string | null;
  seq: number;
  sha256: string;
  text: string;
}

/** Memory write from a run that read outside content: waits for a person. */
export interface MemoryReview {
  id: string;
  about: string | null;
  agentId: string;
  createdAt: string;
  decidedAt: string | null;
  deciderUserId: string | null;
  kind: MemoryKind;
  memoryId: string | null;
  newPath: string | null;
  note: string | null;
  op: "archive" | "create" | "rename" | "update";
  origin: MemoryOrigin;
  path: string | null;
  /** What raised flag A (`mail_read inbox/INBOX/42`). */
  reasons: string[];
  resultMemoryId: string | null;
  runId: string | null;
  scope: "agent" | "person";
  status: "approved" | "failed" | "pending" | "rejected";
  /** The text that stays if approved. */
  text: string;
  tool: string;
}
