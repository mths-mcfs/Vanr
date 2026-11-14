import { expect, test } from "bun:test";
import { can } from "@vanr/contract";
import { channelName, handleFrom, parseMentions, slugify, uniqueHandle } from "./text";

test("channelName follows the original rule", () => {
  expect(channelName("Ação Rápida 2")).toBe("acao-rapida-2");
  expect(channelName("  -geral!! ")).toBe("geral");
});

test("handleFrom and uniqueHandle", () => {
  expect(handleFrom("Ana Clara")).toBe("ana-clara");
  expect(handleFrom("Ö")).toBe("ox");
  expect(uniqueHandle("ana", new Set(["ana", "ana-2"]))).toBe("ana-3");
});

test("slugify", () => {
  expect(slugify("Política de Férias / 2026")).toBe("politica-de-ferias-2026");
});

test("permissions by role", () => {
  expect(can("member", "post")).toBe(true);
  expect(can("member", "manage_agents")).toBe(false);
  expect(can("admin", "manage_owners")).toBe(false);
  expect(can("owner", "manage_owners")).toBe(true);
});

test("parseMentions finds @handle and skips email", () => {
  expect(parseMentions("oi @Ana e @dev-bot, fala com @ana")).toEqual(["ana", "dev-bot"]);
  expect(parseMentions("mande para joao@empresa.com")).toEqual([]);
  expect(parseMentions("@x curto demais, @ok sim")).toEqual(["ok"]);
  expect(parseMentions("(@pedro)")).toEqual(["pedro"]);
});
