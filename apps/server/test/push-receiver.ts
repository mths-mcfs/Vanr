// The browser's side of Web Push, written from scratch from the RFCs, to check what the server sends without
// a network: the "browser" keys, decrypting the aes128gcm body (RFC 8291) and checking the VAPID JWT
// (RFC 8292). It is a second implementation, independent from `web-push`: if the two disagree, the test fails.
import { createDecipheriv, createECDH, createHmac, createPublicKey, verify } from "node:crypto";

export interface Browser {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  decrypt(body: Uint8Array): unknown;
}

const hmac = (key: Uint8Array, data: Uint8Array) => createHmac("sha256", key).update(data).digest();
const cat = (...parts: Uint8Array[]) => Buffer.concat(parts.map((p) => Buffer.from(p)));
const text = (s: string) => Buffer.from(s, "utf8");

export function fakeBrowser(endpoint: string): Browser {
  const ecdh = createECDH("prime256v1");
  const uaPublic = ecdh.generateKeys();
  const auth = Buffer.from(crypto.getRandomValues(new Uint8Array(16)));
  return {
    endpoint,
    keys: { p256dh: uaPublic.toString("base64url"), auth: auth.toString("base64url") },
    decrypt(body) {
      const buf = Buffer.from(body);
      const salt = buf.subarray(0, 16);
      const idlen = buf[20] ?? 0;
      const asPublic = buf.subarray(21, 21 + idlen);
      const ciphertext = buf.subarray(21 + idlen);
      const secret = ecdh.computeSecret(asPublic);
      const prkKey = hmac(auth, secret);
      const ikm = hmac(
        prkKey,
        cat(text("WebPush: info"), Buffer.from([0]), uaPublic, asPublic, Buffer.from([1])),
      );
      const prk = hmac(salt, ikm);
      const cek = hmac(prk, cat(text("Content-Encoding: aes128gcm"), Buffer.from([0, 1]))).subarray(0, 16);
      const nonce = hmac(prk, cat(text("Content-Encoding: nonce"), Buffer.from([0, 1]))).subarray(0, 12);
      const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
      decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
      const plain = Buffer.concat([
        decipher.update(ciphertext.subarray(0, ciphertext.length - 16)),
        decipher.final(),
      ]);
      // A single record: content, the 0x02 delimiter and padding zeros.
      let end = plain.length - 1;
      while (end >= 0 && plain[end] === 0) end--;
      if (plain[end] !== 2) throw new Error("bad padding delimiter");
      return JSON.parse(plain.subarray(0, end).toString("utf8"));
    },
  };
}

/** Checks the `vapid t=<jwt>, k=<key>` header: ES256 signature, `aud` and validity. */
export function checkVapid(header: string, endpoint: string, publicKey: string, now: number) {
  const m = /^vapid t=([^,]+),\s*k=(.+)$/.exec(header);
  if (!m?.[1] || !m[2]) throw new Error(`bad vapid header: ${header}`);
  if (m[2] !== publicKey) throw new Error("vapid key differs from the server key");
  const [h, p, sig] = m[1].split(".");
  if (!h || !p || !sig) throw new Error("bad jwt");
  const raw = Buffer.from(publicKey, "base64url");
  const key = createPublicKey({
    key: {
      kty: "EC",
      crv: "P-256",
      x: raw.subarray(1, 33).toString("base64url"),
      y: raw.subarray(33, 65).toString("base64url"),
    },
    format: "jwk",
  });
  const ok = verify(
    "sha256",
    Buffer.from(`${h}.${p}`),
    { key, dsaEncoding: "ieee-p1363" },
    Buffer.from(sig, "base64url"),
  );
  if (!ok) throw new Error("vapid signature does not verify");
  const claims = JSON.parse(Buffer.from(p, "base64url").toString()) as {
    aud: string;
    exp: number;
    sub: string;
  };
  if (claims.aud !== new URL(endpoint).origin) throw new Error(`aud ${claims.aud}`);
  if (claims.exp * 1000 <= now || claims.exp * 1000 > now + 24 * 3_600_000 + 60_000) throw new Error("exp");
  return claims;
}
