// Secret requests and the secrets an agent holds.

export type SecretTarget = { kind: "env" } | { kind: "file"; path: string };

/** Browser secret: only typed on these sites and in this kind of field (sealed along with the value). */
export interface SecretBrowserBinding {
  field: "password" | "text";
  sites: string[];
}

export interface SecretRequest {
  id: string;
  agentId: string;
  /** Bound to sites and field; null = command secret (variable or file). */
  browser: SecretBrowserBinding | null;
  channelId: string | null;
  createdAt: string;
  deciderUserId: string | null;
  expiresAt: string;
  fulfilledAt: string | null;
  name: string;
  publicKey: string;
  purpose: string;
  runnerId: string;
  status: "canceled" | "declined" | "delivered" | "expired" | "pending";
  target: SecretTarget;
  targetUserId: string | null;
}

/** Value encrypted in the browser (ECDH P-256 + HKDF-SHA256 + AES-256-GCM). The server never sees the value. */
export interface SecretBox {
  ct: string;
  epk: string;
  iv: string;
  v: 1;
}

export interface AgentSecret {
  browser: SecretBrowserBinding | null;
  fulfilledAt: string;
  fulfilledByUserId: string;
  name: string;
  runnerId: string;
  target: SecretTarget;
}
