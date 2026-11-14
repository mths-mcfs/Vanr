import { describe, expect, test } from "bun:test";
import { RiskTracker } from "./effects";
import {
  contentSha256,
  isUnder,
  MemoryPathError,
  memoryWriteNeedsReview,
  numberLines,
  parseMemoryPath,
  untrustedSources,
  virtualPath,
} from "./memory";

describe("memory tool paths", () => {
  test("reads the three stores and the root", () => {
    expect(parseMemoryPath("/memories")).toEqual({ kind: "root" });
    expect(parseMemoryPath("/memories/")).toEqual({ kind: "root" });
    expect(parseMemoryPath("/memories/agent")).toEqual({ kind: "store", scope: "agent", path: "" });
    expect(parseMemoryPath("/memories/you/preferencias.md")).toEqual({
      kind: "store",
      scope: "person",
      path: "preferencias.md",
    });
    expect(parseMemoryPath("/memories/workspace/clientes/Ação (BR).md")).toEqual({
      kind: "store",
      scope: "workspace",
      path: "clientes/Ação (BR).md",
    });
    expect(virtualPath("person", "a/b.md")).toBe("/memories/you/a/b.md");
  });

  // Attack: leaving the agent's store to read or write another one, or outside /memories.
  test.each([
    "/memories/agent/../you/x.md",
    "/memories/agent/../../etc/passwd",
    "/memories/agent/./x.md",
    "/memories/agent//x.md",
    "/memories/agent/%2e%2e/x.md",
    "/memories/agent/..%2fx.md",
    "/memories/agent\\..\\x.md",
    "/memories/agent/x\u0000.md",
    "/memories/agent/.hidden",
    "/memories/other-agent/x.md",
    "/memoriesx/agent/x.md",
    "memories/agent/x.md",
    "agent/x.md",
    "/etc/passwd",
    "",
    `/memories/agent/${"a/".repeat(9)}x.md`,
    `/memories/agent/${"a".repeat(101)}`,
  ])("rejects %p", (raw) => {
    expect(() => parseMemoryPath(raw)).toThrow(MemoryPathError);
  });

  test("a folder contains the item; a similar prefix does not", () => {
    expect(isUnder("clientes/acme.md", "clientes")).toBe(true);
    expect(isUnder("clientes2/acme.md", "clientes")).toBe(false);
    expect(isUnder("x.md", "")).toBe(true);
  });
});

describe("writes under flag A", () => {
  test("a run without A writes directly; with A it goes to review, with the sources", () => {
    const risk = new RiskTracker();
    expect(memoryWriteNeedsReview(risk)).toBe(false);
    risk.raise({ flag: "B", source: "request_secret X" });
    expect(memoryWriteNeedsReview(risk)).toBe(false);
    risk.raise({ flag: "A", source: "mail_read caixa/INBOX/42" });
    expect(memoryWriteNeedsReview(risk)).toBe(true);
    expect(untrustedSources(risk)).toEqual(["mail_read caixa/INBOX/42"]);
  });
});

test("hash and numbered lines in the memory tool format", () => {
  expect(contentSha256("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  expect(numberLines("a\nb\nc")).toBe("     1\ta\n     2\tb\n     3\tc");
  expect(numberLines("a\nb\nc", [2, -1])).toBe("     2\tb\n     3\tc");
  expect(numberLines("a\nb\nc", [1, 2])).toBe("     1\ta\n     2\tb");
});
