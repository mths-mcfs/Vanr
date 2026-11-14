// Encryption of secrets stored in the database (the credentials' API keys).
// AES-256-GCM with a key derived from the server secret by HKDF-SHA256; each use has its own `info`, so the
// same master key does not serve two purposes.
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

const VERSION = "v1";

export interface Sealer {
  seal(plain: string): string;
  open(sealed: string): string;
}

export function createSealer(masterSecret: string, purpose: string): Sealer {
  const key = Buffer.from(hkdfSync("sha256", masterSecret, "vanr-seal", purpose, 32));
  return {
    seal(plain) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
      const tag = cipher.getAuthTag();
      return [VERSION, iv.toString("base64url"), tag.toString("base64url"), body.toString("base64url")].join(
        ".",
      );
    },
    open(sealed) {
      const [version, iv, tag, body] = sealed.split(".");
      if (version !== VERSION || !iv || !tag || body === undefined) throw new Error("Unknown sealed format");
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
      decipher.setAuthTag(Buffer.from(tag, "base64url"));
      return Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString(
        "utf8",
      );
    },
  };
}

/** Hint to show the key without revealing it: the prefix and the last 4 characters. */
export function keyPreview(key: string): string {
  const prefix = key.startsWith("sk-ant-") ? "sk-ant-" : key.startsWith("sk-") ? "sk-" : "";
  return `${prefix}…${key.slice(-4)}`;
}
