import { expect, test } from "bun:test";
import { createSealer, keyPreview } from "./seal";

test("encrypts and decrypts; the ciphertext does not contain the key and changes every time", () => {
  const s = createSealer("segredo-mestre-de-teste-123456", "credentials");
  const a = s.seal("sk-ant-api03-abcdef");
  const b = s.seal("sk-ant-api03-abcdef");
  expect(a).not.toBe(b);
  expect(a).not.toContain("abcdef");
  expect(s.open(a)).toBe("sk-ant-api03-abcdef");
});

test("another purpose or a tampered text does not open", () => {
  const s = createSealer("segredo-mestre-de-teste-123456", "credentials");
  const other = createSealer("segredo-mestre-de-teste-123456", "runner");
  const sealed = s.seal("valor");
  expect(() => other.open(sealed)).toThrow();
  const parts = sealed.split(".");
  parts[3] = `${parts[3]}x`;
  expect(() => s.open(parts.join("."))).toThrow();
});

test("key hint", () => {
  expect(keyPreview("sk-ant-api03-xyz9876")).toBe("sk-ant-…9876");
  expect(keyPreview("abc12345")).toBe("…2345");
});
