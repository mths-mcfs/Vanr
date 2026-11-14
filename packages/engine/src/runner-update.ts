// Signed runner updates. The server signs the bundle manifest (version, sha256, size) with Ed25519; the
// runner checks it with the public key pinned in its own code and rejects a manifest without a signature, with
// a wrong signature or with an equal or older version. Keys travel raw in base64 (32 bytes): the private one
// is the seed, the public one is the point.
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
  sign,
  verify,
} from "node:crypto";
import { z } from "zod";

/** Separates this signature from any other made with the same key. */
const DOMAIN = "runner-update/v1";
const PKCS8_ED25519 = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_ED25519 = Buffer.from("302a300506032b6570032100", "hex");

const VERSION_RE = /^\d{1,6}\.\d{1,6}\.\d{1,6}$/;

export const updateManifest = z.object({
  version: z.string().regex(VERSION_RE),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  size: z
    .number()
    .int()
    .min(1)
    .max(50 * 1024 * 1024),
  /** Path of the bundle on the server (the signed sha256 is what guarantees the content). */
  url: z.string().startsWith("/").max(200),
  signature: z.string().max(200).optional(),
});
export type UpdateManifest = z.infer<typeof updateManifest>;

/** The signed bytes: only what decides what runs (version and content). */
const manifestBytes = (m: Pick<UpdateManifest, "version" | "sha256" | "size">) =>
  Buffer.from(`${DOMAIN}\n${m.version}\n${m.sha256}\n${m.size}\n`, "utf8");

const raw32 = (b64: string, what: string) => {
  const buf = Buffer.from(b64.trim(), "base64");
  if (buf.length !== 32) throw new Error(`${what} must be 32 bytes in base64`);
  return buf;
};

const privateKeyOf = (seedB64: string): KeyObject =>
  createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519, raw32(seedB64, "Signing key")]),
    format: "der",
    type: "pkcs8",
  });

const publicKeyOf = (rawB64: string): KeyObject =>
  createPublicKey({
    key: Buffer.concat([SPKI_ED25519, raw32(rawB64, "Public key")]),
    format: "der",
    type: "spki",
  });

/** Public key (raw base64) that matches the seed. */
export const publicKeyFor = (seedB64: string) =>
  createPublicKey(privateKeyOf(seedB64))
    .export({ format: "der", type: "spki" })
    .subarray(12)
    .toString("base64");

export function signManifest(
  m: Pick<UpdateManifest, "version" | "sha256" | "size">,
  seedB64: string,
): string {
  return sign(null, manifestBytes(m), privateKeyOf(seedB64)).toString("base64");
}

export function verifyManifest(m: UpdateManifest, publicKeyB64: string): boolean {
  if (!m.signature) return false;
  const sig = Buffer.from(m.signature, "base64");
  if (sig.length !== 64) return false;
  try {
    return verify(null, manifestBytes(m), publicKeyOf(publicKeyB64), sig);
  } catch {
    return false;
  }
}

/** -1, 0 or 1. Only numeric `x.y.z`; anything else is an error (a version that does not compare does not install). */
export function compareVersions(a: string, b: string): number {
  if (!VERSION_RE.test(a) || !VERSION_RE.test(b)) throw new Error(`Bad version: ${a} / ${b}`);
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] as number) - (pb[i] as number);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** New key pair (for the runner signing key script): seed and public key, both in base64. */
export function generateUpdateKeys(): { seed: string; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    seed: privateKey.export({ format: "der", type: "pkcs8" }).subarray(16).toString("base64"),
    publicKey: publicKey.export({ format: "der", type: "spki" }).subarray(12).toString("base64"),
  };
}
