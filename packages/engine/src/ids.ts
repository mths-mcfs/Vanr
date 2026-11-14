import { createHash } from "node:crypto";

// Opaque ids with a prefix per kind (usr_, ch_, msg_...). The prefix helps when reading logs; the rest is random.
const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

export function randomId(size = 16): string {
  const bytes = crypto.getRandomValues(new Uint8Array(size));
  let out = "";
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return out;
}

export function newId(prefix: string): string {
  return `${prefix}_${randomId()}`;
}

/** Long token for links (invitation, device code). 32 bytes in base64url. */
export function newToken(bytes = 32): string {
  const raw = crypto.getRandomValues(new Uint8Array(bytes));
  return Buffer.from(raw).toString("base64url");
}

export function sha256Hex(text: string | Uint8Array): string {
  return createHash("sha256").update(text).digest("hex");
}
