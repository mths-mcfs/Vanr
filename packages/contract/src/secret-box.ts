// Sealed box for secrets. The agent's environment generates a P-256 key pair for a single request and
// publishes the public key; the browser seals the value with ECDH (ephemeral key) -> HKDF-SHA256 ->
// AES-256-GCM, with the request bound as additional authenticated data. The server only relays the box:
// the environment opens it. Plain WebCrypto: runs the same in the browser, Bun and Node 22+.

export const SECRET_MAX_BYTES = 16 * 1024;

export interface SecretBinding {
  requestId: string;
  workspaceId: string;
  name: string;
  /** `env` or `file:<path>`. */
  target: string;
  /** Sites and field where the agent's browser may type the value; without it, never in the browser. */
  browser?: { sites: string[]; field: string } | null;
}

export interface SealedBox {
  v: 1;
  /** The browser's ephemeral public key, uncompressed point in base64. */
  epk: string;
  iv: string;
  ct: string;
}

const enc = new TextEncoder();

const dec = new TextDecoder();

const ECDH = { name: "ECDH", namedCurve: "P-256" } as const;

const toB64 = (bytes: ArrayBuffer | Uint8Array) => {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of arr) s += String.fromCharCode(b);
  return btoa(s);
};

const fromB64 = (b64: string) => {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
};

/** Authenticated data: the box only opens for the same request, workspace, name, target and browser sites. */
export const bindingBytes = (b: SecretBinding) =>
  enc.encode(
    JSON.stringify(
      b.browser
        ? [b.requestId, b.workspaceId, b.name, b.target, b.browser.sites, b.browser.field]
        : [b.requestId, b.workspaceId, b.name, b.target],
    ),
  );

async function aesKey(privateKey: CryptoKey, publicKey: CryptoKey, salt: Uint8Array<ArrayBuffer>) {
  const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: publicKey }, privateKey, 256);
  const ikm = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info: enc.encode("secret-box/v1") },
    ikm,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Key pair for the request (environment side). The public key goes to the server in base64. */
export async function createRecipient(): Promise<{ privateKey: CryptoKey; publicKey: string }> {
  const pair = await crypto.subtle.generateKey(ECDH, true, ["deriveBits"]);
  const raw = await crypto.subtle.exportKey("raw", pair.publicKey);
  return { privateKey: pair.privateKey, publicKey: toB64(raw) };
}

/** The request's private key as PKCS#8 base64 (the environment keeps it encrypted until the value arrives). */
export async function exportRecipient(privateKey: CryptoKey): Promise<string> {
  return toB64(await crypto.subtle.exportKey("pkcs8", privateKey));
}

export async function importRecipient(pkcs8: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("pkcs8", fromB64(pkcs8), ECDH, false, ["deriveBits"]);
}

export class SecretTooLarge extends Error {
  constructor() {
    super(`Secret is larger than ${SECRET_MAX_BYTES} bytes`);
  }
}

/** Seals the value for the request's public key (browser side). */
export async function sealSecret(
  publicKeyB64: string,
  value: string,
  binding: SecretBinding,
): Promise<SealedBox> {
  const plain = enc.encode(value);
  if (plain.byteLength > SECRET_MAX_BYTES) throw new SecretTooLarge();
  const recipient = await crypto.subtle.importKey("raw", fromB64(publicKeyB64), ECDH, false, []);
  const eph = await crypto.subtle.generateKey(ECDH, true, ["deriveBits"]);
  const epk = new Uint8Array(await crypto.subtle.exportKey("raw", eph.publicKey));
  const key = await aesKey(eph.privateKey, recipient, epk);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: bindingBytes(binding) },
    key,
    plain,
  );
  return { v: 1, epk: toB64(epk), iv: toB64(iv), ct: toB64(ct) };
}

/** Opens the box with the request's private key (environment side). Throws if the request does not match. */
export async function openSecret(
  privateKey: CryptoKey,
  box: SealedBox,
  binding: SecretBinding,
): Promise<string> {
  if (box.v !== 1) throw new Error("Unknown box version");
  const epk = fromB64(box.epk);
  const sender = await crypto.subtle.importKey("raw", epk, ECDH, false, []);
  const key = await aesKey(privateKey, sender, epk);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromB64(box.iv), additionalData: bindingBytes(binding) },
    key,
    fromB64(box.ct),
  );
  return dec.decode(plain);
}

/** Shape check at the boundary (the server receives the box from outside and only relays it). */
export function isSealedBox(v: unknown): v is SealedBox {
  if (typeof v !== "object" || v === null) return false;
  const b = v as Record<string, unknown>;
  const b64 = (x: unknown, max: number) =>
    typeof x === "string" && x.length > 0 && x.length <= max && /^[A-Za-z0-9+/]+=*$/.test(x);
  return (
    b.v === 1 && b64(b.epk, 200) && b64(b.iv, 40) && b64(b.ct, Math.ceil((SECRET_MAX_BYTES + 16) / 3) * 4 + 4)
  );
}
