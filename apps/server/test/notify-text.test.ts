import { describe, expect, test } from "bun:test";
import { authSubject, emailText, localeFromHeader, oneLine, pushText, snippetOf } from "../src/notify-text";

describe("text that leaves the server", () => {
  test("the auth emails follow Accept-Language, pt-BR without one", () => {
    expect(localeFromHeader("en-US,en;q=0.9")).toBe("en");
    expect(localeFromHeader("pt-BR,pt;q=0.9,en;q=0.8")).toBe("pt-BR");
    expect(localeFromHeader("fr-FR, en;q=0.5")).toBe("en");
    expect(localeFromHeader(null)).toBe("pt-BR");
    expect(authSubject("en", "reset")).toBe("Vanr: reset your password");
    expect(authSubject("pt-BR", "verify")).toBe("Vanr: confirme seu e-mail");
  });

  test("one line without control characters, cut with an ellipsis", () => {
    expect(oneLine("a\u0000b c\n\n d ")).toBe("a b c d");
    expect(oneLine("abcdef", 4)).toBe("abc…");
  });

  test("the excerpt takes the first field present, an empty one included", () => {
    expect(snippetOf({ latest: { text: "t", quote: "q" }, source: { label: "l" } } as never)).toBe("t");
    expect(snippetOf({ latest: { title: "", text: "t" }, source: {} } as never)).toBe("");
    expect(snippetOf({ latest: {}, source: { label: "#general" } } as never)).toBe("#general");
  });

  test("push and email of an assignment that finished, in both languages", () => {
    const n = { reason: "assignment_finished", latest: { title: "Ship it" }, source: {} } as never;
    expect(pushText("pt-BR", "Lia", n)).toEqual({
      title: "Lia terminou a tarefa atribuída e espera sua revisão",
      body: "Ship it",
    });
    const mail = emailText("en", { who: "Lia", workspaceName: "Acme", link: "L", settingsLink: "S", n });
    expect(mail.subject).toBe("[Vanr] Lia is waiting for you: Ship it");
    expect(mail.text.split("\n")[0]).toBe("Lia finished the assignment and awaits your review in Acme.");
  });
});
