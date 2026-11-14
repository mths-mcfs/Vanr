import { describe, expect, test } from "bun:test";
import {
  createRecipient,
  exportRecipient,
  importRecipient,
  isSealedBox,
  openSecret,
  SECRET_MAX_BYTES,
  type SealedBox,
  type SecretBinding,
  SecretTooLarge,
  sealSecret,
} from "./secret-box.ts";

const binding: SecretBinding = { requestId: "sr_1", workspaceId: "ws_1", name: "API_TOKEN", target: "env" };
const browserBinding: SecretBinding = {
  ...binding,
  browser: { sites: ["example.com", "*.example.net"], field: "password" },
};

const b64Bytes = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const bytesB64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
/** Flips one bit of a base64 field, keeping it valid base64 of the same length. */
const flip = (s: string, at = 0) => {
  const b = b64Bytes(s);
  b[at] = (b[at] ?? 0) ^ 1;
  return bytesB64(b);
};

describe("secret box round trip", () => {
  test("the environment opens what the browser sealed, also after exporting the key", async () => {
    const r = await createRecipient();
    const value = "s3cr3t-\u00e7\u00e3o-\u{1f511}";
    const box = await sealSecret(r.publicKey, value, binding);
    expect(isSealedBox(box)).toBe(true);
    expect(JSON.stringify(box)).not.toContain("s3cr3t");
    expect(await openSecret(r.privateKey, box, binding)).toBe(value);

    const again = await importRecipient(await exportRecipient(r.privateKey));
    expect(await openSecret(again, box, binding)).toBe(value);
  });

  test("an empty value and a browser-bound value both round trip", async () => {
    const r = await createRecipient();
    expect(await openSecret(r.privateKey, await sealSecret(r.publicKey, "", binding), binding)).toBe("");
    const box = await sealSecret(r.publicKey, "pw", browserBinding);
    expect(await openSecret(r.privateKey, box, browserBinding)).toBe("pw");
  });

  test("every seal uses a fresh ephemeral key and iv", async () => {
    const r = await createRecipient();
    const a = await sealSecret(r.publicKey, "same", binding);
    const b = await sealSecret(r.publicKey, "same", binding);
    expect(a.epk).not.toBe(b.epk);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ct).not.toBe(b.ct);
  });

  test("the envelope keeps its format: v1, P-256 point, 12-byte iv, GCM tag", async () => {
    const r = await createRecipient();
    const value = "abc";
    const box = await sealSecret(r.publicKey, value, binding);
    expect(Object.keys(box).sort()).toEqual(["ct", "epk", "iv", "v"]);
    expect(box.v).toBe(1);
    const epk = b64Bytes(box.epk);
    expect(epk.length).toBe(65);
    expect(epk[0]).toBe(4);
    expect(b64Bytes(box.iv).length).toBe(12);
    expect(b64Bytes(box.ct).length).toBe(new TextEncoder().encode(value).length + 16);
    expect(b64Bytes(r.publicKey).length).toBe(65);
  });
});

describe("secret box rejects what it must not open", () => {
  test("the wrong private key does not open the box", async () => {
    const r = await createRecipient();
    const box = await sealSecret(r.publicKey, "x", binding);
    const stranger = await createRecipient();
    await expect(openSecret(stranger.privateKey, box, binding)).rejects.toThrow();
  });

  test("a box bound to another request, workspace, name, target or browser binding does not open", async () => {
    const r = await createRecipient();
    const box = await sealSecret(r.publicKey, "x", browserBinding);
    const others: SecretBinding[] = [
      { ...browserBinding, requestId: "sr_2" },
      { ...browserBinding, workspaceId: "ws_2" },
      { ...browserBinding, name: "OTHER" },
      { ...browserBinding, target: "file:/tmp/token" },
      { ...browserBinding, browser: { sites: ["example.com"], field: "password" } },
      { ...browserBinding, browser: { sites: ["example.com", "*.example.net"], field: "email" } },
      { ...browserBinding, browser: null },
      binding,
    ];
    for (const other of others) {
      await expect(openSecret(r.privateKey, box, other)).rejects.toThrow();
    }
  });

  test("a tampered ciphertext, iv or ephemeral key does not open", async () => {
    const r = await createRecipient();
    const box = await sealSecret(r.publicKey, "tamper me", binding);
    const ctLast = b64Bytes(box.ct).length - 1;
    const tampered: SealedBox[] = [
      { ...box, ct: flip(box.ct) },
      { ...box, ct: flip(box.ct, ctLast) },
      { ...box, iv: flip(box.iv) },
      { ...box, epk: flip(box.epk, 64) },
      { ...box, ct: bytesB64(b64Bytes(box.ct).slice(0, -1)) },
    ];
    for (const t of tampered) {
      await expect(openSecret(r.privateKey, t, binding)).rejects.toThrow();
    }
  });

  test("an unknown box version is rejected before decrypting", async () => {
    const r = await createRecipient();
    const box = await sealSecret(r.publicKey, "x", binding);
    const v2 = { ...box, v: 2 } as unknown as SealedBox;
    await expect(openSecret(r.privateKey, v2, binding)).rejects.toThrow("Unknown box version");
  });

  test("values above the limit are rejected; the limit itself is accepted", async () => {
    const r = await createRecipient();
    await expect(sealSecret(r.publicKey, "a".repeat(SECRET_MAX_BYTES + 1), binding)).rejects.toBeInstanceOf(
      SecretTooLarge,
    );
    // The limit counts UTF-8 bytes, not characters.
    await expect(
      sealSecret(r.publicKey, "\u00e9".repeat(SECRET_MAX_BYTES / 2 + 1), binding),
    ).rejects.toBeInstanceOf(SecretTooLarge);
    const max = await sealSecret(r.publicKey, "a".repeat(SECRET_MAX_BYTES), binding);
    expect(isSealedBox(max)).toBe(true);
    expect(await openSecret(r.privateKey, max, binding)).toBe("a".repeat(SECRET_MAX_BYTES));
  });

  test("a malformed public key is rejected when sealing", async () => {
    await expect(sealSecret("AAAA", "x", binding)).rejects.toThrow();
    await expect(sealSecret("not base64!", "x", binding)).rejects.toThrow();
  });
});

describe("isSealedBox checks the shape at the boundary", () => {
  test("rejects non-objects and missing or mistyped fields", async () => {
    const r = await createRecipient();
    const ok = await sealSecret(r.publicKey, "x", binding);
    const bad: unknown[] = [
      null,
      undefined,
      "box",
      42,
      [],
      {},
      { v: 1, epk: "a", iv: "b" },
      { ...ok, v: 2 },
      { ...ok, v: "1" },
      { ...ok, epk: 123 },
      { ...ok, iv: "" },
      { ...ok, ct: "not base64" },
      { ...ok, ct: "abc=d" },
      { ...ok, epk: "A".repeat(201) },
      { ...ok, iv: "A".repeat(41) },
    ];
    for (const b of bad) expect(isSealedBox(b)).toBe(false);
  });

  test("caps the ciphertext at the size of the largest value", () => {
    const limit = Math.ceil((SECRET_MAX_BYTES + 16) / 3) * 4 + 4;
    const base = { v: 1, epk: "A".repeat(88), iv: "A".repeat(16) };
    expect(isSealedBox({ ...base, ct: "A".repeat(limit) })).toBe(true);
    expect(isSealedBox({ ...base, ct: "A".repeat(limit + 1) })).toBe(false);
  });
});
